"""Страж синхронности шаблонов окружения `.env.dev` ↔ `.env.prod` ↔ моделей.

Правило проекта: оба шаблона обновляются синхронно, и там, где параметр
конкретному окружению не нужен, он присутствует **закомментированным**, а не
отсутствует — иначе при переносе конфигурации ручку просто не замечают. До сих
пор правило держалось на внимательности: так разъехались `.env.dev` и
`.env.prod`, а подсистема `CHAT__TEXT_ACTIONS__*` не попала ни в один шаблон.

Ожидаемый список переменных строится ИЗ МОДЕЛЕЙ, а не хардкодится: корневой
``Settings`` плюс доменные классы, попадающие в ``settings_registry`` побочным
эффектом ``discover_domains``. Поэтому новое поле настроек автоматически
становится требованием к обоим шаблонам.

Живой `.env` не проверяется: он в `.gitignore`, в CI его нет.
"""

from pathlib import Path
from typing import Union, get_args, get_origin

import pytest
from pydantic import BaseModel

from app.core import settings_registry
from app.core.chat.tools import reset as reset_tools
from app.core.config import Settings
from app.core.domain_registry import discover_domains, reset_registry

ROOT = Path(__file__).resolve().parent.parent
TEMPLATES = (".env.dev", ".env.prod")

# --- Исключения -----------------------------------------------------------
# Поля моделей, которым не место в шаблонах. Список ЯВНЫЙ и короткий: каждая
# запись — сознательное решение, а не способ погасить упавший тест.
NOT_IN_TEMPLATES = {
    "ACTS__SANITIZER__ALLOWED_TAGS":
        "белый список тегов санитайзера — меняется только вместе с его кодом",
    "ACTS__SANITIZER__ALLOWED_CSS_PROPERTIES":
        "то же: часть контракта санитайзера, а не ручка окружения",
    "ACTS__SANITIZER__ALLOWED_DATA_ATTRS":
        "то же: часть контракта санитайзера, а не ручка окружения",
    "ACTS__IMAGES__ALLOWED_MIME_TYPES":
        "список MIME согласован с фронтом и валидацией — по окружениям не расходится",
    "CHAT__ALLOWED_MIME_TYPES":
        "список MIME согласован с фронтом и валидацией — по окружениям не расходится",
    "CHAT__FALLBACK_EXTRA_HEADERS":
        "dict: задаётся JSON'ом под конкретный прокси, дефолт пустой",
    "SECURITY__CSP_POLICY":
        "длинная политика с обязательным плейсхолдером {nonce} — правится в коде",
    "SECURITY__PERMISSIONS_POLICY":
        "длинная строка директив, по окружениям не различается",
}

# Переменные, которые в шаблонах есть законно, хотя поля настроек под них нет.
NOT_IN_MODELS = {
    "LOG_FORMAT":
        "читается напрямую через os.getenv в app/core/logging.py, минуя Settings",
}


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


# --- Сбор ожидаемых имён --------------------------------------------------

def _nested_model(annotation) -> type[BaseModel] | None:
    """Вложенная модель настроек из аннотации поля (в т.ч. под Optional)."""
    candidates = (
        get_args(annotation) if get_origin(annotation) is Union else (annotation,)
    )
    for candidate in candidates:
        if isinstance(candidate, type) and issubclass(candidate, BaseModel):
            return candidate
    return None


def _expand(model: type[BaseModel], prefix: str = "") -> set[str]:
    """Имена переменных окружения для полей модели.

    Вложенные ``BaseModel`` дают префикс через ``__`` (как pydantic-settings).
    Имя строится по ``alias``, если он задан: у ``schema_name`` алиас
    ``schema`` (само слово занято Python'ом), и в окружении живёт `…__SCHEMA`.
    """
    names: set[str] = set()
    for field_name, field_info in model.model_fields.items():
        key = f"{prefix}{(field_info.alias or field_name).upper()}"
        nested = _nested_model(field_info.annotation)
        if nested is not None:
            names |= _expand(nested, f"{key}__")
        else:
            names.add(key)
    return names


def _expected_vars() -> set[str]:
    """Полный набор имён из корневых и доменных настроек."""
    discover_domains(ROOT / "app" / "domains")
    domains = dict(settings_registry._registry)
    assert {"acts", "chat"} <= set(domains), (
        "реестр доменных настроек пуст или неполон — тест выродился бы в "
        f"проверку одних только корневых Settings; в реестре: {sorted(domains)}"
    )

    names = _expand(Settings)
    for domain_name, instance in domains.items():
        names |= _expand(type(instance), f"{domain_name.upper()}__")
    return names


