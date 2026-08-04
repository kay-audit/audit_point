"""Ratchet бюджета соединений: DI не должен удерживать соединения БД.

Holder — функция, где ``async with get_db()`` содержит ``yield`` внутри блока:
соединение живёт всё время жизни зависимости (весь HTTP-запрос). Целевое
состояние — ноль holder'ов; на время миграции существующие перечислены в
ALLOWLIST и только убываются (равенство ниже не даёт ни добавить нового,
ни забыть вычеркнуть переведённого).
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

# Снимок состояния на 2026-08-04 (начало ветки connection-per-operation).
# Фазы 1-3 вычёркивают переведённые фабрики; Task 4.1 удаляет список и
# заменяет ассерт на ``holders == set()``.
#
# Вложенные фабрики в ``_lifecycle.py`` дают несколько записей на одну
# конструкцию: ``ast.walk`` обходит и вложенные def'ы, поэтому holder'ом
# считается каждая охватывающая функция (``register_factories`` →
# ``_user_directory_factory`` → ``_gen``). Переход фабрики на исполнитель
# снимает всю цепочку разом.
ALLOWLIST = {
    "app/domains/chat/deps.py::get_conversation_service",
    "app/domains/chat/deps.py::get_message_service",
    "app/domains/chat/deps.py::get_file_service",
    "app/domains/chat/deps.py::get_feedback_service",
    "app/domains/chat/deps.py::get_analytics_service",
    "app/domains/chat/deps.py::get_agent_channel_service",
    "app/domains/chat/deps.py::get_tool_metrics_repository",
    "app/domains/chat/deps.py::get_audit_service",
    "app/domains/acts/deps.py::get_crud_service",
    "app/domains/acts/deps.py::get_lock_service",
    "app/domains/acts/deps.py::get_content_service",
    "app/domains/acts/deps.py::get_invoice_service",
    "app/domains/acts/deps.py::get_editor_telemetry_repo",
    "app/domains/acts/deps.py::get_audit_log_deps",
    "app/domains/acts/deps.py::get_audit_log_service",
    "app/domains/admin/deps.py::get_admin_service",
    "app/domains/admin/_lifecycle.py::register_factories",
    "app/domains/admin/_lifecycle.py::_user_directory_factory",
    "app/domains/admin/_lifecycle.py::_user_avatars_factory",
    "app/domains/admin/_lifecycle.py::_gen",
    "app/domains/notifications/_lifecycle.py::register_factories",
    "app/domains/notifications/_lifecycle.py::_push_factory",
    "app/domains/notifications/_lifecycle.py::_gen",
    "app/domains/notifications/deps.py::get_notification_service",
    "app/domains/ck_client_exp/deps.py::get_cs_validation_service",
    "app/domains/ck_fin_res/deps.py::get_fr_validation_service",
    "app/domains/ua_data/deps.py::get_dictionary_service",
}


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
    assert holders == ALLOWLIST, (
        "Изменился состав функций, удерживающих соединение через "
        f"yield-внутри-get_db.\nНовые (запрещено): {sorted(holders - ALLOWLIST)}\n"
        f"Переведённые (вычеркни из ALLOWLIST): {sorted(ALLOWLIST - holders)}"
    )
