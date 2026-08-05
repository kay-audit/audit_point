"""Сервис аудит-лога и версионирования."""

import logging

from app.domains.acts.schemas.act_content import ActDataSchema
from app.domains.acts.repositories.act_content import ActContentRepository
from app.domains.acts.repositories.act_invoice import ActInvoiceRepository
from app.domains.acts.services.content_validation import (
    collect_validation_issues,
    status_from_issues,
)
from app.domains.acts.utils.html_sanitizer import sanitize_act_content_dict, sanitize_act_data

logger = logging.getLogger("audit_workstation.service.acts.audit_log")


class AuditLogService:
    """Операции аудит-лога: восстановление версий."""

    def __init__(self, guard, audit_repo, versions_repo, conn):
        self.guard = guard
        self.audit_repo = audit_repo
        self.versions_repo = versions_repo
        self.conn = conn

    async def restore_version(self, act_id: int, version_id: int, username: str) -> dict:
        """Восстанавливает содержимое акта из указанной версии.

        Перед перезаписью делает pre-snapshot текущего содержимого —
        закрывает lost-write: если активный редактор не успел сохранить
        свой state до restore, его последняя сохранённая версия остаётся
        в истории как отдельная запись и доступна для последующего
        восстановления.

        Три шага (pre-snapshot, перезапись, post-snapshot) идут в ОДНОЙ
        плоской транзакции (§9 зона 4): частичный сбой откатывает всё,
        история и контент не рассогласуются. Репозитории работают на этом
        же соединении без собственных транзакций. Аудит-лог пишется ПОСЛЕ
        коммита: батчер пишет вне нашей транзакции, поэтому изнутри блока
        запись о несостоявшемся восстановлении уехала бы в лог и при откате.
        """
        await self.guard.require_management_role(act_id, username)
        await self.guard.require_lock_owner(act_id, username)

        version = await self.versions_repo.get_version(act_id, version_id)
        if not version:
            from app.domains.acts.exceptions import ActNotFoundError
            raise ActNotFoundError(f"Версия {version_id} не найдена")

        content_repo = ActContentRepository(self.conn)

        restore_data = ActDataSchema(
            tree=version["tree_data"],
            tables=version.get("tables_data", {}),
            textBlocks=version.get("textblocks_data", {}),
            violations=version.get("violations_data", {}),
            saveType="manual",
        )

        # XSS-санитизация перед записью: запись идёт мимо
        # ActContentService.save_content, поэтому очищаем HTML-поля той же
        # утилитой, что и обычное сохранение. Иначе старая версия вернула бы
        # несанитизированный HTML в БД (stored XSS).
        sanitize_act_data(restore_data)

        invoice_repo = ActInvoiceRepository(self.conn)

        async with self.conn.transaction():
            # Pre-snapshot фиксирует РЕАЛЬНОЕ текущее содержимое акта ДО
            # перезаписи. get_content НЕ отдаёт фактуры (только tree/tables/
            # textBlocks/violations), поэтому текущие фактуры тянем напрямую из
            # репозитория и кладём в снимок отдельным словарём {node_id: реквизиты}.
            pre_rows = await invoice_repo.get_invoices_for_act(act_id)
            pre_restore_invoices = {r["node_id"]: r for r in pre_rows}

            # Сохраняем как auto-снимок — это не пользовательский save, значения
            # manual/periodic зарезервированы за явными действиями редактора
            # (см. saveType в ActDataSchema).
            current = await content_repo.get_content(act_id)
            if current:
                # pbe-6: pre-snapshot симметричен post-snapshot'у — HTML-поля
                # чистятся той же санитизацией (dict-форма), иначе restore
                # такого снимка вернул бы в БД несанитизированный HTML.
                sanitize_act_content_dict(current)
                await self.versions_repo.create_version(
                    act_id=act_id,
                    username=username,
                    save_type="auto",
                    tree=current.get("tree", {}),
                    tables=current.get("tables", {}),
                    textblocks=current.get("textBlocks", {}),
                    violations=current.get("violations", {}),
                    invoices=pre_restore_invoices,
                )

            # Заново прикрепляем фактуры восстанавливаемой версии: UPSERT по
            # (act_id, node_id). verification_status при этом сбрасывается в
            # 'pending' (решение владельца — восстановленная фактура требует
            # повторной верификации). Делаем ДО save_content, чтобы UPDATE-ветка
            # _sync_invoices нашла реальные строки, а не ушла в DELETE-всё.
            invoices_snapshot = version.get("invoices_data") or {}
            for node_id, inv in invoices_snapshot.items():
                await invoice_repo.save_invoice(
                    {
                        "act_id": act_id,
                        "node_id": node_id,
                        "node_number": inv.get("node_number"),
                        "db_type": inv.get("db_type"),
                        "schema_name": inv.get("schema_name"),
                        "table_name": inv.get("table_name"),
                        "metrics": inv.get("metrics"),
                        "process": inv.get("process"),
                        "profile_div": inv.get("profile_div"),
                    },
                    username,
                )
            # invoiceNodeIds = узлы снимка → _sync_invoices удалит фактуры узлов
            # вне снимка и освежит номера/аудит-поля оставшихся (вместо ветки
            # DELETE-всё на пустом списке, которая и стирала фактуры при restore).
            restore_data.invoiceNodeIds = list(invoices_snapshot.keys())

            # Пересчитываем состояние валидации из ВОССТАНОВЛЕННОГО содержимого
            # (тот же источник истины, что и обычное сохранение). Иначе restore
            # слепо сбрасывал бы статус в 'ok', даже если восстановлена дефектная
            # структура. collect_validation_issues работает по уже
            # санитизированному restore_data (санитайз структуру не меняет).
            restore_issues = collect_validation_issues(restore_data)
            restore_status = status_from_issues(restore_issues)
            await content_repo.save_content(
                act_id, restore_data, username,
                validation_status=restore_status,
                validation_issues=restore_issues,
            )

            # Реальное состояние фактур ПОСЛЕ restore перечитываем из репозитория
            # (как обычное сохранение): verification_status уже 'pending' после
            # save_invoice, номера/аудит-поля освежены _sync_invoices, лишние
            # удалены. Иначе снимок разошёлся бы с БД и дифф сразу после restore
            # показал бы фантомную смену статуса verified→pending.
            post_rows = await invoice_repo.get_invoices_for_act(act_id)
            post_restore_invoices = {r["node_id"]: r for r in post_rows}

            # Снимок после восстановления берём из уже санитизированного
            # restore_data, а не из сырых данных версии — иначе в историю
            # попал бы несанитизированный HTML, который при повторном restore
            # вернул бы stored XSS.
            await self.versions_repo.create_version(
                act_id=act_id,
                username=username,
                save_type="manual",
                tree=restore_data.tree,
                tables={tid: t.model_dump(mode="json") for tid, t in restore_data.tables.items()},
                textblocks={tid: t.model_dump(mode="json") for tid, t in restore_data.textBlocks.items()},
                violations={vid: v.model_dump(mode="json") for vid, v in restore_data.violations.items()},
                invoices=post_restore_invoices,
            )

        # Аудит — ПОСЛЕ коммита: батчер пишет вне нашей транзакции, поэтому при
        # rollback (сбой post-snapshot или самого коммита) запись о
        # восстановлении всё равно уехала бы в лог для несостоявшейся операции.
        await self.audit_repo.log("restore", username, act_id, {
            "from_version": version["version_number"],
            "version_id": version_id,
        })

        logger.info(
            f"Восстановлено содержимое акта ID={act_id} из версии "
            f"#{version['version_number']} пользователем {username}"
        )

        return {
            "success": True,
            "message": f"Содержимое восстановлено из версии #{version['version_number']}",
            "restored_version": version["version_number"],
        }
