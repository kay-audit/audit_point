"""Эндпоинт /api/v1/acts/my-projects — панель «Мои проекты» на landing.

Возвращает:
- для админа: ВСЕ акты (без role — у админа нет конкретной роли в команде
  актов, он видит всё как «Администратор»);
- для не-админа: только акты, в команде которых он состоит, + его роль
  (Куратор/Руководитель/Редактор/Участник/AppendixRef).

Карточка на фронте кликабельна и ведёт в `/constructor?act_id=<id>`
(как кнопка «Открыть» в разделе «Управление актами»).
"""
from __future__ import annotations

import logging
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.api.v1.deps.auth_deps import get_username
from app.api.v1.deps.role_deps import get_user_roles
from app.db.connection import get_db

logger = logging.getLogger("audit_workstation.api.acts.my_projects")
router = APIRouter()


class MyProjectItem(BaseModel):
    """Лёгкая карточка для панели «Мои проекты»."""

    id: int
    km_number: str
    inspection_name: str
    city: str
    order_number: str
    inspection_start_date: date
    inspection_end_date: date
    status: str  # "active" | "completed" | "pending" — выводится как бейдж
    my_role: str  # "Администратор" для админа или роль в команде (Куратор/...)
    my_full_name: str  # ФИО в команде (для админа = его ФИО из справочника)
    my_position: str  # должность (аналогично)


class MyProjectsResponse(BaseModel):
    is_admin: bool
    items: list[MyProjectItem]


def _derive_status(start: date, end: date) -> str:
    """Простая эвристика: до начала — pending, после конца — completed, иначе active."""
    today = date.today()
    if end < today:
        return "completed"
    if start > today:
        return "pending"
    return "active"


@router.get("/my-projects", response_model=MyProjectsResponse)
async def list_my_projects(username: str = Depends(get_username)):
    """Список актов для панели «Мои проекты» на landing.

    Админам — все акты. Остальным — только те, в команде которых они
    состоят (с их ролью).
    """
    async with get_db() as conn:
        roles = await get_user_roles(username=username)
        is_admin = any(r["name"] == "Админ" for r in roles)

        # ФИО/должность залогиненного — для админа показываем в карточке как
        # «владелец проекта» (как если бы он был руководителем).
        user_info = await conn.fetchrow(
            """
            SELECT COALESCE(fullname, '') AS fullname,
                   COALESCE(job, '') AS job
            FROM t_db_oarb_ua_user
            WHERE username = $1
            """,
            username,
        )
        my_full_name = user_info["fullname"] if user_info else ""
        my_position = user_info["job"] if user_info else ""

        if is_admin:
            rows = await conn.fetch(
                """
                SELECT id, km_number, inspection_name, city, order_number,
                       inspection_start_date, inspection_end_date
                FROM t_db_oarb_audit_act_acts
                ORDER BY inspection_end_date DESC, id DESC
                LIMIT 100
                """
            )
            items = [
                MyProjectItem(
                    id=r["id"],
                    km_number=r["km_number"],
                    inspection_name=r["inspection_name"],
                    city=r["city"] or "",
                    order_number=r["order_number"] or "",
                    inspection_start_date=r["inspection_start_date"],
                    inspection_end_date=r["inspection_end_date"],
                    status=_derive_status(r["inspection_start_date"], r["inspection_end_date"]),
                    my_role="Администратор",
                    my_full_name=my_full_name,
                    my_position=my_position,
                )
                for r in rows
            ]
        else:
            rows = await conn.fetch(
                """
                SELECT a.id, a.km_number, a.inspection_name, a.city,
                       a.order_number, a.inspection_start_date, a.inspection_end_date,
                       MIN(atm.role) AS my_role
                FROM t_db_oarb_audit_act_acts a
                INNER JOIN t_db_oarb_audit_act_audit_team_members atm
                    ON a.id = atm.act_id
                WHERE atm.username = $1
                GROUP BY a.id, a.km_number, a.inspection_name, a.city,
                         a.order_number, a.inspection_start_date, a.inspection_end_date
                ORDER BY a.inspection_end_date DESC, a.id DESC
                LIMIT 100
                """,
                username,
            )
            items = [
                MyProjectItem(
                    id=r["id"],
                    km_number=r["km_number"],
                    inspection_name=r["inspection_name"],
                    city=r["city"] or "",
                    order_number=r["order_number"] or "",
                    inspection_start_date=r["inspection_start_date"],
                    inspection_end_date=r["inspection_end_date"],
                    status=_derive_status(r["inspection_start_date"], r["inspection_end_date"]),
                    my_role=r["my_role"] or "Участник",
                    my_full_name=my_full_name,
                    my_position=my_position,
                )
                for r in rows
            ]

    logger.info("my-projects: user=%s admin=%s items=%d", username, is_admin, len(items))
    return MyProjectsResponse(is_admin=is_admin, items=items)
