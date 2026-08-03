"""Тесты для Pydantic-схем: act_metadata, act_content, act_invoice."""

from datetime import date

import pytest
from pydantic import ValidationError

from app.domains.acts.schemas.act_metadata import (
    ActCreate,
    ActDirective,
    ActUpdate,
    AuditTeamMember,
)
from app.domains.acts.schemas.act_content import (
    VIOLATION_CONTENT_ITEMS_MAX,
    VIOLATION_IMAGE_URL_MAX_LENGTH,
    ActDataSchema,
    TableCellSchema,
    TableSchema,
    TextBlockSchema,
    ViolationAdditionalContentSchema,
    ViolationContentItemSchema,
)
from app.domains.acts.schemas.act_invoice import InvoiceSave, MetricItem


# ── Фикстуры ──


def _team_minimal():
    """Минимальная аудиторская группа (куратор + руководитель)."""
    return [
        AuditTeamMember(
            role="Куратор", full_name="Иванов Иван Иванович",
            position="Директор Департамента внутреннего аудита", username="10029384",
        ),
        AuditTeamMember(
            role="Руководитель", full_name="Петров Петр Петрович",
            position="Главный аудитор", username="87654321",
        ),
    ]


def _act_create_kwargs(**overrides):
    """Базовые kwargs для ActCreate с возможностью переопределения."""
    base = dict(
        km_number="КМ-01-23456",
        inspection_name="Проверка процесса потребительского кредитования",
        city="Москва",
        order_number="478-р",
        order_date=date(2026, 1, 15),
        audit_team=_team_minimal(),
        inspection_start_date=date(2026, 2, 1),
        inspection_end_date=date(2026, 3, 1),
    )
    base.update(overrides)
    return base


# ── AuditTeamMember ──


class TestAuditTeamMember:

    def test_valid_roles(self):
        for role in ("Куратор", "Руководитель", "Редактор", "Участник"):
            m = AuditTeamMember(
                role=role, full_name="Иванов Иван Иванович",
                position="Старший аудитор", username="10029384",
            )
            assert m.role == role

    def test_invalid_role(self):
        with pytest.raises(ValidationError):
            AuditTeamMember(
                role="Аналитик", full_name="Иванов Иван Иванович",
                position="Старший аудитор", username="10029384",
            )

    def test_empty_full_name(self):
        with pytest.raises(ValidationError):
            AuditTeamMember(
                role="Куратор", full_name="", position="Старший аудитор",
                username="10029384",
            )


# ── ActDirective ──


class TestActDirective:

    def test_valid_point_numbers(self):
        for point in ("5.1", "5.1.2", "5.1.2.3"):
            d = ActDirective(point_number=point, directive_number="П-001")
            assert d.point_number == point

    def test_not_section_5(self):
        with pytest.raises(ValidationError, match="разделе 5"):
            ActDirective(point_number="3.1", directive_number="П-001")

    def test_too_deep_nesting(self):
        with pytest.raises(ValidationError, match="вложенность"):
            ActDirective(point_number="5.1.2.3.4", directive_number="П-001")

    def test_non_numeric_parts(self):
        with pytest.raises(ValidationError, match="числами"):
            ActDirective(point_number="5.abc", directive_number="П-001")

    def test_trailing_dot_stripped(self):
        d = ActDirective(point_number="5.1.", directive_number="П-001")
        assert d.point_number == "5.1"


# ── ActCreate: КМ-номер ──


class TestActCreateKmNumber:

    def test_valid_km(self):
        act = ActCreate(**_act_create_kwargs())
        assert act.km_number == "КМ-01-23456"

    def test_wrong_format_latin(self):
        with pytest.raises(ValidationError, match="КМ-XX-XXXXX"):
            ActCreate(**_act_create_kwargs(km_number="KM-01-23456"))

    def test_wrong_digit_count(self):
        with pytest.raises(ValidationError):
            ActCreate(**_act_create_kwargs(km_number="КМ-01-2345"))

    def test_missing_prefix(self):
        with pytest.raises(ValidationError):
            ActCreate(**_act_create_kwargs(km_number="01-23456"))


# ── ActCreate: служебная записка ──


