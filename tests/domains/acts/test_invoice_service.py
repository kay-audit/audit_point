"""Unit-тесты ActInvoiceService.

Покрывает справочники, list_tables, save_invoice (с детекцией изменений),
verify_invoice и get_invoices. Репозиторий и AccessGuard мокаются.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.domains.acts.exceptions import AccessDeniedError, InvoiceError
from app.domains.acts.services.act_invoice_service import ActInvoiceService
from app.domains.acts.settings import ActsSettings, InvoiceSettings
from app.domains.ua_data.interfaces import UaInvoiceTableNames


USERNAME = "22494524"
ACT_ID = 7
NODE_ID = "node-5-1-3"


@pytest.fixture(autouse=True)
def _patch_adapter(mock_adapter):
    """get_adapter() требуется для ActAuditLogRepository в __init__ сервиса."""
    with patch("app.db.repositories.base.get_adapter", return_value=mock_adapter):
        yield


def _make_settings(db_type: str = "greenplum") -> MagicMock:
    """Минимальный mock Settings — нужен только settings.database.type."""
    settings = MagicMock()
    settings.database.type = db_type
    return settings


def _make_acts_settings() -> ActsSettings:
    """ActsSettings с дефолтным InvoiceSettings."""
    return ActsSettings(invoice=InvoiceSettings())


def _make_ua_tables() -> UaInvoiceTableNames:
    """Имена справочных таблиц ua_data."""
    return UaInvoiceTableNames(
        violation_metric_dict="t_db_oarb_ua_violation_metric_dict",
        process_dict="t_db_oarb_ua_process_dict",
        subsidiary_dict="t_db_oarb_ua_subsidiary_dict",
    )


def _make_service(
    *,
    db_type: str = "greenplum",
    access_perm: dict | None = None,
    has_access: bool = True,
    invoice_repo: MagicMock | None = None,
) -> ActInvoiceService:
    """Собирает ActInvoiceService с замоканными репозиториями."""
    conn = MagicMock()

    access = MagicMock()
    if access_perm is None:
        access_perm = {"has_access": True, "can_edit": True, "role": "Куратор"}
    access.get_user_edit_permission = AsyncMock(return_value=access_perm)
    access.check_user_access = AsyncMock(return_value=has_access)

    lock = MagicMock()

    invoice = invoice_repo or MagicMock()
    # Безопасные дефолты для всех методов
    if not isinstance(invoice.list_metric_dict, AsyncMock):
        invoice.list_metric_dict = AsyncMock(return_value=[])
    if not isinstance(invoice.list_process_dict, AsyncMock):
        invoice.list_process_dict = AsyncMock(return_value=[])
    if not isinstance(invoice.list_subsidiary_dict, AsyncMock):
        invoice.list_subsidiary_dict = AsyncMock(return_value=[])
    if not isinstance(invoice.list_tables, AsyncMock):
        invoice.list_tables = AsyncMock(return_value=[])
    if not isinstance(invoice.save_invoice, AsyncMock):
        invoice.save_invoice = AsyncMock(return_value={})
    if not isinstance(invoice.get_invoice_for_node, AsyncMock):
        invoice.get_invoice_for_node = AsyncMock(return_value=None)
    if not isinstance(invoice.verify_invoice, AsyncMock):
        invoice.verify_invoice = AsyncMock(return_value={})
    if not isinstance(invoice.get_invoices_for_act, AsyncMock):
        invoice.get_invoices_for_act = AsyncMock(return_value=[])

    service = ActInvoiceService(
        conn=conn,
        settings=_make_settings(db_type),
        acts_settings=_make_acts_settings(),
        ua_tables=_make_ua_tables(),
        access=access,
        lock=lock,
        invoice=invoice,
    )
    service._audit = MagicMock()
    service._audit.log = AsyncMock()
    return service


# -------------------------------------------------------------------------
# Справочники: list_metrics / list_processes / list_subsidiaries
# -------------------------------------------------------------------------


class TestListDictionaries:
    """Справочники проксируют в репозиторий с правильными именами таблиц."""

    async def test_list_metrics_uses_ua_tables(self):
        """list_metrics зовёт repo с metric_table из UaInvoiceTableNames."""
        service = _make_service()
        service._invoice.list_metric_dict.return_value = [
            {"code": "ФР00001", "metric_name": "Тест", "metric_group": "ФР"},
        ]

        result = await service.list_metrics()

        assert result == [
            {"code": "ФР00001", "metric_name": "Тест", "metric_group": "ФР"},
        ]
        kwargs = service._invoice.list_metric_dict.await_args.kwargs
        assert kwargs["metric_table"] == "t_db_oarb_ua_violation_metric_dict"

    async def test_list_processes_passes_process_dict_table(self):
        """list_processes пробрасывает имя таблицы процессов из ua_tables."""
        service = _make_service()
        await service.list_processes()
        kwargs = service._invoice.list_process_dict.await_args.kwargs
        assert kwargs["process_table"] == "t_db_oarb_ua_process_dict"

    async def test_list_subsidiaries_passes_subsidiary_dict_table(self):
        """list_subsidiaries пробрасывает имя таблицы подразделений из ua_tables."""
        service = _make_service()
        await service.list_subsidiaries()
        kwargs = service._invoice.list_subsidiary_dict.await_args.kwargs
        assert kwargs["subsidiary_table"] == "t_db_oarb_ua_subsidiary_dict"

    async def test_postgres_resolves_schema_to_public(self):
        """Для postgresql _resolve_schema всегда возвращает 'public'."""
        service = _make_service(db_type="postgresql")
        await service.list_metrics()
        kwargs = service._invoice.list_metric_dict.await_args.kwargs
        assert kwargs["registry_schema"] == "public"

    async def test_greenplum_resolves_schema_from_settings(self):
        """Для greenplum _resolve_schema возвращает hive_registry_schema из настроек."""
        service = _make_service(db_type="greenplum")
        await service.list_metrics()
        kwargs = service._invoice.list_metric_dict.await_args.kwargs
        # Дефолт InvoiceSettings.hive_registry_schema
        assert kwargs["registry_schema"] == "s_grnplm_ld_audit_da_project_4"


# -------------------------------------------------------------------------
# list_tables
# -------------------------------------------------------------------------


class TestListTables:
    """list_tables проксирует в repo по db_type и валидирует тип."""

    async def test_list_tables_hive_uses_registry_params(self):
        """db_type=hive — пробрасывает hive_registry_schema/table."""
        service = _make_service(db_type="greenplum")
        await service.list_tables("hive")
        kwargs = service._invoice.list_tables.await_args.kwargs
        assert kwargs["hive_registry_table"] == "t_db_oarb_ua_hadoop_tables"

    async def test_list_tables_greenplum_uses_gp_schema(self):
        """db_type=greenplum — пробрасывает gp_target_schema."""
        service = _make_service(db_type="greenplum")
        await service.list_tables("greenplum")
        kwargs = service._invoice.list_tables.await_args.kwargs
        assert "gp_target_schema" in kwargs

    async def test_list_tables_invalid_db_type_raises(self):
        """Неподдерживаемый db_type → InvoiceError."""
        service = _make_service()
        with pytest.raises(InvoiceError):
            await service.list_tables("oracle")


# -------------------------------------------------------------------------
# save_invoice — детекция изменений
# -------------------------------------------------------------------------


class TestSaveInvoice:
    """save_invoice с детекцией реальных изменений ETL-полей."""

    @staticmethod
    def _make_invoice_payload(**overrides):
        base = {
            "act_id": ACT_ID,
            "node_id": NODE_ID,
            "node_number": "5.1.3",
            "db_type": "hive",
            "schema_name": "team_sva_oarb_3",
            "table_name": "tbl_a",
            "metrics": [{"metric_type": "ФР", "metric_code": "ФР00001"}],
            "process": None,
            "profile_div": None,
        }
        base.update(overrides)
        return base

    async def test_save_creates_when_no_existing(self):
        """get_invoice_for_node=None → save_invoice вызывается."""
        service = _make_service()
        service._invoice.get_invoice_for_node.return_value = None
        service._invoice.save_invoice.return_value = {"id": 1, "act_id": ACT_ID}

        data = self._make_invoice_payload()
        result = await service.save_invoice(data, USERNAME)

        assert result == {"id": 1, "act_id": ACT_ID}
        service._invoice.save_invoice.assert_awaited_once_with(data, USERNAME)
        # Аудит зафиксирован
        service._audit.log.assert_awaited_once()
        assert service._audit.log.await_args.args[0] == "save_invoice"

    async def test_save_skips_when_no_real_changes(self):
        """Если existing совпадает с новыми данными — UPDATE пропущен."""
        existing = {
            "id": 9,
            "db_type": "hive",
            "schema_name": "team_sva_oarb_3",
            "table_name": "tbl_a",
            "profile_div": None,
            "metrics": [{"metric_type": "ФР", "metric_code": "ФР00001"}],
            "process": None,
        }
        service = _make_service()
        service._invoice.get_invoice_for_node.return_value = existing

        data = self._make_invoice_payload()
        result = await service.save_invoice(data, USERNAME)

        assert result == existing
        service._invoice.save_invoice.assert_not_awaited()
        service._audit.log.assert_not_awaited()

    async def test_save_detects_table_change(self):
        """Изменение table_name — реальное изменение, save вызывается."""
        existing = {
            "id": 9,
            "db_type": "hive",
            "schema_name": "team_sva_oarb_3",
            "table_name": "tbl_a",
            "profile_div": None,
            "metrics": [{"metric_type": "ФР", "metric_code": "ФР00001"}],
            "process": None,
        }
        service = _make_service()
        service._invoice.get_invoice_for_node.return_value = existing
        service._invoice.save_invoice.return_value = {"id": 9, "table_name": "tbl_b"}

        data = self._make_invoice_payload(table_name="tbl_b")
        await service.save_invoice(data, USERNAME)

        service._invoice.save_invoice.assert_awaited_once()

    async def test_save_detects_metrics_change(self):
        """Изменение metrics — реальное изменение."""
        existing = {
            "id": 9,
            "db_type": "hive",
            "schema_name": "team_sva_oarb_3",
            "table_name": "tbl_a",
            "profile_div": None,
            "metrics": [{"metric_type": "ФР", "metric_code": "ФР00001"}],
            "process": None,
        }
        service = _make_service()
        service._invoice.get_invoice_for_node.return_value = existing
        service._invoice.save_invoice.return_value = {"id": 9}

        new_metrics = [{"metric_type": "ОР", "metric_code": "ОР00002"}]
        data = self._make_invoice_payload(metrics=new_metrics)
        await service.save_invoice(data, USERNAME)

        service._invoice.save_invoice.assert_awaited_once()

    async def test_save_requires_edit_permission(self):
        """Без can_edit → InsufficientRightsError (от require_edit_permission)."""
        from app.domains.acts.exceptions import InsufficientRightsError
        service = _make_service(
            access_perm={"has_access": True, "can_edit": False, "role": "Участник"},
        )

        data = self._make_invoice_payload()
        with pytest.raises(InsufficientRightsError):
            await service.save_invoice(data, USERNAME)

        service._invoice.save_invoice.assert_not_awaited()

    async def test_save_no_access_raises(self):
        """has_access=False → AccessDeniedError, save не вызывается."""
        service = _make_service(
            access_perm={"has_access": False, "can_edit": False, "role": None},
        )

        data = self._make_invoice_payload()
        with pytest.raises(AccessDeniedError):
            await service.save_invoice(data, USERNAME)

        service._invoice.save_invoice.assert_not_awaited()


# -------------------------------------------------------------------------
# verify / get_invoices
# -------------------------------------------------------------------------


class TestGetAndVerify:
    """verify_invoice и get_invoices."""

    async def test_verify_invoice_returns_repo_result(self):
        """verify_invoice проксирует в repo после проверки доступа."""
        service = _make_service()
        service._invoice.verify_invoice.return_value = {
            "invoice_id": 7,
            "status": "pending",
            "message": "ok",
        }

        result = await service.verify_invoice(invoice_id=7, act_id=ACT_ID, username=USERNAME)

        assert result["invoice_id"] == 7
        service._invoice.verify_invoice.assert_awaited_once_with(7)
        service._access.check_user_access.assert_awaited_once_with(ACT_ID, USERNAME)

    async def test_verify_invoice_no_access_raises(self):
        """has_access=False → AccessDeniedError."""
        service = _make_service(has_access=False)
        with pytest.raises(AccessDeniedError):
            await service.verify_invoice(invoice_id=7, act_id=ACT_ID, username=USERNAME)
        service._invoice.verify_invoice.assert_not_awaited()

    async def test_get_invoices_filters_by_act(self):
        """get_invoices зовёт get_invoices_for_act с act_id."""
        service = _make_service()
        service._invoice.get_invoices_for_act.return_value = [
            {"id": 1, "act_id": ACT_ID},
            {"id": 2, "act_id": ACT_ID},
        ]

        result = await service.get_invoices(ACT_ID, USERNAME)

        assert len(result) == 2
        service._invoice.get_invoices_for_act.assert_awaited_once_with(ACT_ID)

    async def test_get_invoices_no_access_raises(self):
        """has_access=False → AccessDeniedError."""
        service = _make_service(has_access=False)
        with pytest.raises(AccessDeniedError):
            await service.get_invoices(ACT_ID, USERNAME)
