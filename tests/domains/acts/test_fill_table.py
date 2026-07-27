"""Unit-тесты для fill_table и add_table_row операций modify_act_tree_handler.

Покрывает:
- Нормализация compact-формата (строки) в полные TableCellSchema.
- Нормализация full-формата (dict).
- Mode='replace' — заменяет таблицу целиком.
- Mode='append_rows' — добавляет строки в конец.
- add_table_row: добавление одной строки с first_value и row.
- Поиск таблицы по node_id (когда LLM передаёт number вида 'Таблица 1.2').
- Ошибки: неизвестный mode, отсутствует table_id, не-прямоугольный grid,
  неверный тип ячейки, несуществующая таблица.
- col_widths обновление.
- Защищённые таблицы (protected=True) — fill_table/add_table_row
  ДОЛЖНЫ работать (защита только структуры, не контента).
- _resolve_table_by_ref: прямой ключ + поиск по node_id.
"""
import pytest

from app.domains.acts.integrations.action_handlers import (
    _apply_add_table_row,
    _apply_fill_table,
    _normalize_table_cell,
    _normalize_table_grid,
    _resolve_table_by_ref,
)


def _empty_table(table_id: str = "tbl_1", node_id: str = "node_1") -> dict:
    return {
        "id": table_id,
        "nodeId": node_id,
        "grid": [],
        "colWidths": [],
        "protected": False,
        "deletable": True,
        "kind": "regular",
    }


def _tree_with_table(table_id: str = "tbl_1", node_id: str = "node_1") -> dict:
    return {
        "id": "root",
        "children": [
            {
                "id": node_id,
                "type": "table",
                "label": "Test",
                "tableId": table_id,
                "children": [],
            }
        ],
    }


class TestNormalizeTableCell:
    def test_string_cell_compact(self):
        cell = _normalize_table_cell("hello", row=2, col=3, is_header=False)
        assert cell == {
            "content": "hello",
            "isHeader": False,
            "colSpan": 1,
            "rowSpan": 1,
            "isSpanned": False,
            "spanOrigin": None,
            "originRow": 2,
            "originCol": 3,
        }

    def test_string_cell_with_header(self):
        cell = _normalize_table_cell("Колонка", row=0, col=0, is_header=True)
        assert cell["isHeader"] is True
        assert cell["content"] == "Колонка"

    def test_dict_cell_full_keeps_extras(self):
        cell = _normalize_table_cell(
            {"content": "X", "isHeader": True, "colSpan": 2, "rowSpan": 1},
            row=0, col=0, is_header=False,
        )
        assert cell["content"] == "X"
        assert cell["isHeader"] is True
        assert cell["colSpan"] == 2
        assert cell["originRow"] == 0
        assert cell["originCol"] == 0

    def test_dict_cell_missing_content_raises(self):
        with pytest.raises(ValueError, match="должна иметь поле 'content'"):
            _normalize_table_cell({"isHeader": True}, row=0, col=0)

    def test_invalid_type_raises(self):
        with pytest.raises(ValueError, match="должна быть строкой или dict"):
            _normalize_table_cell([1, 2, 3], row=0, col=0)

    def test_int_cell_compact(self):
        cell = _normalize_table_cell(5, row=0, col=1, is_header=False)
        assert cell["content"] == "5"
        assert cell["originRow"] == 0
        assert cell["originCol"] == 1

    def test_none_cell_empty_content(self):
        cell = _normalize_table_cell(None, row=2, col=2, is_header=False)
        assert cell["content"] == ""
        assert cell["originRow"] == 2