class TestActCreateServiceNote:

    def test_valid_service_note_with_date(self):
        act = ActCreate(**_act_create_kwargs(
            service_note="ЦМ-75-вн/9475",
            service_note_date=date(2026, 3, 1),
        ))
        assert act.service_note == "ЦМ-75-вн/9475"

    def test_empty_string_becomes_none(self):
        act = ActCreate(**_act_create_kwargs(service_note=""))
        assert act.service_note is None

    def test_invalid_format_no_year(self):
        with pytest.raises(ValidationError, match="Текст/XXXX"):
            ActCreate(**_act_create_kwargs(
                service_note="ЦМ-без-года",
                service_note_date=date(2026, 1, 1),
            ))

    def test_note_without_date_fails(self):
        with pytest.raises(ValidationError, match="дату"):
            ActCreate(**_act_create_kwargs(
                service_note="ЦМ-75-вн/9475",
                service_note_date=None,
            ))

    def test_date_without_note_fails(self):
        with pytest.raises(ValidationError, match="записку"):
            ActCreate(**_act_create_kwargs(
                service_note=None,
                service_note_date=date(2026, 1, 1),
            ))

    def test_slash_only_prefix_fails(self):
        with pytest.raises(ValidationError, match='текст до символа "/"'):
            ActCreate(**_act_create_kwargs(
                service_note=" /2024",
                service_note_date=date(2026, 1, 1),
            ))


# ── ActCreate: аудиторская группа ──


class TestActCreateAuditTeam:

    def test_no_curator_fails(self):
        team = [
            AuditTeamMember(
                role="Руководитель", full_name="Сидоров Алексей Викторович",
                position="Старший аудитор", username="10029384",
            ),
        ]
        with pytest.raises(ValidationError, match="куратор"):
            ActCreate(**_act_create_kwargs(audit_team=team))

    def test_no_leader_fails(self):
        team = [
            AuditTeamMember(
                role="Куратор", full_name="Сидоров Алексей Викторович",
                position="Старший аудитор", username="10029384",
            ),
        ]
        with pytest.raises(ValidationError, match="руководитель"):
            ActCreate(**_act_create_kwargs(audit_team=team))

    def test_empty_team_fails(self):
        with pytest.raises(ValidationError):
            ActCreate(**_act_create_kwargs(audit_team=[]))


# ── ActUpdate ──


class TestActUpdate:

    def test_all_none_is_valid(self):
        u = ActUpdate()
        assert u.km_number is None

    def test_km_none_passes(self):
        u = ActUpdate(km_number=None)
        assert u.km_number is None

    def test_invalid_km_fails(self):
        with pytest.raises(ValidationError):
            ActUpdate(km_number="bad")

    def test_valid_km_passes(self):
        u = ActUpdate(km_number="КМ-99-11111")
        assert u.km_number == "КМ-99-11111"

    def test_audit_team_none_passes(self):
        u = ActUpdate(audit_team=None)
        assert u.audit_team is None

    def test_audit_team_no_curator_fails(self):
        with pytest.raises(ValidationError, match="куратор"):
            ActUpdate(audit_team=[
                AuditTeamMember(
                    role="Руководитель", full_name="Сидоров Алексей Викторович",
                    position="Старший аудитор", username="10029384",
                ),
            ])


# ── TableSchema ──


