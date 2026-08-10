"""Тесты builder'а нарушений (блочная модель).

Единый цикл по полям реестра в порядке fieldOrder: метка включённого поля +
блоки по порядку. Первый text-блок идёт inline с меткой («Метка: текст»),
размер/курсив поля — из флага small дескриптора (9pt курсив / 12pt без).
"""
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Emu, Pt, Twips

from app.domains.acts.formatters.docx.builders.violation import (
    _USABLE_HEIGHT_TWIPS,
    _USABLE_WIDTH_TWIPS,
    _decode_data_url,
    _scale_picture,
    build_violation,
)
from app.domains.acts.formatters.docx.styles import Sizes
from app.domains.acts.schemas.act_content import ViolationSchema
from app.domains.acts.violation_fields import VIOLATION_FIELD_KEYS

# Валидный PNG 1×1 (прозрачный пиксель) для проверки встраивания.
_PNG_1PX_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)
_PNG_1PX_DATA_URL = f"data:image/png;base64,{_PNG_1PX_B64}"


def _text_block(content, bid="text_1_a"):
    return {"id": bid, "type": "text", "content": content}


def _image_block(**overrides):
    base = dict(
        id="image_1_b", type="image", url=_PNG_1PX_DATA_URL,
        caption="", filename="screen.png", width=0,
    )
    base.update(overrides)
    return base


def _table_block(grid_texts):
    return {
        "id": "table_1_c", "type": "table",
        "table": {
            "grid": [[{"content": c} for c in row] for row in grid_texts],
            "colWidths": [],
        },
    }


def _v(**field_overrides):
    """Нарушение: Нарушено/Установлено + 4 optional-поля с текстом (как раньше)."""
    payload = {
        "id": "v1", "nodeId": "5.1",
        "violated": {"enabled": True, "blocks": [_text_block("Текст нарушения")]},
        "established": {"enabled": True, "blocks": [_text_block("Текст установлено")]},
        "reasons": {"enabled": True, "blocks": [_text_block("Причина-X")]},
        "measures": {"enabled": True, "blocks": [_text_block("Мера-M")]},
        "consequences": {"enabled": True, "blocks": [_text_block("Последствие-Y")]},
        "responsible": {"enabled": True, "blocks": [_text_block("Иванов И.И.")]},
    }
    payload.update(field_overrides)
    return ViolationSchema.model_validate(payload)


def test_violation_renders_required_fields(doc):
    """Поля «Нарушено:»/«Установлено:» присутствуют."""
    build_violation(doc, _v())
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "Нарушено:" in text
    assert "Текст нарушения" in text
    assert "Установлено:" in text
    assert "Текст установлено" in text


def _runs_for_label(doc, label):
    """Метка + следующий за ней body-run в одном абзаце."""
    for p in doc.paragraphs:
        runs = p.runs
        for i, r in enumerate(runs):
            if r.text.strip() == label:
                return runs[i], runs[i + 1] if i + 1 < len(runs) else None
    return None, None


def test_violated_established_are_9pt_italic(doc):
    """«Нарушено:»/«Установлено:» — 9pt курсивом, метка подчёркнута."""
    build_violation(doc, _v())
    for label in ("Нарушено:", "Установлено:"):
        label_run, body_run = _runs_for_label(doc, label)
        assert label_run is not None and body_run is not None
        assert label_run.font.size == Pt(Sizes.violation_pt)
        assert label_run.italic is True
        assert label_run.underline is True
        assert body_run.font.size == Pt(Sizes.violation_pt)
        assert body_run.italic is True


def test_optional_group_stays_12pt_non_italic(doc):
    """Причины/Принятые меры/Последствия/Ответственные — 12pt без курсива."""
    build_violation(doc, _v())
    for label in ("Причины:", "Принятые меры:", "Последствия:", "Ответственные:"):
        label_run, body_run = _runs_for_label(doc, label)
        assert label_run is not None and body_run is not None
        assert label_run.font.size == Pt(Sizes.body_pt)
        assert not label_run.italic
        assert body_run.font.size == Pt(Sizes.body_pt)
        assert not body_run.italic


def test_new_fields_are_12pt_non_italic(doc):
    """Описание/CodeMining/ProcessMining — обычные 12pt (решение владельца)."""
    build_violation(doc, _v(
        description={"enabled": True, "blocks": [_text_block("Опис")]},
        codeMining={"enabled": True, "blocks": [_text_block("CM")]},
        processMining={"enabled": True, "blocks": [_text_block("PM")]},
    ))
    for label in ("Описание:", "CodeMining:", "ProcessMining:"):
        label_run, body_run = _runs_for_label(doc, label)
        assert label_run is not None, f"метка {label} не найдена"
        assert label_run.font.size == Pt(Sizes.body_pt)
        assert not label_run.italic


