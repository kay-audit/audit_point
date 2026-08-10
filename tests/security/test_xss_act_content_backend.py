"""
XSS-санитизация content-полей акта на бэкенде.

Гарантирует, что ActContentService.save_content вычищает опасные
теги/атрибуты до записи в БД: <script>, <img onerror>, <svg onload>,
<iframe srcdoc>, javascript:-URL — для textBlock.content, узлов дерева
(реальный HTML, рендерится через innerHTML) и блоков полей нарушения
(text.content, image.caption — по реестру VIOLATION_FIELDS, блочная модель
{enabled, blocks}, см. TestSaveContentViolationBlocksSanitized). Whitelist
разрешает p/b/i/span/a/ul/ol/li/... и атрибуты {a:href,title;
span:class,style; div/p:class,style; *:class}.

Plain-text поля image-блока (url/filename) через санитайзер НЕ гоняются —
нигде не рендерятся как innerHTML, поэтому хранятся дословно (см. те же
тесты). Ячейки table-блока — тот же инвариант, что у больших таблиц акта
(B8): рендерятся только как текст, санитайзер их не трогает.

Тесты дополнительно покрывают utils/html_sanitizer.sanitize_html/
sanitize_rich_html напрямую (быстрые сценарии без поднятия сервиса).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.domains.acts.schemas.act_content import (
    ActDataSchema,
    EmbeddedTableSchema,
    TableCellSchema,
    TableSchema,
    TextBlockSchema,
    ViolationFieldSchema,
    ViolationImageBlockSchema,
    ViolationSchema,
    ViolationTableBlockSchema,
    ViolationTextBlockSchema,
)
from app.domains.acts.services.act_content_service import ActContentService
from app.domains.acts.utils.html_sanitizer import (
    _sanitize_block,
    _sanitize_violation_dict,
    _sanitize_violation_obj,
    sanitize_html,
    sanitize_rich_html,
)


@pytest.fixture(autouse=True)
def _patch_adapter(mock_adapter):
    """Все репозитории, создающиеся внутри сервиса, должны получить мок-адаптер."""
    with patch("app.db.repositories.base.get_adapter", return_value=mock_adapter):
        yield


# ── Прямые тесты утилиты sanitize_html ──────────────────────────────────────


class TestSanitizeHtmlDirect:
    """sanitize_html: whitelist тегов/атрибутов/протоколов."""

    def test_strips_script_tag(self):
        out = sanitize_html("<p>safe</p><script>alert(1)</script>")
        # bleach strip=True убирает теги; текст между ними остаётся как plain
        # text — это безопасно: без <script>-обёртки `alert(1)` не выполнится
        # при рендере через innerHTML.
        assert "<script" not in out
        assert "</script" not in out
        assert "safe" in out

    def test_strips_img_onerror(self):
        out = sanitize_html('<img src="x" onerror="alert(1)">')
        # <img> вообще не в whitelist → выкидывается целиком
        assert "<img" not in out
        assert "onerror" not in out

    def test_strips_svg_onload(self):
        out = sanitize_html('<svg onload="alert(1)"><circle/></svg>')
        assert "<svg" not in out
        assert "onload" not in out

    def test_strips_iframe_srcdoc(self):
        out = sanitize_html('<iframe srcdoc="<script>alert(1)</script>"></iframe>')
        assert "<iframe" not in out
        assert "srcdoc" not in out

    def test_strips_event_handlers_on_allowed_tags(self):
        out = sanitize_html('<a href="https://ok" onclick="alert(1)">link</a>')
        assert "onclick" not in out
        assert "href" in out
        assert "link" in out

    def test_blocks_javascript_protocol(self):
        out = sanitize_html('<a href="javascript:alert(1)">x</a>')
        # bleach убирает href со схемой не из whitelist, текст остаётся
        assert "javascript:" not in out
        assert "x" in out

    def test_preserves_allowed_tags(self):
        html = '<p>para</p><b>bold</b><i>it</i><span class="hl">s</span>'
        out = sanitize_html(html)
        assert "<p>" in out
        assert "<b>" in out
        assert "<i>" in out
        assert 'class="hl"' in out

    def test_preserves_allowed_anchor_with_https(self):
        out = sanitize_html('<a href="https://example.com" title="t">x</a>')
        assert 'href="https://example.com"' in out
        assert 'title="t"' in out

    def test_empty_and_none_inputs(self):
        assert sanitize_html("") == ""
        assert sanitize_html(None) == ""

    def test_non_string_falls_back_to_str(self):
        # Защитный fallback (на случай если Pydantic пропустил неожиданный тип)
        assert sanitize_html(123) == "123"


class TestSanitizeRichHtmlDirect:
    """sanitize_rich_html: nh3-санитайзер для rich-блоков полей нарушения.

    Тот же allowlist настроек, что у sanitize_html, но на nh3 (allowlist ==
    фронтовый DOMPurify) вместо bleach — см. докстринг sanitize_rich_html.
    """

    def test_strips_script(self):
        out = sanitize_rich_html("<p>safe</p><script>alert(1)</script>")
        assert "<script" not in out and "safe" in out

    def test_strips_img_onerror(self):
        out = sanitize_rich_html('<img src=x onerror="alert(1)">')
        assert "<img" not in out and "onerror" not in out

    def test_blocks_javascript_protocol(self):
        out = sanitize_rich_html('<a href="javascript:alert(1)">x</a>')
        assert "javascript:" not in out and "x" in out

    def test_https_anchor_no_added_rel(self):
        out = sanitize_rich_html('<a href="https://e.com" title="t">x</a>')
        assert 'href="https://e.com"' in out and 'title="t"' in out
        assert "rel=" not in out

    def test_keeps_link_capsule_attrs(self):
        out = sanitize_rich_html('<span data-link-id="l1" data-link-url="https://e.com">c</span>')
        assert 'data-link-id="l1"' in out and 'data-link-url="https://e.com"' in out

    def test_font_size_clamped(self):
        out = sanitize_rich_html('<span style="font-size: 500px">x</span>')
        assert "500px" not in out
        assert "72px" in out  # font_size_max по умолчанию (TextblocksSettings)

    def test_block_keeps_only_text_align(self):
        out = sanitize_rich_html('<div style="text-align: center; color: red">x</div>')
        assert "text-align" in out and "center" in out and "color" not in out

    def test_nonallowlisted_css_dropped(self):
        out = sanitize_rich_html('<span style="position: fixed; color: red">x</span>')
        assert "position" not in out and "color" in out

    def test_empty_none(self):
        assert sanitize_rich_html("") == "" and sanitize_rich_html(None) == ""

    def test_ampersand_encoded_nonidempotent(self):
        assert sanitize_rich_html("Ромашка & Ко") == "Ромашка &amp; Ко"

    def test_style_stripped_from_anchor(self):
        out = sanitize_rich_html('<a href="https://e.com" style="color:red">x</a>')
        assert "style" not in out and 'href="https://e.com"' in out

    def test_data_url_scheme_blocked(self):
        out = sanitize_rich_html('<a href="data:text/html,<script>alert(1)</script>">x</a>')
        assert "data:" not in out and "x" in out

    def test_lists_survive_sanitization(self):
        """ul/ol/li разрешены whitelist'ом — списки переживают санитизацию."""
        out = sanitize_rich_html("<ul><li>раз</li><li>два</li></ul><ol><li>три</li></ol>")
        assert "<ul>" in out and "<li>раз</li>" in out and "<li>два</li>" in out
        assert "<ol>" in out and "<li>три</li>" in out


