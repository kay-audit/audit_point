"""Тесты версионирования статики через путь (`/static/v<версия>/<путь>`).

Версия живёт в пути, а не в ``?v=``, чтобы её наследовал весь граф
ES-модулей с относительными импортами. Здесь проверяются обе половины
механизма: фильтр ``versioned`` (сборка URL в шаблонах) и
``VersionedStaticFiles`` (отдача файла по версионированному пути).
"""

import pytest
from fastapi import FastAPI, Request
from httpx import ASGITransport, AsyncClient

from app.core.templating import (
    VersionedStaticFiles,
    _strip_static_version,
    _versioned,
    get_templates,
)


IMMUTABLE = "public, max-age=31536000, immutable"
REVALIDATE = "public, max-age=0, must-revalidate"


# ---------------------------------------------------------------------
# Фильтр versioned
# ---------------------------------------------------------------------

class TestVersionedFilter:
    """Фильтр ``versioned`` вставляет версию в путь, а не в query."""

    def test_relative_path(self):
        assert (
            _versioned("/static/js/entries/constructor.js", "16.0.0")
            == "/static/v16.0.0/js/entries/constructor.js"
        )

    def test_absolute_url(self):
        """``url_for`` в Starlette отдаёт URL со схемой и хостом."""
        assert (
            _versioned("http://testserver/static/css/auth.css", "16.0.0")
            == "http://testserver/static/v16.0.0/css/auth.css"
        )

    def test_url_with_query_preserved(self):
        assert (
            _versioned("/static/js/a.js?foo=1", "16.0.0")
            == "/static/v16.0.0/js/a.js?foo=1"
        )

    def test_query_containing_static_is_not_touched(self):
        """``/static/`` внутри query не должен приниматься за префикс mount'а."""
        assert (
            _versioned("/other/a.js?next=/static/b.js", "16.0.0")
            == "/other/a.js?next=/static/b.js"
        )

    def test_fragment_preserved(self):
        assert (
            _versioned("/static/css/a.css#top", "16.0.0")
            == "/static/v16.0.0/css/a.css#top"
        )

    def test_url_without_static_returned_as_is(self):
        assert _versioned("https://cdn.example/lib.js", "16.0.0") == (
            "https://cdn.example/lib.js"
        )
        assert _versioned("/favicon.ico", "16.0.0") == "/favicon.ico"

    def test_idempotent(self):
        once = _versioned("/static/js/a.js", "16.0.0")
        assert _versioned(once, "16.0.0") == once

    def test_registered_filter_uses_app_version(self):
        """Фильтр в Jinja-окружении подставляет текущую версию приложения."""
        templates = get_templates()
        version = templates.env.globals["app_version"]
        assert templates.env.filters["versioned"]("/static/js/a.js") == (
            f"/static/v{version}/js/a.js"
        )


# ---------------------------------------------------------------------
# Срезание сегмента версии
# ---------------------------------------------------------------------

class TestStripStaticVersion:
    """``v`` + цифра — версия; всё остальное — обычный каталог статики."""

    @pytest.mark.parametrize("path,expected", [
        ("/static/v16.0.0/js/a.js", ("/static/js/a.js", True)),
        ("/static/v1/a.js", ("/static/a.js", True)),
        # vendor/ — реальный каталог статики, срезать его нельзя.
        ("/static/vendor/dompurify/purify.min.js",
         ("/static/vendor/dompurify/purify.min.js", False)),
        ("/static/js/shared/auth.js", ("/static/js/shared/auth.js", False)),
        # Одиночный сегмент без хвоста — не версия, а имя файла.
        ("/static/v16.0.0", ("/static/v16.0.0", False)),
    ])
    def test_strip(self, path, expected):
        assert _strip_static_version(path, "/static") == expected

    def test_strip_without_root_path(self):
        """Без root_path версия ищется с начала пути."""
        assert _strip_static_version("/v16.0.0/js/a.js") == ("/js/a.js", True)


# ---------------------------------------------------------------------
# Отдача файлов
# ---------------------------------------------------------------------

@pytest.fixture
def static_app(tmp_path):
    """FastAPI с VersionedStaticFiles поверх временного каталога."""
    (tmp_path / "js").mkdir()
    (tmp_path / "js" / "app.js").write_text("export const A = 1;", encoding="utf-8")
    # Файл рядом с каталогом статики — цель для path traversal.
    (tmp_path.parent / "secret.txt").write_text("секрет", encoding="utf-8")

    app = FastAPI()
    app.mount("/static", VersionedStaticFiles(directory=str(tmp_path)), name="static")

    @app.get("/url")
    async def _built_url(request: Request):
        """Отдаёт то, что получилось бы в шаблоне из ``url_for | versioned``."""
        return {"url": _versioned(str(request.url_for("static", path="js/app.js")), "16.0.0")}

    return app


@pytest.fixture
def static_client(static_app):
    return AsyncClient(
        transport=ASGITransport(app=static_app),
        base_url="http://test",
    )


