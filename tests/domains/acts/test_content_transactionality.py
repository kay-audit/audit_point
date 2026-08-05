"""
Транзакционная целостность save_content и restore_version (§9 зона 4).

save_content: контент + diff + снимок версии — в ОДНОЙ плоской транзакции
сервиса (без вложенных transaction()/savepoint'ов — Greenplum).
restore_version: pre-snapshot + перезапись + post-snapshot — так же.

Сбой на любом шаге (например, снимок версии) откатывает ВСЁ: контент
не записывается частично, история не рассогласуется.

Аудит-лог — единственный шаг ВНЕ транзакции, и пишется ПОСЛЕ коммита:
батчер пишет своим соединением, поэтому изнутри блока запись уехала бы
в лог и при откате (phantom-запись о несостоявшейся операции).
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.domains.acts.schemas.act_content import ActDataSchema
from app.domains.acts.services.act_content_service import ActContentService
from app.domains.acts.services.audit_log_service import AuditLogService


@pytest.fixture(autouse=True)
def _patch_adapter(mock_adapter):
    with patch("app.db.repositories.base.get_adapter", return_value=mock_adapter):
        yield


def _make_conn_with_tx(call_log: list[str]):
    """Mock-соединение с трекингом входа/выхода транзакции в call_log."""
    conn = AsyncMock()

    tx = AsyncMock()

    async def _aenter():
        call_log.append("tx:enter")
        return tx

    async def _aexit(exc_type, exc, tb):
        call_log.append(f"tx:exit:{'rollback' if exc_type else 'commit'}")
        return False

    tx.__aenter__ = AsyncMock(side_effect=_aenter)
    tx.__aexit__ = AsyncMock(side_effect=_aexit)
    conn.transaction = MagicMock(return_value=tx)
    return conn, tx


def _make_data(save_type: str = "manual") -> ActDataSchema:
    return ActDataSchema(
        tree={"id": "root", "label": "Акт", "children": []},
        saveType=save_type,
    )


def _make_content_service(call_log: list[str]):
    """ActContentService с моками, пишущими шаги в call_log."""
    conn, tx = _make_conn_with_tx(call_log)
    settings = MagicMock()
    acts_settings = MagicMock()
    acts_settings.resource.max_tree_depth = 20
    acts_settings.audit_log.max_diff_elements = 100
    acts_settings.audit_log.max_diff_cells_per_table = 100
    acts_settings.audit_log.max_content_versions = 50

    svc = ActContentService(
        conn=conn,
        settings=settings,
        acts_settings=acts_settings,
        access=MagicMock(),
        lock=MagicMock(),
        crud=MagicMock(),
        content=MagicMock(),
        invoice=MagicMock(),
    )
    svc.guard = MagicMock()
    svc.guard.require_edit_permission = AsyncMock()
    svc.guard.require_lock_owner = AsyncMock()

    async def _save_content(act_id, data, username, **kwargs):
        call_log.append("repo:save_content")
        return {"status": "success", "message": "ok"}

    async def _log(*args, **kwargs):
        call_log.append("audit:log")

    async def _compute_diff(act_id, data):
        call_log.append("audit:diff")
        return {}

    async def _create_version(**kwargs):
        call_log.append("versions:create")
        return 1

    svc._content = MagicMock()
    svc._content.save_content = AsyncMock(side_effect=_save_content)
    svc._audit = MagicMock()
    svc._audit.log = AsyncMock(side_effect=_log)
    svc._audit.compute_content_diff = AsyncMock(side_effect=_compute_diff)
    svc._audit.compute_field_diffs = AsyncMock(return_value=None)
    svc._versions = MagicMock()
    svc._versions.create_version = AsyncMock(side_effect=_create_version)
    # manual/periodic-снимок тянет фактуры акта для блоба invoices_data
    svc._invoice = MagicMock()
    svc._invoice.get_invoices_for_act = AsyncMock(return_value=[])

    return svc, conn, tx


class TestSaveContentSingleTransaction:
    """save_content: одна плоская транзакция, аудит — после коммита."""

    async def test_all_steps_inside_one_transaction(self):
        call_log: list[str] = []
        svc, conn, tx = _make_content_service(call_log)

        await svc.save_content(act_id=1, data=_make_data("manual"), username="12345")

        # Транзакция открыта ровно один раз (плоская, без вложенности)
        assert conn.transaction.call_count == 1
        # Запись контента и снимок версии — между входом и коммитом
        assert call_log[0] == "tx:enter"
        commit_at = call_log.index("tx:exit:commit")
        inner = call_log[1:commit_at]
        assert "repo:save_content" in inner
        assert "versions:create" in inner
        # Аудит — единственный шаг после коммита
        assert "audit:log" not in inner
        assert call_log[commit_at + 1:] == ["audit:log"]

    async def test_version_failure_rolls_back_content(self):
        """Исключение на шаге «снимок версии» → контент НЕ записан (откат всего)."""
        call_log: list[str] = []
        svc, conn, tx = _make_content_service(call_log)
        svc._versions.create_version = AsyncMock(
            side_effect=RuntimeError("disk full"),
        )

        with pytest.raises(RuntimeError, match="disk full"):
            await svc.save_content(
                act_id=1, data=_make_data("manual"), username="12345",
            )

        # Контент успели записать ВНУТРИ транзакции...
        assert "repo:save_content" in call_log
        # ...но транзакция завершилась откатом — запись не зафиксирована.
        assert call_log[-1] == "tx:exit:rollback"

    async def test_rollback_leaves_no_audit_record(self):
        """Откат не оставляет phantom-записи в аудит-логе.

        Батчер пишет своим соединением, вне транзакции сервиса: логируй мы
        изнутри блока — запись о несостоявшемся сохранении всё равно уехала
        бы в лог и попала в пользовательскую историю акта.
        """
        call_log: list[str] = []
        svc, conn, tx = _make_content_service(call_log)
        svc._versions.create_version = AsyncMock(
            side_effect=RuntimeError("disk full"),
        )

        with pytest.raises(RuntimeError, match="disk full"):
            await svc.save_content(
                act_id=1, data=_make_data("manual"), username="12345",
            )

        assert "audit:log" not in call_log
        svc._audit.log.assert_not_awaited()

    async def test_auto_save_skips_version_but_still_transactional(self):
        """auto-сейв без снимка версии всё равно идёт в транзакции."""
        call_log: list[str] = []
        svc, conn, tx = _make_content_service(call_log)

        await svc.save_content(act_id=1, data=_make_data("auto"), username="12345")

        assert conn.transaction.call_count == 1
        assert "versions:create" not in call_log
        assert call_log[-1] == "audit:log"
        assert call_log[-2] == "tx:exit:commit"


def _make_audit_service(call_log: list[str]):
    """AuditLogService с моками, пишущими шаги в call_log."""
    conn, tx = _make_conn_with_tx(call_log)

    guard = MagicMock()
    guard.require_management_role = AsyncMock()
    guard.require_lock_owner = AsyncMock()

    audit_repo = MagicMock()

    async def _log(*args, **kwargs):
        call_log.append("audit:log")

    audit_repo.log = AsyncMock(side_effect=_log)

    versions_repo = MagicMock()
    versions_repo.get_version = AsyncMock(return_value={
        "version_number": 3,
        "tree_data": {"id": "root", "label": "Акт", "children": []},
        "tables_data": {},
        "textblocks_data": {},
        "violations_data": {},
    })

    async def _create_version(**kwargs):
        call_log.append(f"versions:create:{kwargs['save_type']}")
        return 1

    versions_repo.create_version = AsyncMock(side_effect=_create_version)

    svc = AuditLogService(guard, audit_repo, versions_repo, conn)
    return svc, conn, tx, versions_repo


class TestRestoreVersionSingleTransaction:
    """restore_version: 3 шага в одной транзакции, аудит — после коммита."""

    async def test_all_steps_inside_one_transaction(self):
        call_log: list[str] = []
        svc, conn, tx, versions_repo = _make_audit_service(call_log)

        async def _get_content(act_id):
            call_log.append("repo:get_content")
            return {"tree": {"id": "root"}, "tables": {},
                    "textBlocks": {}, "violations": {}}

        async def _save_content(act_id, data, username, **kwargs):
            call_log.append("repo:save_content")

        with patch(
            "app.domains.acts.services.audit_log_service.ActContentRepository"
        ) as content_cls:
            instance = content_cls.return_value
            instance.get_content = AsyncMock(side_effect=_get_content)
            instance.save_content = AsyncMock(side_effect=_save_content)

            await svc.restore_version(act_id=1, version_id=3, username="12345")

        assert conn.transaction.call_count == 1
        assert call_log[0] == "tx:enter"
        commit_at = call_log.index("tx:exit:commit")
        inner = call_log[1:commit_at]
        # pre-snapshot, перезапись, post-snapshot — все внутри
        assert "versions:create:auto" in inner
        assert "repo:save_content" in inner
        assert "versions:create:manual" in inner
        # Аудит — единственный шаг после коммита
        assert "audit:log" not in inner
        assert call_log[commit_at + 1:] == ["audit:log"]

    async def test_post_snapshot_failure_rolls_back_restore(self):
        """Сбой post-snapshot откатывает и перезапись контента (история целостна)."""
        call_log: list[str] = []
        svc, conn, tx, versions_repo = _make_audit_service(call_log)

        async def _create_version(**kwargs):
            call_log.append(f"versions:create:{kwargs['save_type']}")
            if kwargs["save_type"] == "manual":
                raise RuntimeError("snapshot failed")
            return 1

        versions_repo.create_version = AsyncMock(side_effect=_create_version)

        with patch(
            "app.domains.acts.services.audit_log_service.ActContentRepository"
        ) as content_cls:
            instance = content_cls.return_value
            instance.get_content = AsyncMock(return_value=None)
            instance.save_content = AsyncMock()

            with pytest.raises(RuntimeError, match="snapshot failed"):
                await svc.restore_version(act_id=1, version_id=3, username="12345")

        assert call_log[-1] == "tx:exit:rollback"
        # Откат не оставляет phantom-записи «восстановлено из версии»
        assert "audit:log" not in call_log


class TestSaveContentDanglingRefCleanup:
    """save_content мягко чистит рассогласование дерево ↔ словари (findings 3+8).

    Висячая ссылка листового узла не отбивает PUT 422: сервис удаляет узел-зомби
    ЦЕЛИКОМ (фикс #4 — иначе пустой узел отрисуется в экспорте), сохранение
    успешно, в ответе непустой warning. Сохраняемое дерево больше не содержит
    бессодержательного узла.
    """

    @staticmethod
    def _data_with_dangling_table_ref() -> ActDataSchema:
        return ActDataSchema(
            tree={
                "id": "root", "label": "Акт",
                "children": [
                    {"id": "n1", "label": "Таблица", "type": "table",
                     "tableId": "t_ghost", "children": []},
                ],
            },
            saveType="auto",
        )

    async def test_dangling_ref_node_removed_and_warning_returned(self):
        call_log: list[str] = []
        svc, conn, tx = _make_content_service(call_log)

        saved: dict = {}

        async def _save_content(act_id, data, username, **kwargs):
            # Запоминаем дерево в момент сохранения — узел-зомби уже удалён.
            saved["tree"] = data.tree
            return {"status": "success", "message": "ok", "dropped_orphans": 0}

        svc._content.save_content = AsyncMock(side_effect=_save_content)

        data = self._data_with_dangling_table_ref()
        result = await svc.save_content(act_id=1, data=data, username="12345")

        # Сохранение успешно, не 422.
        assert result["status"] == "success"
        # Узел-зомби удалён целиком (а не просто снята ссылка).
        assert saved["tree"]["children"] == []
        # Пользователь предупреждён одной строкой.
        assert result["warning"] is not None
        assert "висячих ссылок: 1" in result["warning"]

    async def test_nested_zombie_removed_parent_and_siblings_survive(self):
        """Вложенный зомби удаляется, родитель-item и валидные соседи остаются."""
        call_log: list[str] = []
        svc, conn, tx = _make_content_service(call_log)

        saved: dict = {}

        async def _save_content(act_id, data, username, **kwargs):
            saved["tree"] = data.tree
            return {"status": "success", "message": "ok", "dropped_orphans": 0}

        svc._content.save_content = AsyncMock(side_effect=_save_content)

        data = ActDataSchema(
            tree={
                "id": "root", "label": "Акт",
                "children": [
                    {"id": "sec", "label": "Раздел", "type": "item", "children": [
                        {"id": "z", "label": "Таблица", "type": "table",
                         "tableId": "ghost", "children": []},
                        {"id": "ok", "label": "Пункт", "type": "item", "children": []},
                    ]},
                ],
            },
            saveType="auto",
        )
        result = await svc.save_content(act_id=1, data=data, username="12345")

        assert result["status"] == "success"
        sec_children = saved["tree"]["children"][0]["children"]
        ids = [n["id"] for n in sec_children]
        assert "z" not in ids        # зомби удалён
        assert "ok" in ids           # валидный сосед остался
        assert "висячих ссылок: 1" in result["warning"]

    async def test_valid_leaf_ref_not_removed(self):
        """Лист с валидной ссылкой не трогается, warning пуст."""
        call_log: list[str] = []
        svc, conn, tx = _make_content_service(call_log)

        saved: dict = {}

        async def _save_content(act_id, data, username, **kwargs):
            saved["tree"] = data.tree
            return {"status": "success", "message": "ok", "dropped_orphans": 0}

        svc._content.save_content = AsyncMock(side_effect=_save_content)

        data = ActDataSchema(
            tree={
                "id": "root", "label": "Акт",
                "children": [
                    {"id": "n1", "label": "Таблица", "type": "table",
                     "tableId": "t1", "children": []},
                ],
            },
            tables={"t1": {"id": "t1", "nodeId": "n1", "grid": []}},
            saveType="auto",
        )
        result = await svc.save_content(act_id=1, data=data, username="12345")

        assert result["status"] == "success"
        assert [n["id"] for n in saved["tree"]["children"]] == ["n1"]
        assert result["warning"] is None

    async def test_no_cleanup_yields_null_warning(self):
        """Когда чистить нечего — warning равен None."""
        call_log: list[str] = []
        svc, conn, tx = _make_content_service(call_log)

        async def _save_content(act_id, data, username, **kwargs):
            return {"status": "success", "message": "ok", "dropped_orphans": 0}

        svc._content.save_content = AsyncMock(side_effect=_save_content)

        result = await svc.save_content(
            act_id=1, data=_make_data("auto"), username="12345",
        )
        assert result["warning"] is None

    async def test_orphan_dict_drop_surfaced_in_warning(self):
        """Сироты словарей (от репозитория) попадают в warning половиной 'записей без узла'."""
        call_log: list[str] = []
        svc, conn, tx = _make_content_service(call_log)

        async def _save_content(act_id, data, username, **kwargs):
            return {"status": "success", "message": "ok", "dropped_orphans": 2}

        svc._content.save_content = AsyncMock(side_effect=_save_content)

        result = await svc.save_content(
            act_id=1, data=_make_data("auto"), username="12345",
        )
        assert result["warning"] is not None
        assert "записей без узла: 2" in result["warning"]
        # Висячих ссылок не было — эта половина опущена.
        assert "висячих ссылок" not in result["warning"]


class TestCreateVersionPropagatesErrors:
    """create_version пробрасывает ошибки БД (без глотания).

    Глотание исключения внутри уже открытой плоской транзакции оставило бы
    транзакцию в aborted-состоянии и замаскировало бы причину отката.
    """

    async def test_db_error_propagates(self, mock_conn):
        from app.domains.acts.repositories.act_content_version import (
            ActContentVersionRepository,
        )

        mock_conn.fetchrow.side_effect = RuntimeError("connection lost")
        repo = ActContentVersionRepository(mock_conn)

        with pytest.raises(RuntimeError, match="connection lost"):
            await repo.create_version(
                act_id=1, username="12345", save_type="manual",
                tree={}, tables={}, textblocks={}, violations={},
            )
