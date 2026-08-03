"""Тесты для app.auth.lifecycle (регистрация hooks) и resolve_env_username."""

from types import SimpleNamespace

import pytest

from app.auth.context import resolve_env_username
from app.auth.lifecycle import register_lifespan_hooks
from app.core.domain_registry import (
    get_shutdown_hooks,
    get_startup_hooks,
    has_startup_hook,
    register_startup_hook,
    reset_registry,
)


@pytest.fixture(autouse=True)
def clean_registry():
    reset_registry()
    yield
    reset_registry()


# ── register_lifespan_hooks ──


class TestRegisterLifespanHooks:

    def test_registers_auth_redis_hook(self):
        register_lifespan_hooks()
        startup_names = [name for name, _ in get_startup_hooks()]
        shutdown_names = [name for name, _ in get_shutdown_hooks()]
        assert startup_names.count("auth.redis") == 1
        assert shutdown_names.count("auth.redis") == 1

    def test_repeated_call_does_not_duplicate(self):
        register_lifespan_hooks()
        register_lifespan_hooks()
        register_lifespan_hooks()
        startup_names = [name for name, _ in get_startup_hooks()]
        assert startup_names.count("auth.redis") == 1

    def test_reregisters_after_reset_registry(self):
        # Регрессия: старый модульный флаг _hooks_registered переживал
        # reset_registry(), поэтому повторная сборка app в тестах не
        # регистрировала hook "auth.redis" заново — Redis-адаптер не
        # выставлялся, ОТП-эндпоинты отдавали 503.
        register_lifespan_hooks()
        reset_registry()
        assert not has_startup_hook("auth.redis")

        register_lifespan_hooks()
        assert has_startup_hook("auth.redis")


# ── has_startup_hook ──


class TestHasStartupHook:

    def test_false_when_not_registered(self):
        assert has_startup_hook("auth.redis") is False

    def test_true_after_registration(self):
        async def _dummy_hook(app):
            return None

        register_startup_hook("auth.redis", _dummy_hook)
        assert has_startup_hook("auth.redis") is True
        assert has_startup_hook("other.hook") is False


# ── resolve_env_username ──


class TestResolveEnvUsername:

    def test_valid_digits(self, monkeypatch):
        monkeypatch.setenv("JUPYTERHUB_USER", "12345678")
        assert resolve_env_username() == "12345678"

    def test_boundary_five_digits_ok(self, monkeypatch):
        monkeypatch.setenv("JUPYTERHUB_USER", "12345")
        assert resolve_env_username() == "12345"

    def test_boundary_twenty_digits_ok(self, monkeypatch):
        monkeypatch.setenv("JUPYTERHUB_USER", "1" * 20)
        assert resolve_env_username() == "1" * 20

    def test_too_short_returns_none(self, monkeypatch):
        monkeypatch.setenv("JUPYTERHUB_USER", "1234")
        assert resolve_env_username() is None

    def test_too_long_returns_none(self, monkeypatch):
        monkeypatch.setenv("JUPYTERHUB_USER", "1" * 21)
        assert resolve_env_username() is None

    def test_strips_suffix_after_underscore(self, monkeypatch):
        monkeypatch.setenv("JUPYTERHUB_USER", "22494524_omega-sbrf-ru")
        assert resolve_env_username() == "22494524"

    def test_unknown_user_sentinel_returns_none(self, monkeypatch):
        monkeypatch.setenv("JUPYTERHUB_USER", "unknown_user")
        assert resolve_env_username() is None

    def test_empty_env_falls_back_to_settings_default(self, monkeypatch):
        # os.environ без JUPYTERHUB_USER -> резолвится через get_settings().
        # Локальный .env разработчика обычно задаёт JUPYTERHUB_USER (см.
        # .env.example) — подменяем сам get_settings, чтобы тест не зависел
        # от содержимого реального .env.
        monkeypatch.delenv("JUPYTERHUB_USER", raising=False)
        monkeypatch.setattr(
            "app.core.config.get_settings",
            lambda: SimpleNamespace(jupyterhub_user="unknown_user"),
        )
        assert resolve_env_username() is None
