"""Builder нарушений — блочная модель.

Заголовок и нумерация нарушения не выводятся: шаблон «Проблема. ПNNNN.»
указывается в блоке пункта (item) и подставляется при сборке в formatter.py.

Единый цикл: поля в порядке fieldOrder нарушения (или стандартном, см.
violation_fields.ordered_fields) → у включённого поля метка + блоки по
порядку. Размер шрифта поля — из флага small дескриптора (9pt/12pt), курсив
следует той же группе. Блоки:
- text — rich-HTML через общий render_block_segments (первый text-блок
  включённого поля идёт inline с меткой — привычный вид «Метка: текст»);
- image — inline shape: отдельный абзац по центру, подпись курсивом по
  центру ниже (Б-1.5). Ширина — поле `width` (% полезной ширины страницы);
  0 — натуральный размер, но не шире полезной ширины (Б-1.4). Допустимые
  форматы — из ACTS__IMAGES__ALLOWED_MIME_TYPES (image_data_url_pattern,
  тот же источник, что у валидатора url). Битый/пустой url → текстовый
  плейсхолдер «Изображение: {filename}» (паритет с MD/TXT);
- table — обычная таблица через общий build_table (та же графика, что у
  таблиц-узлов дерева).
"""
import base64
import binascii
import io
import re
from functools import lru_cache

from docx.document import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt, Twips

from app.domains.acts.formatters.docx.builders.inline import render_block_segments
from app.domains.acts.formatters.docx.builders.tables import build_table
from app.domains.acts.formatters.docx.styles import Fonts, Margins, Page, Sizes
from app.domains.acts.schemas.act_content import (
    _acts_settings,
    image_data_url_pattern,
    ViolationImageBlockSchema,
    ViolationSchema,
)
from app.domains.acts.violation_fields import ordered_fields

# Полезная ширина страницы (A4 минус поля) в твипах — потолок ширины картинок.
_USABLE_WIDTH_TWIPS = Page.width_twips - Margins.left - Margins.right
# Полезная высота страницы (A4 минус верхнее/нижнее поле) в твипах — база
# потолка высоты картинок (#13).
_USABLE_HEIGHT_TWIPS = Page.height_twips - Margins.top - Margins.bottom


@lru_cache(maxsize=8)
def _data_url_re_for(pattern: str) -> re.Pattern:
    """regex выделения base64-payload для данного whitelist-паттерна."""
    return re.compile("^" + pattern + r"(?P<payload>.+)$", re.IGNORECASE | re.DOTALL)


def _data_url_re() -> re.Pattern:
    """data:image-URL regex с выделением payload по живому whitelist'у настроек.

    Whitelist форматов берётся из ACTS__IMAGES__ALLOWED_MIME_TYPES (через
    image_data_url_pattern) — тот же источник, что и у валидатора схемы, чтобы
    форматы не разъезжались между валидацией и сборкой DOCX.
    """
    return _data_url_re_for(image_data_url_pattern())


def build_violation(doc: Document, violation: ViolationSchema) -> None:
    """Рендерит нарушение в документ (без заголовка и нумерации).

    Правила видимости — зеркало MD/TXT (violation_render.format_violation):
    mandatory-поля выводят метку даже при пустом контейнере (#14); остальные
    поля — только при enabled и хотя бы одном блоке.
    """
    for field in ordered_fields({"fieldOrder": violation.fieldOrder}):
        container = getattr(violation, field.key)
        blocks = list(container.blocks)

        if not field.mandatory and (not container.enabled or not blocks):
            continue

        size_pt = Sizes.violation_pt if field.small else Sizes.body_pt
        italic = field.small

        # Привычный вид «Метка: текст»: первый text-блок идёт inline с меткой;
        # если первый блок — картинка/таблица (или блоков нет) — метка отдельным
        # абзацем, блоки следом.
        label = f"{field.label}:"
        if blocks and blocks[0].type == "text":
            first = blocks.pop(0)
            _labeled_paragraph(
                doc, label, first.content,
                italic=italic, size_pt=size_pt, rich=True,
            )
        else:
            _labeled_paragraph(doc, label, "", italic=italic, size_pt=size_pt)

        for block in blocks:
            if block.type == "text":
                if block.content:
                    render_block_segments(
                        doc, block.content,
                        base_size_pt=size_pt, base_italic=italic,
                        default_alignment=WD_ALIGN_PARAGRAPH.JUSTIFY,
                    )
            elif block.type == "image":
                _add_image(doc, block)
            elif block.type == "table":
                build_table(doc, block.table)


