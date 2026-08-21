"""Тесты узлового MD-конвертера ``HTMLUtils.html_to_markdown`` (F1).

Закрывают два дефекта одной переработкой:

1. **Fake-link во всех rich-полях.** Прежний конвертер не экранировал
   MD-спецсимволы в тексте — пользовательский `[текст](http://evil)`
   оживал как ссылка в MD-экспорте. Затронуты ВСЕ поля, идущие через
   ``html_to_markdown`` (нарушено/установлено, причины/меры/…, пункты
   списка, кейс, свободный текст, текстблок, подпись картинки).
2. **Воскрешение буквального `<script>` через ``html.unescape``.** nh3 хранит
   набранный пользователем `<script>` как `&lt;script&gt;`; прежний
   финальный ``html.unescape`` декодировал его обратно в сырой `<script>`.

Живые инварианты: настоящая ссылка-капсула, `<b>`/`<i>`, границы блоков,
отсутствие двойного экранирования.
"""
from app.domains.acts.formatters.utils.html_utils import HTMLUtils
from app.domains.acts.formatters.markdown_formatter import MarkdownFormatter
from app.domains.acts.settings import ActsSettings

md = HTMLUtils.html_to_markdown


def _md() -> MarkdownFormatter:
    return MarkdownFormatter(settings=None, acts_settings=ActsSettings())


def _has_unescaped(text: str, ch: str) -> bool:
    """True, если в тексте есть вхождение ch, не прикрытое обратным слэшем."""
    i = 0
    while i < len(text):
        if text[i] == "\\":
            i += 2
            continue
        if text[i] == ch:
            return True
        i += 1
    return False


# --- Дефект 1: fake-link на уровне конвертера ------------------------------


class TestFakeLinkNeutralised:
    def test_bracket_link_in_plain_text_escaped(self):
        out = md("[evil](http://evil.example)")
        assert "[evil](http://evil.example)" not in out
        assert "\\[evil\\](http://evil.example)" in out

    def test_no_unescaped_brackets_remain(self):
        out = md("текст [evil](http://evil.example) хвост")
        assert not _has_unescaped(out, "[")
        assert not _has_unescaped(out, "]")

    def test_image_injection_bang_bracket_neutralised(self):
        out = md("![alt](http://evil.example/x.png)")
        assert "![alt](http://evil.example/x.png)" not in out
        assert not _has_unescaped(out, "[")


# --- Дефект 2: воскрешение буквального <script> ----------------------------


class TestScriptResurrectionBlocked:
    def test_escaped_script_not_resurrected(self):
        # Пользователь набрал буквальный <script>; nh3 хранит его как &lt;…&gt;.
        out = md("&lt;script&gt;alert(1)&lt;/script&gt;")
        assert "<script>" not in out
        assert not _has_unescaped(out, "<")

    def test_literal_lt_never_raw(self):
        out = md("a &lt; b и c &lt; d")
        assert not _has_unescaped(out, "<")

    def test_literal_lt_inside_bold_neutralised(self):
        out = md("<b>&lt;img src=x onerror=alert(1)&gt;</b>")
        assert not _has_unescaped(out, "<")
        # Настоящая разметка тега <b> при этом живая.
        assert out.startswith("**") and out.endswith("**")


# --- Живые инварианты ------------------------------------------------------