class TestTableSchema:

    def test_valid_table(self):
        t = TableSchema(
            id="table_1711270400456_3x2m8p1",
            nodeId="node_1711270400123_7a4k9b2",
            grid=[[TableCellSchema(content="A")]],
            colWidths=[100],
        )
        assert len(t.grid) == 1

    def test_too_many_columns(self):
        row = [TableCellSchema() for _ in range(17)]
        with pytest.raises(ValidationError, match="16"):
            TableSchema(
                id="table_1711270400456_3x2m8p1",
                nodeId="node_1711270400123_7a4k9b2",
                grid=[row], colWidths=[100] * 17,
            )

    def test_too_many_rows(self):
        grid = [[TableCellSchema()] for _ in range(65)]
        with pytest.raises(ValidationError):
            TableSchema(
                id="table_1711270400456_3x2m8p1",
                nodeId="node_1711270400123_7a4k9b2",
                grid=grid, colWidths=[100],
            )

    def test_negative_col_width(self):
        with pytest.raises(ValidationError, match="положительными"):
            TableSchema(
                id="table_1711270400456_3x2m8p1",
                nodeId="node_1711270400123_7a4k9b2",
                grid=[[TableCellSchema()]],
                colWidths=[0],
            )

    def test_empty_grid_valid(self):
        t = TableSchema(
            id="table_1711270400456_3x2m8p1",
            nodeId="node_1711270400123_7a4k9b2",
        )
        assert t.grid == []

    def test_special_table_kind(self):
        # Подвид таблицы — единое поле kind (взаимоисключение по построению).
        t = TableSchema(
            id="table_1711270400456_3x2m8p1",
            nodeId="node_1711270400123_7a4k9b2",
            kind="metrics",
        )
        assert t.kind == "metrics"

    def test_unknown_table_kind_rejected(self):
        # Неизвестный подвид таблицы → ValidationError (422).
        with pytest.raises(ValidationError):
            TableSchema(
                id="table_1711270400456_3x2m8p1",
                nodeId="node_1711270400123_7a4k9b2",
                kind="superRisk",
            )


# ── ViolationContentItemSchema: валидация url картинок (4.3.M.2 + 5.2.2) ──


class TestViolationContentItemUrl:
    """url элемента image: только data:image-URL разрешённых форматов."""

    def test_valid_data_image_png_passes(self):
        item = ViolationContentItemSchema(
            id="i1", type="image",
            url="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
        )
        assert item.url.startswith("data:image/png")

    def test_valid_data_image_jpeg_jpg_gif_pass(self):
        for mime in ("jpeg", "jpg", "gif"):
            item = ViolationContentItemSchema(
                id="i1", type="image", url=f"data:image/{mime};base64,AAAA",
            )
            assert item.url

    def test_webp_rejected(self):
        # webp исключён из whitelist: python-docx не встраивает его в DOCX,
        # картинка молча расходилась бы между превью и экспортом.
        with pytest.raises(ValidationError, match="data:image"):
            ViolationContentItemSchema(
                id="i1", type="image", url="data:image/webp;base64,AAAA",
            )

    def test_empty_url_allowed_for_image(self):
        # Картинка без содержимого (черновик) — допустима.
        item = ViolationContentItemSchema(id="i1", type="image", url="")
        assert item.url == ""

    def test_javascript_url_rejected(self):
        with pytest.raises(ValidationError, match="data:image"):
            ViolationContentItemSchema(
                id="i1", type="image", url="javascript:alert(1)",
            )

    def test_data_text_html_rejected(self):
        with pytest.raises(ValidationError, match="data:image"):
            ViolationContentItemSchema(
                id="i1", type="image",
                url="data:text/html,<script>alert(1)</script>",
            )

    def test_data_image_svg_rejected(self):
        # SVG может содержать скрипты — не входит в whitelist форматов.
        with pytest.raises(ValidationError, match="data:image"):
            ViolationContentItemSchema(
                id="i1", type="image", url="data:image/svg+xml;base64,AAAA",
            )

    def test_oversized_url_rejected(self):
        too_long = "data:image/png;base64," + "A" * VIOLATION_IMAGE_URL_MAX_LENGTH
        with pytest.raises(ValidationError, match="превышает"):
            ViolationContentItemSchema(id="i1", type="image", url=too_long)

    def test_non_image_types_do_not_require_image_url(self):
        # Для case/freeText url не проверяется на data:image-префикс.
        item = ViolationContentItemSchema(id="i1", type="case", content="текст")
        assert item.url == ""


class TestViolationAdditionalContentItemsLimit:
    """Число items дополнительного контента ограничено."""

    def _items(self, n: int) -> list[ViolationContentItemSchema]:
        return [
            ViolationContentItemSchema(id=f"i{i}", type="case", content="x")
            for i in range(n)
        ]

    def test_items_at_limit_pass(self):
        ac = ViolationAdditionalContentSchema(
            enabled=True, items=self._items(VIOLATION_CONTENT_ITEMS_MAX),
        )
        assert len(ac.items) == VIOLATION_CONTENT_ITEMS_MAX

    def test_items_over_limit_rejected(self):
        with pytest.raises(ValidationError, match="лемент"):
            ViolationAdditionalContentSchema(
                enabled=True, items=self._items(VIOLATION_CONTENT_ITEMS_MAX + 1),
            )


