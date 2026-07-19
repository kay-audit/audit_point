"""
XSS-санитизация content-полей акта на бэкенде.

Гарантирует, что ActContentService.save_content вычищает опасные
теги/атрибуты до записи в БД: <script>, <img onerror>, <svg onload>,
<iframe srcdoc>, javascript:-URL — для textBlock.content, узлов дерева
(реальный HTML, рендерится через innerHTML) и rich-полей нарушения
(violated/established, reasons/measures/consequences/responsible.content,
additionalContent.items[] типов case/freeText — по реестру
VIOLATION_FIELDS.rich, см. TestSaveContentViolationRichFieldsSanitized).
Whitelist разрешает p/b/i/span/a/... и атрибуты {a:href,title;
span:class,style; div/p:class,style; *:class}.

Plain-text поля нарушения (descriptionList.items[], additionalContent.
items[].filename/url) через санитайзер НЕ гоняются — нигде не
рендерятся как innerHTML, поэтому хранятся дословно (см. те же тесты).
additionalContent.items[].caption (тип image) — rich-поле (Task 6,
rich-редактор подписи), санитизируется как case/freeText.content.

Тесты дополнительно покрывают utils/html_sanitizer.sanitize_html/
sanitize_rich_html напрямую (быстрые сценарии без поднятия сервиса).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.domains.acts.schemas.act_content import (
    ActDataSchema,
    TableCellSchema,
    TableSchema,
    TextBlockSchema,
    ViolationSchema,
    ViolationOptionalFieldSchema,
    ViolationAdditionalContentSchema,
    ViolationContentItemSchema,
)
from app.domains.acts.schemas.act_content import ViolationDescriptionListSchema
from app.domains.acts.services.act_content_service import ActContentService
from app.domains.acts.utils.html_sanitizer import (
    sanitize_html,
    sanitize_plain_text,
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
    """sanitize_rich_html: nh3-санитайзер для rich-полей нарушения (1.2.3).

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


def _data_with_violation(*, violated="", established="",
                          add_item_html="", field_html="") -> ActDataSchema:
    v = ViolationSchema(
        id="v1",
        nodeId="n1",
        violated=violated,
        established=established,
        additionalContent=ViolationAdditionalContentSchema(
            enabled=True,
            items=[ViolationContentItemSchema(
                id="i1", type="freeText", content=add_item_html,
            )],
        ),
        reasons=ViolationOptionalFieldSchema(enabled=True, content=field_html),
        measures=ViolationOptionalFieldSchema(enabled=True, content=field_html),
        consequences=ViolationOptionalFieldSchema(enabled=True, content=field_html),
        responsible=ViolationOptionalFieldSchema(enabled=True, content=field_html),
    )
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


