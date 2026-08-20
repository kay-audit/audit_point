"""Страж реестра переменных в доках: «дефолт в модели ↔ число в §9.5».

Реестр `§9.5 Полная таблица переменных окружения`
(`docs/guides/deploy-and-configuration.md`) — то место, куда смотрят, когда
поднимают лимит на ПРОМе. Врущее число там опаснее отсутствующего: оно выглядит
как проверенный факт. А расходится реестр молча — правка дефолта в pydantic-
модели ничего в доках не двигает, и разъезд обнаруживается только при ручной
сверке (на аудите 2026-08-20 таких строк нашлось семь).

Устройство — как у `test_env_templates_sync.py`: ожидаемые имена и значения
берутся ИЗ МОДЕЛЕЙ, а не хардкодятся, поэтому новое поле настроек
автоматически становится требованием к реестру. Функция сбора имён
переиспользуется оттуда же — «какие поля существуют» должно определяться в
одном месте.

Проверяется три вещи: реестр покрывает все поля; в реестре нет строк, под
которые поля не осталось; литеральные дефолты совпадают. Строки, где в колонке
«По умолчанию» стоит не литерал, а сводка или обрезка (длинные списки, CSP,
системный промпт), перечислены в `NOT_LITERAL` — явным списком с причиной,
как и в соседнем страже.
"""

import re
from pathlib import Path

import pytest
from pydantic import SecretStr

from app.core import settings_registry
from app.core.chat.tools import reset as reset_tools
from app.core.domain_registry import reset_registry
from tests.test_env_templates_sync import NOT_IN_MODELS, _expand, _expected_vars

ROOT = Path(__file__).resolve().parent.parent
DOC = ROOT / "docs" / "guides" / "deploy-and-configuration.md"

# Границы разбираемого куска: сам реестр, без соседних разделов с таблицами.
SECTION_START = "### 9.5 Полная таблица переменных окружения"
SECTION_END = "### 9.5a"

# --- Исключения -----------------------------------------------------------
# Переменные, у которых в колонке «По умолчанию» стоит НЕ литерал: значение
# длинное (список, политика, промпт) и в таблице живёт сводкой либо обрезкой.
# Список ЯВНЫЙ: каждая запись — сознательное решение, а не способ погасить
# упавший тест. Покрытие (строка в реестре есть, имя совпадает) с этих
# переменных не снимается — не проверяется только само значение.
NOT_LITERAL = {
    "APP_TITLE": "берётся из app/__init__.py, а не из литерала в модели",
    "APP_VERSION": "то же: единственный источник — __version__",
    "ACTS__IMAGES__ALLOWED_MIME_TYPES": "список MIME, в таблице сводкой",
    "ACTS__SANITIZER__ALLOWED_TAGS": "22 тега, в таблице сводкой",
    "ACTS__SANITIZER__ALLOWED_CSS_PROPERTIES": "8 свойств, в таблице сводкой",
    "ACTS__SANITIZER__ALLOWED_DATA_ATTRS": "список data-атрибутов, в таблице сводкой",
    "ADMIN__USER_DIRECTORY__BRANCH_FILTER": "длинное название отделения, обрезано",
    "CHAT__ALLOWED_MIME_TYPES": "13 MIME-типов, вынесены отдельной таблицей в §9.4.2",
    "CHAT__SYSTEM_PROMPT": "системный промпт в несколько строк, обрезан",
    "SECURITY__CSP_POLICY": "политика целиком, в таблице обрезана",
    "SECURITY__PERMISSIONS_POLICY": "строка директив, в таблице обрезана",
}

# Как в реестре записывают «значения нет»: пустая строка, None, пустой SecretStr.
EMPTY_DOC_TOKENS = {'""', "''", "(пусто)", "(не задана)", "null", "None"}

ROW_RE = re.compile(r"^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|[^|]*\|([^|]*)\|")


@pytest.fixture(autouse=True)
def _clean_registries():
    """Доменные реестры глобальные — сбрасываем до и после."""
    reset_registry()
    settings_registry.reset()
    reset_tools()
    yield
    reset_registry()
    settings_registry.reset()
    reset_tools()


# --- Разбор реестра -------------------------------------------------------

def _registry_rows() -> dict[str, tuple[str, int]]:
    """``{ИМЯ: (ячейка «По умолчанию», номер строки)}`` из §9.5.

    Разбирается только сам реестр: в соседних разделах есть свои таблицы, и
    захватывать их строки было бы ложным срабатыванием.
    """
    lines = DOC.read_text(encoding="utf-8").splitlines()
    rows: dict[str, tuple[str, int]] = {}
    inside = False
    for lineno, line in enumerate(lines, 1):
        if line.startswith(SECTION_START):
            inside = True
            continue
        if inside and line.startswith(SECTION_END):
            break
        if not inside:
            continue
        match = ROW_RE.match(line)
        if match:
            rows[match.group(1)] = (match.group(2).strip(), lineno)

    assert len(rows) > 100, (
        "разбор реестра выродился: найдено строк "
        f"{len(rows)}. Проверь заголовки-границы (`{SECTION_START}` / "
        f"`{SECTION_END}`) — они могли переехать вместе с нумерацией"
    )
    return rows


