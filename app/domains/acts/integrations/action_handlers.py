"""Handler'ы action-инструментов домена acts."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import date

from pydantic import ValidationError

from app.core.chat.names import ACTION_NOTIFY, ACTION_OPEN_URL

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

    url = f"/constructor?act_id={result.id}"
    return _client_action(
        action=ACTION_OPEN_URL,
        params={"url": url},
        label=f"Открываю новый акт {act_create.km_number}…",
    )
