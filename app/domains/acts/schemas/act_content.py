"""
Pydantic схемы для валидации данных актов.

Определяет структуру данных для всех элементов акта:
таблицы, текстовые блоки, нарушения и древовидную структуру.
"""

import re
from functools import lru_cache
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.domains.acts.block_types import LEAF_BLOCK_REFS

# Фолбэк-дефолты границ таблиц и шрифта текстблоков. Единый ИСТОЧНИК ИСТИНЫ —
# настройки (ACTS__TABLES__* / ACTS__TEXTBLOCKS__*, см. settings.py); схема и
# эндпоинт GET /acts/limits читают их в рантайме (_acts_settings). Константы
# ниже используются только когда реестр настроек ещё не заполнен (импорт-тайм,
# юнит-тесты) и обязаны совпадать с дефолтами settings (пин — тест
# test_settings_defaults_match_schema_fallbacks).
TABLE_MAX_ROWS = 64
TABLE_MAX_COLS = 16
FONT_SIZE_MIN = 8
FONT_SIZE_MAX = 72

# Лимиты картинок нарушений (4.3.M.2 + 5.2.2). Лимит длины url — константа:
# схема статична и не может читать настройки. Инвариант согласованности:
# константа обязана быть заведомо выше ACTS__IMAGES__MAX_FILE_SIZE с учётом
# base64-оверхеда (×4/3 + префикс data:image/...;base64,): 10 МБ файла
# ≈ 14 млн символов data-URL < 15 млн. Пин — тест
# test_url_max_length_covers_max_file_size_in_base64.
VIOLATION_IMAGE_URL_MAX_LENGTH = 15_000_000
# Фолбэк-дефолт числа элементов нарушения. ИСТОЧНИК ИСТИНЫ —
# ACTS__IMAGES__MAX_ITEMS_PER_VIOLATION (валидатор validate_items_count читает
# его в рантайме); константа — только для импорт-тайма/тестов.
VIOLATION_CONTENT_ITEMS_MAX = 50

# Whitelist data-URL картинок. ИСТОЧНИК ИСТИНЫ форматов —
# ACTS__IMAGES__ALLOWED_MIME_TYPES (settings.py): и валидатор схемы
# (_image_data_url_re), и DOCX-builder нарушений
# (formatters/docx/builders/violation.py через image_data_url_pattern())
# выводят regex из ОДНОГО списка настроек — whitelist не разъезжается между
# валидацией и сборкой DOCX. IMAGE_DATA_URL_PATTERN/_IMAGE_DATA_URL_RE ниже —
# фолбэк-дефолт (растровые png/jpeg/gif; без SVG — XSS; без webp — python-docx
# его не встраивает) для импорт-тайма/тестов.
IMAGE_DATA_URL_PATTERN = r"data:image/(?:png|jpe?g|gif);base64,"
_IMAGE_DATA_URL_RE = re.compile("^" + IMAGE_DATA_URL_PATTERN)


def _acts_settings():
    """ActsSettings из реестра; на старте/в тестах (реестр пуст) — дефолты.

    Ленивый импорт: схема импортируется задолго до discover_domains, а реестр
    заполняется на старте. Валидаторы вызываются на парсинге запроса (реестр
    уже жив), поэтому читать настройки внутри валидатора безопасно.
    """
    try:
        from app.core.settings_registry import get as _get
        from app.domains.acts import DOMAIN_NAME
        from app.domains.acts.settings import ActsSettings
        return _get(DOMAIN_NAME, ActsSettings)
    except Exception:
        from app.domains.acts.settings import ActsSettings
        return ActsSettings()


