"""Handler'ы action-инструментов домена acts."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import date

from pydantic import ValidationError

from app.core.chat.names import ACTION_NOTIFY, ACTION_OPEN_URL, ACTION_REFRESH_ACT

logger = logging.getLogger("audit_workstation.domains.acts.integrations.action_handlers")


def _client_action(action: str, params: dict, label: str) -> str:
    return json.dumps(
        {
            "type": "client_action",
            "action": action,
            "params": params,
            "label": label,
            "block_id": str(uuid.uuid4()),
        },
        ensure_ascii=False,
    )


async def _fetch_acts(
    *,
    km_number: str | None,
    sz_number: str | None,
) -> list[dict]:
    """Ищет акты по КМ-номеру и/или СЗ. Возвращает список строк (может быть пустым)."""
    # Импорт внутри функции, чтобы тесты могли патчить get_db/get_adapter
    # на уровне модуля app.db.connection (lookup происходит при вызове).
    from app.db.connection import get_adapter, get_db

    where_parts: list[str] = []
    params: list[object] = []

    if km_number:
        try:
            from app.domains.acts.utils import KMUtils
            km_digit = KMUtils.extract_km_digits(km_number)
            params.append(km_digit)
            where_parts.append(f"km_number_digit = ${len(params)}")
        except Exception as exc:
            logger.warning("Не удалось извлечь цифры из КМ '%s': %s", km_number, exc)
            params.append(km_number)
            where_parts.append(f"km_number = ${len(params)}")

    if sz_number:
        params.append(sz_number)
        where_parts.append(f"service_note = ${len(params)}")

    adapter = get_adapter()
    acts_table = adapter.get_table_name("acts")
    sql = (
        f"SELECT id, km_number, service_note, part_number "
        f"FROM {acts_table} WHERE {' AND '.join(where_parts)} "
        f"ORDER BY part_number"
    )

    async with get_db() as conn:
        rows = await conn.fetch(sql, *params)
    return list(rows)


async def resolve_act_url(
    km_number: str | None,
    sz_number: str | None,
) -> str | None:
    """Резолвит КМ/СЗ в URL акта; None — если не найдено или найдено несколько."""
    if not km_number and not sz_number:
        return None
    rows = await _fetch_acts(km_number=km_number, sz_number=sz_number)
    if len(rows) != 1:
        return None
    return f"/constructor?act_id={rows[0]['id']}"


async def open_act_page_handler(
    *,
    km_number: str | None = None,
    sz_number: str | None = None,
) -> str:
    """Открывает страницу акта в интерфейсе AuditWorkstation.

    Поиск возможен по КМ-номеру или по номеру служебной записки (СЗ).
    - Если по критериям найден ровно один акт — возвращает ClientActionBlock
      с переходом на /constructor?act_id={id}.
    - Если найдено несколько — возвращает текст со списком и просьбой уточнить.
    - Если ничего — возвращает текст, что не найдено.
    """
    if not km_number and not sz_number:
        return ("Не указан ни КМ-номер, ни номер служебной записки. "
                "Укажите хотя бы один параметр для поиска акта.")

    criteria_label: list[str] = []
    if km_number:
        criteria_label.append(f"КМ {km_number}")
    if sz_number:
        criteria_label.append(f"СЗ {sz_number}")

    rows = await _fetch_acts(km_number=km_number, sz_number=sz_number)

    if not rows:
        return f"Акт по критериям ({', '.join(criteria_label)}) не найден."

    if len(rows) == 1:
        row = rows[0]
        url = f"/constructor?act_id={row['id']}"
        return _client_action(
            action=ACTION_OPEN_URL,
            params={"url": url},
            label=f"Открываю акт {row['km_number']}…",
        )

    items = []
    for r in rows:
        sz = r["service_note"] or "без СЗ"
        items.append(
            f"  • {r['km_number']} (часть {r['part_number']}, СЗ: {sz}) — id={r['id']}"
        )
    return (
        f"По критериям ({', '.join(criteria_label)}) найдено несколько актов:\n"
        + "\n".join(items)
        + "\n\nУточните номер служебной записки, чтобы открыть нужный акт."
    )


async def open_act_page_button_translator(params: dict) -> dict:
    """Транслятор серверной кнопки acts.open_act_page → клиентский action.

    Резолвит КМ/СЗ в URL акта; на успехе — open_url, иначе — notify уровня error.
    """
    km = (params or {}).get("km_number")
    sz = (params or {}).get("sz_number")
    url = await resolve_act_url(km, sz)
    if url:
        return {"action": ACTION_OPEN_URL, "params": {"url": url}}
    identifier = km or sz or "?"
    return {
        "action": ACTION_NOTIFY,
        "params": {
            "message": f"Акт {identifier} не найден",
            "level": "error",
        },
    }


# =============================================================================
# acts.create_act — создание нового акта аудита через чат с AI-ассистентом.
# =============================================================================

# Роли, дающие право создавать акты. «Куратор»/«Руководитель» — это
# роли участников аудиторской группы в домене acts (см. AuditTeamMember.role).
# Проверка идёт по справочнику ролей пользователя (user_roles → roles.name).
_ACT_CREATOR_ROLES: tuple[str, ...] = ("Куратор", "Руководитель", "Админ")


async def _user_can_create_acts(username: str) -> tuple[bool, str]:
    """Проверяет, что у пользователя есть роль для создания актов.

    Возвращает (allowed, reason). При ``allowed=False`` reason — понятный текст
    для LLM, чтобы тот сообщил пользователю причину отказа.
    """
    from app.db.connection import get_adapter, get_db

    adapter = get_adapter()
    roles_table = adapter.get_table_name("roles")
    user_roles_table = adapter.get_table_name("user_roles")

    async with get_db() as conn:
        rows = await conn.fetch(
            f"""
            SELECT r.name
            FROM {user_roles_table} ur
            JOIN {roles_table} r ON ur.role_id = r.id
            WHERE ur.username = $1
              AND r.name = ANY($2::text[])
            """,
            username, list(_ACT_CREATOR_ROLES),
        )
    role_names = sorted({r["name"] for r in rows})
    if role_names:
        return True, ""
    return False, (
        f"Создавать акты могут только пользователи с одной из ролей: "
        f"{', '.join(_ACT_CREATOR_ROLES)}. У пользователя {username} таких ролей нет. "
        f"Обратитесь к администратору для назначения роли «Куратор» или «Руководитель»."
    )


def _parse_date(value: object, field: str) -> date | None:
    """Парсит дату из строки/date; возвращает None если пусто или не парсится.

    Pydantic ловит формат, но мы принимаем на вход сырой dict от LLM,
    поэтому валидируем заранее и возвращаем читаемую ошибку.
    """
    if value is None or value == "":
        return None
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value.strip())
        except ValueError:
            raise ValueError(
                f"Поле «{field}» имеет неверный формат даты: «{value}». "
                f"Ожидается ГГГГ-ММ-ДД, например 2025-12-31."
            )
    raise ValueError(f"Поле «{field}» не может быть датой: {value!r}")


async def _resolve_audit_team(
    team_raw: list[dict],
) -> tuple[list[dict], str | None]:
    """Нормализует состав аудиторской группы из сырых данных LLM.

    Принимает список словарей вида:
      {"role": "Куратор"/"Руководитель"/"Редактор"/"Участник",
       "username": "<табельный>" или "full_name": "Иванов Иван"}

    Некоторые LLM (включая MiniMax) иногда оборачивают JSON-объект в
    {"$text": "{...}"} — распаковываем такие обёртки перед обработкой.

    Резолвит пользователей из справочника admin по username или ФИО.
    Возвращает (audit_team_list, error_message).
    """
    from app.core.domain_registry import get_factory
    from app.domains.acts.schemas.act_metadata import AuditTeamMember

    allowed_roles = ("Куратор", "Руководитель", "Редактор", "Участник")
    factory = get_factory("admin.user_directory")
    normalized: list[dict] = []
    errors: list[str] = []

    async for repo in factory():
        for idx, member in enumerate(team_raw or []):
            # Распаковываем {"$text": "{...json...}"} — некоторые провайдеры
            # (например MiniMax) присылают JSON-объекты в виде строки
            # внутри ключа $text. После распаковки member становится dict.
            if isinstance(member, dict) and set(member.keys()) <= {"$text"}:
                try:
                    member = json.loads(member["$text"])
                except (json.JSONDecodeError, TypeError):
                    errors.append(
                        f"Член группы #{idx + 1}: не удалось распарсить "
                        f"переданный JSON ({member['$text']!r})."
                    )
                    continue
            if not isinstance(member, dict):
                errors.append(f"Член группы #{idx + 1}: ожидается объект, получено {type(member).__name__}")
                continue
            role = str(member.get("role") or "").strip()
            if role not in allowed_roles:
                errors.append(
                    f"Член группы #{idx + 1}: роль «{role}» недопустима. "
                    f"Допустимые: {', '.join(allowed_roles)}."
                )
                continue

            username = str(member.get("username") or "").strip()
            full_name = str(member.get("full_name") or "").strip()

            if not username and not full_name:
                errors.append(
                    f"Член группы #{idx + 1} ({role}): укажите табельный номер (username) "
                    f"или ФИО для поиска."
                )
                continue

            # Ищем в справочнике. Если указан username — прямой поиск по подстроке;
            # если ФИО — поиск по подстроке ФИО.
            query = username or full_name
            try:
                # IUserDirectory.search_users(query, limit, offset) — без
                # branch: реализация (UserDirectoryRepository) применяет
                # поиск по всей таблице t_db_oarb_ua_user. AdminRepository
                # с branch — другая функция (admin/settings UI).
                results = await repo.search_users(query, limit=5)
            except Exception as exc:
                logger.warning("search_users(%r) failed: %s", query, exc)
                results = []

            # Попробуем выбрать точное совпадение, иначе первый результат.
            chosen = None
            for r in results:
                if username and str(r.get("username", "")) == username:
                    chosen = r
                    break
            if chosen is None and results:
                chosen = results[0]

            if chosen is None:
                errors.append(
                    f"Член группы #{idx + 1} ({role}): пользователь «{query}» "
                    f"не найден в справочнике. Проверьте табельный номер или ФИО."
                )
                continue

            try:
                normalized.append(
                    AuditTeamMember(
                        role=role,
                        full_name=chosen.get("fullname") or full_name,
                        position=chosen.get("job") or "—",
                        username=str(chosen.get("username") or username),
                    ).model_dump()
                )
            except ValidationError as exc:
                errors.append(
                    f"Член группы #{idx + 1} ({role}): "
                    f"ошибка валидации — {exc.errors()[0]['msg']}"
                )

    if errors:
        return normalized, "; ".join(errors)
    return normalized, None


def _collect_missing_fields(payload: dict) -> list[str]:
    """Возвращает список человекочитаемых названий обязательных полей,
    которые отсутствуют в payload.
    """
    required = [
        ("inspection_name", "Наименование проверки"),
        ("city", "Город"),
        ("order_number", "Номер приказа"),
        ("order_date", "Дата приказа"),
        ("km_number", "КМ-номер"),
        ("inspection_start_date", "Дата начала проверки"),
        ("inspection_end_date", "Дата окончания проверки"),
        ("audit_team", "Состав аудиторской группы"),
    ]
    missing: list[str] = []
    for key, label in required:
        value = payload.get(key)
        if value is None or value == "" or value == []:
            missing.append(label)
    return missing


async def create_act_handler(
    *,
    inspection_name: str | None = None,
    city: str | None = None,
    order_number: str | None = None,
    order_date: str | None = None,
    inspection_start_date: str | None = None,
    inspection_end_date: str | None = None,
    km_number: str | None = None,
    audit_team: list[dict] | None = None,
    created_date: str | None = None,
    is_process_based: bool | None = None,
) -> str:
    """Создаёт акт аудита через чат.

    Handler принимает все поля опциональными — каждый «черновик» собирает
    данные через диалог. Если каких-то обязательных полей не хватает,
    возвращается текстовое сообщение с перечислением недостающего: LLM
    получает его как tool-output и формулирует пользователю уточняющий
    вопрос. Когда все данные есть и проходят валидацию — создаёт акт
    через ActCrudService и возвращает client_action для перехода на
    /constructor?act_id={id}.

    Права: только пользователи с ролями «Куратор», «Руководитель» или
    «Админ» могут создавать акты.
    """
    from app.core.config import get_settings
    from app.db.connection import get_db
    from app.domains.acts.schemas.act_metadata import ActCreate
    from app.domains.chat.services.tool_executor import get_current_chat_user

    # Username автора запроса — из контекста, выставленного tool_executor.
    # Вне chat-сессии (например, прямой вызов handler-а из тестов)
    # вернётся None — сообщаем об этом.
    username = get_current_chat_user()
    if not username:
        return (
            "Не удалось определить пользователя чат-сессии. "
            "Сообщите администратору (handler вызван без контекста)."
        )

    allowed, deny_reason = await _user_can_create_acts(username)
    if not allowed:
        return deny_reason

    # Собираем «черновик» payload.
    payload: dict[str, object] = {
        "inspection_name": (inspection_name or "").strip() or None,
        "city": (city or "").strip() or None,
        "order_number": (order_number or "").strip() or None,
        "km_number": (km_number or "").strip() or None,
        "audit_team": audit_team or [],
        "is_process_based": (
            bool(is_process_based) if is_process_based is not None else True
        ),
    }

    # Даты: парсим заранее и возвращаем понятную ошибку, если формат битый.
    try:
        payload["order_date"] = _parse_date(order_date, "order_date")
        payload["inspection_start_date"] = _parse_date(
            inspection_start_date, "inspection_start_date",
        )
        payload["inspection_end_date"] = _parse_date(
            inspection_end_date, "inspection_end_date",
        )
        payload["created_date"] = _parse_date(created_date, "created_date")
    except ValueError as exc:
        return (
            f"{exc} Пожалуйста, укажите дату в формате ГГГГ-ММ-ДД и попробуйте снова."
        )

    # Нормализуем аудиторскую группу: резолвим пользователей по справочнику.
    team_normalized, team_error = await _resolve_audit_team(payload["audit_team"])
    if team_error:
        return team_error
    payload["audit_team"] = team_normalized

    # Если не хватает обязательных полей — возвращаем список, LLM задаст
    # уточняющие вопросы.
    missing = _collect_missing_fields(payload)
    if missing:
        items = "\n".join(f"- {m}" for m in missing)
        return (
            "Для создания акта не хватает обязательной информации:\n"
            f"{items}\n\n"
            "Пожалуйста, уточните эти данные. После этого я смогу создать акт."
        )

    # Дополнительная проверка: КМ формат + диапазон дат уже делает Pydantic,
    # но мы хотим вернуть человеческую ошибку, а не стек.
    try:
        act_create = ActCreate(**payload)
    except ValidationError as exc:
        # Достаём первую ошибку — для LLM этого достаточно.
        first = exc.errors()[0]
        field = ".".join(str(p) for p in first.get("loc", []))
        msg = first.get("msg", "")
        return (
            f"Ошибка в поле «{field or '?'}»: {msg}. "
            f"Поправьте данные и попробуйте снова."
        )

    # Создаём акт через тот же сервис, что использует REST API /acts/create.
    settings = get_settings()
    try:
        async with get_db() as conn:
            from app.domains.acts.services.act_crud_service import ActCrudService

            service = ActCrudService(conn=conn, settings=settings)
            result = await service.create_act(act_create, username, force_new_part=False)
    except Exception as exc:
        # KmConflictError / ActValidationError наследуются от Exception;
        # обработчик возвращает текст, чтобы LLM попросил пользователя
        # уточнить КМ / СЗ или роль в группе.
        msg = str(exc) or exc.__class__.__name__
        logger.warning("create_act_handler failed for user=%s: %s", username, msg)
        return (
            f"Не удалось создать акт: {msg}. "
            f"Проверьте корректность данных (КМ-номер, уникальность, "
            f"состав группы) и попробуйте снова."
        )

    logger.info(
        "AI-ассистент создал акт id=%s km=%s пользователем %s",
        result.id, act_create.km_number, username,
    )

    # refresh_act — без перезагрузки страницы. Конструктор откроет
    # только что созданный акт.
    return _client_action(
        action=ACTION_REFRESH_ACT,
        params={"act_id": result.id},
        label=f"Открываю новый акт {act_create.km_number}…",
    )


# =============================================================================
# acts.add_processes_to_act — добавление процессов в акт через чат
# =============================================================================

# Метки разделов акта (синхронизированы с AppConfig.tree.defaultSections).
# Используются при автосоздании разделов для новых актов (при вызове из
# чата — UI ещё не успел открыть акт и проинициализировать дерево).
_SECTION_LABELS: dict[str, str] = {
    "1": "Информация о процессе, клиентском пути",
    "2": "Оценка качества проверенного процесса / сценария процесса / потока работ",
    "3": "Примененные технологии",
    "4": "Основные выводы",
    "5": "Результаты проверки",
}
# Порядок разделов в дереве (для автосоздания первого раздела):
_SECTION_ORDER: list[str] = ["1", "2", "3", "4", "5"]


def _add_process_nodes_to_tree(
    tree: dict,
    *,
    parent_id: str,
    processes: list[dict],
    start_number: int,
) -> tuple[int, list[str]]:
    """Добавляет узлы процессов в раздел parent_id дерева.

    Каждый процесс становится отдельным item-узлом с label вида
    ``П1004 - Расчет процентной ставки ИЖС``. Номер узла назначается
    по порядку (5.1, 5.2, ... для раздела 5).

    Args:
        tree: текущее дерево акта (мутируется in-place).
        parent_id: id раздела, куда добавлять ('1'..'5', '6' для PM).
        processes: список {process_code, process_name} (уже валидированный).
        start_number: с какого числа начинать нумерацию внутри parent_id.

    Returns:
        (next_number, list_of_new_node_ids) — следующий доступный номер
        и id созданных узлов (чтобы caller мог их логировать).
    """
    # Найти parent в дереве (рекурсивно, т.к. parent может быть вложенным)
    def _find(node):
        if node.get("id") == parent_id:
            return node
        for c in node.get("children", []):
            found = _find(c)
            if found is not None:
                return found
        return None

    parent = _find(tree)
    if parent is None:
        # Раздел не найден — создаём корневую структуру, если её нет,
        # иначе добавляем в корень как fallback (UI покажет как обычные пункты).
        if "children" not in tree:
            tree["children"] = []
        parent = tree

    if "children" not in parent:
        parent["children"] = []

    next_num = start_number
    new_node_ids: list[str] = []
    for proc in processes:
        code = proc["process_code"]
        name = proc["process_name"]
        node_id = f"item_{parent_id}_{code}_{uuid.uuid4().hex[:8]}"
        node = {
            "id": node_id,
            "label": f"{code} - {name}",
            "type": "item",
            "content": "",
            "protected": False,
            "deletable": True,
            "children": [],
            "customLabel": "",
            "number": f"{parent_id}.{next_num}",
        }
        parent["children"].append(node)
        new_node_ids.append(node_id)
        next_num += 1
    return next_num, new_node_ids


async def add_processes_to_act_handler(
    *,
    act_id: int | None = None,
    process_codes: list[str] | None = None,
    section_id: str = "5",
    start_number: int | None = None,
) -> str:
    """Добавляет процессы из справочника ua_data.process_dict в акт.

    Args:
        act_id: id акта. Если None — LLM должна передать явно (нет
            fallback на «последний» — намеренно, чтобы избежать
            неоднозначности).
        process_codes: список кодов процессов (например, ['П1004',
            'П2054']). Обязательный (если пусто — tool попросит коды).
        section_id: id раздела дерева для добавления (по умолчанию '5' —
            «Результаты проверки»). Допустимые: '1'..'5' (см. AppConfig).
        start_number: с какого числа начинать нумерацию внутри раздела.
            По умолчанию — продолжаем с последнего + 1.

    Права: Куратор/Руководитель/Редактор (или Админ) — те же, что у
    ручного редактора. Участник может только просматривать.

    На успехе возвращает client_action с переходом на /constructor?act_id=...
    и текстовую сводку: какие процессы добавлены, в какой раздел, итоговый
    счётчик пунктов в разделе.
    """
    from app.db.connection import get_db
    from app.domains.acts.integrations.processes import fetch_processes_by_codes
    from app.domains.chat.services.tool_executor import get_current_chat_user

    username = get_current_chat_user()
    if not username:
        return (
            "Не удалось определить пользователя чат-сессии. "
            "Сообщите администратору."
        )

    if act_id is None:
        return (
            "Не указан id акта. Передайте act_id (его можно увидеть "
            "в URL открытого акта или в списке «Мои проекты»)."
        )
    if not process_codes:
        return (
            "Не переданы коды процессов. Укажите хотя бы один код "
            "в process_codes (например, ['П1004', 'П2054']). "
            "Если знаете только название — скажите в чате, я найду код."
        )

    # Шаг 1: проверить доступ (через репозиторий, не поднимая AccessGuard —
    # достаточно знать, что пользователь в команде и имеет право edit).
    from app.domains.acts.repositories.act_access import ActAccessRepository
    from app.domains.acts.repositories.act_lock import ActLockRepository

    async with get_db() as conn:
        access_repo = ActAccessRepository(conn)
        lock_repo = ActLockRepository(conn)
        from app.domains.acts.services.access_guard import AccessGuard
        guard = AccessGuard(access_repo, lock_repo)

        # Доступ + права на редактирование
        try:
            await guard.require_access(act_id, username)
            perm = await access_repo.get_user_edit_permission(act_id, username)
        except Exception as exc:
            logger.warning(
                "add_processes_to_act: доступ запрещён user=%s act=%s: %s",
                username, act_id, exc,
            )
            return (
                f"Нет доступа к акту {act_id}: {exc}. "
                f"Проверьте, что вы участник команды этого акта."
            )
        if not perm.get("can_edit"):
            role = perm.get("role") or "(не в команде)"
            return (
                f"Ваша роль в акте ({role}) позволяет только просматривать "
                f"акт. Редактировать могут Куратор, Руководитель или Редактор. "
                f"Попросите одного из них добавить процесс."
            )

        # Шаг 2: проверить, что процессы существуют в справочнике
        processes = await fetch_processes_by_codes(process_codes)
        if not processes:
            return (
                f"Ни один из переданных кодов {process_codes} не найден "
                f"в справочнике процессов. Проверьте коды (формат «ПXXXX») "
                f"или передайте полное название процесса."
            )
        found_codes = {p["process_code"] for p in processes}
        missing = [
            str(c).strip()
            for c in process_codes
            if c is not None and str(c).strip() and str(c).strip() not in found_codes
        ]
        if missing:
            return (
                f"Эти коды процессов не найдены в справочнике: {', '.join(missing)}. "
                f"Найденные: {', '.join(sorted(found_codes))}. "
                f"Проверьте коды или передайте точные названия."
            )

        # Шаг 3: загрузить дерево и добавить узлы
        from app.domains.acts.repositories.act_content import ActContentRepository

        content_repo = ActContentRepository(conn)
        tree = await content_repo._load_tree(act_id)

        # Если раздел '6' (process mining) — его по умолчанию нет в дереве,
        # добавляем как spec-узел. Иначе — ищем существующий раздел.
        if section_id == "6":
            # Process Mining секция: добавляем как корневой child с special
            pm_exists = any(
                c.get("special") == "process_mining"
                for c in tree.get("children", [])
            )
            if not pm_exists:
                tree.setdefault("children", []).append({
                    "id": "6",
                    "special": "process_mining",
                    "label": (
                        "Оценка процесса по результатам исследования "
                        "методом Process Mining"
                    ),
                    "children": [],
                    "protected": False,
                    "deletable": True,
                })
            actual_parent = "6"
        else:
            actual_parent = section_id
            # Акт при создании имеет пустой default tree (только root).
            # Если раздел '1'..'5' ещё не создан — создаём защищённый
            # раздел с правильным label (UI делает это на своей стороне
            # при первом открытии, но AI вызывает tool до этого).
            # Раздел 1 для непроцессных проверок переименовывается, как
            # и в state-core.js _createRootStructure().
            existing_ids = {c.get("id") for c in tree.get("children", [])}
            if actual_parent not in existing_ids:
                row = await conn.fetchrow(
                    "SELECT is_process_based FROM t_db_oarb_audit_act_acts "
                    "WHERE id = $1",
                    act_id,
                )
                is_pb = bool(row["is_process_based"]) if row else True
                section_label = _SECTION_LABELS.get(
                    actual_parent, f"Раздел {actual_parent}"
                )
                if actual_parent == "1" and not is_pb:
                    section_label = (
                        "Характеристика проверяемого направления"
                    )
                tree.setdefault("children", []).insert(
                    _SECTION_ORDER.index(actual_parent)
                    if actual_parent in _SECTION_ORDER else len(_SECTION_ORDER),
                    {
                        "id": actual_parent,
                        "label": section_label,
                        "protected": True,
                        "deletable": False,
                        "children": [],
                        "content": "",
                    },
                )

        # Определить начальный номер для раздела
        existing = []
        for c in tree.get("children", []):
            if c.get("id") == actual_parent:
                existing = c.get("children", [])
                break
        if start_number is None:
            max_num = 0
            for child in existing:
                num = child.get("number", "")
                # числа вида "5.3" — берём последнюю цифру
                if "." in str(num):
                    tail = str(num).rsplit(".", 1)[-1]
                    try:
                        max_num = max(max_num, int(tail))
                    except ValueError:
                        pass
            start_number = max_num + 1

        # Применить изменения
        next_num, new_ids = _add_process_nodes_to_tree(
            tree,
            parent_id=actual_parent,
            processes=processes,
            start_number=start_number,
        )

        # Шаг 4: сохранить дерево + (опционально) сгенерить audit_point_id
        await content_repo._save_tree(act_id, tree)

        # Получить КМ акта для текстового отчёта
        km_row = await conn.fetchrow(
            "SELECT km_number FROM t_db_oarb_audit_act_acts WHERE id = $1",
            act_id,
        )
        km = km_row["km_number"] if km_row else f"id={act_id}"

    summary = (
        f"Добавлено {len(processes)} процесс(ов) в акт {km} "
        f"(раздел {actual_parent}, пункты {actual_parent}.{start_number}…"
        f"{actual_parent}.{next_num - 1}):\n"
    )
    for proc in processes:
        summary += f"- {proc['process_code']} — {proc['process_name']}\n"

    logger.info(
        "AI-ассистент добавил процессы в акт id=%s: %s пользователем %s",
        act_id, [p["process_code"] for p in processes], username,
    )

    # Используем refresh_act вместо open_url — без перезагрузки страницы.
    return _client_action(
        action=ACTION_REFRESH_ACT,
        params={"act_id": act_id},
        label=f"Акт {km} обновлён, обновляю конструктор…",
    ) + "\n\n" + summary


# =============================================================================
# acts.modify_act_tree — комплексные операции над структурой акта
# =============================================================================


# Поддерживаемые типы таблиц (TableKind Literal из schemas/act_content.py).
# Все они могут быть созданы через add_table — LLM просто указывает kind.
_TABLE_KINDS = frozenset({
    "regular", "metrics", "mainMetrics",
    "regularRisk", "operationalRisk", "taxRisk", "otherRisk",
})

_TABLE_FILL_MODES: frozenset[str] = frozenset({"replace", "append_rows"})


def _unwrap_op(op: object) -> object:
    """Распаковывает MiniMax-style ``{"$text": "{...json...}"}`` обёртку.

    Некоторые LLM (MiniMax) сериализуют JSON-объекты как строки внутри
    ключа $text — если объект ровно с одним ключом $text и значение
    начинается с ``{`` / ``[`` (это JSON), пытаемся распарсить. Иначе
    возвращаем как есть.

    Рекурсивно: вложенные ``$text`` внутри dict-значений тоже разворачиваются
    (например, ``add_table`` с ``kind`` в ``{"$text": "regularRisk"}`` —
    "regularRisk" не JSON, остаётся строкой).
    """
    if not isinstance(op, dict):
        return op
    if set(op.keys()) == {"$text"}:
        raw = op["$text"]
        if isinstance(raw, str) and raw.lstrip().startswith(("{", "[")):
            try:
                return json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                pass
        return op
    # Рекурсивно распаковываем вложенные $text в значениях.
    return {k: (_unwrap_op(v) if isinstance(v, dict) else v) for k, v in op.items()}


def _find_node_by_ref(
    tree: dict,
    ref: str | int,
) -> tuple[dict | None, dict | None]:
    # Нормализуем ref в str — LLM может передать как "2" (str), так и
    # 2 (int). В Python `"2" == 2` = False, поэтому нужно привести
    # к одному типу ДО сравнения.
    ref_str = str(ref) if ref is not None else ""

    def walk(node, parent):
        if str(node.get("id", "")) == ref_str:
            return node, parent
        if str(node.get("number", "")) == ref_str:
            return node, parent
        for child in node.get("children", []) or []:
            found, par = walk(child, node)
            if found is not None:
                return found, par
        return None, None

    return walk(tree, None)


def _next_item_number(tree: dict, parent_id: str, parent_number: str | None) -> tuple[str, int]:
    """Возвращает следующий (number, N) для нового item-узла внутри parent.

    number строится как ``{parent_number}.{N}`` (или ``N`` если parent — root).
    N = max(existing N) + 1.
    """
    # Сначала вычислим число существующих items среди детей parent
    node, _ = _find_node_by_ref(tree, parent_id)
    if node is None:
        # Не нашли — fallback: начинаем с 1
        if parent_number:
            return f"{parent_number}.1", 1
        return "1", 1

    max_n = 0
    for child in node.get("children", []) or []:
        n = child.get("number", "")
        if not n:
            continue
        # Берём последнюю цифру после последней точки
        if "." in n:
            tail = n.rsplit(".", 1)[-1]
        else:
            tail = n
        try:
            v = int(tail)
            if v > max_n:
                max_n = v
        except ValueError:
            pass
    next_n = max_n + 1
    if parent_number:
        return f"{parent_number}.{next_n}", next_n
    return str(next_n), next_n


def _generate_node_id(prefix: str = "node") -> str:
    """Генерирует уникальный id для нового узла (как в state-core.js _createNewNode)."""
    import uuid as _uuid
    ms = int(_uuid.uuid4().int & 0x7FFFFFFFFFFFFFFF)
    return f"{prefix}_{ms}_{_uuid.uuid4().hex[:7]}"


def _apply_add_item(
    tree: dict, op: dict, results: list[dict]
) -> None:
    op = _unwrap_op(op)
    parent_id = op.get("parent_id")
    label = (op.get("label") or "Новый пункт").strip()
    content = op.get("content") or ""
    if not parent_id:
        raise ValueError("add_item: parent_id обязателен")
    parent, _ = _find_node_by_ref(tree, parent_id)
    if parent is None:
        raise ValueError(f"add_item: parent {parent_id!r} не найден в дереве")
    parent_number = parent.get("number")
    number, _ = _next_item_number(tree, parent["id"], parent_number)
    new_id = _generate_node_id("node")
    new_node = {
        "id": new_id,
        "label": label,
        "type": "item",
        "content": content,
        "protected": False,
        "deletable": True,
        "children": [],
        "customLabel": "",
        "number": number,
    }
    parent.setdefault("children", []).append(new_node)
    results.append({"op": "add_item", "node_id": new_id, "number": number,
                    "label": label, "parent_id": parent["id"]})


def _apply_add_sibling(
    tree: dict, op: dict, results: list[dict]
) -> None:
    """Добавляет sibling-узел после указанного (как sibling в UI)."""
    op = _unwrap_op(op)
    sibling_id = op.get("node_id")
    label = (op.get("label") or "Новый пункт").strip()
    if not sibling_id:
        raise ValueError("add_sibling: node_id обязателен")
    sibling, parent = _find_node_by_ref(tree, sibling_id)
    if sibling is None:
        raise ValueError(f"add_sibling: узел {sibling_id!r} не найден")
    if parent is None:
        raise ValueError(
            "add_sibling: нельзя добавить sibling на root уровне — "
            "используйте add_process_mining или add_item с parent_id=root"
        )
    # Определяем следующий номер среди children parent
    parent_number = parent.get("number")
    base = parent_number or ""
    children = parent.get("children", []) or []
    # Найти максимальный N среди соседей типа item
    max_n = 0
    for ch in children:
        if ch.get("id") == sibling["id"]:
            continue
        n = ch.get("number", "")
        if not n:
            continue
        if base and n.startswith(base + "."):
            tail = n[len(base) + 1:]
        elif base:
            continue  # другой подраздел
        else:
            tail = n
        try:
            v = int(tail.split(".")[-1] if "." in tail else tail)
            if v > max_n:
                max_n = v
        except ValueError:
            pass
    next_n = max_n + 1
    if base:
        number = f"{base}.{next_n}"
    else:
        number = str(next_n)
    new_id = _generate_node_id("node")
    new_node = {
        "id": new_id,
        "label": label,
        "type": "item",
        "content": op.get("content") or "",
        "protected": False,
        "deletable": True,
        "children": [],
        "customLabel": "",
        "number": number,
    }
    # Вставляем ПОСЛЕ sibling
    idx = next(
        (i for i, c in enumerate(children) if c.get("id") == sibling["id"]),
        len(children) - 1,
    )
    children.insert(idx + 1, new_node)
    results.append({"op": "add_sibling", "node_id": new_id, "number": number,
                    "label": label, "parent_id": parent["id"]})


def _apply_add_textblock(
    tree: dict, dict_key: str, target_dict: dict,
    op: dict, results: list[dict]
) -> None:
    op = _unwrap_op(op)
    parent_id = op.get("parent_id")
    label = (op.get("label") or "Текстовый блок").strip()
    content = op.get("content") or ""
    if not parent_id:
        raise ValueError("add_textblock: parent_id обязателен")
    parent, _ = _find_node_by_ref(tree, parent_id)
    if parent is None:
        raise ValueError(f"add_textblock: parent {parent_id!r} не найден")
    tb_id = _generate_node_id("textblock")
    node_id = _generate_node_id("node")
    tb_count = sum(
        1 for c in parent.get("children", []) if c.get("type") == "textblock"
    )
    parent.setdefault("children", []).append({
        "id": node_id,
        "label": label,
        "type": "textblock",
        "textBlockId": tb_id,
        "content": content,
        "protected": False,
        "deletable": True,
        "children": [],
        "customLabel": "",
        "number": f"Текстовый блок {tb_count + 1}",
    })
    target_dict[tb_id] = {
        "id": tb_id,
        "nodeId": node_id,
        "content": content,
    }
    results.append({"op": "add_textblock", "node_id": node_id, "textBlockId": tb_id,
                    "label": label, "parent_id": parent["id"]})


def _apply_add_table(
    tree: dict, dict_key: str, target_dict: dict,
    op: dict, results: list[dict]
) -> None:
    op = _unwrap_op(op)
    parent_id = op.get("parent_id")
    label = (op.get("label") or "Таблица").strip()
    kind = (op.get("kind") or "regular").strip()
    if kind not in _TABLE_KINDS:
        raise ValueError(
            f"add_table: kind {kind!r} недопустим. "
            f"Допустимые: {sorted(_TABLE_KINDS)}"
        )
    if not parent_id:
        raise ValueError("add_table: parent_id обязателен")
    parent, _ = _find_node_by_ref(tree, parent_id)
    if parent is None:
        raise ValueError(f"add_table: parent {parent_id!r} не найден")
    table_id = _generate_node_id("table")
    node_id = _generate_node_id("node")
    tbl_count = sum(
        1 for c in parent.get("children", []) if c.get("type") == "table"
    )
    parent.setdefault("children", []).append({
        "id": node_id,
        "label": label,
        "type": "table",
        "tableId": table_id,
        "content": "",
        "protected": False,
        "deletable": True,
        "children": [],
        "customLabel": "",
        "number": f"Таблица {tbl_count + 1}",
    })
    target_dict[table_id] = {
        "id": table_id,
        "nodeId": node_id,
        "grid": [],
        "colWidths": [],
        "protected": False,
        "deletable": True,
        "kind": kind,
    }
    results.append({"op": "add_table", "node_id": node_id, "tableId": table_id,
                    "label": label, "kind": kind, "parent_id": parent["id"]})


def _normalize_table_cell(
    cell: object, row: int, col: int, is_header: bool = False
) -> dict:
    """Приводит ячейку к dict-формату TableCellSchema.

    Принимает:
    - str: {content: <str>, isHeader: <is_header>, colSpan: 1, rowSpan: 1, ...}
    - dict: дополняет дефолтами (isHeader, colSpan, rowSpan, originRow/Col)

    Используется в fill_table — LLM может передавать компактный формат
    (просто строки), а handler приведёт к полному.
    """
    if isinstance(cell, str):
        return {
            "content": cell,
            "isHeader": is_header,
            "colSpan": 1,
            "rowSpan": 1,
            "isSpanned": False,
            "spanOrigin": None,
            "originRow": row,
            "originCol": col,
        }
    if isinstance(cell, (int, float, bool)):
        return {
            "content": str(cell),
            "isHeader": is_header,
            "colSpan": 1,
            "rowSpan": 1,
            "isSpanned": False,
            "spanOrigin": None,
            "originRow": row,
            "originCol": col,
        }
    if cell is None:
        return {
            "content": "",
            "isHeader": is_header,
            "colSpan": 1,
            "rowSpan": 1,
            "isSpanned": False,
            "spanOrigin": None,
            "originRow": row,
            "originCol": col,
        }
    if not isinstance(cell, dict):
        raise ValueError(
            f"fill_table: ячейка [{row}][{col}] должна быть строкой "
            f"или dict, получено {type(cell).__name__}"
        )
    if "content" not in cell:
        raise ValueError(
            f"fill_table: ячейка [{row}][{col}] (dict) должна иметь "
            f"поле 'content'"
        )
    return {
        "content": str(cell.get("content", "")),
        "isHeader": bool(cell.get("isHeader", is_header)),
        "colSpan": int(cell.get("colSpan", 1)),
        "rowSpan": int(cell.get("rowSpan", 1)),
        "isSpanned": bool(cell.get("isSpanned", False)),
        "spanOrigin": cell.get("spanOrigin"),
        "originRow": int(cell.get("originRow", row)),
        "originCol": int(cell.get("originCol", col)),
    }


def _normalize_table_grid(
    raw_grid: list, mode: str
) -> list[list[dict]]:
    """Приводит 2D-массив к формату TableSchema.grid.

    mode='replace': первая строка = заголовки (isHeader=True), остальные —
    данные. mode='append_rows': все строки — данные (isHeader=False).

    Проверяет прямоугольность (все строки одной длины).
    """
    if not isinstance(raw_grid, list) or not raw_grid:
        raise ValueError("fill_table: grid должен быть непустым 2D-массивом")

    out: list[list[dict]] = []
    for r, row in enumerate(raw_grid):
        if not isinstance(row, list):
            raise ValueError(
                f"fill_table: строка {r} должна быть массивом ячеек, "
                f"получено {type(row).__name__}"
            )
        is_header_row = (mode == "replace" and r == 0)
        out.append([
            _normalize_table_cell(cell, r, c, is_header_row)
            for c, cell in enumerate(row)
        ])

    if out:
        width = len(out[0])
        for r, row in enumerate(out):
            if len(row) != width:
                raise ValueError(
                    f"fill_table: строка {r} имеет {len(row)} ячеек, "
                    f"а строка 0 — {width}. Матрица должна быть прямоугольной"
                )
    return out


def _resolve_table_by_ref(
    tree: dict, target_dict: dict, ref: str
) -> tuple[dict | None, str | None]:
    """Ищет таблицу в target_dict по ref (table_id или node_id).

    Returns: (table_dict, node_id) или (None, None) если не найдено.
    """
    if not ref:
        return None, None
    # 1) Прямое совпадение ключа в target_dict
    if ref in target_dict:
        return target_dict[ref], target_dict[ref].get("nodeId")
    # 2) Поиск узла в дереве — может быть node_id узла с type='table'
    node, _ = _find_node_by_ref(tree, ref)
    if node is not None and node.get("type") == "table":
        tbl_id = node.get("tableId")
        if tbl_id and tbl_id in target_dict:
            return target_dict[tbl_id], node.get("id")
    return None, None


def _apply_fill_table(
    tree: dict, target_dict: dict, op: dict, results: list[dict]
) -> None:
    op = _unwrap_op(op)
    table_ref = op.get("table_id")
    if not table_ref:
        raise ValueError("fill_table: table_id обязателен")
    mode = (op.get("mode") or "replace").strip()
    if mode not in _TABLE_FILL_MODES:
        raise ValueError(
            f"fill_table: mode {mode!r} недопустим. "
            f"Допустимые: {sorted(_TABLE_FILL_MODES)}"
        )
    raw_grid = op.get("grid")
    if not raw_grid:
        raise ValueError(
            "fill_table: grid обязателен (2D-массив строк или полных ячеек)"
        )

    target_table, node_id = _resolve_table_by_ref(tree, target_dict, table_ref)
    if target_table is None:
        raise ValueError(
            f"fill_table: таблица {table_ref!r} не найдена "
            f"(передай tableId из add_table или node_id узла с type='table')"
        )

    if target_table.get("protected"):
        raise ValueError(
            f"fill_table: таблица {target_table.get('id')!r} защищена "
            f"от изменений (protected=True)"
        )

    normalized_grid = _normalize_table_grid(raw_grid, mode)
    existing_grid: list = target_table.get("grid") or []

    if mode == "replace":
        target_table["grid"] = normalized_grid
    elif mode == "append_rows":
        target_table["grid"] = list(existing_grid) + normalized_grid

    col_widths = op.get("col_widths")
    if col_widths is not None:
        if not isinstance(col_widths, list) or not all(
            isinstance(w, (int, float)) for w in col_widths
        ):
            raise ValueError(
                "fill_table: col_widths должен быть массивом положительных "
                "целых чисел"
            )
        target_table["colWidths"] = [int(w) for w in col_widths]

    new_grid = target_table["grid"]
    results.append({
        "op": "fill_table",
        "table_id": target_table.get("id"),
        "node_id": node_id,
        "mode": mode,
        "rows": len(new_grid),
        "cols": len(new_grid[0]) if new_grid else 0,
    })


def _apply_add_violation(
    tree: dict, dict_key: str, target_dict: dict,
    op: dict, results: list[dict]
) -> None:
    op = _unwrap_op(op)
    parent_id = op.get("parent_id")
    label = (op.get("label") or "Нарушение").strip()
    if not parent_id:
        raise ValueError("add_violation: parent_id обязателен")
    parent, _ = _find_node_by_ref(tree, parent_id)
    if parent is None:
        raise ValueError(f"add_violation: parent {parent_id!r} не найден")
    viol_id = _generate_node_id("violation")
    node_id = _generate_node_id("node")
    viol_count = sum(
        1 for c in parent.get("children", []) if c.get("type") == "violation"
    )
    parent.setdefault("children", []).append({
        "id": node_id,
        "label": label,
        "type": "violation",
        "violationId": viol_id,
        "content": "",
        "protected": False,
        "deletable": True,
        "children": [],
        "customLabel": "",
        "number": f"Нарушение {viol_count + 1}",
    })
    violated = op.get("violated") or ""
    established = op.get("established") or ""
    target_dict[viol_id] = {
        "id": viol_id,
        "nodeId": node_id,
        "violated": violated,
        "established": established,
        "descriptionList": {"enabled": False, "items": []},
        "additionalContent": {
            "enabled": False,
            "items": [],
        },
        "reasons": {"enabled": False, "content": ""},
        "measures": {"enabled": False, "content": ""},
        "consequences": {"enabled": False, "content": ""},
        "responsible": {"enabled": False, "content": ""},
    }
    results.append({"op": "add_violation", "node_id": node_id, "violationId": viol_id,
                    "label": label, "parent_id": parent["id"]})


def _apply_add_process_mining(
    tree: dict, op: dict, results: list[dict]
) -> None:
    op = _unwrap_op(op)
    """Добавляет раздел «Process Mining» в корень (id='6')."""
    label = (
        op.get("label")
        or "Оценка процесса по результатам исследования методом Process Mining"
    ).strip()
    # Дубль-защита: считаем все PM-разделы (в т.ч. с кривыми id после
    # ручных правок) и не создаём ещё один, если он уже есть.
    pm_count = sum(
        1 for c in tree.get("children", [])
        if c.get("special") == "process_mining"
    )
    if pm_count > 0:
        # Доп. защита: убрать дубликаты PM-разделов, оставив только первый.
        seen = False
        new_children = []
        for c in tree.get("children", []):
            if c.get("special") == "process_mining":
                if seen:
                    continue
                seen = True
            new_children.append(c)
        if len(new_children) < len(tree.get("children", [])):
            tree["children"] = new_children
        results.append({"op": "add_process_mining", "skipped": True,
                        "reason": f"раздел уже существует ({pm_count} шт.)"})
        return
    tree.setdefault("children", []).append({
        "id": "6",
        "special": "process_mining",
        "label": label,
        "children": [],
        "protected": False,
        "deletable": True,
    })
    results.append({"op": "add_process_mining", "node_id": "6", "label": label})


def _apply_delete_node(
    tree: dict, op: dict, results: list[dict]
) -> tuple[set[str], set[str], set[str]]:
    op = _unwrap_op(op)
    """Удаляет узел из дерева + каскадно его вложенные.

    Returns:
        (table_ids, textblock_ids, violation_ids) для последующей очистки
        в content_data — save_content и так сделает DROP для orphan-id, но
        явная очистка уменьшает размер payload.
    """
    node_id = op.get("node_id")
    if not node_id:
        raise ValueError("delete_node: node_id обязателен")
    target, parent = _find_node_by_ref(tree, node_id)
    if target is None:
        raise ValueError(f"delete_node: узел {node_id!r} не найден")
    if parent is None:
        raise ValueError("delete_node: нельзя удалить корень")
    # Собрать все дочерние id-шники (таблиц/текстблоков/нарушений) для
    # очистки content_data — иначе save_content оставит orphan-записи
    # (но они orphan-фильтром всё равно удалятся; это просто оптимизация).
    table_ids: set[str] = set()
    textblock_ids: set[str] = set()
    violation_ids: set[str] = set()

    def collect_ids(n):
        if n.get("tableId"):
            table_ids.add(n["tableId"])
        if n.get("textBlockId"):
            textblock_ids.add(n["textBlockId"])
        if n.get("violationId"):
            violation_ids.add(n["violationId"])
        for c in n.get("children", []) or []:
            collect_ids(c)

    collect_ids(target)
    # Удаляем узел из children parent
    parent["children"] = [
        c for c in parent.get("children", [])
        if c.get("id") != target["id"]
    ]
    results.append({
        "op": "delete_node",
        "node_id": target["id"],
        "label": target.get("label", ""),
        "number": target.get("number", ""),
        "removed_tables": len(table_ids),
        "removed_textblocks": len(textblock_ids),
        "removed_violations": len(violation_ids),
    })
    return table_ids, textblock_ids, violation_ids


def _apply_move_node(
    tree: dict, op: dict, results: list[dict]
) -> None:
    op = _unwrap_op(op)
    """Перемещает узел (с поддеревом) к новому родителю."""
    node_id = op.get("node_id")
    new_parent_id = op.get("new_parent_id")
    if not node_id or not new_parent_id:
        raise ValueError("move_node: node_id и new_parent_id обязательны")
    if node_id == new_parent_id:
        raise ValueError("move_node: нельзя переместить узел в самого себя")
    target, old_parent = _find_node_by_ref(tree, node_id)
    if target is None:
        raise ValueError(f"move_node: узел {node_id!r} не найден")
    new_parent, _ = _find_node_by_ref(tree, new_parent_id)
    if new_parent is None:
        raise ValueError(f"move_node: new_parent {new_parent_id!r} не найден")
    # Проверим, что new_parent не является потомком target (иначе цикл)
    def is_descendant(n, target_id):
        for c in n.get("children", []) or []:
            if c.get("id") == target_id:
                return True
            if is_descendant(c, target_id):
                return True
        return False
    if is_descendant(target, new_parent["id"]):
        raise ValueError(
            "move_node: new_parent является потомком перемещаемого узла — цикл"
        )
    # Отцепляем
    if old_parent is not None:
        old_parent["children"] = [
            c for c in old_parent.get("children", [])
            if c.get("id") != target["id"]
        ]
    else:
        # Удаляем из root
        tree["children"] = [
            c for c in tree.get("children", [])
            if c.get("id") != target["id"]
        ]
    # Прицепляем
    new_parent.setdefault("children", []).append(target)
    results.append({
        "op": "move_node",
        "node_id": target["id"],
        "label": target.get("label", ""),
        "from_parent_id": old_parent["id"] if old_parent else "root",
        "to_parent_id": new_parent["id"],
    })


async def modify_act_tree_handler(
    *,
    act_id: int | None = None,
    operations: list[dict] | None = None,
    dry_run: bool = False,
) -> str:
    """Комплексные операции над структурой акта.

    Args:
        act_id: id акта.
        operations: список операций (любая комбинация):
            - ``{"op": "add_item", "parent_id": "2", "label": "...",
               "content": "..."}`` — добавить дочерний пункт.
            - ``{"op": "add_sibling", "node_id": "5.1", "label": "..."}`` —
               добавить соседний пункт.
            - ``{"op": "add_textblock", "parent_id": "5", "label": "...",
               "content": "..."}`` — добавить текстовый блок.
            - ``{"op": "add_table", "parent_id": "5", "label": "...",
               "kind": "regularRisk"}`` — добавить таблицу (любого kind).
            - ``{"op": "fill_table", "table_id": "5.2.3", "grid":
               [["Товар","Кол-во"],["Ручка",5]], "mode": "replace"}`` —
               заполнить/обновить таблицу (см.ниже).
            - ``{"op": "add_violation", "parent_id": "5.1", "label": "...",
               "violated": "...", "established": "..."}`` — добавить нарушение.
            - ``{"op": "add_process_mining", "label": "..."}`` — добавить
               раздел «Process Mining» в корень (id='6').
            - ``{"op": "delete_node", "node_id": "5.1.2"}`` — удалить узел.
            - ``{"op": "move_node", "node_id": "5.1.2",
               "new_parent_id": "5.2"}`` — переместить.
            parent_id/node_id могут быть как полным id, так и human-readable
            number ('2', '5.1.2').
        dry_run: если True — операции применяются к копии дерева в памяти,
            но не сохраняются. Используется для предпросмотра.

    Права: Куратор/Руководитель/Редактор/Админ (те же, что у ручного
    редактора структуры). Участник (без can_edit) увидит понятный отказ.

    На успехе возвращает client_action с переходом на
    /constructor?act_id={act_id} и текстовую сводку: какие операции
    выполнены, какие id/number у созданных узлов.
    """
    from app.core.config import get_settings
    from app.db.connection import get_db
    from app.domains.chat.services.tool_executor import get_current_chat_user
    from pydantic import ValidationError
    from app.domains.acts.schemas.act_metadata import ActUpdate

    username = get_current_chat_user()
    if not username:
        return (
            "Не удалось определить пользователя чат-сессии. "
            "Сообщите администратору."
        )

    if act_id is None:
        return (
            "Не указан id акта. Передайте act_id (его можно увидеть "
            "в URL открытого акта или в списке «Мои проекты»)."
        )
    if not operations:
        return (
            "Не переданы операции. Передайте хотя бы одну в "
            "operations: add_item / add_textblock / add_table / "
            "fill_table / add_violation / add_process_mining / "
            "delete_node / move_node."
        )

    # Некоторые LLM (MiniMax) оборачивают каждый dict операции в
    # {"$text": "{...}"} — распаковываем на лету.
    unwrapped_ops: list[dict] = []
    for raw_op in operations:
        raw_op = _unwrap_op(raw_op)
        if not isinstance(raw_op, dict):
            return (
                f"Каждая операция должна быть объектом; получено {type(raw_op).__name__}: "
                f"{raw_op!r:.200}"
            )
        unwrapped_ops.append(raw_op)
    operations = unwrapped_ops

    # Шаг 1: проверка доступа + права на редактирование
    from app.domains.acts.repositories.act_access import ActAccessRepository
    from app.domains.acts.repositories.act_lock import ActLockRepository
    from app.domains.acts.services.access_guard import AccessGuard

    async with get_db() as conn:
        access_repo = ActAccessRepository(conn)
        lock_repo = ActLockRepository(conn)
        guard = AccessGuard(access_repo, lock_repo)

        try:
            await guard.require_access(act_id, username)
            perm = await access_repo.get_user_edit_permission(act_id, username)
        except Exception as exc:
            logger.warning(
                "modify_act_tree: доступ запрещён user=%s act=%s: %s",
                username, act_id, exc,
            )
            return (
                f"Нет доступа к акту {act_id}: {exc}. "
                f"Проверьте, что вы участник команды этого акта."
            )
        if not perm.get("can_edit"):
            role = perm.get("role") or "(не в команде)"
            return (
                f"Ваша роль в акте ({role}) позволяет только просматривать "
                f"акт. Редактировать структуру могут Куратор, Руководитель "
                f"или Редактор. Попросите одного из них выполнить операцию."
            )

        # Шаг 2: загрузить текущее содержимое
        from app.domains.acts.repositories.act_content import ActContentRepository

        content_repo = ActContentRepository(conn)
        content = await content_repo.get_content(act_id)
        tree = content["tree"]
        tables = dict(content.get("tables") or {})
        textblocks = dict(content.get("textBlocks") or {})
        violations = dict(content.get("violations") or {})

        # Шаг 3: применить операции к локальной копии
        results: list[dict] = []
        errors: list[str] = []
        try:
            for op_index, op in enumerate(operations, start=1):
                kind = op.get("op")
                try:
                    if kind == "add_item":
                        _apply_add_item(tree, op, results)
                    elif kind == "add_sibling":
                        _apply_add_sibling(tree, op, results)
                    elif kind == "add_textblock":
                        _apply_add_textblock(tree, "textBlocks",
                                            textblocks, op, results)
                    elif kind == "add_table":
                        _apply_add_table(tree, "tables",
                                          tables, op, results)
                    elif kind == "fill_table":
                        _apply_fill_table(tree, tables, op, results)
                    elif kind == "add_violation":
                        _apply_add_violation(tree, "violations",
                                              violations, op, results)
                    elif kind == "add_process_mining":
                        _apply_add_process_mining(tree, op, results)
                    elif kind == "delete_node":
                        t_ids, tb_ids, v_ids = _apply_delete_node(
                            tree, op, results,
                        )
                        # Удаляем каскадно записи из content-таблиц
                        for tid in t_ids:
                            tables.pop(tid, None)
                        for tbid in tb_ids:
                            textblocks.pop(tbid, None)
                        for vid in v_ids:
                            violations.pop(vid, None)
                    elif kind == "move_node":
                        _apply_move_node(tree, op, results)
                    else:
                        errors.append(
                            f"#{op_index}: неизвестная операция {kind!r}. "
                            f"Допустимые: add_item, add_sibling, add_textblock, "
                            f"add_table, fill_table, add_violation, "
                            f"add_process_mining, delete_node, move_node."
                        )
                except ValueError as exc:
                    errors.append(f"#{op_index}: {exc}")
        except Exception as exc:
            logger.exception(
                "modify_act_tree: ошибка при применении операций: %s", exc
            )
            return (
                f"Внутренняя ошибка при обработке операций: {exc}. "
                f"Ничего не сохранено (dry_run=False, но ошибка до commit)."
            )

        if errors:
            return (
                "Не удалось выполнить все операции:\n\n"
                + "\n".join(f"- {e}" for e in errors)
                + "\n\nНичего не сохранено (rollback)."
            )

        # Шаг 4: перенумерация (как в state-tree.js generateNumbering).
        _renumber_tree(tree)

        # Шаг 5: сохранить
        if not dry_run:
            from app.domains.acts.schemas.act_content import ActDataSchema

            data = ActDataSchema(
                tree=tree,
                tables=tables,
                textBlocks=textblocks,
                violations=violations,
            )
            await content_repo.save_content(act_id, data, username)

        km_row = await conn.fetchrow(
            "SELECT km_number FROM t_db_oarb_audit_act_acts WHERE id = $1",
            act_id,
        )
        km = km_row["km_number"] if km_row else f"id={act_id}"

    # Формируем сводку
    summary_lines = [
        f"В акт {km} внесено {len(results)} изменений"
        f"{' (dry-run, НЕ сохранено)' if dry_run else ''}:\n"
    ]
    for r in results:
        op_kind = r["op"]
        if op_kind == "add_item" or op_kind == "add_sibling":
            summary_lines.append(
                f"- {op_kind}: «{r['label']}» (number={r['number']}, "
                f"id={r['node_id']}) в parent_id={r['parent_id']}"
            )
        elif op_kind == "add_textblock":
            summary_lines.append(
                f"- textblock «{r['label']}» (id={r['node_id']}, "
                f"textBlockId={r['textBlockId']}) в parent_id={r['parent_id']}"
            )
        elif op_kind == "add_table":
            summary_lines.append(
                f"- table «{r['label']}» (kind={r['kind']}, id={r['node_id']}, "
                f"tableId={r['tableId']}) в parent_id={r['parent_id']}"
            )
        elif op_kind == "fill_table":
            summary_lines.append(
                f"- fill_table: таблица {r['table_id']!r} (id={r['node_id']}) "
                f"обновлена в режиме «{r['mode']}» — {r['rows']}×{r['cols']}"
            )
        elif op_kind == "add_violation":
            summary_lines.append(
                f"- violation «{r['label']}» (id={r['node_id']}, "
                f"violationId={r['violationId']}) в parent_id={r['parent_id']}"
            )
        elif op_kind == "add_process_mining":
            if r.get("skipped"):
                summary_lines.append(f"- process_mining: пропущено ({r['reason']})")
            else:
                summary_lines.append(
                    f"- process_mining раздел добавлен (id={r['node_id']}, "
                    f"label={r['label']!r})"
                )
        elif op_kind == "delete_node":
            summary_lines.append(
                f"- удалён узел «{r['label']}» ({r['number']}, "
                f"id={r['node_id']}); "
                f"каскадно удалено: {r['removed_tables']} таблиц, "
                f"{r['removed_textblocks']} текстблоков, "
                f"{r['removed_violations']} нарушений"
            )
        elif op_kind == "move_node":
            summary_lines.append(
                f"- перемещён «{r['label']}» (id={r['node_id']}) "
                f"из {r['from_parent_id']} → {r['to_parent_id']}"
            )

    logger.info(
        "AI-ассистент modify_act_tree: act=%s ops=%s dry_run=%s user=%s",
        act_id, [r["op"] for r in results], dry_run, username,
    )

    # Возвращаем JSON-список блоков: client_action (refresh_act) +
    # текстовый summary. _parse_blocks_list_result в agent_loop.py
    # разворачивает список в emitted_blocks — конструктор получит
    # client_action и обновится in-place, а summary попадёт в
    # сообщение ассистента для контекста пользователя.
    #
    # Раньше возвращали JSON + "\n\n" + summary — это ломало
    # json.loads (raw-строка невалидна), client_action терялся,
    # и конструктор НЕ обновлялся (требовался Ctrl+Shift+R).
    return json.dumps(
        [
            {
                "type": "client_action",
                "action": ACTION_REFRESH_ACT,
                "params": {"act_id": act_id},
                "label": f"Акт {km} обновлён, обновляю конструктор…",
            },
            {
                "type": "text",
                "content": "\n".join(summary_lines),
            },
        ],
        ensure_ascii=False,
    )


def _renumber_tree(node: dict, prefix: str = "") -> None:
    """Перенумерация дерева — как в state-tree.js generateNumbering."""
    children = node.get("children", []) or []
    if not children:
        return
    table_count = 0
    text_block_count = 0
    violation_count = 0
    item_count = 0
    for child in children:
        ctype = child.get("type")
        if ctype == "table":
            child["number"] = f"Таблица {table_count + 1}"
            table_count += 1
        elif ctype == "textblock":
            child["number"] = f"Текстовый блок {text_block_count + 1}"
            text_block_count += 1
        elif ctype == "violation":
            child["number"] = f"Нарушение {violation_count + 1}"
            violation_count += 1
        else:
            item_count += 1
            if prefix:
                child["number"] = f"{prefix}.{item_count}"
            else:
                child["number"] = str(item_count)
            _renumber_tree(child, child["number"])