# ── ViolationContentItemSchema: устаревшее поле order (#24) ──


class TestViolationContentItemLegacyOrder:
    """Директива владельца 1B: шим снят, обратная совместимость не нужна.

    Поле order вырезано из модели (#24); порядок элемента задаётся позицией в
    списке items. Прежний before-валидатор молча выкидывал ключ ради restore
    старых актов — снят. При extra="forbid" подача order теперь отвергается
    (БД пересоздаётся с нуля, легаси-данных нет).
    """

    def test_legacy_order_key_rejected(self):
        with pytest.raises(ValidationError, match="order"):
            ViolationContentItemSchema.model_validate({
                "id": "i1", "type": "case", "content": "текст", "order": 3,
            })

    def test_other_unknown_field_still_rejected(self):
        # extra="forbid": любое незадекларированное поле отвергается.
        with pytest.raises(ValidationError, match="junk"):
            ViolationContentItemSchema(id="i1", type="case", junk=1)


# ── TextBlockSchema: устаревшее поле formatting ──


class TestTextBlockLegacyFormatting:
    """Директива владельца 1B: шим снят, обратная совместимость не нужна.

    Контейнерный объект formatting вырезан из модели. Прежний before-валидатор
    молча выкидывал ключ ради restore старых актов — снят. При extra="forbid"
    подача formatting теперь отвергается (БД пересоздаётся с нуля).
    """

    def test_legacy_formatting_key_rejected(self):
        with pytest.raises(ValidationError, match="formatting"):
            TextBlockSchema.model_validate({
                "id": "b1", "nodeId": "n1", "content": "<p>текст</p>",
                "formatting": {
                    "fontSize": 14, "alignment": "center",
                    "bold": True, "italic": False, "underline": False,
                },
            })

    def test_other_unknown_field_still_rejected(self):
        # extra="forbid": любое незадекларированное поле отвергается.
        with pytest.raises(ValidationError, match="junk"):
            TextBlockSchema(id="b1", nodeId="n1", junk=1)


# ── ActDataSchema ──


class TestActDataSchema:

    # C4: tree теперь валидируется через ActItemSchema — узел обязан иметь id.
    _VALID_TREE = {"id": "root", "label": "Акт", "children": []}

    def test_valid_save_types(self):
        for st in ("manual", "periodic", "auto"):
            d = ActDataSchema(tree=dict(self._VALID_TREE), saveType=st)
            assert d.saveType == st

    def test_invalid_save_type(self):
        with pytest.raises(ValidationError):
            ActDataSchema(tree=dict(self._VALID_TREE), saveType="unknown")

    def test_invalid_tree_rejected(self):
        # Дерево без id отбраковывается валидатором структуры (C4).
        with pytest.raises(ValidationError):
            ActDataSchema(tree={})

    def test_default_collections(self):
        d = ActDataSchema(tree=dict(self._VALID_TREE))
        assert d.tables == {}
        assert d.textBlocks == {}
        assert d.violations == {}
        assert d.invoiceNodeIds == []
        assert d.changelog == []


# ── M.20: явная политика extra='forbid' для схем словарей ──


class TestExtraForbidPolicy:
    """Неизвестные поля в схемах словарей отклоняются (раньше молча терялись)."""

    _TABLE_KW = dict(
        id="t1", nodeId="n1",
        grid=[[TableCellSchema(content="A")]], colWidths=[100],
    )

    def test_unknown_field_in_table_rejected(self):
        with pytest.raises(ValidationError, match="unknown_field"):
            TableSchema(**self._TABLE_KW, unknown_field="x")

    def test_unknown_field_in_cell_rejected(self):
        with pytest.raises(ValidationError, match="surprise"):
            TableCellSchema(content="A", surprise=True)

    def test_unknown_field_in_textblock_rejected(self):
        with pytest.raises(ValidationError, match="junk"):
            TextBlockSchema(id="tb1", nodeId="n1", junk=1)

    def test_unknown_field_in_violation_item_rejected(self):
        with pytest.raises(ValidationError, match="position"):
            ViolationContentItemSchema(id="i1", type="case", position=3)

    def test_unknown_top_level_field_rejected(self):
        with pytest.raises(ValidationError, match="metadata"):
            ActDataSchema(
                tree=dict(TestActDataSchema._VALID_TREE),
                metadata={"km_number": "КМ-01-0000001"},
            )

    def test_known_table_fields_round_trip(self):
        """Round-trip: все объявленные поля переживают validate → dump → validate."""
        t = TableSchema(
            id="t1", nodeId="n1",
            grid=[[TableCellSchema(
                content="A", isHeader=True, colSpan=1, rowSpan=1,
                isSpanned=False, spanOrigin=None, originRow=0, originCol=0,
            )]],
            colWidths=[100],
            protected=True, deletable=False, kind="metrics",
        )
        dumped = t.model_dump()
        restored = TableSchema.model_validate(dumped)
        assert restored.model_dump() == dumped