class TestVersionedStaticFiles:
    """Оба адреса живы, версия не валидируется, кеш вечный только на ней."""

    async def test_plain_path_serves_file(self, static_client):
        async with static_client as client:
            response = await client.get("/static/js/app.js")
        assert response.status_code == 200
        assert response.text == "export const A = 1;"

    async def test_versioned_path_serves_same_file(self, static_client):
        async with static_client as client:
            plain = await client.get("/static/js/app.js")
            versioned = await client.get("/static/v16.0.0/js/app.js")
        assert versioned.status_code == 200
        assert versioned.text == plain.text

    async def test_arbitrary_version_serves_file(self, static_client):
        """Версия не валидируется — старая вкладка не ловит 404."""
        async with static_client as client:
            old = await client.get("/static/v1.2.3/js/app.js")
            future = await client.get("/static/v999.0.0-rc1/js/app.js")
        assert old.status_code == 200
        assert future.status_code == 200

    async def test_immutable_only_on_versioned_path(self, static_client):
        async with static_client as client:
            plain = await client.get("/static/js/app.js")
            versioned = await client.get("/static/v16.0.0/js/app.js")
        assert versioned.headers["cache-control"] == IMMUTABLE
        assert plain.headers.get("cache-control") != IMMUTABLE

    async def test_url_from_template_filter_is_servable(self, static_client):
        """Сквозная проверка: url_for → versioned → GET отдаёт файл.

        Ловит рассинхрон между тем, что фильтр пишет в шаблон, и тем, что
        умеет отдавать mount.
        """
        async with static_client as client:
            built = (await client.get("/url")).json()["url"]
            assert "/static/v16.0.0/js/app.js" in built
            response = await client.get(built)
        assert response.status_code == 200
        assert response.text == "export const A = 1;"
        assert response.headers["cache-control"] == IMMUTABLE

    async def test_missing_file_under_version_is_404(self, static_client):
        async with static_client as client:
            response = await client.get("/static/v16.0.0/js/missing.js")
        assert response.status_code == 404

    async def test_vendor_directory_not_mistaken_for_version(self, tmp_path):
        """Каталог ``vendor/`` начинается с ``v`` — срезать его нельзя."""
        (tmp_path / "vendor").mkdir()
        (tmp_path / "vendor" / "purify.min.js").write_text("x", encoding="utf-8")
        app = FastAPI()
        app.mount("/static", VersionedStaticFiles(directory=str(tmp_path)))
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/static/vendor/purify.min.js")
        assert response.status_code == 200
        assert response.text == "x"


class TestPathTraversal:
    """Срезание версии не должно обходить нормализацию StaticFiles."""

    @pytest.mark.parametrize("path", [
        "/static/v1/../../secret.txt",
        "/static/v1/%2e%2e/%2e%2e/secret.txt",
        "/static/v16.0.0/../../../secret.txt",
        "/static/../secret.txt",
    ])
    async def test_traversal_rejected(self, static_client, path):
        async with static_client as client:
            response = await client.get(path)
        assert response.status_code in (404, 400), response.text
        assert "секрет" not in response.text

    @pytest.mark.parametrize("raw_path", [
        # Ровно один уровень вверх — целится в реально существующий secret.txt
        # рядом с каталогом статики.
        "/static/v1/../secret.txt",
        "/static/v16.0.0/../../secret.txt",
    ])
    async def test_traversal_rejected_on_raw_asgi_scope(
        self, static_app, tmp_path, raw_path,
    ):
        """Прямой ASGI-scope в обход нормализации URL на клиенте."""
        from starlette.exceptions import HTTPException

        assert (tmp_path.parent / "secret.txt").exists()
        static = VersionedStaticFiles(directory=str(tmp_path))
        scope = {
            "type": "http",
            "method": "GET",
            "root_path": "/static",
            "path": raw_path,
        }
        with pytest.raises(HTTPException) as exc:
            await static.get_response(static.get_path(scope), scope)
        assert exc.value.status_code == 404


# ---------------------------------------------------------------------
# Флаг SECURITY__STATIC_IMMUTABLE
# ---------------------------------------------------------------------

class TestStaticImmutableFlag:
    """Политика кеша версионированного пути переключается настройкой.

    На ПРОМе адрес меняется с релизом → вечный кеш. На DEV версия в пути при
    правке ``.js`` не меняется, поэтому вечный кеш прячет изменения от F5 —
    там нужен обязательный поход на сервер за ETag.
    """

    @staticmethod
    def _client(tmp_path, *, immutable: bool) -> AsyncClient:
        (tmp_path / "app.js").write_text("export const A = 1;", encoding="utf-8")
        app = FastAPI()
        app.mount(
            "/static",
            VersionedStaticFiles(directory=str(tmp_path), immutable=immutable),
            name="static",
        )
        return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    async def test_enabled_serves_immutable(self, tmp_path):
        async with self._client(tmp_path, immutable=True) as client:
            response = await client.get("/static/v16.0.0/app.js")
        assert response.headers["cache-control"] == IMMUTABLE

    async def test_disabled_forces_revalidation(self, tmp_path):
        async with self._client(tmp_path, immutable=False) as client:
            response = await client.get("/static/v16.0.0/app.js")
        assert response.headers["cache-control"] == REVALIDATE
        # ETag обязан присутствовать — на нём и держится 304.
        assert response.headers.get("etag")

    async def test_disabled_still_answers_304_by_etag(self, tmp_path):
        """Выключенный флаг — не «без кеша»: тело повторно не гоняется."""
        async with self._client(tmp_path, immutable=False) as client:
            first = await client.get("/static/v16.0.0/app.js")
            second = await client.get(
                "/static/v16.0.0/app.js",
                headers={"if-none-match": first.headers["etag"]},
            )
        assert second.status_code == 304

    async def test_flag_does_not_touch_plain_path(self, tmp_path):
        """Неверсионированный /static/... остаётся на дефолтах StaticFiles."""
        async with self._client(tmp_path, immutable=False) as client:
            plain = await client.get("/static/app.js")
        assert plain.headers.get("cache-control") not in (IMMUTABLE, REVALIDATE)

    def test_settings_default_is_revalidation(self):
        """Дефолт кода — безопасный для DEV; ПРОМ включает флаг явно."""
        from app.core.config import SecuritySettings

        assert SecuritySettings().static_immutable is False
