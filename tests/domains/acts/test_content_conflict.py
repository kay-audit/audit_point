"""
Optimistic concurrency check сохранения содержимого акта.

Токен — acts.content_version (INTEGER): счётчик версий СОДЕРЖИМОГО,
инкрементируется ТОЛЬКО при сохранении контента
(ActContentRepository._update_edit_timestamp). НЕ-контентные записи (правка
метаданных, update_total_parts_for_km при создании/удалении соседней части
КМ) бампят updated_at, но счётчик не трогают — поэтому ложных 409 не дают
(дефект первой версии OCC на updated_at).

Клиент присылает в PUT /content поле expected_content_version —
content_version, от которого порождено его состояние
(metadata.content_version из GET /content или content_version из ответа
предыдущего PUT). Сервис сравнивает его с текущим значением ВНУТРИ
транзакции записи (SELECT ... FOR UPDATE — конкурент ждёт коммита и видит
свежий счётчик). Расхождение → ContentConflictError (HTTP 409, code
'content-conflict') с extra {current_content_version, last_edited_by,
last_edited_at}. None → проверка пропускается (restore версий, прочие
вызывающие).
"""

import datetime as dt
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.domains.acts.exceptions import ContentConflictError
from app.domains.acts.schemas.act_content import ActDataSchema
from app.domains.acts.services.act_content_service import ActContentService


@pytest.fixture(autouse=True)
def _patch_adapter(mock_adapter):
    with patch("app.db.repositories.base.get_adapter", return_value=mock_adapter):
        yield


DB_CONTENT_VERSION = 7
LAST_EDITED_AT = dt.datetime(2026, 8, 18, 10, 30, 45, 123456)


def _make_service(stamp: dict | None = None):
    """ActContentService с моками; crud.get_edit_stamp отдаёт stamp."""
    conn = AsyncMock()
    tx = AsyncMock()
    tx.__aenter__ = AsyncMock(return_value=tx)
    tx.__aexit__ = AsyncMock(return_value=False)
    conn.transaction = MagicMock(return_value=tx)

    acts_settings = MagicMock()
    acts_settings.resource.max_tree_depth = 20
    acts_settings.audit_log.max_diff_elements = 100
    acts_settings.audit_log.max_diff_cells_per_table = 100
    acts_settings.audit_log.max_content_versions = 50

    svc = ActContentService(
        conn=conn,
        settings=MagicMock(),
        acts_settings=acts_settings,
        access=MagicMock(),
        lock=MagicMock(),
        crud=MagicMock(),
        content=MagicMock(),
        invoice=MagicMock(),
    )
    svc.guard = MagicMock()
    svc.guard.require_edit_permission = AsyncMock()
    svc.guard.require_lock_owner = AsyncMock()

    svc._crud = MagicMock()
    svc._crud.get_edit_stamp = AsyncMock(return_value=stamp or {
        "content_version": DB_CONTENT_VERSION,
        "last_edited_by": "67890",
        "last_edited_at": LAST_EDITED_AT,
    })
    svc._content = MagicMock()
    svc._content.save_content = AsyncMock(return_value={
        "status": "success", "message": "ok",
        "content_version": DB_CONTENT_VERSION + 1, "dropped_orphans": 0,
    })
    svc._audit = MagicMock()
    svc._audit.log = AsyncMock()
    svc._audit.compute_content_diff = AsyncMock(return_value={})
    svc._audit.compute_field_diffs = AsyncMock(return_value=None)
    svc._versions = MagicMock()
    svc._versions.create_version = AsyncMock(return_value=1)
    svc._invoice = MagicMock()
    svc._invoice.get_invoices_for_act = AsyncMock(return_value=[])
    return svc


def _make_data(expected_content_version=None) -> ActDataSchema:
    kwargs = {}
    if expected_content_version is not None:
        kwargs["expected_content_version"] = expected_content_version
    return ActDataSchema(
        tree={"id": "root", "label": "Акт", "children": []},
        saveType="auto",
        **kwargs,
    )


