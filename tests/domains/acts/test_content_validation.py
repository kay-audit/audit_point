"""Тесты сборщика замечаний валидации акта (фича статуса #8)."""

from app.domains.acts.schemas.act_content import ActDataSchema
from app.domains.acts.services.content_validation import (
    collect_validation_issues,
    status_from_issues,
)


def _base_sections():
    """Защищённые разделы 1–6 (1-5 + Process Mining) — валидная базовая структура."""
    return [
        {"id": str(i), "label": f"Раздел {i}", "type": "item",
         "protected": True, "deletable": False, "children": []}
        for i in range(1, 7)
    ]


def _valid_act(**tables):
    return ActDataSchema(
        tree={"id": "root", "label": "Акт", "children": _base_sections()},
        tables=tables,
        saveType="manual",
    )


def _codes(issues):
    return {i["code"] for i in issues}


def test_valid_structure_no_issues():
    issues = collect_validation_issues(_valid_act())
    assert issues == []
    assert status_from_issues(issues) == "ok"


def test_empty_tree_is_error():
    data = ActDataSchema(tree={"id": "root", "label": "Акт", "children": []}, saveType="manual")
    issues = collect_validation_issues(data)
    assert "empty_structure" in _codes(issues)
    assert status_from_issues(issues) == "error"


def test_missing_base_sections():
    data = ActDataSchema(
        tree={"id": "root", "label": "Акт", "children": [
            {"id": "1", "label": "Раздел 1", "type": "item",
             "protected": True, "deletable": False, "children": []},
        ]},
        saveType="manual",
    )
    issues = collect_validation_issues(data)
    assert "missing_sections" in _codes(issues)


def test_unprotected_base_section():
    sections = _base_sections()
    sections[2]["protected"] = False  # раздел 3 раззащищён
    data = ActDataSchema(
        tree={"id": "root", "label": "Акт", "children": sections},
        saveType="manual",
    )
    issues = collect_validation_issues(data)
    assert "unprotected_sections" in _codes(issues)


def test_table_without_header_is_error():
    table = {
        "id": "t1", "nodeId": "5",
        "grid": [[{"content": "данные", "isHeader": False}]],
        "colWidths": [100],
    }
    issues = collect_validation_issues(_valid_act(t1=table))
    assert "table_no_header" in _codes(issues)
    assert status_from_issues(issues) == "error"


def test_table_empty_header_is_error():
    table = {
        "id": "t1", "nodeId": "5",
        "grid": [
            [{"content": "", "isHeader": True}],
            [{"content": "данные", "isHeader": False}],
        ],
        "colWidths": [100],
    }
    issues = collect_validation_issues(_valid_act(t1=table))
    assert "table_empty_header" in _codes(issues)


def test_table_no_data_is_warning():
    table = {
        "id": "t1", "nodeId": "5",
        "grid": [[{"content": "Заголовок", "isHeader": True}]],
        "colWidths": [100],
    }
    issues = collect_validation_issues(_valid_act(t1=table))
    assert "table_no_data" in _codes(issues)
    # Только warning-замечание (пустая таблица) → статус 'warning', не 'error'.
    assert status_from_issues(issues) == "warning"


def test_status_from_issues_levels():
    """status_from_issues: error доминирует; только warning → warning; пусто → ok."""
    assert status_from_issues([]) == "ok"
    assert status_from_issues([{"severity": "warning"}]) == "warning"
    assert status_from_issues([{"severity": "error"}]) == "error"
    # Смесь error+warning → error (error доминирует).
    assert status_from_issues([{"severity": "warning"}, {"severity": "error"}]) == "error"


def test_complete_table_no_issues():
    table = {
        "id": "t1", "nodeId": "5",
        "grid": [
            [{"content": "Заголовок", "isHeader": True}],
            [{"content": "значение", "isHeader": False}],
        ],
        "colWidths": [100],
    }
    issues = collect_validation_issues(_valid_act(t1=table))
    assert issues == []