@lru_cache(maxsize=8)
def _image_data_url_body(mime_types: tuple[str, ...]) -> str:
    """Строит тело regex whitelist'а data:image-URL из списка MIME настроек.

    `image/jpeg`/`image/jpg` → алиас `jpe?g` (браузеры эмитят и `jpg`).
    Прочие — экранированный подтип. Кэш по кортежу MIME.
    """
    subtypes: set[str] = set()
    for mime in mime_types:
        if not mime.startswith("image/"):
            continue
        sub = mime.split("/", 1)[1].strip().lower()
        if sub in ("jpeg", "jpg"):
            subtypes.add("jpe?g")
        elif sub:
            subtypes.add(re.escape(sub))
    if not subtypes:
        # Пустой whitelist — не матчим ничего (валидатор отвергнет любой url).
        return r"(?!x)x"
    return r"data:image/(?:" + "|".join(sorted(subtypes)) + r");base64,"


@lru_cache(maxsize=8)
def _image_data_url_re(mime_types: tuple[str, ...]) -> re.Pattern:
    """Компилированный whitelist data:image-URL для текущих MIME настроек."""
    return re.compile("^" + _image_data_url_body(mime_types))


def image_data_url_pattern() -> str:
    """Тело regex whitelist'а data:image-URL из настроек (без якорей).

    Единый источник формата для валидатора схемы (`validate_image_url`) и
    DOCX-builder'а нарушений (`formatters/docx/builders/violation.py`).
    """
    return _image_data_url_body(tuple(_acts_settings().images.allowed_mime_types))

# Подвиды таблиц (enum kind). 'regular' — обычная таблица (дефолт/отсутствие
# подвида). Единый источник значений на бэке; СИНХРОНИЗИРУЕТСЯ ВРУЧНУЮ с
# фронтом (static/js/constructor/table/table-kind.js, TABLE_KINDS) и с
# CHECK-констрейнтом check_table_kind_values в миграциях
# (app/domains/acts/migrations/{postgresql,greenplum}/schema.sql).
TABLE_KINDS = (
    "regular",
    "metrics",
    "mainMetrics",
    "regularRisk",
    "operationalRisk",
    "taxRisk",
    "otherRisk",
)

# Literal статичен сознательно (Literal из переменных капризен для type
# checker'ов). Соответствие TABLE_KINDS пинит
# test_table_kind_roundtrip.py::test_table_kind_literal_matches_tuple.
TableKind = Literal[
    "regular", "metrics", "mainMetrics", "regularRisk",
    "operationalRisk", "taxRisk", "otherRisk",
]


class TableCellSchema(BaseModel):
    """
    Схема ячейки таблицы с матричной структурой.

    M.20: extra='forbid' — состав полей зеркалит фронтовый
    _serializeTables (state-core.js); неизвестное поле = рассинхрон
    контракта и отбивается 422, а не теряется молча.

    Attributes:
        content: Содержимое ячейки
        isHeader: Является ли ячейка заголовком
        colSpan: Количество объединенных колонок (минимум 1)
        rowSpan: Количество объединенных строк (минимум 1)
        isSpanned: Является ли ячейка частью объединения
        spanOrigin: Координаты главной ячейки объединения
        originRow: Исходная строка ячейки
        originCol: Исходная колонка ячейки
    """
    model_config = ConfigDict(extra="forbid")

    content: str = Field(default="", description="Содержимое ячейки")
    isHeader: bool = Field(default=False, description="Заголовок")
    # Верхняя граница span'ов — по лимиту колонок/строк из настроек; проверяется
    # в TableSchema.validate_grid_dimensions (по живым настройкам), не Field-ом.
    colSpan: int = Field(
        default=1, ge=1,
        description="Число объединённых колонок (≥1, потолок — по лимиту колонок таблицы)"
    )
    rowSpan: int = Field(
        default=1, ge=1,
        description="Число объединённых строк (≥1, потолок — по лимиту строк таблицы)"
    )
    isSpanned: bool = Field(default=False, description="Часть объединения")
    spanOrigin: dict[str, int] | None = Field(default=None, description="Координаты главной ячейки")
    originRow: int | None = Field(default=None, ge=0, description="Исходная строка")
    originCol: int | None = Field(default=None, ge=0, description="Исходная колонка")


