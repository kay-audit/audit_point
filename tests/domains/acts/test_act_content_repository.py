"""
Тесты репозитория содержимого актов.

2.3.2: executemany в рамках транзакции save_content.
"""
import json
from unittest.mock import AsyncMock, MagicMock, patch, call

import pytest

from app.domains.acts.repositories.act_content import ActContentRepository
from app.domains.acts.violation_fields import VIOLATION_FIELD_KEYS


@pytest.fixture(autouse=True)
def _patch_adapter(mock_adapter):
    with patch("app.db.repositories.base.get_adapter", return_value=mock_adapter):
        yield


def _make_act_data(tables=None, textblocks=None, violations=None):
    """Минимальная заглушка ActDataSchema."""
    data = MagicMock()
    data.tree = {"id": "root", "label": "Акт", "children": []}
    data.tables = tables or {}
    data.textBlocks = textblocks or {}
    data.violations = violations or {}
    data.invoiceNodeIds = []
    return data


class TestSaveContentUsesTransaction:
    """save_content работает в транзакции ВЫЗЫВАЮЩЕГО сервиса (§9 зона 4).

    Репозиторий собственную транзакцию НЕ открывает: плоскую транзакцию
    вокруг контента + diff + аудит-лога + снимка версии держит
    ActContentService.save_content (вложенный conn.transaction() в asyncpg
    создал бы SAVEPOINT — на Greenplum вложенность не используем).
    """

    async def test_repo_does_not_open_own_transaction(self, mock_conn):
        """Репозиторий не открывает собственную транзакцию (контракт)."""
        repo = ActContentRepository(mock_conn)
        mock_conn.fetchval.return_value = None   # audit_act_id
        mock_conn.fetch.return_value = []         # directives query

        data = _make_act_data()
        await repo.save_content(act_id=1, data=data, username="user1")

        mock_conn.transaction.assert_not_called()

    async def test_executemany_called_for_tables(self, mock_conn):
        """executemany для таблиц вызывается при сохранении."""
        repo = ActContentRepository(mock_conn)
        mock_conn.fetchval.return_value = None
        mock_conn.fetch.return_value = []

        # Добавляем одну таблицу в data
        table_data = MagicMock()
        table_data.nodeId = "node_1"
        table_data.grid = []
        table_data.colWidths = []
        table_data.protected = False
        table_data.deletable = True
        table_data.kind = "regular"

        data = _make_act_data(tables={"tbl_1": table_data})
        # Узел-владелец таблицы должен быть в дереве (иначе orphan-фильтр её срежет).
        data.tree = {
            "id": "root", "label": "Акт",
            "children": [{"id": "node_1", "label": "Таблица", "type": "table",
                          "tableId": "tbl_1", "children": []}],
        }
        await repo.save_content(act_id=1, data=data, username="user1")

        mock_conn.executemany.assert_called()
        # Первый аргумент вызова — SQL-строка для act_tables
        sql = mock_conn.executemany.call_args_list[0].args[0]
        assert "act_tables" in sql
        assert "INSERT INTO" in sql

    async def test_three_executemany_calls_on_full_data(self, mock_conn):
        """При наличии таблиц, текстблоков и нарушений вызывается 3 executemany."""
        repo = ActContentRepository(mock_conn)
        mock_conn.fetchval.return_value = None
        mock_conn.fetch.return_value = []

        # Таблица
        table_data = MagicMock()
        table_data.nodeId = "n1"
        table_data.grid = []
        table_data.colWidths = []
        table_data.protected = False
        table_data.deletable = True
        table_data.kind = "regular"

        # Текстблок
        tb_data = MagicMock()
        tb_data.nodeId = "n2"
        tb_data.content = "текст"

        # Нарушение (блочная модель: 10 полей-контейнеров + fieldOrder)
        v_data = MagicMock()
        v_data.nodeId = "n3"
        v_data.fieldOrder = None
        for attr in VIOLATION_FIELD_KEYS:
            m = MagicMock()
            m.model_dump.return_value = {"enabled": False, "blocks": []}
            setattr(v_data, attr, m)

        data = _make_act_data(
            tables={"tbl_1": table_data},
            textblocks={"tb_1": tb_data},
            violations={"v_1": v_data},
        )
        # Узлы-владельцы (n1/n2/n3) должны быть в дереве, иначе orphan-фильтр
        # отбросит записи и executemany для них не вызовется.
        data.tree = {
            "id": "root", "label": "Акт",
            "children": [
                {"id": "n1", "label": "Таблица", "type": "table",
                 "tableId": "tbl_1", "children": []},
                {"id": "n2", "label": "ТБ", "type": "textblock",
                 "textBlockId": "tb_1", "children": []},
                {"id": "n3", "label": "Нарушение", "type": "violation",
                 "violationId": "v_1", "children": []},
            ],
        }
        await repo.save_content(act_id=1, data=data, username="user1")

        assert mock_conn.executemany.call_count == 3

    async def test_no_executemany_on_empty_content(self, mock_conn):
        """executemany не вызывается если нет таблиц/текстблоков/нарушений."""
        repo = ActContentRepository(mock_conn)
        mock_conn.fetchval.return_value = None
        mock_conn.fetch.return_value = []

        data = _make_act_data()
        await repo.save_content(act_id=1, data=data, username="user1")

        mock_conn.executemany.assert_not_called()

    async def test_save_helpers_do_not_open_nested_transactions(self, mock_conn):
        """_save_tables/_save_textblocks/_save_violations не открывают транзакций.

        Любой conn.transaction() внутри save_content был бы вложенным
        относительно транзакции сервиса (= SAVEPOINT) — запрещено.
        """
        repo = ActContentRepository(mock_conn)
        mock_conn.fetchval.return_value = None
        mock_conn.fetch.return_value = []

        table_data = MagicMock()
        table_data.nodeId = "n1"
        table_data.grid = []
        table_data.colWidths = []
        table_data.protected = False
        table_data.deletable = True
        table_data.kind = "regular"

        data = _make_act_data(tables={"tbl_1": table_data})
        await repo.save_content(act_id=1, data=data, username="user1")

        # Ни одной собственной транзакции
        assert mock_conn.transaction.call_count == 0

    async def test_save_content_returns_updated_at(self, mock_conn):
        """save_content отдаёт фактический updated_at акта после сохранения.

        Фронт запоминает его как базу метаданных снимка-черновика
        localStorage (baseUpdatedAt) для восстановления черновика (H3).
        """
        import datetime as dt

        repo = ActContentRepository(mock_conn)
        updated_at = dt.datetime(2026, 6, 11, 10, 0, 0, 123456)
        # 1-й fetchval — audit_act_id, 2-й — SELECT updated_at после UPDATE
        mock_conn.fetchval.side_effect = [None, updated_at]
        mock_conn.fetch.return_value = []

        data = _make_act_data()
        result = await repo.save_content(act_id=1, data=data, username="user1")

        assert result["status"] == "success"
        assert result["updated_at"] == updated_at
        # SELECT updated_at идёт отдельным запросом (не RETURNING — Greenplum)
        select_sql = mock_conn.fetchval.call_args_list[-1].args[0]
        assert "updated_at" in select_sql
        assert "SELECT" in select_sql


