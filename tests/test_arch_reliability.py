"""
Тесты для задач архитектурной надёжности:
  1.2.3 — executor в app.state
  1.3.2 — namespace для exception handlers (fail-fast при конфликте)
  3.3.1 — JUPYTERHUB_USER через settings в connection.py
  5.2.3 — specific except в lifespan
"""

import pytest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI

from app.core.domain import DomainDescriptor
from app.core.domain_registry import register_domains, reset_registry


# ── Фикстура сброса реестра ──────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def clean_registry():
    reset_registry()
    yield
    reset_registry()


# ===========================================================================
# 1.2.3 — executor в app.state
# ===========================================================================


class TestExecutorInAppState:

    async def test_on_startup_сохраняет_executor_в_app_state(self):
        """После on_startup app.state.executor содержит ThreadPoolExecutor."""
        from app.domains.acts._lifecycle import on_startup, on_shutdown

        app = FastAPI()
        await on_startup(app)

        try:
            assert hasattr(app.state, "executor")
            assert isinstance(app.state.executor, ThreadPoolExecutor)
        finally:
            await on_shutdown(app)

    async def test_on_shutdown_закрывает_executor_и_очищает_state(self):
        """После on_shutdown app.state.executor == None и executor завершён."""
        from app.domains.acts._lifecycle import on_startup, on_shutdown

        app = FastAPI()
        await on_startup(app)
        executor = app.state.executor

        await on_shutdown(app)

        assert app.state.executor is None
        # shutdown(wait=True) уже вызван — проверяем что пул завершён
        assert executor._shutdown  # type: ignore[attr-defined]

    async def test_on_shutdown_без_предварительного_startup(self):
        """on_shutdown без on_startup не падает."""
        from app.domains.acts._lifecycle import on_shutdown

        app = FastAPI()
        # Не должен бросать исключение
        await on_shutdown(app)

    def test_get_executor_возвращает_объект_из_state(self):
        """get_format_thread_pool() возвращает тот же объект что и app.state.executor."""
        from app.domains.acts import _lifecycle as lc

        sentinel = MagicMock(spec=ThreadPoolExecutor)
        lc._thread_pool = sentinel
        try:
            result = lc.get_format_thread_pool()
            assert result is sentinel
        finally:
            lc._thread_pool = None

    def test_get_executor_без_инициализации_бросает_RuntimeError(self):
        """get_format_thread_pool() при _thread_pool=None бросает RuntimeError."""
        from app.domains.acts import _lifecycle as lc

        original = lc._thread_pool
        lc._thread_pool = None
        try:
            with pytest.raises(RuntimeError, match="не инициализирован"):
                lc.get_format_thread_pool()
        finally:
            lc._thread_pool = original

    async def test_startup_и_shutdown_синхронизируют_module_level(self):
        """После startup _thread_pool == app.state.executor; после shutdown == None."""
        from app.domains.acts import _lifecycle as lc
        from app.domains.acts._lifecycle import on_startup, on_shutdown

        app = FastAPI()
        await on_startup(app)
        try:
            assert lc._thread_pool is app.state.executor
        finally:
            await on_shutdown(app)

        assert lc._thread_pool is None


# ===========================================================================
# 1.3.2 — namespace для exception handlers
# ===========================================================================


class MyExcA(Exception):
    pass


class MyExcB(Exception):
    pass


def _make_domain(name, exc_class=None):
    handlers = {exc_class: lambda req, exc: None} if exc_class else None
    return DomainDescriptor(name=name, exception_handlers=handlers)


class TestExceptionHandlerNamespace:

    def test_один_домен_регистрирует_handler_без_ошибки(self):
        """Регистрация handler одним доменом проходит без ошибок."""
        app = FastAPI()
        d = _make_domain("domain_a", MyExcA)
        register_domains(app, [d], "/api/v1")  # не должен бросать

    def test_два_домена_разные_классы_без_ошибки(self):
        """Разные домены с разными классами исключений — ошибки нет."""
        app = FastAPI()
        domains = [
            _make_domain("domain_a", MyExcA),
            _make_domain("domain_b", MyExcB),
        ]
        register_domains(app, domains, "/api/v1")  # не должен бросать

    def test_два_домена_один_класс_RuntimeError(self):
        """Два домена пытаются зарегистрировать handler на один класс → RuntimeError."""
        app = FastAPI()
        domains = [
            _make_domain("domain_a", MyExcA),
            _make_domain("domain_b", MyExcA),  # тот же класс!
        ]
        with pytest.raises(RuntimeError, match="domain_a"):
            register_domains(app, domains, "/api/v1")

    def test_сообщение_об_ошибке_содержит_оба_домена(self):
        """RuntimeError содержит имена обоих конфликтующих доменов."""
        app = FastAPI()
        domains = [
            _make_domain("alpha", MyExcA),
            _make_domain("beta", MyExcA),
        ]
        with pytest.raises(RuntimeError) as exc_info:
            register_domains(app, domains, "/api/v1")

        msg = str(exc_info.value)
        assert "alpha" in msg
        assert "beta" in msg

    def test_без_exception_handlers_нет_ошибки(self):
        """Домены без exception_handlers регистрируются без проблем."""
        app = FastAPI()
        domains = [
            DomainDescriptor(name="no_handlers_a"),
            DomainDescriptor(name="no_handlers_b"),
        ]
        register_domains(app, domains, "/api/v1")  # не должен бросать


