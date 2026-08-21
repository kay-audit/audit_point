"""Тесты корневых настроек Redis (app.core.config.RedisSettings / Settings.redis).

Redis — общая инфраструктура приложения на корневом уровне Settings (не под
AuthSettings): app/core/config.py.
"""

from __future__ import annotations

import pytest
from pydantic import SecretStr

from app.core.config import RedisSettings, Settings, get_settings


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    """get_settings() кэширован через lru_cache — сбрасываем до и после теста."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


class TestRedisSettingsDefaults:
    """Дефолты RedisSettings — инстанцируем модель напрямую, без похода в .env."""

    def test_defaults(self):
        redis = RedisSettings()
        assert redis.host == "127.0.0.1"
        assert redis.port == 6379
        assert redis.db == 0
        assert isinstance(redis.password, SecretStr)
        assert redis.password.get_secret_value() == ""
        assert redis.max_connections == 64
        assert redis.socket_timeout == 5.0

    def test_password_secret_not_leaked_in_repr(self):
        """password — SecretStr: значение не должно светиться в repr модели."""
        redis = RedisSettings(password="super-secret")
        assert "super-secret" not in repr(redis)
        assert "super-secret" not in repr(redis.password)
        assert redis.password.get_secret_value() == "super-secret"


class TestRedisOnRootSettings:
    """redis — поле корневого Settings (не AuthSettings), env-префикс REDIS__."""

    def test_redis_is_field_of_root_settings_not_auth(self):
        settings = Settings()
        assert isinstance(settings.redis, RedisSettings)
        assert not hasattr(settings.auth, "redis")

    def test_nested_env_override(self, monkeypatch):
        """REDIS__HOST/REDIS__PORT из окружения переопределяют дефолты (нестандартный ПРОМ-порт)."""
        monkeypatch.setenv("REDIS__HOST", "10.110.10.38")
        monkeypatch.setenv("REDIS__PORT", "7474")
        get_settings.cache_clear()

        settings = get_settings()

        assert settings.redis.host == "10.110.10.38"
        assert settings.redis.port == 7474

    def test_password_from_env_becomes_secret_str(self, monkeypatch):
        monkeypatch.setenv("REDIS__PASSWORD", "env-secret-value")
        get_settings.cache_clear()

        settings = get_settings()

        assert isinstance(settings.redis.password, SecretStr)
        assert "env-secret-value" not in repr(settings.redis.password)
        assert settings.redis.password.get_secret_value() == "env-secret-value"
