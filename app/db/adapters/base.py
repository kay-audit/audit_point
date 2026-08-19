"""
Базовый абстрактный класс для database адаптеров.

Определяет интерфейс для работы с различными СУБД.
"""

import logging
import re
from abc import ABC, abstractmethod
from collections.abc import Callable
from pathlib import Path

import asyncpg

logger = logging.getLogger("audit_workstation.db.adapters.base")


class DatabaseAdapter(ABC):
    """
    Абстрактный класс для адаптеров баз данных.

    Каждая СУБД должна реализовать этот интерфейс для обеспечения
    единообразной работы с разными типами баз данных.
    """

    @staticmethod
    def _extract_table_names_from_sql(sql: str) -> list[str]:
        """
        Извлекает имена таблиц из CREATE TABLE операторов в SQL.

        Args:
            sql: SQL-текст после подстановки плейсхолдеров

        Returns:
            Список имён таблиц в порядке их появления в SQL
        """
        pattern = r'CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)\s*\('
        return re.findall(pattern, sql, re.IGNORECASE)

    # Ключевые слова, начинающие НЕ-колоночное определение внутри CREATE TABLE.
    _TABLE_CONSTRAINT_KEYWORDS = frozenset({
        "CONSTRAINT", "PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "EXCLUDE", "LIKE",
    })

    @staticmethod
    def _top_level_segments(stmt: str, open_paren_idx: int) -> list[str]:
        """Сегменты верхнего уровня внутри ``( ... )``, разделённые запятыми.

        Скан с учётом строк (``'...'``), комментариев (``--``, ``/* */``) и
        вложенных скобок: запятая делит сегмент только на глубине 1 (типы вида
        ``VARCHAR(20)`` и инлайн ``CHECK (a IN (1,2))`` не дробятся). При
        несбалансированных скобках возвращает собранные к этому моменту сегменты.
        """
        n = len(stmt)
        i = open_paren_idx + 1
        depth = 1
        seg_start = i
        segments: list[str] = []
        while i < n and depth > 0:
            c = stmt[i]
            if c == '-' and i + 1 < n and stmt[i + 1] == '-':
                j = stmt.find('\n', i)
                i = n if j == -1 else j + 1
                continue
            if c == '/' and i + 1 < n and stmt[i + 1] == '*':
                j = stmt.find('*/', i + 2)
                i = n if j == -1 else j + 2
                continue
            if c == "'":
                i += 1
                while i < n:
                    if stmt[i] == "'":
                        if i + 1 < n and stmt[i + 1] == "'":
                            i += 2
                            continue
                        i += 1
                        break
                    i += 1
                continue
            if c == '(':
                depth += 1
            elif c == ')':
                depth -= 1
                if depth == 0:
                    segments.append(stmt[seg_start:i])
                    break
            elif c == ',' and depth == 1:
                segments.append(stmt[seg_start:i])
                seg_start = i + 1
            i += 1
        return segments

    @staticmethod
    def _extract_columns_from_sql(sql: str) -> dict[str, set[str]]:
        """Извлекает имена колонок каждой ``CREATE TABLE`` из SQL.

        Возвращает ``{полное_имя_таблицы: {колонка, ...}}``. Best-effort парсер
        для диагностики рассинхрона схемы (см. ``_warn_on_stale_tables``), НЕ для
        DDL: строки-ограничения таблицы отсекаются по ведущему ключевому слову,
        строковые литералы/комментарии и вложенные скобки игнорируются.
        """
        result: dict[str, set[str]] = {}
        for stmt in DatabaseAdapter._split_sql_statements(sql):
            # search, а не match: _split_sql_statements оставляет ведущие
            # комментарии/пробелы перед оператором (как и _extract_table_names_from_sql).
            m = re.search(
                r'CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)\s*\(',
                stmt, re.IGNORECASE,
            )
            if not m:
                continue
            table = m.group(1)
            open_idx = m.end() - 1  # позиция открывающей '('
            cols: set[str] = set()
            for segment in DatabaseAdapter._top_level_segments(stmt, open_idx):
                name = DatabaseAdapter._leading_identifier(segment)
                if name is None:
                    continue
                if name.upper() in DatabaseAdapter._TABLE_CONSTRAINT_KEYWORDS:
                    continue
                cols.add(name)
            result[table] = cols
        return result

    @staticmethod
    def _leading_identifier(segment: str) -> str | None:
        """Первый идентификатор сегмента — имя колонки.

        Сегмент от ``_top_level_segments`` может начинаться с ведущих
        комментариев (``-- ...`` перед колонкой в schema.sql их сохраняет),
        поэтому сначала отбрасываем пробелы и комментарии, затем читаем имя.
        """
        seg = segment
        while True:
            seg = seg.lstrip()
            if seg.startswith('--'):
                nl = seg.find('\n')
                seg = '' if nl == -1 else seg[nl + 1:]
                continue
            if seg.startswith('/*'):
                end = seg.find('*/')
                seg = '' if end == -1 else seg[end + 2:]
                continue
            break
        m = re.match(r'"?([A-Za-z_]\w*)"?', seg)
        return m.group(1) if m else None

    @staticmethod
    async def _actual_columns_by_schema(
        conn: asyncpg.Connection,
        table_names: list[str],
        *,
        default_schema: str,
    ) -> dict[str, set[str]]:
        """``{полное_имя: {колонка, ...}}`` из ``information_schema.columns``.

        Группирует имена по схеме так же, как ``_existing_tables_by_schema``:
        квалифицированные читаются в своей схеме, неквалифицированные — в
        ``default_schema``.
        """
        if not table_names:
            return {}

        by_schema: dict[str, dict[str, str]] = {}
        for name in table_names:
            parts = name.split(".")
            if len(parts) > 1:
                schema, simple = parts[-2], parts[-1]
            else:
                schema, simple = default_schema, name
            by_schema.setdefault(schema, {})[simple] = name

        result: dict[str, set[str]] = {}
        for schema, name_map in by_schema.items():
            rows = await conn.fetch(
                "SELECT table_name, column_name FROM information_schema.columns "
                "WHERE table_schema = $1 AND table_name = ANY($2::text[])",
                schema, list(name_map.keys()),
            )
            for r in rows:
                full = name_map.get(r["table_name"])
                if full is not None:
                    result.setdefault(full, set()).add(r["column_name"])
        return result

    async def _warn_on_stale_tables(
        self,
        conn: asyncpg.Connection,
        schema_sql: str,
        domain_name: str,
        *,
        db_label: str,
        default_schema: str,
    ) -> None:
        """Предупреждает, если существующая таблица устарела (нет новых колонок).

        Вызывается, когда все таблицы домена существуют: existence-check проходит,
        но таблица могла быть создана старой версией схемы. Без этой проверки
        приложение стартует «успешно» и падает уже в рантайме
        (``UndefinedColumnError`` на отсутствующей колонке). Только WARNING —
        старт не блокируется; миграцию выполняет человек: файл
        ``docs/migrations/<дата>-<таблица>-<поле>.md`` для расширяющего изменения
        либо пересоздание БД (``docs/migrations/drop-all-tables.md``) для
        ломающего.
        """
        try:
            expected_cols = self._extract_columns_from_sql(schema_sql)
            if not expected_cols:
                return
            actual_cols = await self._actual_columns_by_schema(
                conn, list(expected_cols.keys()), default_schema=default_schema,
            )
            for table, cols in expected_cols.items():
                actual = actual_cols.get(table)
                if not actual:
                    continue  # таблицы нет в БД — обрабатывается отдельной веткой create_tables
                missing_cols = cols - actual
                if missing_cols:
                    logger.warning(
                        f"{db_label}: таблица '{table.split('.')[-1]}' домена "
                        f"'{domain_name}' устарела — в БД отсутствуют колонки: "
                        f"{', '.join(sorted(missing_cols))}. Схема рассинхронизирована "
                        f"с кодом; накатите миграцию из docs/migrations/ или "
                        f"пересоздайте БД (docs/migrations/drop-all-tables.md)."
                    )
        except Exception as e:  # диагностика не должна ронять старт
            logger.debug(f"{db_label}: проверка дрейфа колонок пропущена: {e}")

    # Директива объявления внешней таблицы в schema.sql (см. _external_tables_from_sql).
    _EXTERNAL_TABLE_DIRECTIVE = re.compile(
        r'^\s*--\s*@external-table:\s*(\S+)\s*$', re.MULTILINE,
    )

    @classmethod
    def _external_tables_from_sql(cls, sql: str) -> set[str]:
        """Таблицы, объявленные в схеме внешними (создаёт и владеет другая сторона).

        Директива в schema.sql: ``-- @external-table: <имя как в DDL>``
        (парсится ПОСЛЕ подстановки плейсхолдеров). Для такой таблицы
        операторы-«спутники» (CREATE INDEX / COMMENT ON) пропускаются, если
        она уже существует: на чужой таблице они падают с
        ``InsufficientPrivilegeError`` («must be owner of relation ...») —
        даже ``CREATE INDEX IF NOT EXISTS``, когда индекса ещё нет.
        Спутники СОБСТВЕННЫХ уже существующих таблиц исполняются как раньше —
        иначе новый индекс из будущего релиза молча не доехал бы до
        развёрнутых стендов (дубликаты идемпотентны: IF NOT EXISTS на PG,
        перехват DuplicateObjectError на GP).
        """
        return set(cls._EXTERNAL_TABLE_DIRECTIVE.findall(sql))

    @staticmethod
    def _companion_target_table(stmt: str) -> str | None:
        """Целевая таблица оператора-«спутника» создания таблицы.

        «Спутники» — ``CREATE INDEX`` и ``COMMENT ON``. На уже существующей
        ВНЕШНЕЙ таблице (объявленной директивой ``-- @external-table:``, см.
        ``_external_tables_from_sql``) они пропускаются — мы не владелец и
        трогать её нельзя.

        Возвращает имя таблицы (как записано в SQL) для
        ``CREATE [UNIQUE] INDEX ... ON <t>`` и ``COMMENT ON TABLE <t>`` /
        ``COMMENT ON COLUMN <t>.<col>``. Для остальных операторов — None:
        их исполняем всегда (в частности ``ALTER TABLE`` — путь эволюции
        уже существующих собственных таблиц).
        """
        s = re.sub(r'/\*.*?\*/', '', stmt, flags=re.DOTALL)
        s = re.sub(r'--[^\n]*', '', s)
        m = re.match(
            r'\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?'
            r'\S+\s+ON\s+([^\s(]+)',
            s, re.IGNORECASE,
        )
        if m:
            return m.group(1)
        m = re.match(r'\s*COMMENT\s+ON\s+TABLE\s+(\S+)\s+IS\b', s, re.IGNORECASE)
        if m:
            return m.group(1)
        m = re.match(
            r'\s*COMMENT\s+ON\s+COLUMN\s+(\S+)\.[^\s.]+\s+IS\b', s, re.IGNORECASE,
        )
        if m:
            return m.group(1)
        return None

    @staticmethod
    async def _existing_tables_by_schema(
        conn: asyncpg.Connection,
        expected_names: list[str],
        *,
        default_schema: str,
    ) -> set[str]:
        """Проверяет существование таблиц в той схеме, где они объявлены.

        Имена из ``_extract_table_names_from_sql`` могут быть квалифицированы
        (``schema.table``) — например, когда домен размещает свои таблицы в
        отдельной схеме (``CHAT__SCHEMA_NAME`` / ``CHAT__AGENT_CHANNEL__SCHEMA_NAME``).
        Группируем по схеме и делаем по запросу на схему, проверяя таблицу именно
        там, где она создаётся, а не только в одной фиксированной схеме (иначе
        post-verify в ``create_tables`` ложно падал бы с RuntimeError на любой
        нестандартной схеме). Неквалифицированные имена относятся к
        ``default_schema``.
        """
        if not expected_names:
            return set()

        # schema -> {tablename: полное_ожидаемое_имя}
        by_schema: dict[str, dict[str, str]] = {}
        for name in expected_names:
            parts = name.split(".")
            if len(parts) > 1:
                schema, simple = parts[-2], parts[-1]
            else:
                schema, simple = default_schema, name
            by_schema.setdefault(schema, {})[simple] = name

        found: set[str] = set()
        for schema, name_map in by_schema.items():
            rows = await conn.fetch(
                "SELECT tablename FROM pg_tables "
                "WHERE schemaname = $1 AND tablename = ANY($2::text[])",
                schema, list(name_map.keys()),
            )
            for r in rows:
                full = name_map.get(r["tablename"])
                if full is not None:
                    found.add(full)
        return found

    @abstractmethod
    async def _get_existing_tables(
        self,
        conn: asyncpg.Connection,
        expected_names: list[str],
    ) -> set[str]:
        """
        Проверяет, какие из ожидаемых таблиц уже существуют в БД.

        Args:
            conn: Подключение к базе данных
            expected_names: Список ожидаемых имён таблиц (как в SQL)

        Returns:
            Множество имён существующих таблиц
        """
        pass

    @abstractmethod
    async def create_tables(
        self,
        conn: asyncpg.Connection,
        schema_paths: list[Path],
        substitutions: dict[str, str | Callable[[], str]] | None = None,
    ) -> None:
        """
        Создает таблицы в БД из списка SQL-схем.

        Args:
            conn: Подключение к базе данных
            schema_paths: Пути к файлам schema.sql каждого домена
            substitutions: Подстановки плейсхолдеров в SQL (например, {REF_HADOOP_TABLES} → имя таблицы)
        """
        pass

    @abstractmethod
    def get_table_name(self, base_name: str, schema: str = "") -> str:
        """
        Возвращает полное имя таблицы с учетом схемы/префикса.

        PostgreSQL: acts
        Greenplum: s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_acts

        Args:
            base_name: Базовое имя таблицы (acts, audit_team_members, etc.)
            schema: Явная схема-override. Пусто → основная схема (GP) /
                без квалификатора (PG). Позволяет домену разместить
                свои таблицы в отдельной схеме.

        Returns:
            Полное имя таблицы для использования в SQL
        """
        pass

    @abstractmethod
    def qualify_table_name(self, full_name: str, schema: str = "") -> str:
        """
        Квалифицирует имя таблицы схемой БЕЗ добавления префикса.

        Используется для справочных таблиц и таблиц других доменов,
        которые уже имеют полное имя и не нуждаются в префиксе.

        Args:
            full_name: Полное имя таблицы без схемы
            schema: Явная схема. Если пустая — Greenplum использует
                основную схему, PostgreSQL не квалифицирует.

        Returns:
            Имя таблицы, квалифицированное схемой
        """
        pass

    @abstractmethod
    def get_serial_type(self) -> str:
        """
        Возвращает тип для auto-increment колонок.

        PostgreSQL: SERIAL
        Greenplum: BIGSERIAL

        Returns:
            Название типа для использования в DDL
        """
        pass

    @abstractmethod
    def get_index_strategy(self, index_type: str) -> str:
        """
        Возвращает стратегию индексирования для конкретной СУБД.

        Args:
            index_type: Тип индекса (btree, gin, hash)

        Returns:
            Рекомендуемый тип индекса для данной СУБД
        """
        pass

    @abstractmethod
    def supports_cascade_delete(self) -> bool:
        """
        Проверяет поддержку ON DELETE CASCADE.

        Returns:
            True если СУБД поддерживает каскадное удаление
        """
        pass

    @abstractmethod
    def supports_on_conflict(self) -> bool:
        """
        Проверяет поддержку INSERT ... ON CONFLICT DO UPDATE.

        Returns:
            True если СУБД поддерживает ON CONFLICT
        """
        pass

    @abstractmethod
    async def get_current_schema(self, conn: asyncpg.Connection) -> str:
        """
        Возвращает текущую схему/namespace базы данных.

        Args:
            conn: Подключение к базе данных

        Returns:
            Название текущей схемы
        """
        pass

    @staticmethod
    def _split_sql_statements(sql: str) -> list[str]:
        """
        Разделяет SQL-текст на отдельные операторы.

        Корректно обрабатывает:
        - Разделение по `;`
        - Dollar-quoting (`$$...$$` и `$tag$...$tag$`) — не разбивает внутри
        - Блочные комментарии (`/* ... */`)
        - Однострочные комментарии (`--`)
        - Строковые литералы (`'...'` с экранированием `''`)
        """
        statements = []
        current_pos = 0
        i = 0
        n = len(sql)

        while i < n:
            c = sql[i]

            # Однострочный комментарий: пропускаем до конца строки
            if c == '-' and i + 1 < n and sql[i + 1] == '-':
                i = sql.find('\n', i)
                if i == -1:
                    break
                i += 1
                continue

            # Блочный комментарий /* ... */
            if c == '/' and i + 1 < n and sql[i + 1] == '*':
                end = sql.find('*/', i + 2)
                if end != -1:
                    i = end + 2
                else:
                    i = n
                continue

            # Строковый литерал в одинарных кавычках
            if c == "'":
                i += 1
                while i < n:
                    if sql[i] == "'":
                        if i + 1 < n and sql[i + 1] == "'":
                            i += 2  # экранированная кавычка
                        else:
                            i += 1
                            break
                    i += 1
                continue

            # Dollar-quoting ($$ или $tag$)
            if c == '$':
                m = re.match(r'\$(\w*)\$', sql[i:])
                if m:
                    tag = m.group(0)
                    end = sql.find(tag, i + len(tag))
                    if end != -1:
                        i = end + len(tag)
                    else:
                        i = n
                    continue

            # Разделитель операторов
            if c == ';':
                stmt = sql[current_pos:i + 1].strip()
                if stmt and stmt != ';':
                    # Пропускаем операторы, содержащие только комментарии
                    content = re.sub(r'/\*.*?\*/', '', stmt, flags=re.DOTALL)
                    content = re.sub(r'--[^\n]*', '', content).strip()
                    if content and content != ';':
                        statements.append(stmt)
                current_pos = i + 1

            i += 1

        # Оставшийся текст
        remaining = sql[current_pos:].strip()
        if remaining:
            content = re.sub(r'/\*.*?\*/', '', remaining, flags=re.DOTALL)
            content = re.sub(r'--[^\n]*', '', content).strip()
            if content:
                statements.append(remaining)

        return statements

    def qualify_column(self, table_alias: str, column: str) -> str:
        """
        Квалифицирует имя колонки с учетом алиаса таблицы.

        Args:
            table_alias: Алиас таблицы
            column: Имя колонки

        Returns:
            Квалифицированное имя колонки (например, a.id)
        """
        return f"{table_alias}.{column}"