class TestRealMarkupPreserved:
    def test_bold(self):
        assert md("<b>жирный</b>") == "**жирный**"
        assert md("<strong>жирный</strong>") == "**жирный**"

    def test_italic(self):
        assert md("<i>курсив</i>") == "*курсив*"
        assert md("<em>курсив</em>") == "*курсив*"

    def test_underline_unwrapped(self):
        assert md("<u>подчёркнуто</u>") == "подчёркнуто"

    def test_link_capsule_live(self):
        src = '<span class="text-link" data-link-url="https://x.ru/d">текст</span>'
        assert md(src) == "[текст](https://x.ru/d)"

    def test_link_capsule_text_escaped_url_safe(self):
        src = '<span class="text-link" data-link-url="https://x.ru">[a]</span>'
        out = md(src)
        # Текст ссылки экранирован (не рвёт скобки), сама ссылка живая.
        assert out == "[\\[a\\]](https://x.ru)"

    def test_unsafe_scheme_link_downgraded_to_text(self):
        src = '<span class="text-link" data-link-url="javascript:alert(1)">клик</span>'
        out = md(src)
        assert "javascript:alert(1)" not in out
        assert out == "клик"

    def test_footnote_capsule_semantics_preserved(self):
        src = '<span class="text-footnote" data-footnote-text="прим"><b>якорь</b></span>'
        assert md(src) == "**якорь** (сноска: прим)"

    def test_footnote_text_escaped(self):
        src = '<span class="text-footnote" data-footnote-text="[e](x)">я</span>'
        out = md(src)
        assert not _has_unescaped(out, "[")


class TestNoDoubleEscaping:
    def test_single_bracket_escaped_once(self):
        out = md("a [ b")
        assert "\\[" in out
        assert "\\\\[" not in out

    def test_single_backslash_escaped_once(self):
        out = md("a \\ b")
        assert out == "a \\\\ b"


# --- Уровень поля нарушения: fake-link мёртв во ВСЕХ rich-полях -------------


_FAKE = "[evil](http://evil.example)"


def _fake_block(bid: str = "text_1") -> dict:
    return {"id": bid, "type": "text", "content": _FAKE}


def _violation(**over):
    from app.domains.acts.violation_fields import VIOLATION_FIELD_KEYS
    base = {key: {"enabled": False, "blocks": []} for key in VIOLATION_FIELD_KEYS}
    base["violated"]["enabled"] = True
    base["established"]["enabled"] = True
    base.update(over)
    return base


class TestFakeLinkDeadInAllFields:
    def test_violated(self):
        out = _md()._format_violation(
            _violation(violated={"enabled": True, "blocks": [_fake_block()]})
        )
        assert _FAKE not in out
        assert "\\[evil\\]" in out

    def test_established(self):
        out = _md()._format_violation(
            _violation(established={"enabled": True, "blocks": [_fake_block()]})
        )
        assert _FAKE not in out

    def test_reasons(self):
        out = _md()._format_violation(
            _violation(reasons={"enabled": True, "blocks": [_fake_block()]})
        )
        assert _FAKE not in out

    def test_description(self):
        out = _md()._format_violation(
            _violation(description={"enabled": True, "blocks": [_fake_block()]})
        )
        assert _FAKE not in out
        assert "\\[evil\\]" in out

    def test_additional_content_text_block(self):
        out = _md()._format_violation(
            _violation(additionalContent={"enabled": True, "blocks": [_fake_block()]})
        )
        assert _FAKE not in out

    def test_caption_url_branch(self):
        # Байты картинки приезжают отдельной картой; b"\x00\x00\x00" → "AAAA".
        images = {"i1": {"data": b"\x00\x00\x00", "mime_type": "image/png"}}
        lines: list[str] = []
        _md()._add_image(lines, {
            "type": "image", "image_id": "i1",
            "caption": _FAKE, "filename": "f.png",
        }, images)
        out = "\n".join(lines)
        assert _FAKE not in out
        # Настоящий url картинки остаётся единственной живой ссылкой.
        assert "(data:image/png;base64,AAAA " in out

    def test_caption_draft_branch(self):
        lines: list[str] = []
        _md()._add_image(lines, {
            "type": "image", "image_id": "", "caption": _FAKE, "filename": "f.png",
        })
        out = "\n".join(lines)
        assert _FAKE not in out
        assert "\\[evil\\]" in out


class TestTextblockFakeLinkDead:
    def test_textblock_content(self):
        out = _md()._format_textblock({"content": _FAKE})
        assert _FAKE not in out
        assert "\\[evil\\]" in out

    def test_textblock_script_not_resurrected(self):
        out = _md()._format_textblock({"content": "&lt;script&gt;x&lt;/script&gt;"})
        assert "<script>" not in out
