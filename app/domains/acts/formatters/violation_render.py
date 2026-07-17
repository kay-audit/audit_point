"""
Общий рендеринг нарушений для Markdown/TXT форматтеров (#12 code review).

Тела ``_format_violation``/``_add_free_text``/диспетчера ``_add_additional_content``
были байт-в-байт одинаковы в ``MarkdownFormatter`` и ``TextFormatter``, а
``_add_required_pair``/``_add_labeled_section``/``_add_description_list``/``_add_case``
отличались одним токеном оформления (жирный текст, буллит). Это дублирование
вынесено сюда как параметризованные stateless-функции — обычная композиция
(как ``formatters/utils/``), БЕЗ базового класса: каждый форматтер держит свои
тонкие методы-обёртки с собственными токенами/колбэками.

``_add_image`` — единственный метод с реально разной логикой (MD — markdown
``![]()`` с экранированием, TXT — обычная строка) — сюда не выносится.
"""
from typing import Callable


def wrap_bold(text: str) -> str:
    """Оборачивает текст в жирное markdown-начертание."""
    return f"**{text}**"


def wrap_plain(text: str) -> str:
    """Возвращает текст без изменений (токен оформления для TXT)."""
    return text


def format_violation(
    violation_data: dict,
    *,
    add_required_pair: Callable[[list[str], str, str], None],
    add_description_list: Callable[[list[str], dict], None],
    add_additional_content: Callable[[list[str], dict], None],
    add_labeled_section: Callable[[list[str], str, dict], None],
) -> str:
    """
    Форматирует нарушение, используя переданные обработчики полей формата.

    Args:
        violation_data: Данные нарушения
        add_required_pair: Обработчик обязательного поля (Нарушено/Установлено)
        add_description_list: Обработчик списка описаний
        add_additional_content: Обработчик доп. контента (кейсы/картинки/текст)
        add_labeled_section: Обработчик опциональной секции с меткой

    Returns:
        Текстовое представление нарушения в формате вызывающего форматтера
    """
    lines: list[str] = []

    # #14: обязательные поля — метка выводится всегда, даже при пустом
    # content (паритет с DOCX-эталоном «метка + пустое тело»).
    add_required_pair(lines, "Нарушено", violation_data.get('violated', ''))
    add_required_pair(lines, "Установлено", violation_data.get('established', ''))
    add_description_list(lines, violation_data.get('descriptionList', {}))
    add_additional_content(lines, violation_data.get('additionalContent', {}))
    add_labeled_section(lines, "Причины", violation_data.get('reasons', {}))
    add_labeled_section(lines, "Принятые меры", violation_data.get('measures', {}))
    add_labeled_section(lines, "Последствия", violation_data.get('consequences', {}))
    add_labeled_section(lines, "Ответственные", violation_data.get('responsible', {}))

    return "\n".join(lines)


def add_required_pair(
    lines: list[str], label: str, content: str, bold_wrap: Callable[[str], str],
    text_conv: Callable[[str], str] = lambda s: s,
) -> None:
    """
    Добавляет обязательное поле (Нарушено/Установлено): метка выводится
    всегда, даже при пустом content (#14).

    Args:
        lines: Список строк для добавления
        label: Текст метки
        content: Текст поля (может быть пустым)
        bold_wrap: Токен оформления метки (жирный MD / как есть TXT)
        text_conv: Конвертер content под формат (HTML→Markdown / HTML→plain);
            дефолт identity — для колбэков без rich-конвертации
    """
    lines.append(f"{bold_wrap(f'{label}:')} {text_conv(content)}".rstrip())
    lines.append("")


def add_labeled_section(
    lines: list[str], label: str, data: dict, bold_wrap: Callable[[str], str],
    text_conv: Callable[[str], str] = lambda s: s,
) -> None:
    """
    Добавляет опциональную секцию с меткой (Причины/Принятые меры/
    Последствия/Ответственные) — только при enabled и непустом content.

    Args:
        lines: Список строк для добавления
        label: Текст метки
        data: Данные секции (dict с enabled/content)
        bold_wrap: Токен оформления метки
        text_conv: Конвертер content под формат; дефолт identity
    """
    if not data.get('enabled', False):
        return
    content = data.get('content', '')

    if content:
        lines.append(f"{bold_wrap(f'{label}:')} {text_conv(content)}")
        lines.append("")


def add_description_list(lines: list[str], desc_list: dict, bullet: str) -> None:
    """
    Добавляет список описаний.

    Args:
        lines: Список строк для добавления
        desc_list: Данные списка с items
        bullet: Префикс буллита под формат (MD «- », TXT «  • »)
    """
    if not desc_list.get('enabled', False):
        return

    items = desc_list.get('items', [])
    if not items:
        return

    # #12: заголовок «Описание» убран — только маркированный список.
    # #15/Q1: рендерятся ВСЕ пункты, включая пустые (пустой → пустой буллит),
    # единообразно с превью и DOCX (пользователь выбрал не прятать).
    for item in items:
        lines.append(f"{bullet}{item}")
    lines.append("")


def add_case(
    lines: list[str], item: dict, case_number: int, bold_wrap: Callable[[str], str],
    text_conv: Callable[[str], str] = lambda s: s,
) -> int:
    """
    Добавляет кейс с нумерацией.

    Args:
        lines: Список строк для добавления
        item: Данные кейса
        case_number: Текущий номер кейса
        bold_wrap: Токен оформления метки
        text_conv: Конвертер content под формат; дефолт identity

    Returns:
        Следующий номер кейса
    """
    # #9/Q1: нумеруются ВСЕ кейсы, включая пустые (метка + пустое тело);
    # счётчик всегда двигается вперёд.
    content = item.get('content', '')
    lines.append(f"{bold_wrap(f'Кейс {case_number}:')} {text_conv(content)}".rstrip())
    lines.append("")
    return case_number + 1


def add_free_text(
    lines: list[str], item: dict, text_conv: Callable[[str], str] = lambda s: s,
) -> None:
    """
    Добавляет свободный текст.

    Args:
        lines: Список строк для добавления
        item: Данные с текстом
        text_conv: Конвертер content под формат; дефолт identity
    """
    content = item.get('content', '')
    if content:
        lines.append(text_conv(content))
        lines.append("")


def add_additional_content(
    lines: list[str],
    additional_content: dict,
    add_case: Callable[[list[str], dict, int], int],
    add_image: Callable[[list[str], dict], None],
    add_free_text: Callable[[list[str], dict], None],
) -> None:
    """
    Добавляет дополнительный контент (кейсы, изображения, свободный текст).

    Args:
        lines: Список строк для добавления
        additional_content: Данные с items разных типов
        add_case: Обработчик кейса (свой bold_wrap у каждого форматтера)
        add_image: Обработчик изображения (реально разная логика MD/TXT, #16)
        add_free_text: Обработчик свободного текста
    """
    if not additional_content.get('enabled', False):
        return

    items = additional_content.get('items', [])
    case_number = 1

    for item in items:
        item_type = item.get('type')

        if item_type == 'case':
            case_number = add_case(lines, item, case_number)
        elif item_type == 'image':
            add_image(lines, item)
            case_number = 1
        elif item_type == 'freeText':
            add_free_text(lines, item)
            case_number = 1
