"""
Форматер для текстового представления актов.

Создает plain text с ASCII-таблицами и отступами для иерархии.
"""

from app.core.config import Settings
from app.domains.acts.block_types import NODE_TYPE_TABLE
from app.domains.acts.settings import ActsSettings
from .base_formatter import BaseFormatter
from .tree_walker import WalkContext, collect_blocks, walk
from .utils import HTMLUtils, TableUtils
from .violation_render import (
    add_additional_content,
    add_case,
    add_description_list,
    add_free_text,
    add_labeled_section,
    add_required_pair,
    format_violation,
    wrap_plain,
)


class TextFormatter(BaseFormatter):
    """
    Форматер для plain text с ASCII-графикой.

    Использует композицию утилит для обработки данных и создания
    визуально приятного текстового представления с таблицами.
    """

    def __init__(self, settings: Settings, acts_settings: ActsSettings):
        """
        Инициализация форматера с настройками.

        Args:
            settings: Глобальные настройки приложения
            acts_settings: Доменные настройки актов
        """
        self.settings = settings
        self.HEADER_WIDTH = acts_settings.formatting.text_header_width
        self.INDENT_SIZE = acts_settings.formatting.text_indent_size

    def format(self, data: dict) -> str:
        """
        Форматирует данные акта в plain text.

        Args:
            data: Данные акта (tree, tables, textBlocks, violations)

        Returns:
            Plain text представление акта
        """
        result = []

        # Декоративный заголовок
        result.append("=" * self.HEADER_WIDTH)
        result.append("АКТ".center(self.HEADER_WIDTH))
        result.append("=" * self.HEADER_WIDTH)
        result.append("")

        # Обход дерева — единый walker, представление — в визиторе.
        visitor = _TextTreeVisitor(self)
        walk(data.get('tree', {}), visitor, collect_blocks(data))
        result.extend(visitor.lines)

        return "\n".join(result)

    def _format_table(self, table_data: dict, level: int = 0) -> str:
        """
        Форматирует таблицу в ASCII-графику.

        Args:
            table_data: Данные таблицы с grid структурой
            level: Уровень вложенности (для отступов)

        Returns:
            ASCII-таблица
        """
        indent = " " * (self.INDENT_SIZE * level)
        grid = table_data.get('grid', [])

        if not grid:
            return f"{indent}[Пустая таблица]"

        # Используем утилиту для построения матрицы
        display_matrix = TableUtils.build_display_matrix(grid)

        if not display_matrix:
            return f"{indent}[Пустая таблица]"

        # Используем утилиту для вычисления ширины колонок
        col_widths = TableUtils.calculate_column_widths(display_matrix)

        # Построение ASCII-таблицы
        lines = []
        separator = self._draw_separator(col_widths, indent)

        lines.append(separator)  # Верхняя граница

        for idx, row in enumerate(display_matrix):
            lines.append(self._draw_row(row, col_widths, indent))
            # Разделитель после заголовка
            if idx == 0:
                lines.append(separator)

        lines.append(separator)  # Нижняя граница

        return "\n".join(lines)

    def _draw_separator(self, col_widths: list[int], indent: str) -> str:
        """
        Создает горизонтальный разделитель таблицы.

        Args:
            col_widths: Ширины колонок
            indent: Отступ для текущего уровня

        Returns:
            Строка разделителя
        """
        parts = ['-' * (width + 2) for width in col_widths]
        return f"{indent}+{'+'.join(parts)}+"

    def _draw_row(self, row: list[str], col_widths: list[int], indent: str) -> str:
        """
        Создает строку таблицы с содержимым.

        Args:
            row: Данные строки
            col_widths: Ширины колонок
            indent: Отступ для текущего уровня

        Returns:
            Отформатированная строка таблицы
        """
        row_parts = []
        for col_idx, width in enumerate(col_widths):
            cell_text = str(row[col_idx]) if col_idx < len(row) else ''
            row_parts.append(f" {cell_text.ljust(width)} ")
        return f"{indent}|{'|'.join(row_parts)}|"

    def _format_textblock(self, textblock_data: dict, level: int = 0) -> str:
        """
        Форматирует текстовый блок с очисткой HTML.

        Args:
            textblock_data: Данные блока с HTML контентом
            level: Уровень вложенности (для отступов)

        Returns:
            Очищенный текст с отступами
        """
        indent = " " * (self.INDENT_SIZE * level)
        content = textblock_data.get('content', '')

        if not content:
            return ""

        # Используем HTML утилиту для очистки
        clean_content = HTMLUtils.clean_html(content)

        # Применение отступов к каждой строке
        lines = clean_content.split('\n')
        formatted_lines = [f"{indent}{line}" for line in lines]

        return "\n".join(formatted_lines)

    def _format_violation(self, violation_data: dict) -> str:
        """
        Форматирует нарушение.

        Args:
            violation_data: Данные нарушения

        Returns:
            Текстовое представление нарушения
        """
        return format_violation(
            violation_data,
            add_required_pair=self._add_required_pair,
            add_description_list=self._add_description_list,
            add_additional_content=self._add_additional_content,
            add_labeled_section=self._add_labeled_section,
        )

    def _add_required_pair(self, lines: list[str], label: str, content: str):
        """
        Добавляет обязательное поле (Нарушено/Установлено): метка выводится
        всегда, даже при пустом content (#14).

        Args:
            lines: Список строк для добавления
            label: Текст метки
            content: Текст поля (может быть пустым)
        """
        add_required_pair(lines, label, content, wrap_plain, text_conv=HTMLUtils.clean_html)

    def _add_labeled_section(self, lines: list[str], label: str, data: dict):
        """
        Добавляет опциональную секцию с меткой (Причины/Принятые меры/
        Последствия/Ответственные) — только при enabled и непустом content.

        Args:
            lines: Список строк для добавления
            label: Текст метки
            data: Данные секции (dict с enabled/content)
        """
        add_labeled_section(lines, label, data, wrap_plain, text_conv=HTMLUtils.clean_html)

    def _add_description_list(self, lines: list[str], desc_list: dict):
        """
        Добавляет список описаний.

        Пункты — rich-поле (Task 7, rich-редактор): HTML конвертируется в
        видимый текст через HTMLUtils.clean_html (как кейс/свободный текст).

        Args:
            lines: Список строк для добавления
            desc_list: Данные списка с items
        """
        add_description_list(lines, desc_list, "  • ", text_conv=HTMLUtils.clean_html)

    def _add_additional_content(self, lines: list[str], additional_content: dict):
        """
        Добавляет дополнительный контент (кейсы, изображения, свободный текст).

        Args:
            lines: Список строк для добавления
            additional_content: Данные с items разных типов
        """
        add_additional_content(
            lines, additional_content, self._add_case, self._add_image, self._add_free_text,
        )

    def _add_case(self, lines: list[str], item: dict, case_number: int) -> int:
        """
        Добавляет кейс с нумерацией.

        Args:
            lines: Список строк для добавления
            item: Данные кейса
            case_number: Текущий номер кейса

        Returns:
            Следующий номер кейса
        """
        return add_case(lines, item, case_number, wrap_plain, text_conv=HTMLUtils.clean_html)

    def _add_image(self, lines: list[str], item: dict):
        """
        Добавляет ссылку на изображение.

        caption — rich-HTML (Task 6, rich-редактор подписи), конвертируется в
        видимый текст через HTMLUtils.clean_html (как кейс/свободный текст).

        Args:
            lines: Список строк для добавления
            item: Данные изображения
        """
        # caption может быть None (легаси-данные без подписи, Task 6) —
        # clean_html падает на None (нет собственного null-guard).
        caption = HTMLUtils.clean_html(item.get('caption') or '')
        filename = item.get('filename', '')

        if caption:
            lines.append(f"Изображение: {filename} - {caption}")
        else:
            lines.append(f"Изображение: {filename}")
        lines.append("")

    def _add_free_text(self, lines: list[str], item: dict):
        """
        Добавляет свободный текст.

        Args:
            lines: Список строк для добавления
            item: Данные с текстом
        """
        add_free_text(lines, item, text_conv=HTMLUtils.clean_html)


