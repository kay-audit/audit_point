"""Тесты builder'а нарушений."""
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
from app.domains.acts.schemas.act_content import (
    ViolationAdditionalContentSchema,
    ViolationContentItemSchema,
    ViolationOptionalFieldSchema,
    ViolationSchema,
)

# Валидный PNG 1×1 (прозрачный пиксель) для проверки встраивания.
_PNG_1PX_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)
_PNG_1PX_DATA_URL = f"data:image/png;base64,{_PNG_1PX_B64}"


def _v(**overrides):
    base = dict(
        id="v1", nodeId="5.1", violated="Текст нарушения",
        established="Текст установлено",
        reasons=ViolationOptionalFieldSchema(enabled=True, content="Причина-X"),
        measures=ViolationOptionalFieldSchema(enabled=True, content="Мера-M"),
        consequences=ViolationOptionalFieldSchema(enabled=True, content="Последствие-Y"),
        responsible=ViolationOptionalFieldSchema(enabled=True, content="Иванов И.И."),
    )
    base.update(overrides)
    return ViolationSchema(**base)


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


def test_description_list_bullets_9pt_italic(doc):
    """Bullets из descriptionList — 9pt курсивом."""
    violation = _v(descriptionList={"enabled": True, "items": ["Пункт-A", "Пункт-B"]})
    build_violation(doc, violation)
    bullet_runs = [
        r for p in doc.paragraphs for r in p.runs
        if r.text.strip() in {"Пункт-A", "Пункт-B"}
    ]
    assert len(bullet_runs) == 2
    assert all(r.font.size == Pt(Sizes.violation_pt) for r in bullet_runs)
    assert all(r.italic for r in bullet_runs)


def test_description_list_bullet_bold_html_renders_bold_run(doc):
    """Task 7: жирный фрагмент rich-пункта → bold run (не текст тегов), базовые курсив/размер сохраняются."""
    violation = _v(descriptionList={"enabled": True, "items": ["<b>важно</b>: пункт"]})
    build_violation(doc, violation)
    bullet_para = next(p for p in doc.paragraphs if "пункт" in p.text)
    assert "<b>" not in bullet_para.text
    bold_run = next(r for r in bullet_para.runs if r.text.strip() == "важно")
    assert bold_run.bold is True
    assert bold_run.italic is True
    assert bold_run.font.size == Pt(Sizes.violation_pt)


def test_reasons_block_stays_12pt_non_italic(doc):
    """Причины/Принятые меры/Последствия/Ответственные — 12pt без курсива."""
    build_violation(doc, _v())
    for label in ("Причины:", "Принятые меры:", "Последствия:", "Ответственные:"):
        label_run, body_run = _runs_for_label(doc, label)
        assert label_run is not None and body_run is not None
        assert label_run.font.size == Pt(Sizes.body_pt)
        assert not label_run.italic
        assert body_run.font.size == Pt(Sizes.body_pt)
        assert not body_run.italic


def test_violation_has_no_header_paragraph(doc):
    """Нет абзаца, начинающегося со слова «Проблема»."""
    build_violation(doc, _v())
    assert not any(p.text.strip().startswith("Проблема") for p in doc.paragraphs)


def test_violation_has_no_numbering(doc):
    """Ни в одном абзаце нарушения нет numPr."""
    build_violation(doc, _v())
    for p in doc.paragraphs:
        p_pr = p._p.find(qn("w:pPr"))
        if p_pr is None:
            continue
        assert p_pr.find(qn("w:numPr")) is None


def test_disabled_optional_fields_not_rendered(doc):
    violation = _v(
        reasons=ViolationOptionalFieldSchema(enabled=False, content="скрытая"),
    )
    build_violation(doc, violation)
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "скрытая" not in text


def test_labels_are_underlined(doc):
    build_violation(doc, _v())
    label_runs = [
        r for p in doc.paragraphs for r in p.runs
        if r.text.strip() in {"Причины:", "Принятые меры:", "Последствия:", "Ответственные:"}
    ]
    assert len(label_runs) == 4
    assert all(r.underline for r in label_runs)


# --- Картинки дополнительного контента (M.2 / H4) ---

def _img_item(**overrides):
    base = dict(
        id="img1", type="image", url=_PNG_1PX_DATA_URL,
        caption="", filename="screen.png",
    )
    base.update(overrides)
    return ViolationContentItemSchema(**base)


def _v_with_items(*items):
    return _v(additionalContent=ViolationAdditionalContentSchema(
        enabled=True, items=list(items),
    ))


