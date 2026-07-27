"""
Навигация: сбор NavItem и сквозных данных из всех зарегистрированных доменов.

Sidebar формируется динамически — домены декларируют свои NavItem,
а шаблон рендерит их в порядке NavItem.order.

Кеширование: за вызов sidebar-страницы выполняется несколько обходов
``get_all_domains()`` (на каждый шаблон). Чтобы не строить структуру
заново при каждом запросе, результаты ``get_nav_items_for_user`` и
``get_knowledge_bases`` кешируются на 60 секунд с инвалидацией через
``domain_registry.add_domain_change_listener`` (при перерегистрации
доменов кеш сбрасывается немедленно). Ключ кеша для per-user — frozenset
имён ролей и доменов, без идентификации пользователя.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.core.domain import KnowledgeBase, NavItem


# TTL кеша в секундах. Sidebar-данные стабильны между деплоями, 60 секунд
# балансирует freshness и нагрузку. При изменении состава доменов кеш
# инвалидируется немедленно через listener (см. _invalidate_cache).
_CACHE_TTL_SEC = 60.0

# Кеши: ключ → (timestamp, значение).
_nav_items_for_user_cache: dict[frozenset[tuple[str, str]], tuple[float, list[dict]]] = {}
_knowledge_bases_cache: tuple[float, list[KnowledgeBase]] | None = None


def _invalidate_cache() -> None:
    """Сбрасывает все кеши навигации. Регистрируется как listener в domain_registry."""
    global _knowledge_bases_cache
    _nav_items_for_user_cache.clear()
    _knowledge_bases_cache = None


def _ensure_invalidator_registered() -> None:
    """Регистрирует listener в domain_registry, если он отсутствует.

    Вызывается лениво из cache-функций: ``reset_registry`` в тестах очищает
    список listener'ов, поэтому повторная регистрация необходима.
    Идемпотентна — повторная регистрация при наличии listener'а пропускается.
    """
    from app.core import domain_registry

    # Прямой доступ к module-level списку — проверяем наличие, чтобы не
    # дублировать listener при многократных вызовах в рамках одного теста.
    if _invalidate_cache not in domain_registry._domain_change_listeners:
        domain_registry.add_domain_change_listener(_invalidate_cache)


def get_nav_items() -> list[NavItem]:
    """Собирает NavItem из всех доменов, сортирует по order."""
    from app.core.domain_registry import get_all_domains

    items: list[NavItem] = []
    for d in get_all_domains():
        items.extend(d.nav_items)
    return sorted(items, key=lambda x: x.order)


def get_chat_domains_for_page(active_page: str) -> list[str] | None:
    """
    Возвращает список доменов для фильтрации chat tools по active_page.

    Ищет NavItem с совпадающим active_page и возвращает его chat_domains.
    Для landing (active_page="landing") возвращает None (все tools).
    """
    if active_page == "landing":
        return None

    from app.core.domain_registry import get_all_domains

    for d in get_all_domains():
        for nav in d.nav_items:
            if nav.active_page == active_page and nav.chat_domains:
                return nav.chat_domains
    return None


def get_nav_items_grouped() -> list[dict]:
    """Собирает NavItem сгруппированные по group. Возвращает [{group, items}]."""
    items = get_nav_items()
    groups: dict[str, list[NavItem]] = {}
    for item in items:
        g = item.group or ""
        groups.setdefault(g, []).append(item)
    return [{"group": group_name, "nav_items": group_items} for group_name, group_items in groups.items()]


def get_nav_items_for_user(roles: list[dict]) -> list[dict]:
    """
    Собирает NavItem, фильтруя по ролям пользователя.

    Админ видит все элементы. Обычный пользователь видит только домены,
    к которым у него есть доступ (по domain_name в ролях).
    Пустые группы не включаются.

    Результат кешируется на 60 секунд. Ключ — frozenset пар
    ``(name, domain_name)`` из ролей пользователя. Кеш инвалидируется
    при изменении состава доменов.
    """
    from app.core.domain_registry import get_all_domains

    _ensure_invalidator_registered()

    # Ключ: frozenset пар (имя_роли, имя_домена) — стабильный набор
    # вне зависимости от порядка и идентификатора пользователя.
    cache_key: frozenset[tuple[str, str]] = frozenset(
        (r.get("name", ""), r.get("domain_name") or "") for r in roles
    )
    now = time.monotonic()
    cached = _nav_items_for_user_cache.get(cache_key)
    if cached is not None and (now - cached[0]) < _CACHE_TTL_SEC:
        return cached[1]

    is_admin = any(r["name"] == "Администратор" for r in roles)
    user_domains = {r["domain_name"] for r in roles if r.get("domain_name")}

    items: list[NavItem] = []
    for d in get_all_domains():
        if is_admin or d.name in user_domains:
            items.extend(d.nav_items)
    items.sort(key=lambda x: x.order)

    # Группировка, пустые группы исключаются
    groups: dict[str, list[NavItem]] = {}
    for item in items:
        g = item.group or ""
        groups.setdefault(g, []).append(item)
    result = [
        {"group": group_name, "nav_items": group_items}
        for group_name, group_items in groups.items()
    ]
    _nav_items_for_user_cache[cache_key] = (now, result)
    return result


def get_knowledge_bases() -> list[KnowledgeBase]:
    """Собирает KnowledgeBase из всех доменов.

    Результат кешируется на 60 секунд; инвалидация при изменении
    состава доменов.
    """
    global _knowledge_bases_cache
    from app.core.domain_registry import get_all_domains

    _ensure_invalidator_registered()

    now = time.monotonic()
    if _knowledge_bases_cache is not None and (now - _knowledge_bases_cache[0]) < _CACHE_TTL_SEC:
        return _knowledge_bases_cache[1]

    bases: list[KnowledgeBase] = []
    for d in get_all_domains():
        bases.extend(d.knowledge_bases)
    _knowledge_bases_cache = (now, bases)
    return bases


def get_knowledge_bases_as_dicts() -> list[dict]:
    """Собирает KnowledgeBase как список dict (для JSON-сериализации в шаблонах)."""
    from dataclasses import asdict
    return [asdict(kb) for kb in get_knowledge_bases()]


# --- Приветствие AI-ассистента -------------------------------------------------
#
# Контекст для приветственного сообщения AI-ассистента в ``shared/chat_content.html``.
# Формируется один раз на запрос и кешируется так же, как nav_items (TTL 60с).
# Структура контекста:
# - ``quick_buttons`` — 3 кнопки быстрого перехода: Администрирование (только
#   админ), Управление актами, План проверок. Скрываются, если недоступны.
# - ``available_ck`` — список ЦК (группа «ЦЕНТРЫ КОМПЕТЕНЦИЙ»), к которым
#   у пользователя есть доступ (фильтр по d.name — только реальные роли,
#   НЕ по chat_domains, чтобы не показывать «доступные всем»).
# - ``available_agents`` — список агентов (группа «АГЕНТЫ»), к которым
#   у пользователя есть доступ (фильтр по chat_domains; для главного
#   SQL-агента — наличие любой роли в sqlagent*).
# - ``inspections`` — список актов, в команде которых состоит пользователь.
# - ``is_admin`` — флаг системной роли (для условных элементов в шаблоне).
#
# Зачем вынесено в helper: чтобы шаблон приветствия оставался декларативным
# (только рендеринг по контексту), а логика фильтрации по доменам и обращения
# к БД за проверками — жила в одном месте, рядом с прочей логикой навигации.


# Короткие отображаемые имена для ЦК в приветствии AI-ассистента.
# Исторически «ЦК Code» (без Mining), но заказчик попросил полное имя —
# «ЦК Code Mining». Остальные — без сокращений.
_CK_DISPLAY_LABELS = {
    "ck_code_mining": "ЦК Code Mining",
    "ck_process_mining": "ЦК Process Mining",
    "ck_client_exp": "ЦК Клиентский опыт",
    "ck_fin_res": "ЦК Фин. результат",
}


async def build_chat_greeting_context(
    roles: list[dict],
    username: str | None,
) -> dict:
    """Готовит данные для приветственного сообщения AI-ассистента.

    Возвращает dict с полями:

    * ``is_admin`` — признак системной роли «Администратор»;
    * ``quick_buttons`` — кнопки быстрого перехода: «Администрирование»
      (только админ), «Управление актами», «План проверок». Только те,
      к которым у пользователя есть доступ;
    * ``available_ck`` — список ЦК с ``label``/``description``/``url``.
      Берётся из NavItem-ов группы «ЦЕНТРЫ КОМПЕТЕНЦИЙ», фильтрация — по
      ``d.name in user_domains`` (только реальные роли в ck-доменах);
    * ``available_agents`` — список агентов (группа «АГЕНТЫ») с label,
      description, url и icon_svg. SQL-агент показывается, если у пользователя
      есть любая роль в sqlagent*. Остальные агенты — по ``chat_domains``;
    * ``inspections`` — список ``[{"km_number", "inspection_name",
      "period", "role"}]`` актов, в команде которых состоит пользователь.
      Пустой список, если таких нет — тогда шаблон не выводит блок.
    """
    from app.core.domain_registry import get_all_domains

    _ensure_invalidator_registered()

    is_admin = any(r.get("name") == "Администратор" for r in roles)
    user_domains = {r.get("domain_name") for r in roles if r.get("domain_name")}

    # Группируем NavItem-ы по доменам (для фильтрации ЦК и SQL-агента),
    # а также собираем плоский список для фильтрации по chat_domains.
    domains_items: dict[str, list[NavItem]] = {}
    all_items: list[NavItem] = []
    for d in get_all_domains():
        domains_items[d.name] = list(d.nav_items)
        all_items.extend(d.nav_items)

    # ── 1. Кнопки быстрого перехода (Администрирование / Управление актами /
    # План проверок). Виртуальный пункт «Администрирование» есть только для админа.
    quick_buttons: list[dict] = []

    if is_admin:
        quick_buttons.append({
            "label": "Администрирование",
            "url": "/admin",
            "icon_svg": (
                # замок (как в sidebar) — символ приватного раздела
                '<path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 '
                '00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" '
                'stroke="currentColor" stroke-width="2" '
                'stroke-linecap="round" stroke-linejoin="round"/>'
            ),
        })

    for item in all_items:
        if item.active_page in ("acts", "acts-plan"):
            # Доступ к «Управление актами» / «План проверок» — по d.name
            # (т.е. у пользователя должна быть роль в домене acts),
            # а НЕ по chat_domains (которые могут включать лишние домены
            # и делать их «доступными всем»).
            domain_name = _domain_for_nav_item(item, domains_items)
            if domain_name and (is_admin or domain_name in user_domains):
                quick_buttons.append({
                    "label": item.label,
                    "url": item.url,
                    "icon_svg": item.icon_svg,
                })

    # Сортируем: Администрирование уже первым, дальше — по order в NavItem.
    quick_buttons.sort(key=lambda b: _quick_button_order(b["label"]))

    # ── 2. Доступные ЦК (фильтр по d.name — реальные роли).
    available_ck: list[dict] = []
    for item in all_items:
        if item.group != "ЦЕНТРЫ КОМПЕТЕНЦИЙ":
            continue
        domain_name = _domain_for_nav_item(item, domains_items)
        if not domain_name:
            continue
        if not (is_admin or domain_name in user_domains):
            continue
        display_label = _CK_DISPLAY_LABELS.get(domain_name, item.label)
        available_ck.append({
            "label": display_label,
            "description": item.description or "",
            "url": item.url,
            "icon_svg": item.icon_svg,
        })
    available_ck.sort(key=lambda x: x["label"])

    # ── 3. Доступные Агенты (группа «АГЕНТЫ»).
    has_any_sqlagent = any(d.startswith("sqlagent") for d in user_domains)
    available_agents: list[dict] = []
    for item in all_items:
        if item.group != "АГЕНТЫ":
            continue
        if item.active_page == "sqlagent":
            # Главный SQL-агент — отдельная логика: показываем если есть
            # любая роль в sqlagent* (не только sqlagent, но и sqlagent_ior
            # и т.д.).
            if not (is_admin or has_any_sqlagent):
                continue
        else:
            # Агенты-инструменты (ИОР, CRM и т.п.) — по chat_domains.
            if not (is_admin or any(d in user_domains for d in item.chat_domains)):
                continue
        available_agents.append({
            "label": item.label,
            "description": item.description or "",
            "url": item.url,
            "icon_svg": item.icon_svg,
        })
    available_agents.sort(key=lambda x: _agent_order(x["label"]))

    # ── 4. Проверки пользователя.
    inspections: list[dict] = []
    if username:
        inspections = await _load_user_inspections(username)

    return {
        "is_admin": is_admin,
        "quick_buttons": quick_buttons,
        "available_ck": available_ck,
        "available_agents": available_agents,
        "inspections": inspections,
    }


def _domain_for_nav_item(item: NavItem, domains_items: dict[str, list[NavItem]]) -> str | None:
    """Возвращает имя домена, к которому относится NavItem.

    Нужно для фильтрации ЦК / SQL-агента / Актов по ``d.name in user_domains``
    (а не по ``chat_domains``, которые могут быть расширены).
    """
    for d_name, items in domains_items.items():
        if item in items:
            return d_name
    return None


def _quick_button_order(label: str) -> int:
    """Фиксированный порядок кнопок быстрого перехода."""
    order = {
        "Администрирование": 0,
        "Управление актами": 1,
        "План проверок": 2,
    }
    return order.get(label, 99)


def _agent_order(label: str) -> int:
    """Фиксированный порядок агентов в блоке «Доступные Агенты»."""
    order = {
        "SQL-агент": 0,
        "ИОР": 1,
        "CRM": 2,
        "Документы": 3,
        "Источники данных": 4,
        "BackLog команд": 5,
        "Follow UP": 6,
    }
    return order.get(label, 99)


async def _load_user_inspections(username: str) -> list[dict]:
    """Возвращает список актов, в команде которых состоит пользователь.

    Формат строки — как на UI-карточке в «Моих проектах»: «КМ-99-XXXXX,
    период 12.05–25.05.2025, роль». Используем ту же логику, что и
    ``/api/v1/acts/my-projects``: INNER JOIN с ``audit_team_members``,
    роль — ``MIN(atm.role)`` на случай нескольких членств.
    """
    try:
        from app.db.connection import get_db

        async with get_db() as conn:
            rows = await conn.fetch(
                """
                SELECT a.km_number,
                       a.inspection_name,
                       a.inspection_start_date,
                       a.inspection_end_date,
                       MIN(atm.role) AS my_role
                FROM t_db_oarb_audit_act_acts a
                INNER JOIN t_db_oarb_audit_act_audit_team_members atm
                    ON a.id = atm.act_id
                WHERE atm.username = $1
                GROUP BY a.id, a.km_number, a.inspection_name,
                         a.inspection_start_date, a.inspection_end_date
                ORDER BY a.inspection_end_date DESC NULLS LAST, a.id DESC
                LIMIT 100
                """,
                username,
            )
    except Exception:
        # Если БД/схема недоступна — чат должен продолжать работать.
        # Возвращаем пустой список: блок «доступные проверки» не выведется.
        return []

    out: list[dict] = []
    for r in rows:
        start = r["inspection_start_date"]
        end = r["inspection_end_date"]
        period = _format_period(start, end)
        out.append({
            "km_number": r["km_number"] or "",
            "inspection_name": r["inspection_name"] or "",
            "period": period,
            "role": r["my_role"] or "Участник",
        })
    return out


def _format_period(start, end) -> str:
    """Человекочитаемый период проверки: «12.05 – 25.05.2025» / «2025».

    Если оба конца в одном году — показываем год один раз в конце;
    если годы разные — добавляем год к каждой дате.
    """
    if start is None and end is None:
        return ""

    def _fmt(d, with_year: bool) -> str:
        if d is None:
            return ""
        return d.strftime("%d.%m.%Y") if with_year else d.strftime("%d.%m")

    if start is None:
        return _fmt(end, with_year=True)
    if end is None:
        return _fmt(start, with_year=True)

    if start.year == end.year:
        if start == end:
            return _fmt(start, with_year=True)
        return f"{_fmt(start, with_year=False)} – {_fmt(end, with_year=True)}"
    return f"{_fmt(start, with_year=True)} – {_fmt(end, with_year=True)}"
