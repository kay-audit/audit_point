"""
Сервис CRUD операций с актами.

Создание, чтение, обновление, удаление, дублирование актов.
"""

import logging
import re
import uuid
from datetime import datetime

import asyncpg

from app.core.config import Settings
from app.db.types import DbConn
from app.domains.acts.exceptions import (
    ActLockError,
    ActValidationError,
    KmConflictError,
)
from app.domains.acts.utils import KMUtils, ActDirectivesValidator
from app.domains.acts.schemas.act_metadata import (
    ActAttentionItem,
    ActCreate,
    ActListItem,
    ActResponse,
    ActUpdate,
    AuditTeamMember,
)
from app.services.audit_id_service import AuditIdService
from app.domains.acts.repositories.act_content import ActContentRepository
from app.domains.acts.repositories.act_crud import ActCrudRepository
from app.domains.acts.repositories.act_lock import ActLockRepository
from app.domains.acts.repositories.act_access import ActAccessRepository
from app.domains.acts.repositories.act_audit_log import ActAuditLogRepository
from app.domains.acts.services.access_guard import AccessGuard
from app.domains.acts.services.notifications_producer import emit_act_notification

logger = logging.getLogger("audit_workstation.service.acts.crud")

PLACEHOLDER_USERNAME = "00000000"
PLACEHOLDER_FULL_NAME = "Требуется назначить"