# ── Нарушения (Q1, wave 2 → блочная модель): мягкое предупреждение о
# незаполненных ВКЛЮЧЁННЫХ полях — обязательных (violated/established,
# включены всегда) и опциональных, которым пользователь поставил чекбокс
# (ревью №6). Выключенные поля не проверяются. ──

def _act_with_violation(violation: dict, node_extra: dict | None = None):
    """Валидный акт с одним узлом-нарушением в разделе 1."""
    sections = _base_sections()
    node = {
        "id": "vnode1", "label": "Нарушение", "type": "violation",
        "violationId": "v1", "children": [],
    }
    if node_extra:
        node.update(node_extra)
    sections[0]["children"] = [node]
    return ActDataSchema(
        tree={"id": "root", "label": "Акт", "children": sections},
        violations={"v1": violation},
        saveType="manual",
    )


def _text_field(content: str) -> dict:
    """Контейнер поля {enabled, blocks} с одним text-блоком (для сценариев)."""
    return {"enabled": True, "blocks": [{"id": "b1", "type": "text", "content": content}]}


def test_violation_empty_fields_is_warning():
    """Пустые контейнеры violated/established (дефолты схемы, blocks=[]) →
    мягкое замечание."""
    data = _act_with_violation({"id": "v1", "nodeId": "vnode1"})
    issues = collect_validation_issues(data)
    assert "violation_incomplete" in _codes(issues)
    issue = next(i for i in issues if i["code"] == "violation_incomplete")
    assert issue["severity"] == "warning"
    assert issue["ref"] == "v1"
    assert status_from_issues(issues) == "warning"


def test_violation_complete_no_issue():
    data = _act_with_violation({
        "id": "v1", "nodeId": "vnode1",
        "violated": _text_field("Нарушен пункт 1.1"),
        "established": _text_field("Установлено расхождение"),
    })
    issues = collect_validation_issues(data)
    assert "violation_incomplete" not in _codes(issues)
    assert issues == []


def test_violation_empty_text_block_is_warning():
    """Text-блок с плейсхолдером `<p><br></p>` — визуально пуст."""
    data = _act_with_violation({
        "id": "v1", "nodeId": "vnode1",
        "violated": _text_field("<p><br></p>"),
        "established": _text_field("Установлено расхождение"),
    })
    issues = collect_validation_issues(data)
    assert "violation_incomplete" in _codes(issues)


def test_violation_image_block_with_url_is_complete():
    data = _act_with_violation({
        "id": "v1", "nodeId": "vnode1",
        "violated": {
            "enabled": True,
            "blocks": [{
                "id": "b1", "type": "image",
                "url": "data:image/png;base64,iVBORw0KGgo=",
            }],
        },
        "established": _text_field("Установлено расхождение"),
    })
    issues = collect_validation_issues(data)
    assert "violation_incomplete" not in _codes(issues)


def test_violation_image_block_without_url_is_warning():
    data = _act_with_violation({
        "id": "v1", "nodeId": "vnode1",
        "violated": {"enabled": True, "blocks": [{"id": "b1", "type": "image"}]},
        "established": _text_field("Установлено расхождение"),
    })
    issues = collect_validation_issues(data)
    assert "violation_incomplete" in _codes(issues)


def test_violation_table_block_with_filled_cell_is_complete():
    data = _act_with_violation({
        "id": "v1", "nodeId": "vnode1",
        "violated": {
            "enabled": True,
            "blocks": [{
                "id": "b1", "type": "table",
                "table": {"grid": [[{"content": "значение"}]], "colWidths": [100]},
            }],
        },
        "established": _text_field("Установлено расхождение"),
    })
    issues = collect_validation_issues(data)
    assert "violation_incomplete" not in _codes(issues)


def test_violation_table_block_all_empty_cells_is_warning():
    data = _act_with_violation({
        "id": "v1", "nodeId": "vnode1",
        "violated": {
            "enabled": True,
            "blocks": [{
                "id": "b1", "type": "table",
                "table": {
                    "grid": [[{"content": ""}, {"content": "  "}]],
                    "colWidths": [100, 100],
                },
            }],
        },
        "established": _text_field("Установлено расхождение"),
    })
    issues = collect_validation_issues(data)
    assert "violation_incomplete" in _codes(issues)


