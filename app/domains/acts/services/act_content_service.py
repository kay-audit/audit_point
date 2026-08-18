"""
Сервис содержимого актов.

Загрузка и сохранение содержимого: дерево, таблицы, текстблоки, нарушения.
"""

import logging
from datetime import datetime

from app.core.config import Settings
from app.db.types import DbConn
from app.domains.acts.block_types import (
    NODE_TYPE_TABLE,
    NODE_TYPE_TEXTBLOCK,
    NODE_TYPE_VIOLATION,
)
from app.domains.acts.exceptions import (
    AccessDeniedError,
    ActValidationError,
    ContentConflictError,
)
from app.domains.acts.repositories.act_access import ActAccessRepository
from app.domains.acts.repositories.act_crud import ActCrudRepository
from app.domains.acts.repositories.act_content import ActContentRepository
from app.domains.acts.repositories.act_invoice import ActInvoiceRepository
from app.domains.acts.repositories.act_audit_log import ActAuditLogRepository
from app.domains.acts.repositories.act_content_version import ActContentVersionRepository
from app.domains.acts.repositories.act_lock import ActLockRepository
from app.domains.acts.schemas.act_content import ActDataSchema
from app.domains.acts.services.access_guard import AccessGuard
from app.domains.acts.services.content_validation import (
    collect_validation_issues,
    status_from_issues,
)
from app.domains.acts.settings import ActsSettings
from app.domains.acts.utils.html_sanitizer import sanitize_act_data, sanitize_tree_nodes

logger = logging.getLogger("audit_workstation.service.acts.content")


def _normalize_updated_at(value: datetime) -> datetime:
    """Нормализует метку для optimistic-сравнения: tz-суффикс отбрасывается.

    acts.updated_at — TIMESTAMP без таймзоны: asyncpg отдаёт naive datetime,
    pydantic сериализует его наивной ISO-строкой (с микросекундами), фронт
    возвращает её эхом — обе стороны сравнения naive и совпадают побитово.
    Если клиентский путь добавил tz-суффикс к той же wall-clock строке,
    суффикс отбрасывается БЕЗ конвертации: значение из БД и есть это
    wall-clock время, перевод в другую зону исказил бы его.
    """
    return value.replace(tzinfo=None) if value.tzinfo is not None else value