class ActCrudService:
    """CRUD операции с актами."""

    def __init__(
        self,
        conn: DbConn,
        settings: Settings,
        *,
        crud: ActCrudRepository | None = None,
        lock: ActLockRepository | None = None,
        access: ActAccessRepository | None = None,
    ):
        self.conn = conn
        self.settings = settings
        self._crud = crud or ActCrudRepository(conn)
        self._lock = lock or ActLockRepository()
        self._access = access or ActAccessRepository(conn)
        self.guard = AccessGuard(self._access, self._lock)
        self._audit = ActAuditLogRepository(conn)

    # -------------------------------------------------------------------------
    # Константы для перестройки дерева при смене типа проверки
    # -------------------------------------------------------------------------

    _SECTION_1_LABELS = {
        True: "Информация о процессе, клиентском пути",
        False: "Характеристика проверяемого направления",
    }

    # Источник правды: static/js/shared/app-config.js → content.tablePresets.qualityAssessment
    _QUALITY_ASSESSMENT_PRESET = {
        "headers": [
            "Процесс",
            "Количество проверенных экземпляров области проверки процесса, шт",
            "Общее количество отклонений, шт",
            "Уровень отклонений, %",
        ],
        "rows": 2,
        "cols": 4,
        "col_widths": [150, 200, 150, 100],
    }

    # -------------------------------------------------------------------------
    # Перестройка дерева при смене типа проверки
    # -------------------------------------------------------------------------

    @staticmethod
    def restructure_sections_for_type_change(
        tree_data: dict,
        *,
        new_is_process_based: bool,
    ) -> dict:
        """Перестраивает разделы 1-2 дерева при смене типа проверки.

        Разделы 1 и 2 очищаются, label раздела 1 обновляется.
        При переходе к процессной проверке в раздел 2 добавляется
        таблица qualityAssessment. Разделы 3-5 не затрагиваются.

        ВАЖНО: мутирует переданный tree_data in-place.

        Args:
            tree_data: текущее дерево акта (dict с id, label, children).
            new_is_process_based: новый тип проверки.

        Returns:
            dict с ключами:
                - tree: обновлённое дерево (тот же объект, что и tree_data)
                - content_ids_to_delete: {table_ids, textblock_ids, violation_ids}
                - tables_to_insert: список данных таблиц для вставки в БД
        """
        ids: dict[str, list[str]] = {
            "table_ids": [],
            "textblock_ids": [],
            "violation_ids": [],
        }
        tables_to_insert: list[dict] = []

        for child in tree_data.get("children", []):
            if child.get("id") not in ("1", "2"):
                continue

            # Рекурсивно собираем ID содержимого для удаления
            ActCrudService._collect_content_ids(
                child.get("children", []), ids,
            )

            if child["id"] == "1":
                child["label"] = ActCrudService._SECTION_1_LABELS[
                    new_is_process_based
                ]
                child["children"] = []

            elif child["id"] == "2":
                child["children"] = []
                if new_is_process_based:
                    qa_node, qa_table_data = (
                        ActCrudService._make_quality_assessment_table(
                            parent_id="2",
                        )
                    )
                    child["children"] = [qa_node]
                    tables_to_insert.append(qa_table_data)

        return {
            "tree": tree_data,
            "content_ids_to_delete": ids,
            "tables_to_insert": tables_to_insert,
        }

    @staticmethod
    def _collect_content_ids(
        nodes: list[dict],
        ids: dict[str, list[str]],
    ) -> None:
        """Рекурсивно собирает tableId / textBlockId / violationId из узлов."""
        for node in nodes:
            if "tableId" in node:
                ids["table_ids"].append(node["tableId"])
            if "textBlockId" in node:
                ids["textblock_ids"].append(node["textBlockId"])
            if "violationId" in node:
                ids["violation_ids"].append(node["violationId"])
            ActCrudService._collect_content_ids(
                node.get("children", []), ids,
            )

    @staticmethod
    def _make_quality_assessment_table(
        parent_id: str,
    ) -> tuple[dict, dict]:
        """Создаёт узел дерева и данные таблицы qualityAssessment.

        Returns:
            (tree_node, table_data) — узел для вставки в children
            и данные таблицы для вставки в БД.
        """
        preset = ActCrudService._QUALITY_ASSESSMENT_PRESET
        table_id = f"table_{uuid.uuid4().hex[:12]}"
        node_id = f"{parent_id}_qa_{table_id}"

        # Узел дерева (формат совпадает с state-core.js _createTableNode)
        tree_node = {
            "id": node_id,
            "label": "Таблица",
            "type": "table",
            "tableId": table_id,
            "parentId": parent_id,
            "protected": True,
            "deletable": False,
            "customLabel": "",
        }

        # Grid: 2D массив ячеек (формат совпадает с state-core.js _createTableGrid)
        grid = []
        header_row = [
            {
                "content": h, "isHeader": True,
                "colSpan": 1, "rowSpan": 1,
                "originRow": 0, "originCol": c,
            }
            for c, h in enumerate(preset["headers"])
        ]
        grid.append(header_row)
        for r in range(1, preset["rows"] + 1):
            data_row = [
                {
                    "content": "", "isHeader": False,
                    "colSpan": 1, "rowSpan": 1,
                    "originRow": r, "originCol": c,
                }
                for c in range(preset["cols"])
            ]
            grid.append(data_row)

        table_data = {
            "table_id": table_id,
            "node_id": node_id,
            "label": tree_node["label"],
            "grid": grid,
            "col_widths": preset["col_widths"],
            "protected": True,
            "deletable": False,
        }

        return tree_node, table_data

    # -------------------------------------------------------------------------
    # SIMPLE CRUD
    # -------------------------------------------------------------------------

    async def list_acts(
        self,
        username: str,
        *,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[ActListItem], int]:
        """Получает страницу актов пользователя и общее количество.

        Признак блокировки БД не знает (блокировки живут в ключах с TTL) —
        страница дообогащается одним batch-чтением хранилища блокировок.
        """
        total = await self._crud.count_user_acts(username)
        acts = await self._crud.get_user_acts(
            username, limit=limit, offset=offset,
        )
        locks = await self._locks_for([act.id for act in acts])
        for act in acts:
            lock = locks.get(act.id)
            if lock is not None:
                act.is_locked = True
                act.locked_by = lock["locked_by"]
        logger.info(
            "Получен список актов для %s: %s из %s (limit=%s, offset=%s)",
            username, len(acts), total, limit, offset,
        )
        return acts, total

    async def get_attention_summary(self, username: str) -> list[ActAttentionItem]:
        """Сводка «мои акты, требующие внимания» для колокольчика лендинга.

        Серверный пересчёт по ВСЕМ актам пользователя (не по загруженной
        странице): акты с незакрытыми требованиями или структурной валидацией
        не 'ok'. Read-only, без пагинации — фронт получает уже отфильтрованный
        список и не сканирует сотни актов на клиенте.

        Заблокированные акты из сводки исключаются: пока акт кто-то правит,
        напоминать по нему нечего. Фильтр применяется после выборки — раньше
        он стоял в WHERE, но блокировки уехали из БД в ключи с TTL.
        """
        items = await self._crud.get_user_acts_needing_attention(username)
        locks = await self._locks_for([item.id for item in items])
        return [item for item in items if item.id not in locks]

    async def _locks_for(self, act_ids: list[int]) -> dict[int, dict]:
        """Состояния блокировок для списка актов; при сбое хранилища — пусто.

        Fail-open сознателен: это чтение, и потерянный признак «занят» никому
        ничего не разрешает — арбитром остаётся сервер, а захват и сохранение
        при недоступном хранилище блокировок упадут сами.
        """
        try:
            return await self._lock.bulk_lock_info(act_ids)
        except Exception as e:
            logger.warning("Не удалось прочитать блокировки актов: %s", e)
            return {}

    async def get_act(self, act_id: int, username: str) -> ActResponse:
        """Получает полную информацию об акте."""
        await self.guard.require_access(act_id, username)
        return await self._crud.get_act_by_id(act_id)

    async def delete_act(self, act_id: int, username: str) -> dict:
        """Удаляет акт и все связанные данные."""
        await self.guard.require_edit_permission(act_id, username)

        async with self.conn.transaction():
            act = await self._crud.get_act_by_id(act_id)

            # Проверяем что акт не заблокирован другим пользователем
            lock_info = await self._lock.get_lock_info(act_id)
            if (
                lock_info
                and lock_info["locked_by"]
                and lock_info["locked_by"] != username
            ):
                raise ActLockError(
                    f"Акт заблокирован пользователем {lock_info['locked_by']}",
                    locked_by=lock_info["locked_by"],
                    locked_until=str(lock_info["lock_expires_at"]),
                )

            km_digit = KMUtils.extract_km_digits(act.km_number)

            await self._crud.delete_by_id(act_id)
            await self._crud.update_total_parts_for_km(km_digit)

            logger.info(
                f"Удален акт ID={act_id} (КМ={act.km_number}, "
                f"часть {act.part_number}) пользователем {username}"
            )

        # Аудит — ПОСЛЕ коммита: батчер пишет вне нашей транзакции, поэтому при
        # rollback запись об удалении не попала бы в лог для несостоявшейся
        # операции (phantom). Логируем только реально выполненное удаление.
        await self._audit.log("delete", username, act_id, {
            "km_number": act.km_number,
            "part_number": act.part_number,
        })

        return {"success": True, "message": "Акт успешно удален"}

    async def check_km_exists(self, km_number: str) -> dict[str, object]:
        """Проверяет существование актов с данным КМ номером."""
        return await self._crud.check_km_exists(km_number)

    async def generate_audit_point_ids(
        self, act_id: int, node_ids: list[str], username: str,
    ) -> dict[str, str]:
        """Генерирует audit_point_id для списка узлов дерева акта."""
        await self.guard.require_access(act_id, username)
        return await AuditIdService.generate_audit_point_ids(node_ids)

    # -------------------------------------------------------------------------
    # CREATE ACT
    # -------------------------------------------------------------------------

    async def create_act(
        self, act_data: ActCreate, username: str, force_new_part: bool = False,
    ) -> ActResponse:
        """Создает новый акт с метаданными, аудиторской группой и поручениями."""
        async with self.conn.transaction():
            km_digit = KMUtils.extract_km_digits(act_data.km_number)
            km_info = await self._crud.check_km_exists(act_data.km_number)

            if act_data.service_note:
                suffix = KMUtils.extract_service_note_suffix(act_data.service_note)
                if not suffix or not suffix.isdigit():
                    raise ActValidationError(
                        f"Некорректный формат служебной записки: {act_data.service_note}"
                    )
                part_number = int(suffix)

                is_unique = await self._crud.check_km_part_uniqueness(km_digit, part_number)
                if not is_unique:
                    raise KmConflictError(
                        f"Акт с КМ (цифры) {km_digit} и частью {part_number} уже существует",
                        km_number=act_data.km_number,
                        current_parts=km_info["current_parts"],
                        next_part=part_number,
                    )
            else:
                if km_info["exists"] and force_new_part:
                    part_number = km_info["next_part_no_sn"]
                elif km_info["exists"] and not force_new_part:
                    raise KmConflictError(
                        f"Акт с КМ '{act_data.km_number}' уже существует",
                        km_number=act_data.km_number,
                        current_parts=km_info["current_parts"],
                        next_part=km_info["next_part"],
                    )
                else:
                    part_number = 1

            total_parts = km_info["total_parts"] + 1

            user_in_team = any(
                member.username == username for member in act_data.audit_team
            )
            if not user_in_team:
                raise ActValidationError("Пользователь должен быть членом аудиторской группы")

            audit_act_id = await AuditIdService.generate_audit_act_id()

            try:
                act_id = await self._crud.insert_act(
                    km_number=act_data.km_number,
                    km_digit=km_digit,
                    part_number=part_number,
                    total_parts=total_parts,
                    inspection_name=act_data.inspection_name,
                    city=act_data.city,
                    created_date=act_data.created_date,
                    order_number=act_data.order_number,
                    order_date=act_data.order_date,
                    is_process_based=act_data.is_process_based,
                    service_note=act_data.service_note,
                    service_note_date=act_data.service_note_date,
                    audit_act_id=audit_act_id,
                    created_by=username,
                    inspection_start_date=act_data.inspection_start_date,
                    inspection_end_date=act_data.inspection_end_date,
                )
            except asyncpg.UniqueViolationError:
                raise KmConflictError(
                    f"Акт с КМ (цифры) {km_digit} и частью {part_number} уже существует "
                    f"(параллельное создание)",
                    km_number=act_data.km_number,
                    current_parts=km_info["current_parts"],
                    next_part=part_number,
                )

            await self._crud.insert_team_members_batch(
                act_id, audit_act_id, act_data.audit_team
            )
            await self._crud.insert_directives_batch(
                act_id, audit_act_id, act_data.directives
            )

            default_tree = {
                "id": "root",
                "label": act_data.inspection_name or "Акт",
                "children": [],
            }
            await self._crud.insert_default_tree(act_id, default_tree)

            await self._crud.update_total_parts_for_km(km_digit)

            logger.info(
                f"Создан акт ID={act_id}, КМ={act_data.km_number}, "
                f"часть {part_number}/{total_parts}, СЗ={act_data.service_note}"
            )

            result = await self._crud.get_act_by_id(act_id)

        # Аудит — ПОСЛЕ коммита (батчер пишет вне нашей транзакции): при откате
        # транзакции не остаётся записи о создании несостоявшегося акта.
        await self._audit.log("create", username, act_id, {
            "km_number": act_data.km_number,
            "part_number": part_number,
        })

        # Уведомление о создании акта — после успешного коммита, адресно
        # инициатору (создателю). Сбой/отсутствие notifications не ломает
        # создание акта (логика обёрнута в try/except внутри хелпера).
        await emit_act_notification(
            title=f"Создан акт {act_data.km_number}",
            severity="success",
            link=f"/constructor?act_id={act_id}",
            recipient_user_id=username,
        )

        return result

    # -------------------------------------------------------------------------
    # UPDATE METADATA
    # -------------------------------------------------------------------------

    async def update_act_metadata(
        self, act_id: int, act_update: ActUpdate, username: str,
    ) -> ActResponse:
        """Обновляет метаданные акта (частичное обновление)."""
        await self.guard.require_edit_permission(act_id, username)

        sent_fields = act_update.model_fields_set

        async with self.conn.transaction():
            current_act = await self._crud.get_act_by_id_for_update(act_id)
            old_km_digit = KMUtils.extract_km_digits(current_act.km_number)

            cur_audit_act_id = await self._crud.get_audit_act_id(act_id)

            tree_data = None
            if act_update.directives is not None:
                tree_data = await self._crud.validate_directives_points(
                    act_id, act_update.directives
                )

            # Валидация дат проверки (с учётом частичного обновления)
            effective_start = (
                act_update.inspection_start_date
                if "inspection_start_date" in sent_fields and act_update.inspection_start_date is not None
                else current_act.inspection_start_date
            )
            effective_end = (
                act_update.inspection_end_date
                if "inspection_end_date" in sent_fields and act_update.inspection_end_date is not None
                else current_act.inspection_end_date
            )
            if effective_start and effective_end and effective_end < effective_start:
                raise ActValidationError(
                    "Дата окончания проверки не может быть раньше даты начала"
                )

            # Валидация КМ, служебной записки, номера части
            new_km_digit, new_part_number, km_changed = await self._validate_km_and_part(
                act_id, act_update, current_act, sent_fields, old_km_digit,
            )

            # Формирование SQL UPDATE
            updates, values = self._build_update_query(
                act_update, current_act, sent_fields,
                new_km_digit, new_part_number, km_changed, username,
            )
            await self._crud.execute_update(act_id, updates, values)

            # Перестройка разделов 1-2 при смене типа проверки
            if (
                "is_process_based" in sent_fields
                and act_update.is_process_based is not None
                and act_update.is_process_based != current_act.is_process_based
            ):
                await self._apply_tree_restructure(
                    act_id, act_update.is_process_based,
                )

            # Замена команды и поручений
            await self._sync_team_and_directives(
                act_id, cur_audit_act_id, act_update, tree_data,
            )

            # Обновление total_parts
            if km_changed:
                await self._crud.update_total_parts_for_km(old_km_digit)
            await self._crud.update_total_parts_for_km(new_km_digit)

            logger.info(f"Обновлены метаданные акта ID={act_id}")

            # Аудит-лог
            await self._log_metadata_changes(
                act_id, username, act_update, current_act, sent_fields,
            )

            return await self._crud.get_act_by_id(act_id)

    async def _validate_km_and_part(
        self,
        act_id: int,
        act_update: ActUpdate,
        current_act: ActResponse,
        sent_fields: set[str],
        old_km_digit: str,
    ) -> tuple[str, int, bool]:
        """Валидация КМ-номера, служебной записки и номера части.

        Returns:
            (new_km_digit, new_part_number, km_changed)
        """
        km_changed = (
            "km_number" in sent_fields
            and act_update.km_number is not None
            and act_update.km_number != current_act.km_number
        )
        service_note_changed = (
            "service_note" in sent_fields
            and act_update.service_note is not None
            and act_update.service_note != current_act.service_note
        )
        service_note_removed = (
            "service_note" in sent_fields
            and act_update.service_note is None
            and current_act.service_note is not None
        )

        new_km_digit = (
            KMUtils.extract_km_digits(act_update.km_number)
            if act_update.km_number
            else old_km_digit
        )

        new_part_number = current_act.part_number

        if service_note_changed or service_note_removed:
            if act_update.service_note:
                suffix = KMUtils.extract_service_note_suffix(act_update.service_note)
                if not suffix or not suffix.isdigit():
                    raise ActValidationError(
                        f"Некорректный формат служебной записки: {act_update.service_note}"
                    )
                new_part_number = int(suffix)
            else:
                new_part_number = await self._crud.find_free_part_number(
                    new_km_digit, act_id
                )
                act_update.service_note = None
                act_update.service_note_date = None

        if km_changed and not (service_note_changed or service_note_removed):
            if current_act.service_note or act_update.service_note:
                if act_update.part_number is not None:
                    new_part_number = act_update.part_number
            else:
                new_part_number = await self._crud.find_free_part_number(
                    new_km_digit, act_id
                )

        if (
            km_changed
            or service_note_changed
            or service_note_removed
            or (act_update.part_number is not None)
        ):
            is_unique = await self._crud.check_km_part_uniqueness(
                new_km_digit, new_part_number, exclude_act_id=act_id
            )
            if not is_unique:
                raise KmConflictError(
                    f"Акт с КМ (цифры) {new_km_digit} и частью {new_part_number} уже существует",
                    km_number=act_update.km_number or current_act.km_number,
                )

        return new_km_digit, new_part_number, km_changed

    @staticmethod
    def _build_update_query(
        act_update: ActUpdate,
        current_act: ActResponse,
        sent_fields: set[str],
        new_km_digit: str,
        new_part_number: int,
        km_changed: bool,
        username: str,
    ) -> tuple[list[str], list]:
        """Формирование динамического SQL UPDATE с diff полей.

        Returns:
            (updates, values) — список SET-фрагментов и параметров
        """
        updates: list[str] = []
        values: list = []
        param_idx = 1

        service_note_changed = (
            "service_note" in sent_fields
            and act_update.service_note is not None
            and act_update.service_note != current_act.service_note
        )
        service_note_removed = (
            "service_note" in sent_fields
            and act_update.service_note is None
            and current_act.service_note is not None
        )

        def _add(col, val):
            nonlocal param_idx
            updates.append(f"{col} = ${param_idx}")
            values.append(val)
            param_idx += 1

        if "km_number" in sent_fields and act_update.km_number is not None:
            _add("km_number", act_update.km_number)
            _add("km_number_digit", new_km_digit)
        if new_part_number != current_act.part_number:
            _add("part_number", new_part_number)
        if "inspection_name" in sent_fields and act_update.inspection_name is not None:
            _add("inspection_name", act_update.inspection_name)
        if "city" in sent_fields and act_update.city is not None:
            _add("city", act_update.city)
        if "created_date" in sent_fields:
            _add("created_date", act_update.created_date)
        if "order_number" in sent_fields and act_update.order_number is not None:
            _add("order_number", act_update.order_number)
        if "order_date" in sent_fields and act_update.order_date is not None:
            _add("order_date", act_update.order_date)
        if "inspection_start_date" in sent_fields and act_update.inspection_start_date is not None:
            _add("inspection_start_date", act_update.inspection_start_date)
        if "inspection_end_date" in sent_fields and act_update.inspection_end_date is not None:
            _add("inspection_end_date", act_update.inspection_end_date)
        if "is_process_based" in sent_fields and act_update.is_process_based is not None:
            _add("is_process_based", act_update.is_process_based)
        if service_note_changed or service_note_removed:
            _add("service_note", act_update.service_note)
            _add("service_note_date", act_update.service_note_date)

        # Авто-сброс служебных флагов
        needs_created_date = current_act.needs_created_date
        needs_directive_number = current_act.needs_directive_number
        needs_service_note = current_act.needs_service_note

        if needs_created_date and "created_date" in sent_fields and act_update.created_date is not None:
            needs_created_date = False
        if (
            needs_directive_number
            and act_update.directives is not None
            and len(act_update.directives) > 0
        ):
            all_have_numbers = all(
                d.directive_number and d.directive_number.strip()
                for d in act_update.directives
            )
            if all_have_numbers:
                needs_directive_number = False
        if needs_service_note and "service_note" in sent_fields and act_update.service_note is not None:
            if act_update.service_note.strip():
                needs_service_note = False

        if needs_created_date != current_act.needs_created_date:
            _add("needs_created_date", needs_created_date)
        if needs_directive_number != current_act.needs_directive_number:
            _add("needs_directive_number", needs_directive_number)
        if needs_service_note != current_act.needs_service_note:
            _add("needs_service_note", needs_service_note)

        _add("last_edited_by", username)
        updates.append("last_edited_at = CURRENT_TIMESTAMP")
        updates.append("updated_at = CURRENT_TIMESTAMP")

        return updates, values

    async def _sync_team_and_directives(
        self,
        act_id: int,
        audit_act_id: str,
        act_update: ActUpdate,
        tree_data,
    ) -> None:
        """Замена команды аудита и поручений."""
        if act_update.audit_team is not None:
            await self._crud.replace_team_members(
                act_id, audit_act_id, act_update.audit_team
            )

        if act_update.directives is not None:
            audit_point_map = (
                ActDirectivesValidator.build_audit_point_map(tree_data)
                if tree_data
                else {}
            )
            await self._crud.replace_directives(
                act_id, audit_act_id, act_update.directives, audit_point_map
            )

    async def _log_metadata_changes(
        self,
        act_id: int,
        username: str,
        act_update: ActUpdate,
        current_act: ActResponse,
        sent_fields: set[str],
    ) -> None:
        """Логирование изменений метаданных в аудит-лог."""
        changes = {}
        field_mapping = {
            "km_number": (current_act.km_number, act_update.km_number),
            "inspection_name": (current_act.inspection_name, act_update.inspection_name),
            "city": (current_act.city, act_update.city),
            "created_date": (current_act.created_date, act_update.created_date),
            "order_number": (current_act.order_number, act_update.order_number),
            "order_date": (current_act.order_date, act_update.order_date),
            "inspection_start_date": (current_act.inspection_start_date, act_update.inspection_start_date),
            "inspection_end_date": (current_act.inspection_end_date, act_update.inspection_end_date),
            "is_process_based": (current_act.is_process_based, act_update.is_process_based),
            "service_note": (current_act.service_note, act_update.service_note),
        }
        for field_name in sent_fields:
            if field_name in field_mapping:
                old_val, new_val = field_mapping[field_name]
                if str(old_val) != str(new_val):
                    changes[field_name] = {
                        "old": str(old_val) if old_val is not None else None,
                        "new": str(new_val) if new_val is not None else None,
                    }

        details = {"changes": changes}
        if act_update.audit_team is not None:
            details["audit_team_replaced"] = True
        if act_update.directives is not None:
            details["directives_replaced"] = True

        await self._audit.log("update", username, act_id, details)

    async def _apply_tree_restructure(
        self, act_id: int, new_is_process_based: bool,
    ) -> None:
        """Перестраивает разделы 1-2 в БД при смене типа проверки."""
        content_repo = ActContentRepository(self.conn)

        tree_data = await content_repo._load_tree(act_id)
        if not tree_data.get("children"):
            return

        result = self.restructure_sections_for_type_change(
            tree_data, new_is_process_based=new_is_process_based,
        )

        # Сохраняем обновлённое дерево
        await content_repo._save_tree(act_id, result["tree"])

        # Удаляем контент из разделов 1-2
        ids = result["content_ids_to_delete"]
        await content_repo.delete_nodes_content(
            act_id,
            table_ids=ids["table_ids"],
            textblock_ids=ids["textblock_ids"],
            violation_ids=ids["violation_ids"],
        )

        # Вставляем новые таблицы (qualityAssessment для процессной)
        for table in result["tables_to_insert"]:
            await content_repo.insert_table(
                act_id,
                table_id=table["table_id"],
                node_id=table["node_id"],
                grid_data=table["grid"],
                col_widths=table["col_widths"],
                is_protected=table["protected"],
                is_deletable=table["deletable"],
                table_label=table.get("label"),
                kind=table.get("kind", "regular"),
            )

        logger.info(
            f"Перестроены разделы 1-2 акта ID={act_id}: "
            f"is_process_based={new_is_process_based}"
        )

    # -------------------------------------------------------------------------
    # DUPLICATE ACT
    # -------------------------------------------------------------------------

    async def _generate_unique_copy_name(self, original_name: str) -> str:
        """Генерирует уникальное название для копии акта."""
        match = re.search(r"^(.+?)\s*\(Копия\s*(\d*)\)\s*$", original_name)

        if match:
            base_name = match.group(1).strip()
            existing_num = match.group(2)
            next_num = int(existing_num) + 1 if existing_num else 2
        else:
            base_name = original_name.strip()
            next_num = None

        for _ in range(100):
            if next_num is None:
                new_name = f"{base_name} (Копия)"
            else:
                new_name = f"{base_name} (Копия {next_num})"

            if not await self._crud.check_name_exists(new_name):
                return new_name

            next_num = 2 if next_num is None else next_num + 1

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        return f"{base_name} (Копия {timestamp})"

    @staticmethod
    def _build_duplicate_team(
        original_team: list[AuditTeamMember], username: str,
    ) -> list[AuditTeamMember]:
        """Формирует команду для дубликата акта."""
        user_original_role = None
        user_full_name = username
        user_position = "Аудитор"

        for member in original_team:
            if member.username == username:
                user_original_role = member.role
                user_full_name = member.full_name
                user_position = member.position
                break

        placeholder = AuditTeamMember(
            username=PLACEHOLDER_USERNAME, role="Участник", full_name=PLACEHOLDER_FULL_NAME, position="—"
        )
        new_team: list[AuditTeamMember] = []

        if user_original_role == "Куратор":
            new_team.append(AuditTeamMember(
                username=username, role="Куратор",
                full_name=user_full_name, position=user_position,
            ))
        else:
            new_team.append(placeholder.model_copy(update={"role": "Куратор"}))

        if user_original_role == "Руководитель":
            new_team.append(AuditTeamMember(
                username=username, role="Руководитель",
                full_name=user_full_name, position=user_position,
            ))
        else:
            new_team.append(placeholder.model_copy(update={"role": "Руководитель"}))

        if user_original_role not in ("Куратор", "Руководитель"):
            new_team.append(AuditTeamMember(
                username=username, role="Редактор",
                full_name=user_full_name, position=user_position,
            ))

        return new_team

    async def duplicate_act(self, act_id: int, username: str) -> ActResponse:
        """Создает дубликат акта."""
        await self.guard.require_access(act_id, username)

        async with self.conn.transaction():
            original = await self._crud.get_act_by_id(act_id)
            km_digit = KMUtils.extract_km_digits(original.km_number)

            new_inspection_name = await self._generate_unique_copy_name(
                original.inspection_name
            )
            new_team = self._build_duplicate_team(original.audit_team, username)

            km_info = await self._crud.check_km_exists(original.km_number)
            part_number = km_info["next_part_no_sn"]
            total_parts = km_info["total_parts"] + 1

            audit_act_id = await AuditIdService.generate_audit_act_id()

            new_act_id = await self._crud.insert_act(
                km_number=original.km_number,
                km_digit=km_digit,
                part_number=part_number,
                total_parts=total_parts,
                inspection_name=new_inspection_name,
                city=original.city,
                created_date=original.created_date,
                order_number=original.order_number,
                order_date=original.order_date,
                is_process_based=original.is_process_based,
                service_note=None,
                service_note_date=None,
                audit_act_id=audit_act_id,
                created_by=username,
                inspection_start_date=original.inspection_start_date,
                inspection_end_date=original.inspection_end_date,
            )

            await self._crud.insert_team_members_batch(
                new_act_id, audit_act_id, new_team
            )

            # Копируем содержимое (без предварительного insert_default_tree)
            await self._crud.copy_tree(act_id, new_act_id)
            await self._crud.copy_tables(act_id, new_act_id)
            await self._crud.copy_textblocks(act_id, new_act_id)
            await self._crud.copy_violations(act_id, new_act_id)

            await self._crud.update_total_parts_for_km(km_digit)

            logger.info(
                f"Создан дубликат акта: ID={act_id} -> ID={new_act_id}, "
                f"КМ={original.km_number} (цифры={km_digit}), "
                f"название='{new_inspection_name}'"
            )

            result = await self._crud.get_act_by_id(new_act_id)

        # Аудит — ПОСЛЕ коммита (батчер пишет вне нашей транзакции): при откате
        # не остаётся записи о дубликате несостоявшегося акта.
        await self._audit.log("duplicate", username, new_act_id, {
            "source_act_id": act_id,
            "km_number": original.km_number,
        })

        return result