class TestInsertTableDenormalizationAndKind:
    """insert_table сохраняет денормализацию (node_number/table_label) и подвид kind."""

    async def test_insert_table_includes_kind_and_denorm_columns(self, mock_conn):
        """SQL insert_table содержит колонки денормализации и kind."""
        repo = ActContentRepository(mock_conn)
        await repo.insert_table(
            act_id=1,
            table_id="t1",
            node_id="n1",
            grid_data=[],
            col_widths=[],
            is_protected=True,
            is_deletable=False,
            node_number="3.1",
            table_label="Оценка качества",
            kind="metrics",
        )
        sql = mock_conn.execute.call_args.args[0]
        for col in ("node_number", "table_label", "kind"):
            assert col in sql, f"insert_table SQL не содержит колонку {col}"

    async def test_insert_table_passes_denorm_and_kind_values(self, mock_conn):
        """Значения денормализации и kind стоят на правильных позициях execute.

        Сверяем КОНКРЕТНЫЕ индексы параметров $1..$10 — порядок зафиксирован
        INSERT-ом insert_table.
        """
        repo = ActContentRepository(mock_conn)
        await repo.insert_table(
            act_id=1,
            table_id="t1",
            node_id="n1",
            grid_data=[],
            col_widths=[],
            is_protected=False,
            is_deletable=True,
            node_number="3.1",
            table_label="Оценка качества",
            kind="regularRisk",
        )
        # args[0] — SQL-строка; позиционные параметры $1..$10 идут с args[1].
        args = mock_conn.execute.call_args.args
        assert args[1] == 1                  # $1  act_id
        assert args[2] == "t1"               # $2  table_id
        assert args[3] == "n1"               # $3  node_id
        assert args[4] == "3.1"              # $4  node_number
        assert args[5] == "Оценка качества"  # $5  table_label
        assert args[8] is False              # $8  is_protected
        assert args[9] is True               # $9  is_deletable
        assert args[10] == "regularRisk"     # $10 kind

    async def test_insert_table_defaults_kind_regular(self, mock_conn):
        """Без явного kind insert_table вставляет 'regular' (системная таблица)."""
        repo = ActContentRepository(mock_conn)
        await repo.insert_table(
            act_id=1,
            table_id="t1",
            node_id="n1",
            grid_data=[],
            col_widths=[],
            is_protected=True,
            is_deletable=False,
            table_label="Таблица",
        )
        # Не падает; SQL по-прежнему содержит колонку kind, значение — дефолт
        args = mock_conn.execute.call_args.args
        assert "kind" in args[0]
        assert args[10] == "regular"