# ── Интеграция: ActContentService.save_content санитизирует все поля ────────


def _make_service():
    """ActContentService с замоканными guard/репозиториями."""
    conn = AsyncMock()
    # save_content открывает плоскую транзакцию на соединении —
    # mock-у нужен синхронный transaction(), возвращающий async-CM
    # (как в conftest.mock_conn).
    tx = AsyncMock()
    tx.__aenter__ = AsyncMock(return_value=tx)
    tx.__aexit__ = AsyncMock(return_value=False)
    conn.transaction = MagicMock(return_value=tx)
    settings = MagicMock()
    acts_settings = MagicMock()
    acts_settings.resource.max_tree_depth = 20
    acts_settings.audit_log.max_diff_elements = 100
    acts_settings.audit_log.max_diff_cells_per_table = 100
    acts_settings.audit_log.max_content_versions = 50

    access = MagicMock()
    lock = MagicMock()
    crud = MagicMock()
    content = MagicMock()
    content.save_content = AsyncMock(return_value={"status": "success"})
    invoice = MagicMock()

    svc = ActContentService(
        conn=conn,
        settings=settings,
        acts_settings=acts_settings,
        access=access,
        lock=lock,
        crud=crud,
        content=content,
        invoice=invoice,
    )

    # Все проверки доступа / лока — no-op
    svc.guard = MagicMock()
    svc.guard.require_edit_permission = AsyncMock()
    svc.guard.require_lock_owner = AsyncMock()

    # Аудит и версии — no-op
    svc._audit = MagicMock()
    svc._audit.log = AsyncMock()
    svc._audit.compute_content_diff = AsyncMock(return_value={})
    svc._audit.compute_field_diffs = AsyncMock(return_value=None)
    svc._versions = MagicMock()
    svc._versions.create_version = AsyncMock()

    return svc, content


