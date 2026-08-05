"""Ratchet бюджета соединений: DI не должен удерживать соединения БД.

Holder — функция, где ``async with get_db()`` содержит ``yield`` внутри блока:
соединение живёт всё время жизни зависимости (весь HTTP-запрос). Целевое
состояние — ноль holder'ов, закреплено навсегда: миграция на исполнитель
(`app/db/executor.py`, ветка connection-per-operation) завершена, любой найденный
holder — регрессия, а не временный снимок.

Зона покрытия — ЧЕСТНО ограничена. Этот ratchet ловит только инвариант 3
(DI-слой не держит соединений) и только его частный случай — ``yield`` внутри
``async with get_db()``/её алиасов. Инварианты 1 (соединение не держится на
время await'ов сети/LLM/файлов) и 2 (внутри явной транзакции нет новых
захватов пула) он НЕ проверяет вовсе — их страхуют только runtime-страж
повторного захвата (``DATABASE__STRICT_ACQUIRE_GUARD``, см.
``app/db/connection.py::get_db``) и код-ревью. AST-обход резолвит алиасы
импорта ``get_db`` (``import ... as``, атрибут модуля), поэтому переименование
импорта не выключает ratchet — но семантически другой способ удержать
соединение (например, сохранить его в атрибут объекта вне ``async with``)
всё ещё вне зоны видимости этого теста.
"""

import ast
import pathlib

APP = pathlib.Path(__file__).resolve().parent.parent / "app"

# Сам исполнитель — единственное легальное место, где соединение живёт дольше
# одного вызова: ``DbExecutor.transaction()`` удерживает его на время явной
# транзакции, что инвариант 1 прямо разрешает. Ratchet следит за DI и доменами,
# поэтому модуль исполнителя из обхода исключён — иначе целевое состояние
# «holder'ов ноль» недостижимо в принципе.
EXCLUDED_MODULES = {"app/db/executor.py"}


def _resolve_get_db_names(tree: ast.Module) -> tuple[set[str], set[str]]:
    """Резолвит алиасы ``get_db`` в AST модуля.

    Возвращает пару множеств:

    - ``direct_names`` — имена, вызов которых напрямую означает ``get_db()``
      (``get_db`` по умолчанию + ``from app.db.connection import get_db as X``);
    - ``module_names`` — имена модуля, атрибут ``.get_db`` которого означает
      то же самое (``from app.db import connection [as X]`` →
      ``connection.get_db()`` / ``X.get_db()``, ``import app.db.connection as X``
      → ``X.get_db()``).

    Не резолвит неалиасированный ``import app.db.connection`` (обращение шло
    бы через ``app.db.connection.get_db()`` — трёхуровневая цепочка атрибутов,
    в проекте не встречается и здесь намеренно не поддержана).
    """
    direct_names = {"get_db"}
    module_names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if node.module == "app.db.connection":
                for alias in node.names:
                    if alias.name == "get_db":
                        direct_names.add(alias.asname or alias.name)
            elif node.module == "app.db":
                for alias in node.names:
                    if alias.name == "connection":
                        module_names.add(alias.asname or alias.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "app.db.connection" and alias.asname:
                    module_names.add(alias.asname)
    return direct_names, module_names


def _is_get_db_call(expr: ast.expr, direct_names: set[str], module_names: set[str]) -> bool:
    """True, если ``expr`` — вызов ``get_db()`` под одним из известных имён."""
    if not isinstance(expr, ast.Call):
        return False
    func = expr.func
    if isinstance(func, ast.Name):
        return func.id in direct_names
    if isinstance(func, ast.Attribute):
        return (
            func.attr == "get_db"
            and isinstance(func.value, ast.Name)
            and func.value.id in module_names
        )
    return False


def _collect_holders_in_source(src: str, rel: str) -> set[str]:
    """Находит holder'ы в исходнике одного модуля.

    Вынесена из ``_collect_holders`` отдельной функцией, принимающей текст
    и относительный путь, — чтобы детектор был тестируем напрямую, без
    похода в файловую систему (см. ``test_collect_holders_*`` ниже).
    """
    holders: set[str] = set()
    if "get_db" not in src:
        return holders
    tree = ast.parse(src)
    direct_names, module_names = _resolve_get_db_names(tree)
    for node in ast.walk(tree):
        if not isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)):
            continue
        for w in ast.walk(node):
            if not isinstance(w, ast.AsyncWith):
                continue
            if not any(
                _is_get_db_call(item.context_expr, direct_names, module_names)
                for item in w.items
            ):
                continue
            if any(isinstance(n, (ast.Yield, ast.YieldFrom)) for n in ast.walk(w)):
                holders.add(f"{rel}::{node.name}")
    return holders