def test_violation_multiple_blocks_one_filled_is_complete():
    """В поле несколько блоков — достаточно, чтобы хоть один был непустым."""
    data = _act_with_violation({
        "id": "v1", "nodeId": "vnode1",
        "violated": {
            "enabled": True,
            "blocks": [
                {"id": "b1", "type": "text", "content": "<p><br></p>"},
                {"id": "b2", "type": "text", "content": "текст"},
            ],
        },
        "established": _text_field("Установлено расхождение"),
    })
    issues = collect_validation_issues(data)
    assert "violation_incomplete" not in _codes(issues)


def test_violation_disabled_optional_fields_empty_not_counted():
    """ВЫКЛЮЧЕННЫЕ опциональные поля с пустыми blocks=[] не считаются:
    пользователь их сознательно не заполняет, в экспорт они не идут."""
    data = _act_with_violation({
        "id": "v1", "nodeId": "vnode1",
        "violated": _text_field("Нарушен пункт 1.1"),
        "established": _text_field("Установлено расхождение"),
        "reasons": {"enabled": False, "blocks": []},
        "consequences": {"enabled": False, "blocks": []},
        "responsible": {"enabled": False, "blocks": []},
        "measures": {"enabled": False, "blocks": []},
    })
    issues = collect_validation_issues(data)
    assert "violation_incomplete" not in _codes(issues)


def test_violation_enabled_empty_optional_field_is_warning():
    """Ревью №6: ВКЛЮЧЁННОЕ опциональное поле без блоков — незаполненное.

    Включив чекбокс, пользователь заявил намерение заполнить поле; пустым оно
    до экспорта не доезжает (рендеры его не выводят), поэтому единственный
    сигнал «работа не закончена» — это предупреждение при сохранении."""
    data = _act_with_violation({
        "id": "v1", "nodeId": "vnode1",
        "violated": _text_field("Нарушен пункт 1.1"),
        "established": _text_field("Установлено расхождение"),
        "reasons": {"enabled": True, "blocks": []},
    })
    issues = collect_validation_issues(data)
    assert "violation_incomplete" in _codes(issues)
    assert status_from_issues(issues) == "warning"


def test_violation_enabled_optional_field_with_empty_blocks_is_warning():
    """Блоки есть, но все визуально пусты — поле тоже незаполнено."""
    data = _act_with_violation({
        "id": "v1", "nodeId": "vnode1",
        "violated": _text_field("Нарушен пункт 1.1"),
        "established": _text_field("Установлено расхождение"),
        "codeMining": _text_field("<p><br></p>"),
    })
    issues = collect_validation_issues(data)
    assert "violation_incomplete" in _codes(issues)


def test_violation_enabled_optional_field_filled_no_issue():
    """Включённое и заполненное опциональное поле замечаний не даёт."""
    data = _act_with_violation({
        "id": "v1", "nodeId": "vnode1",
        "violated": _text_field("Нарушен пункт 1.1"),
        "established": _text_field("Установлено расхождение"),
        "reasons": _text_field("Причина расхождения"),
        "additionalContent": _text_field("Пояснение"),
    })
    issues = collect_validation_issues(data)
    assert issues == []


def test_violation_br_only_is_warning():
    """Слепота к HTML (находка #4): `<br>` — визуально пустой rich-текст, но
    `br` входит в allowlist санитайзера и переживает очистку. Прежняя
    проверка по сырому значению считала поле заполненным."""
    data = _act_with_violation({
        "id": "v1", "nodeId": "vnode1",
        "violated": _text_field("<br>"),
        "established": _text_field("Установлено расхождение"),
    })
    issues = collect_validation_issues(data)
    assert "violation_incomplete" in _codes(issues)