class TableSchema(BaseModel):
    """
    Схема таблицы с матричной структурой.

    Добавлены лимиты на размер grid (макс 64 строки, 16 колонок)
    для защиты от исчерпания памяти.

    Attributes:
        id: Уникальный идентификатор таблицы
        nodeId: ID узла дерева
        grid: Матрица ячеек (двумерный массив, макс 64×16)
        colWidths: Массив относительных весов ширины колонок (целые > 0; нормируются по сумме)
        protected: Защищена ли таблица от перемещения и изменения структуры
        deletable: Можно ли удалить таблицу (работает независимо от protected)
        kind: Подвид таблицы (TABLE_KINDS); 'regular' — обычная таблица
    """
    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="ID таблицы")
    nodeId: str = Field(description="ID узла дерева")
    grid: list[list[TableCellSchema]] = Field(
        default_factory=list,
        description="Матрица ячеек (потолок строк/колонок — по настройкам ACTS__TABLES__*)",
    )
    colWidths: list[int] = Field(
        default_factory=list,
        description="Относительные веса ширины колонок (целые > 0; нормируются по сумме)",
    )
    protected: bool = Field(
        default=False,
        description="Защита от перемещения и изменения структуры"
    )
    deletable: bool = Field(
        default=True,
        description="Разрешено ли удаление таблицы"
    )

    # Подвид таблицы: enum взаимоисключающ по построению (заменил 6 булевых
    # флагов is*Table и валидатор «не более одного типа»).
    kind: TableKind = Field(
        default="regular",
        description="Подвид таблицы (метрики / риски); 'regular' — обычная"
    )

    @field_validator("grid")
    @classmethod
    def validate_grid_dimensions(cls, v: list[list[TableCellSchema]]) -> list[list[TableCellSchema]]:
        """
        Проверяет размеры матрицы и span'ы ячеек по лимитам из настроек.

        Потолки строк/колонок берутся из ACTS__TABLES__* (settings.py), а не
        из статических констант — env реально меняет лимит по всей цепочке.

        Raises:
            ValueError: Если превышен лимит строк/колонок или span ячейки.
        """
        if not v:
            return v

        tables = _acts_settings().tables
        max_rows, max_cols = tables.max_rows, tables.max_cols

        if len(v) > max_rows:
            raise ValueError(
                f"Таблица содержит {len(v)} строк, максимум допустимо {max_rows}"
            )

        for row_idx, row in enumerate(v):
            if len(row) > max_cols:
                raise ValueError(
                    f"Строка {row_idx} содержит {len(row)} колонок, "
                    f"максимум допустимо {max_cols}"
                )
            for cell in row:
                if cell.colSpan > max_cols:
                    raise ValueError(
                        f"colSpan ячейки ({cell.colSpan}) превышает лимит колонок ({max_cols})"
                    )
                if cell.rowSpan > max_rows:
                    raise ValueError(
                        f"rowSpan ячейки ({cell.rowSpan}) превышает лимит строк ({max_rows})"
                    )

        return v

    @field_validator("colWidths")
    @classmethod
    def validate_col_widths(cls, v: list[int]) -> list[int]:
        """
        Проверяет положительность ширин и их число (по лимиту колонок настроек).

        Raises:
            ValueError: Если есть неположительные ширины или их больше лимита колонок.
        """
        max_cols = _acts_settings().tables.max_cols
        if len(v) > max_cols:
            raise ValueError(
                f"Число ширин колонок ({len(v)}) превышает лимит ({max_cols})"
            )
        if any(width <= 0 for width in v):
            raise ValueError("Ширины колонок должны быть положительными")
        return v

    @model_validator(mode="after")
    def validate_structure(self) -> "TableSchema":
        """
        Проверяет структурную целостность таблицы (A2, A3, R6).

        Сообщения на русском и указывают КУДА смотреть пользователю:
        1. прямоугольность матрицы (все строки одной длины);
        2. число ширин колонок: при несовпадении с числом колонок длина
           colWidths НОРМАЛИЗУЕТСЯ (усечение/добивка весом 100, а не
           отклоняется) — билдер делит ширину по весам;
        3. объединения ячеек не выходят за границы матрицы (закрывает
           IndexError в DOCX-builder'е);
        4. объединения не пересекаются — покрытия двух origin-ячеек не
           накладываются (закрывает крэш DOCX-builder'а на наложении merge).

        Взаимоисключение подвидов таблицы НЕ проверяется: поле kind —
        enum, взаимоисключающ по построению.

        СОЗНАТЕЛЬНО НЕ проверяется когерентность spanOrigin и пометка
        поглощённых ячеек isSpanned: легаси-операции вставки/удаления колонок
        и строк оставляют инертный устаревший spanOrigin, который и билдер
        (читает только isSpanned), и сервер игнорируют. Проверять его — ложная
        тревога.

        Returns:
            Сам объект (валидация after-режима; длина colWidths может быть
            нормализована под число колонок).

        Raises:
            ValueError: При нарушении любого инварианта (→ HTTP 422).
        """
        rows = len(self.grid)
        cols = len(self.grid[0]) if rows else 0

        # 1. Прямоугольность: все строки одной длины (пустую матрицу пропускаем).
        if rows:
            for i, row in enumerate(self.grid):
                if len(row) != cols:
                    raise ValueError(
                        f"Строки таблицы имеют разную длину: строка {i} содержит "
                        f"{len(row)} ячеек вместо {cols}"
                    )

        # 2. Число ширин = число колонок. При несовпадении нормализуем длину
        #    (усечение/добивка дефолтным весом 100), сохраняя префикс заданных
        #    пользователем пропорций; билдер делит ширину по весам.
        if self.colWidths and rows and len(self.colWidths) != cols:
            if len(self.colWidths) > cols:
                self.colWidths = self.colWidths[:cols]
            else:
                self.colWidths = self.colWidths + [100] * (cols - len(self.colWidths))

        # 3. Объединения в пределах границ матрицы.
        for r, row in enumerate(self.grid):
            for c, cell in enumerate(row):
                if cell.colSpan > 1 or cell.rowSpan > 1:
                    if r + cell.rowSpan > rows or c + cell.colSpan > cols:
                        raise ValueError(
                            f"Объединение ячейки ({r},{c}) выходит за границы таблицы"
                        )

        # 4. Объединения не пересекаются. Строим coverage-матрицу из покрытий
        #    origin-ячеек (не isSpanned, со span>1); пересечение покрытий двух
        #    origin-ов роняет DOCX-builder. spanOrigin поглощённых НЕ читаем.
        coverage: list[list[tuple[int, int] | None]] = [
            [None] * cols for _ in range(rows)
        ]
        for r, row in enumerate(self.grid):
            for c, cell in enumerate(row):
                if cell.isSpanned:
                    continue
                if cell.colSpan == 1 and cell.rowSpan == 1:
                    continue
                for rr in range(r, r + cell.rowSpan):
                    for cc in range(c, c + cell.colSpan):
                        if coverage[rr][cc] is not None:
                            raise ValueError(
                                f"Объединения пересекаются в ячейке ({rr},{cc})"
                            )
                        coverage[rr][cc] = (r, c)

        return self


