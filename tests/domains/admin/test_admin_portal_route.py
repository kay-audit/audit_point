"""
E2E-проверка серверного гейта на странице /admin.

До фикса роут отдавал HTML всем подряд — фронт затем ловил 403 от
API-вызовов и показывал «Не удалось загрузить данные администрирования».
После фикса не-админ редиректится на /portal/acts (303), админ получает
саму страницу.

Тесты собирают минимальный FastAPI с единственным роутером
``admin.routes.portal`` и переопределяют ``get_user_roles`` через
``app.dependency_overrides``.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.deps.auth_deps import get_username
from app.api.v1.deps.role_deps import get_user_roles
from app.domains.admin.routes.portal import router as portal_router


def _build_app(roles: list[dict], username: str = "12345") -> FastAPI:
    """Минимальный FastAPI с admin-portal роутером и оверрайдами DI."""
    app = FastAPI()
    app.include_router(portal_router)
    app.dependency_overrides[get_username] = lambda: username
    app.dependency_overrides[get_user_roles] = lambda: roles
    return app


class TestAdminPortalAccessGate:
    """GET /admin: только админам, остальным — 303 на /portal/acts."""

    def test_non_admin_user_redirected_to_portal_acts(self):
        """Юзер с обычной ролью получает 303 redirect, а не HTML."""
        roles = [{"id": 1, "name": "Цифровой акт", "domain_name": "acts"}]
        app = _build_app(roles=roles)

        # follow_redirects=False — нам важен сам факт 303, не цель
        client = TestClient(app, follow_redirects=False)
        resp = client.get("/admin")

        assert resp.status_code == 303, resp.text
        assert resp.headers["location"] == "/portal/acts"

    def test_user_without_any_roles_redirected(self):
        """Пользователь с пустым списком ролей — тоже не админ → 303."""
        app = _build_app(roles=[])

        client = TestClient(app, follow_redirects=False)
        resp = client.get("/admin")

        assert resp.status_code == 303
        assert resp.headers["location"] == "/portal/acts"

    def test_user_with_chat_role_only_redirected(self):
        """Чат-ассистент без админки — тоже редирект."""
        roles = [{"id": 2, "name": "Чат-ассистент", "domain_name": "chat"}]
        app = _build_app(roles=roles)

        client = TestClient(app, follow_redirects=False)
        resp = client.get("/admin")

        assert resp.status_code == 303
        assert resp.headers["location"] == "/portal/acts"

    def test_admin_role_not_redirected(self, monkeypatch):
        """Админ — НЕ получает 303 (роут идёт дальше в TemplateResponse).

        Реальный шаблон зависит от static-mount и состава доменов,
        поэтому мокаем ``templates.TemplateResponse`` — нам важен факт
        прохождения гейта и попадание в ветку рендера, а не корректность
        шаблона. Гейт работает, если TemplateResponse был вызван.
        """
        from app.domains.admin.routes import portal as portal_module
        from fastapi.responses import HTMLResponse

        called = {"n": 0}

        def _fake_template_response(*args, **kwargs):
            called["n"] += 1
            return HTMLResponse("<html>admin-stub</html>")

        monkeypatch.setattr(
            portal_module.templates, "TemplateResponse", _fake_template_response,
        )

        roles = [{"id": 99, "name": "Администратор", "domain_name": None}]
        app = _build_app(roles=roles)

        client = TestClient(app, follow_redirects=False)
        resp = client.get("/admin")

        assert resp.status_code == 200, resp.text
        assert called["n"] == 1, "TemplateResponse должен был быть вызван — гейт пропустил админа"
        assert "admin-stub" in resp.text
