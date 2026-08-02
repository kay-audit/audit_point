"""Тесты для модуля подключения к БД (app/db/connection.py)."""

import subprocess

import pytest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import asyncpg

from app.db import connection
from app.db.connection import (
    KerberosTokenExpiredError,
    _is_kerberos_ticket_valid,
    _is_kerberos_token_expired,
    close_db,
    create_tables_if_not_exist,
    get_adapter,
    get_db,
    get_pool,
    init_db,
)


@pytest.fixture(autouse=True)
def reset_connection_globals():
    """Сбрасывает глобальное состояние _pool и _adapter между тестами."""
    yield
    connection._pool = None
    connection._adapter = None
    connection._acquire_timeout = None


# ---------------------------------------------------------------------------
# Вспомогательные функции
# ---------------------------------------------------------------------------


def _make_settings(db_type="postgresql", jupyterhub_user="12345_user"):
    """Создаёт минимальный mock настроек."""
    s = MagicMock()
    s.database.type = db_type
    s.database.host = "localhost"
    s.database.port = 5432
    s.database.name = "testdb"
    s.database.user = "testuser"
    s.database.password = MagicMock(get_secret_value=MagicMock(return_value="secret"))
    s.database.pool_min_size = 1
    s.database.pool_max_size = 5
    s.database.command_timeout = 30
    s.database.gp.host = "gp-host"
    s.database.gp.port = 5433
    s.database.gp.database = "gpdb"
    s.database.gp.schema_name = "test_schema"
    s.database.table_prefix = "t_prefix_"
    s.jupyterhub_user = jupyterhub_user
    return s


# ===========================================================================
# 1. _is_kerberos_token_expired / _is_kerberos_ticket_valid
# ===========================================================================


class TestKerberosDetection:

    @pytest.mark.parametrize(
        "message",
        [
            "ticket expired",
            "tkt_expired",
            "krb_ap_err_tkt_expired",
            "gss failure",
            "gss error",
            "unspecified gss failure",
            "credentials cache",
            "credential cache file",
            "no kerberos credentials available",
            "kerberos credentials",
            "kinit",
            "authentification",
            "authentication",
            "minor: ticket expired",
        ],
    )
    def test_каждый_паттерн_распознаётся(self, message):
        assert _is_kerberos_token_expired(message) is True

    @pytest.mark.parametrize(
        "message",
        [
            "TICKET EXPIRED",
            "Ticket Expired",
            "GSS FAILURE",
            "No Kerberos Credentials Available",
        ],
    )
    def test_регистронезависимость(self, message):
        assert _is_kerberos_token_expired(message) is True

    def test_строка_без_совпадений(self):
        assert _is_kerberos_token_expired("connection refused") is False

    def test_пустая_строка(self):
        assert _is_kerberos_token_expired("") is False

    def test_частичное_совпадение_в_длинном_тексте(self):
        long_msg = "Connection failed: minor: ticket expired (blah blah)"
        assert _is_kerberos_token_expired(long_msg) is True


