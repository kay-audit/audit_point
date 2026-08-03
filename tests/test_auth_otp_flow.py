"""Тесты безопасности ОТП-флоу: гигиена логов, лимит попыток verify-otp,
rate-limit request-otp, единый текст отказа, доставка письма, refresh,
валидатор jwt_secret.

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
from app.auth.jwt_handler import JWTTokenHandler
from app.auth.redis_adapter import RedisAdapter, RedisConfig
from app.auth.router import (
    OTP_INVALID_ERROR,
    REDIS_UNAVAILABLE_ERROR,
    router as auth_router,
)
from app.core.config import AuthSettings, Settings, get_settings
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

    # Один общий in-memory сервер на два клиента: async уходит в адаптер
    # приложения, sync остаётся тесту для проверки ключей и TTL без await.
    server = fakeredis.FakeServer()
    redis_adapter = RedisAdapter(RedisConfig())
    redis_adapter._client = fakeredis.aioredis.FakeRedis(
        server=server, decode_responses=True
    )
    app.state.redis_adapter = redis_adapter
    app.state.fake_redis_sync = fakeredis.FakeStrictRedis(
        server=server, decode_responses=True
    )

    return TestClient(app)


def _raw_redis(client: TestClient):
    """Синхронный доступ к тому же fakeredis, что видит приложение."""
    return client.app.state.fake_redis_sync


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


def _enable_email(send_result: object) -> None:
    """Включает почту и подменяет фабрику notifications.email фейком.

    Args:
        send_result: что вернёт send_email; исключение — будет брошено.
    """
    from app.core import settings_registry
    from app.core.domain_registry import register_factory

    enabled_settings = NotificationsSettings()
    enabled_settings.email.enabled = True
    settings_registry._registry["notifications"] = enabled_settings

    class _FakeEmailService:
        async def send_email(self, *, to, subject, body):
            if isinstance(send_result, Exception):
                raise send_result
            return send_result

    def _factory():
        # Контракт фабрики — async-генератор (см. notifications/_lifecycle.py).
        async def _gen():
            yield _FakeEmailService()
        return _gen()

    register_factory("notifications.email", _factory)


def _dev_log_records(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records if "DEV-режим" in r.getMessage()]


class TestOtpEmailDelivery:
    """Код уходит в лог только в dev-режиме; сбой почты клиенту не раскрывается."""

    def test_code_not_logged_when_email_sent_successfully(self, caplog):
        """При включённом и успешном email — код не должен попадать в лог вообще."""
        _enable_email(True)
        client = _make_client(FakeUserRepository({USER["email"]: USER}))

        with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
            resp = client.post("/auth/request-otp", json={"email": USER["email"]})
        assert resp.status_code == 200
        assert _dev_log_records(caplog) == []

    def test_failed_send_keeps_200_and_never_logs_code(self, caplog):
        """send_email вернул False: клиенту тот же 200, живой код в лог не идёт."""
        _enable_email(False)
        client = _make_client(FakeUserRepository({USER["email"]: USER}))

        with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
            resp = client.post("/auth/request-otp", json={"email": USER["email"]})

        # Отказ не раскрываем: иначе ответ стал бы оракулом существования email.
        assert resp.status_code == 200
        assert resp.json()["success"] is True
        assert _dev_log_records(caplog) == []
        errors = [r.getMessage() for r in caplog.records if r.levelno == logging.ERROR]
        assert any("не доставлен" in msg for msg in errors)

    def test_send_exception_keeps_200_and_never_logs_code(self, caplog):
        """Падение отправки не роняет запрос и тоже не печатает код."""
        _enable_email(RuntimeError("SMTP недоступен"))
        client = _make_client(FakeUserRepository({USER["email"]: USER}))

        with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
            resp = client.post("/auth/request-otp", json={"email": USER["email"]})

        assert resp.status_code == 200
        assert _dev_log_records(caplog) == []
        errors = [r.getMessage() for r in caplog.records if r.levelno == logging.ERROR]
        assert any("SMTP недоступен" in msg for msg in errors)

    def test_code_logged_when_email_disabled(self, caplog):
        """Почта выключена — это dev-режим, код забирают из лога."""
        client = _make_client(FakeUserRepository({USER["email"]: USER}))

        with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
            resp = client.post("/auth/request-otp", json={"email": USER["email"]})

        assert resp.status_code == 200
        assert len(_dev_log_records(caplog)) == 1


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
            assert resp.json()["error"] == OTP_INVALID_ERROR

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
        assert last_resp.json()["error"] == OTP_INVALID_ERROR

        # Дальнейший verify с ПРАВИЛЬНЫМ кодом всё равно отклоняется — ключ уже удалён.
        resp = client.post("/auth/verify-otp", json={"email": USER["email"], "otp": otp})
        assert resp.status_code == 401
        assert resp.json()["error"] == OTP_INVALID_ERROR

    def test_attempts_counter_without_ttl_is_healed(self, caplog):
        """Счётчик попыток без TTL (падение между INCR и EXPIRE) не залипает."""
        repo = FakeUserRepository({USER["email"]: USER})
        client = _make_client(repo)
        _request_otp_and_extract_code(client, caplog, USER["email"])

        raw = _raw_redis(client)
        raw.set(f"otp_att:{USER['id']}", "1")  # без EXPIRE
        assert raw.ttl(f"otp_att:{USER['id']}") == -1

        resp = client.post(
            "/auth/verify-otp", json={"email": USER["email"], "otp": "000000"}
        )
        assert resp.status_code == 401
        assert raw.ttl(f"otp_att:{USER['id']}") > 0


class TestVerifyOtpUniformErrors:
    """Все отказы verify-otp неотличимы: ответ не выдаёт существование email."""

    def _error_body(self, client: TestClient, email: str, otp: str) -> tuple[int, dict]:
        resp = client.post("/auth/verify-otp", json={"email": email, "otp": otp})
        return resp.status_code, resp.json()

    def test_unknown_email_and_wrong_code_are_indistinguishable(self, caplog):
        client = _make_client(FakeUserRepository({USER["email"]: USER}))
        _request_otp_and_extract_code(client, caplog, USER["email"])

        unknown = self._error_body(client, "nobody@example.com", "000000")
        wrong_code = self._error_body(client, USER["email"], "000000")
        assert unknown == wrong_code == (401, {"success": False, "error": OTP_INVALID_ERROR})

    def test_missing_code_matches_same_text(self):
        """Кода в Redis нет (истёк или не запрашивали) — тот же ответ."""
        client = _make_client(FakeUserRepository({USER["email"]: USER}))
        assert self._error_body(client, USER["email"], "000000") == (
            401,
            {"success": False, "error": OTP_INVALID_ERROR},
        )

    def test_non_ascii_code_does_not_crash(self, caplog):
        """compare_digest на str падает с TypeError на не-ASCII — сравниваем байты."""
        client = _make_client(FakeUserRepository({USER["email"]: USER}))
        _request_otp_and_extract_code(client, caplog, USER["email"])

        status, bodyjson = self._error_body(client, USER["email"], "кодкод")
        assert status == 401
        assert bodyjson["error"] == OTP_INVALID_ERROR


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

    def test_counter_without_ttl_is_healed_instead_of_sticking(self):
        """Ключ без TTL (падение между INCR и EXPIRE) залипал бы на 429 навсегда."""
        client = _make_client(FakeUserRepository())
        email = "unknown@example.com"
        rate_key = f"otp_req:{email}"

        raw = _raw_redis(client)
        raw.set(rate_key, "1")  # без EXPIRE
        assert raw.ttl(rate_key) == -1

        resp = client.post("/auth/request-otp", json={"email": email})
        assert resp.status_code == 200
        assert raw.ttl(rate_key) > 0

    def test_redis_failure_returns_503_not_500(self):
        """Redis недоступен: дружелюбный 503 вместо голого 500 от исключения."""

        class _BrokenRedis:
            async def incr(self, key):
                raise ConnectionError("Redis недоступен")

        client = _make_client(FakeUserRepository())
        client.app.state.redis_adapter = _BrokenRedis()

        resp = client.post("/auth/request-otp", json={"email": USER["email"]})
        assert resp.status_code == 503
        assert resp.json() == {"success": False, "error": REDIS_UNAVAILABLE_ERROR}


class TestRefreshTokens:
    """Ротация токенов: новая пара уходит только в cookie."""

    def _client_with_refresh_cookie(self) -> TestClient:
        client = _make_client(FakeUserRepository({USER["email"]: USER}))
        token = JWTTokenHandler.create_refresh_token(USER["id"])
        client.cookies.set("refresh_token", token)
        return client

    def test_tokens_are_not_returned_in_body(self):
        """Токены в JSON обесценили бы HttpOnly — их читал бы любой скрипт."""
        client = self._client_with_refresh_cookie()

        resp = client.post("/auth/refresh")
        assert resp.status_code == 200
        body = resp.json()
        assert body == {"success": True, "user": {
            "sub": USER["id"],
            "email": USER["email"],
            "login": USER["login"],
            "fullname": USER["fullname"],
            "teams": [],
            "roles": ["auditor"],
        }}
        assert "access_token" not in body
        assert "refresh_token" not in body

    def test_cookies_are_still_rotated(self):
        client = self._client_with_refresh_cookie()

        resp = client.post("/auth/refresh")
        assert resp.status_code == 200
        assert resp.cookies.get("access_token")
        assert resp.cookies.get("refresh_token")

    def test_missing_cookie_returns_401(self):
        client = _make_client(FakeUserRepository({USER["email"]: USER}))
        resp = client.post("/auth/refresh")
        assert resp.status_code == 401

    def test_access_token_rejected_as_refresh(self):
        """Подмена типа токена не проходит: нужен именно refresh."""
        client = _make_client(FakeUserRepository({USER["email"]: USER}))
        client.cookies.set("refresh_token", JWTTokenHandler.create_access_token(USER["id"]))
        resp = client.post("/auth/refresh")
        assert resp.status_code == 401


class TestJwtSecretValidator:
    """AuthSettings.validate_jwt_secret: секрет обязателен, не-дефолтен и не короче 32 символов."""

    def test_enabled_with_default_secret_raises(self):
        """Инстанцируем модель напрямую: Settings() подсосал бы валидный секрет
        из реального .env (delenv на файл не действует), и тест зависел бы
        от его содержимого."""
        with pytest.raises(ValidationError):
            AuthSettings(enabled=True)

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
