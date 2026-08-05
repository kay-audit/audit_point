"""
Репозиторий CS-валидации.

Операции с таблицей и представлением записей CS-валидации:
поиск, создание, пакетное обновление, мягкое удаление.
"""

import logging
from datetime import date

from app.core.settings_registry import get as get_domain_settings
from app.db.repositories.base import BaseRepository
from app.db.types import DbConn
from app.domains.ck_client_exp.schemas.cs_validation import CSValidationView
from app.domains.ck_client_exp.schemas.requests import FilterSpec
from app.domains.ck_client_exp.settings import CkClientExpSettings

logger = logging.getLogger("audit_workstation.domains.ck_client_exp.repository")

# Колонки представления v_db_oarb_ck_cs_validation, разрешённые для серверной
# фильтрации и сортировки (ORDER BY). Источник истины — поля схемы
# CSValidationView; whitelist защищает от инъекций в имена колонок/ORDER BY.
ALLOWED_COLUMNS: set[str] = set(CSValidationView.model_fields.keys())

# Разрешённые типы приведения для range-фильтра. cast валидируется по этому
# allowlist — сырое значение cast НЕ интерполируется в SQL напрямую.
_CAST_SQL = {"date": "DATE", "numeric": "NUMERIC"}


def _escape_like(value: str) -> str:
    """Экранирует спецсимволы шаблона LIKE/ILIKE (\\, %, _).

    Иначе пользовательская фраза «100%» матчила бы и «1000 рублей»
    (дефолтный escape-символ LIKE — обратный слэш)."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _coerce_range_bound(cast: str | None, value):
    """Готовит границу range-фильтра к бинду.

    Для cast=date нужен объект date: temporal-кодеки asyncpg бинарные, строка
    в DATE-параметре роняет запрос DataError (numeric-кодек, напротив, сам
    приводит str → Decimal — числа не трогаем). Пустое или некорректное
    значение → None (граница пропускается, как и прочий мусор в фильтрах)."""
    if value is None or str(value).strip() == "":
        return None
    if cast == "date":
        try:
            return date.fromisoformat(str(value).strip()[:10])
        except ValueError:
            return None
    return value

_DATE_FIELDS = {"dt_sz"}
_NULLABLE_FIELDS = _DATE_FIELDS | {"act_sub_number_id", "reestr_metric_id"}
_NUMERIC_DEFAULTS = {
    "metric_unic_clients": 0,
    "metric_element_counts": 0,
    "metric_amount_rubles": 0,
    "is_sent_to_top_brass": False,
}


def _coerce(field: str, value):
    """Приводит значение к типу, ожидаемому asyncpg, с учётом NOT NULL DEFAULT."""
    if value is None:
        if field in _NULLABLE_FIELDS:
            return None
        if field in _NUMERIC_DEFAULTS:
            return _NUMERIC_DEFAULTS[field]
        return ""
    if field in _DATE_FIELDS and isinstance(value, str):
        return date.fromisoformat(value[:10])
    return value


# Поля для INSERT (без системных полей id, created_at, updated_at и т.д.)
_INSERT_FIELDS = (
    "act_sub_number_id",
    "reestr_metric_id",
    "neg_finder_tb_id",
    "metric_code",
    "metric_name",
    "metric_unic_clients",
    "metric_element_counts",
    "metric_amount_rubles",
    "is_sent_to_top_brass",
    "km_id",
    "num_sz",
    "dt_sz",
    "act_item_number",
    "process_number",
    "process_name",
    "block_owner",
    "department_owner",
    "ck_comment",
    "created_by",
)


class CSValidationRepository(BaseRepository):
    """Операции с записями CS-валидации в БД."""

    def __init__(self, conn: DbConn):
        super().__init__(conn)
        s = get_domain_settings("ck_client_exp", CkClientExpSettings)
        self.table = self.adapter.qualify_table_name(s.cs_validation_table, s.schema_name)
        self.view = self.adapter.qualify_table_name(s.cs_validation_view, s.schema_name)

    # ------------------------------------------------------------------
    # ПОИСК ПО КОЛОНОЧНЫМ ФИЛЬТРАМ (настраиваемая таблица)
    # ------------------------------------------------------------------

    def _build_filter_where(
        self, filters: dict[str, FilterSpec] | None,
    ) -> tuple[str, list, int]:
        """Собирает WHERE из типизированных колоночных фильтров (FilterSpec).

        Учитываются только колонки из ALLOWED_COLUMNS (иначе фильтр пропускается —
        защита от инъекции в имя колонки). Все значения подставляются
        bind-параметрами, ``cast`` валидируется по allowlist (никакой
        интерполяции сырого cast). Семантика по ``op`` — канон СЫРОЕ значение:

        - ``contains``: ``CAST(col AS TEXT) ILIKE $i`` c параметром ``%value%``
          (спецсимволы LIKE экранируются); пустой ``value`` → фильтр
          пропускается;
        - ``eq``: ``CAST(col AS TEXT) = $i`` c параметром ``value``; пустой
          ``value`` → фильтр пропускается;
        - ``in``: ``CAST(col AS TEXT) IN ($i, ...)`` по ``values`` (текстовое
          равенство, как множественный ``eq``: сырой ``col IN`` ронял бы
          бинарные кодеки asyncpg на нетекстовых колонках); пустой список →
          ``1=0`` («совпадений нет»);
        - ``range``: ``cast`` обязателен (date→DATE, numeric→NUMERIC), иначе
          фильтр пропускается; условия собираются по наличию границ
          ``CAST(col AS T) >= $i`` и/или ``CAST(col AS T) <= $j``; границы
          cast=date приводятся к date-объектам (_coerce_range_bound);
        - ``contains_any``: ``(CAST(col AS TEXT) ILIKE $i OR ...)`` по каждой
          непустой фразе из values; пустой/пробельный список → пропуск (в
          отличие от ``in``, не ``1=0``).

        CAST в TEXT нужен, т.к. ILIKE/= по тексту не определены для numeric/
        date/bool без приведения. Совместимо с PG 9.4 / GP 6.x.
        Возвращает (clause, params, next_idx).
        """
        conditions: list[str] = []
        params: list = []
        idx = 1
        for column, spec in (filters or {}).items():
            if column not in ALLOWED_COLUMNS:
                continue
            op = spec.op
            if op == "contains":
                value = spec.value
                if value is None or str(value).strip() == "":
                    continue
                conditions.append(f"CAST({column} AS TEXT) ILIKE ${idx}")
                params.append(f"%{_escape_like(str(value))}%")
                idx += 1
            elif op == "eq":
                value = spec.value
                if value is None or str(value).strip() == "":
                    continue
                conditions.append(f"CAST({column} AS TEXT) = ${idx}")
                params.append(value)
                idx += 1
            elif op == "in":
                values = spec.values or []
                if not values:
                    conditions.append("1=0")
                    continue
                placeholders = ", ".join(f"${idx + i}" for i in range(len(values)))
                conditions.append(f"CAST({column} AS TEXT) IN ({placeholders})")
                params.extend(values)
                idx += len(values)
            elif op == "range":
                cast_sql = _CAST_SQL.get(spec.cast) if spec.cast else None
                if cast_sql is None:
                    continue
                lo = _coerce_range_bound(spec.cast, spec.from_)
                hi = _coerce_range_bound(spec.cast, spec.to)
                if lo is not None:
                    conditions.append(f"CAST({column} AS {cast_sql}) >= ${idx}")
                    params.append(lo)
                    idx += 1
                if hi is not None:
                    conditions.append(f"CAST({column} AS {cast_sql}) <= ${idx}")
                    params.append(hi)
                    idx += 1
            elif op == "contains_any":
                values = [v for v in (spec.values or []) if v is not None and str(v).strip() != ""]
                if not values:
                    continue  # нет фраз = фильтр не задан (в отличие от in: пустой in → 1=0)
                ors = []
                for v in values:
                    ors.append(f"CAST({column} AS TEXT) ILIKE ${idx}")
                    params.append(f"%{_escape_like(str(v))}%")
                    idx += 1
                conditions.append("(" + " OR ".join(ors) + ")")
        where = f" WHERE {' AND '.join(conditions)}" if conditions else ""
        return where, params, idx

    async def search_filtered(
        self,
        *,
        filters: dict[str, FilterSpec] | None = None,
        sort: list[tuple[str, str]] | None = None,
        sort_by: str | None = None,
        sort_dir: str = "asc",
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[dict], int]:
        """Поиск записей по колоночным фильтрам с сортировкой и подсчётом total.

        - Фильтры по whitelisted-колонкам (значения — bind-параметры): ``contains``/
          ``contains_any`` — ILIKE (одна фраза / любая из нескольких через OR);
          ``eq`` — точное равенство; ``in`` — членство в списке; ``range`` —
          типизированные границы (DATE/NUMERIC). Экранирование ILIKE-метасимволов —
          через ``_escape_like``.
        - Сортировка: ``sort`` — упорядоченный список (колонка, направление) для
          многоколоночного ORDER BY; если не задан — одиночные ``sort_by``/
          ``sort_dir``. Каждая колонка валидируется против ALLOWED_COLUMNS (иначе
          ValueError — защита от инъекции в ORDER BY); направление — только
          ASC/DESC. Без сортировки — стабильный ``ORDER BY id``.
        - ``COUNT(*)`` считается отдельным запросом с теми же WHERE-параметрами.

        Возвращает (страница записей, общее количество). SQL — PG 9.4 / GP 6.x.
        """
        specs = list(sort) if sort else (
            [(sort_by, sort_dir)] if sort_by is not None else []
        )
        order_parts: list[str] = []
        sort_cols: list[str] = []
        for column, direction in specs:
            if column not in ALLOWED_COLUMNS:
                raise ValueError(f"Недопустимая колонка сортировки: {column}")
            sort_cols.append(column)
            order_parts.append(
                f"{column} {'DESC' if str(direction).lower() == 'desc' else 'ASC'}"
            )
        # Завершающий стабильный ключ id — детерминированный порядок равных строк
        # между запросами COUNT/страниц в server-mode (LIMIT/OFFSET). Без него
        # ничьи по неуникальным колонкам могли бы «прыгать» на границах страниц.
        if order_parts and "id" not in sort_cols:
            order_parts.append("id ASC")
        order_by = (
            "ORDER BY " + ", ".join(order_parts) if order_parts else "ORDER BY id"
        )

        where, params, idx = self._build_filter_where(filters)

        total = await self.conn.fetchval(
            f"SELECT COUNT(*) FROM {self.view}{where}",
            *params,
        )

        query = (
            f"SELECT * FROM {self.view}{where} "
            f"{order_by} LIMIT ${idx} OFFSET ${idx + 1}"
        )
        rows = await self.conn.fetch(query, *params, limit, offset)
        logger.debug(
            "Поиск CS-валидации (фильтры): %s условий, сортировок=%s",
            len(params), len(order_parts),
        )
        return [dict(r) for r in rows], int(total or 0)

    # ------------------------------------------------------------------
    # ПОЛУЧЕНИЕ ПО ID
    # ------------------------------------------------------------------

    async def get_by_id(self, record_id: int) -> dict | None:
        """Возвращает запись CS-валидации по ID (из VIEW)."""
        row = await self.conn.fetchrow(
            f"SELECT * FROM {self.view} WHERE id = $1",
            record_id,
        )
        return dict(row) if row else None

    # ------------------------------------------------------------------
    # СОЗДАНИЕ
    # ------------------------------------------------------------------

    async def create(self, data: dict, username: str) -> dict:
        """
        Создаёт новую запись CS-валидации.

        Поля берутся из data, created_by = username.
        Возвращает словарь с id и created_at.
        """
        values = []
        for field in _INSERT_FIELDS:
            if field == "created_by":
                values.append(username)
            else:
                values.append(_coerce(field, data.get(field)))

        placeholders = ", ".join(f"${i}" for i in range(1, len(_INSERT_FIELDS) + 1))
        columns = ", ".join(_INSERT_FIELDS)

        query = (
            f"INSERT INTO {self.table} ({columns}) "
            f"VALUES ({placeholders}) "
            f"RETURNING id, created_at"
        )

        row = await self.conn.fetchrow(query, *values)
        logger.info("Создана запись CS-валидации id=%s пользователем %s", row["id"], username)
        return dict(row)

    # ------------------------------------------------------------------
    # ПАКЕТНОЕ ОБНОВЛЕНИЕ
    # ------------------------------------------------------------------

    async def batch_update(self, items: list[dict], username: str) -> int:
        """
        Пакетное обновление записей CS-валидации.

        В транзакции:
        1. Деактивирует существующие записи (soft delete).
        2. Вставляет новые версии записей.

        Возвращает количество обновлённых (деактивированных) записей.
        """
        if not items:
            return 0

        ids = [item["id"] for item in items if "id" in item]
        if not ids:
            return 0

        async with self.conn.transaction():
            # Деактивация старых записей
            id_placeholders = ", ".join(f"${i + 2}" for i in range(len(ids)))
            deactivate_query = (
                f"UPDATE {self.table} "
                f"SET updated_at = now(), is_actual = false, updated_by = $1 "
                f"WHERE id IN ({id_placeholders}) AND is_actual = true"
            )
            result = await self.conn.execute(deactivate_query, username, *ids)
            updated_count = int(result.split()[-1]) if result else 0

            # Вставка новых версий (пакетом)
            columns = ", ".join(_INSERT_FIELDS)
            placeholders = ", ".join(
                f"${i}" for i in range(1, len(_INSERT_FIELDS) + 1)
            )
            insert_query = (
                f"INSERT INTO {self.table} ({columns}) "
                f"VALUES ({placeholders})"
            )
            rows_to_insert = []
            for item in items:
                values = []
                for field in _INSERT_FIELDS:
                    if field == "created_by":
                        values.append(username)
                    else:
                        values.append(_coerce(field, item.get(field)))
                rows_to_insert.append(values)
            await self.conn.executemany(insert_query, rows_to_insert)

        logger.info(
            "Пакетное обновление CS-валидации: %s записей деактивировано, "
            "%s новых версий вставлено пользователем %s",
            updated_count, len(items), username,
        )
        return updated_count

    # ------------------------------------------------------------------
    # МЯГКОЕ УДАЛЕНИЕ
    # ------------------------------------------------------------------

    async def soft_delete(self, record_id: int, username: str) -> bool:
        """
        Мягкое удаление записи CS-валидации.

        Устанавливает is_actual=false, deleted_at=now(), updated_at=now(),
        updated_by=username. Возвращает True если запись была деактивирована.
        """
        result = await self.conn.execute(
            f"""
            UPDATE {self.table}
            SET is_actual = false,
                deleted_at = now(),
                updated_at = now(),
                updated_by = $1
            WHERE id = $2 AND is_actual = true
            """,
            username,
            record_id,
        )
        deleted = result == "UPDATE 1"
        if deleted:
            logger.info(
                "Мягкое удаление CS-валидации id=%s пользователем %s",
                record_id, username,
            )
        return deleted
