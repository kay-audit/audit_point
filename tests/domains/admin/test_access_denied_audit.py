"""Тесты аудит-лога отказов доступа к доменам."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.deps.auth_deps import get_username
from app.api.v1.deps.role_deps import (
    _roles_cache,
    get_user_roles,
    require_domain_access,
)
from app.core.metrics_batcher import MetricsBatcher
from app.domains.admin import deps as admin_deps
from app.domains.admin.repositories.access_denied_audit import (
    AccessDeniedAuditRepository,
    AccessDeniedRecord,
)


@pytest.fixture(autouse=True)
def _patch_adapter():
    """Подменяет get_adapter, чтобы BaseRepository работал без init_db()."""
    adapter = MagicMock()
    adapter.get_table_name = lambda name, schema='': name
    adapter.qualify_table_name = lambda name, schema="": name
    with patch("app.db.repositories.base.get_adapter", return_value=adapter):
        yield


@pytest.fixture(autouse=True)
def _reset_batcher():
    """Сбрасывает батчер аудита, кеш ролей и реестр фабрик между тестами.

    Регистрирует admin-фабрики (как реальный app в discover_domains), чтобы
    путь ``require_domain_access → _log_access_denied`` находил фабрику
    ``admin.access_denied_audit`` и доходил до батчера.
    """
    from app.core import domain_registry
    from app.domains.admin._lifecycle import register_factories

    domain_registry.reset_registry()
    register_factories()
    admin_deps.set_access_denied_audit_batcher(None)
    _roles_cache.clear()
    yield
    admin_deps.set_access_denied_audit_batcher(None)
    _roles_cache.clear()
    domain_registry.reset_registry()


# ---------------------------------------------------------------------------
# Репозиторий
# ---------------------------------------------------------------------------


async def test_log_many_inserts_all_records(mock_conn):
    """log_many: один executemany со списком кортежей в правильном порядке."""
    repo = AccessDeniedAuditRepository(mock_conn)
    records = [
        AccessDeniedRecord(
            username="u1",
            domain="acts",
            path="/api/v1/acts",
            method="GET",
            reason="roles=[Чат-ассистент], missing domain_name='acts'",
        ),
        AccessDeniedRecord(
            username="u2",
            domain="chat",
            path="/api/v1/chat/conversations",
            method="POST",
            reason=None,
        ),
    ]
    await repo.log_many(records)

    mock_conn.executemany.assert_awaited_once()
    sql, params = mock_conn.executemany.call_args.args
    assert "INSERT INTO" in sql
    assert "access_denied_audit" in sql
    assert params == [
        (
            "u1",
            "acts",
            "/api/v1/acts",
            "GET",
            "roles=[Чат-ассистент], missing domain_name='acts'",
        ),
        ("u2", "chat", "/api/v1/chat/conversations", "POST", None),
    ]


async def test_log_many_empty_is_noop(mock_conn):
    """Пустой список — не открывает транзакцию, не вызывает executemany."""
    repo = AccessDeniedAuditRepository(mock_conn)
    await repo.log_many([])
    mock_conn.executemany.assert_not_called()
    mock_conn.transaction.assert_not_called()


# ---------------------------------------------------------------------------
# Батчер
# ---------------------------------------------------------------------------


async def test_batcher_flushes_records_to_callback():
    """3 add → ручной stop → callback вызван с этими 3 records одним пакетом."""
    received: list[list[AccessDeniedRecord]] = []

    async def _callback(batch: list[AccessDeniedRecord]) -> None:
        received.append(list(batch))

    batcher: MetricsBatcher[AccessDeniedRecord] = MetricsBatcher(
        flush_callback=_callback,
        max_batch_size=100,
        flush_interval_sec=60.0,
        max_buffer_size=1000,
        name="test_access_denied_audit",
    )
    records = [
        AccessDeniedRecord(
            username=f"u{i}",
            domain="acts",
            path="/api/v1/acts",
            method="GET",
            reason="test",
        )
        for i in range(3)
    ]
    for r in records:
        await batcher.add(r)

    # stop() делает финальный flush
    await batcher.stop()

    assert len(received) == 1
    assert received[0] == records


# ---------------------------------------------------------------------------
# Интеграция в require_domain_access
# ---------------------------------------------------------------------------


def _build_app_with_endpoint(domain: str) -> FastAPI:
    app = FastAPI()

    @app.get("/protected", dependencies=[])
    async def _protected(_=__import__(
        "fastapi"
    ).Depends(require_domain_access(domain))):
        return {"ok": True}

    return app


async def test_require_domain_access_denies_and_records_to_batcher():
    """403 → запись попадает в батчер с username, domain, path, method, reason."""
    received: list[list[AccessDeniedRecord]] = []

    async def _callback(batch: list[AccessDeniedRecord]) -> None:
        received.append(list(batch))

    batcher: MetricsBatcher[AccessDeniedRecord] = MetricsBatcher(
        flush_callback=_callback,
        max_batch_size=100,
        flush_interval_sec=60.0,
        max_buffer_size=1000,
        name="test_access_denied_audit_integration",
    )
    admin_deps.set_access_denied_audit_batcher(batcher)

    app = _build_app_with_endpoint("acts")

    async def _override_username() -> str:
        return "22501010"

    async def _override_roles() -> list[dict]:
        # Роль есть, но на чужой домен — должен быть отказ
        return [{"id": 5, "name": "Чат-ассистент", "domain_name": "chat"}]

    app.dependency_overrides[get_username] = _override_username
    app.dependency_overrides[get_user_roles] = _override_roles

    with TestClient(app) as client:
        resp = client.get("/protected")

    assert resp.status_code == 403
    assert resp.json() == {"detail": "Нет доступа к разделу"}

    # Принудительный flush — забираем накопленную запись из батчера
    await batcher.stop()
    assert len(received) == 1
    assert len(received[0]) == 1
    record = received[0][0]
    assert record.username == "22501010"
    assert record.domain == "acts"
    assert record.path == "/protected"
    assert record.method == "GET"
    assert record.reason is not None
    assert "Чат-ассистент" in record.reason
    assert "acts" in record.reason


async def test_require_domain_access_allows_admin_without_audit():
    """Админ → доступ разрешён, ничего в батчер не пишется."""
    received: list[AccessDeniedRecord] = []

    async def _callback(batch: list[AccessDeniedRecord]) -> None:
        received.extend(batch)

    batcher: MetricsBatcher[AccessDeniedRecord] = MetricsBatcher(
        flush_callback=_callback,
        max_batch_size=100,
        flush_interval_sec=60.0,
        max_buffer_size=1000,
        name="test_admin_bypass",
    )
    admin_deps.set_access_denied_audit_batcher(batcher)

    app = _build_app_with_endpoint("acts")

    async def _override_username() -> str:
        return "22494524"

    async def _override_roles() -> list[dict]:
        return [{"id": 1, "name": "Администратор", "domain_name": None}]

    app.dependency_overrides[get_username] = _override_username
    app.dependency_overrides[get_user_roles] = _override_roles

    with TestClient(app) as client:
        resp = client.get("/protected")

    assert resp.status_code == 200
    await batcher.stop()
    assert received == []


async def test_require_domain_access_denies_without_batcher_does_not_crash(
    caplog,
):
    """Если батчер не поднят (None) — 403 всё равно отдаётся + warning в лог."""
    import logging

    admin_deps.set_access_denied_audit_batcher(None)

    app = _build_app_with_endpoint("acts")

    async def _override_username() -> str:
        return "22501010"

    async def _override_roles() -> list[dict]:
        return [{"id": 5, "name": "Чат-ассистент", "domain_name": "chat"}]

    app.dependency_overrides[get_username] = _override_username
    app.dependency_overrides[get_user_roles] = _override_roles

    with caplog.at_level(logging.WARNING, logger="audit_workstation.api.deps.roles"):
        with TestClient(app) as client:
            resp = client.get("/protected")

    assert resp.status_code == 403
    # Лог должен содержать username и domain
    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert any(
        "22501010" in r.getMessage() and "acts" in r.getMessage()
        for r in warnings
    )


async def test_require_domain_access_swallows_batcher_exceptions():
    """Если batcher.add() падает — 403 всё равно отдаётся, исключение не пробивается."""
    failing_batcher = MagicMock()
    failing_batcher.add = AsyncMock(side_effect=RuntimeError("batcher broke"))
    admin_deps.set_access_denied_audit_batcher(failing_batcher)

    app = _build_app_with_endpoint("acts")

    async def _override_username() -> str:
        return "22501010"

    async def _override_roles() -> list[dict]:
        return [{"id": 5, "name": "Чат-ассистент", "domain_name": "chat"}]

    app.dependency_overrides[get_username] = _override_username
    app.dependency_overrides[get_user_roles] = _override_roles

    with TestClient(app) as client:
        resp = client.get("/protected")

    assert resp.status_code == 403
    failing_batcher.add.assert_awaited_once()
