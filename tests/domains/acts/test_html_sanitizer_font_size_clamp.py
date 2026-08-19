"""TB-6: мягкий кламп font-size бэк-санитайзера к [min,max] из настроек.

Единица контракта — ПУНКТЫ: редактор эмитит pt, границы настроек в pt, и
ровно это число уходит в Word. px редактор не создаёт — он приходит из прямого
API/внешней вставки и КОНВЕРТИРУЕТСЯ в pt (×0.75), а не вырезается: заданный
автором кегль не должен молча теряться. Прочие единицы (em/%/rem) убираются
целиком — относительный размер нечем клампить, и превью↔DOCX разошлись бы.

После вырезания formatting-объекта (Task 5) серверная схема размер шрифта не
валидирует. Границу держат тулбар (фронт) и числовой пост-проход санитайзера
(_FontSizeClampFilter). Дефолты границ — 8/72 pt
(TextblocksSettings.font_size_min/max).
"""
from app.domains.acts.settings import ActsSettings, TextblocksSettings
from app.domains.acts.utils.html_sanitizer import sanitize_html


def test_font_size_above_max_clamped_to_max():
    out = sanitize_html('<span style="font-size: 99pt">крупно</span>')
    assert "72pt" in out
    assert "99pt" not in out


def test_font_size_below_min_clamped_to_min():
    out = sanitize_html('<span style="font-size: 4pt">мелко</span>')
    assert "8pt" in out
    assert "4pt" not in out


def test_font_size_in_range_untouched():
    """Валидный размер в pt остаётся дословным (не переформатируется)."""
    out = sanitize_html('<span style="font-size: 20pt">норма</span>')
    assert "font-size: 20pt" in out


def test_font_size_at_boundaries_untouched():
    for size in (8, 72):
        out = sanitize_html(f'<span style="font-size: {size}pt">г</span>')
        assert f"{size}pt" in out


def test_clamp_preserves_other_css_properties():
    """Кламп трогает только font-size — соседние свойства span остаются."""
    out = sanitize_html('<span style="font-size: 120pt; color: red">т</span>')
    assert "72pt" in out
    assert "120pt" not in out
    assert "color" in out and "red" in out


def test_px_converted_to_pt():
    """Внешняя вставка в px не вырезается, а конвертируется: 20px → 15pt."""
    out = sanitize_html('<span style="font-size: 20px">крупно</span>')
    assert "font-size: 15pt" in out
    assert "20px" not in out


def test_px_converted_then_clamped():
    """Сначала px→pt, потом кламп: 200px = 150pt → 72pt; 4px = 3pt → 8pt."""
    assert "font-size: 72pt" in sanitize_html('<span style="font-size: 200px">a</span>')
    assert "font-size: 8pt" in sanitize_html('<span style="font-size: 4px">b</span>')


def test_px_conversion_keeps_fractional_pt():
    """Некруглый результат конвертации сохраняется дробным (18px → 13.5pt)."""
    out = sanitize_html('<span style="font-size: 18px">т</span>')
    assert "font-size: 13.5pt" in out


def test_relative_font_size_stripped():
    """Относительный размер (em/%/rem/без единицы) клампу не поддаётся и
    рассогласовал бы превью↔DOCX — объявление убирается целиком, текст остаётся."""
    for value in ("1.5em", "150%", "3rem", "24"):
        out = sanitize_html(f'<span style="font-size: {value}">т</span>')
        assert "font-size" not in out
        assert "т" in out


def test_relative_font_size_stripped_keeps_siblings():
    """Убирается только неподдержанный font-size; соседние свойства остаются."""
    out = sanitize_html('<span style="font-size: 1.5em; color: red">т</span>')
    assert "font-size" not in out and "1.5em" not in out
    assert "color" in out and "red" in out
    assert "т" in out


def test_clamp_respects_settings_bounds(monkeypatch):
    """Границы берутся из настроек, не захардкожены: сузим диапазон до [10,24]."""
    import app.domains.acts.utils.html_sanitizer as mod

    narrow = ActsSettings(textblocks=TextblocksSettings(font_size_min=10, font_size_max=24))
    monkeypatch.setattr(mod, "_acts_settings", lambda: narrow)

    assert "24pt" in sanitize_html('<span style="font-size: 72pt">т</span>')
    assert "10pt" in sanitize_html('<span style="font-size: 8pt">т</span>')
    assert "18pt" in sanitize_html('<span style="font-size: 18pt">т</span>')


def test_multiple_spans_each_clamped():
    out = sanitize_html(
        '<span style="font-size: 200pt">a</span>'
        '<span style="font-size: 2pt">b</span>'
    )
    # Полные объявления, чтобы «2pt» не совпадал как подстрока «72pt».
    assert "font-size: 72pt" in out
    assert "font-size: 8pt" in out
    assert "font-size: 200pt" not in out
    assert "font-size: 2pt" not in out


# ── Пункт списка несёт собственный font-size (размер маркера) ────────────────
#
# ::marker наследует кегль от САМОГО <li>, а не от вложенного span, поэтому
# размер целиком покрытого пункта редактор ставит на <li>. Раньше style у <li>
# не был разрешён вовсе — размер жил только в живом DOM и пропадал на
# сохранении, а маркер после перезагрузки возвращался к базовому кеглю.
# В DOCX это же значение печатает метку абзаца (render_block_segments).

def test_list_item_keeps_own_font_size():
    out = sanitize_html('<ul><li style="font-size: 18pt">пункт</li></ul>')
    assert 'font-size: 18pt' in out


def test_list_item_font_size_clamped_and_converted():
    assert "72pt" in sanitize_html('<ul><li style="font-size: 500pt">п</li></ul>')
    # px из внешней вставки приводится к пунктам той же конвертацией, что у span.
    assert "15pt" in sanitize_html('<ul><li style="font-size: 20px">п</li></ul>')


def test_list_item_keeps_text_align_alongside_size():
    out = sanitize_html(
        '<ul><li style="text-align: center; font-size: 14pt">п</li></ul>'
    )
    assert "text-align: center" in out
    assert "font-size: 14pt" in out


def test_list_item_drops_other_properties():
    """color/background у <li> DOCX не читает — оставлять их значит развести
    превью и выгрузку."""
    out = sanitize_html('<ul><li style="color: red">п</li></ul>')
    assert "color" not in out
    assert "style" not in out


def test_block_tags_still_drop_font_size():
    """Послабление адресное: div/p по-прежнему несут ТОЛЬКО text-align."""
    out = sanitize_html('<p style="font-size: 30pt; text-align: center">абзац</p>')
    assert "font-size" not in out
    assert "text-align: center" in out


def test_rich_sanitizer_mirrors_list_item_policy():
    """nh3-ветка (rich-поля нарушения) обязана вести себя как bleach-ветка."""
    from app.domains.acts.utils.html_sanitizer import sanitize_rich_html

    out = sanitize_rich_html('<ul><li style="color: red; font-size: 500pt">п</li></ul>')
    assert "72pt" in out
    assert "color" not in out
    assert "font-size" not in sanitize_rich_html('<p style="font-size: 30pt">а</p>')