class ActContentService:
    """Загрузка и сохранение содержимого актов."""

    def __init__(
        self,
        conn: DbConn,
        settings: Settings,
        acts_settings: ActsSettings,
        *,
        access: ActAccessRepository | None = None,
        lock: ActLockRepository | None = None,
        crud: ActCrudRepository | None = None,
        content: ActContentRepository | None = None,
        invoice: ActInvoiceRepository | None = None,
    ):
        self.conn = conn
        self.settings = settings
        self.acts_settings = acts_settings
        self._access = access or ActAccessRepository(conn)
        self._lock = lock or ActLockRepository()
        self._crud = crud or ActCrudRepository(conn)
        self._content = content or ActContentRepository(conn)
        self._invoice = invoice or ActInvoiceRepository(conn)
        self.guard = AccessGuard(self._access, self._lock)
        self._audit = ActAuditLogRepository(conn)
        self._versions = ActContentVersionRepository(conn)

    async def get_content(self, act_id: int, username: str) -> dict:
        """
        Загружает полное содержимое акта для редактора.

        Оркестрирует 4 репозитория: crud (метаданные), content (дерево,
        таблицы, текстблоки, нарушения), invoice (фактуры), access (права).
        """
        permission = await self._access.get_user_edit_permission(act_id, username)
        if not permission["has_access"]:
            raise AccessDeniedError("Нет доступа к акту")

        act_metadata = await self._crud.get_act_by_id(act_id)
        content = await self._content.get_content(act_id)

        invoices_list = await self._invoice.get_invoices_for_act(act_id)
        invoices = {inv["node_id"]: inv for inv in invoices_list}

        logger.info(
            f"Загружено содержимое акта ID={act_id}, "
            f"КМ={act_metadata.km_number}, is_process_based={act_metadata.is_process_based}"
        )

        return {
            "metadata": act_metadata.model_dump(mode="json"),
            **content,
            "invoices": invoices,
            "userPermission": {
                "canEdit": permission["can_edit"],
                "role": permission["role"],
            },
        }

    async def save_content(self, act_id: int, data: ActDataSchema, username: str) -> dict:
        """Сохраняет содержимое акта.

        Запись контента, diff и снимок версии идут в ОДНОЙ плоской
        транзакции (§9 зона 4): сбой на любом шаге откатывает всё — контент
        не записывается частично, история версий не рассогласуется.
        Вложенных transaction()/savepoint'ов нет (Greenplum): репозитории
        работают на этом же соединении и собственных транзакций не открывают.
        Аудит-лог пишется ПОСЛЕ коммита (как в ActCrudService.delete_act):
        активный батчер пишет своим соединением, вне нашей транзакции, поэтому
        изнутри блока запись о несостоявшемся сохранении уехала бы в лог и при
        откате (phantom-запись в пользовательской истории акта).
        """
        await self.guard.require_edit_permission(act_id, username)
        await self.guard.require_lock_owner(act_id, username)

        # Валидация дерева перед сохранением
        self._validate_tree(data)

        # XSS-санитизация всех HTML-полей (textBlocks/violations/дерево)
        # перед записью в БД. Whitelist в utils/html_sanitizer.py.
        self._sanitize_html_fields(data)

        # Мягкая чистка рассогласования дерево ↔ словари (решение «lenient»,
        # обе стороны). Листовые узлы-зомби с висячей ссылкой удаляются ЦЕЛИКОМ
        # ДО diff/сохранения — сохраняемое дерево не ссылается на потерянный
        # контент и не оставляет пустых блоков в экспорте.
        stripped_refs = self._strip_dangling_refs(data)

        # Состояние структурной валидации (фича #8): бэк — источник истины.
        # WIP-сохранение НЕ блокируется (в отличие от старого фронт-гейта):
        # акт сохраняется и помечается статусом, конкретику покажут карточка
        # и уведомления. _validate_tree выше всё ещё бросает на жёстких
        # дефектах (нет корня/превышена глубина) — их сохранить нельзя.
        validation_issues = collect_validation_issues(data)
        validation_status = status_from_issues(validation_issues)

        async with self.conn.transaction():
            # Optimistic-проверка конкурентного редактирования (две вкладки
            # одного пользователя, перехват истёкшего лока — сценарии, которые
            # Redis-лок не закрывает). Чтение метки — SELECT ... FOR UPDATE
            # внутри этой же транзакции: конкурирующее сохранение ждёт нашего
            # коммита и видит уже свежий updated_at.
            if data.expected_updated_at is not None:
                await self._check_content_conflict(act_id, data.expected_updated_at)

            # Вычисляем diff ДО сохранения
            diff = await self._audit.compute_content_diff(act_id, data)
            diff["save_type"] = data.saveType

            # Вычисляем field-level diff для изменённых элементов
            audit_log_cfg = self.acts_settings.audit_log
            field_changes = await self._audit.compute_field_diffs(
                act_id,
                data,
                max_elements=audit_log_cfg.max_diff_elements,
                max_cells_per_table=audit_log_cfg.max_diff_cells_per_table,
            )
            if field_changes:
                diff["field_changes"] = field_changes

            # Сохраняем содержимое; репозиторий возвращает число записей
            # словарей, отброшенных orphan-фильтром (нет узла-владельца).
            result = await self._content.save_content(
                act_id, data, username,
                validation_status=validation_status,
                validation_issues=validation_issues,
            )

            # Создаём снэпшот версии только для manual/periodic
            if data.saveType in ("manual", "periodic"):
                # Фактуры в снимок берём из БД (act_invoices уже синхронизированы
                # save_content выше через _sync_invoices) как {node_id: реквизиты}
                # — та же форма, что поле invoices в GET /acts/{id}/content, чтобы
                # обе стороны диффа версий были структурно одинаковыми.
                invoices_list = await self._invoice.get_invoices_for_act(act_id)
                invoices_snapshot = {inv["node_id"]: inv for inv in invoices_list}
                await self._versions.create_version(
                    act_id=act_id,
                    username=username,
                    save_type=data.saveType,
                    tree=data.tree,
                    tables={tid: t.model_dump(mode="json") for tid, t in data.tables.items()},
                    textblocks={tid: t.model_dump(mode="json") for tid, t in data.textBlocks.items()},
                    violations={vid: v.model_dump(mode="json") for vid, v in data.violations.items()},
                    invoices=invoices_snapshot,
                    max_versions=self.acts_settings.audit_log.max_content_versions,
                )

        # Аудит — ПОСЛЕ коммита: батчер пишет вне нашей транзакции, поэтому при
        # rollback (сбой снимка версии или самого коммита) запись о сохранении
        # всё равно уехала бы в лог для несостоявшейся операции. Логируем
        # только реально записанное содержимое.
        await self._audit.log("content_save", username, act_id, diff, changelog=data.changelog)

        # Одно предупреждение, если что-то вычищено в любую из сторон:
        # stripped_refs — снятые висячие ссылки узлов, dropped_orphans —
        # записи словарей без узла-владельца. null, если чистить было нечего.
        dropped_orphans = result.pop("dropped_orphans", 0)
        result["warning"] = self._build_cleanup_warning(stripped_refs, dropped_orphans)
        result["validation_status"] = validation_status
        result["validation_issues"] = validation_issues

        # Структурный статус акта (error/warning) НЕ создаёт персистентного
        # уведомления. На лендинге его показывает серверная сводка attention
        # (GET /acts/attention-summary, колокольчик), внутри акта — живой
        # источник validation. Прежний error-push дублировал эту сводку и при
        # каждом ручном сохранении плодил записи (INSERT без дедупликации) —
        # поэтому убран. Toast о статусе остаётся на фронте (api.js).
        return result

    async def _check_content_conflict(self, act_id: int, expected: datetime) -> None:
        """Сверяет expected_updated_at клиента с текущим acts.updated_at.

        Расхождение означает, что с момента загрузки клиентского состояния
        акт сохранил кто-то другой — бросаем ContentConflictError (409),
        транзакция откатывается, ничего не записано. Сравнение точное, до
        микросекунд (round-trip через pydantic их сохраняет); tz-семантика —
        см. _normalize_updated_at.
        """
        stamp = await self._crud.get_edit_stamp(act_id)
        current = stamp["updated_at"]
        if current is not None and (
            _normalize_updated_at(expected) == _normalize_updated_at(current)
        ):
            return
        last_edited_at = stamp["last_edited_at"]
        raise ContentConflictError(
            "Содержимое акта изменено с момента загрузки — сохранение отклонено",
            current_updated_at=current.isoformat() if current else None,
            last_edited_by=stamp["last_edited_by"],
            last_edited_at=last_edited_at.isoformat() if last_edited_at else None,
        )

    def _strip_dangling_refs(self, data: ActDataSchema) -> int:
        """Удаляет листовые узлы-зомби с висячей ссылкой на отсутствующую запись.

        Узел-лист (table/textBlock/violation), чья ссылка
        (tableId/textBlockId/violationId) указывает на запись, которой нет в
        словаре, удаляется из дерева ЦЕЛИКОМ — снять только поле-ссылку мало:
        остался бы бессодержательный узел, который walker экспорта всё равно
        отрисует (пустая «Таблица N»), а пересохранение его не вычистит
        (висячей ссылки уже нет). Зеркалит act-content-sanitizer.js на фронте.

        Удаляем безусловно: нефункциональный лист — мусор независимо от
        protected/deletable; защищённые секции 1–5 имеют type='item' и
        листовых ссылок не несут, поэтому под удаление не попадают. Возвращает
        число удалённых узлов (для предупреждения пользователю).
        """
        dangling = data.collect_dangling_refs()
        if not dangling:
            return 0

        # Группируем по (node_id, ref_field) → набор «висячих» значений ссылок.
        to_strip: dict[tuple[str | None, str], set[str]] = {}
        for node_id, ref_field, ref in dangling:
            to_strip.setdefault((node_id, ref_field), set()).add(ref)

        def _is_zombie(node: dict) -> bool:
            node_id = node.get("id")
            for (target_id, ref_field), refs in to_strip.items():
                if node_id == target_id and node.get(ref_field) in refs:
                    return True
            return False

        # Обходим с родителями; узел-зомби вырезаем из children родителя.
        # Корень не проверяется (ссылок не несёт) — только его поддерево.
        removed = 0
        stack = [data.tree] if data.tree else []
        while stack:
            node = stack.pop()
            children = node.get("children")
            if not isinstance(children, list) or not children:
                continue
            kept = [child for child in children if not _is_zombie(child)]
            if len(kept) != len(children):
                removed += len(children) - len(kept)
                node["children"] = kept
            stack.extend(kept)
        return removed

    @staticmethod
    def _build_cleanup_warning(stripped_refs: int, dropped_orphans: int) -> str | None:
        """Собирает одно русскоязычное предупреждение о вычищенных рассогласованиях.

        null, если ничего не чистилось. Нулевую половину опускаем.
        """
        if not stripped_refs and not dropped_orphans:
            return None
        parts: list[str] = []
        if stripped_refs:
            parts.append(f"висячих ссылок: {stripped_refs}")
        if dropped_orphans:
            parts.append(f"записей без узла: {dropped_orphans}")
        return "Очищено рассогласование дерево ↔ словари (" + ", ".join(parts) + ")"

    def _sanitize_html_fields(self, data: ActDataSchema) -> None:
        """
        Чистит все HTML-поля до безопасного подмножества тегов/атрибутов.

        Делегирует в utils/html_sanitizer.sanitize_act_data — общая логика
        переиспользуется при восстановлении версий (AuditLogService).
        """
        sanitize_act_data(data)

    def _sanitize_tree_nodes(self, node: dict) -> None:
        """Рекурсивно чистит content в узлах дерева (узлы хранятся как dict)."""
        sanitize_tree_nodes(node)

    def _validate_tree(self, data: ActDataSchema) -> None:
        """Проверяет структуру дерева перед сохранением.

        Глубина и лимиты числа блоков-детей одного узла (B-13 текстблоки, #7
        нарушения и таблицы) считаются за ОДИН обход дерева (#14 код-ревью —
        раньше на каждое сохранение дерево обходилось 4 раза). Фронт
        ограничивает добавление блоков узлу, но paste/drag/undo и прямой API
        эти проверки обходили — считаем детей нужного type у каждого узла
        дерева, паритет с фронт-гейтами вставки.

        Порядок ошибок сохранён как при последовательных проверках: глубина →
        корневой id → текстблоки → нарушения → таблицы.
        """
        tree = data.tree
        if not tree:
            return

        # (node_type, лимит-на-узел, подпись для сообщения об ошибке)
        type_limits = (
            (NODE_TYPE_TEXTBLOCK, self.acts_settings.textblocks.per_node, "текстовых блоков"),
            (NODE_TYPE_VIOLATION, self.acts_settings.violations.per_node, "нарушений"),
            (NODE_TYPE_TABLE, self.acts_settings.tables.per_node, "таблиц"),
        )
        # Типы с несконфигурированным (не int) лимитом — лимит не применяем
        # (настройки не заданы или замоканы в тестах; в проде per_node всегда
        # int из ACTS__*__PER_NODE).
        active_limits = {
            node_type: max_per_node
            for node_type, max_per_node, _label in type_limits
            if isinstance(max_per_node, int)
        }

        max_depth = 0
        # Первое превышение лимита на узел по каждому типу, в порядке обхода
        # (stack.pop() + stack.extend) — совпадает с порядком прежних раздельных
        # проходов, т.к. порядок посещения узлов не зависит от node_type.
        first_over_limit: dict[str, int] = {}
        stack = [(tree, 0)]
        while stack:
            node, depth = stack.pop()
            if depth > max_depth:
                max_depth = depth
            children = node.get("children")
            if not isinstance(children, list):
                continue
            if active_limits:
                counts: dict[str, int] = {}
                for child in children:
                    if not isinstance(child, dict):
                        continue
                    child_type = child.get("type")
                    if child_type in active_limits:
                        counts[child_type] = counts.get(child_type, 0) + 1
                for node_type, count in counts.items():
                    if count > active_limits[node_type] and node_type not in first_over_limit:
                        first_over_limit[node_type] = count
            stack.extend((child, depth + 1) for child in children)

        # Проверка глубины
        if max_depth > self.acts_settings.resource.max_tree_depth:
            raise ActValidationError(
                f"Глубина дерева ({max_depth}) превышает максимум ({self.acts_settings.resource.max_tree_depth})"
            )

        # Проверка наличия корневого узла
        if not tree.get('id'):
            raise ActValidationError("Дерево должно иметь корневой узел с id")

        for node_type, max_per_node, item_label in type_limits:
            if node_type in first_over_limit:
                count = first_over_limit[node_type]
                raise ActValidationError(
                    f"Узел содержит слишком много {item_label} "
                    f"({count}), максимум — {max_per_node}"
                )