class TestIsKerberosTicketValid:
    """Контракт `klist -s`: rc 0 → валиден, иначе — нет; Windows не проверяется,
    любая ошибка запуска — fail-open (True)."""

    def test_windows_true_без_вызова_subprocess(self, monkeypatch):
        monkeypatch.setattr(connection.sys, "platform", "win32")
        with patch("app.db.connection._subprocess.run") as mock_run:
            assert _is_kerberos_ticket_valid() is True
        mock_run.assert_not_called()

    def test_posix_rc0_валиден(self, monkeypatch):
        monkeypatch.setattr(connection.sys, "platform", "linux")
        mock_result = MagicMock(returncode=0)
        with patch(
            "app.db.connection._subprocess.run", return_value=mock_result
        ) as mock_run:
            assert _is_kerberos_ticket_valid() is True
        mock_run.assert_called_once_with(["klist", "-s"], timeout=5)

    def test_posix_rc1_невалиден(self, monkeypatch):
        monkeypatch.setattr(connection.sys, "platform", "linux")
        mock_result = MagicMock(returncode=1)
        with patch("app.db.connection._subprocess.run", return_value=mock_result):
            assert _is_kerberos_ticket_valid() is False

    def test_posix_klist_не_найден_fail_open(self, monkeypatch):
        monkeypatch.setattr(connection.sys, "platform", "linux")
        with patch(
            "app.db.connection._subprocess.run", side_effect=FileNotFoundError()
        ):
            assert _is_kerberos_ticket_valid() is True

    def test_posix_таймаут_fail_open(self, monkeypatch):
        monkeypatch.setattr(connection.sys, "platform", "linux")
        with patch(
            "app.db.connection._subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="klist -s", timeout=5),
        ):
            assert _is_kerberos_ticket_valid() is True

    def test_posix_нет_прав_fail_open(self, monkeypatch):
        monkeypatch.setattr(connection.sys, "platform", "linux")
        with patch("app.db.connection._subprocess.run", side_effect=PermissionError()):
            assert _is_kerberos_ticket_valid() is True

    def test_posix_прочая_ошибка_fail_open(self, monkeypatch):
        """Любое исключение — не только 3 именованных — тоже fail-open."""
        monkeypatch.setattr(connection.sys, "platform", "linux")
        with patch(
            "app.db.connection._subprocess.run", side_effect=OSError("недоступно")
        ):
            assert _is_kerberos_ticket_valid() is True


# ===========================================================================
# 2. get_pool / get_adapter
# ===========================================================================


class TestGetPool:

    def test_pool_не_инициализирован(self):
        with pytest.raises(RuntimeError, match="Database pool не инициализирован"):
            get_pool()

    def test_pool_инициализирован(self):
        sentinel = MagicMock()
        connection._pool = sentinel
        assert get_pool() is sentinel


class TestGetAdapter:

    def test_adapter_не_инициализирован(self):
        with pytest.raises(RuntimeError, match="Database adapter не инициализирован"):
            get_adapter()

    def test_adapter_инициализирован(self):
        sentinel = MagicMock()
        connection._adapter = sentinel
        assert get_adapter() is sentinel


# ===========================================================================
# 3. init_db
# ===========================================================================