class TextBlockSchema(BaseModel):
    """
    Схема текстового блока.

    Форматирование целиком живёт в inline-HTML поля content: начертание —
    теги <b>/<i>/<u>, выравнивание — text-align блочных элементов, размер —
    span'ы с font-size (базовый размер — единый дефолт настроек, не хранится
    per-block). Прежний контейнерный объект formatting вырезан (директива
    владельца): он писался только при создании блока и правками не обновлялся.

    Attributes:
        id: Уникальный идентификатор текстового блока
        nodeId: ID узла дерева, к которому привязан блок
        content: HTML-содержимое блока с inline-форматированием
    """
    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="ID текстового блока")
    nodeId: str = Field(description="ID узла дерева")
    content: str = Field(default="", description="HTML-содержимое")


class ViolationDescriptionListSchema(BaseModel):
    """Схема списка описаний нарушения."""
    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    items: list[str] = Field(default_factory=list)


class ViolationOptionalFieldSchema(BaseModel):
    """
    Схема опционального текстового поля нарушения.

    Используется для причин, принятых мер, последствий,
    ответственных лиц и др.
    """
    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    content: str = ""


class ViolationContentItemSchema(BaseModel):
    """
    Универсальный элемент дополнительного контента.

    Attributes:
        id: Уникальный идентификатор элемента
        type: Тип элемента
        content: Текстовое содержимое (для case и freeText)
        url: URL изображения (для image)
        caption: Подпись изображения (для image)
        filename: Имя файла (для image)
        width: Ширина изображения в процентах полезной ширины страницы
    """
    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="ID элемента")
    type: Literal["case", "image", "freeText"] = Field(description="Тип элемента")
    content: str = Field(default="", description="Текстовое содержимое")
    url: str = Field(default="", description="URL изображения")
    caption: str = Field(default="", description="Подпись изображения")
    filename: str = Field(default="", description="Имя файла")
    width: int = Field(
        default=0, ge=0, le=100,
        description="Ширина изображения, % полезной ширины страницы (0 — авто)",
    )

    @model_validator(mode="after")
    def validate_image_url(self) -> "ViolationContentItemSchema":
        """
        Валидирует url картинки (4.3.M.2 + 5.2.2).

        Для type='image' непустой url обязан быть data:image-URL разрешённого
        растрового формата (png/jpeg/gif, base64) — отсекает
        javascript:/data:text-схемы (XSS) и не-картинки. Пустая строка
        допустима (черновик без содержимого). Лимит длины защищает БД и
        снимки версий от многомегабайтных payload'ов.
        """
        if len(self.url) > VIOLATION_IMAGE_URL_MAX_LENGTH:
            raise ValueError(
                f"Размер изображения превышает допустимый лимит "
                f"({VIOLATION_IMAGE_URL_MAX_LENGTH} символов data-URL). "
                f"Уменьшите изображение."
            )
        if self.type == "image" and self.url:
            mime_types = tuple(_acts_settings().images.allowed_mime_types)
            if not _image_data_url_re(mime_types).match(self.url):
                allowed = ", ".join(
                    m.split("/", 1)[1] for m in mime_types if m.startswith("image/")
                )
                raise ValueError(
                    "Изображение нарушения должно быть встроенным data:image-URL "
                    f"разрешённого формата ({allowed or 'нет'}, base64)."
                )
        return self