def _data_with_textblock(html: str) -> ActDataSchema:
    return ActDataSchema(
        tree={"id": "root", "label": "Акт", "children": []},
        textBlocks={"tb1": TextBlockSchema(id="tb1", nodeId="n1", content=html)},
        saveType="auto",
    )


def _violation_with_blocks(**field_blocks) -> ActDataSchema:
    """Нарушение v1 с блоками в указанных полях (остальные — дефолт реестра).

    Каждый kwarg — ключ поля реестра VIOLATION_FIELDS, значение — список
    готовых блоков (ViolationTextBlockSchema/ViolationImageBlockSchema/
    ViolationTableBlockSchema) для контейнера {enabled: True, blocks: [...]}.
    """
    kwargs = {
        key: ViolationFieldSchema(enabled=True, blocks=blocks)
        for key, blocks in field_blocks.items()
    }
    v = ViolationSchema(id="v1", nodeId="n1", **kwargs)
    return ActDataSchema(
        tree={"id": "root", "label": "Акт", "children": []},
        violations={"v1": v},
        saveType="auto",
    )


class TestSaveContentSanitizesTextBlocks:
    """save_content → textBlock.content прогоняется через sanitize_html."""

    async def test_script_tag_stripped_in_textblock(self):
        svc, content_repo = _make_service()
        payload = "<p>ok</p><script>alert('xss')</script>"
        data = _data_with_textblock(payload)

        await svc.save_content(act_id=1, data=data, username="12345")

        # Проверяем что в save_content репозитория ушёл уже очищенный data
        content_repo.save_content.assert_awaited_once()
        saved_data = content_repo.save_content.await_args.kwargs.get("data") \
            or content_repo.save_content.await_args.args[1]
        sanitized = saved_data.textBlocks["tb1"].content
        # Теги вырезаны; внутренний текст остаётся как plain — не исполнится
        # при innerHTML без <script>-обёртки.
        assert "<script" not in sanitized
        assert "</script" not in sanitized
        assert "ok" in sanitized

    async def test_img_onerror_stripped_in_textblock(self):
        svc, content_repo = _make_service()
        data = _data_with_textblock('<img src=x onerror="alert(1)">')

        await svc.save_content(act_id=1, data=data, username="12345")

        sanitized = data.textBlocks["tb1"].content
        assert "onerror" not in sanitized
        assert "<img" not in sanitized

    async def test_svg_onload_stripped_in_textblock(self):
        svc, content_repo = _make_service()
        data = _data_with_textblock('<svg onload="alert(1)"></svg>')

        await svc.save_content(act_id=1, data=data, username="12345")

        sanitized = data.textBlocks["tb1"].content
        assert "<svg" not in sanitized
        assert "onload" not in sanitized

    async def test_iframe_srcdoc_stripped_in_textblock(self):
        svc, content_repo = _make_service()
        data = _data_with_textblock('<iframe srcdoc="<script>alert(1)</script>"></iframe>')

        await svc.save_content(act_id=1, data=data, username="12345")

        sanitized = data.textBlocks["tb1"].content
        assert "<iframe" not in sanitized
        assert "srcdoc" not in sanitized

    async def test_safe_html_preserved(self):
        """Plain text + базовые теги должны пройти насквозь — regression на e2e."""
        svc, content_repo = _make_service()
        safe = '<p>Hello <b>world</b> <a href="https://example.com">link</a></p>'
        data = _data_with_textblock(safe)

        await svc.save_content(act_id=1, data=data, username="12345")

        sanitized = data.textBlocks["tb1"].content
        assert "<p>" in sanitized
        assert "<b>world</b>" in sanitized
        assert 'href="https://example.com"' in sanitized


