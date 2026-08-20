"""
Форматер для Markdown представления актов.

Использует композицию утилит вместо наследования для обработки
таблиц, HTML и форматирования.
"""

import base64

from app.core.config import Settings
from app.domains.acts.block_types import NODE_TYPE_TABLE
from app.domains.acts.settings import ActsSettings
from .base_formatter import BaseFormatter
from .tree_walker import WalkContext, collect_blocks, walk
from .utils import HTMLUtils, MarkdownUtils, TableUtils
from .violation_render import format_violation, wrap_bold


def _image_data_url(image_id: str, images: dict | None) -> str:
    """Собирает data:image-URL из предзагруженных байт; '' — если байт нет.

    Единственное место, где base64 картинки вообще появляется: хранение и
    транспорт контента акта работают со ссылкой ``image_id``.
    """
    if not image_id or not images:
        return ""
    record = images.get(image_id)
    if not record:
        return ""
    data = record.get("data")
    if not isinstance(data, (bytes, bytearray)):
        return ""
    mime = record.get("mime_type") or "application/octet-stream"
    return f"data:{mime};base64,{base64.b64encode(bytes(data)).decode('ascii')}"


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
            data: Данные акта (tree, tables, textBlocks, violations); ключ
                ``images`` — предзагруженные байты картинок нарушений
                (``image_id → {"data": bytes, "mime_type": str}``), из них
                восстанавливаются data-URL картинок (см. ``_add_image``)

        Returns:
            Markdown-текст акта
        """
        result = []

        # Главный заголовок
        result.append("# АКТ")
        result.append("")

        # Обход дерева — единый walker, представление — в визиторе.
        visitor = _MarkdownTreeVisitor(self, data.get('images') or {})
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

    def _format_violation(self, violation_data: dict, images: dict | None = None) -> str:
        """
        Форматирует нарушение (блочная модель: цикл по полям реестра).

        Args:
            violation_data: Данные нарушения
            images: Предзагруженные байты картинок акта (см. ``format``)

        Returns:
            Markdown-текст нарушения
        """
        return format_violation(
            violation_data,
            bold_wrap=wrap_bold,
            text_conv=HTMLUtils.html_to_markdown,
            add_image=lambda lines, item: self._add_image(lines, item, images),
            add_table=self._add_violation_table,
        )

    def _add_violation_table(self, lines: list[str], table_data: dict):
        """
        Добавляет блок-таблицу нарушения (та же pipe-table, что у таблиц-узлов).

        Args:
            lines: Список строк для добавления
            table_data: Сетка встроенной таблицы ({grid, colWidths})
        """
        lines.append(self._format_table(table_data))
        lines.append("")

    def _add_image(self, lines: list[str], item: dict, images: dict | None = None):
        r"""
        Встраивает картинку (#16).

        РЕШЕНИЕ: в .md картинка восстанавливается ОБРАТНО в data-URL, а не
        отдаётся именем файла или ссылкой на API. Экспорт — один файл, который
        пользователь уносит с собой: ссылка на `/api/v1/acts/.../images/...`
        протухла бы вне сессии (и требовала бы авторизации), а имя файла без
        приложенных байт просто теряет картинку. Байты берутся из карты
        `images`, предзагруженной ExportService; в БД data-URL по-прежнему НЕ
        хранится — он собирается только на выходе.

        При доступных байтах — markdown-изображение `![alt](url "filename")`:
        alt = подпись или имя файла, имя файла сохраняется в title (чтобы не
        теряться при непустом url). Нет байт (пустой/висячий image_id) →
        текстовый fallback `*filename*` (с подписью, если есть).

        filename хранится дословно (без bleach, T4) — экранируем через
        MarkdownUtils.escape_inline (backslash экранируется первым, иначе
        `\]`/`\"` в тексте пользователя гасят экранирование и позволяют
        «впрыснуть» поддельную ссылку/картинку в экспорт, #7). caption —
        rich-HTML (Task 6, rich-редактор подписи): конвертируется в markdown
        через HTMLUtils.html_to_markdown (как кейс/свободный текст) — сама
        markdown-разметка **bold**/*italic* доходит до вывода как есть, а
        текстовые узлы (в т.ч. `[...](...)`) уже экранированы узловым
        конвертером (F1) РОВНО один раз. Поэтому повторного escape_inline по
        '[]' здесь НЕТ (дал бы двойное экранирование). Но alt/подпись —
        ОДНОСТРОЧНЫЙ контекст: переносы из <br>/границ блоков сворачиваем в
        пробел (как раньше это делал escape_inline), не трогая проставленные
        конвертером '\'. При пустой подписи в alt-ветке fallback — имя файла
        (plain-строка, конвертер её не видел) — экранируется как раньше.

        Args:
            lines: Список строк для добавления
            item: Данные изображения
        """
        # caption может быть None (легаси-данные без подписи, Task 6) —
        # html_to_markdown падает на None (нет собственного null-guard).
        caption = HTMLUtils.html_to_markdown(item.get('caption') or '')
        # Однострочный контекст alt/подписи: сворачиваем переносы в пробел БЕЗ
        # повторного backslash-экранирования (escape_inline экранирует '\'
        # первым и удвоил бы уже проставленные конвертером слэши).
        caption = caption.replace("\r", " ").replace("\n", " ")
        filename = item.get('filename', '')
        url = _image_data_url(item.get('image_id') or '', images)

        if url:
            alt = caption or MarkdownUtils.escape_inline(filename, '[]')
            title = MarkdownUtils.escape_inline(filename, '"')
            lines.append(f'![{alt}]({url} "{title}")')
        elif caption:
            filename_esc = MarkdownUtils.escape_inline(filename, '*[]')
            lines.append(f"*{filename_esc}* - {caption}")
        else:
            filename_esc = MarkdownUtils.escape_inline(filename, '*[]')
            lines.append(f"*{filename_esc}*")
        lines.append("")

class _MarkdownTreeVisitor:
    """Визитор tree-walker'а для Markdown: представление узлов дерева.

    Уровень заголовка строится от глубины обхода (дети корня — '##');
    рендеринг таблиц, текстблоков и нарушений делегируется методам
    MarkdownFormatter.
    """

    # Дети корня дерева начинаются с заголовков второго уровня (после '# АКТ').
    _BASE_HEADING_LEVEL = 2

    def __init__(self, formatter: MarkdownFormatter, images: dict | None = None):
        self._fmt = formatter
        # Байты картинок нарушений (предзагрузка экспорта); пусто — картинки
        # уйдут текстовым плейсхолдером.
        self._images = images or {}
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
            self.lines.append(self._fmt._format_violation(schema, self._images))
            self.lines.append("")
