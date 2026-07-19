"""Тест-страж паритета подписей/нумерации нарушения между DOCX/MD/TXT (#32).

Task 10 унифицировал подписи/нумерацию/пустые поля в трёх форматтерах
(``markdown_formatter._format_violation``, ``text_formatter._format_violation``,
``docx/builders/violation.build_violation``). Этот файл фиксирует паритет
тестом, чтобы расхождение меток/разделов между форматтерами больше не
проходило незамеченным:

- **label-parity** — reference-нарушение со ВСЕМИ 8 полями enabled+filled и
  доп.контентом трёх видов (кейс/картинка/свободный текст) прогоняется через
  все три форматтера; каждая ожидаемая непустая метка контракта
  (``violation_fields.LABELS``) и «Кейс 1» обязаны присутствовать в КАЖДОМ
  выводе. descriptionList рендерится БЕЗ заголовка (только буллиты), freeText
  — без метки «Текст N». Уникальные маркеры на каждое поле проверяют, что
  именно ЗНАЧЕНИЕ поля доходит до вывода, а не только метка;
- **numbering-parity** — сквозная нумерация кейсов (включая пустые, #9/Q1) и
  сброс нумерации на не-кейсе (в т.ч. картинке) совпадают во всех трёх
  форматтерах;
- **формат-покрытие контракта** (отложено из Task 1,
  ``test_violation_fields_guard.py``) — параметризованный аналог
  ``TestFormattersCoverEveryLeafType`` из ``test_block_types_guard.py``:
  каждая непустая метка ``LABELS[key]`` доходит до вывода каждого форматтера.

Источник ожидаемых меток — ``app.domains.acts.violation_fields.LABELS``
(канон #11 и т.д.). Если кто-то откатит метку форматтера на старую
(например, DOCX «Ответственный» вместо канонического «Ответственные») —
эти тесты упадут.
"""
from __future__ import annotations

import re

import pytest
from docx import Document

from app.domains.acts.formatters.docx.builders.violation import build_violation
from app.domains.acts.formatters.markdown_formatter import MarkdownFormatter
from app.domains.acts.formatters.text_formatter import TextFormatter
from app.domains.acts.schemas.act_content import ViolationSchema
from app.domains.acts.settings import ActsSettings
from app.domains.acts.violation_fields import CASE_LABEL_TEMPLATE, LABELS


def _md() -> MarkdownFormatter:
    return MarkdownFormatter(settings=None, acts_settings=ActsSettings())


def _txt() -> TextFormatter:
    return TextFormatter(settings=None, acts_settings=ActsSettings())


def _docx_text(violation: ViolationSchema) -> str:
    """Рендерит нарушение в свежий Document и возвращает весь текст абзацев."""
    doc = Document()
    build_violation(doc, violation)
    return "\n".join(p.text for p in doc.paragraphs)


# --- Reference-нарушение: ВСЕ 8 полей enabled+filled + доп.контент трёх видов.
# Уникальный маркер на каждое поле — проверяем доходимость именно ЗНАЧЕНИЯ,
# не только наличия метки. Картинка — с пустым url (черновик): плейсхолдер
# "Изображение: {filename}" рендерится всеми тремя форматтерами одинаково
# (в отличие от встроенного inline shape в DOCX, который текста не оставляет).

MARKERS = {
    "violated": "МАРКЕР_ALPHA",
    "established": "МАРКЕР_BRAVO",
    "desc_1": "МАРКЕР_CHARLIE_1",
    "desc_2": "МАРКЕР_CHARLIE_2",
    "case": "МАРКЕР_DELTA",
    "image_caption": "МАРКЕР_ECHO",
    "image_filename": "МАРКЕР_FOXTROT.png",
    "free_text": "МАРКЕР_GOLF",
    "reasons": "МАРКЕР_HOTEL",
    "consequences": "МАРКЕР_INDIA",
    "responsible": "МАРКЕР_JULIET",
    "measures": "МАРКЕР_KILO",
}

_REFERENCE_VIOLATION_DICT = {
    "id": "v_parity_1",
    "nodeId": "9.9",
    "violated": MARKERS["violated"],
    "established": MARKERS["established"],
    "descriptionList": {
        "enabled": True,
        "items": [MARKERS["desc_1"], MARKERS["desc_2"]],
    },
    "additionalContent": {
        "enabled": True,
        "items": [
            {"id": "case1", "type": "case", "content": MARKERS["case"]},
            {
                "id": "img1", "type": "image", "url": "",
                "caption": MARKERS["image_caption"],
                "filename": MARKERS["image_filename"],
            },
            {"id": "ft1", "type": "freeText", "content": MARKERS["free_text"]},
        ],
    },
    "reasons": {"enabled": True, "content": MARKERS["reasons"]},
    "consequences": {"enabled": True, "content": MARKERS["consequences"]},
    "responsible": {"enabled": True, "content": MARKERS["responsible"]},
    "measures": {"enabled": True, "content": MARKERS["measures"]},
}


