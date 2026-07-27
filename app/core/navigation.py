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