# ── M.21: дерево хранится нормализованным через ActItemSchema ──


class TestTreeNormalization:
    """tree сохраняется как model_dump() от ActItemSchema, а не сырой dict."""

    def test_unknown_node_field_dropped_on_normalization(self):
        """Незадекларированное поле узла (например parentId) не персистится."""
        tree = {
            "id": "root", "label": "Акт",
            "children": [
                {"id": "n1", "label": "Таблица", "type": "table",
                 "tableId": "t1", "parentId": "root", "children": []},
            ],
        }
        d = ActDataSchema(tree=tree, tables={
            "t1": TableSchema(id="t1", nodeId="n1"),
        })
        child = d.tree["children"][0]
        assert "parentId" not in child
        assert child["tableId"] == "t1"

    def test_known_node_fields_preserved(self):
        """Все поля, которые шлёт фронтовый exportData, переживают нормализацию."""
        tree = {
            "id": "root", "label": "Акт",
            "children": [
                {
                    "id": "n1", "label": "5.1 Пункт", "type": "item",
                    "content": "текст", "protected": True, "deletable": False,
                    "customLabel": "Своя метка", "number": "5.1",
                    "tb": ["ВВБ", "СЗБ"], "auditPointId": "AP-1",
                    "kind": "metrics",
                    "children": [],
                },
            ],
        }
        d = ActDataSchema(tree=tree)
        child = d.tree["children"][0]
        assert child["id"] == "n1"
        assert child["label"] == "5.1 Пункт"
        assert child["type"] == "item"
        assert child["content"] == "текст"
        assert child["protected"] is True
        assert child["deletable"] is False
        assert child["customLabel"] == "Своя метка"
        assert child["number"] == "5.1"
        assert child["tb"] == ["ВВБ", "СЗБ"]
        assert child["auditPointId"] == "AP-1"
        assert child["kind"] == "metrics"
        assert child["children"] == []

    def test_tree_is_normalized_dict_not_raw_reference(self):
        """Хранимое дерево — новый нормализованный dict, не исходная ссылка."""
        raw = {"id": "root", "label": "Акт", "children": [], "garbage": 1}
        d = ActDataSchema(tree=raw)
        assert d.tree is not raw
        assert "garbage" not in d.tree
        # Исходный dict не мутирован
        assert "garbage" in raw


# ── M.13: кросс-валидатор дерево ↔ словари ──