class TestSaveTablesOrphanFilter:
    """_save_tables пропускает таблицы, чей nodeId отсутствует в дереве."""

    async def test_orphan_table_not_inserted(self, mock_conn):
        """Таблица с nodeId не из дерева не попадает в executemany."""
        repo = ActContentRepository(mock_conn)
        mock_conn.fetchval.return_value = None
        mock_conn.fetch.return_value = []

        # Таблица привязана к узлу, которого нет в дереве (root без детей).
        orphan = MagicMock()
        orphan.nodeId = "ghost"
        orphan.grid = []
        orphan.colWidths = []
        orphan.protected = False
        orphan.deletable = True
        orphan.kind = "regular"

        data = _make_act_data(tables={"orphan_tbl": orphan})
        result = await repo.save_content(act_id=1, data=data, username="user1")

        # Orphan не должен вставляться — executemany для таблиц не вызывается
        # (нет валидных таблиц).
        for c in mock_conn.executemany.call_args_list:
            sql = c.args[0]
            if "act_tables" in sql:
                pytest.fail("orphan-таблица попала в INSERT act_tables")
        # Репозиторий возвращает число отброшенных сирот (для warning'а сервиса).
        assert result["dropped_orphans"] == 1

    async def test_valid_table_inserted(self, mock_conn):
        """Таблица с nodeId, присутствующим в дереве, вставляется."""
        repo = ActContentRepository(mock_conn)
        mock_conn.fetchval.return_value = None
        mock_conn.fetch.return_value = []

        valid = MagicMock()
        valid.nodeId = "node_1"
        valid.grid = []
        valid.colWidths = []
        valid.protected = False
        valid.deletable = True
        valid.kind = "regular"

        data = _make_act_data(tables={"valid_tbl": valid})
        # Дерево содержит узел node_1
        data.tree = {
            "id": "root", "label": "Акт",
            "children": [{"id": "node_1", "label": "Таблица", "type": "table",
                          "tableId": "valid_tbl", "children": []}],
        }
        result = await repo.save_content(act_id=1, data=data, username="user1")

        table_inserts = [
            c for c in mock_conn.executemany.call_args_list
            if "act_tables" in c.args[0]
        ]
        assert table_inserts, "валидная таблица не вставлена"
        # Сирот нет — счётчик нулевой.
        assert result["dropped_orphans"] == 0


