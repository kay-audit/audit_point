"""
Тесты ImagesSettings и эндпоинта GET /api/v1/acts/limits.

Эндпоинт отдаёт фронту лимиты картинок нарушений (настройки ACTS__IMAGES__*)
и жёсткие границы таблиц/текстблоков из констант схем — чтобы UI-валидация
совпадала с серверной (образец — chat GET /limits).

E2E-паттерн: минимальный FastAPI + dependency_overrides, без create_app().
Дефолты настроек проверяются прямым инстанцированием модели (не _load_from_env,
который подсасывает реальный .env).
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api.v1.deps.auth_deps import get_username
from app.core.config import SecuritySettings
from app.domains.acts.api import get_api_routers
from app.domains.acts.deps import _get_acts_settings
from app.domains.acts.schemas.act_content import (
    FONT_SIZE_MAX,
    FONT_SIZE_MIN,
    TABLE_MAX_COLS,
    TABLE_MAX_ROWS,
    VIOLATION_CONTENT_ITEMS_MAX,
    VIOLATION_IMAGE_URL_MAX_LENGTH,
)
from app.domains.acts.settings import (
    ActsSettings,
    ImagesSettings,
    TablesSettings,
    TextblocksSettings,
    ViolationsSettings,
)


USERNAME = "12345"


# ── ImagesSettings: дефолты ─────────────────────────────────────────────────


class TestImagesSettingsDefaults:
    """Дефолты лимитов картинок нарушений."""

    def test_defaults(self):
        s = ImagesSettings()
        assert s.max_file_size == 4 * 1024 * 1024
        assert s.max_total_size_per_act == 5 * 1024 * 1024
        assert s.allowed_mime_types == [
            "image/jpeg", "image/png", "image/gif",
        ]
        assert s.max_items_per_violation == 50
        assert s.image_max_height_percent == 40

    def test_acts_settings_includes_images(self):
        s = ActsSettings()
        assert isinstance(s.images, ImagesSettings)
        assert s.images.max_file_size == 4 * 1024 * 1024

    def test_url_max_length_covers_max_file_size_in_base64(self):
        """Инвариант согласованности лимитов (fce3e4e ↔ ImagesSettings).

        Серверный потолок длины data-URL (VIOLATION_IMAGE_URL_MAX_LENGTH)
        обязан быть заведомо выше UX-лимита файла: base64 раздувает байты
        в ×4/3 плюс префикс data:image/...;base64, — иначе валидный по
        max_file_size файл отбивался бы схемой.
        """
        s = ImagesSettings()
        base64_len = (s.max_file_size + 2) // 3 * 4
        prefix_margin = 64  # запас на data:image/jpeg;base64, и подобные
        assert VIOLATION_IMAGE_URL_MAX_LENGTH > base64_len + prefix_margin

    def test_image_budgets_fit_in_http_request_size_limit(self):
        """Инвариант (#2, КРИТ): base64-раздутый бюджет картинок влезает в лимит запроса.

        Бюджет картинок (ImagesSettings) считается в СЫРЫХ байтах, а на провод
        внутри JSON акта уходит base64 (+×4/3). RequestSizeLimitMiddleware
        режет тело запроса по SecuritySettings.max_request_size — если
        base64-раздутая сумма его превышает, весь акт не сохраняется (413) и
        правки пользователя теряются. max_request_size — общий с доменом
        chat лимит, его НЕЛЬЗЯ поднимать под картинки; согласовываем в
        обратную сторону — бюджет картинок должен быть заведомо меньше.

        1_500_000 байт — резерв на data-URL-префиксы каждой картинки и
        не-картиночное тело акта (дерево/таблицы/текстблоки).
        """
        images = ImagesSettings()
        security = SecuritySettings()
        assert (
            images.max_total_size_per_act * 4 // 3 + 1_500_000
            <= security.max_request_size
        )
        assert images.max_file_size * 4 // 3 <= security.max_request_size

    def test_mime_whitelist_matches_schema_url_whitelist(self):
        """MIME-whitelist настроек согласован с regex-whitelist'ом схемы url."""
        from app.domains.acts.schemas.act_content import _image_data_url_re
        s = ImagesSettings()
        rx = _image_data_url_re(tuple(s.allowed_mime_types))
        for mime in s.allowed_mime_types:
            subtype = mime.split("/", 1)[1]
            assert rx.match(f"data:image/{subtype};base64,AAAA"), (
                f"MIME {mime} разрешён настройками, но отбивается схемой url"
            )


# ── Tables/Textblocks settings: дефолты + пин против фолбэк-констант схемы ────


class TestStructureSettingsDefaults:
    """Дефолты границ таблиц/текстблоков и их согласованность со схемой."""

    def test_tables_defaults(self):
        s = TablesSettings()
        assert s.max_rows == 64
        assert s.max_cols == 16
        assert s.min_col_width_px == 80
        assert s.per_node == 10

    def test_textblocks_defaults(self):
        s = TextblocksSettings()
        assert s.font_size_min == 8
        assert s.font_size_max == 72
        # UI-потолок глубины списков редактора (0-based: 4 — пятый уровень).
        assert s.max_list_level == 4

    def test_max_list_level_bounded_by_ooxml_limit(self):
        """Настройка не может выйти за 9 уровней w:abstractNum (ilvl 0..8)."""
        assert TextblocksSettings(max_list_level=8).max_list_level == 8
        for bad in (0, 9, -1):
            with pytest.raises(ValidationError):
                TextblocksSettings(max_list_level=bad)

    def test_violations_defaults(self):
        s = ViolationsSettings()
        assert s.per_node == 10

    def test_acts_settings_includes_tables_and_textblocks(self):
        s = ActsSettings()
        assert isinstance(s.tables, TablesSettings)
        assert isinstance(s.textblocks, TextblocksSettings)
        assert isinstance(s.violations, ViolationsSettings)

    def test_settings_defaults_match_schema_fallbacks(self):
        """Дефолты настроек == фолбэк-константы схемы (не должны разъезжаться)."""
        t = TablesSettings()
        tb = TextblocksSettings()
        assert t.max_rows == TABLE_MAX_ROWS
        assert t.max_cols == TABLE_MAX_COLS
        assert tb.font_size_min == FONT_SIZE_MIN
        assert tb.font_size_max == FONT_SIZE_MAX
        assert ImagesSettings().max_items_per_violation == VIOLATION_CONTENT_ITEMS_MAX


# ── GET /api/v1/acts/limits ─────────────────────────────────────────────────


def _build_app() -> FastAPI:
    """Все acts-роутеры в боевом порядке get_api_routers().

    Порядок важен: литеральный маршрут /limits обязан регистрироваться
    раньше GET /{act_id} (int) из management-роутера — иначе "limits"
    уходит в int-конвертацию act_id и даёт 422 без fallthrough.
    """
    app = FastAPI()
    for router, prefix, _tags in get_api_routers():
        app.include_router(router, prefix=f"/api/v1{prefix}")
    app.dependency_overrides[get_username] = lambda: USERNAME
    app.dependency_overrides[_get_acts_settings] = lambda: ActsSettings()
    return app


class TestActsLimitsEndpoint:
    """E2E: эндпоинт лимитов контента актов."""

    def test_returns_images_limits_and_schema_bounds(self):
        app = _build_app()
        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/limits")

        assert resp.status_code == 200, resp.text
        body = resp.json()

        assert body["images"] == {
            "max_file_size": 4 * 1024 * 1024,
            "max_total_size_per_act": 5 * 1024 * 1024,
            "allowed_mime_types": [
                "image/jpeg", "image/png", "image/gif",
            ],
            "max_items_per_violation": 50,
            "image_max_height_percent": 40,
        }
        # Границы таблиц/шрифта — из настроек ACTS__TABLES__/TEXTBLOCKS__
        assert body["tables"] == {
            "max_rows": TABLE_MAX_ROWS,
            "max_cols": TABLE_MAX_COLS,
            "min_col_width_px": 80,
            "per_node": 10,
        }
        assert body["textblocks"] == {
            "font_size_min": FONT_SIZE_MIN,
            "font_size_max": FONT_SIZE_MAX,
            "font_size_default": 12,
            "per_node": 10,
            "max_list_level": 4,
        }
        # #7: лимит нарушений на узел — из настроек ACTS__VIOLATIONS__
        assert body["violations"] == {"per_node": 10}
        # Фактические значения границ (пин против случайной правки дефолтов)
        assert body["tables"] == {
            "max_rows": 64, "max_cols": 16, "min_col_width_px": 80, "per_node": 10,
        }
        assert body["textblocks"] == {
            "font_size_min": 8, "font_size_max": 72, "font_size_default": 12, "per_node": 10,
            "max_list_level": 4,
        }
        # B-5: секция sanitizer — единый allowlist фронт↔бэк.
        assert set(body["sanitizer"]) == {
            "allowed_tags", "allowed_css_properties", "allowed_data_attrs",
        }

    def test_limits_reflect_settings_override(self):
        """Эндпоинт отдаёт значения из настроек (config/env), не хардкод."""
        app = FastAPI()
        for router, prefix, _tags in get_api_routers():
            app.include_router(router, prefix=f"/api/v1{prefix}")
        app.dependency_overrides[get_username] = lambda: USERNAME
        app.dependency_overrides[_get_acts_settings] = lambda: ActsSettings(
            tables=TablesSettings(max_rows=100, max_cols=20, min_col_width_px=50, per_node=7),
            textblocks=TextblocksSettings(
                font_size_min=6, font_size_max=96, font_size_default=24, max_list_level=2,
            ),
            violations=ViolationsSettings(per_node=4),
            images=ImagesSettings(max_items_per_violation=80),
        )
        with TestClient(app) as client:
            body = client.get("/api/v1/acts/limits").json()
        assert body["tables"] == {
            "max_rows": 100, "max_cols": 20, "min_col_width_px": 50, "per_node": 7,
        }
        assert body["textblocks"] == {
            "font_size_min": 6, "font_size_max": 96, "font_size_default": 24, "per_node": 10,
            "max_list_level": 2,
        }
        assert body["violations"] == {"per_node": 4}
        assert body["images"]["max_items_per_violation"] == 80

    def test_limits_not_shadowed_by_act_id_route(self):
        """Регрессия порядка роутеров: /limits не перехвачен /{act_id}."""
        app = _build_app()
        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/limits")
        # 422 означал бы int-парсинг "limits" как act_id
        assert resp.status_code != 422
        assert resp.status_code == 200

    def test_limits_includes_editor_telemetry_flag(self):
        """§6.8: kill-switch телеметрии редактора отдаётся фронту (дефолт true)."""
        app = _build_app()
        with TestClient(app) as client:
            body = client.get("/api/v1/acts/limits").json()
        assert body["editor_telemetry_enabled"] is True

    def test_editor_telemetry_flag_reflects_settings(self):
        """Флаг телеметрии отражает настройку ACTS__EDITOR_TELEMETRY_ENABLED."""
        app = FastAPI()
        for router, prefix, _tags in get_api_routers():
            app.include_router(router, prefix=f"/api/v1{prefix}")
        app.dependency_overrides[get_username] = lambda: USERNAME
        app.dependency_overrides[_get_acts_settings] = lambda: ActsSettings(
            editor_telemetry_enabled=False,
        )
        with TestClient(app) as client:
            body = client.get("/api/v1/acts/limits").json()
        assert body["editor_telemetry_enabled"] is False