class TestInitDb:

    # --- PostgreSQL ---

    @patch("app.db.connection.asyncpg.create_pool", new_callable=AsyncMock)
    async def test_postgresql_успешная_инициализация(self, mock_create_pool):
        from app.db.adapters.postgresql import PostgreSQLAdapter

        mock_pool = AsyncMock()
        mock_create_pool.return_value = mock_pool

        settings = _make_settings(db_type="postgresql")
        await init_db(settings)

        mock_create_pool.assert_awaited_once()
        assert connection._pool is mock_pool
        assert isinstance(connection._adapter, PostgreSQLAdapter)

    @patch("app.db.connection.asyncpg.create_pool", new_callable=AsyncMock)
    async def test_повторный_вызов_не_пересоздаёт_пул(self, mock_create_pool):
        connection._pool = MagicMock()

        settings = _make_settings()
        await init_db(settings)

        mock_create_pool.assert_not_awaited()

    # --- Greenplum ---

    @patch("app.db.connection._is_kerberos_ticket_valid", return_value=True)
    @patch("app.db.connection.asyncpg.create_pool", new_callable=AsyncMock)
    @patch.dict("os.environ", {"JUPYTERHUB_USER": "u12345_test"})
    async def test_greenplum_успешная_инициализация_env(self, mock_create_pool, _mock_krb):
        from app.db.adapters.greenplum import GreenplumAdapter

        mock_pool = AsyncMock()
        mock_create_pool.return_value = mock_pool

        settings = _make_settings(db_type="greenplum")
        await init_db(settings)

        mock_create_pool.assert_awaited_once()
        assert connection._pool is mock_pool
        assert isinstance(connection._adapter, GreenplumAdapter)

        # Проверяем что user в pool_kwargs — это цифры из первой части username
        call_kwargs = mock_create_pool.call_args
        assert call_kwargs.kwargs.get("user") == "12345" or call_kwargs[1].get("user") == "12345"

    @patch("app.db.connection._is_kerberos_ticket_valid", return_value=True)
    @patch("app.db.connection.asyncpg.create_pool", new_callable=AsyncMock)
    @patch.dict("os.environ", {"JUPYTERHUB_USER": ""})
    async def test_greenplum_fallback_на_settings(self, mock_create_pool, _mock_krb):
        mock_pool = AsyncMock()
        mock_create_pool.return_value = mock_pool

        settings = _make_settings(db_type="greenplum", jupyterhub_user="99887_dev")
        await init_db(settings)

        call_kwargs = mock_create_pool.call_args
        assert call_kwargs.kwargs.get("user") == "99887" or call_kwargs[1].get("user") == "99887"

    @patch("app.db.connection.asyncpg.create_pool", new_callable=AsyncMock)
    @patch.dict("os.environ", {"JUPYTERHUB_USER": ""})
    async def test_greenplum_username_без_цифр_ValueError(self, mock_create_pool):
        settings = _make_settings(db_type="greenplum", jupyterhub_user="no_digits_here")

        with pytest.raises(ValueError, match="Не удалось извлечь username"):
            await init_db(settings)

    @patch("app.db.connection._is_kerberos_ticket_valid", return_value=True)
    @patch("app.db.connection.asyncpg.create_pool", new_callable=AsyncMock)
    @patch.dict("os.environ", {"JUPYTERHUB_USER": "u12345_test"})
    async def test_greenplum_kerberos_ошибка(self, mock_create_pool, _mock_krb):
        mock_create_pool.side_effect = asyncpg.PostgresError("ticket expired")

        settings = _make_settings(db_type="greenplum")
        with pytest.raises(KerberosTokenExpiredError):
            await init_db(settings)

    @patch("app.db.connection._is_kerberos_ticket_valid", return_value=True)
    @patch("app.db.connection.asyncpg.create_pool", new_callable=AsyncMock)
    @patch.dict("os.environ", {"JUPYTERHUB_USER": "u12345_test"})
    async def test_greenplum_postgres_error_не_kerberos(self, mock_create_pool, _mock_krb):
        mock_create_pool.side_effect = asyncpg.PostgresError("permission denied")

        settings = _make_settings(db_type="greenplum")
        with pytest.raises(RuntimeError, match="Не удалось подключиться к БД"):
            await init_db(settings)

    @patch("app.db.connection._is_kerberos_ticket_valid", return_value=True)
    @patch("app.db.connection.asyncpg.create_pool", new_callable=AsyncMock)
    @patch.dict("os.environ", {"JUPYTERHUB_USER": "u12345_test"})
    async def test_greenplum_неожиданная_ошибка(self, mock_create_pool, _mock_krb):
        mock_create_pool.side_effect = OSError("network unreachable")

        settings = _make_settings(db_type="greenplum")
        with pytest.raises(RuntimeError, match="Не удалось создать пул подключений"):
            await init_db(settings)

    @patch("app.db.connection._is_kerberos_ticket_valid", return_value=False)
    @patch("app.db.connection.asyncpg.create_pool", new_callable=AsyncMock)
    @patch.dict("os.environ", {"JUPYTERHUB_USER": "u12345_test"})
    async def test_greenplum_предпроверка_kerberos(self, mock_create_pool, _mock_krb):
        """Предпроверка klist -s ловит протухший билет до подключения к БД."""
        settings = _make_settings(db_type="greenplum")
        with pytest.raises(KerberosTokenExpiredError):
            await init_db(settings)

        # Подключение к БД не должно происходить
        mock_create_pool.assert_not_awaited()

    @patch("app.db.connection._is_kerberos_ticket_valid", return_value=False)
    @patch("app.db.connection.asyncpg.create_pool", new_callable=AsyncMock)
    @patch.dict("os.environ", {"JUPYTERHUB_USER": "u12345_test"})
    async def test_greenplum_ошибка_подключения_при_протухшем_билете(self, mock_create_pool, mock_krb):
        """OSError при подключении к GP + протухший билет → KerberosTokenExpiredError."""
        # Имитируем: предпроверка прошла (билет был валиден), но к моменту подключения протух
        mock_krb.side_effect = [True, False]
        mock_create_pool.side_effect = OSError("Connection refused")

        settings = _make_settings(db_type="greenplum")
        with pytest.raises(KerberosTokenExpiredError):
            await init_db(settings)

    # --- PostgreSQL ошибки подключения ---

    @patch("app.db.connection.asyncpg.create_pool", new_callable=AsyncMock)
    async def test_postgresql_generic_exception(self, mock_create_pool):
        mock_create_pool.side_effect = OSError("network unreachable")

        settings = _make_settings(db_type="postgresql")
        with pytest.raises(RuntimeError, match="Не удалось создать пул подключений"):
            await init_db(settings)

    @patch("app.db.connection.asyncpg.create_pool", new_callable=AsyncMock)
    async def test_postgresql_kerberos_ошибка(self, mock_create_pool):
        mock_create_pool.side_effect = asyncpg.PostgresError("ticket expired")

        settings = _make_settings(db_type="postgresql")
        with pytest.raises(KerberosTokenExpiredError):
            await init_db(settings)

    @patch("app.db.connection.asyncpg.create_pool", new_callable=AsyncMock)
    async def test_postgresql_postgres_error_не_kerberos(self, mock_create_pool):
        mock_create_pool.side_effect = asyncpg.PostgresError("permission denied")

        settings = _make_settings(db_type="postgresql")
        with pytest.raises(RuntimeError, match="Не удалось подключиться к БД"):
            await init_db(settings)

    # --- Неподдерживаемый тип ---

    async def test_неподдерживаемый_тип_бд(self):
        settings = _make_settings(db_type="oracle")
        with pytest.raises(ValueError, match="Неподдерживаемый тип БД"):
            await init_db(settings)