# ===========================================================================
# 3.3.1 — JUPYTERHUB_USER через settings в connection.py
# ===========================================================================


class TestJupyterhubUserViaSettings:

    @patch("app.db.connection.asyncpg.create_pool", new_callable=AsyncMock)
    @patch("app.db.connection._is_kerberos_ticket_valid", return_value=True)
    async def test_settings_jupyterhub_user_используется_для_greenplum(
        self, _mock_krb, mock_create_pool
    ):
        """
        При db.type=greenplum, username берётся из settings.jupyterhub_user
        (без прямого os.environ.get).
        """
        from app.db import connection
        from app.db.connection import init_db

        mock_pool = AsyncMock()
        mock_create_pool.return_value = mock_pool

        settings = MagicMock()
        settings.database.type = "greenplum"
        settings.database.table_prefix = "t_"
        settings.database.pool_min_size = 1
        settings.database.pool_max_size = 5
        settings.database.command_timeout = 30
        settings.database.gp.host = "gp-host"
        settings.database.gp.port = 5433
        settings.database.gp.database = "gpdb"
        settings.database.gp.schema_name = "test_schema"
        # Ключевое: ТОЛЬКО через settings, без os.environ
        settings.jupyterhub_user = "98765_omega"

        try:
            await init_db(settings)
            call_kwargs = mock_create_pool.call_args
            user_arg = call_kwargs.kwargs.get("user") or call_kwargs[1].get("user")
            assert user_arg == "98765", (
                f"Ожидали '98765', получили '{user_arg}'"
            )
        finally:
            connection._pool = None
            connection._adapter = None

    @patch("app.db.connection.asyncpg.create_pool", new_callable=AsyncMock)
    @patch("app.db.connection._is_kerberos_ticket_valid", return_value=True)
    async def test_monkeypatched_settings_виден_в_connection(
        self, _mock_krb, mock_create_pool
    ):
        """
        Подмена settings через monkeypatch влияет на connection.py —
        подтверждает что os.environ.get убран из кода.
        """
        from app.db import connection
        from app.db.connection import init_db

        mock_pool = AsyncMock()
        mock_create_pool.return_value = mock_pool

        settings = MagicMock()
        settings.database.type = "greenplum"
        settings.database.table_prefix = "t_"
        settings.database.pool_min_size = 1
        settings.database.pool_max_size = 5
        settings.database.command_timeout = 30
        settings.database.gp.host = "gp-host"
        settings.database.gp.port = 5433
        settings.database.gp.database = "gpdb"
        settings.database.gp.schema_name = "s1"
        settings.jupyterhub_user = "11223344_test"

        try:
            await init_db(settings)
            call_kwargs = mock_create_pool.call_args
            user_arg = call_kwargs.kwargs.get("user") or call_kwargs[1].get("user")
            assert user_arg == "11223344"
        finally:
            connection._pool = None
            connection._adapter = None

    def test_os_environ_не_используется_напрямую_в_connection(self):
        """
        Проверяет исходный код connection.py: прямой os.environ.get('JUPYTERHUB_USER')
        должен быть удалён.
        """
        import inspect
        from app.db import connection as conn_module

        source = inspect.getsource(conn_module)
        assert "os.environ.get('JUPYTERHUB_USER')" not in source, (
            "os.environ.get('JUPYTERHUB_USER') найден в connection.py — "
            "должен быть заменён на settings.jupyterhub_user"
        )
        assert 'os.environ.get("JUPYTERHUB_USER")' not in source, (
            'os.environ.get("JUPYTERHUB_USER") найден в connection.py'
        )


# ===========================================================================
# 5.2.3 — specific except в lifespan
# ===========================================================================


class TestSpecificExceptInLifespan:

    def test_asyncpg_postgres_error_обрабатывается_отдельно(self):
        """
        В lifespan startup asyncpg.PostgresError ловится явным except,
        а не только общим except Exception.
        """
        import inspect
        from app import main as main_module

        source = inspect.getsource(main_module.lifespan)
        # Должен быть явный except asyncpg.PostgresError
        assert "except asyncpg.PostgresError" in source, (
            "В lifespan нет явного 'except asyncpg.PostgresError' — "
            "задача 5.2.3 не выполнена"
        )

    def test_kerberos_error_ловится_до_generic_except(self):
        """
        KerberosTokenExpiredError должен ловиться ПЕРЕД Exception
        (специфичный перед общим).
        """
        import inspect
        from app import main as main_module

        source = inspect.getsource(main_module.lifespan)
        pos_kerberos = source.find("except KerberosTokenExpiredError")
        pos_generic = source.rfind("except Exception")  # последний в startup-блоке

        assert pos_kerberos != -1, "KerberosTokenExpiredError не найден в lifespan"
        assert pos_generic != -1, "except Exception не найден в lifespan"
        assert pos_kerberos < pos_generic, (
            "KerberosTokenExpiredError должен быть до except Exception"
        )

    def test_нет_except_BaseException_в_lifespan(self):
        """
        В lifespan не должно быть except BaseException —
        это поглотило бы KeyboardInterrupt/SystemExit.
        """
        import inspect
        from app import main as main_module

        source = inspect.getsource(main_module.lifespan)
        assert "except BaseException" not in source, (
            "В lifespan найден 'except BaseException' — это поглощает "
            "KeyboardInterrupt и SystemExit"
        )