class TestSaveContentViolationBlocksSanitized:
    """save_content прогоняет rich-блоки полей нарушения через sanitize_rich_html.

    Блочная модель: у каждого из 10 полей реестра VIOLATION_FIELDS —
    единый контейнер {enabled, blocks}. text-блок.content и image-блок.caption
    несут реальный HTML (rich-редактор, innerHTML) — санитизируются как любой
    другой HTML-контент (см. докстринг sanitize_act_data). image-блок
    url/filename — plain, не трогаются. table-блок — ячейки хранятся
    дословно (тот же инвариант B8, что у больших таблиц акта, см.
    TestSaveContentTableCellsStoredVerbatim).
    """

    async def test_violated_established_text_block_sanitized(self):
        svc, _ = _make_service()
        data = _violation_with_blocks(
            violated=[ViolationTextBlockSchema(
                id="b1", type="text", content="<p>ok</p><script>alert(1)</script>",
            )],
            established=[ViolationTextBlockSchema(
                id="b2", type="text", content='<img onerror="x" src=y>вред',
            )],
        )

        await svc.save_content(act_id=1, data=data, username="12345")

        v = data.violations["v1"]
        violated_content = v.violated.blocks[0].content
        established_content = v.established.blocks[0].content
        assert "<script" not in violated_content and "<p>ok</p>" in violated_content
        assert "onerror" not in established_content
        assert "<img" not in established_content and "вред" in established_content

    async def test_optional_field_text_blocks_sanitized(self):
        """reasons/measures/consequences/responsible: text-блок.content санитизируется."""
        svc, _ = _make_service()
        raw = '<b>причина</b><svg onload="x"></svg>'
        keys = ("reasons", "measures", "consequences", "responsible")
        data = _violation_with_blocks(**{
            key: [ViolationTextBlockSchema(id=f"b_{key}", type="text", content=raw)]
            for key in keys
        })

        await svc.save_content(act_id=1, data=data, username="12345")

        v = data.violations["v1"]
        for key in keys:
            content = getattr(v, key).blocks[0].content
            assert "<svg" not in content and "onload" not in content
            assert "<b>причина</b>" in content

    async def test_image_caption_sanitized(self):
        """image-блок.caption — rich, санитизируется."""
        svc, _ = _make_service()
        raw_caption = '<b>подпись</b><img src=x onerror="a">'
        data = _violation_with_blocks(additionalContent=[ViolationImageBlockSchema(
            id="b1", type="image", caption=raw_caption,
        )])

        await svc.save_content(act_id=1, data=data, username="12345")

        block = data.violations["v1"].additionalContent.blocks[0]
        assert "<b>подпись</b>" in block.caption
        assert "<img" not in block.caption and "onerror" not in block.caption

    async def test_image_url_filename_verbatim(self):
        """url/filename image-блока — plain, дословно (не HTML-контент)."""
        svc, _ = _make_service()
        raw_filename = "<script>x</script>ф.png"
        url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="
        data = _violation_with_blocks(additionalContent=[ViolationImageBlockSchema(
            id="b1", type="image", url=url, filename=raw_filename,
        )])

        await svc.save_content(act_id=1, data=data, username="12345")

        block = data.violations["v1"].additionalContent.blocks[0]
        assert block.filename == raw_filename
        assert block.url == url

    async def test_table_block_cells_verbatim(self):
        """table-блок: ячейки не тронуты — тот же инвариант, что у больших таблиц (B8)."""
        svc, _ = _make_service()
        payload = "<script>window.__xss=1</script>"
        table = EmbeddedTableSchema(grid=[[TableCellSchema(content=payload)]], colWidths=[100])
        data = _violation_with_blocks(additionalContent=[ViolationTableBlockSchema(
            id="b1", type="table", table=table,
        )])

        await svc.save_content(act_id=1, data=data, username="12345")

        cell = data.violations["v1"].additionalContent.blocks[0].table.grid[0][0]
        assert cell.content == payload

    async def test_allowlisted_formatting_survives(self):
        """Разрешённые тег/CSS/ссылка переживают санитизацию."""
        svc, _ = _make_service()
        raw = '<span style="font-size: 20px">крупно</span><a href="https://e.com">l</a>'
        data = _violation_with_blocks(violated=[ViolationTextBlockSchema(
            id="b1", type="text", content=raw,
        )])

        await svc.save_content(act_id=1, data=data, username="12345")

        content = data.violations["v1"].violated.blocks[0].content
        assert "font-size" in content and "20px" in content
        assert 'href="https://e.com"' in content

    async def test_lists_survive_sanitization(self):
        """ul/ol/li в text-блоке переживают санитизацию (списки разрешены)."""
        svc, _ = _make_service()
        html = "<ul><li>раз</li><li>два</li></ul><ol><li>три</li></ol>"
        data = _violation_with_blocks(reasons=[ViolationTextBlockSchema(
            id="b1", type="text", content=html,
        )])

        await svc.save_content(act_id=1, data=data, username="12345")

        content = data.violations["v1"].reasons.blocks[0].content
        assert "<ul>" in content and "<li>раз</li>" in content
        assert "<ol>" in content and "<li>три</li>" in content

    async def test_ampersand_html_encoded_not_corruption(self):
        """"&" → "&amp;" — корректное HTML-хранение rich-блока, не порча текста."""
        svc, _ = _make_service()
        data = _violation_with_blocks(violated=[ViolationTextBlockSchema(
            id="b1", type="text", content="Ромашка & Ко",
        )])

        await svc.save_content(act_id=1, data=data, username="12345")

        assert data.violations["v1"].violated.blocks[0].content == "Ромашка &amp; Ко"