class TestNormalizeTableGrid:
    def test_compact_grid_replace_mode(self):
        grid = _normalize_table_grid(
            [["Товар", "Кол-во"], ["Ручка", 5], ["Карандаш", 12]],
            mode="replace",
        )
        assert len(grid) == 3
        assert grid[0][0]["content"] == "Товар"
        assert grid[0][0]["isHeader"] is True
        assert grid[0][1]["isHeader"] is True
        assert grid[1][0]["isHeader"] is False
        assert grid[1][1]["content"] == "5"
        assert grid[2][0]["originRow"] == 2

    def test_compact_grid_append_rows_mode(self):
        grid = _normalize_table_grid(
            [["Строка1-1", "Строка1-2"], ["Строка2-1", "Строка2-2"]],
            mode="append_rows",
        )
        for row in grid:
            for cell in row:
                assert cell["isHeader"] is False

    def test_full_grid_passes_through(self):
        full = [
            [
                {"content": "A", "isHeader": True, "colSpan": 2,
                 "rowSpan": 1, "originRow": 0, "originCol": 0},
                {"content": "_spanned_", "isSpanned": True,
                 "originRow": 0, "originCol": 0},
            ],
            [
                {"content": "B1", "originRow": 1, "originCol": 0},
                {"content": "B2", "originRow": 1, "originCol": 1},
            ],
        ]
        grid = _normalize_table_grid(full, mode="replace")
        assert grid[0][0]["colSpan"] == 2
        assert grid[0][1]["isSpanned"] is True
        assert grid[1][1]["content"] == "B2"

    def test_non_rectangular_raises(self):
        with pytest.raises(ValueError, match="должна быть прямоугольной"):
            _normalize_table_grid(
                [["A", "B"], ["C"]], mode="replace"
            )

    def test_empty_raises(self):
        with pytest.raises(ValueError, match="непустым 2D-массивом"):
            _normalize_table_grid([], mode="replace")

    def test_non_list_row_raises(self):
        with pytest.raises(ValueError, match="должна быть массивом ячеек"):
            _normalize_table_grid(["not a list"], mode="replace")


class TestResolveTableByRef:
    def test_direct_key_match(self):
        tree: dict = {}
        target = {"tbl_1": _empty_table("tbl_1", "node_1")}
        table, node_id = _resolve_table_by_ref(tree, target, "tbl_1")
        assert table is target["tbl_1"]
        assert node_id == "node_1"

    def test_node_id_match_finds_via_tree(self):
        tree = _tree_with_table("tbl_1", "node_1")
        target = {"tbl_1": _empty_table("tbl_1", "node_1")}
        table, node_id = _resolve_table_by_ref(tree, target, "node_1")
        assert table is target["tbl_1"]
        assert node_id == "node_1"

    def test_human_readable_number_match(self):
        tree = {
            "id": "root",
            "children": [
                {
                    "id": "tbl_node_1",
                    "type": "table",
                    "tableId": "tbl_1",
                    "number": "Таблица 1",
                    "children": [],
                }
            ],
        }
        target = {"tbl_1": _empty_table("tbl_1", "tbl_node_1")}
        table, node_id = _resolve_table_by_ref(tree, target, "Таблица 1")
        assert table is target["tbl_1"]
        assert node_id == "tbl_node_1"

    def test_missing_ref_returns_none(self):
        tree: dict = {}
        target = {"tbl_1": _empty_table()}
        table, _ = _resolve_table_by_ref(tree, target, "missing")
        assert table is None

    def test_node_is_not_table_returns_none(self):
        tree = {
            "id": "root",
            "children": [
                {"id": "item_1", "type": "item", "children": []}
            ],
        }
        target: dict = {}
        table, _ = _resolve_table_by_ref(tree, target, "item_1")
        assert table is None