def _reference_schema() -> ViolationSchema:
    return ViolationSchema(**_REFERENCE_VIOLATION_DICT)


# Единая точка правды меток на py-стороне (источник — violation_fields.LABELS).
EXPECTED_LABELS = {key: label for key, label in LABELS.items() if label}

_MD_OUT = _md()._format_violation(_REFERENCE_VIOLATION_DICT)
_TXT_OUT = _txt()._format_violation(_REFERENCE_VIOLATION_DICT)
_DOCX_OUT = _docx_text(_reference_schema())

_ALL_OUTPUTS = {"markdown": _MD_OUT, "text": _TXT_OUT, "docx": _DOCX_OUT}
_FMT_NAMES = sorted(_ALL_OUTPUTS)


@pytest.mark.parametrize("fmt_name", _FMT_NAMES)
class TestLabelParity:
    """Reference-нарушение: каждая ожидаемая метка/маркер — в КАЖДОМ выводе."""

    def test_field_labels_present(self, fmt_name):
        out = _ALL_OUTPUTS[fmt_name]
        for key, label in EXPECTED_LABELS.items():
            assert f"{label}:" in out, (
                f"{fmt_name}: метка {label!r} поля {key!r} потерялась — сверь "
                f"с violation_fields.LABELS"
            )

    def test_case_label_present(self, fmt_name):
        out = _ALL_OUTPUTS[fmt_name]
        expected = CASE_LABEL_TEMPLATE.format(n=1)
        assert f"{expected}:" in out, f"{fmt_name}: метка «{expected}» потерялась"

    def test_all_markers_reach_output(self, fmt_name):
        """Доходимость значений: каждый уникальный маркер поля — в выводе."""
        out = _ALL_OUTPUTS[fmt_name]
        for field, marker in MARKERS.items():
            assert marker in out, (
                f"{fmt_name}: маркер {marker!r} поля {field!r} не дошёл до вывода"
            )

    def test_description_list_has_no_header(self, fmt_name):
        """#12: заголовок списка описаний убран — только буллиты."""
        out = _ALL_OUTPUTS[fmt_name]
        assert "В том числе" not in out
        assert "Описание" not in out
        assert "**Описание:**" not in out

    def test_free_text_has_no_label(self, fmt_name):
        """freeText рендерится без метки «Текст N» (FREE_TEXT_LABEL == "")."""
        out = _ALL_OUTPUTS[fmt_name]
        assert not re.search(r"Текст\s*\d", out), (
            f"{fmt_name}: у свободного текста не должно быть метки «Текст N»"
        )


def _numbering_violation(items: list[dict]) -> dict:
    """Reference-нарушение с заданным списком additionalContent.items."""
    violation = dict(_REFERENCE_VIOLATION_DICT)
    violation["additionalContent"] = {"enabled": True, "items": items}
    return violation


