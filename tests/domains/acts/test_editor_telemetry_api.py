"""E2E-тесты эндпоинта телеметрии здоровья редактора (§6.8).

Минимальный FastAPI + dependency_overrides (без create_app). Проверяют:
kill-switch (204 без записи), счастливый путь (201 + батч-INSERT), rate-guard
(>200 → 422), пустой батч (204), валидацию типа события, и то, что username
берётся из auth, а не из payload.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.deps.auth_deps import get_username
from app.api.v1.deps.role_deps import get_user_roles
from app.domains.acts.api.editor_telemetry import (
    MAX_EVENTS_PER_BATCH,
    router as telemetry_router,
)
from app.domains.acts.deps import _get_acts_settings, get_editor_telemetry_repo
from app.domains.acts.settings import ActsSettings


USERNAME = "12345"


def _make_repo() -> MagicMock:
    repo = MagicMock()
    repo.insert_many = AsyncMock()
    return repo


def _build_app(*, enabled: bool = True, repo: MagicMock | None = None) -> tuple[FastAPI, MagicMock]:
    """Минимальный FastAPI с телеметрия-роутером и замоканными зависимостями."""
    repo = repo or _make_repo()
    app = FastAPI()
    app.include_router(telemetry_router, prefix="/api/v1/acts")

    app.dependency_overrides[get_username] = lambda: USERNAME
    # require_domain_access("acts") пропускает админа — избегаем реального БД-запроса ролей.
    app.dependency_overrides[get_user_roles] = lambda: [
        {"name": "Администратор", "domain_name": None},
    ]
    app.dependency_overrides[_get_acts_settings] = lambda: ActsSettings(
        editor_telemetry_enabled=enabled,
    )
    app.dependency_overrides[get_editor_telemetry_repo] = lambda: repo
    return app, repo


def _events(*specs: tuple[str, int, int]) -> dict:
    """Строит payload батча из троек (event_type, act_id, count)."""
    return {
        "events": [
            {"event_type": et, "act_id": aid, "count": cnt}
            for et, aid, cnt in specs
        ],
    }


class TestEditorTelemetryEndpoint:
    """POST /api/v1/acts/editor-telemetry."""

    def test_happy_path_writes_batch_and_returns_201(self):
        """Включённая телеметрия: батч записывается одним INSERT, ответ 201."""
        app, repo = _build_app(enabled=True)
        payload = _events(
            ("observer_heal", 42, 3),
            ("save_failure", 42, 1),
        )
        with TestClient(app) as client:
            resp = client.post("/api/v1/acts/editor-telemetry", json=payload)

        assert resp.status_code == 201, resp.text
        assert resp.json() == {"written": 2}
        repo.insert_many.assert_awaited_once()
        rows = repo.insert_many.await_args.args[0]
        assert len(rows) == 2
        # Каждая строка: (id, act_id, username, event_type, event_count).
        ids = {r[0] for r in rows}
        assert len(ids) == 2, "id генерируются уникальными (uuid)"
        assert all(isinstance(r[0], str) and len(r[0]) == 36 for r in rows)
        assert {(r[1], r[3], r[4]) for r in rows} == {
            (42, "observer_heal", 3),
            (42, "save_failure", 1),
        }

    def test_username_comes_from_auth_not_payload(self):
        """Username берётся из auth-зависимости, а не из тела запроса."""
        app, repo = _build_app(enabled=True)
        payload = _events(("dup_id_fix", 7, 5))
        # Пытаемся протащить чужой username в payload — должен игнорироваться.
        payload["username"] = "hacker"
        payload["events"][0]["username"] = "hacker"

        with TestClient(app) as client:
            resp = client.post("/api/v1/acts/editor-telemetry", json=payload)

        assert resp.status_code == 201, resp.text
        rows = repo.insert_many.await_args.args[0]
        assert all(r[2] == USERNAME for r in rows), "username — из auth"

    def test_disabled_returns_204_without_insert(self):
        """Kill-switch выключен → 204 без записи в БД."""
        app, repo = _build_app(enabled=False)
        with TestClient(app) as client:
            resp = client.post(
                "/api/v1/acts/editor-telemetry",
                json=_events(("observer_heal", 1, 1)),
            )
        assert resp.status_code == 204
        assert resp.content == b""
        repo.insert_many.assert_not_awaited()

    def test_empty_batch_returns_204_without_insert(self):
        """Пустой батч — нечего писать, 204."""
        app, repo = _build_app(enabled=True)
        with TestClient(app) as client:
            resp = client.post("/api/v1/acts/editor-telemetry", json={"events": []})
        assert resp.status_code == 204
        repo.insert_many.assert_not_awaited()

    def test_over_limit_returns_422_without_insert(self):
        """Rate-guard: > MAX_EVENTS_PER_BATCH событий → 422, без записи."""
        app, repo = _build_app(enabled=True)
        payload = {
            "events": [
                {"event_type": "observer_heal", "act_id": 1, "count": 1}
                for _ in range(MAX_EVENTS_PER_BATCH + 1)
            ],
        }
        with TestClient(app) as client:
            resp = client.post("/api/v1/acts/editor-telemetry", json=payload)
        assert resp.status_code == 422
        assert "телеметри" in resp.json()["detail"].lower()
        repo.insert_many.assert_not_awaited()

    def test_boundary_at_limit_is_accepted(self):
        """Ровно MAX_EVENTS_PER_BATCH событий — на границе, принимается (201)."""
        app, repo = _build_app(enabled=True)
        payload = {
            "events": [
                {"event_type": "empty_paste", "act_id": i, "count": 1}
                for i in range(MAX_EVENTS_PER_BATCH)
            ],
        }
        with TestClient(app) as client:
            resp = client.post("/api/v1/acts/editor-telemetry", json=payload)
        assert resp.status_code == 201, resp.text
        assert resp.json() == {"written": MAX_EVENTS_PER_BATCH}
        repo.insert_many.assert_awaited_once()

    def test_unknown_event_type_returns_422(self):
        """Неизвестный тип события отбивается Pydantic (422), без записи."""
        app, repo = _build_app(enabled=True)
        with TestClient(app) as client:
            resp = client.post(
                "/api/v1/acts/editor-telemetry",
                json=_events(("bogus_event", 1, 1)),
            )
        assert resp.status_code == 422
        repo.insert_many.assert_not_awaited()

    def test_nonpositive_count_returns_422(self):
        """count <= 0 отбивается Pydantic (gt=0), без записи."""
        app, repo = _build_app(enabled=True)
        with TestClient(app) as client:
            resp = client.post(
                "/api/v1/acts/editor-telemetry",
                json=_events(("observer_heal", 1, 0)),
            )
        assert resp.status_code == 422
        repo.insert_many.assert_not_awaited()

    def test_oversized_count_returns_422_not_500(self):
        """Аномально большой count отбивается Pydantic (le=), а не падает
        переполнением INTEGER на INSERT (голый 500). Верхняя граница обязательна."""
        app, repo = _build_app(enabled=True)
        with TestClient(app) as client:
            resp = client.post(
                "/api/v1/acts/editor-telemetry",
                json=_events(("observer_heal", 1, 9_999_999_999)),
            )
        assert resp.status_code == 422
        repo.insert_many.assert_not_awaited()