class ViolationAdditionalContentSchema(BaseModel):
    """Коллекция дополнительного контента нарушения."""
    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    items: list[ViolationContentItemSchema] = Field(default_factory=list)

    @field_validator("items")
    @classmethod
    def validate_items_count(
        cls, v: list[ViolationContentItemSchema],
    ) -> list[ViolationContentItemSchema]:
        """Ограничивает число элементов доп. контента (лимит — из настроек)."""
        max_items = _acts_settings().images.max_items_per_violation
        if len(v) > max_items:
            # №14: текст синхронизирован ВРУЧНУЮ с фронтом (единая точка —
            # AppConfig.content.errors.contentItemsLimitReached,
            # static/js/shared/app-config.js) — должен совпадать дословно
            # (прецедент синхронизации — names.py ↔ chat-client-actions.js).
            raise ValueError(
                f"Достигнут лимит элементов дополнительного контента на нарушение ({max_items})."
            )
        return v


class ViolationSchema(BaseModel):
    """
    Схема нарушения со всеми полями.

    Attributes:
        id: Уникальный идентификатор нарушения
        nodeId: ID узла дерева, к которому привязано нарушение
        violated: Текст для секции 'Нарушено'
        established: Текст для секции 'Установлено'
        descriptionList: Список описаний нарушения
        additionalContent: Дополнительный контент
        reasons: Причины нарушения
        measures: Принятые меры
        consequences: Последствия нарушения
        responsible: Ответственные лица
    """
    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="ID нарушения")
    nodeId: str = Field(description="ID узла дерева")
    violated: str = Field(default="", description="Текст для 'Нарушено'")
    established: str = Field(default="", description="Текст для 'Установлено'")
    descriptionList: ViolationDescriptionListSchema = Field(
        default_factory=ViolationDescriptionListSchema,
        description="Список описаний"
    )
    additionalContent: ViolationAdditionalContentSchema = Field(
        default_factory=ViolationAdditionalContentSchema,
        description="Дополнительный контент"
    )
    reasons: ViolationOptionalFieldSchema = Field(
        default_factory=ViolationOptionalFieldSchema,
        description="Причины"
    )
    measures: ViolationOptionalFieldSchema = Field(
        default_factory=ViolationOptionalFieldSchema,
        description="Принятые меры"
    )
    consequences: ViolationOptionalFieldSchema = Field(
        default_factory=ViolationOptionalFieldSchema,
        description="Последствия"
    )
    responsible: ViolationOptionalFieldSchema = Field(
        default_factory=ViolationOptionalFieldSchema,
        description="Ответственные"
    )