class TestExpectedContentVersionCheck:
    """Проверка expected_content_version в save_content."""

    async def test_matching_expected_saves_ok(self):
        """Совпадающий счётчик — сохранение проходит, конфликта нет."""
        svc = _make_service()

        result = await svc.save_content(
            act_id=1, data=_make_data(DB_CONTENT_VERSION), username="12345",
        )

        assert result["status"] == "success"
        svc._crud.get_edit_stamp.assert_awaited_once_with(1)
        svc._content.save_content.assert_awaited_once()

    async def test_stale_expected_raises_conflict(self):
        """Отстающий счётчик → ContentConflictError 409 c extra-полями."""
        svc = _make_service()

        with pytest.raises(ContentConflictError) as exc_info:
            await svc.save_content(
                act_id=1, data=_make_data(DB_CONTENT_VERSION - 1), username="12345",
            )

        exc = exc_info.value
        assert exc.status_code == 409
        assert exc.code == "content-conflict"
        assert exc.extra["current_content_version"] == DB_CONTENT_VERSION
        assert exc.extra["last_edited_by"] == "67890"
        assert exc.extra["last_edited_at"] == LAST_EDITED_AT.isoformat()
        # Ничего не записано и не залогировано.
        svc._content.save_content.assert_not_awaited()
        svc._audit.log.assert_not_awaited()

    async def test_missing_expected_skips_check(self):
        """Без expected_content_version (None) проверка пропускается целиком."""
        svc = _make_service()

        result = await svc.save_content(
            act_id=1, data=_make_data(), username="12345",
        )

        assert result["status"] == "success"
        svc._crud.get_edit_stamp.assert_not_awaited()

    async def test_zero_expected_is_checked_not_skipped(self):
        """expected_content_version=0 — легитимное значение (акт ещё не
        сохранялся), falsy-ноль НЕ трактуется как «пропустить проверку»."""
        svc = _make_service(stamp={
            "content_version": 0,
            "last_edited_by": None,
            "last_edited_at": None,
        })

        result = await svc.save_content(
            act_id=1, data=_make_data(0), username="12345",
        )

        assert result["status"] == "success"
        svc._crud.get_edit_stamp.assert_awaited_once_with(1)

    async def test_check_runs_inside_write_transaction(self):
        """Чтение счётчика — внутри транзакции записи (минимум TOCTOU-окна)."""
        call_log: list[str] = []
        svc = _make_service()

        tx = AsyncMock()

        async def _aenter():
            call_log.append("tx:enter")
            return tx

        tx.__aenter__ = AsyncMock(side_effect=_aenter)
        tx.__aexit__ = AsyncMock(return_value=False)
        svc.conn.transaction = MagicMock(return_value=tx)

        async def _get_stamp(act_id):
            call_log.append("crud:get_edit_stamp")
            return {
                "content_version": DB_CONTENT_VERSION,
                "last_edited_by": "67890",
                "last_edited_at": LAST_EDITED_AT,
            }

        svc._crud.get_edit_stamp = AsyncMock(side_effect=_get_stamp)

        await svc.save_content(
            act_id=1, data=_make_data(DB_CONTENT_VERSION), username="12345",
        )

        assert call_log.index("tx:enter") < call_log.index("crud:get_edit_stamp")


class TestContentVersionIncrementScope:
    """content_version инкрементируется ТОЛЬКО контентным путём.

    Дефект первой версии OCC: токеном был updated_at, который бампится и
    НЕ-контентными записями (метаданные, total_parts всех частей КМ при
    создании/удалении соседней части) — редактор ловил ложный 409. Токен
    заменён на content_version; эти тесты пинят границу инкремента.
    """

    async def test_update_edit_timestamp_increments_content_version(self, mock_conn):
        """Сохранение контента инкрементирует счётчик атомарно в UPDATE."""
        from app.domains.acts.repositories.act_content import ActContentRepository

        repo = ActContentRepository(mock_conn)
        await repo._update_edit_timestamp(1, "12345")

        update_sql = mock_conn.execute.await_args.args[0]
        assert "content_version = content_version + 1" in update_sql
        # Свежие значения возвращаются отдельным SELECT (GP: без RETURNING).
        select_sql = mock_conn.fetchrow.await_args.args[0]
        assert "content_version" in select_sql

    async def test_update_total_parts_does_not_touch_content_version(self, mock_conn):
        """Пересчёт total_parts (задевает ВСЕ части КМ) счётчик не трогает."""
        from app.domains.acts.repositories.act_crud import ActCrudRepository

        mock_conn.fetchval.return_value = 2
        repo = ActCrudRepository(mock_conn)
        await repo.update_total_parts_for_km(1234567)

        for call in mock_conn.execute.await_args_list:
            assert "content_version" not in call.args[0]

    def test_increment_exists_only_in_update_edit_timestamp(self):
        """Единственная точка инкремента во всём домене acts —
        ActContentRepository._update_edit_timestamp (страж от будущих
        «удобных» инкрементов из метаданных/CRUD-путей)."""
        from pathlib import Path

        import app.domains.acts as acts_pkg

        acts_dir = Path(acts_pkg.__file__).parent
        hits = sorted(
            path.name
            for path in acts_dir.rglob("*")
            if path.suffix in (".py", ".sql")
            and "content_version = content_version + 1"
            in path.read_text(encoding="utf-8")
        )
        assert hits == ["act_content.py"]

    def test_content_version_column_in_both_schemas(self):
        """Колонка объявлена в ОБЕИХ схемах (PG и GP) — NOT NULL DEFAULT 0."""
        from pathlib import Path

        import app.domains.acts as acts_pkg

        migrations = Path(acts_pkg.__file__).parent / "migrations"
        for flavor in ("postgresql", "greenplum"):
            schema = (migrations / flavor / "schema.sql").read_text(encoding="utf-8")
            assert "content_version INTEGER NOT NULL DEFAULT 0" in schema, flavor