class TestNumberingParity:
    """Сквозная нумерация кейсов (вкл. пустые) и сброс на не-кейсе — паритет."""

    def test_empty_first_case_shifts_second_to_case_2(self):
        items = [
            {"id": "c1", "type": "case", "content": ""},
            {"id": "c2", "type": "case", "content": "МАРКЕР_НОМЕР_ВТОРОЙ"},
        ]
        v = _numbering_violation(items)
        md_out = _md()._format_violation(v)
        txt_out = _txt()._format_violation(v)
        docx_out = _docx_text(ViolationSchema(**v))

        assert "**Кейс 1:**" in md_out
        assert "**Кейс 2:** МАРКЕР_НОМЕР_ВТОРОЙ" in md_out
        assert "Кейс 1:" in txt_out
        assert "Кейс 2: МАРКЕР_НОМЕР_ВТОРОЙ" in txt_out

        docx_case_lines = [
            ln.strip() for ln in docx_out.split("\n") if ln.strip().startswith("Кейс")
        ]
        assert docx_case_lines == ["Кейс 1:", "Кейс 2: МАРКЕР_НОМЕР_ВТОРОЙ"]

    def test_case_after_image_resets_to_case_1(self):
        items = [
            {"id": "c1", "type": "case", "content": "МАРКЕР_ДО_КАРТИНКИ"},
            {
                "id": "img1", "type": "image", "url": "",
                "caption": "", "filename": "reset.png",
            },
            {"id": "c2", "type": "case", "content": "МАРКЕР_ПОСЛЕ_КАРТИНКИ"},
        ]
        v = _numbering_violation(items)
        md_out = _md()._format_violation(v)
        txt_out = _txt()._format_violation(v)
        docx_out = _docx_text(ViolationSchema(**v))

        for out in (md_out, txt_out, docx_out):
            assert "Кейс 2" not in out, "после картинки нумерация обязана сброситься"

        assert "**Кейс 1:** МАРКЕР_ДО_КАРТИНКИ" in md_out
        assert "**Кейс 1:** МАРКЕР_ПОСЛЕ_КАРТИНКИ" in md_out
        assert "Кейс 1: МАРКЕР_ДО_КАРТИНКИ" in txt_out
        assert "Кейс 1: МАРКЕР_ПОСЛЕ_КАРТИНКИ" in txt_out

        docx_case_lines = [
            ln.strip() for ln in docx_out.split("\n") if ln.strip().startswith("Кейс")
        ]
        assert docx_case_lines == ["Кейс 1: МАРКЕР_ДО_КАРТИНКИ", "Кейс 1: МАРКЕР_ПОСЛЕ_КАРТИНКИ"]


# --- Формат-покрытие контракта (отложено из Task 1) ---

_CONTRACT_LABEL_KEYS = tuple(EXPECTED_LABELS)


@pytest.mark.parametrize("field_key", _CONTRACT_LABEL_KEYS)
class TestFormattersCoverEveryContractLabel:
    """Аналог TestFormattersCoverEveryLeafType (test_block_types_guard.py):

    для каждого поля контракта с непустой меткой — метка LABELS[key] обязана
    дойти до вывода КАЖДОГО форматтера на reference-нарушении.
    """

    def test_markdown_formatter_renders_label(self, field_key):
        assert f"{LABELS[field_key]}:" in _MD_OUT, (
            f"markdown_formatter потерял метку поля {field_key!r} — сверь "
            f"_format_violation с violation_fields.LABELS"
        )

    def test_text_formatter_renders_label(self, field_key):
        assert f"{LABELS[field_key]}:" in _TXT_OUT, (
            f"text_formatter потерял метку поля {field_key!r} — сверь "
            f"_format_violation с violation_fields.LABELS"
        )

    def test_docx_formatter_renders_label(self, field_key):
        assert f"{LABELS[field_key]}:" in _DOCX_OUT, (
            f"DOCX build_violation потерял метку поля {field_key!r} — сверь "
            f"с violation_fields.LABELS"
        )


# --- Rich-рендер текстовых полей (Task 1.1.2) ---
#
# violated/established/кейсы/freeText/reasons/measures/consequences/
# responsible/descriptionList-буллеты (Task 7) рендерятся через
# apply_inline_html (inline HTML → runs) вместо plain add_run. Плейсхолдер
# картинки остаётся plain — картинка не должна парсить filename как HTML.


def test_docx_violation_field_bold_and_ampersand():
    v = ViolationSchema(**{**_REFERENCE_VIOLATION_DICT, "violated": "Ромашка &amp; Ко <b>жирное</b>"})
    doc = Document(); build_violation(doc, v)
    para = doc.paragraphs[0]
    assert any(r.text == "жирное" and r.bold for r in para.runs)
    full = "\n".join(p.text for p in doc.paragraphs)
    assert "Ромашка & Ко" in full and "&amp;" not in full


def test_docx_violation_field_stays_italic():
    v = ViolationSchema(**{**_REFERENCE_VIOLATION_DICT, "violated": "обычный"})
    doc = Document(); build_violation(doc, v)
    body = [r for r in doc.paragraphs[0].runs if r.text.strip() and "Нарушено" not in r.text]
    assert body and all(r.italic for r in body)


def test_docx_image_placeholder_stays_plain():
    v = ViolationSchema(**{**_REFERENCE_VIOLATION_DICT, "additionalContent": {"enabled": True,
        "items": [{"id":"i","type":"image","url":"","caption":"","filename":"a<b.png"}]}})
    doc = Document(); build_violation(doc, v)
    assert "a<b.png" in "\n".join(p.text for p in doc.paragraphs)
