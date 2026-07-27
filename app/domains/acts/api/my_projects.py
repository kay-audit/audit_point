"""Эндпоинт /api/v1/acts/my-projects — панель «Мои проекты» на landing.

Возвращает карточки только тех актов, в команде которых пользователь
**явно состоит** (`audit_team_members`). Для каждого акта — его роль
в команде (Куратор/Руководитель/Редактор/Участник/AppendixRef).

Системная роль «Администратор» НЕ влияет на содержимое панели: она даёт
администратору доступ ко всем актам на уровне API (на правах Руководителя
в каждом акте), но это про права, а не про UI-панель «Мои проекты».
Панель отражает фактическое членство в команде — независимо от системной
роли. Так админ, добавленный в акт как «Редактор», увидит на карточке этого
акта «Редактор», а не «Администратор» / «Руководитель».

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
    my_role: str  # роль пользователя в команде акта (Куратор/Руководитель/...)
    my_full_name: str  # ФИО в команде (из справочника пользователей)
    my_position: str  # должность (из справочника)


class MyProjectsResponse(BaseModel):
    is_admin: bool  # оставлено для совместимости с фронтом; НЕ влияет на items
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

    Возвращает **только** акты, в команде которых пользователь состоит
    (`audit_team_members`), с его ролью в команде.

    Раньше для админа возвращались ВСЕ акты с ролью «Администратор» — это
    смешивало системную роль с ролью в команде акта. Теперь этого нет:
    администратор без членства в `audit_team_members` увидит пустую панель,
    потому что в «Моих проектах» отображаются только реально «свои» проекты.
    """
    async with get_db() as conn:
        roles = await get_user_roles(username=username)
        is_admin = any(r["name"] == "Администратор" for r in roles)

        # ФИО/должность залогиненного — для отображения на карточке.
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

        # Один и тот же запрос и для админа, и для обычного пользователя:
        # мы НЕ разделяем ветки кода, потому что требование одно — показать
        # только то, в чём пользователь реально состоит в команде.
        # Роль пользователя в акте выбирается агрегатом MIN — если по
        # какой-то причине один и тот же человек добавлен в команду акта
        # с несколькими ролями, мы отдадим минимальную по алфавиту (стабильно).
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
