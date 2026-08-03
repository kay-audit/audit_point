"""Тесты совместимости Greenplum-схем с PostgreSQL 9.4 и SQL-сплиттер."""

import re

import pytest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import asyncpg

from app.db.adapters.base import DatabaseAdapter
from app.db.adapters.greenplum import GreenplumAdapter


# ---------------------------------------------------------------------------
# 1. Статический анализ: совместимость GP-схем с PostgreSQL 9.4
# ---------------------------------------------------------------------------


class TestGreenplumSchemaCompatibility:
    """Статический анализ Greenplum-схем на совместимость с PostgreSQL 9.4."""

    @pytest.fixture
    def gp_schema_files(self):
        """Находит все greenplum schema.sql файлы (непустые)."""
        base = Path(__file__).parent.parent / "app" / "domains"
        schemas = list(base.glob("*/migrations/greenplum/schema.sql"))
        # Фильтруем только непустые (не заглушки)
        return [s for s in schemas if s.stat().st_size > 100]

    def _find_violations(self, gp_schema_files, pattern):
        """Общий хелпер для поиска нарушений по regex-паттерну."""
        violations = []
        for schema in gp_schema_files:
            content = schema.read_text(encoding='utf-8')
            matches = pattern.findall(content)
            if matches:
                violations.append(f"{schema}: {len(matches)} вхождений")
        return violations

    def test_no_create_index_if_not_exists(self, gp_schema_files):
        """CREATE INDEX IF NOT EXISTS не поддерживается в PostgreSQL 9.4 / Greenplum 6."""
        pattern = re.compile(r'CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS', re.IGNORECASE)
        violations = self._find_violations(gp_schema_files, pattern)
        assert not violations, (
            f"CREATE INDEX IF NOT EXISTS не поддерживается в GP 6:\n"
            + "\n".join(violations)
        )

    def test_no_on_conflict(self, gp_schema_files):
        """ON CONFLICT (INSERT ... ON CONFLICT DO NOTHING/UPDATE) не поддерживается в PG 9.4."""
        pattern = re.compile(r'ON\s+CONFLICT', re.IGNORECASE)
        violations = self._find_violations(gp_schema_files, pattern)
        assert not violations, (
            f"ON CONFLICT не поддерживается в GP 6:\n"
            + "\n".join(violations)
        )

    def test_no_add_column_if_not_exists(self, gp_schema_files):
        """ALTER TABLE ... ADD COLUMN IF NOT EXISTS не поддерживается в PG 9.4."""
        pattern = re.compile(r'ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS', re.IGNORECASE)
        violations = self._find_violations(gp_schema_files, pattern)
        assert not violations, (
            f"ADD COLUMN IF NOT EXISTS не поддерживается в GP 6:\n"
            + "\n".join(violations)
        )

    def test_no_create_sequence_if_not_exists(self, gp_schema_files):
        """CREATE SEQUENCE IF NOT EXISTS не поддерживается в PG 9.4."""
        pattern = re.compile(r'CREATE\s+SEQUENCE\s+IF\s+NOT\s+EXISTS', re.IGNORECASE)
        violations = self._find_violations(gp_schema_files, pattern)
        assert not violations, (
            f"CREATE SEQUENCE IF NOT EXISTS не поддерживается в GP 6:\n"
            + "\n".join(violations)
        )

    def test_no_jsonb_set(self, gp_schema_files):
        """Функция jsonb_set() не поддерживается в PG 9.4."""
        pattern = re.compile(r'jsonb_set\s*\(', re.IGNORECASE)
        violations = self._find_violations(gp_schema_files, pattern)
        assert not violations, (
            f"jsonb_set() не поддерживается в GP 6:\n"
            + "\n".join(violations)
        )

    def test_no_jsonb_pretty(self, gp_schema_files):
        """Функция jsonb_pretty() не поддерживается в PG 9.4."""
        pattern = re.compile(r'jsonb_pretty\s*\(', re.IGNORECASE)
        violations = self._find_violations(gp_schema_files, pattern)
        assert not violations, (
            f"jsonb_pretty() не поддерживается в GP 6:\n"
            + "\n".join(violations)
        )

    def test_no_tablesample(self, gp_schema_files):
        """TABLESAMPLE не поддерживается в PG 9.4."""
        pattern = re.compile(r'TABLESAMPLE', re.IGNORECASE)
        violations = self._find_violations(gp_schema_files, pattern)
        assert not violations, (
            f"TABLESAMPLE не поддерживается в GP 6:\n"
            + "\n".join(violations)
        )

    def test_no_on_delete_cascade(self, gp_schema_files):
        """ON DELETE CASCADE / ON DELETE SET NULL на REFERENCES не поддерживается в GP 6."""
        pattern = re.compile(r'ON\s+DELETE\s+(CASCADE|SET\s+NULL)', re.IGNORECASE)
        violations = self._find_violations(gp_schema_files, pattern)
        assert not violations, (
            f"ON DELETE CASCADE/SET NULL не поддерживается в GP 6:\n"
            + "\n".join(violations)
        )

    def test_distributed_by_subset_of_primary_key(self, gp_schema_files):
        """GP 6: если у таблицы есть и PRIMARY KEY, и DISTRIBUTED BY,
        то столбцы DISTRIBUTED BY обязаны быть подмножеством PRIMARY KEY
        (то же правило для UNIQUE-констрейнтов). Нарушение → InvalidTableDefinitionError
        при CREATE TABLE."""
        pk_pattern = re.compile(r'PRIMARY\s+KEY\s*\(([^)]+)\)', re.IGNORECASE)
        uq_pattern = re.compile(r'\bUNIQUE\s*\(([^)]+)\)', re.IGNORECASE)
        dist_pattern = re.compile(r'DISTRIBUTED\s+BY\s*\(([^)]+)\)', re.IGNORECASE)
        name_pattern = re.compile(
            r'CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)',
            re.IGNORECASE,
        )

        def _cols(s):
            return {c.strip().lower() for c in s.split(',') if c.strip()}

        violations = []
        for schema in gp_schema_files:
            content = schema.read_text(encoding='utf-8')
            # _split_sql_statements корректно игнорирует ; внутри комментариев
            # и строковых литералов — нельзя резать regex'ом по ';'.
            for raw_stmt in DatabaseAdapter._split_sql_statements(content):
                # Вырезаем line-комментарии: они могут содержать
                # документацию вида "-- DISTRIBUTED BY (col)" и сбить регекс.
                stmt = re.sub(r'--[^\n]*', '', raw_stmt)
                if not re.search(r'\bCREATE\s+TABLE\b', stmt, re.IGNORECASE):
                    continue
                dist_match = dist_pattern.search(stmt)
                if not dist_match:
                    continue
                dist_cols = _cols(dist_match.group(1))
                name_match = name_pattern.search(stmt)
                table = name_match.group(1) if name_match else '?'

                pk_match = pk_pattern.search(stmt)
                if pk_match:
                    pk_cols = _cols(pk_match.group(1))
                    if not dist_cols.issubset(pk_cols):
                        violations.append(
                            f"{schema.parent.parent.parent.name}/{table}: "
                            f"DIST {sorted(dist_cols)} ⊄ PK {sorted(pk_cols)}"
                        )
                for uq_match in uq_pattern.finditer(stmt):
                    uq_cols = _cols(uq_match.group(1))
                    if not dist_cols.issubset(uq_cols):
                        violations.append(
                            f"{schema.parent.parent.parent.name}/{table}: "
                            f"DIST {sorted(dist_cols)} ⊄ UNIQUE {sorted(uq_cols)}"
                        )

        assert not violations, (
            "GP-правило: DISTRIBUTED BY должен быть подмножеством PRIMARY KEY "
            "и каждого UNIQUE-констрейнта.\n" + "\n".join(violations)
        )

    def test_act_tables_kind_column_and_check_both_schemas(self):
        """act_tables в обеих схемах объявляет колонку kind и CHECK по всем подвидам.

        Колонка kind обязана быть в схемах PG и GP (репозиторий пишет/читает её
        через INSERT/SELECT), а CHECK check_table_kind_values — перечислять
        ровно значения TABLE_KINDS (ручная синхронизация схема ↔ код).
        """
        from app.domains.acts.schemas.act_content import TABLE_KINDS

        base = Path(__file__).parent.parent / "app" / "domains" / "acts" / "migrations"
        for db_type in ("postgresql", "greenplum"):
            sql = (base / db_type / "schema.sql").read_text(encoding="utf-8")
            assert "kind VARCHAR(20) DEFAULT 'regular' NOT NULL" in sql, \
                f"{db_type}: act_tables не содержит колонку kind"
            check_match = re.search(
                r"CONSTRAINT\s+check_table_kind_values\s+CHECK\s*\(kind\s+IN\s*\(([^)]+)\)\)",
                sql,
            )
            assert check_match, f"{db_type}: нет CHECK check_table_kind_values"
            values = set(re.findall(r"'([^']+)'", check_match.group(1)))
            assert values == set(TABLE_KINDS), (
                f"{db_type}: CHECK перечисляет {sorted(values)}, "
                f"а TABLE_KINDS = {sorted(TABLE_KINDS)}"
            )

    def test_act_tables_unique_act_id_node_id_both_schemas(self):
        """act_tables в обеих схемах объявляет UNIQUE(act_id, node_id).

        Гарантирует не более одной активной таблицы на узел дерева. На GP
        DISTRIBUTED BY (act_id) ⊆ {act_id, node_id} — правило подмножества
        соблюдено, констрейнт валиден.
        """
        base = Path(__file__).parent.parent / "app" / "domains" / "acts" / "migrations"
        uq_pattern = re.compile(r'\bUNIQUE\s*\(([^)]+)\)', re.IGNORECASE)
        for db_type in ("postgresql", "greenplum"):
            content = (base / db_type / "schema.sql").read_text(encoding="utf-8")
            create_stmt = None
            for raw in DatabaseAdapter._split_sql_statements(content):
                cleaned = re.sub(r'--[^\n]*', '', raw)
                if (
                    re.search(r'\bCREATE\s+TABLE\b', cleaned, re.IGNORECASE)
                    and "{PREFIX}act_tables" in cleaned
                ):
                    create_stmt = cleaned
                    break
            assert create_stmt is not None, (
                f"{db_type}/schema.sql: CREATE TABLE act_tables не найдено"
            )
            uniques = [
                {c.strip().lower() for c in m.group(1).split(',') if c.strip()}
                for m in uq_pattern.finditer(create_stmt)
            ]
            assert {"act_id", "node_id"} in uniques, (
                f"{db_type}/schema.sql: act_tables не объявляет "
                f"UNIQUE(act_id, node_id). Найдено: {uniques}"
            )

    def test_act_textblocks_has_no_formatting_column_both_schemas(self):
        """Директива владельца: колонка formatting вырезана из act_textblocks.

        Схема и репозиторий синхронны — INSERT/SELECT текстблоков её не
        упоминают. Регрессия на случай случайного возврата колонки без
        поддержки в репозитории (INSERT упал бы на NOT NULL).
        """
        base = Path(__file__).parent.parent / "app" / "domains" / "acts" / "migrations"
        for db_type in ("postgresql", "greenplum"):
            content = (base / db_type / "schema.sql").read_text(encoding="utf-8")
            create_stmt = None
            for raw in DatabaseAdapter._split_sql_statements(content):
                cleaned = re.sub(r'--[^\n]*', '', raw)
                if (
                    re.search(r'\bCREATE\s+TABLE\b', cleaned, re.IGNORECASE)
                    and "{PREFIX}act_textblocks" in cleaned
                ):
                    create_stmt = cleaned
                    break
            assert create_stmt is not None, (
                f"{db_type}/schema.sql: CREATE TABLE act_textblocks не найдено"
            )
            assert not re.search(r'\bformatting\b', create_stmt, re.IGNORECASE), (
                f"{db_type}/schema.sql: колонка formatting в act_textblocks "
                f"должна быть вырезана (директива владельца)"
            )

    def test_act_content_versions_has_all_snapshot_columns_both_schemas(self):
        """Колонки снимка версии из create_version присутствуют в CREATE TABLE
        обеих схем.

        create_tables_if_not_exist создаёт таблицу целиком из schema.sql и НЕ
        добавляет колонки в существующие таблицы. При пересоздании БД колонка
        обязана прийти из schema.sql — иначе INSERT в create_version упадёт на
        отсутствующей колонке (например invoices_data), откатывая всё
        сохранение акта. Регрессия связывает список колонок INSERT'а
        (ActContentVersionRepository.create_version) со схемой, чтобы новая
        колонка снимка не могла попасть в репозиторий мимо DDL.
        """
        base = Path(__file__).parent.parent / "app" / "domains" / "acts" / "migrations"
        # Колонки, которые пишет ActContentVersionRepository.create_version.
        required_columns = [
            "act_id", "version_number", "save_type", "username",
            "tree_data", "tables_data", "textblocks_data", "violations_data",
            "invoices_data", "content_hash",
        ]
        for db_type in ("postgresql", "greenplum"):
            content = (base / db_type / "schema.sql").read_text(encoding="utf-8")
            create_stmt = None
            for raw in DatabaseAdapter._split_sql_statements(content):
                cleaned = re.sub(r'--[^\n]*', '', raw)
                if (
                    re.search(r'\bCREATE\s+TABLE\b', cleaned, re.IGNORECASE)
                    and "{PREFIX}act_content_versions" in cleaned
                ):
                    create_stmt = cleaned
                    break
            assert create_stmt is not None, (
                f"{db_type}/schema.sql: CREATE TABLE act_content_versions не найдено"
            )
            for col in required_columns:
                assert re.search(rf'\b{col}\b', create_stmt), (
                    f"{db_type}/schema.sql: колонка {col} отсутствует в "
                    f"act_content_versions — create_version.INSERT упадёт при "
                    f"пересоздании БД"
                )

    def test_no_pl_pgsql_triggers(self, gp_schema_files):
        """В GP 6 PL/pgSQL-триггеры исполняются только на координаторе → каждый
        UPDATE превращается в RPC на мастер. Для метки ``updated_at`` это лишний
        overhead: значение проще выставлять явно в SQL репозиториев. Регрессия —
        запрещаем CREATE TRIGGER и LANGUAGE plpgsql в GP-схемах."""
        trigger_pattern = re.compile(r'\bCREATE\s+TRIGGER\b', re.IGNORECASE)
        plpgsql_pattern = re.compile(r'\bLANGUAGE\s+plpgsql\b', re.IGNORECASE)
        trigger_violations = self._find_violations(gp_schema_files, trigger_pattern)
        plpgsql_violations = self._find_violations(gp_schema_files, plpgsql_pattern)
        assert not trigger_violations, (
            "CREATE TRIGGER на GP даёт coordinator-only исполнение. "
            "Перенеси логику в SQL репозиториев:\n" + "\n".join(trigger_violations)
        )
        assert not plpgsql_violations, (
            "PL/pgSQL-функции на GP исполняются только на координаторе:\n"
            + "\n".join(plpgsql_violations)
        )

    def test_pg_acts_schema_no_updated_at_trigger(self):
        """PG- и GP-схемы acts синхронизированы: updated_at выставляется явно
        в SQL репозиториев, функция ``update_updated_at_column`` и связанные
        CREATE TRIGGER в обеих схемах отсутствуют."""
        base = Path(__file__).parent.parent / "app" / "domains" / "acts" / "migrations"
        for db_type in ("postgresql", "greenplum"):
            schema = base / db_type / "schema.sql"
            content = schema.read_text(encoding="utf-8")
            # Вырезаем комментарии — допускаем упоминание в пояснительных секциях.
            stripped = re.sub(r'--[^\n]*', '', content)
            stripped = re.sub(r'/\*.*?\*/', '', stripped, flags=re.DOTALL)
            assert "update_updated_at_column" not in stripped, (
                f"{db_type}/schema.sql: функция update_updated_at_column "
                f"должна быть удалена (updated_at выставляется в SQL репозиториев)"
            )
            assert not re.search(r'\bCREATE\s+TRIGGER\b', stripped, re.IGNORECASE), (
                f"{db_type}/schema.sql: CREATE TRIGGER должен быть удалён"
            )

    def test_chat_domain_migration_discovered(self, gp_schema_files):
        """GP-миграция домена chat обнаруживается автоматически."""
        domain_names = {s.parent.parent.parent.name for s in gp_schema_files}
        assert "chat" in domain_names, (
            f"Миграция chat не найдена среди GP-схем. "
            f"Обнаруженные домены: {sorted(domain_names)}"
        )

    def test_notifications_domain_migration_discovered(self, gp_schema_files):
        """GP-миграция домена notifications обнаруживается автоматически."""
        domain_names = {s.parent.parent.parent.name for s in gp_schema_files}
        assert "notifications" in domain_names, (
            f"Миграция notifications не найдена среди GP-схем. "
            f"Обнаруженные домены: {sorted(domain_names)}"
        )

    def test_notifications_gp_distribution_and_pk(self):
        """Обе таблицы notifications в GP-схеме: DISTRIBUTED BY ⊆ PRIMARY KEY.

        notifications: PK (id), DISTRIBUTED BY (id).
        notification_state: PK (notification_id, user_id), DISTRIBUTED BY
        (notification_id) — co-location с notifications по id для join.
        """
        schema_path = (
            Path(__file__).parent.parent
            / "app" / "domains" / "notifications" / "migrations"
            / "greenplum" / "schema.sql"
        )
        content = schema_path.read_text(encoding="utf-8")
        stmts = DatabaseAdapter._split_sql_statements(content)

        expected = {
            "{PREFIX}notifications": ("id", {"id"}),
            "{PREFIX}notification_state": (
                "notification_id", {"notification_id", "user_id"},
            ),
        }

        for table_marker, (dist_col, pk_cols) in expected.items():
            create_stmt = None
            for raw in stmts:
                cleaned = re.sub(r'--[^\n]*', '', raw)
                if (
                    re.search(r'\bCREATE\s+TABLE\b', cleaned, re.IGNORECASE)
                    and table_marker in cleaned
                    # notification_state содержит подстроку "notifications"? нет —
                    # маркеры различны, но notifications-маркер шире: отсекаем
                    # state через явную проверку distribution-колонки ниже.
                ):
                    create_stmt = cleaned
                    # Берём первый CREATE TABLE с точным distribution-clause.
                    if re.search(
                        rf'DISTRIBUTED\s+BY\s*\(\s*{dist_col}\s*\)',
                        cleaned, re.IGNORECASE,
                    ):
                        break
            assert create_stmt is not None, (
                f"GP-схема notifications: CREATE TABLE {table_marker} не найдено"
            )
            assert re.search(
                rf'DISTRIBUTED\s+BY\s*\(\s*{dist_col}\s*\)',
                create_stmt, re.IGNORECASE,
            ), f"{table_marker}: DISTRIBUTED BY ({dist_col}) не найден"

            pk_match = re.search(
                r'PRIMARY\s+KEY\s*\(([^)]+)\)', create_stmt, re.IGNORECASE,
            )
            if pk_match:
                found_pk = {c.strip().lower() for c in pk_match.group(1).split(',')}
            else:
                # inline "id VARCHAR(36) PRIMARY KEY" — одноколоночный PK.
                inline = re.search(
                    r'(\w+)\s+[^\n,]*\bPRIMARY\s+KEY\b', create_stmt, re.IGNORECASE,
                )
                assert inline is not None, (
                    f"{table_marker}: PRIMARY KEY не найден"
                )
                found_pk = {inline.group(1).strip().lower()}
            assert found_pk == pk_cols, (
                f"{table_marker}: PK {sorted(found_pk)} != ожидаемого "
                f"{sorted(pk_cols)}"
            )
            assert {dist_col}.issubset(found_pk), (
                f"{table_marker}: DIST {dist_col} ⊄ PK {sorted(found_pk)}"
            )

    def test_chat_messages_has_status_column(self):
        """chat_messages в обеих схемах содержит колонку status с CHECK-констрейнтом
        check_chat_messages_status_values (Phase 0 «D»: server-authoritative state)."""
        base = Path(__file__).parent.parent / "app" / "domains" / "chat" / "migrations"
        for db_type in ("postgresql", "greenplum"):
            schema_path = base / db_type / "schema.sql"
            content = schema_path.read_text(encoding="utf-8")

            # Используем splitter — он корректно игнорирует ; внутри
            # комментариев / строк / dollar-quoting.
            stmts = DatabaseAdapter._split_sql_statements(content)
            create_stmt = None
            for raw in stmts:
                # Срезаем line-комментарии — иначе документация может шадовить.
                cleaned = re.sub(r'--[^\n]*', '', raw)
                if (
                    re.search(r'\bCREATE\s+TABLE\b', cleaned, re.IGNORECASE)
                    and "{PREFIX}chat_messages" in cleaned
                    and "agent" not in cleaned  # отсекаем chat_audit_log/etc, не нужно
                ):
                    create_stmt = cleaned
                    break

            assert create_stmt is not None, (
                f"{db_type}/schema.sql: CREATE TABLE chat_messages не найдено"
            )
            assert re.search(r'\bstatus\b\s+VARCHAR', create_stmt, re.IGNORECASE), (
                f"{db_type}/schema.sql: колонка status не найдена в "
                f"CREATE TABLE chat_messages"
            )
            assert "check_chat_messages_status_values" in create_stmt, (
                f"{db_type}/schema.sql: CHECK-констрейнт "
                f"check_chat_messages_status_values не найден в "
                f"CREATE TABLE chat_messages"
            )
            # Допустимые значения статуса
            for v in ("streaming", "complete", "failed"):
                assert f"'{v}'" in create_stmt, (
                    f"{db_type}/schema.sql: значение '{v}' отсутствует в CHECK"
                )

    def test_chat_messages_has_agent_ref_column(self):
        """chat_messages в обеих схемах содержит колонку agent_ref VARCHAR(36)
        (Phase 1: ссылка draft-сообщения на строку-вопрос в chat_agent_messages_bus)."""
        base = Path(__file__).parent.parent / "app" / "domains" / "chat" / "migrations"
        for db_type in ("postgresql", "greenplum"):
            schema_path = base / db_type / "schema.sql"
            content = schema_path.read_text(encoding="utf-8")
            assert "agent_ref" in content, (
                f"{db_type}/schema.sql: колонка agent_ref не найдена — "
                f"ожидается ADD COLUMN agent_ref VARCHAR(36) для chat_messages"
            )
            assert "agent_ref VARCHAR(36)" in content, (
                f"{db_type}/schema.sql: agent_ref VARCHAR(36) не найдено — "
                f"проверь тип колонки"
            )

    def test_chat_schemas_have_no_legacy_agent_bridge_tables(self):
        """Старые 3-табличные artefact'ы моста удалены из обеих схем чата.

        Канал к внешнему агенту теперь — единственная bus-таблица
        chat_agent_messages_bus; старые agent_requests / agent_response_events /
        agent_responses (+ их sequence) не должны создаваться.
        """
        for db_type in ("postgresql", "greenplum"):
            schema_path = (
                Path(__file__).parent.parent
                / "app" / "domains" / "chat" / "migrations" / db_type / "schema.sql"
            )
            content = schema_path.read_text(encoding="utf-8")

            for table in ("agent_requests", "agent_response_events", "agent_responses"):
                assert f"{{PREFIX}}{table}" not in content, (
                    f"{db_type}/schema.sql: легаси-таблица {table} всё ещё в схеме"
                )

            assert "agent_response_events_id_seq" not in content, (
                f"{db_type}/schema.sql: легаси-sequence agent_response_events_id_seq "
                f"всё ещё в схеме"
            )

    def test_chat_agent_messages_bus_mirrors_external_owner_structure(self):
        """Bus-таблица в обеих схемах зеркалит фактическую структуру владельца (агента).

        Колонки conversation_id в шине НЕТ (uid сообщения — колонка id типа
        uuid); GP-имитация — DISTRIBUTED BY (chat_id) без PRIMARY KEY
        (у владельца id nullable). Регрессия на возврат старой структуры,
        ронявшей запросы «column id does not exist» на проде.
        """
        base = Path(__file__).parent.parent / "app" / "domains" / "chat" / "migrations"
        for db_type in ("postgresql", "greenplum"):
            content = (base / db_type / "schema.sql").read_text(encoding="utf-8")
            stmts = DatabaseAdapter._split_sql_statements(content)

            create_stmt = None
            for raw in stmts:
                cleaned = re.sub(r'--[^\n]*', '', raw)
                if (
                    re.search(r'\bCREATE\s+TABLE\b', cleaned, re.IGNORECASE)
                    and "{BUS_TABLE}" in cleaned
                ):
                    create_stmt = cleaned
                    break

            assert create_stmt is not None, (
                f"{db_type}-схема chat: CREATE TABLE chat_agent_messages_bus не найдено"
            )

            assert "conversation_id" not in create_stmt, (
                f"{db_type}/schema.sql: в bus-таблице не должно быть conversation_id "
                f"(uid сообщения — колонка id; структуру задаёт владелец-агент)"
            )
            assert re.search(r'\bid\s+UUID\b', create_stmt, re.IGNORECASE), (
                f"{db_type}/schema.sql: колонка id UUID не найдена в bus-таблице"
            )
            assert re.search(r'\breply_to\s+UUID\b', create_stmt, re.IGNORECASE), (
                f"{db_type}/schema.sql: колонка reply_to UUID не найдена в bus-таблице"
            )
            assert re.search(
                r'PRIMARY\s+KEY', create_stmt, re.IGNORECASE
            ) is None, (
                f"{db_type}/schema.sql: у bus-таблицы не должно быть PRIMARY KEY "
                f"(у владельца id nullable)"
            )

            if db_type == "greenplum":
                assert re.search(
                    r'DISTRIBUTED\s+BY\s*\(\s*chat_id\s*\)', create_stmt, re.IGNORECASE
                ), "DISTRIBUTED BY (chat_id) не найден в CREATE TABLE chat_agent_messages_bus"

    def test_chat_agent_messages_bus_name_is_prefix_free_placeholder(self):
        """Bus-таблица именуется плейсхолдером {BUS_TABLE} без {PREFIX}.

        Шина — интеграционный «провод» к внешнему агенту: её имя задаётся
        настройкой CHAT__AGENT_CHANNEL__TABLE_NAME целиком, префикс приложения
        (DATABASE__TABLE_PREFIX) к ней НЕ клеится. Регрессия на случай возврата
        {PREFIX} перед именем bus-таблицы.
        """
        base = (
            Path(__file__).parent.parent
            / "app" / "domains" / "chat" / "migrations"
        )
        for db_type in ("postgresql", "greenplum"):
            content = (base / db_type / "schema.sql").read_text(encoding="utf-8")
            assert "{BUS_TABLE}" in content, (
                f"{db_type}/schema.sql: плейсхолдер {{BUS_TABLE}} не найден"
            )
            assert "{PREFIX}chat_agent_messages_bus" not in content, (
                f"{db_type}/schema.sql: bus-таблица всё ещё префиксуется {{PREFIX}}"
            )

    def test_gp_schema_no_forbidden_constructs(self):
        """GP-схема chat не содержит конструкций, запрещённых в GP 6.x / PG 9.4."""
        schema_path = (
            Path(__file__).parent.parent
            / "app" / "domains" / "chat" / "migrations" / "greenplum" / "schema.sql"
        )
        content = schema_path.read_text(encoding="utf-8")
        # Вырезаем line-комментарии перед проверкой
        stripped = re.sub(r'--[^\n]*', '', content)

        forbidden = {
            'SKIP LOCKED': re.compile(r'\bSKIP\s+LOCKED\b', re.IGNORECASE),
            'jsonb_set()': re.compile(r'\bjsonb_set\s*\(', re.IGNORECASE),
            'ON CONFLICT': re.compile(r'\bON\s+CONFLICT\b', re.IGNORECASE),
            'gen_random_uuid()': re.compile(r'\bgen_random_uuid\s*\(', re.IGNORECASE),
        }
        violations = [
            name for name, pat in forbidden.items() if pat.search(stripped)
        ]
        assert not violations, (
            f"GP-схема chat содержит конструкции, запрещённые в GP 6.x: "
            + ", ".join(violations)
        )

    def test_chat_message_feedback_present_in_both_schemas(self):
        """chat_message_feedback есть в обеих схемах с CHECK на rating (up/down)."""
        base = Path(__file__).parent.parent / "app" / "domains" / "chat" / "migrations"
        for db_type in ("postgresql", "greenplum"):
            content = (base / db_type / "schema.sql").read_text(encoding="utf-8")
            assert "{PREFIX}chat_message_feedback" in content, (
                f"{db_type}/schema.sql: таблица chat_message_feedback не найдена"
            )
            assert "check_chat_message_feedback_rating_values" in content, (
                f"{db_type}/schema.sql: CHECK rating не найден"
            )
            for v in ("'up'", "'down'"):
                assert v in content, f"{db_type}/schema.sql: значение {v} не найдено"

    def test_chat_message_feedback_gp_distribution_and_pk(self):
        """GP: chat_message_feedback DISTRIBUTED BY (message_id) ⊆ PK (message_id, user_id).

        message_id ведущий в PK (lookup WHERE message_id=$1 по PK-индексу),
        co-location по сообщению, идемпотентность даёт сам составной PK.
        """
        schema_path = (
            Path(__file__).parent.parent
            / "app" / "domains" / "chat" / "migrations" / "greenplum" / "schema.sql"
        )
        content = schema_path.read_text(encoding="utf-8")
        stmts = DatabaseAdapter._split_sql_statements(content)

        create_stmt = None
        for raw in stmts:
            cleaned = re.sub(r'--[^\n]*', '', raw)
            if (
                re.search(r'\bCREATE\s+TABLE\b', cleaned, re.IGNORECASE)
                and "{PREFIX}chat_message_feedback" in cleaned
            ):
                create_stmt = cleaned
                break

        assert create_stmt is not None, (
            "GP-схема chat: CREATE TABLE chat_message_feedback не найдено"
        )
        assert re.search(
            r'DISTRIBUTED\s+BY\s*\(\s*message_id\s*\)', create_stmt, re.IGNORECASE
        ), "DISTRIBUTED BY (message_id) не найден в chat_message_feedback"

        pk_match = re.search(
            r'PRIMARY\s+KEY\s*\(([^)]+)\)', create_stmt, re.IGNORECASE,
        )
        assert pk_match is not None, "PRIMARY KEY не найден в chat_message_feedback"
        pk_cols = {c.strip().lower() for c in pk_match.group(1).split(',')}
        assert pk_cols == {"message_id", "user_id"}, (
            f"chat_message_feedback PK {sorted(pk_cols)} != "
            f"{{message_id, user_id}}"
        )

    def test_user_avatars_present_in_both_schemas(self):
        """Фото профиля (admin.user_avatars) есть в обеих схемах, колонки совпадают."""
        base = Path(__file__).parent.parent / "app" / "domains" / "admin" / "migrations"
        for db_type in ("postgresql", "greenplum"):
            content = (base / db_type / "schema.sql").read_text(encoding="utf-8")
            assert "{PREFIX}user_avatars" in content, (
                f"{db_type}/schema.sql: таблица user_avatars не найдена"
            )
            for column in ("user_id", "image", "mime", "updated_at"):
                assert column in content, (
                    f"{db_type}/schema.sql: колонка {column} не найдена"
                )

    def test_user_avatars_gp_distributed_by_user_id(self):
        """GP: user_avatars DISTRIBUTED BY (user_id) — он же единственный PK."""
        schema_path = (
            Path(__file__).parent.parent
            / "app" / "domains" / "admin" / "migrations" / "greenplum" / "schema.sql"
        )
        content = schema_path.read_text(encoding="utf-8")

        create_stmt = None
        for raw in DatabaseAdapter._split_sql_statements(content):
            cleaned = re.sub(r'--[^\n]*', '', raw)
            if (
                re.search(r'\bCREATE\s+TABLE\b', cleaned, re.IGNORECASE)
                and "{PREFIX}user_avatars" in cleaned
            ):
                create_stmt = cleaned
                break

        assert create_stmt is not None, (
            "GP-схема admin: CREATE TABLE user_avatars не найдено"
        )
        assert re.search(
            r'DISTRIBUTED\s+BY\s*\(\s*user_id\s*\)', create_stmt, re.IGNORECASE
        ), "DISTRIBUTED BY (user_id) не найден в user_avatars"
        assert re.search(
            r'user_id\s+VARCHAR\(\d+\)\s+PRIMARY\s+KEY', create_stmt, re.IGNORECASE
        ), "user_id должен быть PRIMARY KEY (distribution key ⊆ PK)"