def test_violation_div_br_only_is_warning():
    """`<div><br></div>` — плейсхолдер пустой строки contenteditable."""
    data = _act_with_violation({
        "id": "v1", "nodeId": "vnode1",
        "violated": _text_field("<div><br></div>"),
        "established": _text_field("Установлено расхождение"),
    })
    issues = collect_validation_issues(data)
    assert "violation_incomplete" in _codes(issues)


def test_violation_nbsp_paragraph_only_is_warning():
    """`<p>&nbsp;</p>` — неразрывный пробел визуально пуст."""
    data = _act_with_violation({
        "id": "v1", "nodeId": "vnode1",
        "violated": _text_field("Нарушен пункт 1.1"),
        "established": _text_field("<p>&nbsp;</p>"),
    })
    issues = collect_validation_issues(data)
    assert "violation_incomplete" in _codes(issues)


def test_violation_rich_formatted_text_is_complete():
    """Rich-форматирование с реальным текстом (`<b>`/`<div>`) — не пусто."""
    data = _act_with_violation({
        "id": "v1", "nodeId": "vnode1",
        "violated": _text_field("<b>текст</b>"),
        "established": _text_field("<div>а</div>"),
    })
    issues = collect_validation_issues(data)
    assert "violation_incomplete" not in _codes(issues)
    assert issues == []


def test_violation_uses_custom_label_in_message():
    data = _act_with_violation(
        {"id": "v1", "nodeId": "vnode1"},
        node_extra={"customLabel": "Нарушение по кассе"},
    )
    issues = collect_validation_issues(data)
    issue = next(i for i in issues if i["code"] == "violation_incomplete")
    assert "Нарушение по кассе" in issue["message"]


# ── Юнит-уровень: None-гварды помощников (`_field_is_empty`/`_is_block_empty`)
# на повреждённых структурах, которые схема ViolationSchema не пропустит, но
# сами функции обязаны не падать на них (защита в глубину). ──

from types import SimpleNamespace

from app.domains.acts.services.content_validation import (
    _field_is_empty,
    _is_block_empty,
)


def test_field_is_empty_none_container_is_empty():
    assert _field_is_empty(None) is True


def test_field_is_empty_blocks_not_a_list_is_empty():
    assert _field_is_empty(SimpleNamespace(blocks="not-a-list")) is True


def test_is_block_empty_unknown_type_is_empty():
    assert _is_block_empty(SimpleNamespace(type="unknown")) is True


# ── Сервисный уровень: статус сохраняется и шлётся уведомление (#8) ──

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.domains.acts.exceptions import ActValidationError
from app.domains.acts.services.act_content_service import ActContentService


@pytest.fixture(autouse=True)
def _patch_adapter(mock_adapter):
    with patch("app.db.repositories.base.get_adapter", return_value=mock_adapter):
        yield


def _svc():
    conn = AsyncMock()
    tx = AsyncMock()
    tx.__aenter__ = AsyncMock(return_value=tx)
    tx.__aexit__ = AsyncMock(return_value=False)
    conn.transaction = MagicMock(return_value=tx)
    acts_settings = MagicMock()
    acts_settings.resource.max_tree_depth = 50
    acts_settings.audit_log.max_diff_elements = 100
    acts_settings.audit_log.max_diff_cells_per_table = 100
    acts_settings.audit_log.max_content_versions = 50
    svc = ActContentService(
        conn=conn, settings=MagicMock(), acts_settings=acts_settings,
        access=MagicMock(), lock=MagicMock(), crud=MagicMock(),
        content=MagicMock(), invoice=MagicMock(),
    )
    svc.guard = MagicMock()
    svc.guard.require_edit_permission = AsyncMock()
    svc.guard.require_lock_owner = AsyncMock()
    saved = {}

    async def _save_content(act_id, data, username, **kwargs):
        saved.update(kwargs)
        return {"status": "success", "message": "ok", "dropped_orphans": 0}

    svc._content = MagicMock()
    svc._content.save_content = AsyncMock(side_effect=_save_content)
    svc._audit = MagicMock()
    svc._audit.log = AsyncMock()
    svc._audit.compute_content_diff = AsyncMock(return_value={})
    svc._audit.compute_field_diffs = AsyncMock(return_value=None)
    svc._versions = MagicMock()
    svc._versions.create_version = AsyncMock(return_value=1)
    svc._invoice = MagicMock()
    svc._invoice.get_invoices_for_act = AsyncMock(return_value=[])
    svc._crud = MagicMock()
    svc._crud.get_act_by_id = AsyncMock(return_value=MagicMock(km_number="КМ-01-00001"))
    return svc, saved