class ActItemSchema(BaseModel):
    """
    Схема пункта акта (рекурсивная структура).

    Представляет узел дерева структуры акта с возможностью
    вложенности и привязки таблиц, текстовых блоков, нарушений.

    Attributes:
        id: Уникальный идентификатор узла
        label: Отображаемый текст узла (номер пункта + название)
        type: Тип узла
        content: Текстовое содержимое пункта
        protected: Защищен ли узел от удаления и перемещения
        deletable: Можно ли удалить узел (работает независимо от protected)
        children: Список дочерних узлов
        tableId: ID привязанной таблицы
        textBlockId: ID привязанного текстового блока
        violationId: ID привязанного нарушения
        customLabel: Пользовательская метка узла
        number: Номер узла в иерархии
        kind: Подвид таблицы узла-таблицы (TABLE_KINDS); 'regular' — обычная
    """
    # M.21: политика extra='ignore' задана ЯВНО и сознательно (не forbid):
    # незадекларированные поля узла отбрасываются нормализацией
    # (validate_tree_structure хранит model_dump()), а не отбиваются 422.
    # Forbid ломал бы restore исторических снимков и серверные узлы
    # перестройки разделов (qa-узел несёт runtime-поле parentId,
    # которое фронтовый exportData не сериализует — известный мусор).
    model_config = ConfigDict(extra="ignore")

    id: str
    # label у корневого узла исторически мог отсутствовать (снимки версий до
    # введения метки). Поле опционально, чтобы валидатор дерева (C4) не
    # отбраковывал легитимные сохранённые снимки; id остаётся обязательным.
    label: str | None = ""
    # Набор типов = реестр app/domains/acts/block_types.py (NODE_TYPES).
    # Literal статичен сознательно: Literal из переменных капризен для
    # type checker'ов. Соответствие пинит test_block_types_guard.py.
    type: Literal["item", "textblock", "violation", "table"] = "item"
    content: str | None = ""
    protected: bool | None = False
    deletable: bool | None = True
    children: list['ActItemSchema'] = Field(default_factory=list)
    tableId: str | None = None
    textBlockId: str | None = None
    violationId: str | None = None
    customLabel: str | None = None
    number: str | None = None
    # Подвид таблицы (узел — источник истины; см. TABLE_KINDS).
    kind: TableKind = "regular"
    tb: list[str] | None = None
    auditPointId: str | None = None