class TestTreeDictCrossValidation:
    """Висячая ссылка дерево → словари НЕ отбивает PUT 422 (решение «lenient»).

    Разбор запроса больше не бросает: collect_dangling_refs ВОЗВРАЩАЕТ висячие
    ссылки, а сервис (ActContentService.save_content) их вычищает и
    предупреждает пользователя одним warning'ом. Обе стороны рассогласования
    (висячая ссылка узла и запись словаря без узла) лечатся мягко.
    """

    @staticmethod
    def _tree_with_ref(ref_field: str, ref_value: str, node_type: str) -> dict:
        return {
            "id": "root", "label": "Акт",
            "children": [
                {"id": "n1", "label": "Узел", "type": node_type,
                 ref_field: ref_value, "children": []},
            ],
        }

    def test_dangling_table_ref_collected_not_raised(self):
        """Висячая ссылка на таблицу не роняет разбор, попадает в список."""
        d = ActDataSchema(tree=self._tree_with_ref("tableId", "t_ghost", "table"))
        assert d.collect_dangling_refs() == [("n1", "tableId", "t_ghost")]

    def test_dangling_textblock_ref_collected_not_raised(self):
        d = ActDataSchema(
            tree=self._tree_with_ref("textBlockId", "tb_ghost", "textblock"),
        )
        assert d.collect_dangling_refs() == [("n1", "textBlockId", "tb_ghost")]

    def test_dangling_violation_ref_collected_not_raised(self):
        d = ActDataSchema(
            tree=self._tree_with_ref("violationId", "v_ghost", "violation"),
        )
        assert d.collect_dangling_refs() == [("n1", "violationId", "v_ghost")]

    def test_collect_returns_node_id_field_and_ref(self):
        """Кортеж висячей ссылки несёт id узла, поле-ссылку и значение."""
        d = ActDataSchema(tree=self._tree_with_ref("tableId", "t_ghost", "table"))
        node_id, ref_field, ref = d.collect_dangling_refs()[0]
        assert node_id == "n1"
        assert ref_field == "tableId"
        assert ref == "t_ghost"

    def test_valid_refs_have_no_dangling(self):
        d = ActDataSchema(
            tree={
                "id": "root", "label": "Акт",
                "children": [
                    {"id": "n1", "label": "Таблица", "type": "table",
                     "tableId": "t1", "children": []},
                    {"id": "n2", "label": "ТБ", "type": "textblock",
                     "textBlockId": "tb1", "children": []},
                ],
            },
            tables={"t1": TableSchema(id="t1", nodeId="n1")},
            textBlocks={"tb1": TextBlockSchema(id="tb1", nodeId="n2")},
        )
        assert d.tree["children"][0]["tableId"] == "t1"
        assert d.collect_dangling_refs() == []

    def test_orphan_dict_entry_allowed(self):
        """Обратное направление — запись словаря без узла — НЕ ошибка.

        Такие записи отбрасывает orphan-фильтр репозитория при сохранении
        (pbe-4); отклонять весь PUT из-за них нельзя. Висячих ссылок дерева
        здесь нет — collect_dangling_refs пуст.
        """
        d = ActDataSchema(
            tree={"id": "root", "label": "Акт", "children": []},
            tables={"t_orphan": TableSchema(id="t_orphan", nodeId="ghost")},
        )
        assert "t_orphan" in d.tables
        assert d.collect_dangling_refs() == []

    def test_dangling_ref_in_nested_node_collected(self):
        """Обход рекурсивен: висячая ссылка вложенного узла тоже собирается."""
        tree = {
            "id": "root", "label": "Акт",
            "children": [
                {"id": "s1", "label": "Раздел", "type": "item", "children": [
                    {"id": "n9", "label": "Нарушение", "type": "violation",
                     "violationId": "v_missing", "children": []},
                ]},
            ],
        }
        d = ActDataSchema(tree=tree)
        assert ("n9", "violationId", "v_missing") in d.collect_dangling_refs()


# ── MetricItem ──


class TestMetricItem:

    def test_valid_metric_types(self):
        for mt in ("КС", "ФР", "ОР", "РР", "МКР"):
            m = MetricItem(metric_type=mt)
            assert m.metric_type == mt

    def test_invalid_metric_type(self):
        with pytest.raises(ValidationError, match="Недопустимый тип"):
            MetricItem(metric_type="INVALID")


# ── InvoiceSave ──