class TestSanitizeBlockDispatch:
    """_sanitize_block: прямые тесты диспетчера по типу (без ViolationSchema)."""

    def test_text_dispatches_to_content(self):
        block = {"id": "b1", "type": "text", "content": "<script>x</script>ok"}
        _sanitize_block(block)
        assert "<script" not in block["content"] and "ok" in block["content"]

    def test_image_dispatches_to_caption(self):
        block = {"id": "b1", "type": "image", "caption": "<script>x</script>ok"}
        _sanitize_block(block)
        assert "<script" not in block["caption"] and "ok" in block["caption"]

    def test_table_left_untouched(self):
        block = {"id": "b1", "type": "table",
                  "table": {"grid": [[{"content": "<script>x</script>"}]]}}
        _sanitize_block(block)
        assert block["table"]["grid"][0][0]["content"] == "<script>x</script>"

    def test_unknown_type_left_untouched(self):
        """Неизвестный type — пропуск без изменений (422 на нём отбивает схема раньше)."""
        block = {"id": "b1", "type": "unknown", "content": "<script>x</script>"}
        _sanitize_block(block)
        assert block["content"] == "<script>x</script>"

    def test_missing_type_left_untouched(self):
        block = {"id": "b1", "content": "<script>x</script>"}
        _sanitize_block(block)
        assert block["content"] == "<script>x</script>"

    def test_none_block_does_not_raise(self):
        _sanitize_block(None)  # не упало — достаточно