# ===========================================================================
# 4. close_db
# ===========================================================================


class TestCloseDb:

    async def test_закрытие_существующего_пула(self):
        mock_pool = AsyncMock()
        connection._pool = mock_pool
        connection._adapter = MagicMock()

        await close_db()

        mock_pool.close.assert_awaited_once()
        assert connection._pool is None
        assert connection._adapter is None

    async def test_закрытие_когда_пул_None(self):
        assert connection._pool is None
        await close_db()  # не должно бросать
        assert connection._pool is None


# ===========================================================================
# 5. get_db — async context manager
# ===========================================================================


class TestGetDb:

    async def test_успешное_получение_соединения(self):
        mock_conn = AsyncMock()
        mock_pool = MagicMock()
        # acquire/release теперь вызываются раздельно (не как контекст-менеджер):
        # таймаут acquire ловится отдельно от ошибок тела запроса.
        mock_pool.acquire = AsyncMock(return_value=mock_conn)
        mock_pool.release = AsyncMock()
        connection._pool = mock_pool

        async with get_db() as conn:
            assert conn is mock_conn
        # Соединение возвращается в пул в finally.
        mock_pool.release.assert_awaited_once_with(mock_conn)

    async def test_acquire_timeout_отдаёт_503(self):
        """При исчерпании пула (TimeoutError на acquire) — ServiceUnavailableError."""
        import asyncio
        from app.core.exceptions import ServiceUnavailableError

        mock_pool = MagicMock()
        mock_pool.acquire = AsyncMock(side_effect=asyncio.TimeoutError())
        mock_pool.release = AsyncMock()
        connection._pool = mock_pool

        with pytest.raises(ServiceUnavailableError) as exc_info:
            async with get_db():
                pass
        assert exc_info.value.status_code == 503
        # release не вызывается — соединение не было получено.
        mock_pool.release.assert_not_awaited()

    async def test_kerberos_ошибка_при_acquire(self):
        # Kerberos-ошибка при установлении соединения (рост пула) → понятная ошибка.
        mock_pool = MagicMock()
        mock_pool.acquire = AsyncMock(
            side_effect=asyncpg.PostgresError("gss failure during auth")
        )
        mock_pool.release = AsyncMock()
        connection._pool = mock_pool

        with pytest.raises(KerberosTokenExpiredError):
            async with get_db():
                pass

    async def test_postgres_error_без_kerberos(self):
        # Не-Kerberos PostgresError из тела запроса пробрасывается как есть;
        # соединение при этом всё равно возвращается в пул.
        mock_conn = AsyncMock()
        mock_pool = MagicMock()
        mock_pool.acquire = AsyncMock(return_value=mock_conn)
        mock_pool.release = AsyncMock()
        connection._pool = mock_pool

        with pytest.raises(asyncpg.PostgresError, match="relation does not exist"):
            async with get_db():
                raise asyncpg.PostgresError("relation does not exist")
        mock_pool.release.assert_awaited_once_with(mock_conn)


