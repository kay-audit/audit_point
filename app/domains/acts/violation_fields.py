"""Декларативный контракт полей нарушения (#31A, бэкбон рефакторинга «Нарушения»).

Single source of truth для набора полей нарушения: ключ, метка, порядок
отображения, вид (`kind`) и три флага (`small` — мелкий шрифт,
`show_label_in_preview` — показывать ли подпись поля в превью/форме,
`rich` — поле редактируется rich-редактором и санитизируется как HTML
на сохранении; plain-поля хранятся дословно). На этом
контракте позже стоит унификация подписей и единый рендер формы (следующие
задачи бэкбона); в ЭТОЙ задаче он только объявлен и закреплён стражами —
рендереры не трогаются.

Порядок `VIOLATION_FIELDS` — порядок полей в
``app.domains.acts.schemas.act_content.ViolationSchema`` (без `id`/`nodeId` —
это метаданные нарушения, не поля контента).

ВАЖНО: набор синхронизируется ВРУЧНУЮ с фронтовым зеркалом
``static/js/constructor/violation/violation-fields.js`` (как
``app/domains/acts/block_types.py`` ↔ ``static/js/constructor/block-types.js``,
``app/core/chat/names.py`` ↔ ``chat-client-actions.js``): фронт не импортирует
Python. Соответствие пиннится двумя тест-стражами —
``tests/domains/acts/test_violation_fields_guard.py`` (бэк) и
``tests/js/violation-fields.test.mjs`` (фронт, точные строки меток).

`small`: контракт ОПИСЫВАЕТ текущий рендер (позже DOCX/превью будут читать
размер отсюда). Сверено с ``formatters/docx/builders/violation.py``
(`build_violation`) и ``formatters/docx/styles.py``: 9pt-группа
(`Sizes.violation_pt`) — `violated` / `established` / `descriptionList` /
`additionalContent` (все ветки case/image-caption/freeText) → `small=True`.
`reasons` / `measures` / `consequences` / `responsible` рендерятся без
`size_pt` (дефолт `Sizes.body_pt`, 12pt; закреплено
`test_reasons_block_stays_12pt_non_italic`) → `small=False`.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ViolationFieldDescriptor:
    """Описание одного поля нарушения: метка, порядок, вид, флаги рендера."""

    key: str
    label: str
    order: int
    kind: str  # "pair" | "list" | "additional" | "optional_text"
    small: bool
    show_label_in_preview: bool
    rich: bool  # Поле требует rich-редактора и HTML-санитайзера


VIOLATION_FIELDS: tuple[ViolationFieldDescriptor, ...] = (
    ViolationFieldDescriptor(
        key="violated", label="Нарушено", order=0, kind="pair",
        small=True, show_label_in_preview=True, rich=True,
    ),
    ViolationFieldDescriptor(
        key="established", label="Установлено", order=1, kind="pair",
        small=True, show_label_in_preview=True, rich=True,
    ),
    ViolationFieldDescriptor(
        # Заголовок убран (решение #12) — список описаний идёт без подписи.
        key="descriptionList", label="", order=2, kind="list",
        small=True, show_label_in_preview=False, rich=False,
    ),
    ViolationFieldDescriptor(
        key="additionalContent", label="", order=3, kind="additional",
        small=True, show_label_in_preview=False, rich=False,
    ),
    ViolationFieldDescriptor(
        key="reasons", label="Причины", order=4, kind="optional_text",
        small=False, show_label_in_preview=True, rich=True,
    ),
    ViolationFieldDescriptor(
        key="measures", label="Принятые меры", order=5, kind="optional_text",
        small=False, show_label_in_preview=True, rich=True,
    ),
    ViolationFieldDescriptor(
        key="consequences", label="Последствия", order=6, kind="optional_text",
        small=False, show_label_in_preview=True, rich=True,
    ),
    ViolationFieldDescriptor(
        # Канон #11: "Ответственные" (не "Ответственный", как в DOCX-builder'е —
        # выравнивание подписи форматтеров будет отдельной задачей бэкбона).
        key="responsible", label="Ответственные", order=7, kind="optional_text",
        small=False, show_label_in_preview=True, rich=True,
    ),
)

LABELS: dict[str, str] = {field.key: field.label for field in VIOLATION_FIELDS}

# Подпись кейса дополнительного контента ("Кейс 1", "Кейс 2", ...).
CASE_LABEL_TEMPLATE = "Кейс {n}"

# Свободный текст дополнительного контента — без подписи (решение #10).
FREE_TEXT_LABEL = ""
