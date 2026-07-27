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


async def load_user_context(
    username: str,
    current_act_id: int | None = None,
) -> dict:
    """Загружает контекст текущего пользователя.

    Возвращает dict с полями:
        username, fullname, job, is_admin, roles: list[str],
        acts: list[{id, km_number, inspection_name, my_role, status, ...}],
        current_act_id: int | None — id акта, в котором пользователь
            сейчас работает (с конструктора). None если чат открыт
            не из конструктора (например, sidebar на landing).
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
        is_admin = "Администратор" in roles

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
                    "my_role": "Администратор",
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
        "current_act_id": current_act_id,
        "selected_node_id": None,  # подставляется позже, если передан
    }


async def format_user_context_for_prompt(ctx: dict) -> str:
    """Форматирует контекст пользователя как блок для system prompt.

    Формат — компактный, чтобы не раздувать токены. На 12 актов с
    кириллицей это ~1.5-2 KB.

    Если задан current_act_id — он помечается маркером «← ОТКРЫТ
    СЕЙЧАС» в таблице актов, чтобы LLM понимала контекст по умолчанию
    для операций модификации.
    """
    lines = [
        "## Контекст текущего пользователя",
        f"- Логин: {ctx['username']}",
        f"- ФИО: {ctx['fullname'] or '(не заполнено)'}",
        f"- Должность: {ctx['job'] or '(не заполнено)'}",
        f"- Роли: {', '.join(ctx['roles']) if ctx['roles'] else '(нет)'}",
    ]

    current_act_id = ctx.get("current_act_id")
    selected_node_id = ctx.get("selected_node_id")
    selected_node_info: dict | None = None
    if current_act_id:
        # Найдём описание текущего акта, чтобы LLM понимал контекст
        current_act = next(
            (a for a in ctx.get("acts", []) if a["id"] == current_act_id),
            None,
        )
        if current_act:
            lines.append(
                f"- Текущий открытый акт: id={current_act_id}, "
                f"КМ={current_act['km_number']}, "
                f"«{current_act['inspection_name'] or '—'}», "
                f"ваша роль в команде: {current_act['my_role']} "
                f"(← ОТКРЫТ СЕЙЧАС в конструкторе)"
            )
        else:
            # Акт есть в URL, но не в топ-12 доступных. Догрузим его
            # метаданные одним запросом — чтобы LLM видела КМ/название,
            # даже если акт не попал в основной список.
            extra = await _load_single_act_meta(current_act_id)
            if extra:
                lines.append(
                    f"- Текущий открытый акт: id={current_act_id}, "
                    f"КМ={extra['km_number']}, "
                    f"«{extra['inspection_name'] or '—'}» "
                    f"(← ОТКРЫТ СЕЙЧАС в конструкторе)"
                )
            else:
                lines.append(
                    f"- Текущий открытый акт: id={current_act_id} "
                    f"(← ОТКРЫТ СЕЙЧАС в конструкторе)"
                )

        # Если выбран конкретный узел — подгружаем его метку/номер,
        # чтобы LLM знала контекст.
        if selected_node_id:
            selected_node_info = await _load_selected_node_meta(
                current_act_id, selected_node_id,
            )
            if selected_node_info:
                lines.append(
                    f"- Выбранный блок: id={selected_node_id}, "
                    f"number={selected_node_info.get('number') or '?'}, "
                    f"label={selected_node_info.get('label') or '?'}, "
                    f"type={selected_node_info.get('type', 'item')} "
                    f"(← ВЫБРАН ПОЛЬЗОВАТЕЛЕМ через контекстное меню)"
                )

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
            marker = " ← ОТКРЫТ" if a["id"] == current_act_id else ""
            lines.append(
                f"| {a['id']} | {a['km_number']} | {label} | {city} | "
                f"{dates} | {a['my_role']} | {a['status']}{marker} |"
            )
        lines.append("")
        if current_act_id:
            lines.append(
                "Сейчас открыт один акт — по умолчанию все операции "
                "модификации (create_act, add_processes_to_act и т.п.) "
                "выполняй для него, если пользователь не указал "
                "другой КМ. Для поиска/просмотра по другим актам — "
                "используй таблицу выше."
            )
        else:
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


async def _load_single_act_meta(act_id: int) -> dict | None:
    """Догружает метаданные одного акта (если он не попал в топ-12)."""
    from app.db.connection import get_db
    async with get_db() as conn:
        row = await conn.fetchrow(
            "SELECT id, km_number, inspection_name, is_process_based "
            "FROM t_db_oarb_audit_act_acts WHERE id = $1",
            act_id,
        )
    if row is None:
        return None
    return dict(row)


async def _load_selected_node_meta(
    act_id: int, node_id: str,
) -> dict | None:
    """Загружает label/number/type узла дерева акта по его id.

    Идёт обходом дерева JSONB (несколько уровней вложенности). Если узел
    не найден — возвращает None. Используется для контекстного промпта
    «выбранный блок».
    """
    from app.db.connection import get_db
    async with get_db() as conn:
        row = await conn.fetchrow(
            "SELECT tree_data FROM t_db_oarb_audit_act_act_tree WHERE act_id = $1",
            act_id,
        )
    if not row:
        return None
    try:
        import json
        tree = json.loads(row["tree_data"])
    except (json.JSONDecodeError, TypeError):
        return None

    def walk(node):
        if node.get("id") == node_id:
            return {
                "id": node_id,
                "label": node.get("label", ""),
                "number": node.get("number", ""),
                "type": node.get("type", "item"),
            }
        for c in node.get("children", []) or []:
            found = walk(c)
            if found is not None:
                return found
        return None

    return walk(tree)