# ---------------------------------------------------------------------------
# 2. SQL Statement Splitter (_split_sql_statements)
# ---------------------------------------------------------------------------


class TestSplitSqlStatements:
    """Тесты разделения SQL на отдельные операторы."""

    def test_simple_statements(self):
        """Разделяет простые операторы по точке с запятой."""
        sql = "CREATE TABLE t (id INT); CREATE INDEX idx ON t(id);"
        stmts = DatabaseAdapter._split_sql_statements(sql)
        assert len(stmts) == 2

    def test_dollar_quoting(self):
        """Не разбивает внутри $$ ... $$."""
        sql = """
CREATE FUNCTION f() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE t (id INT);
"""
        stmts = DatabaseAdapter._split_sql_statements(sql)
        assert len(stmts) == 2
        assert 'CREATE FUNCTION' in stmts[0]
        assert 'CREATE TABLE' in stmts[1]

    def test_single_quotes(self):
        """Не разбивает внутри строковых литералов."""
        sql = "INSERT INTO t (v) VALUES ('hello; world');"
        stmts = DatabaseAdapter._split_sql_statements(sql)
        assert len(stmts) == 1

    def test_escaped_quotes(self):
        """Обрабатывает экранированные кавычки ''."""
        sql = "INSERT INTO t (v) VALUES ('it''s; fine');"
        stmts = DatabaseAdapter._split_sql_statements(sql)
        assert len(stmts) == 1

    def test_line_comments(self):
        """Игнорирует ; в однострочных комментариях."""
        sql = "-- comment; with semicolon\nCREATE TABLE t (id INT);"
        stmts = DatabaseAdapter._split_sql_statements(sql)
        assert len(stmts) == 1

    def test_empty_input(self):
        """Пустая строка возвращает пустой список."""
        stmts = DatabaseAdapter._split_sql_statements("")
        assert stmts == []

    def test_comments_only(self):
        """Только комментарии — нет операторов."""
        sql = "-- just a comment\n-- another comment"
        stmts = DatabaseAdapter._split_sql_statements(sql)
        assert stmts == []

    def test_multiline_statement(self):
        """Многострочный оператор — один результат."""
        sql = """
CREATE TABLE t (
    id INT,
    name VARCHAR(50)
);
"""
        stmts = DatabaseAdapter._split_sql_statements(sql)
        assert len(stmts) == 1

    def test_real_greenplum_schema_pattern(self):
        """Проверяет разбиение типичного GP-паттерна."""
        sql = """
CREATE TABLE IF NOT EXISTS schema.prefix_acts (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL
)
WITH (appendonly=false)
DISTRIBUTED BY (id);

COMMENT ON TABLE schema.prefix_acts IS 'Test table';

CREATE INDEX idx_test ON schema.prefix_acts(name);

CREATE OR REPLACE FUNCTION schema.update_fn()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_test ON schema.prefix_acts;
CREATE TRIGGER trg_test
    BEFORE UPDATE ON schema.prefix_acts
    FOR EACH ROW
    EXECUTE PROCEDURE schema.update_fn();
"""
        stmts = DatabaseAdapter._split_sql_statements(sql)
        # CREATE TABLE, COMMENT, CREATE INDEX, CREATE FUNCTION, DROP TRIGGER, CREATE TRIGGER
        assert len(stmts) == 6

    def test_no_trailing_semicolon(self):
        """Обрабатывает SQL без финального ;"""
        sql = "CREATE TABLE t (id INT)"
        stmts = DatabaseAdapter._split_sql_statements(sql)
        assert len(stmts) == 1

    def test_where_clause_with_semicolon_in_string(self):
        """Не разбивает при ; внутри строк в WHERE."""
        sql = "INSERT INTO t (v) VALUES ('a;b'); SELECT 1;"
        stmts = DatabaseAdapter._split_sql_statements(sql)
        assert len(stmts) == 2

    def test_comment_on_with_quotes(self):
        """COMMENT ON с кавычками и ; внутри строки."""
        sql = "COMMENT ON TABLE t IS 'It''s a; table';"
        stmts = DatabaseAdapter._split_sql_statements(sql)
        assert len(stmts) == 1

    def test_multiple_dollar_quoted_functions(self):
        """Несколько функций с $$ блоками."""
        sql = """
CREATE FUNCTION f1() RETURNS VOID AS $$
BEGIN
    RAISE NOTICE 'hello;';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION f2() RETURNS VOID AS $$
BEGIN
    RAISE NOTICE 'world;';
END;
$$ LANGUAGE plpgsql;
"""
        stmts = DatabaseAdapter._split_sql_statements(sql)
        assert len(stmts) == 2
        assert 'f1' in stmts[0]
        assert 'f2' in stmts[1]

    def test_whitespace_only(self):
        """Пробелы и переносы строк — нет операторов."""
        sql = "   \n\n   \t  "
        stmts = DatabaseAdapter._split_sql_statements(sql)
        assert stmts == []

    def test_semicolons_only(self):
        """Только точки с запятой — нет реальных операторов."""
        sql = ";;;"
        stmts = DatabaseAdapter._split_sql_statements(sql)
        assert stmts == []

    def test_tagged_dollar_quoting(self):
        """Не разбивает внутри $tag$ ... $tag$."""
        sql = """
CREATE FUNCTION f() RETURNS TRIGGER AS $body$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$body$ LANGUAGE plpgsql;

CREATE TABLE t (id INT);
"""
        stmts = DatabaseAdapter._split_sql_statements(sql)
        assert len(stmts) == 2
        assert 'CREATE FUNCTION' in stmts[0]
        assert '$body$' in stmts[0]
        assert 'CREATE TABLE' in stmts[1]

    def test_block_comments(self):
        """Игнорирует ; внутри блочных комментариев /* ... */."""
        sql = "/* comment; with semicolon */\nCREATE TABLE t (id INT);"
        stmts = DatabaseAdapter._split_sql_statements(sql)
        assert len(stmts) == 1
        assert 'CREATE TABLE' in stmts[0]

    def test_block_comments_only(self):
        """Только блочные комментарии — нет операторов."""
        sql = "/* just a comment; here */ /* another */;"
        stmts = DatabaseAdapter._split_sql_statements(sql)
        assert stmts == []

    def test_block_comment_multiline(self):
        """Многострочный блочный комментарий с ;."""
        sql = """
/* This is a
   multi-line comment;
   with semicolons; everywhere */
CREATE TABLE t (id INT);
"""
        stmts = DatabaseAdapter._split_sql_statements(sql)
        assert len(stmts) == 1


