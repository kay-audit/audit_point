"""Декларативный контракт полей нарушения — блочная модель.

Single source of truth для набора полей нарушения. Каждое поле — единый
контейнер ``{enabled, blocks}`` с блоками трёх типов (text/image/table,
см. ``schemas.act_content``): ключ в JSON, имя колонки БД, метка,
стандартный порядок отображения и два флага (`mandatory` — поле нельзя
выключить, чекбокс не рендерится; `small` — мелкий шрифт 9pt в DOCX).

От этого реестра производятся: состав полей ``ViolationSchema``, полевые
колонки таблицы нарушений (страж ``test_violation_schema_columns_guard``),
санитайзер, DOCX/MD/TXT-рендеры, сериализация фронта, дифф и регенерация
id блоков. Пользовательский порядок полей конкретного нарушения хранится
в ``fieldOrder`` (None = порядок ``default_order`` отсюда).

Порядок ``VIOLATION_FIELDS`` — порядок полей в
``app.domains.acts.schemas.act_content.ViolationSchema`` (без ``id`` /
``nodeId`` / ``fieldOrder`` — это метаданные нарушения, не поля контента).

ВАЖНО: набор синхронизируется ВРУЧНУЮ с фронтовым зеркалом
``static/js/constructor/violation/violation-fields.js`` (как
``app/domains/acts/block_types.py`` ↔ ``static/js/constructor/block-types.js``):
фронт не импортирует Python. Соответствие пиннится двумя тест-стражами —
``tests/domains/acts/test_violation_fields_guard.py`` (бэк) и
``tests/js/violation-fields.test.mjs`` (фронт, точные строки меток).

`small`: 9pt-группа (`Sizes.violation_pt`) — `violated` / `established` /
`additionalContent`; остальные поля — дефолт `Sizes.body_pt` (12pt,
решение владельца при ревью спеки блочной модели).
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ViolationFieldDescriptor:
    """Описание одного поля нарушения: ключ, колонка БД, метка, порядок, флаги."""

    key: str            # camelCase-ключ поля в JSON ("codeMining")
    column: str         # snake_case-колонка таблицы нарушений ("code_mining")
    label: str          # подпись поля в UI и экспортах
    default_order: int  # позиция в стандартном порядке (== индекс в реестре)
    mandatory: bool     # True => чекбокса нет, enabled всегда True
    small: bool         # True => 9pt в DOCX


VIOLATION_FIELDS: tuple[ViolationFieldDescriptor, ...] = (
    ViolationFieldDescriptor(
        key="violated", column="violated", label="Нарушено",
        default_order=0, mandatory=True, small=True,
    ),
    ViolationFieldDescriptor(
        key="established", column="established", label="Установлено",
        default_order=1, mandatory=True, small=True,
    ),
    ViolationFieldDescriptor(
        key="description", column="description", label="Описание",
        default_order=2, mandatory=False, small=False,
    ),
    ViolationFieldDescriptor(
        key="codeMining", column="code_mining", label="CodeMining",
        default_order=3, mandatory=False, small=False,
    ),
    ViolationFieldDescriptor(
        key="processMining", column="process_mining", label="ProcessMining",
        default_order=4, mandatory=False, small=False,
    ),
    ViolationFieldDescriptor(
        key="additionalContent", column="additional_content",
        label="Дополнительный контент",
        default_order=5, mandatory=False, small=True,
    ),
    ViolationFieldDescriptor(
        key="reasons", column="reasons", label="Причины",
        default_order=6, mandatory=False, small=False,
    ),
    ViolationFieldDescriptor(
        key="measures", column="measures", label="Принятые меры",
        default_order=7, mandatory=False, small=False,
    ),
    ViolationFieldDescriptor(
        key="consequences", column="consequences", label="Последствия",
        default_order=8, mandatory=False, small=False,
    ),
    ViolationFieldDescriptor(
        # Канон #11: "Ответственные" (не "Ответственный").
        key="responsible", column="responsible", label="Ответственные",
        default_order=9, mandatory=False, small=False,
    ),
)

VIOLATION_FIELD_KEYS: tuple[str, ...] = tuple(f.key for f in VIOLATION_FIELDS)
VIOLATION_FIELD_COLUMNS: tuple[str, ...] = tuple(f.column for f in VIOLATION_FIELDS)
MANDATORY_FIELD_KEYS: tuple[str, ...] = tuple(
    f.key for f in VIOLATION_FIELDS if f.mandatory
)
FIELD_BY_KEY: dict[str, ViolationFieldDescriptor] = {
    f.key: f for f in VIOLATION_FIELDS
}

LABELS: dict[str, str] = {field.key: field.label for field in VIOLATION_FIELDS}


def ordered_fields(violation_data: dict | None) -> tuple[ViolationFieldDescriptor, ...]:
    """Дескрипторы полей в порядке отображения конкретного нарушения.

    fieldOrder нарушения применяется, если он — перестановка ВСЕХ ключей
    реестра; иначе (None, повреждён, устарел после смены состава) молча
    возвращается стандартный порядок — зеркало фронтового
    getOrderedFieldKeys (violation-fields.js). Единая точка для DOCX/MD/TXT-
    рендеров: порядок полей в экспорте == порядок в форме.
    """
    order = (violation_data or {}).get("fieldOrder")
    if (
        isinstance(order, list)
        and len(order) == len(VIOLATION_FIELD_KEYS)
        and set(order) == set(VIOLATION_FIELD_KEYS)
    ):
        return tuple(FIELD_BY_KEY[key] for key in order)
    return VIOLATION_FIELDS