def test_image_embedded_as_inline_shape(doc):
    """PNG 1×1 из data-URL встраивается в документ как inline shape."""
    build_violation(doc, _v_with_items(_img_item()))
    assert len(doc.inline_shapes) == 1


def test_image_paragraph_centered(doc):
    """Абзац с картинкой выровнен по центру (Б-1.5)."""
    build_violation(doc, _v_with_items(_img_item()))
    pic_para = next(
        p for p in doc.paragraphs if p._p.findall(".//" + qn("w:drawing"))
    )
    assert pic_para.alignment == WD_ALIGN_PARAGRAPH.CENTER


def test_image_caption_italic_centered_below(doc):
    """Подпись — отдельный абзац под картинкой: курсив, по центру."""
    build_violation(doc, _v_with_items(_img_item(caption="Скриншот экрана")))
    cap_para = next(p for p in doc.paragraphs if "Скриншот экрана" in p.text)
    assert cap_para.alignment == WD_ALIGN_PARAGRAPH.CENTER
    cap_runs = [r for r in cap_para.runs if r.text.strip()]
    assert all(r.italic for r in cap_runs)
    assert all(r.font.size == Pt(Sizes.violation_pt) for r in cap_runs)


def test_image_caption_bold_html_renders_bold_run(doc):
    """Task 6: жирный фрагмент rich-подписи → bold run (не текст тегов), базовые курсив/размер сохраняются."""
    build_violation(doc, _v_with_items(_img_item(caption="<b>важно</b>: подпись")))
    cap_para = next(p for p in doc.paragraphs if "подпись" in p.text)
    assert "<b>" not in cap_para.text
    bold_run = next(r for r in cap_para.runs if r.text.strip() == "важно")
    assert bold_run.bold is True
    assert bold_run.italic is True
    assert bold_run.font.size == Pt(Sizes.violation_pt)


def test_broken_base64_renders_placeholder(doc):
    """Битый base64 → текстовый плейсхолдер «Изображение: …», без исключения."""
    build_violation(doc, _v_with_items(
        _img_item(url="data:image/png;base64,@@не-base64@@"),
    ))
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "Изображение: screen.png" in text
    assert len(doc.inline_shapes) == 0


def test_empty_url_renders_placeholder(doc):
    """Пустой url (черновик без содержимого) → плейсхолдер (паритет с MD/TXT)."""
    violation = _v_with_items(
        ViolationContentItemSchema(
            id="img1", type="image", url="", caption="", filename="ext.png",
        ),
    )
    build_violation(doc, violation)
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "Изображение: ext.png" in text
    assert len(doc.inline_shapes) == 0


def test_undecodable_image_bytes_render_placeholder(doc):
    """Валидный base64, но не картинка → плейсхолдер, без исключения."""
    build_violation(doc, _v_with_items(_img_item(url="data:image/png;base64,AAAA")))
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "Изображение: screen.png" in text
    assert len(doc.inline_shapes) == 0


# --- Whitelist форматов builder'а = whitelist схемы (единый IMAGE_DATA_URL_PATTERN) ---

def test_decode_rejects_webp_and_svg():
    """Builder отбрасывает форматы вне whitelist (webp/svg) — единый источник
    с валидатором url схемы (IMAGE_DATA_URL_PATTERN)."""
    # Валидный base64-payload (PNG), но MIME вне whitelist → None (плейсхолдер).
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
    build_violation(doc, _v_with_items(_img_item(width=50)))
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


# --- Нумерация кейсов (паритет с MD/TXT и фронтом) ---

def _case(content, **overrides):
    base = dict(id=f"c_{content}", type="case", content=content)
    base.update(overrides)
    return ViolationContentItemSchema(**base)


def test_cases_are_numbered_sequentially(doc):
    """Подряд идущие кейсы нумеруются: «Кейс 1:», «Кейс 2:»."""
    build_violation(doc, _v_with_items(_case("Первый"), _case("Второй")))
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "Кейс 1:" in text
    assert "Кейс 2:" in text


def test_case_numbering_resets_after_non_case_item(doc):
    """Не-кейс (image/freeText) сбрасывает нумерацию — как в MD/TXT и превью."""
    build_violation(doc, _v_with_items(
        _case("До картинки"),
        _img_item(),
        _case("После картинки"),
    ))
    labels = [
        r.text for p in doc.paragraphs for r in p.runs
        if r.text.strip().startswith("Кейс")
    ]
    assert labels == ["Кейс 1: ", "Кейс 1: "]


