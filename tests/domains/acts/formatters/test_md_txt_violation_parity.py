"""Тест-фиксация семантики нарушений в MD/TXT (блочная модель).

Единый цикл по полям реестра в порядке fieldOrder (или стандартном):
метка видимого поля + блоки по порядку. Правила: mandatory-поля
(Нарушено/Установлено) выводят метку даже при пустом контейнере (#14);
выключенное или пустое опциональное поле не рендерится; поля с
labeled=False (CM/PM/доп. контент) выводят только контент; text-блок идёт
через rich-конвертер (HTML→MD / HTML→plain); картинка — формат-специфично
(#16, MD — markdown-разметка, TXT — строка «Изображение: …»); таблица —
pipe-table в MD и ASCII в TXT (та же графика, что у таблиц-узлов).
Если кто-то «оптимизирует» вывод — эти тесты укажут на дрейф.
"""
from app.domains.acts.formatters.markdown_formatter import MarkdownFormatter
from app.domains.acts.formatters.text_formatter import TextFormatter
from app.domains.acts.settings import ActsSettings
from app.domains.acts.violation_fields import VIOLATION_FIELD_KEYS


def _md() -> MarkdownFormatter:
    return MarkdownFormatter(settings=None, acts_settings=ActsSettings())


def _txt() -> TextFormatter:
    return TextFormatter(settings=None, acts_settings=ActsSettings())


def _text_block(content: str, bid: str = "text_1_a") -> dict:
    return {"id": bid, "type": "text", "content": content}


# Байты картинки живут отдельно от контента: блок хранит image_id, а карту
# предзагруженных байт форматтеру передаёт экспорт. b"\x00\x00\x00" выбрано
# так, чтобы base64 дал ровно "AAAA" — ассерты остались читаемыми.
_IMAGE_ID = "img-1"
_IMAGES = {_IMAGE_ID: {"data": b"\x00\x00\x00", "mime_type": "image/png"}}


def _image_block(**kw) -> dict:
    return {"id": "image_1_b", "type": "image",
            "image_id": kw.get("image_id", ""), "caption": kw.get("caption", ""),
            "filename": kw.get("filename", ""), "width": kw.get("width", 0)}


def _table_block(grid_texts: list[list[str]]) -> dict:
    return {
        "id": "table_1_c", "type": "table",
        "table": {
            "grid": [[{"content": c} for c in row] for row in grid_texts],
            "colWidths": [],
        },
    }


def _violation(**field_overrides) -> dict:
    """Нарушение с дефолтными контейнерами; поля переопределяются kwargs."""
    v = {"id": "v1", "nodeId": "n1", "fieldOrder": None}
    for key in VIOLATION_FIELD_KEYS:
        v[key] = {"enabled": key in ("violated", "established"), "blocks": []}
    v["violated"]["blocks"] = [_text_block("Нарушено-X")]
    v["established"]["blocks"] = [_text_block("Установлено-Y")]
    v.update(field_overrides)
    return v


# --- Базовый рендер и правила видимости ---


def test_markdown_renders_labels_and_text_blocks():
    out = _md()._format_violation(_violation())
    assert "**Нарушено:**" in out
    assert "Нарушено-X" in out
    assert "**Установлено:**" in out
    assert "Установлено-Y" in out


def test_disabled_field_not_rendered():
    v = _violation(reasons={"enabled": False, "blocks": [_text_block("скрытая")]})
    assert "скрытая" not in _md()._format_violation(v)
    assert "скрытая" not in _txt()._format_violation(v)


def test_enabled_empty_field_not_rendered():
    """Включённое, но пустое опциональное поле не даёт метки."""
    v = _violation(reasons={"enabled": True, "blocks": []})
    assert "Причины" not in _md()._format_violation(v)
    assert "Причины" not in _txt()._format_violation(v)


def test_required_labels_shown_when_empty():
    """#14: Нарушено/Установлено — метка даже при пустом контейнере."""
    v = _violation()
    v["violated"]["blocks"] = []
    v["established"]["blocks"] = []
    md = _md()._format_violation(v)
    assert "**Нарушено:**" in md and "**Установлено:**" in md
    txt = _txt()._format_violation(v)
    assert "Нарушено:" in txt and "Установлено:" in txt


