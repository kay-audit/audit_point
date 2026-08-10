"""Согласованность метаданных приложения (название и версия).

Единственный источник — ``__title__`` и ``__version__`` в ``app/__init__.py``.
Тест ловит типовые промахи бампа: разъехавшиеся значения в коде, невалидный
SemVer, забытую запись в CHANGELOG и метаданные, запиненные в шаблонах ``.env``.
"""

import re
from pathlib import Path

import pytest

import app
from app.core.config import Settings

SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")
CHANGELOG = Path(app.__file__).resolve().parent.parent / "CHANGELOG.md"


@pytest.fixture(scope="module")
def changelog_text() -> str:
    return CHANGELOG.read_text(encoding="utf-8")


def test_version_is_semver():
    """Версия — строго X.Y.Z, без пре-релизных суффиксов и билд-метаданных."""
    assert SEMVER_RE.match(app.__version__), (
        f"__version__ = {app.__version__!r} — ожидался SemVer вида 14.0.1"
    )


def test_settings_metadata_comes_from_package():
    """Дефолты Settings не задаются отдельными литералами."""
    # Смотрим дефолты полей, чтобы .env с override'ом на них не влиял.
    assert Settings.model_fields["app_version"].default == app.__version__
    assert Settings.model_fields["app_title"].default == app.__title__


def test_changelog_declares_current_version(changelog_text):
    """Шапка CHANGELOG объявляет ту же версию, что и код."""
    match = re.search(r"\*\*Текущая версия: `([^`]+)`", changelog_text)
    assert match, "в CHANGELOG.md не найдена строка «Текущая версия: `X.Y.Z`»"
    assert match.group(1) == app.__version__, (
        f"CHANGELOG объявляет {match.group(1)}, а код — {app.__version__}"
    )


def test_changelog_has_entry_for_current_version(changelog_text):
    """У текущей версии есть запись — раздел `## X.Y.Z` или строка `- X.Y.Z ·`."""
    version = re.escape(app.__version__)
    has_entry = re.search(rf"^(##\s+{version}\s|-\s+{version}\s)", changelog_text, re.M)
    assert has_entry, (
        f"в CHANGELOG.md нет записи о версии {app.__version__}: "
        "добавьте раздел «## X.Y.Z» (MAJOR/MINOR) или строку «- X.Y.Z · `hash` — PATCH: …»"
    )


@pytest.mark.parametrize("var", ["APP_TITLE", "APP_VERSION"])
def test_env_templates_do_not_pin_metadata(var):
    """В шаблонах .env метаданные не задаются — иначе релиз не сбросит кэш статики."""
    root = CHANGELOG.parent
    for name in (".env.dev", ".env.prod"):
        lines = (root / name).read_text(encoding="utf-8").splitlines()
        pinned = [ln for ln in lines if ln.strip().startswith(f"{var}=")]
        assert not pinned, (
            f"{name}: {var} задан явно ({pinned[0]!r}). Метаданные меняются "
            "централизованно в app/__init__.py; в шаблоне строка должна быть закомментирована"
        )