class TestApplyFillTable:
    def _tree(self) -> dict:
        return _tree_with_table("tbl_1", "node_1")

    def _tables(self) -> dict:
        return {"tbl_1": _empty_table("tbl_1", "node_1")}

    def test_replace_compact_grid(self):
        tables = self._tables()
        results: list[dict] = []
        _apply_fill_table(
            self._tree(),
            tables,
            {
                "op": "fill_table",
                "table_id": "tbl_1",
                "mode": "replace",
                "grid": [["Товар", "Кол-во"], ["Ручка", 5]],
            },
            results,
        )
        assert len(results) == 1
        r = results[0]
        assert r["op"] == "fill_table"
        assert r["table_id"] == "tbl_1"
        assert r["node_id"] == "node_1"
        assert r["mode"] == "replace"
        assert r["rows"] == 2
        assert r["cols"] == 2
        grid = tables["tbl_1"]["grid"]
        assert grid[0][0]["content"] == "Товар"
        assert grid[0][0]["isHeader"] is True
        assert grid[1][1]["content"] == "5"

    def test_default_mode_is_replace(self):
        results: list[dict] = []
        _apply_fill_table(
            self._tree(),
            self._tables(),
            {
                "op": "fill_table",
                "table_id": "tbl_1",
                "grid": [["A"]],
            },
            results,
        )
        assert results[0]["mode"] == "replace"

    def test_append_rows_does_not_touch_headers(self):
        tables = self._tables()
        # Заранее заполним таблицу (replace)
        _apply_fill_table(
            self._tree(),
            tables,
            {
                "op": "fill_table",
                "table_id": "tbl_1",
                "grid": [["Товар", "Кол-во"], ["Ручка", 5]],
            },
            [],
        )
        # Теперь добавим ещё строк
        results: list[dict] = []
        _apply_fill_table(
            self._tree(),
            tables,
            {
                "op": "fill_table",
                "table_id": "tbl_1",
                "mode": "append_rows",
                "grid": [["Карандаш", 12]],
            },
            results,
        )
        grid = tables["tbl_1"]["grid"]
        assert len(grid) == 3
        assert grid[0][0]["isHeader"] is True  # Заголовки не тронуты
        assert grid[2][0]["isHeader"] is False  # Новая строка — данные
        assert results[0]["rows"] == 3

    def test_col_widths_updated(self):
        tables = self._tables()
        _apply_fill_table(
            self._tree(),
            tables,
            {
                "op": "fill_table",
                "table_id": "tbl_1",
                "grid": [["A", "B", "C"]],
                "col_widths": [120, 80, 100],
            },
            [],
        )
        assert tables["tbl_1"]["colWidths"] == [120, 80, 100]

    def test_find_table_by_node_id(self):
        results: list[dict] = []
        _apply_fill_table(
            self._tree(),
            self._tables(),
            {
                "op": "fill_table",
                "table_id": "node_1",
                "grid": [["A"]],
            },
            results,
        )
        assert results[0]["table_id"] == "tbl_1"

    def test_missing_table_id_raises(self):
        with pytest.raises(ValueError, match="table_id обязателен"):
            _apply_fill_table(
                self._tree(), self._tables(),
                {"op": "fill_table", "grid": [["A"]]}, [],
            )

    def test_missing_grid_raises(self):
        with pytest.raises(ValueError, match="grid обязателен"):
            _apply_fill_table(
                self._tree(), self._tables(),
                {"op": "fill_table", "table_id": "tbl_1"}, [],
            )

    def test_unknown_mode_raises(self):
        with pytest.raises(ValueError, match="недопустим"):
            _apply_fill_table(
                self._tree(), self._tables(),
                {
                    "op": "fill_table", "table_id": "tbl_1",
                    "mode": "overwrite", "grid": [["A"]],
                },
                [],
            )

    def test_table_not_found_raises(self):
        with pytest.raises(ValueError, match="не найдена"):
            _apply_fill_table(
                self._tree(), self._tables(),
                {
                    "op": "fill_table", "table_id": "missing",
                    "grid": [["A"]],
                },
                [],
            )

    def test_protected_table_allowed(self):
        """protected=True защищает только структуру (от удаления/
        перемещения), но НЕ контент. Ассистент с правами edit должен
        мочь заполнять любые таблицы, включая шаблонные (metrics,
        regularRisk и т.д.) — они ВСЕ protected=True на фронте."""
        tables = self._tables()
        tables["tbl_1"]["protected"] = True
        results: list[dict] = []
        _apply_fill_table(
            self._tree(), tables,
            {
                "op": "fill_table", "table_id": "tbl_1",
                "grid": [["A", "B"], ["X", "Y"]],
            },
            results,
        )
        assert results[0]["rows"] == 2
        assert tables["tbl_1"]["grid"][1][0]["content"] == "X"

    def test_non_rectangular_grid_raises(self):
        with pytest.raises(ValueError, match="прямоугольной"):
            _apply_fill_table(
                self._tree(), self._tables(),
                {
                    "op": "fill_table", "table_id": "tbl_1",
                    "grid": [["A", "B"], ["C"]],
                },
                [],
            )

    def test_invalid_col_widths_raises(self):
        with pytest.raises(ValueError, match="col_widths"):
            _apply_fill_table(
                self._tree(), self._tables(),
                {
                    "op": "fill_table", "table_id": "tbl_1",
                    "grid": [["A"]], "col_widths": "not a list",
                },
                [],
            )

    def test_minimax_textwrap_unwraps(self):
        """MiniMax оборачивает JSON в {"$text": "{...}"} — _apply_fill_table
        должен корректно это развернуть через _unwrap_op."""
        import json
        tables = self._tables()
        results: list[dict] = []
        _apply_fill_table(
            self._tree(),
            tables,
            {
                "$text": json.dumps({
                    "op": "fill_table",
                    "table_id": "tbl_1",
                    "grid": [["A", "B"], ["X", "Y"]],
                })
            },
            results,
        )
        assert results[0]["rows"] == 2
        assert results[0]["cols"] == 2