def test_mandatory_labels_shown_when_empty(doc):
    """#14: Нарушено/Установлено — метка даже при пустом контейнере."""
    v = _v(
        violated={"enabled": True, "blocks": []},
        established={"enabled": True, "blocks": []},
    )
    build_violation(doc, v)
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "Нарушено:" in text
    assert "Установлено:" in text


def test_disabled_optional_fields_not_rendered(doc):
    v = _v(reasons={"enabled": False, "blocks": [_text_block("скрытая")]})
    build_violation(doc, v)
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "скрытая" not in text
    assert "Причины:" not in text


def test_enabled_empty_optional_field_not_rendered(doc):
    v = _v(reasons={"enabled": True, "blocks": []})
    build_violation(doc, v)
    assert "Причины:" not in "\n".join(p.text for p in doc.paragraphs)


def test_field_order_respected(doc):
    """fieldOrder меняет порядок секций в DOCX."""
    order = list(VIOLATION_FIELD_KEYS)
    order.remove("responsible")
    order.insert(0, "responsible")
    build_violation(doc, _v(fieldOrder=order))
    text = "\n".join(p.text for p in doc.paragraphs)
    assert text.index("Иванов И.И.") < text.index("Текст нарушения")


def test_multiple_text_blocks_render_in_order(doc):
    v = _v(reasons={"enabled": True, "blocks": [
        _text_block("Первый абзац", "text_1"),
        _text_block("Второй абзац", "text_2"),
    ]})
    build_violation(doc, v)
    text = "\n".join(p.text for p in doc.paragraphs)
    assert text.index("Первый абзац") < text.index("Второй абзац")
    # Метка одна — на первом блоке.
    assert text.count("Причины:") == 1


def test_violation_has_no_header_paragraph(doc):
    """Нет абзаца, начинающегося со слова «Проблема»."""
    build_violation(doc, _v())
    assert not any(p.text.strip().startswith("Проблема") for p in doc.paragraphs)


def test_violation_has_no_numbering(doc):
    """Ни в одном абзаце нарушения нет numPr (списки ul/ol — отдельные тесты)."""
    build_violation(doc, _v())
    for p in doc.paragraphs:
        p_pr = p._p.find(qn("w:pPr"))
        if p_pr is None:
            continue
        assert p_pr.find(qn("w:numPr")) is None


def test_labels_are_underlined(doc):
    build_violation(doc, _v())
    label_runs = [
        r for p in doc.paragraphs for r in p.runs
        if r.text.strip() in {"Причины:", "Принятые меры:", "Последствия:", "Ответственные:"}
    ]
    assert len(label_runs) == 4
    assert all(r.underline for r in label_runs)


# --- Блок-таблица ---


def test_table_block_renders_docx_table(doc):
    v = _v(codeMining={"enabled": True, "blocks": [
        _table_block([["Запрос", "Результат"], ["SELECT 1", "OK"]]),
    ]})
    build_violation(doc, v)
    assert len(doc.tables) == 1
    cells = [c.text for row in doc.tables[0].rows for c in row.cells]
    assert "Запрос" in cells and "SELECT 1" in cells


def test_field_with_table_first_renders_label_alone(doc):
    """Если первый блок — таблица, метка выводится отдельным абзацем."""
    v = _v(codeMining={"enabled": True, "blocks": [
        _table_block([["A"]]),
        _text_block("после таблицы"),
    ]})
    build_violation(doc, v)
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "CodeMining:" in text
    assert "после таблицы" in text
    assert len(doc.tables) == 1


def test_empty_table_block_renders_nothing(doc):
    """Пустая сетка не создаёт docx-таблицы (build_table no-op)."""
    v = _v(codeMining={"enabled": True, "blocks": [
        {"id": "table_1_c", "type": "table", "table": {"grid": [], "colWidths": []}},
    ]})
    build_violation(doc, v)
    assert len(doc.tables) == 0


# --- Картинки (M.2 / H4) ---


def _v_with_blocks(*blocks):
    return _v(additionalContent={"enabled": True, "blocks": list(blocks)})


def test_image_embedded_as_inline_shape(doc):
    """PNG 1×1 из data-URL встраивается в документ как inline shape."""
    build_violation(doc, _v_with_blocks(_image_block()))
    assert len(doc.inline_shapes) == 1


