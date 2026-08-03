"""Тесты GET /me: полный профиль текущего пользователя (включая job).

GET /profile больше не существует в этом роутере (карточка/страница профиля
теперь работает через /api/v1/auth/me + отдельный HTML-роут /profile в
app.auth.portal_router) — регрессия ниже фиксирует его отсутствие.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth.dependencies import get_current_user
from app.auth.router import router as auth_router
from app.auth.value_objects import UserContext


def _make_client(user: UserContext) -> TestClient:
    """Минimal FastAPI с auth-роутером; get_current_user переопределён напрямую
    (профиль строится глубже, через БД — здесь важен только контракт /me)."""
    app = FastAPI()
    app.include_router(auth_router, prefix="/auth")
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


class TestMe:
    """GET /me отдаёт весь профиль пользователя, включая должность (job)."""

    def test_returns_job_and_profile_fields(self):
        user = UserContext(
            sub="12345",
            email="ivanov@example.com",
            login="12345",
            fullname="Иванов И.И.",
            job="Аудитор",
            teams=[],
            roles=["Цифровой акт"],
        )
        client = _make_client(user)

        resp = client.get("/auth/me")

        assert resp.status_code == 200
        body = resp.json()
        assert body["authenticated"] is True
        assert body["job"] == "Аудитор"
        assert body["fullname"] == "Иванов И.И."
        assert body["roles"] == ["Цифровой акт"]

    def test_empty_job_returned_as_empty_string(self):
        """Должность не заполнена в справочнике — пустая строка, не отсутствующий ключ."""
        user = UserContext(sub="12345", email="", login="12345", fullname="Пользователь 12345")
        client = _make_client(user)

        resp = client.get("/auth/me")

        assert resp.json()["job"] == ""


class TestProfileApiRouteRemoved:
    """Регрессия: мёртвый GET /profile (app.auth.router) удалён вместе с UserProfile."""

    def test_profile_route_not_registered(self):
        user = UserContext(sub="1", email="", login="1", fullname="Х")
        client = _make_client(user)

        resp = client.get("/auth/profile")

        assert resp.status_code == 404

    def test_user_profile_model_removed(self):
        import app.auth.router as router_module

        assert not hasattr(router_module, "UserProfile")