def _model_defaults() -> dict[str, object]:
    """``{ИМЯ: дефолт}`` по тем же моделям, что и у стража шаблонов."""
    _expected_vars()  # побочный эффект: discover_domains наполняет реестр
    from app.core.config import Settings

    defaults = _expand_defaults(Settings)
    for domain, instance in settings_registry._registry.items():
        defaults.update(_expand_defaults(type(instance), f"{domain.upper()}__"))
    return defaults


def _expand_defaults(model, prefix: str = "") -> dict[str, object]:
    """Дефолты полей модели под теми же именами, что строит ``_expand``."""
    names = _expand(model, prefix)
    out: dict[str, object] = {}
    for name in names:
        out[name] = _lookup_default(model, name[len(prefix):])
    return out


def _lookup_default(model, path: str):
    """Дефолт вложенного поля по пути вида ``AGENT_CHANNEL__TABLE_NAME``."""
    head, _, rest = path.partition("__")
    for field_name, field_info in model.model_fields.items():
        if (field_info.alias or field_name).upper() != head:
            continue
        default = field_info.default
        if field_info.default_factory is not None:
            default = field_info.default_factory()
        if rest:
            return _lookup_default(type(default), rest)
        return default
    raise AssertionError(f"поле {path} не найдено в {model.__name__}")


def _render(value) -> str:
    """Дефолт в том виде, в каком его пишут в колонке «По умолчанию»."""
    if isinstance(value, SecretStr):
        value = value.get_secret_value()
    if value is None:
        return ""
    return str(value)


def _doc_literal(cell: str) -> str:
    """Содержимое ячейки без обрамляющих backtick'ов."""
    match = re.fullmatch(r"`(.*)`", cell.strip())
    return match.group(1) if match else cell.strip()


# --- Тесты ----------------------------------------------------------------

def test_registry_covers_all_settings():
    """Каждое поле настроек описано строкой реестра."""
    missing = sorted(set(_model_defaults()) - set(_registry_rows()))
    assert not missing, (
        "§9.5 не описывает переменные, которые есть в моделях настроек "
        f"({len(missing)} шт.) — добавь строки:\n  " + "\n  ".join(missing)
    )


def test_registry_has_no_orphan_rows():
    """В реестре нет строк, под которые поля настроек не осталось."""
    known = set(_model_defaults()) | set(NOT_IN_MODELS)
    orphans = sorted(set(_registry_rows()) - known)
    assert not orphans, (
        "§9.5 описывает переменные, которым не соответствует ни одно поле "
        f"настроек — мусор от удалённых полей либо опечатка:\n  "
        + "\n  ".join(orphans)
    )


def test_registry_defaults_match_models():
    """Колонка «По умолчанию» совпадает с дефолтом в pydantic-модели."""
    rows = _registry_rows()
    mismatched = []
    for name, default in sorted(_model_defaults().items()):
        if name in NOT_LITERAL or name not in rows:
            continue
        cell, lineno = rows[name]
        documented = _doc_literal(cell)
        actual = _render(default)
        if not actual and documented in EMPTY_DOC_TOKENS:
            continue
        if documented != actual:
            mismatched.append(
                f"строка {lineno}: {name} — в доках `{documented}`, "
                f"в модели `{actual}`"
            )
    assert not mismatched, (
        "§9.5 разошёлся с дефолтами моделей — реестр читают, когда решают, "
        f"что ставить на ПРОМе ({len(mismatched)} шт.):\n  "
        + "\n  ".join(mismatched)
    )


def test_not_literal_exceptions_are_not_stale():
    """`NOT_LITERAL` описывает реальность, а не прошлое.

    Исключение, потерявшее предмет, тихо ослабляет проверку. Причин две:
    поля больше нет либо значение перестало быть длинным и в таблице теперь
    обычный литерал — в обоих случаях запись пора убрать.
    """
    defaults = _model_defaults()
    rows = _registry_rows()

    stale = sorted(set(NOT_LITERAL) - set(defaults))
    assert not stale, (
        f"NOT_LITERAL перечисляет поля, которых в моделях больше нет: {stale}"
    )

    now_literal = sorted(
        name for name in NOT_LITERAL
        if name in rows and _doc_literal(rows[name][0]) == _render(defaults[name])
    )
    assert not now_literal, (
        "NOT_LITERAL перечисляет переменные, у которых в реестре уже стоит "
        f"точный дефолт — убери записи, чтобы значение проверялось: {now_literal}"
    )
