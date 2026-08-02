"""Тесты безопасности ОТП-флоу: гигиена логов, лимит попыток verify-otp,
rate-limit request-otp, валидатор jwt_secret.

DB не используется — репозиторий пользователей подменяется фейком через
dependency_overrides, Redis — fakeredis (см. tests/test_auth_middleware.py
за паттерном автосброса кэша настроек).
"""

from __future__ import annotations

import logging
import re

import fakeredis.aioredis
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.auth.dependencies import get_user_repository
from app.auth.redis_adapter import RedisAdapter, RedisConfig
from app.auth.router import router as auth_router
from app.core.config import Settings, get_settings
from app.core.domain_registry import reset_registry
from app.core.settings_registry import reset as reset_settings
from app.domains.notifications.settings import NotificationsSettings

SECRET = "test-secret-key-for-otp-flow-security-suite"
LOGGER_NAME = "audit_workstation.auth.router"

USER = {
    "id": "77",
    "email": "user@example.com",
    "login": "77",
    "fullname": "Тестовый Пользователь",
}


@pytest.fixture(autouse=True)
def _propagate_auth_router_logger():
    """Включает propagate на auth-router-логгере и его родителе.

    В app.core.logging.setup_logging выставляется propagate=False на
    `audit_workstation` (избежать дублей с uvicorn) — если этот вызов уже
    произошёл в рамках сессии (другой тест-файл), записи не доходят до
    caplog (root). Временно включаем propagation на всём пути до root
    (паттерн из tests/test_metrics_batcher.py).
    """
    names = ("audit_workstation", LOGGER_NAME)
    originals: dict[str, bool] = {}
    for name in names:
        log = logging.getLogger(name)
        originals[name] = log.propagate
        log.propagate = True
    yield
    for name, val in originals.items():
        logging.getLogger(name).propagate = val


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    """ОТП-режим с тестовым секретом; настройки notifications — email выключен по дефолту.

    Доменные реестры (settings_registry, domain_registry) хранят глобальное
    состояние — сбрасываем до и после каждого теста.
    """
    monkeypatch.setenv("AUTH__ENABLED", "true")
    monkeypatch.setenv("AUTH__JWT_SECRET", SECRET)
    get_settings.cache_clear()
    reset_registry()
    reset_settings()

    from app.core import settings_registry

    settings_registry._registry["notifications"] = NotificationsSettings()

    yield
    get_settings.cache_clear()
    reset_registry()
    reset_settings()


class FakeUserRepository:
    """Фейковый репозиторий пользователей (email -> user) без похода в БД."""

    def __init__(self, users: dict[str, dict] | None = None):
        self._by_email = {k.lower(): v for k, v in (users or {}).items()}

    async def find_by_email(self, email: str) -> dict | None:
        return self._by_email.get(email.lower())

    async def get_user_context(self, user_id: str) -> dict | None:
        for u in self._by_email.values():
            if u["id"] == user_id:
                return {
                    "id": u["id"],
                    "email": u["email"],
                    "login": u["login"],
                    "fullname": u["fullname"],
                    "teams": [],
                    "roles": ["auditor"],
                }
        return None


def _make_client(repo: FakeUserRepository) -> TestClient:
    """Минимальный FastAPI с auth-роутером, фейковым репозиторием и fakeredis."""
    app = FastAPI()
    app.include_router(auth_router, prefix="/auth")
    app.dependency_overrides[get_user_repository] = lambda: repo

    redis_adapter = RedisAdapter(RedisConfig())
    redis_adapter._client = fakeredis.aioredis.FakeRedis(decode_responses=True)
    app.state.redis_adapter = redis_adapter

    return TestClient(app)


def _request_otp_and_extract_code(client: TestClient, caplog, email: str) -> str:
    """Запрашивает OTP и достаёт код из dev-лога (email выключен в фикстуре)."""
    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        resp = client.post("/auth/request-otp", json={"email": email})
    assert resp.status_code == 200
    for record in caplog.records:
        match = re.search(r"DEV-режим: ОТП-код для .+ = (\d+)", record.getMessage())
        if match:
            return match.group(1)
    raise AssertionError("Код ОТП не найден в логе (dev-режим)")