class TestSanitizeViolationNoneGuards:
    """Отсутствующее/None-поле, blocks не-список, блок без type — не роняют
    санитайзер (V18/#11: явный None не подменяется на '', missing-ключ не
    появляется)."""

    def test_missing_field_key_does_not_raise(self):
        v = {"id": "v1", "nodeId": "n1"}  # ни одного из 10 полей
        _sanitize_violation_dict(v)  # не упало — достаточно

    def test_none_field_does_not_raise(self):
        v = {"id": "v1", "nodeId": "n1", "violated": None}
        _sanitize_violation_dict(v)

    def test_blocks_not_list_skipped(self):
        v = {"id": "v1", "nodeId": "n1",
             "violated": {"enabled": True, "blocks": "не список"}}
        _sanitize_violation_dict(v)
        assert v["violated"]["blocks"] == "не список"

    def test_none_block_in_list_skipped(self):
        v = {"id": "v1", "nodeId": "n1",
             "violated": {"enabled": True, "blocks": [None]}}
        _sanitize_violation_dict(v)
        assert v["violated"]["blocks"] == [None]

    def test_text_content_missing_key_not_added(self):
        v = {"id": "v1", "nodeId": "n1",
             "violated": {"enabled": True, "blocks": [{"id": "b1", "type": "text"}]}}
        _sanitize_violation_dict(v)
        assert "content" not in v["violated"]["blocks"][0]

    def test_text_content_none_stays_none_dict_form(self):
        v = {"id": "v1", "nodeId": "n1",
             "violated": {"enabled": True,
                          "blocks": [{"id": "b1", "type": "text", "content": None}]}}
        _sanitize_violation_dict(v)
        assert v["violated"]["blocks"][0]["content"] is None

    def test_image_caption_missing_key_not_added(self):
        v = {"id": "v1", "nodeId": "n1",
             "violated": {"enabled": True, "blocks": [{"id": "b1", "type": "image"}]}}
        _sanitize_violation_dict(v)
        assert "caption" not in v["violated"]["blocks"][0]

    def test_image_caption_none_stays_none_dict_form(self):
        v = {"id": "v1", "nodeId": "n1",
             "violated": {"enabled": True,
                          "blocks": [{"id": "b1", "type": "image", "caption": None}]}}
        _sanitize_violation_dict(v)
        assert v["violated"]["blocks"][0]["caption"] is None

    def test_text_content_none_stays_none_obj_form(self):
        """Зеркало dict-теста для объектной формы (прямая подмена атрибута,
        имитация легаси/некорректного объекта — Pydantic-конструктор content=None
        не пропустит)."""
        block = ViolationTextBlockSchema(id="b1", type="text", content="x")
        block.content = None
        v = ViolationSchema(id="v1", nodeId="n1",
                             violated=ViolationFieldSchema(enabled=True, blocks=[block]))

        _sanitize_violation_obj(v)

        assert v.violated.blocks[0].content is None

    def test_image_caption_none_stays_none_obj_form(self):
        block = ViolationImageBlockSchema(id="b1", type="image", caption="x")
        block.caption = None
        v = ViolationSchema(id="v1", nodeId="n1",
                             violated=ViolationFieldSchema(enabled=True, blocks=[block]))

        _sanitize_violation_obj(v)

        assert v.violated.blocks[0].caption is None