class TestInvoiceSave:

    def _base_kwargs(self, **overrides):
        base = dict(
            act_id=1, node_id="node_1711270400100_abc1234", db_type="hive",
            schema_name="schema", table_name="table",
            metrics=[MetricItem(metric_type="КС")],
        )
        base.update(overrides)
        return base

    def test_valid_invoice(self):
        inv = InvoiceSave(**self._base_kwargs())
        assert inv.act_id == 1

    def test_duplicate_metric_types_fail(self):
        with pytest.raises(ValidationError, match="уникальными"):
            InvoiceSave(**self._base_kwargs(
                metrics=[
                    MetricItem(metric_type="КС"),
                    MetricItem(metric_type="КС"),
                ],
            ))

    def test_too_many_metrics_fail(self):
        with pytest.raises(ValidationError):
            InvoiceSave(**self._base_kwargs(
                metrics=[MetricItem(metric_type=t) for t in
                         ["КС", "ФР", "ОР", "РР", "МКР", "КС"]],
            ))

    def test_empty_metrics_fail(self):
        with pytest.raises(ValidationError):
            InvoiceSave(**self._base_kwargs(metrics=[]))

    def test_invalid_db_type_fail(self):
        with pytest.raises(ValidationError):
            InvoiceSave(**self._base_kwargs(db_type="mysql"))

    def test_all_5_metrics_valid(self):
        inv = InvoiceSave(**self._base_kwargs(
            metrics=[MetricItem(metric_type=t) for t in
                     ["КС", "ФР", "ОР", "РР", "МКР"]],
        ))
        assert len(inv.metrics) == 5


# == Динамические лимиты из настроек (#3, #15, #13) ==


class TestDynamicLimitsFromSettings:
    """Схема читает лимиты из реестра настроек (единый источник, config/env)."""

    @pytest.fixture(autouse=True)
    def _reset_registry(self):
        from app.core import settings_registry
        settings_registry.reset()
        yield
        settings_registry.reset()

    @staticmethod
    def _register(acts_settings):
        from app.core import settings_registry
        from app.domains.acts import DOMAIN_NAME
        settings_registry._registry[DOMAIN_NAME] = acts_settings

    def test_items_count_limit_from_settings(self):
        """#3: лимит элементов нарушения берётся из ACTS__IMAGES__MAX_ITEMS_PER_VIOLATION."""
        from app.domains.acts.settings import ActsSettings, ImagesSettings
        self._register(ActsSettings(images=ImagesSettings(max_items_per_violation=2)))
        items = [
            ViolationContentItemSchema(id=str(i), type="freeText", content="x")
            for i in range(3)
        ]
        with pytest.raises(ValidationError) as exc_info:
            ViolationAdditionalContentSchema(enabled=True, items=items)
        # №14: текст синхронизирован вручную с фронтом (AppConfig.content.errors.
        # contentItemsLimitReached, static/js/shared/app-config.js) — должен
        # совпадать дословно.
        assert "Достигнут лимит элементов дополнительного контента на нарушение (2)." in str(exc_info.value)
        # 2 элемента проходят
        ViolationAdditionalContentSchema(enabled=True, items=items[:2])

    def test_image_mime_whitelist_from_settings(self):
        """#15: добавленный в настройки MIME принимается схемой url."""
        from app.domains.acts.settings import ActsSettings, ImagesSettings
        self._register(ActsSettings(
            images=ImagesSettings(allowed_mime_types=["image/webp", "image/png"])
        ))
        # webp теперь валиден
        ViolationContentItemSchema(id="1", type="image", url="data:image/webp;base64,AAAA")
        # gif больше не в whitelist -> отвергается
        with pytest.raises(ValidationError):
            ViolationContentItemSchema(id="2", type="image", url="data:image/gif;base64,AAAA")

    def test_table_rows_limit_from_settings(self):
        """#13: потолок строк grid берётся из ACTS__TABLES__MAX_ROWS."""
        from app.domains.acts.settings import ActsSettings, TablesSettings
        self._register(ActsSettings(tables=TablesSettings(max_rows=2)))
        cell = lambda: TableCellSchema(content="x")
        grid3 = [[cell()], [cell()], [cell()]]
        with pytest.raises(ValidationError):
            TableSchema(id="t", nodeId="n", grid=grid3)
        TableSchema(id="t", nodeId="n", grid=grid3[:2])

    def test_font_size_default_from_settings(self):
        """EXP-2: базовый размер текстблока берётся из
        ACTS__TEXTBLOCKS__FONT_SIZE_DEFAULT (единый источник /limits и экспорта)."""
        from app.domains.acts.settings import ActsSettings, TextblocksSettings
        self._register(ActsSettings(textblocks=TextblocksSettings(font_size_default=20)))
        from app.core import settings_registry
        from app.domains.acts import DOMAIN_NAME
        assert settings_registry._registry[DOMAIN_NAME].textblocks.font_size_default == 20
        # Дефолт — 16px.
        assert TextblocksSettings().font_size_default == 16
