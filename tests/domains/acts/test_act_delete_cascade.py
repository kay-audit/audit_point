"""Каскад удаления акта: паритет PG-схемы и ручного списка для Greenplum.

На PostgreSQL дочерние строки уносит ``ON DELETE CASCADE``. На Greenplum
referential actions не enforce-ятся, поэтому ``ActCrudRepository.delete_by_id``
чистит те же таблицы явным DELETE по списку ``_CHILD_TABLES``. Список ведётся
руками, и его расхождение со схемой не проявляется ни на одном PG-тесте —
только сиротами в проде на GP. Отсюда страж: набор таблиц с каскадом в
PG-схеме должен ровно совпадать со списком.
"""

import re
from pathlib import Path

from app.db.adapters.base import DatabaseAdapter
from app.domains.acts.repositories.act_crud import ActCrudRepository

MIGRATIONS = (
    Path(__file__).parent.parent.parent.parent
    / "app" / "domains" / "acts" / "migrations"
)

# Лог-таблицы: act_id есть, FK нет ни в PG, ни в GP — переживают удаление акта
# по обеим СУБД. В _CHILD_TABLES им не место, иначе GP чистил бы больше PG.
_LOG_TABLES = {"audit_log", "act_editor_telemetry"}


def _tables_with_cascade_on_acts() -> set[str]:
    """Таблицы PG-схемы с ``REFERENCES acts(id) ON DELETE CASCADE``."""
    content = (MIGRATIONS / "postgresql" / "schema.sql").read_text(encoding="utf-8")
    found = set()
    for raw in DatabaseAdapter._split_sql_statements(content):
        cleaned = re.sub(r"--[^\n]*", "", raw)
        name = re.search(
            r"CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+\{SCHEMA\}\.\{PREFIX\}(\w+)",
            cleaned,
            re.IGNORECASE,
        )
        if not name:
            continue
        if re.search(
            r"REFERENCES\s+\{SCHEMA\}\.\{PREFIX\}acts\s*\(\s*id\s*\)\s*ON\s+DELETE\s+CASCADE",
            cleaned,
            re.IGNORECASE,
        ):
            found.add(name.group(1))
    return found


def test_child_tables_match_pg_cascade():
    """Ни одной таблицы с каскадом мимо списка и ни одной лишней в списке."""
    cascaded = _tables_with_cascade_on_acts()
    assert cascaded, "в PG-схеме не найдено ни одного ON DELETE CASCADE на acts"
    listed = set(ActCrudRepository._CHILD_TABLES)

    missing = sorted(cascaded - listed)
    extra = sorted(listed - cascaded)
    assert not missing, (
        "таблицы каскадно удаляются на PG, но не чистятся на GP — "
        f"добавь в ActCrudRepository._CHILD_TABLES: {missing}"
    )
    assert not extra, (
        "в _CHILD_TABLES есть таблицы без каскада на acts в PG-схеме — "
        f"на GP они удалялись бы, а на PG нет: {extra}"
    )


def test_content_versions_deleted_with_act():
    """Снимки версий — дочерние акту, на GP их уносит явный DELETE."""
    assert "act_content_versions" in ActCrudRepository._CHILD_TABLES


def test_log_tables_survive_act_deletion():
    """Лог-таблицы FK на acts не имеют и в каскад не входят — по обеим схемам."""
    assert _LOG_TABLES.isdisjoint(ActCrudRepository._CHILD_TABLES)
    assert _LOG_TABLES.isdisjoint(_tables_with_cascade_on_acts())
    for db_type in ("postgresql", "greenplum"):
        sql = (MIGRATIONS / db_type / "schema.sql").read_text(encoding="utf-8")
        for raw in DatabaseAdapter._split_sql_statements(sql):
            cleaned = re.sub(r"--[^\n]*", "", raw)
            name = re.search(
                r"CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+"
                r"\{SCHEMA\}\.\{PREFIX\}(\w+)",
                cleaned,
                re.IGNORECASE,
            )
            if name and name.group(1) in _LOG_TABLES:
                assert "REFERENCES" not in cleaned.upper(), (
                    f"{db_type}: у лог-таблицы {name.group(1)} появился FK — "
                    "решение о её судьбе при удалении акта нужно пересмотреть"
                )


def test_child_tables_order_puts_acts_last():
    """Родительская таблица в списке дочерних отсутствует."""
    assert "acts" not in ActCrudRepository._CHILD_TABLES
