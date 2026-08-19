"""
Настройки домена актов.

Содержит все доменные настройки, которые загружаются через
ACTS__* префикс в .env файле.
"""

from pydantic import BaseModel, Field, field_validator


class LockSettings(BaseModel):
    """
    Параметры блокировок и контроля активности пользователя.

    Механизм работы:
    1. При открытии акта сервер ставит эксклюзивную блокировку на duration_minutes.
    2. Фронтенд каждые inactivity_check_interval_seconds проверяет,
       двигал ли пользователь мышь / нажимал клавиши / скроллил.
    3. Если пользователь активен и с последнего продления прошло ≥ min_extension_interval_minutes,
       фронтенд автоматически продлевает блокировку на сервере.
    4. Если пользователь бездействует ≥ inactivity_timeout_minutes,
       появляется диалог «Продолжить работу?» с обратным отсчётом.
    5. Если пользователь не отвечает за inactivity_dialog_timeout_seconds —
       контент автосохраняется, блокировка снимается, происходит редирект на список актов.
    """
    duration_minutes: int = Field(default=15, gt=0)
    inactivity_timeout_minutes: float = Field(default=5.0, gt=0)
    inactivity_check_interval_seconds: int = Field(default=30, gt=0)
    min_extension_interval_minutes: float = Field(default=5.0, gt=0)
    inactivity_dialog_timeout_seconds: int = Field(default=15, gt=0)


class AutosaveSettings(BaseModel):
    """Настройки автосохранения черновика акта в браузере."""
    period_seconds: int = Field(default=3, gt=0, description="Период дебаунса автосохранения в localStorage, сек")


class FormattingSettings(BaseModel):
    """Параметры форматирования документов."""
    # DOCX
    max_image_size_mb: float = 10.0
    docx_image_width: float = 4.0
    docx_max_heading_level: int = 9
    # Text
    text_header_width: int = 80
    text_indent_size: int = 2
    # Markdown
    markdown_max_heading_level: int = 6
    # HTML parsing
    html_parse_timeout: int = Field(default=30, gt=0)
    max_html_depth: int = 100
    html_parse_chunk_size: int = Field(default=1000, gt=0)
    # Retry
    max_retries: int = Field(default=3, gt=0)
    retry_delay: float = Field(default=0.5, ge=0)


class ResourceSettings(BaseModel):
    """Параметры управления ресурсами."""
    max_concurrent_file_operations: int = Field(default=100, gt=0)
    save_operation_timeout: int = Field(default=300, gt=0)
    save_act_timeout: int = 300
    max_tree_depth: int = 50


class InvoiceSettings(BaseModel):
    """
    Настройки фактур.

    Имена справочных таблиц (metric_dict, process_dict, subsidiary_dict)
    берутся из домена ua_data. Колонки захардкожены — они часть схемы таблиц.
    """
    hive_schema: str = Field(default="team_sva_oarb_3")
    gp_schema: str = Field(default="s_grnplm_ld_audit_da_sandbox_oarb")
    hive_registry_schema: str = Field(default="s_grnplm_ld_audit_project_4")
    hive_registry_table: str = Field(default="t_db_oarb_ua_hadoop_tables")

    @field_validator(
        'hive_schema', 'gp_schema', 'hive_registry_schema',
        'hive_registry_table',
    )
    @classmethod
    def validate_sql_identifiers(cls, v: str) -> str:
        """Проверяет что значение является безопасным SQL-идентификатором."""
        from app.db.utils.sql_utils import validate_sql_identifier
        if not validate_sql_identifier(v):
            raise ValueError(f"Небезопасный SQL-идентификатор в настройках: {v!r}")
        return v


class AuditLogSettings(BaseModel):
    """Параметры аудит-лога и версионирования."""
    retention_days: int = Field(default=365, gt=0)
    max_content_versions: int = Field(default=50, gt=0)
    max_diff_elements: int = Field(default=20, gt=0)
    max_diff_cells_per_table: int = Field(default=50, gt=0)


class ImagesSettings(BaseModel):
    """
    Лимиты картинок нарушений (inline data-URL в дополнительном контенте).

    Фронт читает их через GET /acts/limits и валидирует файлы ДО
    кодирования в base64. Жёсткий серверный потолок длины data-URL —
    константа VIOLATION_IMAGE_URL_MAX_LENGTH в schemas/act_content.py;
    она обязана быть заведомо выше max_file_size с учётом
    base64-оверхеда (×4/3 + префикс).

    Пороги согласованы с SecuritySettings.max_request_size (общий с доменом
    chat лимит тела HTTP-запроса, который сам НЕ поднимаем): дефолты — сырые
    (pre-base64) байты, а на провод внутри JSON акта уходит base64 (+×4/3).
    Инвариант — tests/domains/acts/test_acts_limits_api.py::
    test_image_budgets_fit_in_http_request_size_limit.
    """
    max_file_size: int = Field(default=4 * 1024 * 1024, gt=0)
    max_total_size_per_act: int = Field(default=5 * 1024 * 1024, gt=0)
    # webp исключён сознательно: python-docx (без Pillow) не встраивает его
    # в DOCX — картинка молча расходилась бы между превью и экспортом.
    allowed_mime_types: list[str] = Field(
        default=["image/jpeg", "image/png", "image/gif"]
    )
    max_items_per_violation: int = Field(default=50, gt=0)
    # Потолок высоты картинки нарушения (% полезной высоты листа A4). Управляет
    # и превью (maxHeight), и DOCX-экспортом (_scale_picture, #13).
    image_max_height_percent: int = Field(default=40, gt=0, le=100)


