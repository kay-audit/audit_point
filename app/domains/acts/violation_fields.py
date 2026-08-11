"""Декларативный контракт полей нарушения — блочная модель.

Single source of truth для набора полей нарушения. Каждое поле — единый
контейнер ``{enabled, blocks}`` с блоками трёх типов (text/image/table,
см. ``schemas.act_content``): ключ в JSON, имя колонки БД, метка,
стандартный порядок отображения и три флага (`mandatory` — поле нельзя
выключить, чекбокс не рендерится; `small` — мелкий шрифт 9pt в DOCX;
`labeled` — метка выводится в рендерах экспорта).

От этого реестра производятся: состав полей ``ViolationSchema``, полевые
колонки таблицы нарушений (страж ``test_violation_schema_columns_guard``),
санитайзер, DOCX/MD/TXT-рендеры, сериализация фронта, дифф и регенерация
id блоков. Пользовательский порядок полей конкретного нарушения хранится
в ``fieldOrder`` (None = порядок ``default_order`` отсюда).

Здесь же живёт ПОЛИТИКА рендеров экспорта — ``should_render_field`` (выводить
ли поле) и ``field_label_for_render`` (с какой меткой). Оба Python-рендера
(``formatters/docx/builders/violation.py`` и ``formatters/violation_render.py``)
обязаны звать эти предикаты, а не повторять условия у себя: политика — часть
контракта поля, и её место рядом с флагами, от которых она считается. В
``violation_render.py`` её положить нельзя — этот модуль обслуживает только
MD/TXT, DOCX-builder на него не завязан.

Порядок ``VIOLATION_FIELDS`` — порядок полей в
``app.domains.acts.schemas.act_content.ViolationSchema`` (без ``id`` /
``nodeId`` / ``fieldOrder`` — это метаданные нарушения, не поля контента).

ВАЖНО: набор синхронизируется ВРУЧНУЮ с фронтовым зеркалом
``static/js/constructor/violation/violation-fields.js`` (как
``app/domains/acts/block_types.py`` ↔ ``static/js/constructor/block-types.js``):
фронт не импортирует Python. Соответствие пиннится двумя тест-стражами —
``tests/domains/acts/test_violation_fields_guard.py`` (бэк) и
``tests/js/violation-fields.test.mjs`` (фронт, точные строки меток).

`small`: 9pt-группа (`Sizes.violation_pt`) — `violated` / `established`;
остальные поля — дефолт `Sizes.body_pt` (12pt, решение владельца при ревью
спеки блочной модели).

`labeled`: `codeMining` / `processMining` / `additionalContent` выводятся в
экспортах и превью БЕЗ заголовка-метки — просто контент подряд, как
текстблоки (решение владельца). В ФОРМЕ конструктора подписи этих полей
остаются: флаг управляет только рендерами.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ViolationFieldDescriptor:
    """Описание одного поля нарушения: ключ, колонка БД, метка, порядок, флаги."""

    key: str            # camelCase-ключ поля в JSON ("codeMining")
    column: str         # snake_case-колонка таблицы нарушений ("code_mining")
    label: str          # подпись поля в форме конструктора и (если labeled) в экспортах
    default_order: int  # позиция в стандартном порядке (== индекс в реестре)
    mandatory: bool     # True => чекбокса нет, enabled всегда True
    small: bool         # True => 9pt курсивом в DOCX
    labeled: bool       # True => метка выводится в экспортах и превью


VIOLATION_FIELDS: tuple[ViolationFieldDescriptor, ...] = (
    ViolationFieldDescriptor(
        key="violated", column="violated", label="Нарушено",
        default_order=0, mandatory=True, small=True, labeled=True,
    ),
    ViolationFieldDescriptor(
        key="established", column="established", label="Установлено",
        default_order=1, mandatory=True, small=True, labeled=True,
    ),
    ViolationFieldDescriptor(
        key="description", column="description", label="Описание",
        default_order=2, mandatory=False, small=False, labeled=True,
    ),
    ViolationFieldDescriptor(
        key="codeMining", column="code_mining", label="CodeMining",
        default_order=3, mandatory=False, small=False, labeled=False,
    ),
    ViolationFieldDescriptor(
        key="processMining", column="process_mining", label="ProcessMining",
        default_order=4, mandatory=False, small=False, labeled=False,
    ),
    ViolationFieldDescriptor(
        key="additionalContent", column="additional_content",
        label="Дополнительный контент",
        default_order=5, mandatory=False, small=False, labeled=False,
    ),
    ViolationFieldDescriptor(
        key="reasons", column="reasons", label="Причины",
        default_order=6, mandatory=False, small=False, labeled=True,
    ),
    ViolationFieldDescriptor(
        key="measures", column="measures", label="Принятые меры",
        default_order=7, mandatory=False, small=False, labeled=True,
    ),
    ViolationFieldDescriptor(
        key="consequences", column="consequences", label="Последствия",
        default_order=8, mandatory=False, small=False, labeled=True,
    ),
    ViolationFieldDescriptor(
        # Канон #11: "Ответственные" (не "Ответственный").
        key="responsible", column="responsible", label="Ответственные",
        default_order=9, mandatory=False, small=False, labeled=True,
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


def should_render_field(
    field: ViolationFieldDescriptor, *, enabled: bool, has_blocks: bool
) -> bool:
    """Выводить ли поле в экспорт/превью — единая политика видимости.

    mandatory-поле выводится всегда, даже с пустым контейнером (#14: метка
    без тела — сигнал «не заполнено»); опциональное — только когда включено
    чекбоксом И содержит хотя бы один блок.
    """
    if field.mandatory:
        return True
    return enabled and has_blocks


def field_label_for_render(field: ViolationFieldDescriptor) -> str | None:
    """Метка поля для экспорта/превью; ``None`` — поле выводится без метки.

    Без метки идут `codeMining` / `processMining` / `additionalContent`
    (`labeled=False`): их контент выводится подряд, как текстблоки. Подписи
    в форме конструктора это не затрагивает — там метки берутся из `label`.
    """
    return field.label if field.labeled else None


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
