"""
Seed-данные для Playwright E2E.

Создаёт 3 акта минимально-валидной структуры в БД через asyncpg:
- ID 999001: процессная проверка, дерево из 5 пустых секций
- ID 999002: непроцессная проверка, дерево с тестовой таблицей и текстблоком
- ID 999003: процессная проверка, второй вариант для cross-tab сценария

Используется в `global-setup.ts` через subprocess.

Идемпотентен: перед INSERT удаляет существующие записи с теми же id
(каскад очистит дочерние таблицы).

Параметры подключения берутся из .env через переменные окружения
DATABASE__HOST / __PORT / __USER / __PASSWORD / __NAME (уже выставлены
самим uvicorn-процессом, тут читаем явно через os.environ).
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

import asyncpg


SEED_USER = os.environ.get("E2E_SEED_USERNAME", "22494524")
PREFIX = os.environ.get("DATABASE__TABLE_PREFIX", "t_db_oarb_audit_act_")

# Фиксированные ID seed-актов — используются в фикстурах Playwright.
SEED_ACT_IDS = [999001, 999002, 999003]


def _build_default_tree(label: str) -> dict:
    """5 защищённых секций + обязательный пункт Process Mining — копия логики
    `StateCore._createProtectedSection` / `_createProcessMiningSection`."""
    sections = [
        {"id": "1", "label": "Информация о процессе, клиентском пути"},
        {"id": "2", "label": "Оценка качества проверенного процесса / сценария процесса / потока работ"},
        {"id": "3", "label": "Примененные технологии"},
        {"id": "4", "label": "Основные выводы"},
        {"id": "5", "label": "Результаты проверки"},
    ]
    children = [
        {
            "id": s["id"],
            "label": s["label"],
            "protected": True,
            "deletable": False,
            "children": [],
        }
        for s in sections
    ]
    children.append({
        "id": "6",
        "label": "Оценка процесса по результатам исследования методом Process Mining",
        "special": "process_mining",
        "protected": True,
        "deletable": False,
        "titleLocked": True,
        "children": [],
    })
    return {"id": "root", "label": label, "children": children}


def _build_tree_with_table_and_textblock(label: str) -> dict:
    """Дерево с одной таблицей и одним текстблоком в секции 2.

    Поля узлов согласованы с items-renderer.js (`node.type === 'table'/'textblock'`),
    tree-utils.js (TABLE/TEXTBLOCK константы) и API ответом `loadActContent`
    (`AppState.tables[node.tableId]`, `AppState.textBlocks[node.textBlockId]`).
    """
    tree = _build_default_tree(label)
    section2 = tree["children"][1]
    section2["children"] = [
        {
            "id": "2.1",
            "type": "item",
            "label": "Тестовый пункт",
            "deletable": True,
            "protected": False,
            "children": [
                {
                    "id": "tbl-seed-1",
                    "type": "table",
                    "label": "Таблица: тестовые данные",
                    "tableId": "tbl-seed-1",
                    "deletable": True,
                    "protected": False,
                    "children": [],
                },
                {
                    "id": "txt-seed-1",
                    "type": "textblock",
                    "label": "Текстовый блок: примечание",
                    "textBlockId": "txt-seed-1",
                    "deletable": True,
                    "protected": False,
                    "children": [],
                },
            ],
        }
    ]
    return tree


async def _delete_act_if_exists(conn: asyncpg.Connection, act_id: int) -> None:
    # CASCADE снесёт audit_team_members / act_tree / act_tables / act_textblocks / etc.
    await conn.execute(f"DELETE FROM {PREFIX}acts WHERE id = $1", act_id)


async def _insert_act(
    conn: asyncpg.Connection,
    act_id: int,
    km_digit: int,
    inspection_name: str,
    is_process_based: bool,
) -> None:
    # CHECK_km_number_format: ^КМ-\d{2}-\d{5}$
    # CHECK_km_number_digit_length: length(km_number_digit::text) = 7 (т.е. ровно 7 цифр)
    # → km_number_digit формируется как XX || XXXXX (7 цифр), km_number как КМ-XX-XXXXX.
    km_digit_str = f"{km_digit:07d}"
    km_number = f"КМ-{km_digit_str[:2]}-{km_digit_str[2:]}"
    await conn.execute(
        f"""
        INSERT INTO {PREFIX}acts (
            id, km_number, km_number_digit, part_number, total_parts,
            inspection_name, city, order_number, order_date,
            is_process_based, inspection_start_date, inspection_end_date,
            created_by
        ) VALUES (
            $1, $2, $3, 1, 1,
            $4, 'Москва', 'ORD-E2E-001', CURRENT_DATE,
            $5, CURRENT_DATE - INTERVAL '7 days', CURRENT_DATE,
            $6
        )
        """,
        act_id, km_number, km_digit,
        inspection_name, is_process_based, SEED_USER,
    )


async def _insert_tree(conn: asyncpg.Connection, act_id: int, tree: dict) -> None:
    await conn.execute(
        f"INSERT INTO {PREFIX}act_tree (act_id, tree_data) VALUES ($1, $2)",
        act_id, json.dumps(tree, ensure_ascii=False),
    )


async def _insert_team(conn: asyncpg.Connection, act_id: int) -> None:
    """Один член аудиторской группы — текущий тестовый пользователь как куратор."""
    await conn.execute(
        f"""
        INSERT INTO {PREFIX}audit_team_members
            (act_id, role, full_name, position, username, order_index)
        VALUES ($1, 'Куратор', 'E2E Тестовый Куратор', 'Аудитор', $2, 0)
        """,
        act_id, SEED_USER,
    )


async def _insert_table(conn: asyncpg.Connection, act_id: int) -> None:
    """Простая 2x2 таблица для table-cell-operations сценария.

    Формат ячеек согласован с items-renderer.js (`cellData.content`,
    `colSpan`/`rowSpan`/`isHeader`/`isSpanned`/`originRow`/`originCol`/`spanOrigin`).
    """
    def cell(content: str, is_header: bool = False) -> dict:
        return {
            "content": content,
            "colSpan": 1,
            "rowSpan": 1,
            "isHeader": is_header,
            "isSpanned": False,
            "originRow": None,
            "originCol": None,
            "spanOrigin": None,
        }

    grid = [
        [cell("Колонка A", True), cell("Колонка B", True)],
        [cell("Значение 1"), cell("Значение 2")],
    ]
    col_widths = [50, 50]
    await conn.execute(
        f"""
        INSERT INTO {PREFIX}act_tables
            (act_id, table_id, node_id, table_label, grid_data, col_widths)
        VALUES ($1, 'tbl-seed-1', 'tbl-seed-1', 'Таблица: тестовые данные',
                $2::jsonb, $3::jsonb)
        """,
        act_id, json.dumps(grid, ensure_ascii=False),
        json.dumps(col_widths),
    )


async def _insert_textblock(conn: asyncpg.Connection, act_id: int) -> None:
    """Простой текстблок для textblock-editing сценария."""
    await conn.execute(
        f"""
        INSERT INTO {PREFIX}act_textblocks
            (act_id, textblock_id, node_id, content)
        VALUES ($1, 'txt-seed-1', 'txt-seed-1', 'Исходный текст блока.')
        """,
        act_id,
    )


async def seed() -> None:
    dsn = (
        f"postgresql://{os.environ['DATABASE__USER']}:{os.environ['DATABASE__PASSWORD']}"
        f"@{os.environ['DATABASE__HOST']}:{os.environ['DATABASE__PORT']}"
        f"/{os.environ['DATABASE__NAME']}"
    )
    conn = await asyncpg.connect(dsn)
    try:
        # Чистим stale singleton-lock: если предыдущий uvicorn упал/был убит
        # taskkill-ом, lifespan-shutdown мог не успеть отпустить блокировку.
        # TTL=60s, но мы не хотим ждать его при последовательных прогонах.
        try:
            await conn.execute(f"DELETE FROM {PREFIX}app_singleton_lock")
        except asyncpg.UndefinedTableError:
            pass  # Таблица создаётся при первом старте — это норма.

        async with conn.transaction():
            for act_id in SEED_ACT_IDS:
                await _delete_act_if_exists(conn, act_id)

            # 999001 — пустое процессное дерево (для open-existing-act, tree-dnd).
            await _insert_act(conn, 999001, 9900001,
                              "E2E: процессная проверка (пустая)", True)
            await _insert_tree(conn, 999001, _build_default_tree(
                "E2E: процессная проверка (пустая)"))
            await _insert_team(conn, 999001)

            # 999002 — непроцессная с таблицей и текстблоком в секции 2
            # (для table/textblock/ctrl-s/edit-item-title сценариев).
            await _insert_act(conn, 999002, 9900002,
                              "E2E: непроцессная с таблицей", False)
            tree2 = _build_tree_with_table_and_textblock(
                "E2E: непроцессная с таблицей")
            await _insert_tree(conn, 999002, tree2)
            await _insert_team(conn, 999002)
            await _insert_table(conn, 999002)
            await _insert_textblock(conn, 999002)

            # 999003 — второй акт для cross-tab сценария (удаляем его в тесте).
            await _insert_act(conn, 999003, 9900003,
                              "E2E: акт для cross-tab удаления", True)
            await _insert_tree(conn, 999003, _build_default_tree(
                "E2E: акт для cross-tab удаления"))
            await _insert_team(conn, 999003)
    finally:
        await conn.close()


if __name__ == "__main__":
    try:
        asyncio.run(seed())
        print("SEED_OK")
    except Exception as e:  # noqa: BLE001
        print(f"SEED_FAILED: {e}", file=sys.stderr)
        raise