class _TextTreeVisitor:
    """Визитор tree-walker'а для plain text: представление узлов дерева.

    Отступ строится от глубины обхода (ctx.depth); рендеринг таблиц,
    текстблоков и нарушений делегируется методам TextFormatter.
    """

    def __init__(self, formatter: TextFormatter):
        self._fmt = formatter
        self.lines: list[str] = []

    def _indent(self, depth: int) -> str:
        return " " * (self._fmt.INDENT_SIZE * depth)

    def on_item_enter(self, node: dict, ctx: WalkContext) -> None:
        indent = self._indent(ctx.depth)
        label = node.get('label', '')
        number = node.get('number', '')

        # Полный заголовок пункта из номера и текста, с подчёркиванием.
        full_label = f"{number}. {label}" if number and label else (label or number)
        if full_label:
            self.lines.append(f"{indent}{full_label}")
            self.lines.append(f"{indent}{'-' * len(full_label)}")

        content = node.get('content', '')
        if content:
            self.lines.append(f"{indent}{content}")
            self.lines.append("")

    def on_item_exit(self, node: dict, ctx: WalkContext) -> None:
        pass

    def on_table(self, node: dict, schema: dict | None, ctx: WalkContext) -> None:
        indent = self._indent(ctx.depth)
        if node.get('type') == NODE_TYPE_TABLE:
            # Заголовок узла-таблицы с подчёркиванием (выводится и без данных);
            # прикреплённой к пункту таблице заголовком служит сам пункт.
            title = node.get('customLabel') or node.get('number') or node.get('label', '')
            if title:
                self.lines.append(f"{indent}{title}")
                self.lines.append(f"{indent}{'-' * len(title)}")
        if schema is not None:
            self.lines.append(self._fmt._format_table(schema, ctx.depth))
            self.lines.append("")

    def on_textblock(self, node: dict, schema: dict | None, ctx: WalkContext) -> None:
        if schema is not None:
            self.lines.append(self._fmt._format_textblock(schema, ctx.depth))
            self.lines.append("")

    def on_violation(self, node: dict, schema: dict | None, ctx: WalkContext) -> None:
        if schema is None:
            return
        indent = self._indent(ctx.depth)
        # Отступ применяется к каждой строке нарушения.
        for line in self._fmt._format_violation(schema).split('\n'):
            self.lines.append(f"{indent}{line}")
        self.lines.append("")