class TestSanitizeViolationParity:
    """obj-путь (_sanitize_violation_obj) и dict-путь (_sanitize_violation_dict)
    обходят одно и то же нарушение по единой семантике (закрывает риск
    повторного V18-расхождения между двумя параллельными walker'ами)."""

    def _build_obj(self) -> ViolationSchema:
        return ViolationSchema(
            id="v1", nodeId="n1",
            violated=ViolationFieldSchema(enabled=True, blocks=[
                ViolationTextBlockSchema(id="b1", type="text", content="<p>v</p><script>x</script>"),
            ]),
            established=ViolationFieldSchema(enabled=True, blocks=[
                ViolationTextBlockSchema(id="b2", type="text", content="<i>e</i><svg onload=x></svg>"),
            ]),
            reasons=ViolationFieldSchema(enabled=True, blocks=[
                ViolationImageBlockSchema(id="b3", type="image", caption="<b>капшн</b><script>x</script>"),
            ]),
            additionalContent=ViolationFieldSchema(enabled=True, blocks=[
                ViolationTableBlockSchema(
                    id="b4", type="table",
                    table=EmbeddedTableSchema(
                        grid=[[TableCellSchema(content="<script>x</script>")]], colWidths=[100],
                    ),
                ),
            ]),
        )

    def _build_dict(self) -> dict:
        return {
            "id": "v1", "nodeId": "n1",
            "violated": {"enabled": True, "blocks": [
                {"id": "b1", "type": "text", "content": "<p>v</p><script>x</script>"},
            ]},
            "established": {"enabled": True, "blocks": [
                {"id": "b2", "type": "text", "content": "<i>e</i><svg onload=x></svg>"},
            ]},
            "reasons": {"enabled": True, "blocks": [
                {"id": "b3", "type": "image", "caption": "<b>капшн</b><script>x</script>"},
            ]},
            "additionalContent": {"enabled": True, "blocks": [
                {"id": "b4", "type": "table", "table": {
                    "grid": [[{"content": "<script>x</script>"}]], "colWidths": [100],
                }},
            ]},
        }

    def test_full_payload_matches_across_paths(self):
        """text.content + image.caption — идентичный результат санитизации;
        table-блок не тронут ни на одном из путей (verbatim)."""
        obj = self._build_obj()
        d = self._build_dict()

        _sanitize_violation_obj(obj)
        _sanitize_violation_dict(d)

        assert obj.violated.blocks[0].content == d["violated"]["blocks"][0]["content"]
        assert obj.established.blocks[0].content == d["established"]["blocks"][0]["content"]
        assert obj.reasons.blocks[0].caption == d["reasons"]["blocks"][0]["caption"]
        assert obj.additionalContent.blocks[0].table.grid[0][0].content == "<script>x</script>"
        assert d["additionalContent"]["blocks"][0]["table"]["grid"][0][0]["content"] == "<script>x</script>"
        # Санитизация реально сработала (не no-op сравнение пустышек)
        assert "<script" not in obj.violated.blocks[0].content and "v" in obj.violated.blocks[0].content

    def test_text_content_none_stays_none_both_paths(self):
        obj = self._build_obj()
        obj.violated.blocks[0].content = None
        d = self._build_dict()
        d["violated"]["blocks"][0]["content"] = None

        _sanitize_violation_obj(obj)
        _sanitize_violation_dict(d)

        assert obj.violated.blocks[0].content is None
        assert d["violated"]["blocks"][0]["content"] is None

    def test_image_caption_none_stays_none_both_paths(self):
        obj = self._build_obj()
        obj.reasons.blocks[0].caption = None
        d = self._build_dict()
        d["reasons"]["blocks"][0]["caption"] = None

        _sanitize_violation_obj(obj)
        _sanitize_violation_dict(d)

        assert obj.reasons.blocks[0].caption is None
        assert d["reasons"]["blocks"][0]["caption"] is None


class TestSaveContentSanitizesTreeNodes:
    """save_content → tree nodes[*].content рекурсивно чистится."""

    async def test_root_and_nested_node_content_sanitized(self):
        svc, _ = _make_service()
        tree = {
            "id": "root",
            "label": "Акт",
            "content": '<p>r</p><script>alert(1)</script>',
            "children": [
                {
                    "id": "child1",
                    "label": "Раздел",
                    "content": '<img onerror="x" src=y>',
                    "children": [
                        {
                            "id": "leaf",
                            "label": "Пункт",
                            "content": '<iframe srcdoc="x"></iframe>safe',
                            "children": [],
                        }
                    ],
                }
            ],
        }
        data = ActDataSchema(tree=tree, saveType="auto")

        await svc.save_content(act_id=1, data=data, username="12345")

        assert "<script" not in data.tree["content"]
        assert "r" in data.tree["content"]
        child = data.tree["children"][0]
        assert "onerror" not in child["content"]
        assert "<img" not in child["content"]
        leaf = child["children"][0]
        assert "<iframe" not in leaf["content"]
        assert "safe" in leaf["content"]

    async def test_node_without_content_does_not_break(self):
        svc, _ = _make_service()
        tree = {"id": "root", "label": "Акт", "children": [
            {"id": "c", "label": "x", "children": []}  # нет ключа content
        ]}
        data = ActDataSchema(tree=tree, saveType="auto")
        await svc.save_content(act_id=1, data=data, username="12345")
        # Не упало — достаточно


