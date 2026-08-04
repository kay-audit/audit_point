"""Ratchet бюджета соединений: DI не должен удерживать соединения БД.

Holder — функция, где ``async with get_db()`` содержит ``yield`` внутри блока:
соединение живёт всё время жизни зависимости (весь HTTP-запрос). Целевое
состояние — ноль holder'ов, закреплено навсегда: миграция на исполнитель
(`app/db/executor.py`, ветка connection-per-operation) завершена, любой найденный
holder — регрессия, а не временный снимок.
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


def _collect_holders() -> set[str]:
    holders: set[str] = set()
    for py in sorted(APP.rglob("*.py")):
        src = py.read_text(encoding="utf-8")
        if "get_db()" not in src:
            continue
        rel = py.relative_to(APP.parent).as_posix()
        if rel in EXCLUDED_MODULES:
            continue
        for node in ast.walk(ast.parse(src)):
            if not isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)):
                continue
            for w in ast.walk(node):
                if not isinstance(w, ast.AsyncWith):
                    continue
                head = " ".join(
                    ast.get_source_segment(src, item.context_expr) or ""
                    for item in w.items
                )
                if "get_db()" not in head:
                    continue
                if any(isinstance(n, (ast.Yield, ast.YieldFrom)) for n in ast.walk(w)):
                    holders.add(f"{rel}::{node.name}")
    return holders


def test_di_holds_no_connections():
    holders = _collect_holders()
    assert holders == set(), (
        "DI-слой снова удерживает соединения (yield внутри get_db): "
        f"{sorted(holders)}. Используйте get_executor() — см. app/db/executor.py."
    )