def test_image_paragraph_centered(doc):
    """Абзац с картинкой выровнен по центру (Б-1.5)."""
    build_violation(doc, _v_with_blocks(_image_block()))
    pic_para = next(
        p for p in doc.paragraphs if p._p.findall(".//" + qn("w:drawing"))
    )
    assert pic_para.alignment == WD_ALIGN_PARAGRAPH.CENTER


def test_image_caption_italic_centered_below(doc):
    """Подпись — отдельный абзац под картинкой: курсив, по центру."""
    build_violation(doc, _v_with_blocks(_image_block(caption="Скриншот экрана")))
    cap_para = next(p for p in doc.paragraphs if "Скриншот экрана" in p.text)
    assert cap_para.alignment == WD_ALIGN_PARAGRAPH.CENTER
    cap_runs = [r for r in cap_para.runs if r.text.strip()]
    assert all(r.italic for r in cap_runs)
    assert all(r.font.size == Pt(Sizes.violation_pt) for r in cap_runs)


def test_image_caption_bold_html_renders_bold_run(doc):
    """Task 6: жирный фрагмент rich-подписи → bold run (не текст тегов)."""
    build_violation(doc, _v_with_blocks(_image_block(caption="<b>важно</b>: подпись")))
    cap_para = next(p for p in doc.paragraphs if "подпись" in p.text)
    assert "<b>" not in cap_para.text
    bold_run = next(r for r in cap_para.runs if r.text.strip() == "важно")
    assert bold_run.bold is True
    assert bold_run.italic is True
    assert bold_run.font.size == Pt(Sizes.violation_pt)


def test_broken_base64_renders_placeholder(doc):
    """Битый base64 → текстовый плейсхолдер «Изображение: …», без исключения."""
    build_violation(doc, _v_with_blocks(
        _image_block(url="data:image/png;base64,@@не-base64@@"),
    ))
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "Изображение: screen.png" in text
    assert len(doc.inline_shapes) == 0


def test_empty_url_renders_placeholder(doc):
    """Пустой url (черновик без содержимого) → плейсхолдер (паритет с MD/TXT)."""
    build_violation(doc, _v_with_blocks(
        _image_block(url="", filename="ext.png"),
    ))
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "Изображение: ext.png" in text
    assert len(doc.inline_shapes) == 0


def test_undecodable_image_bytes_render_placeholder(doc):
    """Валидный base64, но не картинка → плейсхолдер, без исключения."""
    build_violation(doc, _v_with_blocks(_image_block(url="data:image/png;base64,AAAA")))
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "Изображение: screen.png" in text
    assert len(doc.inline_shapes) == 0


def test_image_placeholder_is_9pt_italic(doc):
    """Текстовый плейсхолдер «Изображение: …» — 9pt курсивом."""
    build_violation(doc, _v_with_blocks(_image_block(url="")))
    run = next(
        r for p in doc.paragraphs for r in p.runs
        if r.text.strip().startswith("Изображение:")
    )
    assert run.font.size == Pt(Sizes.violation_pt)
    assert run.italic is True


# --- Whitelist форматов builder'а = whitelist схемы (единый IMAGE_DATA_URL_PATTERN) ---


def test_decode_rejects_webp_and_svg():
    """Builder отбрасывает форматы вне whitelist (webp/svg)."""
    assert _decode_data_url(f"data:image/webp;base64,{_PNG_1PX_B64}") is None
    assert _decode_data_url(f"data:image/svg+xml;base64,{_PNG_1PX_B64}") is None


def test_decode_accepts_png_jpeg_gif():
    """Builder принимает png/jpeg/gif и возвращает декодированные байты."""
    for subtype in ("png", "jpeg", "jpg", "gif"):
        data = _decode_data_url(f"data:image/{subtype};base64,{_PNG_1PX_B64}")
        assert data is not None, f"формат {subtype} должен приниматься builder'ом"
        assert isinstance(data, bytes)