async def test_valid_act_status_ok_no_notification():
    svc, saved = _svc()
    data = _valid_act()
    with patch(
        "app.domains.acts.services.notifications_producer.emit_act_notification",
        new=AsyncMock(),
    ) as emit:
        result = await svc.save_content(act_id=1, data=data, username="12345")
    assert result["validation_status"] == "ok"
    assert saved["validation_status"] == "ok"
    emit.assert_not_called()


async def test_broken_act_status_error_no_notification():
    """Структурная ошибка фиксирует статус 'error' и замечания, но НЕ создаёт
    персистентного уведомления: на лендинге ошибку показывает серверная сводка
    attention (колокольчик), внутри акта — живой источник validation. Прежний
    error-push убран (дублировал сводку и плодил записи при каждом сохранении)."""
    svc, saved = _svc()
    data = ActDataSchema(
        tree={"id": "root", "label": "Акт", "children": []}, saveType="manual",
    )
    with patch(
        "app.domains.acts.services.notifications_producer.emit_act_notification",
        new=AsyncMock(),
    ) as emit:
        result = await svc.save_content(act_id=1, data=data, username="12345")
    assert result["validation_status"] == "error"
    assert saved["validation_status"] == "error"
    assert result["validation_issues"]
    emit.assert_not_called()


async def test_broken_act_auto_save_does_not_notify():
    svc, saved = _svc()
    data = ActDataSchema(
        tree={"id": "root", "label": "Акт", "children": []}, saveType="auto",
    )
    with patch(
        "app.domains.acts.services.notifications_producer.emit_act_notification",
        new=AsyncMock(),
    ) as emit:
        result = await svc.save_content(act_id=1, data=data, username="12345")
    assert result["validation_status"] == "error"
    emit.assert_not_called()


async def test_textblocks_per_node_limit_raises_validation_error():
    """PERSIST-2/B-13: сервер отклоняет узел с N+1 текстблоками — реальный вызов
    _validate_textblocks_per_node (раньше _svc() мокал acts_settings без явного
    per_node, проверка молча выключалась — isinstance(MagicMock, int) is False).
    ActValidationError.status_code=400 (у бизнес-валидации акта, не 422 —
    см. test_save_content_business_validation_error_returns_400)."""
    svc, _saved = _svc()
    svc.acts_settings.textblocks.per_node = 2
    sections = _base_sections()
    sections[0]["children"] = [
        {"id": f"tb{i}", "label": "Текстовый блок", "type": "textblock",
         "textBlockId": f"tb{i}", "children": []}
        for i in range(3)
    ]
    data = ActDataSchema(
        tree={"id": "root", "label": "Акт", "children": sections},
        saveType="manual",
    )
    with pytest.raises(ActValidationError, match="текстовых блоков") as exc_info:
        await svc.save_content(act_id=1, data=data, username="12345")
    assert exc_info.value.status_code == 400


async def test_violations_per_node_limit_raises_validation_error():
    """#7: сервер отклоняет узел с N+1 нарушениями (paste/drag/undo обходили
    фронт-гейт). Симметрия текстблочному лимиту B-13."""
    svc, _saved = _svc()
    svc.acts_settings.violations.per_node = 2
    sections = _base_sections()
    sections[0]["children"] = [
        {"id": f"v{i}", "label": "Нарушение", "type": "violation",
         "violationId": f"v{i}", "children": []}
        for i in range(3)
    ]
    data = ActDataSchema(
        tree={"id": "root", "label": "Акт", "children": sections},
        saveType="manual",
    )
    with pytest.raises(ActValidationError, match="нарушений") as exc_info:
        await svc.save_content(act_id=1, data=data, username="12345")
    assert exc_info.value.status_code == 400


