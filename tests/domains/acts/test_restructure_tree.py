"""Тесты для метода перестройки дерева при смене типа проверки."""

import pytest

from app.domains.acts.services.act_crud_service import ActCrudService


# ── Фикстуры ──


@pytest.fixture
def process_tree():
    """Дерево процессной проверки: раздел 1 и 2 с содержимым, разделы 3-5 пустые."""
    return {
        "id": "root",
        "label": "Акт",
        "children": [
            {
                "id": "1",
                "label": "Информация о процессе, клиентском пути",
                "number": "1",
                "type": "item",
                "protected": True,
                "deletable": False,
                "children": [
                    {
                        "id": "node_1",
                        "label": "Описание процесса",
                        "type": "item",
                        "children": [
                            {
                                "id": "node_1_tbl",
                                "label": "Таблица",
                                "type": "table",
                                "tableId": "table_001",
                                "children": [],
                            },
                        ],
                    },
                    {
                        "id": "node_2",
                        "label": "Текстовый блок",
                        "type": "textblock",
                        "textBlockId": "tb_001",
                        "children": [],
                    },
                ],
            },
            {
                "id": "2",
                "label": "Оценка качества процесса",
                "number": "2",
                "type": "item",
                "protected": True,
                "deletable": False,
                "children": [
                    {
                        "id": "node_qa",
                        "label": "Оценка качества",
                        "type": "table",
                        "tableType": "qualityAssessment",
                        "tableId": "table_qa_001",
                        "children": [],
                    },
                    {
                        "id": "node_3",
                        "label": "Комментарий",
                        "type": "textblock",
                        "textBlockId": "tb_002",
                        "children": [],
                    },
                ],
            },
            {
                "id": "3",
                "label": "Выводы",
                "number": "3",
                "type": "item",
                "protected": True,
                "deletable": False,
                "children": [
                    {
                        "id": "node_sec3",
                        "label": "Вывод 1",
                        "type": "textblock",
                        "textBlockId": "tb_sec3",
                        "children": [],
                    },
                ],
            },
            {
                "id": "4",
                "label": "Приложения",
                "number": "4",
                "type": "item",
                "protected": True,
                "deletable": False,
                "children": [],
            },
            {
                "id": "5",
                "label": "Результаты проверки",
                "number": "5",
                "type": "item",
                "protected": True,
                "deletable": False,
                "children": [],
            },
        ],
    }


@pytest.fixture
def non_process_tree():
    """Дерево непроцессной проверки: раздел 1 и 2 с содержимым."""
    return {
        "id": "root",
        "label": "Акт",
        "children": [
            {
                "id": "1",
                "label": "Характеристика проверяемого направления",
                "number": "1",
                "type": "item",
                "protected": True,
                "deletable": False,
                "children": [
                    {
                        "id": "node_np_1",
                        "label": "Описание направления",
                        "type": "textblock",
                        "textBlockId": "tb_np_001",
                        "children": [],
                    },
                ],
            },
            {
                "id": "2",
                "label": "Оценка качества процесса",
                "number": "2",
                "type": "item",
                "protected": True,
                "deletable": False,
                "children": [
                    {
                        "id": "node_np_2",
                        "label": "Текстовый блок",
                        "type": "textblock",
                        "textBlockId": "tb_np_002",
                        "children": [],
                    },
                    {
                        "id": "node_np_3",
                        "label": "Нарушение",
                        "type": "violation",
                        "violationId": "viol_np_001",
                        "children": [],
                    },
                ],
            },
            {
                "id": "3",
                "label": "Выводы",
                "number": "3",
                "type": "item",
                "protected": True,
                "deletable": False,
                "children": [],
            },
            {
                "id": "4",
                "label": "Приложения",
                "number": "4",
                "type": "item",
                "protected": True,
                "deletable": False,
                "children": [],
            },
            {
                "id": "5",
                "label": "Результаты проверки",
                "number": "5",
                "type": "item",
                "protected": True,
                "deletable": False,
                "children": [],
            },
        ],
    }


# ── Процессная → непроцессная ──