def test_image_width_50_percent_is_half_usable_width(doc):
    """width=50 → ширина shape ≈ 5173 твип (половина полезной ширины)."""
    build_violation(doc, _v_with_blocks(_image_block(width=50)))
    shape = doc.inline_shapes[0]
    expected = Twips(_USABLE_WIDTH_TWIPS * 50 // 100)
    assert abs(int(shape.width) - int(expected)) <= int(Twips(1))
    assert _USABLE_WIDTH_TWIPS == 10346  # Page 11906 − left 851 − right 709


def test_scale_picture_caps_natural_size_at_usable_width():
    """Без width картинка шире полезной ширины ужимается с сохранением пропорций."""
    class _FakeShape:
        width = Emu(int(Twips(_USABLE_WIDTH_TWIPS)) * 2)
        height = Emu(1_000_000)

    shape = _FakeShape()
    _scale_picture(shape, 0)
    assert int(shape.width) == int(Twips(_USABLE_WIDTH_TWIPS))
    assert int(shape.height) == 500_000


def test_scale_picture_keeps_natural_size_when_fits():
    """Без width картинка уже полезной ширины остаётся в натуральном размере."""
    class _FakeShape:
        width = Emu(100_000)
        height = Emu(50_000)

    shape = _FakeShape()
    _scale_picture(shape, 0)
    assert int(shape.width) == 100_000
    assert int(shape.height) == 50_000


class _StubShape:
    """Минимальный shape для юнит-теста _scale_picture (width/height — int)."""
    def __init__(self, width, height):
        self.width = width
        self.height = height


def test_scale_picture_zero_width_does_not_crash():
    """#7: картинка нулевой ширины не роняет экспорт (нет ZeroDivisionError)."""
    shape = _StubShape(width=0, height=100)
    _scale_picture(shape, width_percent=50)
    assert shape.width == 0
    assert shape.height == 100


def test_scale_picture_zero_width_auto_branch():
    """#7: тот же guard в ветке width_percent=0 (натуральный размер)."""
    shape = _StubShape(width=0, height=50)
    _scale_picture(shape, width_percent=0)
    assert shape.width == 0
    assert shape.height == 50


def test_scale_picture_normal_still_scales():
    """Регрессия: ненулевая ширина по-прежнему масштабируется по проценту."""
    usable = int(Twips(_USABLE_WIDTH_TWIPS))
    shape = _StubShape(width=usable, height=usable)
    _scale_picture(shape, width_percent=50)
    assert shape.width == usable * 50 // 100
    assert shape.height == shape.width


def test_scale_picture_caps_tall_image_at_height_ceiling():
    """#13: узкая высокая картинка досжимается по потолку высоты (и ширина тоже)."""
    usable_w = int(Twips(_USABLE_WIDTH_TWIPS))
    ceiling = int(Twips(_USABLE_HEIGHT_TWIPS)) * 40 // 100
    shape = _StubShape(width=usable_w, height=usable_w * 3)
    _scale_picture(shape, width_percent=100, max_height_percent=40)
    assert shape.height == ceiling
    assert abs(shape.height - shape.width * 3) <= 2


def test_scale_picture_wide_image_not_capped_by_height():
    """#13: широкая невысокая картинка потолком высоты не трогается."""
    usable_w = int(Twips(_USABLE_WIDTH_TWIPS))
    shape = _StubShape(width=usable_w, height=usable_w // 10)
    _scale_picture(shape, width_percent=100, max_height_percent=40)
    assert shape.width == usable_w
    assert shape.height == usable_w // 10


# --- БАГ-4: per-line выравнивание rich-полей нарушения ---


def _paras_containing(doc, text):
    """Абзацы документа, чей текст содержит подстроку text."""
    return [p for p in doc.paragraphs if text in p.text]


class TestRichFieldPerLineAlignment:
    """Text-блоки полей режутся на строки тем же split_block_segments, что и
    текстблок: каждая верхнеуровневая строка со своим text-align — свой w:p."""

    def test_center_line_becomes_centered_paragraph(self, doc):
        """Строка с text-align: center внутри поля — отдельный center-абзац."""
        build_violation(doc, _v(reasons={"enabled": True, "blocks": [_text_block(
            '<div>обычная</div><div style="text-align: center">по центру</div>',
        )]}))
        paras = _paras_containing(doc, "по центру")
        assert len(paras) == 1
        assert paras[0].alignment == WD_ALIGN_PARAGRAPH.CENTER

    def test_default_stays_justify(self, doc):
        """Строка без text-align — прежний дефолт justify."""
        build_violation(doc, _v(reasons={"enabled": True, "blocks": [_text_block(
            "обычный текст без разметки",
        )]}))
        paras = _paras_containing(doc, "Причины:")
        assert len(paras) == 1
        assert paras[0].alignment == WD_ALIGN_PARAGRAPH.JUSTIFY

    def test_label_only_on_first_paragraph(self, doc):
        """«Причины:» выводится один раз — на первом абзаце; продолжение без метки."""
        build_violation(doc, _v(reasons={"enabled": True, "blocks": [_text_block(
            '<div>первая</div><div style="text-align: center">вторая</div>',
        )]}))
        label_paras = _paras_containing(doc, "Причины:")
        assert len(label_paras) == 1
        assert "первая" in label_paras[0].text
        second = _paras_containing(doc, "вторая")
        assert len(second) == 1
        assert "Причины:" not in second[0].text
