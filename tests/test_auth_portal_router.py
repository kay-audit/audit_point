"""
E2E-проверка HTML-роута GET /profile (app.auth.portal_router).

Анонима на HTML-путь вне /auth и /static не пускает уже AuthMiddleware
(редирект на /auth/login, см. tests/test_auth_middleware.py) — сюда запрос
с валидной личностью попадает уже авторизованным, роуту остаётся собрать
контекст шаблона из get_current_user (профиль) + get_user_roles (nav/is_admin).

Реальный шаблон зависит от static-mount (url_for('static', ...)) — как и в
tests/domains/admin/test_admin_portal_route.py, TemplateResponse мокается:
важен факт рендера и переданный контекст, а не сама HTML-разметка.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.testclient import TestClient

from app.api.v1.deps.role_deps import get_user_roles
from app.auth.dependencies import get_current_user
from app.auth.portal_router import router as portal_router
from app.auth.value_objects import UserContext


def _build_app(user: UserContext, roles: list[dict]) -> FastAPI:
    """Минимальный FastAPI с auth-portal-роутером и оверрайдами DI."""
    app = FastAPI()
    app.include_router(portal_router)
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_user_roles] = lambda: roles
    return app


def _capture_template_response(monkeypatch):
    """Подменяет templates.TemplateResponse, возвращая dict с переданным контекстом."""
    from app.auth import portal_router as portal_router_module

    captured: dict = {}

    def _fake(request, name, context=None, *args, **kwargs):
        captured["name"] = name
        captured["context"] = context
        return HTMLResponse("<html>profile-stub</html>")

    monkeypatch.setattr(portal_router_module.templates, "TemplateResponse", _fake)
    return captured


class TestProfilePage:
    """GET /profile рендерит portal/profile.html с профилем текущего пользователя."""

    def test_renders_with_user_profile_in_context(self, monkeypatch):
        captured = _capture_template_response(monkeypatch)

        user = UserContext(
            sub="12345",
            email="ivanov@example.com",
            login="12345",
            fullname="Иванов И.И.",
            job="Аудитор",
            roles=["Цифровой акт"],
        )
        roles = [{"id": 1, "name": "Цифровой акт", "domain_name": "acts"}]
        client = TestClient(_build_app(user, roles))

        resp = client.get("/profile")

        assert resp.status_code == 200, resp.text
        assert captured["name"] == "portal/profile.html"
        assert captured["context"]["profile"] is user
        assert captured["context"]["active_page"] == "profile"
        assert captured["context"]["is_admin"] is False

    def test_admin_role_marks_is_admin(self, monkeypatch):
        captured = _capture_template_response(monkeypatch)

        user = UserContext(sub="1", email="", login="1", fullname="Админ")
        roles = [{"id": 99, "name": "Админ", "domain_name": None}]
        client = TestClient(_build_app(user, roles))

        client.get("/profile")

        assert captured["context"]["is_admin"] is True

    def test_no_role_gate_any_authenticated_user_sees_own_profile(self, monkeypatch):
        """В отличие от /admin, /profile не требует конкретной роли — только личность."""
        captured = _capture_template_response(monkeypatch)

        user = UserContext(sub="1", email="", login="1", fullname="Рядовой пользователь")
        client = TestClient(_build_app(user, roles=[]))

        resp = client.get("/profile")

        assert resp.status_code == 200, resp.text
        assert captured["context"]["profile"] is user