class TestProcessToNonProcess:
    """Тесты смены типа: процессная → непроцессная."""

    def test_section_1_label_changed(self, process_tree):
        """Label раздела 1 меняется на 'Характеристика проверяемого направления'."""
        result = ActCrudService.restructure_sections_for_type_change(
            process_tree, new_is_process_based=False,
        )
        tree = result["tree"]
        section_1 = next(c for c in tree["children"] if c["id"] == "1")
        assert section_1["label"] == "Характеристика проверяемого направления"

    def test_section_1_children_cleared(self, process_tree):
        """Children раздела 1 очищаются."""
        result = ActCrudService.restructure_sections_for_type_change(
            process_tree, new_is_process_based=False,
        )
        tree = result["tree"]
        section_1 = next(c for c in tree["children"] if c["id"] == "1")
        assert section_1["children"] == []

    def test_section_2_children_cleared(self, process_tree):
        """Children раздела 2 очищаются."""
        result = ActCrudService.restructure_sections_for_type_change(
            process_tree, new_is_process_based=False,
        )
        tree = result["tree"]
        section_2 = next(c for c in tree["children"] if c["id"] == "2")
        assert section_2["children"] == []

    def test_table_ids_collected(self, process_tree):
        """table_ids из разделов 1 и 2 собраны для удаления."""
        result = ActCrudService.restructure_sections_for_type_change(
            process_tree, new_is_process_based=False,
        )
        ids = result["content_ids_to_delete"]
        assert "table_001" in ids["table_ids"]
        assert "table_qa_001" in ids["table_ids"]

    def test_textblock_ids_collected(self, process_tree):
        """textblock_ids из разделов 1 и 2 собраны для удаления."""
        result = ActCrudService.restructure_sections_for_type_change(
            process_tree, new_is_process_based=False,
        )
        ids = result["content_ids_to_delete"]
        assert "tb_001" in ids["textblock_ids"]
        assert "tb_002" in ids["textblock_ids"]

    def test_no_tables_to_insert(self, process_tree):
        """При переходе к непроцессной — нет таблиц для вставки."""
        result = ActCrudService.restructure_sections_for_type_change(
            process_tree, new_is_process_based=False,
        )
        assert result["tables_to_insert"] == []

    def test_sections_3_to_5_unchanged(self, process_tree):
        """Разделы 3-5 не изменяются."""
        original_3 = next(c for c in process_tree["children"] if c["id"] == "3")
        original_4 = next(c for c in process_tree["children"] if c["id"] == "4")
        original_5 = next(c for c in process_tree["children"] if c["id"] == "5")

        result = ActCrudService.restructure_sections_for_type_change(
            process_tree, new_is_process_based=False,
        )
        tree = result["tree"]

        section_3 = next(c for c in tree["children"] if c["id"] == "3")
        section_4 = next(c for c in tree["children"] if c["id"] == "4")
        section_5 = next(c for c in tree["children"] if c["id"] == "5")

        assert section_3["children"] == original_3["children"]
        assert section_4["children"] == original_4["children"]
        assert section_5["children"] == original_5["children"]


# ── Непроцессная → процессная ──