# --- Разбор шаблонов ------------------------------------------------------

def _parse(template: str) -> dict[str, tuple[str, int, bool]]:
    """``{ИМЯ: (значение, номер строки, закомментирована ли)}``.

    Строка вида ``# КЛЮЧ=значение`` считается присутствующей: правило проекта
    требует держать неиспользуемый параметр закомментированным, а не удалять.
    """
    found: dict[str, tuple[str, int, bool]] = {}
    path = ROOT / template
    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        commented = line.startswith("#")
        if commented:
            line = line.lstrip("#").strip()
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        # Отсекаем прозаические комментарии, где случайно встретился "=".
        if not key or not key.replace("_", "").isalnum() or key.upper() != key:
            continue
        found[key] = (value.strip(), lineno, commented)
    return found


# --- Тесты ----------------------------------------------------------------

@pytest.mark.parametrize("template", TEMPLATES)
def test_all_settings_present_in_template(template):
    """Каждое поле настроек отражено в шаблоне — хотя бы закомментированным."""
    expected = _expected_vars() - set(NOT_IN_TEMPLATES)
    missing = sorted(expected - set(_parse(template)))
    assert not missing, (
        f"{template}: нет переменных, которые есть в моделях настроек "
        f"({len(missing)} шт.). Добавь их значением или закомментированной "
        f"строкой:\n  " + "\n  ".join(missing)
    )


@pytest.mark.parametrize("template", TEMPLATES)
def test_no_orphan_vars_in_template(template):
    """В шаблоне нет переменных, под которые не осталось поля настроек.

    Так в файлах пережили удаление полей ``MAX_IMAGE_SIZE_MB`` и
    ``DOCX_CAPTION_FONT_SIZE``: их правили, ничего не меняя.
    """
    known = _expected_vars() | set(NOT_IN_MODELS)
    orphans = sorted(set(_parse(template)) - known)
    assert not orphans, (
        f"{template}: переменные не соответствуют ни одному полю настроек — "
        f"мусор от удалённых полей либо опечатка:\n  " + "\n  ".join(orphans)
    )


def test_templates_declare_same_vars():
    """Наборы имён в двух шаблонах совпадают."""
    dev, prod = (set(_parse(name)) for name in TEMPLATES)
    only_dev = sorted(dev - prod)
    only_prod = sorted(prod - dev)
    assert not only_dev and not only_prod, (
        "шаблоны разъехались:\n"
        f"  только в .env.dev: {only_dev}\n"
        f"  только в .env.prod: {only_prod}"
    )


@pytest.mark.parametrize("template", TEMPLATES)
def test_no_value_starts_with_hash(template):
    """``КЛЮЧ= # пояснение`` — значение ``# пояснение``, а не пустая строка.

    python-dotenv отрезает инлайн-комментарий только после непустого значения.
    Именно так на ПРОМе SMTP-пароль уезжал в логин литералом. Проверяем только
    активные строки: у закомментированной параметра в окружении нет вовсе.
    """
    broken = [
        f"строка {lineno}: {key}={value}"
        for key, (value, lineno, commented) in _parse(template).items()
        if not commented and value.startswith("#")
    ]
    assert not broken, (
        f"{template}: значение начинается с '#' — dotenv прочитает комментарий "
        f"как значение. Оставь пустое значение или закомментируй строку "
        f"целиком:\n  " + "\n  ".join(broken)
    )


def test_exceptions_are_not_stale():
    """Списки исключений описывают реальность, а не прошлое.

    Исключение, потерявшее предмет, тихо ослабляет проверку — ловим сразу.
    """
    expected = _expected_vars()
    stale = sorted(set(NOT_IN_TEMPLATES) - expected)
    assert not stale, (
        "NOT_IN_TEMPLATES перечисляет поля, которых в моделях больше нет — "
        f"удали записи: {stale}"
    )

    in_templates = set().union(*(set(_parse(name)) for name in TEMPLATES))
    unused = sorted(set(NOT_IN_MODELS) - in_templates)
    assert not unused, (
        "NOT_IN_MODELS перечисляет переменные, которых в шаблонах уже нет — "
        f"удали записи: {unused}"
    )