def _make_textblock(node_id: str) -> MagicMock:
    tb = MagicMock()
    tb.nodeId = node_id
    tb.content = "текст"
    return tb


def _make_violation(node_id: str) -> MagicMock:
    v = MagicMock()
    v.nodeId = node_id
    v.fieldOrder = None
    for attr in VIOLATION_FIELD_KEYS:
        m = MagicMock()
        m.model_dump.return_value = {"enabled": False, "blocks": []}
        setattr(v, attr, m)
    return v


class TestSaveTextblocksViolationsOrphanFilter:
    """pbe-4 / §6 п.11: orphan-фильтр единообразен для всех словарей.

    Записи textBlocks/violations, чей nodeId отсутствует в дереве,
    отбрасываются при сохранении — как уже сделано для tables.
    """

    _TREE_WITH_NODES = {
        "id": "root", "label": "Акт",
        "children": [
            {"id": "n_tb", "label": "ТБ", "type": "textblock",
             "textBlockId": "tb_ok", "children": []},
            {"id": "n_v", "label": "Нарушение", "type": "violation",
             "violationId": "v_ok", "children": []},
        ],
    }

    async def test_orphan_textblock_not_inserted(self, mock_conn):
        """Текстблок с nodeId не из дерева не попадает в INSERT."""
        repo = ActContentRepository(mock_conn)
        mock_conn.fetchval.return_value = None
        mock_conn.fetch.return_value = []

        data = _make_act_data(textblocks={"tb_ghost": _make_textblock("ghost")})
        result = await repo.save_content(act_id=1, data=data, username="user1")

        for c in mock_conn.executemany.call_args_list:
            if "act_textblocks" in c.args[0]:
                pytest.fail("orphan-текстблок попал в INSERT act_textblocks")
        assert result["dropped_orphans"] == 1

    async def test_orphan_violation_not_inserted(self, mock_conn):
        """Нарушение с nodeId не из дерева не попадает в INSERT."""
        repo = ActContentRepository(mock_conn)
        mock_conn.fetchval.return_value = None
        mock_conn.fetch.return_value = []

        data = _make_act_data(violations={"v_ghost": _make_violation("ghost")})
        result = await repo.save_content(act_id=1, data=data, username="user1")

        for c in mock_conn.executemany.call_args_list:
            if "act_violations" in c.args[0]:
                pytest.fail("orphan-нарушение попало в INSERT act_violations")
        assert result["dropped_orphans"] == 1

    async def test_valid_textblock_and_violation_inserted(self, mock_conn):
        """Записи с узлом-владельцем в дереве сохраняются (фильтр не сверх-агрессивен)."""
        repo = ActContentRepository(mock_conn)
        mock_conn.fetchval.return_value = None
        mock_conn.fetch.return_value = []

        data = _make_act_data(
            textblocks={"tb_ok": _make_textblock("n_tb")},
            violations={"v_ok": _make_violation("n_v")},
        )
        data.tree = dict(self._TREE_WITH_NODES)
        await repo.save_content(act_id=1, data=data, username="user1")

        sqls = [c.args[0] for c in mock_conn.executemany.call_args_list]
        assert any("act_textblocks" in s for s in sqls), "валидный текстблок не вставлен"
        assert any("act_violations" in s for s in sqls), "валидное нарушение не вставлено"

    async def test_mixed_orphans_dropped_valid_kept(self, mock_conn):
        """Смешанный словарь: orphan отброшен, валидная запись вставлена."""
        repo = ActContentRepository(mock_conn)
        mock_conn.fetchval.return_value = None
        mock_conn.fetch.return_value = []

        data = _make_act_data(
            textblocks={
                "tb_ok": _make_textblock("n_tb"),
                "tb_ghost": _make_textblock("ghost"),
            },
        )
        data.tree = dict(self._TREE_WITH_NODES)
        await repo.save_content(act_id=1, data=data, username="user1")

        tb_inserts = [
            c for c in mock_conn.executemany.call_args_list
            if "act_textblocks" in c.args[0]
        ]
        assert len(tb_inserts) == 1
        rows = tb_inserts[0].args[1]
        # Вставлена ровно одна запись — валидная
        assert len(rows) == 1
        assert rows[0][3] == "tb_ok"  # $4 — textblock_id


