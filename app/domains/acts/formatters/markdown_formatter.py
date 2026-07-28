"""
Форматер для Markdown представления актов.

Использует композицию утилит вместо наследования для обработки
таблиц, HTML и форматирования.
"""

from app.core.config import Settings
from app.domains.acts.block_types import NODE_TYPE_TABLE
from app.domains.acts.settings import ActsSettings
from .base_formatter import BaseFormatter
from .tree_walker import WalkContext, collect_blocks, walk
from .utils import HTMLUtils, MarkdownUtils, TableUtils
from .violation_render import (
    add_additional_content,
    add_case,
    add_description_list,
    add_free_text,
    add_labeled_section,
    add_required_pair,
    format_violation,
    wrap_bold,
)


class MarkdownFormatter(BaseFormatter):
    """
    Форматер для преобразования структуры акта в Markdown.

    Следует принципу Composition over Inheritance, используя
    утилитарные классы для специфичных задач.
    """

    def __init__(self, settings: Settings, acts_settings: ActsSettings):
        """
        Инициализация форматера с настройками.

        Args:
            settings: Глобальные настройки приложения
            acts_settings: Доменные настройки актов
        """
        self.settings = settings
        self.MAX_HEADING_LEVEL = acts_settings.formatting.markdown_max_heading_level

    def format(self, data: dict) -> str:
        """
        Форматирует данные акта в Markdown.

        Args:
            data: Данные акта (tree, tables, textBlocks, violations)

        Returns:
            Markdown-текст акта
        """
        result = []

        # Главный заголовок
        result.append("# АКТ")
        result.append("")

        # Обход дерева — единый walker, представление — в визиторе.
        visitor = _MarkdownTreeVisitor(self)
        walk(data.get('tree', {}), visitor, collect_blocks(data))
        result.extend(visitor.lines)

        return "\n".join(result)

    def _format_table(self, table_data: dict) -> str:
        """
        Форматирует таблицу в Markdown pipe tables.

        Args:
            table_data: Данные таблицы с grid структурой

        Returns:
            Markdown-таблица
        """
        grid = table_data.get('grid', [])

        if not grid:
            return "*[Пустая таблица]*"

        # Используем утилиту через композицию
        display_matrix = TableUtils.build_display_matrix(grid)

        if not display_matrix:
            return "*[Пустая таблица]*"

        lines = []
        max_cols = len(display_matrix[0])

        for idx, row in enumerate(display_matrix):
            # Экранируем pipes через утилиту
            escaped_row = [
                TableUtils.escape_markdown_pipes(cell) for cell in row
            ]
            lines.append('| ' + ' | '.join(escaped_row) + ' |')

            # Разделитель после заголовка
            if idx == 0:
                separator = '|' + '|'.join([' --- ' for _ in range(max_cols)]) + '|'
                lines.append(separator)

        return "\n".join(lines)

    def _format_textblock(self, textblock_data: dict) -> str:
        """
        Форматирует текстовый блок с HTML→Markdown конвертацией.

        Args:
            textblock_data: Данные блока с HTML контентом

        Returns:
            Markdown-текст блока
        """
        content = textblock_data.get('content', '')
        if not content:
            return ""

        # Используем HTML утилиту
        return HTMLUtils.html_to_markdown(content)

    def _format_violation(self, violation_data: dict) -> str:
        """
        Форматирует нарушение.

        Args:
            violation_data: Данные нарушения

        Returns:
            Markdown-текст нарушения
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
        add_required_pair(lines, label, content, wrap_bold, text_conv=HTMLUtils.html_to_markdown)

    def _add_labeled_section(self, lines: list[str], label: str, data: dict):
        """
        Добавляет опциональную секцию с жирной меткой (Причины/Принятые меры/
        Последствия/Ответственные) — только при enabled и непустом content.

        Args:
            lines: Список строк для добавления
            label: Текст метки
            data: Данные секции (dict с enabled/content)
        """
        add_labeled_section(lines, label, data, wrap_bold, text_conv=HTMLUtils.html_to_markdown)

    def _add_description_list(self, lines: list[str], desc_list: dict):
        """
        Добавляет список описаний.

        Пункты — rich-поле (Task 7, rich-редактор): HTML конвертируется в
        markdown через HTMLUtils.html_to_markdown (как кейс/свободный текст).

        Args:
            lines: Список строк для добавления
            desc_list: Данные списка с items
        """
        add_description_list(lines, desc_list, "- ", text_conv=HTMLUtils.html_to_markdown)

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
        return add_case(lines, item, case_number, wrap_bold, text_conv=HTMLUtils.html_to_markdown)

    def _add_image(self, lines: list[str], item: dict):
        r"""
        Встраивает картинку (#16).

        При непустом url — markdown-изображение `![alt](url "filename")`:
        alt = подпись или имя файла, имя файла сохраняется в title (чтобы не
        теряться при непустом url). Пустой url (черновик) → текстовый
        fallback `*filename*` (с подписью, если есть).

        filename хранится дословно (без bleach, T4) — экранируем через
        MarkdownUtils.escape_inline (backslash экранируется первым, иначе
        `\]`/`\"` в тексте пользователя гасят экранирование и позволяют
        «впрыснуть» поддельную ссылку/картинку в экспорт, #7). caption —
        rich-HTML (Task 6, rich-редактор подписи): конвертируется в markdown
        через HTMLUtils.html_to_markdown (как кейс/свободный текст) — сама
        markdown-разметка **bold**/*italic* должна дойти до вывода как есть.
        Результат ДОПОЛНИТЕЛЬНО экранируется по '[]' в обеих ветках (alt и
        текстовый fallback черновика, #15) — защита от структурного разрыва
        `![...]`/впрыска поддельной ссылки `[...](...)` содержимым caption;
        живая text-link ссылка в подписи черновика тем самым гасится — тот же
        трейдофф, что alt-ветка уже приняла для непустого url.

        Args:
            lines: Список строк для добавления
            item: Данные изображения
        """
        # caption может быть None (легаси-данные без подписи, Task 6) —
        # html_to_markdown падает на None (нет собственного null-guard).
        caption = HTMLUtils.html_to_markdown(item.get('caption') or '')
        filename = item.get('filename', '')
        url = item.get('url', '')

        if url:
            alt = MarkdownUtils.escape_inline(caption or filename, '[]')
            title = MarkdownUtils.escape_inline(filename, '"')
            lines.append(f'![{alt}]({url} "{title}")')
        elif caption:
            filename_esc = MarkdownUtils.escape_inline(filename, '*[]')
            caption_esc = MarkdownUtils.escape_inline(caption, '[]')
            lines.append(f"*{filename_esc}* - {caption_esc}")
        else:
            filename_esc = MarkdownUtils.escape_inline(filename, '*[]')
            lines.append(f"*{filename_esc}*")
        lines.append("")

    def _add_free_text(self, lines: list[str], item: dict):
        """
        Добавляет свободный текст.

        Args:
            lines: Список строк для добавления
            item: Данные с текстом
        """
        add_free_text(lines, item, text_conv=HTMLUtils.html_to_markdown)


class _MarkdownTreeVisitor:
    """Визитор tree-walker'а для Markdown: представление узлов дерева.

    Уровень заголовка строится от глубины обхода (дети корня — '##');
    рендеринг таблиц, текстблоков и нарушений делегируется методам
    MarkdownFormatter.
    """

    # Дети корня дерева начинаются с заголовков второго уровня (после '# АКТ').
    _BASE_HEADING_LEVEL = 2

    def __init__(self, formatter: MarkdownFormatter):
        self._fmt = formatter
        self.lines: list[str] = []

    def on_item_enter(self, node: dict, ctx: WalkContext) -> None:
        label = node.get('label', '')
        number = node.get('number', '')

        # Полный заголовок пункта из номера и текста.
        full_label = f"{number}. {label}" if number and label else (label or number)
        if full_label:
            heading_level = min(
                ctx.depth + self._BASE_HEADING_LEVEL, self._fmt.MAX_HEADING_LEVEL
            )
            self.lines.append(f"{'#' * heading_level} {full_label}")
            self.lines.append("")

        content = node.get('content', '')
        if content:
            self.lines.append(content)
            self.lines.append("")

    def on_item_exit(self, node: dict, ctx: WalkContext) -> None:
        pass

    def on_table(self, node: dict, schema: dict | None, ctx: WalkContext) -> None:
        if node.get('type') == NODE_TYPE_TABLE:
            # Заголовок узла-таблицы — обычной строкой (выводится и без данных);
            # прикреплённой к пункту таблице заголовком служит сам пункт.
            title = node.get('customLabel') or node.get('number') or node.get('label', '')
            if title:
                self.lines.append(title)
                self.lines.append("")
        if schema is not None:
            self.lines.append(self._fmt._format_table(schema))
            self.lines.append("")

    def on_textblock(self, node: dict, schema: dict | None, ctx: WalkContext) -> None:
        if schema is not None:
            self.lines.append(self._fmt._format_textblock(schema))
            self.lines.append("")

    def on_violation(self, node: dict, schema: dict | None, ctx: WalkContext) -> None:
        if schema is not None:
            self.lines.append(self._fmt._format_violation(schema))
            self.lines.append("")