def _collect_holders() -> set[str]:
    holders: set[str] = set()
    for py in sorted(APP.rglob("*.py")):
        rel = py.relative_to(APP.parent).as_posix()
        if rel in EXCLUDED_MODULES:
            continue
        src = py.read_text(encoding="utf-8")
        holders |= _collect_holders_in_source(src, rel)
    return holders


def test_di_holds_no_connections():
    """Ratchet: ноль holder'ов в ``app/`` (кроме ``app/db/executor.py``).

    Ловит только инвариант 3 — см. docstring модуля про то, что тест
    НЕ проверяет (инварианты 1-2).
    """
    holders = _collect_holders()
    assert holders == set(), (
        "DI-слой снова удерживает соединения (yield внутри get_db): "
        f"{sorted(holders)}. Используйте get_executor() — см. app/db/executor.py."
    )


# ── Тесты на сам детектор ────────────────────────────────────────────────────
#
# Проверяют, что _collect_holders_in_source не слепнет от переименованного
# импорта get_db — раньше обход искал литеральную подстроку "get_db()" в
# исходнике async-with, и `from app.db.connection import get_db as _db`
# оставался незамеченным.


def test_collect_holders_detects_plain_get_db():
    """Базовый случай (регрессия): ``get_db()`` без алиаса ловится."""
    src = (
        "from app.db.connection import get_db\n\n"
        "async def handler():\n"
        "    async with get_db() as conn:\n"
        "        yield conn\n"
    )
    holders = _collect_holders_in_source(src, "app/fake_di.py")
    assert holders == {"app/fake_di.py::handler"}


def test_collect_holders_detects_aliased_direct_import():
    """``from app.db.connection import get_db as _db`` + вызов ``_db()``."""
    src = (
        "from app.db.connection import get_db as _db\n\n"
        "async def handler():\n"
        "    async with _db() as conn:\n"
        "        yield conn\n"
    )
    holders = _collect_holders_in_source(src, "app/fake_di.py")
    assert holders == {"app/fake_di.py::handler"}


def test_collect_holders_detects_module_attribute_call():
    """``from app.db import connection`` + вызов ``connection.get_db()``."""
    src = (
        "from app.db import connection\n\n"
        "async def handler():\n"
        "    async with connection.get_db() as conn:\n"
        "        yield conn\n"
    )
    holders = _collect_holders_in_source(src, "app/fake_di.py")
    assert holders == {"app/fake_di.py::handler"}


def test_collect_holders_detects_aliased_module_import():
    """``import app.db.connection as dbconn`` + вызов ``dbconn.get_db()``."""
    src = (
        "import app.db.connection as dbconn\n\n"
        "async def handler():\n"
        "    async with dbconn.get_db() as conn:\n"
        "        yield conn\n"
    )
    holders = _collect_holders_in_source(src, "app/fake_di.py")
    assert holders == {"app/fake_di.py::handler"}


def test_collect_holders_ignores_call_without_yield():
    """Захват на время одного вызова (без yield внутри блока) — не holder."""
    src = (
        "from app.db.connection import get_db as _db\n\n"
        "async def handler():\n"
        "    async with _db() as conn:\n"
        "        await conn.fetchval('SELECT 1')\n"
    )
    holders = _collect_holders_in_source(src, "app/fake_di.py")
    assert holders == set()