# ── Инвариант: ячейки таблицы НЕ санитизируются (хранятся как инертный текст) ─


def _data_with_table_cell(cell_content: str) -> ActDataSchema:
    """ActDataSchema с одной таблицей 2×1; payload в ячейке тела grid[1][0]."""
    table = TableSchema(
        id="t1",
        nodeId="n1",
        grid=[
            [TableCellSchema(content="Заголовок", isHeader=True)],
            [TableCellSchema(content=cell_content)],
        ],
        colWidths=[100],
    )
    return ActDataSchema(
        tree={"id": "root", "label": "Акт", "children": []},
        tables={"t1": table},
        saveType="auto",
    )


class TestSaveContentTableCellsStoredVerbatim:
    """
    Инвариант ячеек таблицы (B8): содержимое ячеек НЕ прогоняется через
    sanitize_html — оно сохраняется в БД дословно, как инертный текст.

    ПОЧЕМУ ЭТО БЕЗОПАСНО: все потребители содержимого ячеек рендерят его как
    ТЕКСТ, а не как HTML, поэтому payload никогда не интерпретируется:
      - редактор: items-renderer._createTableCell → cell.textContent
      - предпросмотр: preview-table-renderer → cell.textContent
      - DOCX-экспорт: run.add_run(text) (текстовый run, не HTML)
      - TXT/MD-экспорт: plain text
    Санитизация ячеек была бы вредна: она искажала бы легитимные значения
    (например, «a < b», «<тэг> в кавычках» как данные). Инвариант
    «всё на текст» сильнее, чем точечная санитизация одного из путей.

    Тот же инвариант распространяется на ячейки table-блока внутри полей
    нарушения — см. TestSaveContentViolationBlocksSanitized.test_table_block_cells_verbatim.

    Эти тесты фиксируют, что save_content НЕ трогает ячейки таблицы.
    """

    async def test_script_payload_in_cell_preserved_verbatim(self):
        svc, content_repo = _make_service()
        payload = "<script>window.__xss=1</script>"
        data = _data_with_table_cell(payload)

        await svc.save_content(act_id=1, data=data, username="12345")

        content_repo.save_content.assert_awaited_once()
        saved_data = content_repo.save_content.await_args.kwargs.get("data") \
            or content_repo.save_content.await_args.args[1]
        stored = saved_data.tables["t1"].grid[1][0].content
        # Содержимое сохранено дословно — не вырезано и не экранировано.
        # Безопасность обеспечивают потребители (textContent / add_run), не БД.
        assert stored == payload

    async def test_img_onerror_payload_in_cell_preserved_verbatim(self):
        svc, _ = _make_service()
        payload = '<img src=x onerror="window.__xss=1">'
        data = _data_with_table_cell(payload)

        await svc.save_content(act_id=1, data=data, username="12345")

        stored = data.tables["t1"].grid[1][0].content
        assert stored == payload

    async def test_legitimate_angle_brackets_in_cell_not_mangled(self):
        """Легитимный текст с угловыми скобками не должен искажаться."""
        svc, _ = _make_service()
        payload = "Условие: a < b и c > d"
        data = _data_with_table_cell(payload)

        await svc.save_content(act_id=1, data=data, username="12345")

        stored = data.tables["t1"].grid[1][0].content
        assert stored == payload