class TestSaveOrphanFilterReverseRef:
    """Находка #21: orphan-фильтр сверяет ОБРАТНУЮ ссылку узла (не только

    существование узла с таким nodeId). Запись, чей nodeId указывает на
    существующий узел, который в реальности ссылается на ДРУГУЮ запись
    словаря (или не ссылается вовсе) — фантом, отбрасывается так же, как
    обычный orphan.
    """

    _TREE_ONE_TABLE = {
        "id": "root", "label": "Акт",
        "children": [
            {"id": "n1", "label": "Таблица", "type": "table",
             "tableId": "t1", "children": []},
        ],
    }

    async def test_stale_table_nodeid_points_to_node_referencing_other_table(self, mock_conn):
        """t_stale.nodeId='n1', но n1.tableId фактически 't1' — t_stale фантом."""
        repo = ActContentRepository(mock_conn)
        mock_conn.fetchval.return_value = None
        mock_conn.fetch.return_value = []

        valid = MagicMock()
        valid.nodeId = "n1"
        valid.grid = []
        valid.colWidths = []
        valid.protected = False
        valid.deletable = True
        valid.kind = "regular"

        stale = MagicMock()
        stale.nodeId = "n1"  # существующий узел, но он ссылается на "t1", не "t_stale"
        stale.grid = []
        stale.colWidths = []
        stale.protected = False
        stale.deletable = True
        stale.kind = "regular"

        data = _make_act_data(tables={"t1": valid, "t_stale": stale})
        data.tree = dict(self._TREE_ONE_TABLE)
        result = await repo.save_content(act_id=1, data=data, username="user1")

        table_inserts = [
            c for c in mock_conn.executemany.call_args_list
            if "act_tables" in c.args[0]
        ]
        assert len(table_inserts) == 1
        rows = table_inserts[0].args[1]
        assert len(rows) == 1
        assert rows[0][3] == "t1"  # $4 — table_id, только валидная запись
        assert result["dropped_orphans"] == 1

    async def test_stale_textblock_and_violation_dropped_by_reverse_ref(self, mock_conn):
        """Аналогично для textBlocks/violations — единый generic-фильтр."""
        repo = ActContentRepository(mock_conn)
        mock_conn.fetchval.return_value = None
        mock_conn.fetch.return_value = []

        tree = {
            "id": "root", "label": "Акт",
            "children": [
                {"id": "n_tb", "label": "ТБ", "type": "textblock",
                 "textBlockId": "tb_ok", "children": []},
                {"id": "n_v", "label": "Нарушение", "type": "violation",
                 "violationId": "v_ok", "children": []},
            ],
        }

        data = _make_act_data(
            textblocks={
                "tb_ok": _make_textblock("n_tb"),
                "tb_stale": _make_textblock("n_tb"),  # n_tb ссылается на tb_ok, не tb_stale
            },
            violations={
                "v_ok": _make_violation("n_v"),
                "v_stale": _make_violation("n_v"),
            },
        )
        data.tree = tree
        result = await repo.save_content(act_id=1, data=data, username="user1")

        tb_inserts = [
            c for c in mock_conn.executemany.call_args_list
            if "act_textblocks" in c.args[0]
        ]
        v_inserts = [
            c for c in mock_conn.executemany.call_args_list
            if "act_violations" in c.args[0]
        ]
        assert len(tb_inserts) == 1 and len(tb_inserts[0].args[1]) == 1
        assert tb_inserts[0].args[1][0][3] == "tb_ok"
        assert len(v_inserts) == 1 and len(v_inserts[0].args[1]) == 1
        assert v_inserts[0].args[1][0][3] == "v_ok"
        assert result["dropped_orphans"] == 2


