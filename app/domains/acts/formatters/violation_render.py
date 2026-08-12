"""
Общий рендеринг нарушений для Markdown/TXT форматтеров (блочная модель).

Единый цикл: поля в порядке ``fieldOrder`` нарушения (или стандартном, см.
``violation_fields.ordered_fields``) → у видимого поля метка + блоки по
порядку. Видимость и наличие метки — общая политика реестра
(``should_render_field`` / ``field_label_for_render``), та же, что у DOCX.
Формат-специфичны только четыре точки, передаваемые колбэками:
оформление метки (жирный MD / plain TXT), конвертер rich-HTML текста
(HTML→Markdown / HTML→plain), рендер картинки (#16) и рендер таблицы
(pipe-table MD / ASCII TXT) — их держат сами форматтеры.

Прежний зоопарк per-kind функций (add_required_pair / add_description_list /
add_case / add_additional_content / ...) умер вместе со старой моделью полей.
"""
from typing import Callable

from app.domains.acts.violation_fields import (
    field_label_for_render,
    ordered_fields,
    should_render_field,
)


def wrap_bold(text: str) -> str:
    """Оборачивает текст в жирное markdown-начертание."""
    return f"**{text}**"


def wrap_plain(text: str) -> str:
    """Возвращает текст без изменений (токен оформления для TXT)."""
    return text


def format_violation(
    violation_data: dict,
    *,
    bold_wrap: Callable[[str], str],
    text_conv: Callable[[str], str],
    add_image: Callable[[list[str], dict], None],
    add_table: Callable[[list[str], dict], None],
) -> str:
    """
    Форматирует нарушение: цикл по полям реестра в порядке отображения.

    Правила видимости и меток — общая политика реестра:
    ``should_render_field`` (mandatory всегда, остальные — при enabled и
    непустом контейнере) и ``field_label_for_render`` (None — поле выводится
    без строки метки, только контент).

    Args:
        violation_data: Документ нарушения (10 контейнеров + fieldOrder)
        bold_wrap: Токен оформления метки (жирный MD / как есть TXT)
        text_conv: Конвертер rich-HTML текст-блока под формат
        add_image: Рендер блока-картинки (реально разная логика MD/TXT, #16)
        add_table: Рендер блока-таблицы (pipe-table MD / ASCII TXT)

    Returns:
        Текстовое представление нарушения в формате вызывающего форматтера
    """
    lines: list[str] = []

    for field in ordered_fields(violation_data):
        container = violation_data.get(field.key)
        if not isinstance(container, dict):
            # Повреждённые данные (скаляр старой модели и т.п.) — считаем пустым.
            container = {}
        blocks = container.get('blocks') or []

        if not should_render_field(
            field,
            enabled=bool(container.get('enabled', False)),
            has_blocks=bool(blocks),
        ):
            continue

        label = field_label_for_render(field)
        if label is not None:
            lines.append(bold_wrap(f"{label}:"))
            lines.append("")

        for block in blocks:
            block_type = block.get('type')
            if block_type == 'text':
                content = block.get('content') or ''
                if content:
                    lines.append(text_conv(content))
                    lines.append("")
            elif block_type == 'image':
                add_image(lines, block)
            elif block_type == 'table':
                add_table(lines, block.get('table') or {})

    return "\n".join(lines)