# ---------------------------------------------------------------------------
# 3. Извлечение имени домена из пути к schema.sql
# ---------------------------------------------------------------------------


class TestDomainNameExtraction:
    """Проверяет корректное извлечение имени домена из пути к schema.sql."""

    def test_domain_name_from_schema_path(self):
        """schema_path.parent.parent.parent.name == имя домена."""
        base = Path(__file__).parent.parent / "app" / "domains"
        found_any = False
        for domain_dir in base.iterdir():
            if not domain_dir.is_dir():
                continue
            for db_type in ("postgresql", "greenplum"):
                schema = domain_dir / "migrations" / db_type / "schema.sql"
                if schema.exists():
                    found_any = True
                    domain_name = schema.parent.parent.parent.name
                    assert domain_name == domain_dir.name, (
                        f"Имя домена из {schema} = '{domain_name}', "
                        f"ожидалось '{domain_dir.name}'"
                    )
        assert found_any, "Не найдено ни одного schema.sql для проверки"

    def test_path_structure_depth(self):
        """Проверяет что все schema.sql расположены на ожидаемой глубине."""
        base = Path(__file__).parent.parent / "app" / "domains"
        for schema in base.glob("*/migrations/*/schema.sql"):
            # schema.parent = postgresql/ или greenplum/
            # schema.parent.parent = migrations/
            # schema.parent.parent.parent = domain_dir/
            assert schema.parent.parent.name == "migrations", (
                f"Родительская директория должна быть 'migrations', "
                f"получено '{schema.parent.parent.name}' для {schema}"
            )
            assert schema.parent.name in ("postgresql", "greenplum"), (
                f"Тип БД должен быть 'postgresql' или 'greenplum', "
                f"получено '{schema.parent.name}' для {schema}"
            )


