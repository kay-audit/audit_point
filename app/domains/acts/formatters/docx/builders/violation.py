"""Builder нарушений: Нарушено/Установлено/Причины/...

Заголовок и нумерация нарушения не выводятся: шаблон «Проблема. ПNNNN.»
указывается в блоке пункта (item) и подставляется при сборке в formatter.py.

Дополнительный контент:
- кейсы нумеруются («Кейс 1:», «Кейс 2:»), нумерация сбрасывается после
  не-кейса — та же семантика, что в MD/TXT-форматтерах и превью;
- картинки (data:image-URL) встраиваются inline shape'ом: отдельный абзац
  по центру, подпись курсивом по центру ниже (Б-1.5). Ширина — поле
  `width` (% полезной ширины страницы); 0/не задана — натуральный размер,
  но не шире полезной ширины (Б-1.4). Допустимые форматы — из настроек
  ACTS__IMAGES__ALLOWED_MIME_TYPES (через image_data_url_pattern из act_content,
  тот же источник, что и у валидатора url). Битый/пустой url или формат вне
  whitelist → текстовый плейсхолдер «Изображение: {filename}» (паритет с MD/TXT).
"""
import base64
import binascii
import io
import re
from functools import lru_cache

from docx.document import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt, Twips

from app.domains.acts.formatters.docx.builders.inline import (
    ALIGNMENT_MAP,
    apply_inline_html,
    split_block_segments,
)
from app.domains.acts.formatters.docx.styles import Fonts, Margins, Page, Sizes
from app.domains.acts.schemas.act_content import (
    _acts_settings,
    image_data_url_pattern,
    ViolationContentItemSchema,
    ViolationSchema,
)

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
    """Рендерит нарушение в документ (без заголовка и нумерации)."""
    _labeled_paragraph(
        doc, "Нарушено:", violation.violated,
        italic=True, size_pt=Sizes.violation_pt, rich=True,
    )
    _labeled_paragraph(
        doc, "Установлено:", violation.established,
        italic=True, size_pt=Sizes.violation_pt, rich=True,
    )

    if violation.descriptionList.enabled:
        for item in violation.descriptionList.items:
            bullet = doc.add_paragraph(style="List Bullet")
            bullet.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
            # Task 7: пункт — rich-HTML (rich-редактор); apply_inline_html
            # парсит инлайн-разметку в runs, базовые размер/курсив — прежние
            # свойства run'а (паритет с test_description_list_bullets_9pt_italic),
            # внешний вид plain-пунктов не меняется.
            apply_inline_html(bullet, item, base_size_pt=Sizes.violation_pt, base_italic=True)

    # additionalContent (case / image / freeText). Нумеруются ВСЕ кейсы, включая
    # пустые (метка + пустое тело); счётчик сбрасывается на любом не-кейсе —
    # единое правило нумерации (computeAdditionalContentNumbers, решение Q1),
    # зеркало markdown/text_formatter._add_additional_content.
    if violation.additionalContent.enabled:
        case_number = 1
        for item in violation.additionalContent.items:
            if item.type == "case":
                _labeled_paragraph(
                    doc, f"Кейс {case_number}:", item.content,
                    italic=True, size_pt=Sizes.violation_pt, rich=True,
                )
                case_number += 1
            elif item.type == "image":
                _add_image(doc, item)
                case_number = 1
            elif item.type == "freeText":
                _labeled_paragraph(
                    doc, "", item.content,
                    italic=True, size_pt=Sizes.violation_pt, rich=True,
                )
                case_number = 1

    for label, field in [
        ("Причины:", violation.reasons),
        ("Принятые меры:", violation.measures),
        ("Последствия:", violation.consequences),
        # Канон #11 (violation_fields.LABELS['responsible']) — «Ответственные».
        ("Ответственные:", violation.responsible),
    ]:
        if field.enabled and field.content:
            _labeled_paragraph(doc, label, field.content, rich=True)


def _add_image(doc: Document, item: ViolationContentItemSchema) -> None:
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
        # Task 6: подпись — rich-HTML (rich-редактор), парсится тем же
        # inline-парсером, что и остальные rich-поля нарушения; базовые
        # размер/курсив — прежние свойства run'а (см. тест-паритет
        # test_image_caption_italic_centered_below), внешний вид plain-
        # подписи не меняется.
        cap_para = doc.add_paragraph()
        cap_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
        apply_inline_html(cap_para, item.caption, base_size_pt=Sizes.violation_pt, base_italic=True)


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
    rich=True — тело рендерится через apply_inline_html (inline HTML → runs с
    жирным/курсивом/подчёркиванием) вместо обычного текстового run'а (Task 1.1.2).
    Несколько верхнеуровневых строк поля (per-line text-align, БАГ-4) —
    каждая строка своим w:p со своим выравниванием (прецедент — formatter.
    _render_textblock через тот же split_block_segments/ALIGNMENT_MAP);
    метка выводится только на первом абзаце.
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
        segments = split_block_segments(body)
        if len(segments) <= 1:
            seg = segments[0] if segments else None
            if seg is not None:
                para.alignment = ALIGNMENT_MAP.get(seg.alignment, WD_ALIGN_PARAGRAPH.JUSTIFY)
                apply_inline_html(para, seg.html, base_size_pt=size_pt, base_italic=italic)
            else:
                apply_inline_html(para, body, base_size_pt=size_pt, base_italic=italic)
            return
        paras = [para]
        para.alignment = ALIGNMENT_MAP.get(segments[0].alignment, WD_ALIGN_PARAGRAPH.JUSTIFY)
        apply_inline_html(para, segments[0].html, base_size_pt=size_pt, base_italic=italic)
        for seg in segments[1:]:
            extra = doc.add_paragraph()
            extra.alignment = ALIGNMENT_MAP.get(seg.alignment, WD_ALIGN_PARAGRAPH.JUSTIFY)
            apply_inline_html(extra, seg.html, base_size_pt=size_pt, base_italic=italic)
            paras.append(extra)
        for p_ in paras[:-1]:
            # Бывшие границы строк поля: без межабзацного просвета (прецедент _render_textblock).
            p_.paragraph_format.space_after = Pt(0)
        return
    body_run = para.add_run(body)
    body_run.font.name = Fonts.main
    body_run.font.size = Pt(size_pt)
    if italic:
        body_run.italic = True
