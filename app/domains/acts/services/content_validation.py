"""Сбор замечаний структурной валидации акта (статус акта, фича #8).

Чистая, НЕ бросающая исключений функция: вычисляет состояние акта при
сохранении. Зеркалит фронтовые проверки (validation-act.js /
validation-table-core.js), но это ИСТОЧНИК ИСТИНЫ для хранимого статуса —
фронту доверять нельзя (может быть устаревшим/обойдённым). Каждое замечание —
{code, severity, message, ref?}. severity: 'error' (акт сломан) /
'warning' (заполнен не полностью).

Намеренно НЕ дублирует жёсткие интеграционные проверки `_validate_tree`
(глубина/корень — они по-прежнему бросают ActValidationError: дерево без
корня нельзя сохранить вообще) и грид-дефекты таблиц (P6a → 422 на схеме):
здесь собираются «мягкие» замечания, при которых акт сохраняется как WIP.
"""

from __future__ import annotations

from typing import Any

from app.domains.acts.formatters.utils.html_utils import HTMLUtils
from app.domains.acts.schemas.act_content import ActDataSchema
from app.domains.acts.violation_fields import VIOLATION_FIELDS

# Базовые разделы 1–6 (1–5 + обязательный пункт Process Mining), по id,
# как ValidationAct.validateStructure на фронте.
_BASE_SECTION_IDS = ("1", "2", "3", "4", "5", "6")


def _table_node_labels(tree: dict | None) -> dict[str, str]:
    """tableId → человекочитаемая метка узла-таблицы (для сообщений)."""
    labels: dict[str, str] = {}
    stack: list[Any] = [tree] if tree else []
    while stack:
        node = stack.pop()
        if not isinstance(node, dict):
            continue
        tid = node.get("tableId")
        if tid:
            labels[tid] = node.get("customLabel") or node.get("label") or "Таблица"
        stack.extend(node.get("children") or [])
    return labels


def _violation_node_labels(tree: dict | None) -> dict[str, str]:
    """violationId → человекочитаемая метка узла-нарушения (для сообщений)."""
    labels: dict[str, str] = {}
    stack: list[Any] = [tree] if tree else []
    while stack:
        node = stack.pop()
        if not isinstance(node, dict):
            continue
        vid = node.get("violationId")
        if vid:
            labels[vid] = node.get("customLabel") or node.get("label") or "Нарушение"
        stack.extend(node.get("children") or [])
    return labels


def _is_html_value_empty(value: str | None) -> bool:
    """Пусто ли rich-HTML-значение поля (снятие тегов + нормализация пробелов).

    Очищенное contenteditable-поле хранит `<br>` или `<div><br></div>` —
    оба тега входят в allowlist санитайзера и переживают очистку, поэтому
    проверка по сырому значению (`(value or '').strip()`) даёт ложное
    «заполнено». Снимает теги тем же экстрактором, что и TXT/MD-экспорт
    (HTMLUtils.clean_html), и проверяет остаток на пробельность.
    """
    if not value:
        return True
    return not HTMLUtils.clean_html(value).strip()


def _is_block_empty(block: Any) -> bool:
    """Пуст ли один блок поля нарушения (блочная модель text/image/table).

    text — HTML-aware проверка видимого содержимого (см. `_is_html_value_empty`);
    image — пуст, если нет url; table — пуста, если во всех ячейках grid нет
    непустого content (ячейки хранят plain-текст, не rich-HTML).
    """
    block_type = getattr(block, "type", None)
    if block_type == "text":
        return _is_html_value_empty(getattr(block, "content", ""))
    if block_type == "image":
        return not (getattr(block, "url", "") or "").strip()
    if block_type == "table":
        grid = getattr(getattr(block, "table", None), "grid", None) or []
        return not any(
            (getattr(cell, "content", "") or "").strip()
            for row in grid
            for cell in row
        )
    return True


def _field_is_empty(field: Any) -> bool:
    """Пуст ли контейнер поля нарушения: нет ни одного непустого блока.

    None-гвард: у повреждённого нарушения контейнер поля может отсутствовать
    или его `blocks` — не список (не прошли/обошли схему) — такое поле
    считается пустым, а не роняет валидацию.
    """
    blocks = getattr(field, "blocks", None)
    if not isinstance(blocks, list):
        return True
    return all(_is_block_empty(block) for block in blocks)


def _violation_has_empty_fields(violation: Any) -> bool:
    """Есть ли у нарушения незаполненные ВКЛЮЧЁННЫЕ поля.

    Поля блочной модели — контейнеры `{enabled, blocks}`; поле считается
    пустым, если в нём нет ни одного непустого блока (`_field_is_empty`).
    Учитываются обязательные (`mandatory` в реестре — включены всегда) и
    опциональные, которые пользователь ВКЛЮЧИЛ чекбоксом: включённое пустое
    поле — незаконченная работа, а не осознанный пропуск (выключенное поле
    не проверяется вовсе). Ревью №6: без этого включённое пустое поле молча
    доезжало до экспорта — раньше «висячей подписью» в DOCX, теперь тихой
    пропажей (рендеры такое поле не выводят), и предупредить о нём при
    сохранении может только валидация.
    """
    for field in VIOLATION_FIELDS:
        container = getattr(violation, field.key, None)
        if not field.mandatory and not getattr(container, "enabled", False):
            continue
        if _field_is_empty(container):
            return True
    return False