class ActDataSchema(BaseModel):
    """
    Полная схема данных акта.

    Включает древовидную структуру и все связанные сущности
    (таблицы, текстовые блоки, нарушения).

    Attributes:
        tree: Корневой узел дерева структуры акта
        tables: Словарь таблиц (ключ: ID таблицы)
        textBlocks: Словарь текстовых блоков (ключ: ID блока)
        violations: Словарь нарушений (ключ: ID нарушения)
        saveType: Тип сохранения (manual, periodic, auto)
    """
    model_config = ConfigDict(extra="forbid")

    tree: dict = Field(description="Дерево структуры акта")
    tables: dict[str, TableSchema] = Field(
        default_factory=dict,
        description="Таблицы"
    )
    textBlocks: dict[str, TextBlockSchema] = Field(
        default_factory=dict,
        description="Текстовые блоки"
    )
    violations: dict[str, ViolationSchema] = Field(
        default_factory=dict,
        description="Нарушения"
    )
    invoiceNodeIds: list[str] = Field(
        default_factory=list,
        description="ID узлов, у которых есть прикреплённая фактура"
    )
    changelog: list[dict] = Field(
        default_factory=list,
        description="Гранулярный лог локальных изменений"
    )
    saveType: str = Field(
        default="auto",
        pattern=r"^(manual|periodic|auto)$",
        description="Тип сохранения: manual (Ctrl+S), periodic (2мин), auto (debounced)"
    )

    @field_validator("tree")
    @classmethod
    def validate_tree_structure(cls, v: dict) -> dict:
        """
        Валидирует дерево через ActItemSchema и хранит НОРМАЛИЗОВАННЫЙ результат.

        C4/M.21: downstream-консьюмеры (build_audit_point_map, _build_node_map,
        json.dumps(tree), extract_node_number, sanitize_tree_nodes, аудит-лог)
        читают дерево как dict — поэтому тип хранения остаётся dict, но это
        model_dump() от провалидированной ActItemSchema, а не исходный сырой
        dict. Незадекларированные поля узлов при этом отбрасываются (политика
        extra='ignore' схемы узла) — устранена асимметрия со словарями, где
        неизвестные поля терялись через model_dump, а в дереве персистились.
        Битая структура (узел без id и т.п.) поднимает ValueError → HTTP 422.
        """
        return ActItemSchema.model_validate(v).model_dump()

    def collect_dangling_refs(self) -> list[tuple[str | None, str, str]]:
        """
        Собирает висячие ссылки дерево → словари (M.13, решение «lenient»).

        Каждая ссылка узла (tableId/textBlockId/violationId) должна указывать на
        существующую запись словаря. Раньше первая висячая ссылка отбивала весь
        PUT 422 на разборе запроса; теперь обе стороны рассогласования лечатся
        мягко: сервис (ActContentService.save_content) вызывает этот метод,
        снимает с узлов «висячие» поля-ссылки и предупреждает пользователя одним
        warning'ом. Поэтому метод НЕ бросает, а ВОЗВРАЩАЕТ список нарушений.

        Обратное направление (запись словаря без узла-владельца) здесь НЕ
        собирается — его лечит orphan-фильтр репозитория при сохранении:
        `ActContentRepository._resolve_owner_node_id`, вызываемый из
        _save_tables / _save_textblocks / _save_violations
        (repositories/act_content.py) — лечит устаревший nodeId по
        актуальному рефереру дерева и дропает (считает `dropped`-сиротами)
        только записи вовсе без реферера. См. pbe-4.

        Состав проверяемых ссылок строится из реестра LEAF_BLOCK_REFS
        (block_types.py): новый leaf-тип без словаря в схеме упадёт здесь
        AttributeError'ом на старте, а не потеряет ссылки молча.

        Returns:
            Список кортежей (node_id, ref_field, ref): для каждого узла, чья
            ссылка ref_field указывает на отсутствующую запись словаря.
        """
        ref_checks = tuple(
            (ref_field, getattr(self, dict_name))
            for _block_type, (ref_field, dict_name) in LEAF_BLOCK_REFS.items()
        )
        dangling: list[tuple[str | None, str, str]] = []
        stack = [self.tree] if self.tree else []
        while stack:
            node = stack.pop()
            for ref_field, registry in ref_checks:
                ref = node.get(ref_field)
                if ref and ref not in registry:
                    dangling.append((node.get("id"), ref_field, ref))
            stack.extend(node.get("children") or [])
        return dangling


class ActSaveResponse(BaseModel):
    """
    Ответ API при сохранении акта.

    Attributes:
        status: Статус операции
        message: Сообщение о результате
        filename: Имя созданного файла
    """
    status: Literal["success", "error"]
    message: str
    filename: str


# Обновление forward references для рекурсивной схемы
ActItemSchema.model_rebuild()