# ---------------------------------------------------------------------------
# 4. Пооператорное выполнение SQL в Greenplum-адаптере
# ---------------------------------------------------------------------------


class TestGreenplumStatementExecution:
    """Тесты пооператорного выполнения SQL в Greenplum-адаптере."""

    @pytest.fixture
    def adapter(self):
        return GreenplumAdapter(schema="test_schema", table_prefix="test_")

    @pytest.fixture
    def conn(self):
        """Mock asyncpg connection."""
        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock(return_value=None)
        mock_conn.fetch = AsyncMock(return_value=[])
        return mock_conn

    async def test_duplicate_index_continues(self, adapter, conn, tmp_path):
        """DuplicateObjectError на одном индексе не останавливает выполнение остальных."""
        schema_dir = tmp_path / "testdomain" / "migrations" / "greenplum"
        schema_dir.mkdir(parents=True)
        schema = schema_dir / "schema.sql"
        schema.write_text(
            "CREATE TABLE test_schema.test_t (id INT);\n"
            "CREATE INDEX idx_1 ON test_schema.test_t(id);\n"
            "CREATE INDEX idx_2 ON test_schema.test_t(id);\n",
            encoding='utf-8'
        )

        call_count = 0

        async def side_effect(sql):
            nonlocal call_count
            call_count += 1
            if 'idx_1' in sql:
                raise asyncpg.DuplicateObjectError("already exists")
            return None

        conn.execute = AsyncMock(side_effect=side_effect)
        # pre-check: нет таблиц; post-verify: таблица создана
        conn.fetch.side_effect = [
            [],                                         # pre-check
            [{"tablename": "test_t"}],                  # post-verify
        ]

        await adapter.create_tables(conn, [schema])

        # Все 3 оператора должны быть выполнены
        assert call_count == 3

    async def test_duplicate_table_continues(self, adapter, conn, tmp_path):
        """DuplicateTableError не останавливает выполнение остальных операторов."""
        schema_dir = tmp_path / "testdomain" / "migrations" / "greenplum"
        schema_dir.mkdir(parents=True)
        schema = schema_dir / "schema.sql"
        schema.write_text(
            "CREATE TABLE test_schema.test_t1 (id INT);\n"
            "CREATE TABLE test_schema.test_t2 (id INT);\n",
            encoding='utf-8'
        )

        call_count = 0

        async def side_effect(sql):
            nonlocal call_count
            call_count += 1
            if 'test_t1' in sql:
                raise asyncpg.DuplicateTableError("already exists")
            return None

        conn.execute = AsyncMock(side_effect=side_effect)
        conn.fetch.side_effect = [
            [],
            [{"tablename": "test_t1"}, {"tablename": "test_t2"}],
        ]

        await adapter.create_tables(conn, [schema])
        assert call_count == 2

    async def test_syntax_error_propagates(self, adapter, conn, tmp_path):
        """Реальные синтаксические ошибки пробрасываются."""
        schema_dir = tmp_path / "testdomain" / "migrations" / "greenplum"
        schema_dir.mkdir(parents=True)
        schema = schema_dir / "schema.sql"
        schema.write_text(
            "CREATE TABLE test_schema.test_t (id INT);\n"
            "INVALID SQL STATEMENT;\n",
            encoding='utf-8'
        )

        async def side_effect(sql):
            if 'INVALID' in sql:
                raise asyncpg.PostgresSyntaxError("syntax error")
            return None

        conn.execute = AsyncMock(side_effect=side_effect)
        conn.fetch.side_effect = [
            [],   # pre-check
        ]

        with pytest.raises(asyncpg.PostgresSyntaxError):
            await adapter.create_tables(conn, [schema])

    async def test_generic_exception_propagates(self, adapter, conn, tmp_path):
        """Неожиданные исключения пробрасываются."""
        schema_dir = tmp_path / "testdomain" / "migrations" / "greenplum"
        schema_dir.mkdir(parents=True)
        schema = schema_dir / "schema.sql"
        schema.write_text(
            "CREATE TABLE test_schema.test_err (id INT);\n",
            encoding='utf-8'
        )

        conn.execute = AsyncMock(side_effect=RuntimeError("unexpected failure"))
        conn.fetch.side_effect = [[], []]

        with pytest.raises(RuntimeError, match="unexpected failure"):
            await adapter.create_tables(conn, [schema])

    async def test_all_statements_executed_in_order(self, adapter, conn, tmp_path):
        """Все операторы выполняются последовательно."""
        schema_dir = tmp_path / "testdomain" / "migrations" / "greenplum"
        schema_dir.mkdir(parents=True)
        schema = schema_dir / "schema.sql"
        schema.write_text(
            "CREATE TABLE test_schema.test_t (id INT);\n"
            "CREATE INDEX idx_t ON test_schema.test_t(id);\n"
            "COMMENT ON TABLE test_schema.test_t IS 'Test';\n",
            encoding='utf-8'
        )

        executed = []

        async def side_effect(sql):
            executed.append(sql)
            return None

        conn.execute = AsyncMock(side_effect=side_effect)
        conn.fetch.side_effect = [
            [],                               # pre-check
            [{"tablename": "test_t"}],        # post-verify
        ]

        await adapter.create_tables(conn, [schema])

        assert len(executed) == 3
        assert 'CREATE TABLE' in executed[0]
        assert 'CREATE INDEX' in executed[1]
        assert 'COMMENT ON' in executed[2]

    async def test_schema_prefix_substitution_per_statement(self, adapter, conn, tmp_path):
        """Плейсхолдеры {SCHEMA} и {PREFIX} подставляются до разбиения."""
        schema_dir = tmp_path / "testdomain" / "migrations" / "greenplum"
        schema_dir.mkdir(parents=True)
        schema = schema_dir / "schema.sql"
        schema.write_text(
            "CREATE TABLE {SCHEMA}.{PREFIX}tbl (id INT);\n"
            "CREATE INDEX idx_tbl ON {SCHEMA}.{PREFIX}tbl(id);\n",
            encoding='utf-8'
        )

        executed = []

        async def side_effect(sql):
            executed.append(sql)
            return None

        conn.execute = AsyncMock(side_effect=side_effect)
        conn.fetch.side_effect = [
            [],
            [{"tablename": "test_tbl"}],
        ]

        await adapter.create_tables(conn, [schema])

        assert len(executed) == 2
        for stmt in executed:
            assert '{SCHEMA}' not in stmt
            assert '{PREFIX}' not in stmt
            assert 'test_schema.test_tbl' in stmt

    async def test_function_with_dollar_quoting_single_statement(self, adapter, conn, tmp_path):
        """Функция с $$ блоком выполняется как один оператор."""
        schema_dir = tmp_path / "testdomain" / "migrations" / "greenplum"
        schema_dir.mkdir(parents=True)
        schema = schema_dir / "schema.sql"
        schema.write_text(
            "CREATE TABLE test_schema.test_t (id INT);\n"
            "\n"
            "CREATE OR REPLACE FUNCTION test_schema.update_fn()\n"
            "RETURNS TRIGGER AS $$\n"
            "BEGIN\n"
            "    NEW.updated_at = CURRENT_TIMESTAMP;\n"
            "    RETURN NEW;\n"
            "END;\n"
            "$$ LANGUAGE plpgsql;\n",
            encoding='utf-8'
        )

        executed = []

        async def side_effect(sql):
            executed.append(sql)
            return None

        conn.execute = AsyncMock(side_effect=side_effect)
        conn.fetch.side_effect = [
            [],
            [{"tablename": "test_t"}],
        ]

        await adapter.create_tables(conn, [schema])

        assert len(executed) == 2
        # Функция должна быть единым оператором с $$ блоком
        assert '$$' in executed[1]
        assert 'CREATE OR REPLACE FUNCTION' in executed[1]