async def test_tables_per_node_limit_raises_validation_error():
    """#7: сервер отклоняет узел с N+1 таблицами. Считаются ВСЕ таблицы, включая
    закреплённые metrics/risk (паритет с фронт-гейтом добавления)."""
    svc, _saved = _svc()
    svc.acts_settings.tables.per_node = 2
    sections = _base_sections()
    # Одна из таблиц — закреплённая metrics: её тоже нужно учитывать.
    sections[0]["children"] = [
        {"id": "tbl0", "label": "Таблица", "type": "table",
         "tableId": "tbl0", "kind": "metrics", "children": []},
        {"id": "tbl1", "label": "Таблица", "type": "table",
         "tableId": "tbl1", "children": []},
        {"id": "tbl2", "label": "Таблица", "type": "table",
         "tableId": "tbl2", "children": []},
    ]
    data = ActDataSchema(
        tree={"id": "root", "label": "Акт", "children": sections},
        saveType="manual",
    )
    with pytest.raises(ActValidationError, match="таблиц") as exc_info:
        await svc.save_content(act_id=1, data=data, username="12345")
    assert exc_info.value.status_code == 400


def test_validate_tree_single_pass_traversal():
    """#14 код-ревью: глубина и три per-node лимита считаются за ОДИН обход
    дерева, не за 4 отдельных (было: calculate_tree_depth + 3×
    _validate_children_per_node, каждый со своим stack.pop()-обходом).

    Усиленный регресс-гард: шпионим доступ к ключу "children" на КАЖДОМ узле
    дерева и обоими способами доступа — `.get("children")` и индексация
    `node["children"]`. При едином обходе каждый узел посещается ровно раз, а
    его дети читаются один раз → суммарных обращений ровно столько, сколько
    узлов в дереве. Повторный проход по любому поддереву (дети уже собранных
    узлов «не под шпионом» в прежней версии — шпионился только корень) или
    доступ мимо `.get` через `node["children"]` поднимут счётчик выше числа
    узлов и будут пойманы независимо от способа обхода."""
    svc, _saved = _svc()
    svc.acts_settings.textblocks.per_node = 5
    svc.acts_settings.violations.per_node = 5
    svc.acts_settings.tables.per_node = 5

    access_log = []

    class SpyDict(dict):
        """dict, логирующий любой доступ к ключу "children" (get и []-индексация)."""
        def get(self, key, *args):
            if key == "children":
                access_log.append(("get", id(self)))
            return super().get(key, *args)

        def __getitem__(self, key):
            if key == "children":
                access_log.append(("getitem", id(self)))
            return super().__getitem__(key)

    def _spy(node: dict) -> SpyDict:
        """Рекурсивно оборачивает узел и всех его потомков в SpyDict."""
        wrapped = SpyDict(node)
        # __setitem__ не переопределён — присвоение шпиона не логируется.
        wrapped["children"] = [_spy(child) for child in node.get("children", [])]
        return wrapped

    def _count_nodes(node: dict) -> int:
        return 1 + sum(_count_nodes(child) for child in node.get("children", []))

    raw_tree = {"id": "root", "label": "Акт", "children": _base_sections()}
    node_count = _count_nodes(raw_tree)
    root = _spy(raw_tree)

    data = ActDataSchema(
        tree={"id": "root", "label": "Акт", "children": _base_sections()},
        saveType="manual",
    )
    # Прямое присвоение обходит pydantic-нормализацию поля tree (иначе
    # field_validator пересоздаёт дерево через ActItemSchema.model_dump(),
    # и spy-обёртки узлов теряются).
    data.tree = root

    svc._validate_tree(data)

    # Ровно одно обращение к "children" на каждый узел → единый проход.
    assert len(access_log) == node_count


