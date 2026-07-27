"""Хелперы для ChatTool-обработчиков домена acts.

Содержит общую логику:
- Загрузка контекста пользователя (identity + roles + accessible acts)
- Загрузка справочника процессов (для добавления в акт)
- Сериализация контекста в строку для system prompt

Контекст пользователя нужен, чтобы:
1. System prompt содержал ФИО/должность/логин/роль — LLM мог отвечать
   «вы руководитель этого акта», понимать «я», «руководитель я».
2. LLM видел список доступных пользователю актов — мог отвечать на
   «открой мой последний акт», «какие у меня проекты» без отдельного
   tool-вызова.
3. Tool-handlers могли взять act_id по контексту (например,
   «последний созданный мной акт»).

Все запросы читающие, без модификации БД.
"""
from __future__ import annotations

import json
import logging
from datetime import date

from app.db.connection import get_db, get_adapter

logger = logging.getLogger("audit_workstation.domains.acts.integrations.context")


# Сколько актов включать в контекст пользователя (хвост — самые свежие).
MAX_ACTS_IN_CONTEXT = 12


def _derive_status(start: date, end: date) -> str:
    """pending/active/completed — точно как на /api/v1/acts/my-projects."""
    today = date.today()
    if end < today:
        return "completed"
    if start > today:
        return "pending"
    return "active"


async def load_user_context(username: str) -> dict:
    """Загружает контекст текущего пользователя.

    Возвращает dict с полями:
        username, fullname, job, is_admin, roles: list[str],
        acts: list[{id, km_number, inspection_name, my_role, status, ...}]
    """
    async with get_db() as conn:
        # ФИО/должность
        row = await conn.fetchrow(
            "SELECT COALESCE(fullname, '') AS fullname, "
            "       COALESCE(job, '') AS job "
            "FROM t_db_oarb_ua_user WHERE username = $1",
            username,
        )
        fullname = row["fullname"] if row else ""
        job = row["job"] if row else ""

        # Роли (с фолбэком на default-роли для новых пользователей —
        # get_user_roles делает auto-assign и кеширует в памяти).
        from app.api.v1.deps.role_deps import get_user_roles

        roles_records = await get_user_roles(username=username)
        roles = sorted({r["name"] for r in roles_records})
        is_admin = "Админ" in roles

        # Акты: админу — все, остальным — только свои.
        if is_admin:
            act_rows = await conn.fetch(
                "SELECT id, km_number, inspection_name, city, "
                "       order_number, inspection_start_date, "
                "       inspection_end_date, created_by, "
                "       is_process_based "
                "FROM t_db_oarb_audit_act_acts "
                "ORDER BY GREATEST(inspection_end_date, "
                "                 inspection_start_date) DESC, id DESC "
                "LIMIT $1",
                MAX_ACTS_IN_CONTEXT,
            )
            act_records = [
                {
                    "id": r["id"],
                    "km_number": r["km_number"],
                    "inspection_name": r["inspection_name"] or "",
                    "city": r["city"] or "",
                    "my_role": "Админ",
                    "status": _derive_status(
                        r["inspection_start_date"],
                        r["inspection_end_date"],
                    ),
                    "created_by": r["created_by"],
                    "is_process_based": r["is_process_based"],
                    "inspection_start_date": str(r["inspection_start_date"]),
                    "inspection_end_date": str(r["inspection_end_date"]),
                }
                for r in act_rows
            ]
        else:
            act_rows = await conn.fetch(
                "SELECT a.id, a.km_number, a.inspection_name, a.city, "
                "       a.order_number, a.inspection_start_date, "
                "       a.inspection_end_date, a.created_by, "
                "       a.is_process_based, "
                "       MIN(atm.role::text) AS my_role "
                "FROM t_db_oarb_audit_act_acts a "
                "INNER JOIN t_db_oarb_audit_act_audit_team_members atm "
                "       ON a.id = atm.act_id "
                "WHERE atm.username = $1 "
                "GROUP BY a.id, a.km_number, a.inspection_name, a.city, "
                "         a.order_number, a.inspection_start_date, "
                "         a.inspection_end_date, a.created_by, "
                "         a.is_process_based "
                "ORDER BY GREATEST(a.inspection_end_date, "
                "                 a.inspection_start_date) DESC, a.id DESC "
                "LIMIT $2",
                username, MAX_ACTS_IN_CONTEXT,
            )
            act_records = [
                {
                    "id": r["id"],
                    "km_number": r["km_number"],
                    "inspection_name": r["inspection_name"] or "",
                    "city": r["city"] or "",
                    "my_role": r["my_role"] or "Участник",
                    "status": _derive_status(
                        r["inspection_start_date"],
                        r["inspection_end_date"],
                    ),
                    "created_by": r["created_by"],
                    "is_process_based": r["is_process_based"],
                    "inspection_start_date": str(r["inspection_start_date"]),
                    "inspection_end_date": str(r["inspection_end_date"]),
                }
                for r in act_rows
            ]

    return {
        "username": username,
        "fullname": fullname,
        "job": job,
        "is_admin": is_admin,
        "roles": roles,
        "acts": act_records,
    }


def format_user_context_for_prompt(ctx: dict) -> str:
    """Форматирует контекст пользователя как блок для system prompt.

    Формат — компактный, чтобы не раздувать токены. На 12 актов с
    кириллицей это ~1.5-2 KB.
    """
    lines = [
        "## Контекст текущего пользователя",
        f"- Логин: {ctx['username']}",
        f"- ФИО: {ctx['fullname'] or '(не заполнено)'}",
        f"- Должность: {ctx['job'] or '(не заполнено)'}",
        f"- Роли: {', '.join(ctx['roles']) if ctx['roles'] else '(нет)'}",
    ]
    if ctx["acts"]:
        lines.append("")
        lines.append("## Доступные вам акты (id, КМ, ваша роль, статус)")
        lines.append(
            "| id | КМ | Наименование | Город | Сроки | Ваша роль | Статус |"
        )
        lines.append(
            "|----|----|----|----|----|----|----|"
        )
        for a in ctx["acts"]:
            label = a["inspection_name"] or "—"
            city = a["city"] or "—"
            dates = (
                f"{a['inspection_start_date']}…{a['inspection_end_date']}"
            )
            lines.append(
                f"| {a['id']} | {a['km_number']} | {label} | {city} | "
                f"{dates} | {a['my_role']} | {a['status']} |"
            )
        lines.append("")
        lines.append(
            "Когда пользователь говорит «открой мой последний акт», "
            "«какие у меня проекты», «открой КМ-99-XXXXX» — "
            "используй эти данные. По «я», «мой», «у меня» — "
            "подставляй username=" + ctx["username"] + "."
        )
    else:
        lines.append("")
        lines.append("## Доступные вам акты")
        lines.append("(нет — пользователь ещё не участвует ни в одном акте)")
    return "\n".join(lines)