def test_case_runs_are_9pt_italic(doc):
    """Кейсы — 9pt курсивом (метка и тело), метка подчёркнута."""
    build_violation(doc, _v_with_items(_case("Содержимое кейса")))
    label_run, body_run = _runs_for_label(doc, "Кейс 1:")
    assert label_run is not None and body_run is not None
    assert label_run.font.size == Pt(Sizes.violation_pt)
    assert label_run.italic is True
    assert label_run.underline is True
    assert body_run.font.size == Pt(Sizes.violation_pt)
    assert body_run.italic is True


def test_free_text_run_is_9pt_italic(doc):
    """freeText — 9pt курсивом (без метки)."""
    item = ViolationContentItemSchema(
        id="ft1", type="freeText", content="Свободный текст",
    )
    build_violation(doc, _v_with_items(item))
    run = next(
        r for p in doc.paragraphs for r in p.runs
        if r.text.strip() == "Свободный текст"
    )
    assert run.font.size == Pt(Sizes.violation_pt)
    assert run.italic is True


def test_image_placeholder_is_9pt_italic(doc):
    """Текстовый плейсхолдер «Изображение: …» — 9pt курсивом."""
    build_violation(doc, _v_with_items(_img_item(url="")))
    run = next(
        r for p in doc.paragraphs for r in p.runs
        if r.text.strip().startswith("Изображение:")
    )
    assert run.font.size == Pt(Sizes.violation_pt)
    assert run.italic is True


def test_empty_case_rendered_and_numbered(doc):
    """Q1: пустой кейс рендерится (метка+пустое тело) и двигает нумерацию.

    Пустой первый кейс занимает «Кейс 1», следующий непустой становится
    «Кейс 2» — единое правило нумерации всех форматов (MD/TXT/превью).
    """
    build_violation(doc, _v_with_items(_case(""), _case("Второй")))
    labels = [
        r.text.strip() for p in doc.paragraphs for r in p.runs
        if r.text.strip().startswith("Кейс")
    ]
    assert labels == ["Кейс 1:", "Кейс 2:"]
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "Кейс 2: Второй" in text


class _StubShape:
    """Минимальный shape для юнит-теста _scale_picture (width/height — int)."""
    def __init__(self, width, height):
        self.width = width
        self.height = height


def test_scale_picture_zero_width_does_not_crash():
    """#7: картинка нулевой ширины не роняет экспорт (нет ZeroDivisionError)."""
    shape = _StubShape(width=0, height=100)
    _scale_picture(shape, width_percent=50)  # не должно бросить
    # Размеры не тронуты — масштабировать нечего.
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
    assert shape.height == shape.width  # пропорции 1:1 сохранены


def test_scale_picture_caps_tall_image_at_height_ceiling():
    """#13: узкая высокая картинка досжимается по потолку высоты (и ширина тоже).

    width=100% дало бы полную полезную ширину, но высота втрое больше →
    выше потолка. Итог: высота = потолок, ширина досжата тем же масштабом,
    пропорция 1:3 сохранена.
    """
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
    """rich-поля (Нарушено/Установлено/Причины/...) режутся на строки тем же
    split_block_segments, что и текстблок (прецедент — _render_textblock):
    каждая верхнеуровневая строка со своим text-align — свой w:p."""

    def test_center_line_becomes_centered_paragraph(self, doc):
        """Строка с text-align: center внутри поля — отдельный center-абзац."""
        build_violation(doc, _v(reasons=ViolationOptionalFieldSchema(
            enabled=True,
            content='<div>обычная</div><div style="text-align: center">по центру</div>',
        )))
        paras = _paras_containing(doc, "по центру")
        assert len(paras) == 1
        assert paras[0].alignment == WD_ALIGN_PARAGRAPH.CENTER

    def test_default_stays_justify(self, doc):
        """Строка без text-align — прежний дефолт justify."""
        build_violation(doc, _v(reasons=ViolationOptionalFieldSchema(
            enabled=True, content="обычный текст без разметки",
        )))
        paras = _paras_containing(doc, "Причины:")
        assert len(paras) == 1
        assert paras[0].alignment == WD_ALIGN_PARAGRAPH.JUSTIFY

    def test_label_only_on_first_paragraph(self, doc):
        """«Причины:» выводится один раз — на первом абзаце; продолжение без метки."""
        build_violation(doc, _v(reasons=ViolationOptionalFieldSchema(
            enabled=True,
            content='<div>первая</div><div style="text-align: center">вторая</div>',
        )))
        label_paras = _paras_containing(doc, "Причины:")
        assert len(label_paras) == 1
        assert "первая" in label_paras[0].text
        second = next(p for p in doc.paragraphs if p.text == "вторая")
        assert "Причины:" not in second.text
        assert second.alignment == WD_ALIGN_PARAGRAPH.CENTER
        # Метка сохраняет текущее форматирование (test_labels_are_underlined,
        # test_reasons_block_stays_12pt_non_italic): подчёркнута, 12pt, без курсива.
        label_run, _ = _runs_for_label(doc, "Причины:")
        assert label_run.underline is True
        assert label_run.font.size == Pt(Sizes.body_pt)
        assert not label_run.italic

    def test_size_italic_preserved_on_continuation(self, doc):
        """9pt+italic у «Нарушено:» сохраняется на 2-м (continuation) абзаце."""
        build_violation(doc, _v(
            violated='<div>первая</div><div style="text-align: right">вторая</div>',
        ))
        second = next(p for p in doc.paragraphs if p.text == "вторая")
        assert second.alignment == WD_ALIGN_PARAGRAPH.RIGHT
        body_run = next(r for r in second.runs if r.text == "вторая")
        assert body_run.font.size == Pt(Sizes.violation_pt)
        assert body_run.italic is True

    def test_no_extra_spacing_between_segments(self, doc):
        """space_after == Pt(0) у всех бывших строк-границ, кроме последней
        (прецедент _render_textblock: строки поля не растягиваются в разные абзацы)."""
        build_violation(doc, _v(
            violated="<div>раз</div><div>два</div><div>три</div>",
        ))
        first = next(p for p in doc.paragraphs if "раз" in p.text)
        second = next(p for p in doc.paragraphs if p.text == "два")
        third = next(p for p in doc.paragraphs if p.text == "три")
        assert first.paragraph_format.space_after == Pt(0)
        assert second.paragraph_format.space_after == Pt(0)
        assert third.paragraph_format.space_after is None