def test_validate_tree_depth_error_precedes_per_node_error():
    """#14 код-ревью: при одновременном превышении глубины и per-node лимита
    приоритет у ошибки глубины — как при прежних последовательных проверках,
    где глубина проверялась ДО per-node. Регрессия на случай, если будущий
    рефактор переставит порядок raise в едином обходе."""
    svc, _saved = _svc()
    svc.acts_settings.resource.max_tree_depth = 1
    svc.acts_settings.textblocks.per_node = 2
    # Узел на глубине 2 с 3 текстблоками: превышены И глубина (3 > 1), И лимит
    # текстблоков (3 > 2). Ожидаем именно ошибку глубины.
    deep_and_wide = {
        "id": "root", "label": "Акт", "children": [
            {"id": "s1", "label": "Секция", "type": "section", "children": [
                {"id": "n", "label": "Узел", "type": "section", "children": [
                    {"id": f"tb{i}", "label": "ТБ", "type": "textblock",
                     "textBlockId": f"tb{i}", "children": []}
                    for i in range(3)
                ]},
            ]},
        ],
    }
    data = ActDataSchema(
        tree={"id": "root", "label": "Акт", "children": _base_sections()},
        saveType="manual",
    )
    data.tree = deep_and_wide
    with pytest.raises(ActValidationError, match="Глубина дерева"):
        svc._validate_tree(data)


def test_validate_tree_textblock_error_precedes_table_error():
    """#14 код-ревью: при одновременном превышении лимитов текстблоков и таблиц
    в одном узле приоритет у текстблоков (порядок проверок текстблоки →
    нарушения → таблицы сохранён)."""
    svc, _saved = _svc()
    svc.acts_settings.textblocks.per_node = 2
    svc.acts_settings.tables.per_node = 2
    node_children = (
        [{"id": f"tb{i}", "label": "ТБ", "type": "textblock",
          "textBlockId": f"tb{i}", "children": []} for i in range(3)]
        + [{"id": f"tbl{i}", "label": "Табл", "type": "table",
            "tableId": f"tbl{i}", "children": []} for i in range(3)]
    )
    both_over = {
        "id": "root", "label": "Акт", "children": [
            {"id": "s1", "label": "Секция", "type": "section",
             "children": node_children},
        ],
    }
    data = ActDataSchema(
        tree={"id": "root", "label": "Акт", "children": _base_sections()},
        saveType="manual",
    )
    data.tree = both_over
    with pytest.raises(ActValidationError, match="текстовых блоков"):
        svc._validate_tree(data)


async def test_warning_act_manual_save_does_not_notify():
    """Статус warning (только пустые таблицы) портальное уведомление НЕ шлёт —
    даже при ручном сохранении: warning не критичен (решение пользователя)."""
    svc, saved = _svc()
    table = {
        "id": "t1", "nodeId": "5",
        "grid": [[{"content": "Заголовок", "isHeader": True}]],
        "colWidths": [100],
    }
    data = _valid_act(t1=table)  # валидная структура + пустая таблица → warning
    with patch(
        "app.domains.acts.services.notifications_producer.emit_act_notification",
        new=AsyncMock(),
    ) as emit:
        result = await svc.save_content(act_id=1, data=data, username="12345")
    assert result["validation_status"] == "warning"
    assert saved["validation_status"] == "warning"
    emit.assert_not_called()


async def test_violation_incomplete_manual_save_not_blocked():
    """Незаполненное нарушение (Q1, wave 2): акт СОХРАНЯЕТСЯ (не 422/исключение),
    статус помечается 'warning', уведомление НЕ шлётся — симметрично пустой
    таблице (table_no_data)."""
    svc, saved = _svc()
    data = _act_with_violation({"id": "v1", "nodeId": "vnode1"})
    with patch(
        "app.domains.acts.services.notifications_producer.emit_act_notification",
        new=AsyncMock(),
    ) as emit:
        result = await svc.save_content(act_id=1, data=data, username="12345")
    assert result["validation_status"] == "warning"
    assert saved["validation_status"] == "warning"
    assert any(i["code"] == "violation_incomplete" for i in result["validation_issues"])
    emit.assert_not_called()