def test_default_field_order_reasons_before_consequences():
    """Стандартный порядок: Причины < Принятые меры < Последствия."""
    v = _violation(
        reasons={"enabled": True, "blocks": [_text_block("ПРИЧИНА-X")]},
        measures={"enabled": True, "blocks": [_text_block("МЕРА-Y")]},
        consequences={"enabled": True, "blocks": [_text_block("ПОСЛЕДСТВИЕ-Z")]},
    )
    for out in (_md()._format_violation(v), _txt()._format_violation(v)):
        assert out.index("ПРИЧИНА-X") < out.index("МЕРА-Y") < out.index("ПОСЛЕДСТВИЕ-Z")


def test_field_order_respected():
    """fieldOrder меняет порядок секций в экспорте."""
    order = list(VIOLATION_FIELD_KEYS)
    order.remove("consequences")
    order.insert(0, "consequences")
    v = _violation(
        fieldOrder=order,
        consequences={"enabled": True, "blocks": [_text_block("ПОСЛЕДСТВИЕ-Z")]},
    )
    out = _md()._format_violation(v)
    assert out.index("ПОСЛЕДСТВИЕ-Z") < out.index("Нарушено-X")


def test_invalid_field_order_falls_back_to_default():
    """Повреждённый fieldOrder молча игнорируется (стандартный порядок)."""
    v = _violation(fieldOrder=["violated"])
    out = _md()._format_violation(v)
    assert out.index("Нарушено-X") < out.index("Установлено-Y")


def test_description_renders_with_label():
    """Описание — обычное поле с меткой."""
    v = _violation(
        description={"enabled": True, "blocks": [_text_block("Опис-контент")]},
    )
    out = _md()._format_violation(v)
    assert "**Описание:**" in out and "Опис-контент" in out


def _unlabeled_violation() -> dict:
    """Нарушение с заполненными полями без метки (labeled=False)."""
    return _violation(
        codeMining={"enabled": True, "blocks": [_text_block("CM-контент")]},
        processMining={"enabled": True, "blocks": [_text_block("PM-контент")]},
        additionalContent={"enabled": True, "blocks": [_text_block("Доп-контент")]},
    )


def test_unlabeled_fields_render_content_without_label():
    """CM/PM/доп. контент: контент есть, строки метки нет (решение владельца)."""
    v = _unlabeled_violation()
    for out in (_md()._format_violation(v), _txt()._format_violation(v)):
        for marker in ("CM-контент", "PM-контент", "Доп-контент"):
            assert marker in out
        for label in ("CodeMining", "ProcessMining", "Дополнительный контент"):
            assert label not in out, f"метка {label!r} не должна выводиться"


def test_unlabeled_field_multiple_blocks_all_rendered():
    """Все блоки поля без метки доходят до вывода по порядку."""
    v = _violation(codeMining={"enabled": True, "blocks": [
        _text_block("Первый CM", "text_1"),
        _text_block("Второй CM", "text_2"),
    ]})
    out = _md()._format_violation(v)
    assert out.index("Первый CM") < out.index("Второй CM")


def test_unlabeled_field_disabled_or_empty_still_hidden():
    """Политика видимости у полей без метки прежняя: выключено/пусто — не рендерим."""
    v = _violation(
        codeMining={"enabled": False, "blocks": [_text_block("скрытый CM")]},
        processMining={"enabled": True, "blocks": []},
    )
    out = _md()._format_violation(v)
    assert "скрытый CM" not in out


def test_multiple_blocks_render_in_order():
    v = _violation(
        reasons={"enabled": True, "blocks": [_text_block("Первый", "text_1"), _text_block("Второй", "text_2")]},
    )
    out = _md()._format_violation(v)
    assert out.index("Первый") < out.index("Второй")


# --- Rich-конвертация text-блоков ---


def test_markdown_text_block_converts_html():
    v = _violation()
    v["violated"]["blocks"] = [_text_block("это <b>жирное</b> и Ромашка &amp; Ко")]
    out = _md()._format_violation(v)
    assert "**жирное**" in out and "Ромашка & Ко" in out and "&amp;" not in out


