"""Тесты builder'а нарушений (блочная модель).

Единый цикл по полям реестра в порядке fieldOrder: метка видимого поля +
блоки по порядку. Первый text-блок идёт inline с меткой («Метка: текст»);
у полей с labeled=False метки нет вовсе — только контент. Размер/курсив
поля — из флага small дескриптора (9pt курсив / 12pt без).
"""
import base64

from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Emu, Pt, Twips

from app.domains.acts.formatters.docx.builders.violation import (
    _USABLE_HEIGHT_TWIPS,
    _USABLE_WIDTH_TWIPS,
    _image_bytes,
    _scale_picture,
    _transcode_to_png,
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
_PNG_1PX = base64.b64decode(_PNG_1PX_B64)
_IMAGE_ID = "img-1"

# Карта предзагруженных байт, которую экспорт передаёт builder'у: блок
# нарушения хранит только image_id, байты приезжают отдельно.
_IMAGES = {_IMAGE_ID: {"data": _PNG_1PX, "mime_type": "image/png"}}


def _text_block(content, bid="text_1_a"):
    return {"id": bid, "type": "text", "content": content}


def _image_block(**overrides):
    base = dict(
        id="image_1_b", type="image", image_id=_IMAGE_ID,
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
    build_violation(doc, _v(), _IMAGES)
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
    build_violation(doc, _v(), _IMAGES)
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
    build_violation(doc, _v(), _IMAGES)
    for label in ("Причины:", "Принятые меры:", "Последствия:", "Ответственные:"):
        label_run, body_run = _runs_for_label(doc, label)
        assert label_run is not None and body_run is not None
        assert label_run.font.size == Pt(Sizes.body_pt)
        assert not label_run.italic
        assert body_run.font.size == Pt(Sizes.body_pt)
        assert not body_run.italic


def test_description_is_12pt_non_italic(doc):
    """Описание — обычные 12pt с меткой (решение владельца)."""
    build_violation(doc, _v(
        description={"enabled": True, "blocks": [_text_block("Опис")]},
    ))
    label_run, body_run = _runs_for_label(doc, "Описание:")
    assert label_run is not None, "метка Описание: не найдена"
    assert label_run.font.size == Pt(Sizes.body_pt)
    assert not label_run.italic


# --- labeled=False: CodeMining/ProcessMining/Дополнительный контент ---


def _unlabeled_violation():
    """Нарушение с заполненными полями без метки (labeled=False)."""
    return _v(
        codeMining={"enabled": True, "blocks": [_text_block("CM-контент")]},
        processMining={"enabled": True, "blocks": [_text_block("PM-контент")]},
        additionalContent={"enabled": True, "blocks": [_text_block("Доп-контент")]},
    )


def test_unlabeled_fields_render_content_without_label(doc):
    """CM/PM/доп. контент выводят только контент — заголовка-метки нет."""
    build_violation(doc, _unlabeled_violation(), _IMAGES)
    text = "\n".join(p.text for p in doc.paragraphs)
    for marker in ("CM-контент", "PM-контент", "Доп-контент"):
        assert marker in text
    for label in ("CodeMining", "ProcessMining", "Дополнительный контент"):
        assert label not in text, f"метка {label!r} не должна выводиться в DOCX"


def test_unlabeled_fields_are_12pt_non_italic(doc):
    """Контент полей без метки — обычный текст листа, включая доп. контент.

    Регрессия решения владельца: additionalContent выведен из 9pt-группы
    (small=False) — раньше он рендерился 9pt курсивом.
    """
    build_violation(doc, _unlabeled_violation(), _IMAGES)
    for marker in ("CM-контент", "PM-контент", "Доп-контент"):
        run = next(
            r for p in doc.paragraphs for r in p.runs if marker in r.text
        )
        assert run.font.size == Pt(Sizes.body_pt), f"{marker}: ожидался 12pt"
        assert not run.italic, f"{marker}: курсив не ожидается"


def test_unlabeled_field_is_not_underlined(doc):
    """Без метки нет и подчёркнутого label-run'а — контент обычным начертанием."""
    build_violation(doc, _unlabeled_violation(), _IMAGES)
    run = next(r for p in doc.paragraphs for r in p.runs if "CM-контент" in r.text)
    assert not run.underline


def test_unlabeled_field_with_table_first_renders_no_label(doc):
    """Первый блок — таблица: у поля без метки не появляется и пустой абзац-метка."""
    v = _v(codeMining={"enabled": True, "blocks": [
        _table_block([["A"]]),
        _text_block("после таблицы"),
    ]})
    build_violation(doc, v, _IMAGES)
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "CodeMining" not in text
    assert "после таблицы" in text
    assert len(doc.tables) == 1


def test_unlabeled_field_multiple_text_blocks_all_rendered(doc):
    """Все text-блоки поля без метки рендерятся по порядку (первый не «съеден»)."""
    v = _v(processMining={"enabled": True, "blocks": [
        _text_block("Первый PM", "text_1"),
        _text_block("Второй PM", "text_2"),
    ]})
    build_violation(doc, v, _IMAGES)
    text = "\n".join(p.text for p in doc.paragraphs)
    assert text.index("Первый PM") < text.index("Второй PM")


def test_mandatory_labels_shown_when_empty(doc):
    """#14: Нарушено/Установлено — метка даже при пустом контейнере."""
    v = _v(
        violated={"enabled": True, "blocks": []},
        established={"enabled": True, "blocks": []},
    )
    build_violation(doc, v, _IMAGES)
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "Нарушено:" in text
    assert "Установлено:" in text


def test_disabled_optional_fields_not_rendered(doc):
    v = _v(reasons={"enabled": False, "blocks": [_text_block("скрытая")]})
    build_violation(doc, v, _IMAGES)
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "скрытая" not in text
    assert "Причины:" not in text


def test_enabled_empty_optional_field_not_rendered(doc):
    v = _v(reasons={"enabled": True, "blocks": []})
    build_violation(doc, v, _IMAGES)
    assert "Причины:" not in "\n".join(p.text for p in doc.paragraphs)


def test_field_order_respected(doc):
    """fieldOrder меняет порядок секций в DOCX."""
    order = list(VIOLATION_FIELD_KEYS)
    order.remove("responsible")
    order.insert(0, "responsible")
    build_violation(doc, _v(fieldOrder=order), _IMAGES)
    text = "\n".join(p.text for p in doc.paragraphs)
    assert text.index("Иванов И.И.") < text.index("Текст нарушения")


def test_multiple_text_blocks_render_in_order(doc):
    v = _v(reasons={"enabled": True, "blocks": [
        _text_block("Первый абзац", "text_1"),
        _text_block("Второй абзац", "text_2"),
    ]})
    build_violation(doc, v, _IMAGES)
    text = "\n".join(p.text for p in doc.paragraphs)
    assert text.index("Первый абзац") < text.index("Второй абзац")
    # Метка одна — на первом блоке.
    assert text.count("Причины:") == 1


def test_violation_has_no_header_paragraph(doc):
    """Нет абзаца, начинающегося со слова «Проблема»."""
    build_violation(doc, _v(), _IMAGES)
    assert not any(p.text.strip().startswith("Проблема") for p in doc.paragraphs)


def test_violation_has_no_numbering(doc):
    """Ни в одном абзаце нарушения нет numPr (списки ul/ol — отдельные тесты)."""
    build_violation(doc, _v(), _IMAGES)
    for p in doc.paragraphs:
        p_pr = p._p.find(qn("w:pPr"))
        if p_pr is None:
            continue
        assert p_pr.find(qn("w:numPr")) is None


def test_labels_are_underlined(doc):
    build_violation(doc, _v(), _IMAGES)
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
    build_violation(doc, v, _IMAGES)
    assert len(doc.tables) == 1
    cells = [c.text for row in doc.tables[0].rows for c in row.cells]
    assert "Запрос" in cells and "SELECT 1" in cells


def test_field_with_table_first_renders_label_alone(doc):
    """Если первый блок — таблица, метка выводится отдельным абзацем."""
    v = _v(reasons={"enabled": True, "blocks": [
        _table_block([["A"]]),
        _text_block("после таблицы"),
    ]})
    build_violation(doc, v, _IMAGES)
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "Причины:" in text
    assert "после таблицы" in text
    assert len(doc.tables) == 1


def test_field_starting_with_list_renders_label_alone(doc):
    """Первая строка поля — список: метка отдельным абзацем, пункты следом.

    Сквозная проверка через build_violation (в test_rich_lists тот же случай
    проверяется на уровне _labeled_paragraph, с нумерацией абзацев).
    """
    v = _v(reasons={"enabled": True, "blocks": [
        _text_block("<ul><li>раз</li><li>два</li></ul><div>хвост</div>"),
    ]})
    build_violation(doc, v, _IMAGES)
    texts = [p.text for p in doc.paragraphs]
    idx = next(i for i, t in enumerate(texts) if t.strip() == "Причины:")
    assert texts[idx + 1:idx + 4] == ["раз", "два", "хвост"]


def test_empty_table_block_renders_nothing(doc):
    """Пустая сетка не создаёт docx-таблицы (build_table no-op)."""
    v = _v(codeMining={"enabled": True, "blocks": [
        {"id": "table_1_c", "type": "table", "table": {"grid": [], "colWidths": []}},
    ]})
    build_violation(doc, v, _IMAGES)
    assert len(doc.tables) == 0


# --- Картинки (M.2 / H4) ---


def _v_with_blocks(*blocks):
    return _v(additionalContent={"enabled": True, "blocks": list(blocks)})


def test_image_embedded_as_inline_shape(doc):
    """PNG 1×1 из data-URL встраивается в документ как inline shape."""
    build_violation(doc, _v_with_blocks(_image_block()), _IMAGES)
    assert len(doc.inline_shapes) == 1


def test_image_paragraph_centered(doc):
    """Абзац с картинкой выровнен по центру (Б-1.5)."""
    build_violation(doc, _v_with_blocks(_image_block()), _IMAGES)
    pic_para = next(
        p for p in doc.paragraphs if p._p.findall(".//" + qn("w:drawing"))
    )
    assert pic_para.alignment == WD_ALIGN_PARAGRAPH.CENTER


def test_image_caption_italic_centered_below(doc):
    """Подпись — отдельный абзац под картинкой: курсив, по центру."""
    build_violation(doc, _v_with_blocks(_image_block(caption="Скриншот экрана")), _IMAGES)
    cap_para = next(p for p in doc.paragraphs if "Скриншот экрана" in p.text)
    assert cap_para.alignment == WD_ALIGN_PARAGRAPH.CENTER
    cap_runs = [r for r in cap_para.runs if r.text.strip()]
    assert all(r.italic for r in cap_runs)
    assert all(r.font.size == Pt(Sizes.violation_pt) for r in cap_runs)


def test_image_caption_bold_html_renders_bold_run(doc):
    """Task 6: жирный фрагмент rich-подписи → bold run (не текст тегов)."""
    build_violation(doc, _v_with_blocks(_image_block(caption="<b>важно</b>: подпись")), _IMAGES)
    cap_para = next(p for p in doc.paragraphs if "подпись" in p.text)
    assert "<b>" not in cap_para.text
    bold_run = next(r for r in cap_para.runs if r.text.strip() == "важно")
    assert bold_run.bold is True
    assert bold_run.italic is True
    assert bold_run.font.size == Pt(Sizes.violation_pt)


def test_broken_bytes_render_placeholder(doc):
    """Байты не картинка → текстовый плейсхолдер «Изображение: …», без исключения."""
    build_violation(doc, _v_with_blocks(
        _image_block(image_id="broken"),
    ), {"broken": {"data": b"ne-kartinka", "mime_type": "image/png"}})
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "Изображение: screen.png" in text
    assert len(doc.inline_shapes) == 0


def test_empty_image_id_renders_placeholder(doc):
    """Пустой image_id (черновик без содержимого) → плейсхолдер (паритет с MD/TXT)."""
    build_violation(doc, _v_with_blocks(
        _image_block(image_id="", filename="ext.png"),
    ), _IMAGES)
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "Изображение: ext.png" in text
    assert len(doc.inline_shapes) == 0


def test_dangling_image_id_renders_placeholder(doc):
    """image_id есть, а байт в карте нет (картинка собрана GC) → плейсхолдер."""
    build_violation(doc, _v_with_blocks(_image_block(image_id="ushla")), _IMAGES)
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "Изображение: screen.png" in text
    assert len(doc.inline_shapes) == 0


def test_image_placeholder_is_9pt_italic(doc):
    """Текстовый плейсхолдер «Изображение: …» — 9pt курсивом."""
    build_violation(doc, _v_with_blocks(_image_block(image_id="")), _IMAGES)
    run = next(
        r for p in doc.paragraphs for r in p.runs
        if r.text.strip().startswith("Изображение:")
    )
    assert run.font.size == Pt(Sizes.violation_pt)
    assert run.italic is True


# --- Разрешение байт по image_id и перекодировка форматов ---


def test_image_bytes_resolves_from_map():
    """Байты берутся из предзагруженной карты по image_id."""
    assert _image_bytes(_IMAGE_ID, _IMAGES) == _PNG_1PX


def test_image_bytes_none_for_missing_or_empty():
    """Пустой id, отсутствующая карта и висячая ссылка дают None (не исключение)."""
    assert _image_bytes("", _IMAGES) is None
    assert _image_bytes(_IMAGE_ID, None) is None
    assert _image_bytes("net-takogo", _IMAGES) is None
    assert _image_bytes(_IMAGE_ID, {_IMAGE_ID: {"mime_type": "image/png"}}) is None


def test_webp_is_embedded_via_png_transcode(doc):
    """WebP python-docx не встраивает — builder перекодирует его в PNG.

    Без перекодировки разрешённый настройками формат молча превращался бы
    в текстовый плейсхолдер (фронт кодирует скриншоты именно в WebP).
    """
    import io as _io

    from PIL import Image

    buf = _io.BytesIO()
    Image.new("RGB", (4, 4), (10, 20, 30)).save(buf, format="WEBP")

    build_violation(
        doc, _v_with_blocks(_image_block(image_id="w1")),
        {"w1": {"data": buf.getvalue(), "mime_type": "image/webp"}},
    )
    assert len(doc.inline_shapes) == 1
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "Изображение: screen.png" not in text


def test_transcode_returns_none_for_non_image():
    """Не-картинка перекодировке не поддаётся — None, без исключения."""
    assert _transcode_to_png(b"not-an-image-at-all") is None


def test_image_width_50_percent_is_half_usable_width(doc):
    """width=50 → ширина shape ≈ 5173 твип (половина полезной ширины)."""
    build_violation(doc, _v_with_blocks(_image_block(width=50)), _IMAGES)
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