class TestHappyPath:
    """request-otp -> код из dev-лога -> verify-otp -> токены в cookie."""

    def test_request_then_verify_succeeds(self, caplog):
        repo = FakeUserRepository({USER["email"]: USER})
        client = _make_client(repo)

        otp = _request_otp_and_extract_code(client, caplog, USER["email"])
        assert len(otp) == 6

        resp = client.post("/auth/verify-otp", json={"email": USER["email"], "otp": otp})
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["user"]["sub"] == USER["id"]
        assert resp.cookies.get("access_token")
        assert resp.cookies.get("refresh_token")

    def test_code_not_logged_when_email_sent_successfully(self, caplog, monkeypatch):
        """При включённом и успешном email — код не должен попадать в лог вообще."""
        from app.core import settings_registry
        from app.core.domain_registry import register_factory

        enabled_settings = NotificationsSettings()
        enabled_settings.email.enabled = True
        settings_registry._registry["notifications"] = enabled_settings

        class _FakeEmailService:
            async def send_email(self, *, to, subject, body):
                return True

        register_factory("notifications.email", lambda: _FakeEmailService())
        monkeypatch.setattr(
            "app.domains.notifications.services.email_service.EmailService",
            _FakeEmailService,
        )

        repo = FakeUserRepository({USER["email"]: USER})
        client = _make_client(repo)

        with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
            resp = client.post("/auth/request-otp", json={"email": USER["email"]})
        assert resp.status_code == 200
        for record in caplog.records:
            assert "DEV-режим" not in record.getMessage()


class TestVerifyOtpAttemptLimit:
    """AUTH__OTP_MAX_ATTEMPTS: лимит неверных попыток verify-otp."""

    def test_wrong_code_returns_401_without_exhausting_immediately(self, caplog):
        repo = FakeUserRepository({USER["email"]: USER})
        client = _make_client(repo)
        _request_otp_and_extract_code(client, caplog, USER["email"])

        # 4 неверные попытки при дефолтном лимите 5 — ещё не исчерпан.
        for _ in range(4):
            resp = client.post(
                "/auth/verify-otp", json={"email": USER["email"], "otp": "000000"}
            )
            assert resp.status_code == 401
            assert resp.json()["error"] == "Неверный email или код"

    def test_attempts_exhausted_invalidates_code_even_for_correct_value(self, caplog):
        repo = FakeUserRepository({USER["email"]: USER})
        client = _make_client(repo)
        otp = _request_otp_and_extract_code(client, caplog, USER["email"])

        last_resp = None
        for _ in range(5):
            last_resp = client.post(
                "/auth/verify-otp", json={"email": USER["email"], "otp": "000000"}
            )
        # 5-я (последняя допустимая) неверная попытка исчерпывает лимит.
        assert last_resp.status_code == 401
        assert last_resp.json()["error"] == "Код недействителен, запросите новый"

        # Дальнейший verify с ПРАВИЛЬНЫМ кодом всё равно отклоняется — ключ уже удалён.
        resp = client.post("/auth/verify-otp", json={"email": USER["email"], "otp": otp})
        assert resp.status_code == 401
        assert resp.json()["error"] == "Код недействителен, запросите новый"


class TestRequestOtpRateLimit:
    """AUTH__OTP_REQUEST_MAX_PER_MINUTE: лимит частоты запроса кода на email."""

    def test_fourth_request_within_window_returns_429(self):
        client = _make_client(FakeUserRepository())
        email = "unknown@example.com"

        for _ in range(3):
            resp = client.post("/auth/request-otp", json={"email": email})
            assert resp.status_code == 200

        resp = client.post("/auth/request-otp", json={"email": email})
        assert resp.status_code == 429
        assert resp.json() == {
            "success": False,
            "error": "Слишком много запросов кода, попробуйте через минуту",
        }

    def test_unknown_email_returns_success_anti_enumeration(self):
        client = _make_client(FakeUserRepository())
        resp = client.post("/auth/request-otp", json={"email": "unknown@example.com"})
        assert resp.status_code == 200
        assert resp.json()["success"] is True


class TestJwtSecretValidator:
    """AuthSettings.validate_jwt_secret: секрет обязателен, не-дефолтен и не короче 32 символов."""

    def test_enabled_with_default_secret_raises(self, monkeypatch):
        monkeypatch.setenv("AUTH__ENABLED", "true")
        monkeypatch.delenv("AUTH__JWT_SECRET", raising=False)
        with pytest.raises(ValidationError):
            Settings()

    def test_enabled_with_short_secret_raises(self, monkeypatch):
        """Короче 32 символов — недостаточно для HS256 (RFC 7518), старт падает."""
        monkeypatch.setenv("AUTH__ENABLED", "true")
        monkeypatch.setenv("AUTH__JWT_SECRET", "short-but-not-default")
        with pytest.raises(ValidationError, match="32"):
            Settings()

    def test_enabled_with_real_secret_ok(self, monkeypatch):
        monkeypatch.setenv("AUTH__ENABLED", "true")
        monkeypatch.setenv("AUTH__JWT_SECRET", "a-real-secret-value-of-proper-length-48chars-ok")
        settings = Settings()
        assert settings.auth.enabled is True