class TestNonProcessToProcess:
    """Тесты смены типа: непроцессная → процессная."""

    def test_section_1_label_changed(self, non_process_tree):
        """Label раздела 1 меняется на 'Информация о процессе, клиентском пути'."""
        result = ActCrudService.restructure_sections_for_type_change(
            non_process_tree, new_is_process_based=True,
        )
        tree = result["tree"]
        section_1 = next(c for c in tree["children"] if c["id"] == "1")
        assert section_1["label"] == "Информация о процессе, клиентском пути"

    def test_section_1_children_cleared(self, non_process_tree):
        """Children раздела 1 очищаются."""
        result = ActCrudService.restructure_sections_for_type_change(
            non_process_tree, new_is_process_based=True,
        )
        tree = result["tree"]
        section_1 = next(c for c in tree["children"] if c["id"] == "1")
        assert section_1["children"] == []

    def test_section_2_has_quality_assessment_table(self, non_process_tree):
        """В раздел 2 добавляется узел таблицы qualityAssessment."""
        result = ActCrudService.restructure_sections_for_type_change(
            non_process_tree, new_is_process_based=True,
        )
        tree = result["tree"]
        section_2 = next(c for c in tree["children"] if c["id"] == "2")

        assert len(section_2["children"]) == 1
        qa_node = section_2["children"][0]
        assert qa_node["type"] == "table"
        assert qa_node["protected"] is True
        # Таблицу разрешено удалить вручную и пересоздать из контекстного меню
        assert qa_node["deletable"] is True
        assert qa_node["parentId"] == "2"
        assert qa_node["label"] == "Результаты оценки качества процесса"
        assert qa_node["customLabel"] == "Результаты оценки качества процесса"
        assert qa_node["special"] == "quality_assessment"

    def test_quality_assessment_table_data_created(self, non_process_tree):
        """Создаются данные таблицы qualityAssessment с правильной структурой grid."""
        result = ActCrudService.restructure_sections_for_type_change(
            non_process_tree, new_is_process_based=True,
        )

        assert len(result["tables_to_insert"]) == 1
        table_data = result["tables_to_insert"][0]

        # 3 строки: 1 header + 2 data (2D массив ячеек)
        grid = table_data["grid"]
        assert len(grid) == 3

        # Первая строка — header
        header_row = grid[0]
        assert len(header_row) == 4
        assert header_row[0]["content"] == "Процесс"
        assert header_row[0]["isHeader"] is True
        assert header_row[0]["originRow"] == 0
        assert header_row[0]["originCol"] == 0
        assert header_row[1]["content"] == (
            "Количество проверенных экземпляров области проверки процесса, шт"
        )
        assert header_row[2]["content"] == "Общее количество отклонений, шт"
        assert header_row[3]["content"] == "Уровень отклонений, %"

        # Data строки
        for r_idx, row in enumerate(grid[1:], start=1):
            assert len(row) == 4
            for c_idx, cell in enumerate(row):
                assert cell["content"] == ""
                assert cell["isHeader"] is False
                assert cell["originRow"] == r_idx
                assert cell["originCol"] == c_idx

        # col_widths
        assert table_data["col_widths"] == [150, 200, 150, 100]

    def test_textblock_ids_collected_for_deletion(self, non_process_tree):
        """textblock_ids из разделов 1 и 2 собраны для удаления."""
        result = ActCrudService.restructure_sections_for_type_change(
            non_process_tree, new_is_process_based=True,
        )
        ids = result["content_ids_to_delete"]
        assert "tb_np_001" in ids["textblock_ids"]
        assert "tb_np_002" in ids["textblock_ids"]

    def test_violation_ids_collected_for_deletion(self, non_process_tree):
        """violation_ids из разделов 1 и 2 собраны для удаления."""
        result = ActCrudService.restructure_sections_for_type_change(
            non_process_tree, new_is_process_based=True,
        )
        ids = result["content_ids_to_delete"]
        assert "viol_np_001" in ids["violation_ids"]

    def test_table_data_has_correct_table_id(self, non_process_tree):
        """tableId в данных таблицы совпадает с tableId в узле дерева."""
        result = ActCrudService.restructure_sections_for_type_change(
            non_process_tree, new_is_process_based=True,
        )
        tree = result["tree"]
        section_2 = next(c for c in tree["children"] if c["id"] == "2")
        qa_node = section_2["children"][0]
        table_data = result["tables_to_insert"][0]

        assert table_data["table_id"] == qa_node["tableId"]


# ── Граничные случаи ──


class TestEdgeCases:
    """Граничные случаи."""

    def test_empty_tree_no_crash(self):
        """Пустое дерево (без children) не вызывает ошибку."""
        empty_tree = {"id": "root", "label": "Акт", "children": []}
        result = ActCrudService.restructure_sections_for_type_change(
            empty_tree, new_is_process_based=False,
        )
        assert result["tree"]["children"] == []
        assert result["content_ids_to_delete"]["table_ids"] == []
        assert result["content_ids_to_delete"]["textblock_ids"] == []
        assert result["content_ids_to_delete"]["violation_ids"] == []

    def test_recursive_id_collection(self):
        """Рекурсивный сбор ID из глубоко вложенных children."""
        tree = {
            "id": "root",
            "label": "Акт",
            "children": [
                {
                    "id": "1",
                    "label": "Раздел 1",
                    "number": "1",
                    "type": "item",
                    "protected": True,
                    "children": [
                        {
                            "id": "level_1",
                            "label": "Уровень 1",
                            "type": "item",
                            "children": [
                                {
                                    "id": "level_2",
                                    "label": "Уровень 2",
                                    "type": "item",
                                    "children": [
                                        {
                                            "id": "deep_tbl",
                                            "label": "Глубокая таблица",
                                            "type": "table",
                                            "tableId": "table_deep",
                                            "children": [],
                                        },
                                        {
                                            "id": "deep_tb",
                                            "label": "Глубокий текстблок",
                                            "type": "textblock",
                                            "textBlockId": "tb_deep",
                                            "children": [],
                                        },
                                        {
                                            "id": "deep_viol",
                                            "label": "Глубокое нарушение",
                                            "type": "violation",
                                            "violationId": "viol_deep",
                                            "children": [],
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
                {
                    "id": "2",
                    "label": "Раздел 2",
                    "number": "2",
                    "type": "item",
                    "protected": True,
                    "children": [],
                },
            ],
        }

        result = ActCrudService.restructure_sections_for_type_change(
            tree, new_is_process_based=False,
        )
        ids = result["content_ids_to_delete"]
        assert "table_deep" in ids["table_ids"]
        assert "tb_deep" in ids["textblock_ids"]
        assert "viol_deep" in ids["violation_ids"]
