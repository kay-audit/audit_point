"""Unit-тест: modify_act_tree_handler возвращает JSON-список блоков
(client_action.refresh_act + text summary).

Это ключевая инвариантность для динамического обновления конструктора
(без Ctrl+Shift+R). Раньше handler возвращал JSON + "\\n\\n" + summary,
json.loads падал, client_action терялся, и UI не обновлялся.
"""
import json

import pytest


def test_modify_act_tree_unwraps_minimax_textwrap():
    """MiniMax-LLM оборачивает операции в ``{"$text": "{...}"}`` —
    handler должен распаковать это перед обработкой (тестируем
    только helper, без БД)."""
    from app.domains.acts.integrations.action_handlers import _unwrap_op

    # Обычный dict — без изменений
    assert _unwrap_op({"op": "add_item", "label": "test"}) == {
        "op": "add_item", "label": "test",
    }

    # MiniMax-style $text с JSON-строкой — распаковываем
    wrapped = {"$text": json.dumps({"op": "add_item", "label": "test"})}
    assert _unwrap_op(wrapped) == {"op": "add_item", "label": "test"}

    # $text со строкой, которая НЕ JSON — оставляем как есть
    # (json.loads("regularRisk") упал бы с JSONDecodeError, поэтому
    # _unwrap_op должен сначала проверить, что строка начинается с { или [).
    wrapped_str = {"$text": "regularRisk"}
    assert _unwrap_op(wrapped_str) == wrapped_str

    # Рекурсивно для вложенных dict: $text со строкой (не JSON) — оставляем
    # обёртку как есть. Это защищает от json.loads("regularRisk") → JSONDecodeError.
    wrapped_nested = {
        "op": "add_table",
        "kind": {"$text": "regularRisk"},
        "parent_id": "2",
    }
    assert _unwrap_op(wrapped_nested) == {
        "op": "add_table", "kind": {"$text": "regularRisk"}, "parent_id": "2",
    }

    # Рекурсивно для вложенных dict: $text с JSON — распаковываем
    wrapped_nested_json = {
        "op": "add_table",
        "kind": {"$text": json.dumps({"name": "regularRisk"})},
        "parent_id": "2",
    }
    assert _unwrap_op(wrapped_nested_json) == {
        "op": "add_table", "kind": {"name": "regularRisk"}, "parent_id": "2",
    }

    # Невалидный JSON — возвращаем как есть
    invalid = {"$text": "not json"}
    assert _unwrap_op(invalid) == invalid


def test_modify_act_tree_unwrap_handles_non_dict():
    """Не-dict значения возвращаются как есть (без падения)."""
    from app.domains.acts.integrations.action_handlers import _unwrap_op

    assert _unwrap_op(None) is None
    assert _unwrap_op("plain string") == "plain string"
    assert _unwrap_op(42) == 42
    assert _unwrap_op([1, 2, 3]) == [1, 2, 3]  # list — не unwrap (только dict)