def _count_header_rows(grid) -> int:
    """Число подряд идущих сверху строк-заголовков (как countHeaderRows)."""
    count = 0
    for row in grid:
        if not any(getattr(cell, "isHeader", False) for cell in row):
            break
        count += 1
    return count


def _has_empty_headers(grid, header_rows: int) -> bool:
    """Есть ли пустые видимые ячейки в шапке (как hasEmptyHeaders)."""
    for r in range(header_rows):
        for cell in grid[r]:
            if (
                not getattr(cell, "isSpanned", False)
                and getattr(cell, "isHeader", False)
                and not (getattr(cell, "content", "") or "").strip()
            ):
                return True
    return False


def _has_data_rows(grid, header_rows: int) -> bool:
    """Есть ли хотя бы одна заполненная строка данных (как hasDataRows)."""
    for r in range(header_rows, len(grid)):
        for cell in grid[r]:
            if not getattr(cell, "isSpanned", False) and (getattr(cell, "content", "") or "").strip():
                return True
    return False


def collect_validation_issues(data: ActDataSchema) -> list[dict[str, Any]]:
    """Собирает замечания структуры/контента акта (без исключений)."""
    issues: list[dict[str, Any]] = []
    tree = data.tree if isinstance(data.tree, dict) else None

    # ── Структура (зеркало ValidationAct.validateStructure) ──
    children = tree.get("children") if tree else None
    if not children or not isinstance(children, list):
        issues.append({
            "code": "empty_structure", "severity": "error",
            "message": "Структура акта пуста: добавьте хотя бы один раздел",
        })
    else:
        sections = [c for c in children if isinstance(c, dict)]
        by_id = {c.get("id"): c for c in sections}
        missing = [sid for sid in _BASE_SECTION_IDS if sid not in by_id]
        if missing:
            issues.append({
                "code": "missing_sections", "severity": "error",
                "message": f"Базовая структура повреждена: отсутствуют разделы {', '.join(missing)}",
            })
        unprotected = [
            sid for sid in _BASE_SECTION_IDS
            if sid in by_id and (not by_id[sid].get("protected") or by_id[sid].get("deletable") is not False)
        ]
        if unprotected:
            issues.append({
                "code": "unprotected_sections", "severity": "error",
                "message": f"Базовая структура повреждена: разделы {', '.join(unprotected)} не защищены от изменения",
            })

    # ── Таблицы (зеркало validation-table-core) ──
    labels = _table_node_labels(tree)
    for tid, table in (data.tables or {}).items():
        grid = getattr(table, "grid", None) or []
        if not grid:
            continue
        name = labels.get(tid) or labels.get(getattr(table, "nodeId", "")) or "Таблица"
        header_rows = _count_header_rows(grid)
        if header_rows == 0:
            issues.append({
                "code": "table_no_header", "severity": "error", "ref": tid,
                "message": f"Таблица «{name}» без строки заголовка",
            })
        elif _has_empty_headers(grid, header_rows):
            issues.append({
                "code": "table_empty_header", "severity": "error", "ref": tid,
                "message": f"Таблица «{name}»: не заполнены заголовки",
            })
        if not _has_data_rows(grid, header_rows):
            issues.append({
                "code": "table_no_data", "severity": "warning", "ref": tid,
                "message": f"Таблица «{name}» без данных",
            })

    # ── Нарушения (Q1, wave 2): мягкое замечание о незаполненных полях ──
    violation_labels = _violation_node_labels(tree)
    for vid, violation in (data.violations or {}).items():
        if not _violation_has_empty_fields(violation):
            continue
        name = violation_labels.get(vid) or violation_labels.get(getattr(violation, "nodeId", "")) or "Нарушение"
        issues.append({
            "code": "violation_incomplete", "severity": "warning", "ref": vid,
            "message": f"Нарушение «{name}»: есть незаполненные поля",
        })

    return issues


# Уровни состояния структурной валидации содержимого (фича #8):
#   'error'   — акт структурно сломан (среди замечаний есть severity='error':
#               пустая/повреждённая структура разделов, таблица без заголовка).
#               Критично — приравнен к требованию проверки фактуры (красная карточка).
#   'warning' — заполнен не полностью (только severity='warning', напр. таблица
#               без данных): работа не закончена, но не критично — карточку НЕ
#               красит, виден агрегатом в колокольчике лендинга и полным списком
#               внутри акта.
#   'ok'      — замечаний нет.
VALIDATION_OK = "ok"
VALIDATION_WARNING = "warning"
VALIDATION_ERROR = "error"


def status_from_issues(issues: list[dict[str, Any]]) -> str:
    """Статус акта по замечаниям (три уровня, решение #8).

    Любое замечание severity='error' → 'error'. Иначе при наличии только
    «мягких» замечаний (severity='warning') → 'warning'. Нет замечаний → 'ok'.
    """
    if any(i.get("severity") == "error" for i in issues):
        return VALIDATION_ERROR
    if issues:
        return VALIDATION_WARNING
    return VALIDATION_OK
