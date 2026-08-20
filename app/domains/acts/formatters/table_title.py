"""Единое правило оформления подписи таблицы — зеркало фронта.

Правило владельца, действующее во ВСЕХ контурах (редактор, превью, диалог
версий, DOCX/MD/TXT):

- пресетная (автосозданная) таблица разделов 1–4 — обычным начертанием,
  ПОДЧЁРКНУТАЯ;
- раздел 5, любые таблицы — обычным начертанием, БЕЗ подчёркивания;
- пользовательская таблица — без эффектов;
- таблица внутри блока нарушения — без эффектов (подписи у неё нет вовсе).

Жирного начертания у подписи нет ни в одном контуре.

Фронтовое зеркало — ``static/js/constructor/table/table-title.js``
(``UNDERLINED_TITLE_SECTIONS`` / ``tableTitleUnderlined``); импорт из Python
невозможен, поэтому синхронность сторожит
``tests/domains/acts/formatters/test_table_title_rule.py``: одна матрица
случаев прогоняется через обе реализации.

Раздел узла приходит из ``WalkContext.root_section_id`` (его проставляет
tree_walker), поэтому правило одинаково доступно всем трём форматтерам.
"""
from __future__ import annotations

from typing import Any, Mapping

from app.domains.acts.block_types import NODE_TYPE_TABLE

# Разделы, у которых пресетная таблица получает подчёркнутую подпись.
# Правило владельца сформулировано ПО РАЗДЕЛАМ: 1–4 — подчёркиваем, 5 — нет.
UNDERLINED_TITLE_SECTIONS: frozenset[str] = frozenset({"1", "2", "3", "4"})

# Подвид обычной таблицы (зеркало KIND_REGULAR фронта / TABLE_KINDS схемы).
_KIND_REGULAR = "regular"


def is_preset_table(node: Mapping[str, Any] | None) -> bool:
    """Пресетная (автоматически созданная) таблица.

    Признака «создана автоматически» в модели нет, дискриминатор — защищённая
    обычная таблица: у пользовательских ``protected`` False, у спецтаблиц
    (метрики/риски) ``kind`` отличен от 'regular'.
    """
    if not node:
        return False
    return (
        node.get("type") == NODE_TYPE_TABLE
        and node.get("protected") is True
        and (node.get("kind") or _KIND_REGULAR) == _KIND_REGULAR
    )


def table_title_underlined(
    node: Mapping[str, Any] | None, root_section_id: str | None,
) -> bool:
    """Подчёркивается ли подпись таблицы (единое правило всех контуров).

    Args:
        node: Узел-таблица дерева акта.
        root_section_id: ID раздела верхнего уровня, под которым лежит узел
            (``WalkContext.root_section_id``); None — раздел неизвестен.

    Returns:
        True, если подпись подчёркивается.
    """
    if root_section_id is None:
        return False
    return is_preset_table(node) and str(root_section_id) in UNDERLINED_TITLE_SECTIONS