def _add_image(doc: Document, item: ViolationImageBlockSchema) -> None:
    """Картинка: абзац по центру; подпись курсивом по центру ниже (Б-1.5).

    Не удалось встроить (битый base64, пустой url, формат без поддержки
    в python-docx) → текстовый плейсхолдер «Изображение: {filename}».
    Подпись выводится в обоих случаях.
    """
    embedded = False
    data = _decode_data_url(item.url)
    if data is not None:
        para = doc.add_paragraph()
        para.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = para.add_run()
        try:
            shape = run.add_picture(io.BytesIO(data))
        except Exception:
            # Байты не распознаны как картинка (обрезанный файл и т.п.) —
            # убираем пустой абзац и откатываемся к плейсхолдеру. Экспорт не
            # должен падать из-за одной битой картинки.
            para._p.getparent().remove(para._p)
        else:
            _scale_picture(shape, item.width)
            embedded = True

    if not embedded:
        _labeled_paragraph(
            doc, "", f"Изображение: {item.filename}",
            italic=True, size_pt=Sizes.violation_pt,
        )

    if item.caption:
        # Task 6 + #5: подпись — rich-HTML; общий render_block_segments режет
        # её на строки per-line align, дефолт CENTER (Б-1.5) сохраняется для
        # сегмента без text-align (см. тест-паритет
        # test_image_caption_italic_centered_below).
        render_block_segments(
            doc, item.caption,
            base_size_pt=Sizes.violation_pt, base_italic=True,
            default_alignment=WD_ALIGN_PARAGRAPH.CENTER,
        )


def _decode_data_url(url: str) -> bytes | None:
    """Достаёт байты картинки из data:image-URL; None — если url не пригоден."""
    if not url:
        return None
    match = _data_url_re().match(url)
    if not match:
        return None
    try:
        return base64.b64decode(match.group("payload"), validate=True)
    except (binascii.Error, ValueError):
        return None


def _scale_picture(shape, width_percent: int, max_height_percent: int | None = None) -> None:
    """Подгоняет размер inline shape с сохранением пропорций (Б-1.4, #13).

    width_percent > 0 — процент полезной ширины страницы; 0 — натуральный
    размер с потолком по полезной ширине. После расчёта ширины высота
    ограничивается потолком (доля полезной высоты листа A4,
    image_max_height_percent): если картинка выше потолка — она пропорционально
    досжимается И по высоте, И по ширине (единый масштаб). Потолок применяется
    во всех ветках, включая явную ширину и натуральный размер (паритет с превью).

    max_height_percent — доля полезной высоты (%). None → берётся из настроек
    (ACTS__IMAGES__IMAGE_MAX_HEIGHT_PERCENT); юнит-тесты передают его явно.

    Картинка нулевой ширины/высоты (битый/вырожденный shape, который
    python-docx всё же встроил) не масштабируется — иначе деление на ноль
    уронило бы весь экспорт DOCX. Оставляем натуральный размер.
    """
    orig_width = int(shape.width)
    orig_height = int(shape.height)
    if not orig_width or not orig_height:
        return

    usable_emu = int(Twips(_USABLE_WIDTH_TWIPS))
    if width_percent:
        target_width = usable_emu * width_percent // 100
    elif orig_width > usable_emu:
        target_width = usable_emu
    else:
        target_width = orig_width
    target_height = round(orig_height * target_width / orig_width)

    if max_height_percent is None:
        max_height_percent = _acts_settings().images.image_max_height_percent
    ceiling_emu = int(Twips(_USABLE_HEIGHT_TWIPS)) * max_height_percent // 100
    if ceiling_emu and target_height > ceiling_emu:
        # Досжать пропорционально: и высоту, и ширину (единый min-scale).
        target_width = round(target_width * ceiling_emu / target_height)
        target_height = ceiling_emu

    shape.width = target_width
    shape.height = target_height


def _labeled_paragraph(
    doc: Document,
    label: str,
    body: str,
    *,
    italic: bool = False,
    size_pt: int = Sizes.body_pt,
    rich: bool = False,
) -> None:
    """Параграф «Label_underlined body_plain».

    italic ставится и на метку, и на тело; size_pt задаёт размер обоих run'ов.
    rich=True — тело рендерится через render_block_segments (общий helper,
    V14) вместо обычного текстового run'а (Task 1.1.2). Несколько
    верхнеуровневых строк поля (per-line text-align, БАГ-4) — каждая строка
    своим w:p со своим выравниванием; метка выводится только на первом
    абзаце (para передаётся helper'у как first_paragraph).
    """
    if not body and not label:
        return
    para = doc.add_paragraph()
    para.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    if label:
        label_run = para.add_run(label + " ")
        label_run.font.name = Fonts.main
        label_run.font.size = Pt(size_pt)
        label_run.underline = True
        if italic:
            label_run.italic = True
    if rich:
        render_block_segments(
            doc, body,
            base_size_pt=size_pt, base_italic=italic,
            default_alignment=WD_ALIGN_PARAGRAPH.JUSTIFY,
            first_paragraph=para,
        )
        return
    body_run = para.add_run(body)
    body_run.font.name = Fonts.main
    body_run.font.size = Pt(size_pt)
    if italic:
        body_run.italic = True