class TestSaveOrphanFilterHealsStaleNodeId:
    """Ревью-находка №1: «restore версии теряет таблицу с устаревшим nodeId».

    Старый фильтр дропал запись, если entry.nodeId не находился в дереве —
    ДАЖЕ когда её реально держит живой узел (условие было AND, а не лечение).
    restore_version (audit_log_service.py) собирает акт из снимка БД и пишет
    через репозиторий напрямую, минуя фронтовый санитайзер, который для
    этого же случая уже лечит (не дропает) — поэтому именно путь restore
    терял таблицу/нарушение целиком.

    Новая политика (_resolve_owner_node_id): сиротой считается запись БЕЗ
    единого реферера; если реферер есть, но entry.nodeId ему не равен —
    nodeId лечится на реферера (первого в документном порядке, если их
    несколько), а не дропается.
    """

    async def test_dead_nodeid_with_live_referrer_heals_not_drops(self, mock_conn):
        """a) nodeId не существует в дереве, но живой узел реально ссылается
        на запись — запись СОХРАНЯЕТСЯ, nodeId лечится на id реферера."""
        repo = ActContentRepository(mock_conn)
        mock_conn.fetchval.return_value = None
        mock_conn.fetch.return_value = []

        stale = MagicMock()
        stale.nodeId = "ghost"  # такого узла в дереве нет вовсе
        stale.grid = []
        stale.colWidths = []
        stale.protected = False
        stale.deletable = True
        stale.kind = "regular"

        data = _make_act_data(tables={"t1": stale})
        data.tree = {
            "id": "root", "label": "Акт",
            "children": [{"id": "n1", "label": "Таблица", "type": "table",
                          "tableId": "t1", "children": []}],
        }
        result = await repo.save_content(act_id=1, data=data, username="user1")

        table_inserts = [
            c for c in mock_conn.executemany.call_args_list
            if "act_tables" in c.args[0]
        ]
        assert len(table_inserts) == 1
        rows = table_inserts[0].args[1]
        assert len(rows) == 1, "таблица с мёртвым nodeId, но живым реферером не должна дропаться"
        assert rows[0][3] == "t1"   # $4 table_id
        assert rows[0][4] == "n1"   # $5 node_id — вылечен на id реферера
        assert result["dropped_orphans"] == 0

    async def test_valid_nodeid_with_duplicate_referrer_not_rewritten(self, mock_conn):
        """b) entry.nodeId уже валиден (сам входит в рефереров) — даже если
        есть ЕЩЁ один узел с дублирующей ссылкой, nodeId НЕ переписывается."""
        repo = ActContentRepository(mock_conn)
        mock_conn.fetchval.return_value = None
        mock_conn.fetch.return_value = []

        valid = MagicMock()
        valid.nodeId = "n2"  # её реальный (не первый по документу) владелец
        valid.grid = []
        valid.colWidths = []
        valid.protected = False
        valid.deletable = True
        valid.kind = "regular"

        data = _make_act_data(tables={"t1": valid})
        data.tree = {
            "id": "root", "label": "Акт",
            "children": [
                {"id": "n1", "label": "Дубль ссылки", "type": "table",
                 "tableId": "t1", "children": []},
                {"id": "n2", "label": "Таблица", "type": "table",
                 "tableId": "t1", "children": []},
            ],
        }
        result = await repo.save_content(act_id=1, data=data, username="user1")

        table_inserts = [
            c for c in mock_conn.executemany.call_args_list
            if "act_tables" in c.args[0]
        ]
        rows = table_inserts[0].args[1]
        assert len(rows) == 1
        # nodeId остаётся "n2" — не переписан на первого по документу "n1".
        assert rows[0][4] == "n2"
        assert result["dropped_orphans"] == 0

    async def test_no_referrers_at_all_dropped(self, mock_conn):
        """c) ни один узел не ссылается на запись — настоящая сирота, дроп."""
        repo = ActContentRepository(mock_conn)
        mock_conn.fetchval.return_value = None
        mock_conn.fetch.return_value = []

        orphan = MagicMock()
        orphan.nodeId = "n1"  # узел существует, но ни на что не ссылается
        orphan.grid = []
        orphan.colWidths = []
        orphan.protected = False
        orphan.deletable = True
        orphan.kind = "regular"

        data = _make_act_data(tables={"t_orphan": orphan})
        data.tree = {
            "id": "root", "label": "Акт",
            "children": [{"id": "n1", "label": "Пункт", "type": "item", "children": []}],
        }
        result = await repo.save_content(act_id=1, data=data, username="user1")

        for c in mock_conn.executemany.call_args_list:
            if "act_tables" in c.args[0]:
                pytest.fail("сирота без единого реферера попала в INSERT act_tables")
        assert result["dropped_orphans"] == 1

    async def test_two_live_referrers_dead_nodeid_heals_to_first_in_document_order(self, mock_conn):
        """e) nodeId мёртв, рефереров двое (оба живые) — лечится на ПЕРВОГО в
        документном порядке (родитель раньше детей, дети по порядку)."""
        repo = ActContentRepository(mock_conn)
        mock_conn.fetchval.return_value = None
        mock_conn.fetch.return_value = []

        stale = MagicMock()
        stale.nodeId = "ghost"
        stale.grid = []
        stale.colWidths = []
        stale.protected = False
        stale.deletable = True
        stale.kind = "regular"

        data = _make_act_data(tables={"t1": stale})
        data.tree = {
            "id": "root", "label": "Акт",
            "children": [
                {"id": "n_first", "label": "Таблица 1", "type": "table",
                 "tableId": "t1", "children": []},
                {"id": "n_second", "label": "Таблица 2", "type": "table",
                 "tableId": "t1", "children": []},
            ],
        }
        result = await repo.save_content(act_id=1, data=data, username="user1")

        table_inserts = [
            c for c in mock_conn.executemany.call_args_list
            if "act_tables" in c.args[0]
        ]
        rows = table_inserts[0].args[1]
        assert len(rows) == 1
        assert rows[0][4] == "n_first"  # первый в документном порядке, не n_second
        assert result["dropped_orphans"] == 0

    async def test_dead_nodeid_with_live_referrer_heals_for_textblock_and_violation(self, mock_conn):
        """a) единообразно для textBlocks/violations (не только tables)."""
        repo = ActContentRepository(mock_conn)
        mock_conn.fetchval.return_value = None
        mock_conn.fetch.return_value = []

        data = _make_act_data(
            textblocks={"tb1": _make_textblock("ghost")},
            violations={"v1": _make_violation("ghost")},
        )
        data.tree = {
            "id": "root", "label": "Акт",
            "children": [
                {"id": "n_tb", "label": "ТБ", "type": "textblock",
                 "textBlockId": "tb1", "children": []},
                {"id": "n_v", "label": "Нарушение", "type": "violation",
                 "violationId": "v1", "children": []},
            ],
        }
        result = await repo.save_content(act_id=1, data=data, username="user1")

        tb_inserts = [
            c for c in mock_conn.executemany.call_args_list
            if "act_textblocks" in c.args[0]
        ]
        v_inserts = [
            c for c in mock_conn.executemany.call_args_list
            if "act_violations" in c.args[0]
        ]
        assert len(tb_inserts) == 1 and len(tb_inserts[0].args[1]) == 1
        assert tb_inserts[0].args[1][0][4] == "n_tb"
        assert len(v_inserts) == 1 and len(v_inserts[0].args[1]) == 1
        assert v_inserts[0].args[1][0][4] == "n_v"
        assert result["dropped_orphans"] == 0