# ===========================================================================
# 6. create_tables_if_not_exist
# ===========================================================================


class TestCreateTables:

    async def test_с_доменами(self, tmp_path):
        # Создаём файл schema.sql
        pg_dir = tmp_path / "migrations" / "postgresql"
        pg_dir.mkdir(parents=True)
        schema_file = pg_dir / "schema.sql"
        schema_file.write_text("CREATE TABLE test (id INT);")

        domain = MagicMock()
        domain.migration_substitutions = {"KEY": "VALUE"}
        domain.package_path = tmp_path

        mock_conn = AsyncMock()
        mock_pool = MagicMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)

        from app.db.adapters.postgresql import PostgreSQLAdapter
        real_adapter = MagicMock(spec=PostgreSQLAdapter)
        real_adapter.create_tables = AsyncMock()

        connection._pool = mock_pool
        connection._adapter = real_adapter

        await create_tables_if_not_exist([domain])

        real_adapter.create_tables.assert_awaited_once()
        call_args = real_adapter.create_tables.call_args
        # Проверяем что schema_paths содержит наш файл
        schema_paths = call_args[0][1]
        assert len(schema_paths) == 1
        assert schema_paths[0] == schema_file
        # Проверяем что substitutions передаются
        substitutions = call_args[0][2]
        assert substitutions == {"KEY": "VALUE"}

    async def test_без_доменов(self):
        from app.db.adapters.postgresql import PostgreSQLAdapter

        mock_conn = AsyncMock()
        mock_pool = MagicMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)

        real_adapter = MagicMock(spec=PostgreSQLAdapter)
        real_adapter.create_tables = AsyncMock()

        connection._pool = mock_pool
        connection._adapter = real_adapter

        await create_tables_if_not_exist([])

        # create_tables вызывается с пустым списком путей
        real_adapter.create_tables.assert_awaited_once()
        call_args = real_adapter.create_tables.call_args
        assert call_args[0][1] == []

    async def test_kerberos_ошибка_при_создании_таблиц(self):
        from app.db.adapters.postgresql import PostgreSQLAdapter

        mock_conn = AsyncMock()
        mock_pool = MagicMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)

        real_adapter = MagicMock(spec=PostgreSQLAdapter)
        real_adapter.create_tables = AsyncMock(
            side_effect=asyncpg.PostgresError("ticket expired")
        )

        connection._pool = mock_pool
        connection._adapter = real_adapter

        with pytest.raises(KerberosTokenExpiredError):
            await create_tables_if_not_exist([])

    async def test_postgres_error_при_создании_таблиц(self):
        from app.db.adapters.postgresql import PostgreSQLAdapter

        mock_conn = AsyncMock()
        mock_pool = MagicMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)

        real_adapter = MagicMock(spec=PostgreSQLAdapter)
        real_adapter.create_tables = AsyncMock(
            side_effect=asyncpg.PostgresError("syntax error in schema")
        )

        connection._pool = mock_pool
        connection._adapter = real_adapter

        with pytest.raises(asyncpg.PostgresError, match="syntax error"):
            await create_tables_if_not_exist([])

    async def test_substitutions_из_domain_передаются(self, tmp_path):
        """Проверяет что migration_substitutions из нескольких доменов объединяются."""
        from app.db.adapters.postgresql import PostgreSQLAdapter

        d1 = MagicMock()
        d1.migration_substitutions = {"A": "1"}
        d1.package_path = None  # нет schema.sql

        d2 = MagicMock()
        d2.migration_substitutions = {"B": "2"}
        d2.package_path = None

        mock_conn = AsyncMock()
        mock_pool = MagicMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)

        real_adapter = MagicMock(spec=PostgreSQLAdapter)
        real_adapter.create_tables = AsyncMock()

        connection._pool = mock_pool
        connection._adapter = real_adapter

        await create_tables_if_not_exist([d1, d2])

        call_args = real_adapter.create_tables.call_args
        substitutions = call_args[0][2]
        assert substitutions == {"A": "1", "B": "2"}
