"""
Optimistic concurrency check сохранения содержимого акта.

Клиент присылает в PUT /content поле expected_updated_at — acts.updated_at,
от которого порождено его состояние (metadata.updated_at из GET /content или
updated_at из ответа предыдущего PUT). Сервис сравнивает его с текущим
acts.updated_at ВНУТРИ транзакции записи (SELECT ... FOR UPDATE — конкурент
ждёт коммита и видит свежую метку). Расхождение → ContentConflictError
(HTTP 409, code 'content-conflict') с extra {current_updated_at,
last_edited_by, last_edited_at}. None → проверка пропускается (прочие
вызывающие: restore версий, старые клиенты).

Семантика сравнения: acts.updated_at — TIMESTAMP без tz (naive), pydantic
сериализует его наивной ISO-строкой с микросекундами, парсинг эхо-строки
даёт побитово тот же datetime — сравнение точное. tz-суффикс, если клиент
его добавил, отбрасывается без конвертации.
"""

import datetime as dt
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.domains.acts.exceptions import ContentConflictError
from app.domains.acts.schemas.act_content import ActDataSchema
from app.domains.acts.schemas.act_responses import SaveContentResponse
from app.domains.acts.services.act_content_service import ActContentService


@pytest.fixture(autouse=True)
def _patch_adapter(mock_adapter):
    with patch("app.db.repositories.base.get_adapter", return_value=mock_adapter):
        yield


# Метка последнего сохранения в БД — с микросекундами, как отдаёт asyncpg.
DB_UPDATED_AT = dt.datetime(2026, 8, 18, 10, 30, 45, 123456)
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
        "updated_at": DB_UPDATED_AT,
        "last_edited_by": "67890",
        "last_edited_at": LAST_EDITED_AT,
    })
    svc._content = MagicMock()
    svc._content.save_content = AsyncMock(return_value={
        "status": "success", "message": "ok", "dropped_orphans": 0,
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


def _make_data(expected_updated_at=None) -> ActDataSchema:
    kwargs = {}
    if expected_updated_at is not None:
        kwargs["expected_updated_at"] = expected_updated_at
    return ActDataSchema(
        tree={"id": "root", "label": "Акт", "children": []},
        saveType="auto",
        **kwargs,
    )


class TestExpectedUpdatedAtCheck:
    """Проверка expected_updated_at в save_content."""

    async def test_matching_expected_saves_ok(self):
        """Совпадающая метка — сохранение проходит, конфликта нет."""
        svc = _make_service()

        result = await svc.save_content(
            act_id=1, data=_make_data(DB_UPDATED_AT), username="12345",
        )

        assert result["status"] == "success"
        svc._crud.get_edit_stamp.assert_awaited_once_with(1)
        svc._content.save_content.assert_awaited_once()

    async def test_stale_expected_raises_conflict(self):
        """Устаревшая метка → ContentConflictError 409 c extra-полями."""
        svc = _make_service()
        stale = DB_UPDATED_AT - dt.timedelta(minutes=5)

        with pytest.raises(ContentConflictError) as exc_info:
            await svc.save_content(
                act_id=1, data=_make_data(stale), username="12345",
            )

        exc = exc_info.value
        assert exc.status_code == 409
        assert exc.code == "content-conflict"
        assert exc.extra["current_updated_at"] == DB_UPDATED_AT.isoformat()
        assert exc.extra["last_edited_by"] == "67890"
        assert exc.extra["last_edited_at"] == LAST_EDITED_AT.isoformat()
        # Ничего не записано и не залогировано.
        svc._content.save_content.assert_not_awaited()
        svc._audit.log.assert_not_awaited()

    async def test_missing_expected_skips_check(self):
        """Без expected_updated_at (None) проверка пропускается целиком."""
        svc = _make_service()

        result = await svc.save_content(
            act_id=1, data=_make_data(), username="12345",
        )

        assert result["status"] == "success"
        svc._crud.get_edit_stamp.assert_not_awaited()

    async def test_check_runs_inside_write_transaction(self):
        """Чтение метки — внутри транзакции записи (минимум TOCTOU-окна)."""
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
                "updated_at": DB_UPDATED_AT,
                "last_edited_by": "67890",
                "last_edited_at": LAST_EDITED_AT,
            }

        svc._crud.get_edit_stamp = AsyncMock(side_effect=_get_stamp)

        await svc.save_content(
            act_id=1, data=_make_data(DB_UPDATED_AT), username="12345",
        )

        assert call_log.index("tx:enter") < call_log.index("crud:get_edit_stamp")


class TestComparisonRoundTrip:
    """Устойчивость сравнения к round-trip сериализации pydantic.

    Фронт эхом возвращает строку, полученную из сериализации схемы
    (updated_at ответа PUT / metadata.updated_at из GET). Прогон значения
    через реальную сериализацию и обратный парсинг НЕ должен давать
    ложный 409; изменённое значение — должен.
    """

    @staticmethod
    def _roundtrip(value: dt.datetime) -> dt.datetime:
        """datetime → ISO-строка (реальная сериализация схемы) → datetime схемы."""
        serialized = SaveContentResponse(
            status="success", message="ok", updated_at=value,
        ).model_dump(mode="json")["updated_at"]
        assert isinstance(serialized, str)
        return _make_data(serialized).expected_updated_at

    async def test_roundtrip_value_does_not_conflict(self):
        """Эхо сериализованной метки (с микросекундами) — совпадение, не 409."""
        svc = _make_service()
        echoed = self._roundtrip(DB_UPDATED_AT)

        result = await svc.save_content(
            act_id=1, data=_make_data(echoed), username="12345",
        )
        assert result["status"] == "success"

    async def test_roundtrip_without_microseconds(self):
        """Метка с нулевыми микросекундами переживает round-trip без 409."""
        whole_second = dt.datetime(2026, 8, 18, 10, 30, 45)
        svc = _make_service(stamp={
            "updated_at": whole_second,
            "last_edited_by": "67890",
            "last_edited_at": whole_second,
        })
        echoed = self._roundtrip(whole_second)

        result = await svc.save_content(
            act_id=1, data=_make_data(echoed), username="12345",
        )
        assert result["status"] == "success"

    async def test_changed_value_conflicts(self):
        """Отличие даже на микросекунду — конфликт 409."""
        svc = _make_service()
        off_by_one = self._roundtrip(
            DB_UPDATED_AT + dt.timedelta(microseconds=1),
        )

        with pytest.raises(ContentConflictError):
            await svc.save_content(
                act_id=1, data=_make_data(off_by_one), username="12345",
            )

    async def test_tz_suffix_dropped_without_conversion(self):
        """tz-суффикс на той же wall-clock строке отбрасывается, не 409.

        БД хранит TIMESTAMP без tz; если клиентский путь добавил 'Z'/'+00:00'
        к той же наивной строке — сравниваем wall-clock, без конвертации.
        """
        svc = _make_service()
        aware = _make_data(DB_UPDATED_AT.isoformat() + "Z").expected_updated_at
        assert aware.tzinfo is not None

        result = await svc.save_content(
            act_id=1, data=_make_data(aware), username="12345",
        )
        assert result["status"] == "success"