# --- #5: подпись картинки и пункты descriptionList — per-line align ---

class TestImageCaptionPerLineAlignment:
    """Подпись режется тем же split_block_segments/ALIGNMENT_MAP, что и rich-поля
    (общий helper, V14): CENTER остаётся дефолтом (Б-1.5), но per-line
    text-align сегмента его переопределяет — паритет с TestRichFieldPerLineAlignment."""

    def test_segment_with_left_align_overrides_default_center(self, doc):
        """Сегмент без align — дефолт CENTER; сегмент с text-align:left — LEFT."""
        build_violation(doc, _v_with_items(_img_item(
            caption='<div>по центру</div><div style="text-align: left">слева</div>',
        )))
        default_para = next(p for p in doc.paragraphs if p.text == "по центру")
        left_para = next(p for p in doc.paragraphs if p.text == "слева")
        assert default_para.alignment == WD_ALIGN_PARAGRAPH.CENTER
        assert left_para.alignment == WD_ALIGN_PARAGRAPH.LEFT

    def test_no_extra_spacing_between_caption_segments(self, doc):
        """Границы сегментов подписи — без межабзацного просвета, как у rich-полей."""
        build_violation(doc, _v_with_items(_img_item(
            caption="<div>раз</div><div>два</div>",
        )))
        first = next(p for p in doc.paragraphs if p.text == "раз")
        second = next(p for p in doc.paragraphs if p.text == "два")
        assert first.paragraph_format.space_after == Pt(0)
        assert second.paragraph_format.space_after is None


class TestDescriptionListPerLineAlignment:
    """Пункты descriptionList режутся тем же helper'ом: JUSTIFY остаётся
    дефолтом, per-line text-align переопределяет его; маркер (bullet) — только
    на первом сегменте пункта (зеркало «метки на первом абзаце»)."""

    def test_segment_with_right_align_overrides_default_justify(self, doc):
        violation = _v(descriptionList={
            "enabled": True,
            "items": ['<div style="text-align: right">пункт</div>'],
        })
        build_violation(doc, violation)
        para = next(p for p in doc.paragraphs if "пункт" in p.text)
        assert para.alignment == WD_ALIGN_PARAGRAPH.RIGHT

    def test_marker_only_on_first_segment_of_multiline_item(self, doc):
        """Первый сегмент пункта — стиль "List Bullet" (маркер); продолжение —
        обычный абзац без маркера, со своим align."""
        violation = _v(descriptionList={
            "enabled": True,
            "items": ['<div>первая</div><div style="text-align: right">вторая</div>'],
        })
        build_violation(doc, violation)
        first = next(p for p in doc.paragraphs if p.text == "первая")
        second = next(p for p in doc.paragraphs if p.text == "вторая")
        assert first.style.name == "List Bullet"
        assert second.style.name != "List Bullet"
        assert second.alignment == WD_ALIGN_PARAGRAPH.RIGHT