def test_text_text_block_strips_html():
    v = _violation()
    v["violated"]["blocks"] = [_text_block("это <b>жирное</b> и Ромашка &amp; Ко")]
    out = _txt()._format_violation(v)
    assert "жирное" in out and "<b>" not in out and "Ромашка & Ко" in out


# --- #16: картинка (MD — markdown-разметка, TXT — строка) ---


def test_markdown_image_embedded_with_filename_in_title():
    v = _violation(additionalContent={"enabled": True, "blocks": [
        _image_block(image_id=_IMAGE_ID, caption="Подпись", filename="pic.png"),
    ]})
    out = _md()._format_violation(v, _IMAGES)
    assert '![Подпись](data:image/png;base64,AAAA "pic.png")' in out


def test_markdown_image_empty_id_falls_back_to_filename():
    v = _violation(additionalContent={"enabled": True, "blocks": [
        _image_block(image_id="", caption="", filename="draft.png"),
    ]})
    out = _md()._format_violation(v)
    assert "*draft.png*" in out
    assert "![" not in out


def test_markdown_image_filename_with_quote_escaped_in_title():
    v = _violation(additionalContent={"enabled": True, "blocks": [
        _image_block(image_id=_IMAGE_ID, caption="Подпись", filename='pic "one".png'),
    ]})
    out = _md()._format_violation(v, _IMAGES)
    assert '![Подпись](data:image/png;base64,AAAA "pic \\"one\\".png")' in out


def test_markdown_image_caption_with_bracket_escaped_in_alt():
    v = _violation(additionalContent={"enabled": True, "blocks": [
        _image_block(image_id=_IMAGE_ID, caption="рост] на 10%", filename="pic.png"),
    ]})
    out = _md()._format_violation(v, _IMAGES)
    assert '![рост\\] на 10%](data:image/png;base64,AAAA "pic.png")' in out


def test_markdown_image_caption_is_rich():
    v = _violation(additionalContent={"enabled": True, "blocks": [
        _image_block(image_id=_IMAGE_ID, caption="<b>важно</b>", filename="pic.png"),
    ]})
    out = _md()._format_violation(v, _IMAGES)
    assert '![**важно**](data:image/png;base64,AAAA "pic.png")' in out


def test_markdown_image_caption_none_falls_back_to_filename():
    v = _violation(additionalContent={"enabled": True, "blocks": [
        {"id": "image_1_b", "type": "image", "image_id": "", "caption": None, "filename": "draft.png"},
    ]})
    out = _md()._format_violation(v)
    assert "*draft.png*" in out


def test_text_image_caption_is_rich():
    v = _violation(additionalContent={"enabled": True, "blocks": [
        _image_block(image_id="", caption="<b>важно</b>", filename="pic.png"),
    ]})
    out = _txt()._format_violation(v)
    assert "Изображение: pic.png - важно" in out
    assert "<b>" not in out


def test_text_image_caption_none_falls_back_to_filename_only():
    v = _violation(additionalContent={"enabled": True, "blocks": [
        {"id": "image_1_b", "type": "image", "image_id": "", "caption": None, "filename": "draft.png"},
    ]})
    out = _txt()._format_violation(v)
    assert "Изображение: draft.png" in out


# --- Блок-таблица: та же графика, что у таблиц-узлов ---


def test_markdown_table_block_renders_pipe_table():
    v = _violation(codeMining={"enabled": True, "blocks": [
        _table_block([["Запрос", "Результат"], ["SELECT 1", "OK"]]),
    ]})
    out = _md()._format_violation(v)
    assert "| Запрос | Результат |" in out
    assert "| SELECT 1 | OK |" in out


def test_text_table_block_renders_ascii_table():
    v = _violation(codeMining={"enabled": True, "blocks": [
        _table_block([["Запрос", "Результат"], ["SELECT 1", "OK"]]),
    ]})
    out = _txt()._format_violation(v)
    assert "| Запрос" in out and "| SELECT 1" in out
    assert "+---" in out  # ASCII-рамка


def test_empty_table_block_renders_placeholder():
    v = _violation(codeMining={"enabled": True, "blocks": [
        {"id": "table_1_c", "type": "table", "table": {"grid": [], "colWidths": []}},
    ]})
    assert "*[Пустая таблица]*" in _md()._format_violation(v)
    assert "[Пустая таблица]" in _txt()._format_violation(v)
