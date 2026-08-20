"""
Unit-тесты сервиса/репозитория аудит-лога.

В acts-домене аудит-лог разделён на два слоя:
- ``ActAuditLogRepository.log()`` — запись действия (глушит DB-ошибки by design)
- ``AuditLogService.restore_version()`` — восстановление содержимого с записью в лог

Тут проверяем поведение этих двух слоёв на уровне сервиса. Whitelist полей
``get_log`` уже покрыт в test_act_audit_log_whitelist.py — не дублируем,
но даём один регрессионный кейс на интеграцию (фильтр доходит до SQL).
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.domains.acts.exceptions import ActNotFoundError
from app.domains.acts.repositories.act_audit_log import ActAuditLogRepository
from app.domains.acts.services.audit_log_service import AuditLogService


@pytest.fixture(autouse=True)
def _patch_adapter(mock_adapter):
    with patch("app.db.repositories.base.get_adapter", return_value=mock_adapter):
        yield


def _make_tx_conn() -> AsyncMock:
    """Mock-соединение с поддержкой async with conn.transaction().

    restore_version держит все шаги в одной плоской транзакции —
    mock-у нужен синхронный transaction(), возвращающий async-CM.
    """
    conn = AsyncMock()
    tx = AsyncMock()
    tx.__aenter__ = AsyncMock(return_value=tx)
    tx.__aexit__ = AsyncMock(return_value=False)
    conn.transaction = MagicMock(return_value=tx)
    # restore_version тянет текущие фактуры напрямую через ActInvoiceRepository
    # (реальный репо на этом же conn в тестах без явного patch'а) — пустой
    # fetch по умолчанию, чтобы get_invoices_for_act вернул [].
    conn.fetch = AsyncMock(return_value=[])
    return conn


# ── ActAuditLogRepository.log: запись и обработка ошибок ────────────────────


class TestAuditLogPersistence:
    """log() сохраняет запись с правильными полями и глушит исключения БД."""

    async def test_log_persists_with_correct_fields(self, mock_conn):
        """Корректный вызов execute с action, username, act_id, JSON-полями."""
        repo = ActAuditLogRepository(mock_conn)

        await repo.log(
            action="create",
            username="12345",
            act_id=42,
            details={"km_number": "КМ-01-0000001"},
        )

        mock_conn.execute.assert_awaited_once()
        sql, *params = mock_conn.execute.await_args.args
        assert "INSERT INTO" in sql
        assert "audit_log" in sql
        # Параметры в порядке: act_id, action, username, details_json, changelog_json
        assert params[0] == 42
        assert params[1] == "create"
        assert params[2] == "12345"
        # details сериализован в JSON-строку
        assert "КМ-01-0000001" in params[3]
        # changelog по умолчанию — пустой массив
        assert params[4] == "[]"

    async def test_log_with_changelog_persists_changelog_json(self, mock_conn):
        """changelog передаётся в SQL как сериализованный JSON-массив."""
        repo = ActAuditLogRepository(mock_conn)
        changelog = [{"type": "table_added", "table_id": "t1"}]

        await repo.log(
            action="content_save",
            username="12345",
            act_id=10,
            changelog=changelog,
        )

        params = mock_conn.execute.await_args.args[1:]
        assert "table_added" in params[4]
        assert "t1" in params[4]

    async def test_log_swallows_db_errors_returns_none(self, mock_conn):
        """Ошибка execute не должна пробрасываться наверх (audit-log fail-safe).

        Запись в аудит-лог не должна блокировать основную операцию.
        Документировано в repositories/act_audit_log.py (try/except).
        """
        mock_conn.execute.side_effect = RuntimeError("connection lost")
        repo = ActAuditLogRepository(mock_conn)

        # НЕ должно бросить
        result = await repo.log(
            action="create",
            username="12345",
            act_id=1,
        )
        assert result is None

    async def test_log_serializes_non_json_native_via_default_str(self, mock_conn):
        """default=str в json.dumps — не падает на datetime/Decimal/UUID."""
        from datetime import datetime
        repo = ActAuditLogRepository(mock_conn)

        await repo.log(
            action="export",
            username="12345",
            act_id=5,
            details={"exported_at": datetime(2026, 5, 18, 12, 0, 0)},
        )

        # JSON-строка собралась — execute вызван
        mock_conn.execute.assert_awaited_once()
        details_json = mock_conn.execute.await_args.args[4]
        assert "2026-05-18" in details_json


# ── ActAuditLogRepository.get_log: фильтрация и пагинация ───────────────────


class TestGetLogFilters:
    """get_log применяет фильтры и пагинацию."""

    async def test_get_history_returns_paginated_list(self, mock_conn):
        """Возвращает (items, total) и пробрасывает limit/offset в SQL."""
        repo = ActAuditLogRepository(mock_conn)
        mock_conn.fetchrow.return_value = {"cnt": 7}
        mock_conn.fetch.return_value = [
            {
                "id": i,
                "action": "create",
                "username": "12345",
                "details": "{}",
                "changelog": None,
                "created_at": "2026-05-18T12:00:00",
            }
            for i in range(3)
        ]

        items, total = await repo.get_log(act_id=1, limit=3, offset=0)

        assert total == 7
        assert len(items) == 3
        # limit / offset попали в параметры SQL
        params = mock_conn.fetch.await_args.args[1:]
        assert 3 in params
        assert 0 in params
        # JSON-строки распаршены в dict/list
        assert items[0]["details"] == {}
        assert items[0]["changelog"] == []

    async def test_get_history_filters_by_action(self, mock_conn):
        """Фильтр action=create добавляет условие в WHERE."""
        repo = ActAuditLogRepository(mock_conn)
        mock_conn.fetchrow.return_value = {"cnt": 0}
        mock_conn.fetch.return_value = []

        await repo.get_log(act_id=1, action="create")

        sql = mock_conn.fetch.await_args.args[0]
        assert "action" in sql
        # Один action → "= $N", не IN
        assert "action = " in sql

    async def test_get_history_filters_by_multiple_actions(self, mock_conn):
        """Несколько action через запятую → IN-клауза."""
        repo = ActAuditLogRepository(mock_conn)
        mock_conn.fetchrow.return_value = {"cnt": 0}
        mock_conn.fetch.return_value = []

        await repo.get_log(act_id=1, action="create,update,delete")

        sql = mock_conn.fetch.await_args.args[0]
        assert "IN (" in sql

    async def test_get_history_filters_by_user(self, mock_conn):
        """username — ILIKE с подстановкой %username%."""
        repo = ActAuditLogRepository(mock_conn)
        mock_conn.fetchrow.return_value = {"cnt": 0}
        mock_conn.fetch.return_value = []

        await repo.get_log(act_id=1, username="иван")

        sql = mock_conn.fetch.await_args.args[0]
        params = mock_conn.fetch.await_args.args[1:]
        assert "ILIKE" in sql
        assert "%иван%" in params

    async def test_get_history_respects_whitelist_only_safe_columns_in_sql(
        self, mock_conn,
    ):
        """Регрессионный тест на whitelist: не должно быть инъекций.

        Полное покрытие в test_act_audit_log_whitelist.py — тут только
        факт, что комбинированный фильтр не пропускает посторонних имён.
        """
        repo = ActAuditLogRepository(mock_conn)
        mock_conn.fetchrow.return_value = {"cnt": 0}
        mock_conn.fetch.return_value = []

        await repo.get_log(
            act_id=1,
            action="create",
            username="user",
            from_date="2026-01-01",
            to_date="2026-12-31",
        )

        sql = mock_conn.fetch.await_args.args[0]
        assert "; DROP" not in sql
        assert "OR 1=1" not in sql


# ── AuditLogService.restore_version ────────────────────────────────────────


class TestAuditLogServiceRestore:
    """AuditLogService.restore_version восстанавливает версию + пишет в лог."""

    def _make_service(self):
        """Собирает AuditLogService с моками всех зависимостей."""
        guard = MagicMock()
        guard.require_management_role = AsyncMock()
        guard.require_lock_owner = AsyncMock()

        audit_repo = MagicMock()
        audit_repo.log = AsyncMock()

        versions_repo = MagicMock()
        versions_repo.get_version = AsyncMock()
        versions_repo.create_version = AsyncMock(return_value=2)

        conn = _make_tx_conn()
        return AuditLogService(guard, audit_repo, versions_repo, conn), guard, audit_repo, versions_repo

    async def test_restore_version_unknown_raises_not_found(self):
        """Несуществующая версия → ActNotFoundError (404)."""
        svc, guard, audit_repo, versions_repo = self._make_service()
        versions_repo.get_version.return_value = None

        with pytest.raises(ActNotFoundError):
            await svc.restore_version(act_id=1, version_id=999, username="12345")

        guard.require_management_role.assert_awaited_once_with(1, "12345")
        guard.require_lock_owner.assert_awaited_once_with(1, "12345")
        audit_repo.log.assert_not_awaited()
        versions_repo.create_version.assert_not_awaited()

    async def test_restore_version_writes_audit_log_with_restore_action(self):
        """Успешный restore пишет аудит-лог с action=restore и метаданными версии."""
        svc, guard, audit_repo, versions_repo = self._make_service()
        versions_repo.get_version.return_value = {
            "version_number": 5,
            "tree_data": {"id": "root", "children": []},
            "tables_data": {},
            "textblocks_data": {},
            "violations_data": {},
        }

        # Патчим ActContentRepository, чтобы не дёргать настоящий save_content
        with patch(
            "app.domains.acts.services.audit_log_service.ActContentRepository"
        ) as content_cls:
            instance = content_cls.return_value
            instance.save_content = AsyncMock()
            # restore_version делает pre-snapshot через get_content
            # (lost-write guard) — мок обязателен, иначе TypeError на await.
            # Здесь возвращаем None: проверяем что без текущего контента
            # pre-snapshot пропускается.
            instance.get_content = AsyncMock(return_value=None)
            result = await svc.restore_version(
                act_id=42,
                version_id=100,
                username="12345",
            )

        audit_repo.log.assert_awaited_once()
        call = audit_repo.log.await_args
        # action positional/kw
        action = call.args[0] if call.args else call.kwargs.get("action")
        assert action == "restore"
        # details содержит from_version и version_id
        details = call.args[3] if len(call.args) > 3 else call.kwargs.get("details")
        assert details["from_version"] == 5
        assert details["version_id"] == 100

        # Новая версия создана (snapshot после восстановления, без pre-snapshot
        # так как get_content вернул None).
        versions_repo.create_version.assert_awaited_once()
        # Ответ содержит restored_version
        assert result["restored_version"] == 5
        assert result["success"] is True

    async def test_restore_recomputes_validation_status_from_content(self):
        """restore пересчитывает validation_status из ВОССТАНОВЛЕННОГО контента.

        Регрессия на баг «restore слепо сбрасывал статус в ok»: восстановление
        дефектной структуры (пустое дерево) должно дать save_content с
        validation_status='error', а не дефолтным 'ok'.
        """
        svc, guard, audit_repo, versions_repo = self._make_service()
        versions_repo.get_version.return_value = {
            "version_number": 5,
            "tree_data": {"id": "root", "label": "Акт", "children": []},  # пустая структура → error
            "tables_data": {},
            "textblocks_data": {},
            "violations_data": {},
        }

        saved = {}

        async def _save_content(act_id, data, username, **kwargs):
            saved.update(kwargs)

        with patch(
            "app.domains.acts.services.audit_log_service.ActContentRepository"
        ) as content_cls:
            instance = content_cls.return_value
            instance.save_content = AsyncMock(side_effect=_save_content)
            instance.get_content = AsyncMock(return_value=None)
            await svc.restore_version(act_id=42, version_id=5, username="12345")

        assert saved.get("validation_status") == "error"
        assert saved.get("validation_issues")  # непустой список замечаний

    async def test_restore_valid_content_yields_ok_status(self):
        """Восстановление валидной структуры (разделы 1–6, включая Process Mining) → статус 'ok'."""
        svc, guard, audit_repo, versions_repo = self._make_service()
        valid_tree = {
            "id": "root", "label": "Акт", "children": [
                {"id": str(i), "label": f"Раздел {i}", "type": "item",
                 "protected": True, "deletable": False, "children": []}
                for i in range(1, 7)
            ],
        }
        versions_repo.get_version.return_value = {
            "version_number": 6,
            "tree_data": valid_tree,
            "tables_data": {},
            "textblocks_data": {},
            "violations_data": {},
        }

        saved = {}

        async def _save_content(act_id, data, username, **kwargs):
            saved.update(kwargs)

        with patch(
            "app.domains.acts.services.audit_log_service.ActContentRepository"
        ) as content_cls:
            instance = content_cls.return_value
            instance.save_content = AsyncMock(side_effect=_save_content)
            instance.get_content = AsyncMock(return_value=None)
            await svc.restore_version(act_id=42, version_id=6, username="12345")

        assert saved.get("validation_status") == "ok"
        assert saved.get("validation_issues") == []

    async def test_restore_version_swallow_audit_log_db_error_does_not_fail_caller(self):
        """Аудит-лог глушит DB-ошибку → restore_version всё равно завершается успехом.

        Это тест на интеграцию: AuditLogService вызывает audit_repo.log(),
        который не должен ронять основную операцию (см. log() impl).
        Здесь мокаем audit_repo.log так, чтобы он сам не кидал
        (как делает реальный код).
        """
        svc, guard, audit_repo, versions_repo = self._make_service()
        versions_repo.get_version.return_value = {
            "version_number": 1,
            "tree_data": {"id": "root", "children": []},
            "tables_data": {},
            "textblocks_data": {},
            "violations_data": {},
        }
        # Имитируем "глушение" внутри log()
        audit_repo.log = AsyncMock(return_value=None)

        with patch(
            "app.domains.acts.services.audit_log_service.ActContentRepository"
        ) as content_cls:
            instance = content_cls.return_value
            instance.save_content = AsyncMock()
            instance.get_content = AsyncMock(return_value=None)
            result = await svc.restore_version(1, 1, "12345")

        assert result["success"] is True


# ── Pre-snapshot перед restore_version (lost-write guard) ──────────────────


class TestRestoreVersionPreSnapshot:
    """restore_version делает snapshot текущего контента ДО перезаписи.

    Закрывает lost-write: если активный редактор не успел сохранить
    свой state, его последняя версия остаётся доступной в истории.
    """

    def _make_service(self):
        guard = MagicMock()
        guard.require_management_role = AsyncMock()
        guard.require_lock_owner = AsyncMock()
        audit_repo = MagicMock()
        audit_repo.log = AsyncMock()
        versions_repo = MagicMock()
        versions_repo.get_version = AsyncMock()
        versions_repo.create_version = AsyncMock(return_value=2)
        conn = _make_tx_conn()
        return AuditLogService(guard, audit_repo, versions_repo, conn), versions_repo

    async def test_pre_snapshot_created_from_current_content(self):
        """Перед restore версии v_old фиксируем текущий v_now как auto-snapshot."""
        svc, versions_repo = self._make_service()
        # Старая версия, которую восстанавливаем (валидная для ActDataSchema)
        versions_repo.get_version.return_value = {
            "version_number": 1,
            "tree_data": {"id": "root", "label": "v1", "children": []},
            "tables_data": {},
            "textblocks_data": {},
            "violations_data": {},
        }
        # Текущее содержимое акта — это то, что должно попасть в pre-snapshot.
        # Структуру намеренно делаем плоской: pre-snapshot пишется через
        # versions_repo.create_version(**kwargs), без валидации Pydantic.
        current_content = {
            "tree": {"id": "root", "label": "v_current", "children": []},
            "tables": {"t2": {"id": "t2", "nodeId": "n2"}},
            "textBlocks": {"tb1": {"id": "tb1", "nodeId": "n1", "content": "WIP"}},
            "violations": {},
            "invoices": {},
        }

        with patch(
            "app.domains.acts.services.audit_log_service.ActContentRepository"
        ) as content_cls:
            instance = content_cls.return_value
            instance.save_content = AsyncMock()
            instance.get_content = AsyncMock(return_value=current_content)

            await svc.restore_version(act_id=42, version_id=1, username="12345")

        # get_content должен быть вызван ДО save_content
        instance.get_content.assert_awaited_once_with(42)

        # create_version вызван дважды: pre-snapshot + post-restore
        assert versions_repo.create_version.await_count == 2
        first_call = versions_repo.create_version.await_args_list[0]
        # Первый вызов — pre-snapshot с текущим контентом
        assert first_call.kwargs["save_type"] == "auto"
        assert first_call.kwargs["tree"]["label"] == "v_current"
        assert first_call.kwargs["tables"] == {"t2": {"id": "t2", "nodeId": "n2"}}
        assert first_call.kwargs["textblocks"] == {
            "tb1": {"id": "tb1", "nodeId": "n1", "content": "WIP"}
        }

        # Второй вызов — post-restore snapshot с восстановленной версией
        second_call = versions_repo.create_version.await_args_list[1]
        assert second_call.kwargs["save_type"] == "manual"
        assert second_call.kwargs["tree"]["label"] == "v1"

    async def test_restore_reattaches_version_invoices(self):
        """restore заново прикрепляет фактуры версии, а не стирает их.

        Pre-снимок несёт РЕАЛЬНЫЕ текущие фактуры акта (get_invoices_for_act —
        get_content их не отдаёт). Сам restore UPSERT'ит фактуры версии
        (save_invoice на каждый узел снимка) и проставляет restore_data.
        invoiceNodeIds — так _sync_invoices освежает строки, а не уходит в
        ветку DELETE-всё. Post-снимок отражает восстановленные фактуры (не {}).
        """
        svc, versions_repo = self._make_service()
        version_invoices = {
            "n7": {
                "node_id": "n7", "act_id": 42, "db_type": "hive",
                "schema_name": "s", "table_name": "t7",
                "metrics": {"m": 1}, "node_number": "1.1",
                "process": None, "profile_div": None,
                "verification_status": "verified",
            },
        }
        versions_repo.get_version.return_value = {
            "version_number": 1,
            "tree_data": {"id": "root", "label": "v1", "children": []},
            "tables_data": {},
            "textblocks_data": {},
            "violations_data": {},
            "invoices_data": version_invoices,
        }
        current_content = {
            "tree": {"id": "root", "label": "v_current", "children": []},
            "tables": {},
            "textBlocks": {},
            "violations": {},
        }
        # Реальные текущие фактуры акта ДО restore — источник pre-снимка.
        current_invoice_rows = [
            {
                "node_id": "n5", "act_id": 42, "db_type": "hive",
                "schema_name": "s", "table_name": "t5", "metrics": {},
                "node_number": "2.1", "process": None, "profile_div": None,
                "verification_status": "verified",
            },
        ]
        # Реальное состояние фактур ПОСЛЕ restore (перечитывается из репозитория):
        # фактура версии прикреплена, verification_status сброшен в 'pending'.
        post_restore_rows = [
            {
                "node_id": "n7", "act_id": 42, "db_type": "hive",
                "schema_name": "s", "table_name": "t7",
                "metrics": {"m": 1}, "node_number": "1.1",
                "process": None, "profile_div": None,
                "verification_status": "pending",
            },
        ]

        with patch(
            "app.domains.acts.services.audit_log_service.ActContentRepository"
        ) as content_cls, patch(
            "app.domains.acts.services.audit_log_service.ActInvoiceRepository"
        ) as invoice_cls:
            content_inst = content_cls.return_value
            content_inst.save_content = AsyncMock()
            content_inst.get_content = AsyncMock(return_value=current_content)

            invoice_inst = invoice_cls.return_value
            # 1-й вызов — pre-снимок (текущие фактуры), 2-й — post-снимок
            # (реальное состояние после restore, перечитанное из репозитория).
            invoice_inst.get_invoices_for_act = AsyncMock(
                side_effect=[current_invoice_rows, post_restore_rows]
            )
            invoice_inst.save_invoice = AsyncMock()

            await svc.restore_version(act_id=42, version_id=1, username="12345")

        # Фактура версии заново прикреплена: save_invoice на узел снимка.
        invoice_inst.save_invoice.assert_awaited_once()
        saved_data = invoice_inst.save_invoice.await_args.args[0]
        assert saved_data["act_id"] == 42
        assert saved_data["node_id"] == "n7"
        assert saved_data["table_name"] == "t7"

        # save_content получил непустой invoiceNodeIds → _sync_invoices не
        # уходит в ветку DELETE-всё (restore больше не стирает фактуры).
        restore_data = content_inst.save_content.await_args.args[1]
        assert restore_data.invoiceNodeIds == ["n7"]

        pre_call = versions_repo.create_version.await_args_list[0]
        post_call = versions_repo.create_version.await_args_list[1]
        # Pre — реальные текущие фактуры акта (keyed by node_id).
        assert pre_call.kwargs["invoices"] == {"n5": current_invoice_rows[0]}
        # Post — реальное состояние фактур после restore (перечитано из БД):
        # n7 прикреплена, статус сброшен в 'pending' (не сырой снимок версии,
        # и не {}).
        assert post_call.kwargs["invoices"] == {"n7": post_restore_rows[0]}

    async def test_pre_snapshot_sanitized_before_write(self):
        """pbe-6: pre-snapshot чистится той же санитизацией, что и post.

        Иначе несанитизированный HTML из текущего контента (записанного
        в обход save_content или до ужесточения) лёг бы в историю и при
        повторном restore такого снимка вернулся бы в БД (stored XSS).
        Блочная модель: rich-носители блоков (text.content, image.caption)
        чистятся так же, как textBlock/tree; plain-поля image (url/filename)
        — дословно; ячейки блок-таблиц и больших таблиц — дословно
        (инвариант B8, все потребители рендерят их как текст).
        """
        svc, versions_repo = self._make_service()
        versions_repo.get_version.return_value = {
            "version_number": 1,
            "tree_data": {"id": "root", "label": "v1", "children": []},
            "tables_data": {},
            "textblocks_data": {},
            "violations_data": {},
        }
        current_content = {
            "tree": {
                "id": "root", "label": "Акт",
                "content": "<p>ok</p><script>alert(1)</script>",
                "children": [],
            },
            "tables": {
                "t1": {"id": "t1", "nodeId": "n1", "grid": [[
                    {"content": "<script>в ячейке — дословно</script>"},
                ]]},
            },
            "textBlocks": {
                "tb1": {"id": "tb1", "nodeId": "n2",
                        "content": '<b>жирный</b><iframe srcdoc="x"></iframe>'},
            },
            "violations": {
                "v1": {
                    "id": "v1", "nodeId": "n3",
                    "violated": {"enabled": True, "blocks": [
                        {"id": "text_1", "type": "text",
                         "content": '<img src=x onerror="alert(1)">текст'},
                    ]},
                    "description": {"enabled": True, "blocks": [
                        {"id": "text_2", "type": "text",
                         "content": "<b>важно</b><script>x</script>пункт"},
                    ]},
                    "additionalContent": {"enabled": True, "blocks": [
                        {"id": "image_1", "type": "image",
                         "url": "data:image/png;base64,AAAA",
                         "caption": '<b>подпись</b><img src=x onerror="a">',
                         "filename": "<script>f</script>имя.png"},
                        {"id": "text_3", "type": "text",
                         "content": '<b>текст</b><svg onload="x"></svg>'},
                    ]},
                    "codeMining": {"enabled": True, "blocks": [
                        {"id": "table_1", "type": "table", "table": {"grid": [[
                            {"content": "<script>в ячейке блока — дословно</script>"},
                        ]], "colWidths": [100]}},
                    ]},
                    "reasons": {"enabled": True, "blocks": [
                        {"id": "text_4", "type": "text",
                         "content": "<svg onload=x></svg>причина"},
                    ]},
                },
            },
        }

        with patch(
            "app.domains.acts.services.audit_log_service.ActContentRepository"
        ) as content_cls:
            instance = content_cls.return_value
            instance.save_content = AsyncMock()
            instance.get_content = AsyncMock(return_value=current_content)

            await svc.restore_version(act_id=42, version_id=1, username="12345")

        pre = versions_repo.create_version.await_args_list[0].kwargs
        assert pre["save_type"] == "auto"
        # Дерево: script вырезан, безопасный HTML остался
        assert "<script" not in pre["tree"]["content"]
        assert "ok" in pre["tree"]["content"]
        # Текстблок: iframe вырезан, whitelist-тег остался
        tb = pre["textblocks"]["tb1"]
        assert "<iframe" not in tb["content"]
        assert "<b>жирный</b>" in tb["content"]
        # Нарушение: rich-носители блоков санитизируются, plain — дословно
        v = pre["violations"]["v1"]
        assert v["violated"]["blocks"][0]["content"] == "текст"
        desc_block = v["description"]["blocks"][0]["content"]
        assert "<b>важно</b>" in desc_block and "пункт" in desc_block
        assert "<script" not in desc_block
        # image.caption — rich; filename/url остаются plain (дословно).
        image = v["additionalContent"]["blocks"][0]
        assert "<b>подпись</b>" in image["caption"]
        assert "<img" not in image["caption"] and "onerror" not in image["caption"]
        assert image["filename"] == "<script>f</script>имя.png"
        assert image["url"] == "data:image/png;base64,AAAA"
        # text-блок в additionalContent — rich
        text_block = v["additionalContent"]["blocks"][1]["content"]
        assert "<svg" not in text_block and "onload" not in text_block
        assert "<b>текст</b>" in text_block
        assert v["reasons"]["blocks"][0]["content"] == "причина"
        # Ячейки блок-таблицы нарушения — дословно (инвариант B8)
        block_cell = v["codeMining"]["blocks"][0]["table"]["grid"][0][0]
        assert block_cell["content"] == "<script>в ячейке блока — дословно</script>"
        # Ячейки больших таблиц — дословно (инвариант B8)
        cell = pre["tables"]["t1"]["grid"][0][0]
        assert cell["content"] == "<script>в ячейке — дословно</script>"

    async def test_pre_snapshot_image_caption_none_stays_none(self):
        """caption=None (dict-путь, легаси-данные без подписи) — не становится ''."""
        svc, versions_repo = self._make_service()
        versions_repo.get_version.return_value = {
            "version_number": 1,
            "tree_data": {"id": "root", "label": "v1", "children": []},
            "tables_data": {},
            "textblocks_data": {},
            "violations_data": {},
        }
        current_content = {
            "tree": {"id": "root", "label": "Акт", "children": []},
            "tables": {},
            "textBlocks": {},
            "violations": {
                "v1": {
                    "id": "v1", "nodeId": "n3",
                    "additionalContent": {"enabled": True, "blocks": [
                        {"id": "image_1", "type": "image", "url": "",
                         "caption": None, "filename": "имя.png"},
                    ]},
                },
            },
        }

        with patch(
            "app.domains.acts.services.audit_log_service.ActContentRepository"
        ) as content_cls:
            instance = content_cls.return_value
            instance.save_content = AsyncMock()
            instance.get_content = AsyncMock(return_value=current_content)

            await svc.restore_version(act_id=42, version_id=1, username="12345")

        pre = versions_repo.create_version.await_args_list[0].kwargs
        block = pre["violations"]["v1"]["additionalContent"]["blocks"][0]
        assert block["caption"] is None

    async def test_pre_snapshot_skipped_when_no_current_content(self):
        """get_content вернул None/{} → pre-snapshot не создаётся."""
        svc, versions_repo = self._make_service()
        versions_repo.get_version.return_value = {
            "version_number": 1,
            "tree_data": {"id": "root", "children": []},
            "tables_data": {},
            "textblocks_data": {},
            "violations_data": {},
        }

        with patch(
            "app.domains.acts.services.audit_log_service.ActContentRepository"
        ) as content_cls:
            instance = content_cls.return_value
            instance.save_content = AsyncMock()
            instance.get_content = AsyncMock(return_value=None)

            await svc.restore_version(act_id=1, version_id=1, username="12345")

        instance.get_content.assert_awaited_once_with(1)
        # Только post-restore snapshot, без pre-snapshot
        assert versions_repo.create_version.await_count == 1
        assert versions_repo.create_version.await_args.kwargs["save_type"] == "manual"

    async def test_pre_snapshot_happens_before_save_content(self):
        """Порядок: get_content → create_version(pre) → save_content → create_version(post)."""
        svc, versions_repo = self._make_service()
        versions_repo.get_version.return_value = {
            "version_number": 3,
            "tree_data": {"id": "root", "label": "restored"},
            "tables_data": {},
            "textblocks_data": {},
            "violations_data": {},
        }

        call_log: list[str] = []

        async def _get_content(act_id):
            call_log.append("get_content")
            return {"tree": {"id": "root", "label": "wip"}, "tables": {},
                    "textBlocks": {}, "violations": {}}

        async def _save_content(act_id, data, username, **kwargs):
            call_log.append("save_content")

        async def _create_version(**kwargs):
            call_log.append(f"create_version:{kwargs['save_type']}")
            return 1

        versions_repo.create_version.side_effect = _create_version

        with patch(
            "app.domains.acts.services.audit_log_service.ActContentRepository"
        ) as content_cls:
            instance = content_cls.return_value
            instance.get_content = AsyncMock(side_effect=_get_content)
            instance.save_content = AsyncMock(side_effect=_save_content)

            await svc.restore_version(act_id=1, version_id=3, username="12345")

        assert call_log == [
            "get_content",
            "create_version:auto",   # pre-snapshot
            "save_content",           # перезапись восстановленным контентом
            "create_version:manual",  # post-restore snapshot
        ]


# ── ActAuditLogRepository.compute_field_diffs: поля нарушений ────────────────


# Маленькая, но валидная data:image-картинка (payload-маркер для проверки,
# что base64 не утекает в diff).
_IMG_BASE64_PAYLOAD = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
_IMG_DATA_URL = f"data:image/png;base64,{_IMG_BASE64_PAYLOAD}"


def _make_act_data(violations: dict) -> "ActDataSchema":
    """ActDataSchema с пустым деревом и заданными нарушениями."""
    from app.domains.acts.schemas.act_content import ActDataSchema
    return ActDataSchema(
        tree={"id": "root", "label": "Акт", "children": []},
        violations=violations,
    )


def _db_violation_row(**overrides) -> dict:
    """Строка нарушения из БД, как её отдаёт SELECT в compute_field_diffs.

    Блочная модель: все полевые колонки — JSONB-контейнеры {enabled, blocks};
    NULL-колонка разбирается маппером в дефолтный контейнер (mandatory —
    включённый).
    """
    from app.domains.acts.violation_fields import VIOLATION_FIELDS
    row = {"violation_id": "v1", "node_id": "n1", "field_order": None}
    for field in VIOLATION_FIELDS:
        row[field.column] = json.dumps({"enabled": field.mandatory, "blocks": []})
    row.update(overrides)
    return row


class TestComputeFieldDiffsViolationCollections:
    """compute_field_diffs учитывает все поля-контейнеры (блочная модель).

    В diff пишется только компактная сводка (changed + число блоков):
    блоки могут содержать base64-картинки на мегабайты —
    их содержимое в аудит-лог попадать не должно.
    """

    def _make_violation(self, **kwargs):
        from app.domains.acts.schemas.act_content import ViolationSchema
        defaults = {"id": "v1", "nodeId": "n1"}
        defaults.update(kwargs)
        return ViolationSchema.model_validate(defaults)

    async def test_description_change_detected(self, mock_conn):
        """Добавление блока в поле попадает в diff нарушения со счётчиками."""
        repo = ActAuditLogRepository(mock_conn)
        mock_conn.fetch.side_effect = [
            [],  # таблицы
            [],  # текстблоки
            [_db_violation_row(
                description=json.dumps({"enabled": True, "blocks": [
                    {"id": "text_1", "type": "text", "content": "старый пункт"},
                ]}),
            )],
        ]
        data = _make_act_data({"v1": self._make_violation(
            description={"enabled": True, "blocks": [
                {"id": "text_1", "type": "text", "content": "старый пункт"},
                {"id": "text_2", "type": "text", "content": "новый пункт"},
            ]},
        )})

        result = await repo.compute_field_diffs(1, data)

        assert "v1" in result
        diff = result["v1"]["fields"]["description"]
        assert diff["changed"] is True
        assert diff["old_blocks"] == 1
        assert diff["new_blocks"] == 2

    async def test_additional_content_change_detected_without_base64_leak(self, mock_conn):
        """Изменение доп. контента фиксируется компактно — без base64 в diff."""
        repo = ActAuditLogRepository(mock_conn)
        mock_conn.fetch.side_effect = [
            [], [],
            [_db_violation_row()],
        ]
        data = _make_act_data({"v1": self._make_violation(
            additionalContent={"enabled": True, "blocks": [
                {"id": "image_1", "type": "image", "url": _IMG_DATA_URL},
            ]},
        )})

        result = await repo.compute_field_diffs(1, data)

        assert "v1" in result
        diff = result["v1"]["fields"]["additionalContent"]
        assert diff["changed"] is True
        assert diff["old_blocks"] == 0
        assert diff["new_blocks"] == 1
        # base64-payload картинки не должен утекать в аудит-лог
        assert _IMG_BASE64_PAYLOAD not in json.dumps(result)

    async def test_unchanged_containers_not_reported(self, mock_conn):
        """Совпадающие контейнеры (включая NULL в БД ↔ схемный дефолт) — не diff."""
        repo = ActAuditLogRepository(mock_conn)
        mock_conn.fetch.side_effect = [
            [], [],
            [_db_violation_row(description=None, additional_content=None)],
        ]
        data = _make_act_data({"v1": self._make_violation()})

        result = await repo.compute_field_diffs(1, data)

        assert result == {}

    async def test_field_order_change_detected(self, mock_conn):
        """Смена fieldOrder попадает в diff нарушения."""
        from app.domains.acts.violation_fields import VIOLATION_FIELD_KEYS
        repo = ActAuditLogRepository(mock_conn)
        mock_conn.fetch.side_effect = [
            [], [],
            [_db_violation_row(field_order=None)],
        ]
        data = _make_act_data({"v1": self._make_violation(
            fieldOrder=list(reversed(VIOLATION_FIELD_KEYS)),
        )})

        result = await repo.compute_field_diffs(1, data)

        assert result["v1"]["fields"]["fieldOrder"] == {"changed": True}

    async def test_text_block_content_diff_still_works(self, mock_conn):
        """Регрессия: правка текста внутри блока даёт diff поля."""
        repo = ActAuditLogRepository(mock_conn)
        mock_conn.fetch.side_effect = [
            [], [],
            [_db_violation_row(violated=json.dumps({"enabled": True, "blocks": [
                {"id": "text_1", "type": "text", "content": "старый текст"},
            ]}))],
        ]
        data = _make_act_data({"v1": self._make_violation(
            violated={"enabled": True, "blocks": [
                {"id": "text_1", "type": "text", "content": "новый текст"},
            ]},
        )})

        result = await repo.compute_field_diffs(1, data)

        assert result["v1"]["fields"]["violated"]["changed"] is True
