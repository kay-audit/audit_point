"""E2E-тесты публичной поверхности домена ``ua_data``.

В текущей реализации домен предоставляет:
- ``DictionaryRepository`` (чтение справочников);
- ``IDictionaryRepository`` Protocol (внешняя зависимость других доменов);
- ``make_invoice_table_names`` фабрика (даёт ``UaInvoiceTableNames`` для acts).

HTTP-роутера у домена пока нет. Эти тесты проверяют:
1) Protocol-совместимость ``DictionaryRepository`` ↔ ``IDictionaryRepository``;
2) фабрику ``make_invoice_table_names`` через ``settings_registry``;
3) интеграционный сценарий «минимальный FastAPI + Depends(repo) + дефолтная
   защита ``require_domain_access('ua_data')``» — показывает, что repo
   корректно собирается через DI и проходит проверку роли.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.v1.deps.auth_deps import get_username
from app.api.v1.deps.role_deps import get_user_roles, require_domain_access
from app.core import settings_registry
from app.domains.ua_data.factories import make_invoice_table_names
from app.domains.ua_data.interfaces import IDictionaryRepository, UaInvoiceTableNames
from app.domains.ua_data.repositories.dictionary_repository import (
    DictionaryRepository,
)
from app.domains.ua_data.settings import UaDataSettings


@pytest.fixture(autouse=True)
def _reset_registry():
    """Сброс реестра настроек между тестами."""
    settings_registry.reset()
    settings_registry.register("ua_data", UaDataSettings)
    yield
    settings_registry.reset()


@pytest.fixture
def repo(mock_conn):
    """``DictionaryRepository`` с замоканным адаптером."""
    adapter = MagicMock()
    adapter.qualify_table_name = lambda name, schema="": name
    with patch("app.db.repositories.base.get_adapter", return_value=adapter):
        return DictionaryRepository(conn=mock_conn)


# -------------------------------------------------------------------------
# Protocol-совместимость
# -------------------------------------------------------------------------


class TestProtocolConformance:
    """``DictionaryRepository`` должен быть совместим с ``IDictionaryRepository``."""

    def test_repository_satisfies_interface(self, repo):
        assert isinstance(repo, IDictionaryRepository)

    def test_protocol_methods_callable(self, repo):
        for method_name in (
            "get_processes",
            "get_terbanks",
            "get_metric_codes",
            "get_departments",
            "get_channels",
            "get_products",
            "get_risk_types",
            "get_teams",
        ):
            assert callable(getattr(repo, method_name)), method_name


# -------------------------------------------------------------------------
# Фабрика make_invoice_table_names
# -------------------------------------------------------------------------


class TestInvoiceTableNamesFactory:
    """``make_invoice_table_names`` строит ``UaInvoiceTableNames`` из настроек."""

    def test_returns_dataclass_with_default_tables(self):
        names = make_invoice_table_names()
        assert isinstance(names, UaInvoiceTableNames)
        assert names.process_dict == "t_db_oarb_ua_process_dict"
        assert names.violation_metric_dict == "t_db_oarb_ua_violation_metric_dict"
        assert names.subsidiary_dict == "t_db_oarb_ua_subsidiary_dict"

    def test_reflects_overridden_settings(self):
        settings_registry.reset()
        custom = UaDataSettings(
            process_dict="custom_process",
            violation_metric_dict="custom_metric",
            subsidiary_dict="custom_sub",
        )
        settings_registry._registry["ua_data"] = custom

        names = make_invoice_table_names()
        assert names.process_dict == "custom_process"
        assert names.violation_metric_dict == "custom_metric"
        assert names.subsidiary_dict == "custom_sub"

    def test_dataclass_is_frozen(self):
        names = make_invoice_table_names()
        with pytest.raises(Exception):
            names.process_dict = "mutated"  # type: ignore[misc]


# -------------------------------------------------------------------------
# Интеграция: минимальный FastAPI + DI repo + защита ua_data
# -------------------------------------------------------------------------


USERNAME = "12345678"


def _build_app(repo_instance, *, roles: list[dict]) -> FastAPI:
    """Минимальный app со стаб-эндпоинтом, имитирующим будущий ua_data роутер."""
    app = FastAPI()

    def _get_repo() -> IDictionaryRepository:
        return repo_instance

    @app.get(
        "/api/v1/ua-data/processes",
        dependencies=[Depends(require_domain_access("ua_data"))],
    )
    async def list_processes(r: IDictionaryRepository = Depends(_get_repo)):
        return await r.get_processes()

    @app.get(
        "/api/v1/ua-data/terbanks",
        dependencies=[Depends(require_domain_access("ua_data"))],
    )
    async def list_terbanks(r: IDictionaryRepository = Depends(_get_repo)):
        return await r.get_terbanks()

    app.dependency_overrides[get_username] = lambda: USERNAME
    app.dependency_overrides[get_user_roles] = lambda: roles
    return app


class TestUaDataEndpointsIntegration:
    """Интеграция repo + role_deps на стаб-эндпоинтах."""

    def test_list_processes_returns_data_for_authorized_role(self):
        repo_mock = MagicMock(spec=IDictionaryRepository)
        repo_mock.get_processes = AsyncMock(
            return_value=[{"id": 1, "process_code": "1013", "process_name": "Кредит"}]
        )
        app = _build_app(
            repo_mock,
            roles=[{"id": 1, "name": "Аудитор", "domain_name": "ua_data"}],
        )

        with TestClient(app) as client:
            resp = client.get("/api/v1/ua-data/processes")

        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body, list)
        assert body[0]["process_code"] == "1013"
        repo_mock.get_processes.assert_awaited_once()

    def test_list_processes_returns_empty_list(self):
        repo_mock = MagicMock(spec=IDictionaryRepository)
        repo_mock.get_processes = AsyncMock(return_value=[])
        app = _build_app(
            repo_mock,
            roles=[{"id": 1, "name": "Администратор", "domain_name": None}],
        )

        with TestClient(app) as client:
            resp = client.get("/api/v1/ua-data/processes")

        assert resp.status_code == 200
        assert resp.json() == []

    def test_admin_role_passes(self):
        repo_mock = MagicMock(spec=IDictionaryRepository)
        repo_mock.get_terbanks = AsyncMock(
            return_value=[{"tb_id": "07", "short_name": "МСК", "full_name": "Москва"}]
        )
        app = _build_app(
            repo_mock,
            roles=[{"id": 99, "name": "Администратор", "domain_name": None}],
        )

        with TestClient(app) as client:
            resp = client.get("/api/v1/ua-data/terbanks")

        assert resp.status_code == 200
        assert resp.json()[0]["short_name"] == "МСК"

    def test_foreign_domain_role_forbidden(self):
        repo_mock = MagicMock(spec=IDictionaryRepository)
        repo_mock.get_processes = AsyncMock(return_value=[])
        app = _build_app(
            repo_mock,
            roles=[{"id": 2, "name": "Чат", "domain_name": "chat"}],
        )

        with TestClient(app) as client:
            resp = client.get("/api/v1/ua-data/processes")

        assert resp.status_code == 403
        repo_mock.get_processes.assert_not_awaited()

    def test_empty_roles_forbidden(self):
        repo_mock = MagicMock(spec=IDictionaryRepository)
        repo_mock.get_processes = AsyncMock(return_value=[])
        app = _build_app(repo_mock, roles=[])

        with TestClient(app) as client:
            resp = client.get("/api/v1/ua-data/processes")

        assert resp.status_code == 403