class TestSaveContentViolationRichFieldsSanitized:
    """save_content прогоняет RICH-поля нарушения через sanitize_rich_html.

    Фиксирует НОВУЮ семантику (флип): rich-поля нарушения (violated/
    established, reasons/measures/consequences/responsible,
    additionalContent.items[] типов case/freeText) теперь реальный HTML,
    рендерящийся как innerHTML (rich-редактор, §9 паритет) — санитизируются
    как любой другой HTML-контент (см. докстринг sanitize_act_data).
    additionalContent.items[] типа image — caption (Task 6, rich-редактор
    подписи) санитизируется так же. Plain-поля (descriptionList.items[],
    additionalContent.items[].filename/url) остаются дословными. Старый класс
    TestSaveContentViolationFieldsStoredVerbatim фиксировал ДО-rich
    поведение (ВСЕ поля нарушения дословны) — заменён этим классом.
    """

    async def test_violated_established_sanitized(self):
        svc, _ = _make_service()
        data = _data_with_violation(violated="<p>ok</p><script>alert(1)</script>",
                                     established='<img onerror="x" src=y>вред')

        await svc.save_content(act_id=1, data=data, username="12345")

        v = data.violations["v1"]
        assert "<script" not in v.violated and "<p>ok</p>" in v.violated
        assert "onerror" not in v.established and "<img" not in v.established and "вред" in v.established

    async def test_optional_fields_sanitized(self):
        """reasons/measures/consequences/responsible.content санитизируются."""
        svc, _ = _make_service()
        raw = '<b>причина</b><svg onload="x"></svg>'
        data = _data_with_violation(field_html=raw)

        await svc.save_content(act_id=1, data=data, username="12345")

        v = data.violations["v1"]
        for fname in ("reasons", "measures", "consequences", "responsible"):
            content = getattr(v, fname).content
            assert "<svg" not in content and "onload" not in content
            assert "<b>причина</b>" in content

    async def test_case_freetext_content_sanitized(self):
        """additionalContent item (type=case И type=freeText) — content санитизируется."""
        svc, _ = _make_service()
        raw_case = '<p>кейс</p><iframe srcdoc="x"></iframe>'
        raw_free = '<b>текст</b><svg onload="x"></svg>'
        data = _data_with_violation(add_item_html=raw_case)
        data.violations["v1"].additionalContent.items[0].type = "case"
        data.violations["v1"].additionalContent.items.append(
            ViolationContentItemSchema(id="i2", type="freeText", content=raw_free)
        )

        await svc.save_content(act_id=1, data=data, username="12345")

        items = data.violations["v1"].additionalContent.items
        case_item = items[0]
        assert "<iframe" not in case_item.content and "srcdoc" not in case_item.content
        assert "<p>кейс</p>" in case_item.content
        freetext_item = items[1]
        assert "<svg" not in freetext_item.content and "onload" not in freetext_item.content
        assert "<b>текст</b>" in freetext_item.content

    async def test_allowlisted_formatting_survives(self):
        """Разрешённые тег/CSS/ссылка нарушения переживают санитизацию."""
        svc, _ = _make_service()
        raw = '<span style="font-size: 20px">крупно</span><a href="https://e.com">l</a>'
        data = _data_with_violation(violated=raw)

        await svc.save_content(act_id=1, data=data, username="12345")

        v = data.violations["v1"]
        assert "font-size" in v.violated and "20px" in v.violated
        assert 'href="https://e.com"' in v.violated

    async def test_ampersand_html_encoded_not_corruption(self):
        """"&" → "&amp;" — корректное HTML-хранение rich-поля, не порча текста."""
        svc, _ = _make_service()
        data = _data_with_violation(violated="Ромашка & Ко")

        await svc.save_content(act_id=1, data=data, username="12345")

        assert data.violations["v1"].violated == "Ромашка &amp; Ко"

    async def test_description_list_verbatim(self):
        """descriptionList.items — plain-поле, санитайзер его не касается."""
        svc, _ = _make_service()
        data = _data_with_violation()
        raw_items = [
            "обычный",
            "<script>alert(1)</script>опасный",
            "a<b и c>d",
        ]
        data.violations["v1"].descriptionList = ViolationDescriptionListSchema(
            enabled=True,
            items=list(raw_items),
        )

        await svc.save_content(act_id=1, data=data, username="12345")

        assert data.violations["v1"].descriptionList.items == raw_items

    async def test_image_filename_url_verbatim(self):
        """filename/url элемента additionalContent — plain, дословно."""
        svc, _ = _make_service()
        data = _data_with_violation()
        raw_filename = "<script>x</script>ф.png"
        url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="
        item = data.violations["v1"].additionalContent.items[0]
        item.type = "image"
        item.filename = raw_filename
        item.url = url

        await svc.save_content(act_id=1, data=data, username="12345")

        item = data.violations["v1"].additionalContent.items[0]
        assert item.filename == raw_filename
        assert item.url == url

    async def test_image_caption_sanitized(self):
        """caption элемента additionalContent (image) — rich, санитизируется (Task 6).

        Allowlisted-тег (<b>) переживает санитизацию, опасный payload
        (<img onerror>) вырезается — зеркало test_case_freetext_content_sanitized.
        """
        svc, _ = _make_service()
        data = _data_with_violation()
        raw_caption = '<b>подпись</b><img src=x onerror="a">'
        item = data.violations["v1"].additionalContent.items[0]
        item.type = "image"
        item.caption = raw_caption

        await svc.save_content(act_id=1, data=data, username="12345")

        item = data.violations["v1"].additionalContent.items[0]
        assert "<b>подпись</b>" in item.caption
        assert "<img" not in item.caption and "onerror" not in item.caption

    async def test_image_caption_none_stays_none(self):
        """caption=None (легаси-данные без подписи) — санитайзер не подменяет на ''."""
        svc, _ = _make_service()
        data = _data_with_violation()
        item = data.violations["v1"].additionalContent.items[0]
        item.type = "image"
        item.caption = None

        await svc.save_content(act_id=1, data=data, username="12345")

        assert data.violations["v1"].additionalContent.items[0].caption is None


class TestSanitizePlainTextDirect:
    """sanitize_plain_text: plain-поля — без тегов вовсе (пустой whitelist)."""

    def test_strips_all_tags_including_whitelisted(self):
        out = sanitize_plain_text("<p>a</p><b>b</b><script>alert(1)</script>c")
        assert "<" not in out
        assert "a" in out and "b" in out and "c" in out

    def test_plain_text_passes_through(self):
        assert sanitize_plain_text("просто текст 123") == "просто текст 123"

    def test_empty_and_none_inputs(self):
        assert sanitize_plain_text("") == ""
        assert sanitize_plain_text(None) == ""

    def test_non_string_falls_back_to_str(self):
        assert sanitize_plain_text(42) == "42"


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
