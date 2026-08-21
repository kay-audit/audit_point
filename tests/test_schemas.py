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
    ActDataSchema,
    EmbeddedTableSchema,
    TableCellSchema,
    TableSchema,
    TextBlockSchema,
    ViolationFieldSchema,
    ViolationImageBlockSchema,
    ViolationSchema,
)
from app.domains.acts.violation_fields import VIOLATION_FIELD_KEYS
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


# ── Блоки полей нарушения (блочная модель) ──


class TestViolationImageBlockImageId:
    """Блок-картинка адресует байты через image_id (строка act_images).

    Поля url и его валидатора формата/длины больше нет: и whitelist форматов,
    и лимиты размера проверяются один раз при загрузке
    (POST /api/v1/acts/{act_id}/images), а не на каждом сохранении контента.
    """

    def test_image_id_stored_as_is(self):
        block = ViolationImageBlockSchema(
            id="image_1_a", type="image",
            image_id="8f14e45f-ea0b-4d1e-9c2a-1b2c3d4e5f60",
        )
        assert block.image_id == "8f14e45f-ea0b-4d1e-9c2a-1b2c3d4e5f60"

    def test_empty_image_id_allowed(self):
        # Картинка без содержимого (черновик) — допустима.
        block = ViolationImageBlockSchema(id="image_1_a", type="image")
        assert block.image_id == ""

    def test_url_field_is_gone(self):
        # extra='forbid': старое поле теперь отбивается 422, а не хранится.
        with pytest.raises(ValidationError, match="url"):
            ViolationImageBlockSchema(
                id="image_1_a", type="image",
                url="data:image/png;base64,AAAA",
            )


class TestViolationBlockUnion:
    """Дискриминированный union блоков: диспетчеризация по type, 422 на чужом."""

    def test_three_block_types_dispatch(self):
        field = ViolationFieldSchema.model_validate({
            "enabled": True,
            "blocks": [
                {"id": "text_1_a", "type": "text", "content": "<p>x</p>"},
                {"id": "image_1_b", "type": "image", "image_id": ""},
                {"id": "table_1_c", "type": "table",
                 "table": {"grid": [[{"content": "A"}]], "colWidths": [100]}},
            ],
        })
        assert [type(b).__name__ for b in field.blocks] == [
            "ViolationTextBlockSchema",
            "ViolationImageBlockSchema",
            "ViolationTableBlockSchema",
        ]

    def test_unknown_block_type_rejected(self):
        # Неизвестный тип блока → громкая 422, fallback'а сознательно нет.
        with pytest.raises(ValidationError):
            ViolationFieldSchema.model_validate({
                "enabled": True,
                "blocks": [{"id": "b1", "type": "case", "content": "x"}],
            })

    def test_embedded_table_has_no_node_metadata(self):
        # EmbeddedTableSchema: сетка без id/nodeId/kind (extra=forbid).
        with pytest.raises(ValidationError, match="nodeId"):
            EmbeddedTableSchema.model_validate({"grid": [], "nodeId": "n1"})
        with pytest.raises(ValidationError, match="kind"):
            EmbeddedTableSchema.model_validate({"grid": [], "kind": "metrics"})


class TestViolationFieldBlocksLimit:
    """Число блоков в поле нарушения ограничено (лимит — из настроек)."""

    def _blocks(self, n: int) -> list[dict]:
        return [
            {"id": f"text_1_{i}", "type": "text", "content": "x"}
            for i in range(n)
        ]

    def test_blocks_at_limit_pass(self):
        field = ViolationFieldSchema.model_validate(
            {"enabled": True, "blocks": self._blocks(VIOLATION_CONTENT_ITEMS_MAX)},
        )
        assert len(field.blocks) == VIOLATION_CONTENT_ITEMS_MAX

    def test_blocks_over_limit_rejected(self):
        with pytest.raises(ValidationError, match="лимит блоков"):
            ViolationFieldSchema.model_validate(
                {"enabled": True, "blocks": self._blocks(VIOLATION_CONTENT_ITEMS_MAX + 1)},
            )