class TestApplyAddTableRow:
    def _tree(self) -> dict:
        return _tree_with_table("tbl_1", "node_1")

    def _tables_with_headers(self) -> dict:
        """Таблица с заголовками 3×3 (как у regularRisk шаблона)."""
        return {
            "tbl_1": {
                "id": "tbl_1",
                "nodeId": "node_1",
                "grid": [
                    [{"content": "Процесс", "isHeader": True, "originRow": 0, "originCol": 0},
                     {"content": "Описание", "isHeader": True, "originRow": 0, "originCol": 1},
                     {"content": "Уровень", "isHeader": True, "originRow": 0, "originCol": 2}],
                ],
                "colWidths": [120, 250, 100],
                "protected": True,
                "deletable": True,
                "kind": "regularRisk",
            },
        }

    def test_first_value_only(self):
        """«Впиши П2008 в таблицу 1 в первый столбец» — самый частый кейс."""
        tables = self._tables_with_headers()
        results: list[dict] = []
        _apply_add_table_row(
            self._tree(), tables,
            {
                "op": "add_table_row",
                "table_id": "tbl_1",
                "first_value": "П2008",
            },
            results,
        )
        grid = tables["tbl_1"]["grid"]
        assert len(grid) == 2  # 1 header + 1 new
        assert grid[1][0]["content"] == "П2008"
        assert grid[1][1]["content"] == ""
        assert grid[1][2]["content"] == ""
        assert grid[1][0]["isHeader"] is False
        assert results[0]["first_value"] == "П2008"
        assert results[0]["row_index"] == 1
        assert results[0]["cols"] == 3

    def test_full_row_passed(self):
        tables = self._tables_with_headers()
        results: list[dict] = []
        _apply_add_table_row(
            self._tree(), tables,
            {
                "op": "add_table_row",
                "table_id": "tbl_1",
                "row": ["П2008", "Расчёт процентной ставки", "Высокий"],
            },
            results,
        )
        grid = tables["tbl_1"]["grid"]
        assert grid[1][0]["content"] == "П2008"
        assert grid[1][1]["content"] == "Расчёт процентной ставки"
        assert grid[1][2]["content"] == "Высокий"

    def test_row_shorter_than_table_pads(self):
        tables = self._tables_with_headers()
        _apply_add_table_row(
            self._tree(), tables,
            {
                "op": "add_table_row", "table_id": "tbl_1",
                "row": ["П2008"],  # только 1 ячейка, а таблица 3-кол
            },
            [],
        )
        grid = tables["tbl_1"]["grid"]
        assert len(grid[1]) == 3
        assert grid[1][0]["content"] == "П2008"
        assert grid[1][1]["content"] == ""
        assert grid[1][2]["content"] == ""

    def test_row_longer_than_table_truncates(self):
        tables = self._tables_with_headers()
        _apply_add_table_row(
            self._tree(), tables,
            {
                "op": "add_table_row", "table_id": "tbl_1",
                "row": ["A", "B", "C", "D", "E"],
            },
            [],
        )
        grid = tables["tbl_1"]["grid"]
        assert len(grid[1]) == 3
        assert grid[1][0]["content"] == "A"
        assert grid[1][2]["content"] == "C"

    def test_row_priority_over_first_value(self):
        """Если переданы и row и first_value — row выигрывает."""
        tables = self._tables_with_headers()
        _apply_add_table_row(
            self._tree(), tables,
            {
                "op": "add_table_row", "table_id": "tbl_1",
                "first_value": "X",  # будет проигнорировано
                "row": ["П2008", "Описание", "Уровень"],
            },
            [],
        )
        grid = tables["tbl_1"]["grid"]
        assert grid[1][0]["content"] == "П2008"

    def test_multiple_rows_appended_in_order(self):
        tables = self._tables_with_headers()
        for code in ("П2008", "П2009", "П2010"):
            _apply_add_table_row(
                self._tree(), tables,
                {"op": "add_table_row", "table_id": "tbl_1",
                 "first_value": code},
                [],
            )
        grid = tables["tbl_1"]["grid"]
        assert len(grid) == 4  # 1 header + 3 new
        assert grid[1][0]["content"] == "П2008"
        assert grid[2][0]["content"] == "П2009"
        assert grid[3][0]["content"] == "П2010"
        # originRow должен идти подряд
        for c in range(3):
            assert grid[3][c]["originRow"] == 3

    def test_protected_table_allowed(self):
        """add_table_row должен работать и для protected таблиц."""
        tables = self._tables_with_headers()
        # protected=True (как у шаблонных таблиц)
        assert tables["tbl_1"]["protected"] is True
        results: list[dict] = []
        _apply_add_table_row(
            self._tree(), tables,
            {
                "op": "add_table_row", "table_id": "tbl_1",
                "first_value": "П2008",
            },
            results,
        )
        assert results[0]["first_value"] == "П2008"

    def test_empty_table_first_value(self):
        """Для пустой таблицы (без заголовков) — дефолт 1 колонка."""
        tables = {"tbl_1": _empty_table("tbl_1", "node_1")}
        results: list[dict] = []
        _apply_add_table_row(
            self._tree(), tables,
            {
                "op": "add_table_row", "table_id": "tbl_1",
                "first_value": "X",
            },
            results,
        )
        assert results[0]["cols"] == 1
        assert tables["tbl_1"]["grid"][0][0]["content"] == "X"

    def test_first_value_none(self):
        tables = self._tables_with_headers()
        _apply_add_table_row(
            self._tree(), tables,
            {
                "op": "add_table_row", "table_id": "tbl_1",
                "first_value": None,
            },
            [],
        )
        grid = tables["tbl_1"]["grid"]
        assert grid[1][0]["content"] == ""

    def test_int_first_value(self):
        tables = self._tables_with_headers()
        _apply_add_table_row(
            self._tree(), tables,
            {
                "op": "add_table_row", "table_id": "tbl_1",
                "first_value": 42,
            },
            [],
        )
        grid = tables["tbl_1"]["grid"]
        assert grid[1][0]["content"] == "42"

    def test_missing_table_id_raises(self):
        with pytest.raises(ValueError, match="table_id обязателен"):
            _apply_add_table_row(
                self._tree(), {"tbl_1": _empty_table()},
                {"op": "add_table_row", "first_value": "X"},
                [],
            )

    def test_table_not_found_raises(self):
        with pytest.raises(ValueError, match="не найдена"):
            _apply_add_table_row(
                self._tree(), {"tbl_1": _empty_table()},
                {"op": "add_table_row", "table_id": "missing",
                 "first_value": "X"},
                [],
            )

    def test_row_not_a_list_raises(self):
        with pytest.raises(ValueError, match="row должен быть массивом"):
            _apply_add_table_row(
                self._tree(), self._tables_with_headers(),
                {"op": "add_table_row", "table_id": "tbl_1",
                 "row": "not a list"},
                [],
            )

    def test_minimax_textwrap_unwraps(self):
        import json
        tables = self._tables_with_headers()
        results: list[dict] = []
        _apply_add_table_row(
            self._tree(), tables,
            {
                "$text": json.dumps({
                    "op": "add_table_row",
                    "table_id": "tbl_1",
                    "first_value": "П2008",
                })
            },
            results,
        )
        assert results[0]["first_value"] == "П2008"
        assert tables["tbl_1"]["grid"][1][0]["content"] == "П2008"