class TablesSettings(BaseModel):
    """
    Жёсткие границы таблиц (grid) — защита от исчерпания памяти.

    Единый источник для серверной схемы (act_content.py читает их в
    валидаторах), эндпоинта GET /acts/limits и фронт-гейтов вставки
    строк/колонок. Дефолты обязаны совпадать с фолбэк-константами схемы
    (TABLE_MAX_ROWS/TABLE_MAX_COLS).
    """
    max_rows: int = Field(default=64, gt=0)
    max_cols: int = Field(default=16, gt=0)
    min_col_width_px: int = Field(default=80, gt=0)
    # Максимальное число таблиц-детей одного узла дерева (#7). Фронт ограничивает
    # добавление таблиц узлу, но paste/drag/undo и прямой API проверку обходили —
    # серверный гейт в ActContentService._validate_tree. Считаются ВСЕ таблицы,
    # включая закреплённые metrics/risk (паритет с фронт-гейтом добавления).
    # Отдаётся через GET /acts/limits (tables.per_node).
    per_node: int = Field(default=10, gt=0)


class ViolationsSettings(BaseModel):
    """
    Лимит нарушений-детей одного узла дерева (#7).

    Фронт ограничивает добавление нарушений узлу, но paste/drag/undo и прямой
    API проверку обходили — серверный гейт в ActContentService._validate_tree.
    Отдаётся через GET /acts/limits (violations.per_node).
    """
    per_node: int = Field(default=10, gt=0)


class TextblocksSettings(BaseModel):
    """
    Границы форматирования текстблоков (размер шрифта редактора).

    Единый источник границ размера шрифта и глубины списков для GET /acts/limits
    и фронт-тулбара (кламп размера в дропдауне, потолок «Уровень глубже»).
    Дефолты границ совпадают с фолбэками схемы (FONT_SIZE_MIN/FONT_SIZE_MAX).

    Размер шрифта задаётся в ПУНКТАХ (pt) — и границы, и базовое значение:
    число, выбранное в тулбаре, попадает в Word как есть, без конвертации.
    """
    font_size_min: int = Field(default=8, gt=0)
    font_size_max: int = Field(default=72, gt=0)
    # Базовый размер текстблока в пунктах — единый для редактора, превью
    # (через /acts/limits) и DOCX-экспорта.
    font_size_default: int = Field(default=12, gt=0)
    # Максимальное число текстблоков-детей одного узла дерева (B-13). Фронт
    # ограничивает добавление блоков узлу, но прямой API эту проверку обходил —
    # серверный гейт в ActContentService._validate_tree. Отдаётся через
    # GET /acts/limits (textblocks.per_node).
    per_node: int = Field(default=10, gt=0)
    # Потолок глубины вложенности списков в редакторе (0-based: 4 — пятый
    # уровень). Это UI-граница — глубже не уводят ни Tab, ни пункт меню
    # «Уровень глубже» (гейт execCommand читает значение через /acts/limits).
    # le=8 — жёсткий предел формата: w:abstractNum в OOXML описывает 9 уровней,
    # и DOCX-экспорт клампит на ilvl 8 независимо от этой настройки.
    max_list_level: int = Field(default=4, gt=0, le=8)


class SanitizerSettings(BaseModel):
    """
    Allowlist HTML-санитайзера контента актов — ЕДИНЫЙ ИСТОЧНИК для bleach
    (бэк) и DOMPurify (фронт). Раньше списки дублировались в
    html_sanitizer.py и static/js/shared/sanitize.js и синхронизировались
    вручную (B-5). Теперь: bleach читает их в рантайме, фронт — через
    GET /acts/limits (секция sanitizer). Дефолты обязаны совпадать с
    фолбэк-константами html_sanitizer.py.
    """
    # Разрешённые теги (whitelist). javascript:-протоколы и on*-атрибуты
    # фильтрует bleach/DOMPurify независимо от этого списка.
    allowed_tags: list[str] = Field(default=[
        "p", "br", "b", "strong", "i", "em", "u", "s", "strike", "del", "span", "a",
        "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "div",
    ])
    # Разрешённые CSS-свойства inline-style.
    allowed_css_properties: list[str] = Field(default=[
        "font-size", "color", "background-color",
        "font-weight", "font-style", "text-decoration", "text-decoration-line",
        # TB-1: per-line выравнивание живёт в style блочных элементов content.
        "text-align",
    ])
    # Разрешённые data-атрибуты span (сноски/ссылки) — без них DOCX-экспорт
    # теряет содержимое сносок/ссылок.
    allowed_data_attrs: list[str] = Field(default=[
        "data-footnote-id", "data-footnote-text",
        "data-link-id", "data-link-url",
    ])


class ActsSettings(BaseModel):
    """Корневая модель настроек домена актов."""
    lock: LockSettings = LockSettings()
    autosave: AutosaveSettings = AutosaveSettings()
    formatting: FormattingSettings = FormattingSettings()
    resource: ResourceSettings = ResourceSettings()
    invoice: InvoiceSettings = InvoiceSettings()
    audit_log: AuditLogSettings = AuditLogSettings()
    images: ImagesSettings = ImagesSettings()
    tables: TablesSettings = TablesSettings()
    textblocks: TextblocksSettings = TextblocksSettings()
    violations: ViolationsSettings = ViolationsSettings()
    sanitizer: SanitizerSettings = SanitizerSettings()
    # Kill-switch телеметрии здоровья редактора (§6.8). Выключено → эндпоинт
    # /acts/editor-telemetry отвечает 204 без записи, а фронт (получив флаг
    # через GET /acts/limits) перестаёт слать батчи.
    editor_telemetry_enabled: bool = Field(default=True)