class TestViolationSchemaFieldOrder:
    """fieldOrder — перестановка всех ключей реестра либо None."""

    def test_none_is_default(self):
        v = ViolationSchema(id="v1", nodeId="n1")
        assert v.fieldOrder is None

    def test_valid_permutation_accepted(self):
        order = list(reversed(VIOLATION_FIELD_KEYS))
        v = ViolationSchema(id="v1", nodeId="n1", fieldOrder=order)
        assert v.fieldOrder == order

    def test_incomplete_order_rejected(self):
        with pytest.raises(ValidationError, match="ровно один раз"):
            ViolationSchema(
                id="v1", nodeId="n1", fieldOrder=list(VIOLATION_FIELD_KEYS[1:]),
            )

    def test_duplicate_key_rejected(self):
        order = list(VIOLATION_FIELD_KEYS[:-1]) + [VIOLATION_FIELD_KEYS[0]]
        with pytest.raises(ValidationError, match="ровно один раз"):
            ViolationSchema(id="v1", nodeId="n1", fieldOrder=order)

    def test_alien_key_rejected(self):
        order = list(VIOLATION_FIELD_KEYS[:-1]) + ["unknownField"]
        with pytest.raises(ValidationError, match="ровно один раз"):
            ViolationSchema(id="v1", nodeId="n1", fieldOrder=order)


class TestViolationSchemaMandatoryFields:
    """Нарушено/Установлено нельзя выключить — enabled принуждается к True."""

    def test_defaults_enabled(self):
        v = ViolationSchema(id="v1", nodeId="n1")
        assert v.violated.enabled is True
        assert v.established.enabled is True
        assert v.reasons.enabled is False

    def test_disabled_mandatory_coerced_to_enabled(self):
        v = ViolationSchema.model_validate({
            "id": "v1", "nodeId": "n1",
            "violated": {"enabled": False, "blocks": []},
        })
        assert v.violated.enabled is True

    def test_registry_fields_match_schema(self):
        # Все 10 полей реестра присутствуют в схеме контейнерами.
        v = ViolationSchema(id="v1", nodeId="n1")
        for key in VIOLATION_FIELD_KEYS:
            field = getattr(v, key)
            assert isinstance(field, ViolationFieldSchema)


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

    def test_unknown_field_in_violation_block_rejected(self):
        with pytest.raises(ValidationError, match="position"):
            ViolationImageBlockSchema(id="image_1_a", type="image", position=3)

    def test_unknown_field_in_violation_rejected(self):
        with pytest.raises(ValidationError, match="junk"):
            ViolationSchema(id="v1", nodeId="n1", junk=1)

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

    def test_process_mining_special_flags_preserved(self):
        """Спец-поля узла Process Mining (special/titleLocked) переживают
        нормализацию дерева, а незадекларированный мусор рядом с ними —
        по-прежнему отбрасывается (extra='ignore' не должна пропускать всё).

        Регресс на баг: фронт сериализует special/titleLocked
        (state-core.js::_serializeTree), но ActItemSchema их не объявляла →
        после save+reload узел Process Mining терял флаги, снимался запрет
        добавлять нарушения/риски под разделом и заголовок вновь становился
        редактируемым."""
        tree = {
            "id": "root", "label": "Акт",
            "children": [
                {
                    "id": "6", "label": "Process Mining", "type": "item",
                    "special": "process_mining", "titleLocked": True,
                    "parentId": "root", "children": [],
                },
            ],
        }
        d = ActDataSchema(tree=tree)
        child = d.tree["children"][0]
        assert child["special"] == "process_mining"
        assert child["titleLocked"] is True
        assert "parentId" not in child


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
        """#3: лимит блоков поля нарушения берётся из ACTS__IMAGES__MAX_ITEMS_PER_VIOLATION."""
        from app.domains.acts.settings import ActsSettings, ImagesSettings
        self._register(ActsSettings(images=ImagesSettings(max_items_per_violation=2)))
        blocks = [
            {"id": f"text_1_{i}", "type": "text", "content": "x"}
            for i in range(3)
        ]
        with pytest.raises(ValidationError) as exc_info:
            ViolationFieldSchema.model_validate({"enabled": True, "blocks": blocks})
        # №14: текст синхронизирован вручную с фронтом (AppConfig.content.errors.
        # contentItemsLimitReached, static/js/shared/app-config.js) — должен
        # совпадать дословно.
        assert "Достигнут лимит блоков в поле нарушения (2)." in str(exc_info.value)
        # 2 блока проходят
        ViolationFieldSchema.model_validate({"enabled": True, "blocks": blocks[:2]})

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
        """Базовый размер текстблока берётся из
        ACTS__TEXTBLOCKS__FONT_SIZE_DEFAULT (единый источник /limits и экспорта).
        Единица — пункты."""
        from app.domains.acts.settings import ActsSettings, TextblocksSettings
        self._register(ActsSettings(textblocks=TextblocksSettings(font_size_default=20)))
        from app.core import settings_registry
        from app.domains.acts import DOMAIN_NAME
        assert settings_registry._registry[DOMAIN_NAME].textblocks.font_size_default == 20
        # Дефолт — 12pt.
        assert TextblocksSettings().font_size_default == 12
