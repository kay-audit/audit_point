"""Работа со справочником процессов для ChatTool.

Источник — таблица ``t_db_oarb_ua_process_dict`` (настраивается через
``UA_DATA__PROCESS_DICT``). Колонки: ``process_code``, ``process_name``.

Для быстрого поиска без сложных join'ов: LLM обычно оперирует
process_code («П1004») или частью process_name («ИЖС»). Возвращаем
список dict'ов с process_code/process_name — handler сам решит,
какой процесс куда положить.
"""
from __future__ import annotations

import logging

from app.db.connection import get_adapter, get_db

logger = logging.getLogger("audit_workstation.domains.acts.integrations.processes")


async def fetch_processes_by_codes(
    process_codes: list[str],
) -> list[dict]:
    """Возвращает список процессов по списку кодов (точное совпадение).

    Пустые/None коды игнорируются. Дубликаты схлопываются.
    Резолвит имя таблицы через UaDataSettings.process_dict (берётся из
    settings_registry, чтобы не хардкодить имя).
    """
    codes = sorted({
        str(c).strip()
        for c in (process_codes or [])
        if c is not None and str(c).strip()
    })
    if not codes:
        return []

    adapter = get_adapter()
    from app.core.settings_registry import get as get_domain_settings
    from app.domains.ua_data.settings import UaDataSettings

    ua_s = get_domain_settings("ua_data", UaDataSettings)
    schema = ua_s.schema_name
    table = ua_s.process_dict
    qualified = adapter.qualify_table_name(table, schema)

    sql = (
        f"SELECT process_code, process_name "
        f"FROM {qualified} "
        f"WHERE process_code = ANY($1::text[]) "
        f"  AND is_actual = true "
        f"ORDER BY process_code"
    )
    async with get_db() as conn:
        rows = await conn.fetch(sql, codes)
    return [
        {"process_code": r["process_code"], "process_name": r["process_name"]}
        for r in rows
    ]


async def search_processes(query: str, limit: int = 20) -> list[dict]:
    """Поиск процессов по части process_code или process_name.

    Используется handler'ом, когда LLM передал имя вместо кода
    («ИЖС» вместо «П1004»). ILIKE по обеим колонкам.
    """
    q = (query or "").strip()
    if not q:
        return []
    pattern = f"%{q}%"

    adapter = get_adapter()
    from app.core.settings_registry import get as get_domain_settings
    from app.domains.ua_data.settings import UaDataSettings

    ua_s = get_domain_settings("ua_data", UaDataSettings)
    schema = ua_s.schema_name
    table = ua_s.process_dict
    qualified = adapter.qualify_table_name(table, schema)

    sql = (
        f"SELECT process_code, process_name "
        f"FROM {qualified} "
        f"WHERE (process_code ILIKE $1 OR process_name ILIKE $1) "
        f"  AND is_actual = true "
        f"ORDER BY process_code "
        f"LIMIT $2"
    )
    async with get_db() as conn:
        rows = await conn.fetch(sql, pattern, limit)
    return [
        {"process_code": r["process_code"], "process_name": r["process_name"]}
        for r in rows
    ]