"""
Обнаружение и регистрация доменов.

Сканирует app/domains/*/, импортирует DomainDescriptor из каждого пакета,
регистрирует роутеры и обработчики ошибок в приложении FastAPI.

Дополнительно содержит вспомогательные реестры межсоменного взаимодействия:

* ``register_factory``/``get_factory`` — реестр фабрик доменных компонентов.
  Позволяет потребителям получать инстанс по строковому ключу
  (например, ``"admin.user_directory"``) без прямого импорта класса.

* ``register_startup_hook``/``register_shutdown_hook`` —
  ``app/main.py`` итерирует зарегистрированные hooks в lifespan вместо
  явных импортов доменных ``set_*_batcher``. ``on_startup``-hooks
  вызываются ПОСЛЕ ``discover_domains()``, ПОСЛЕ ``settings_registry``,
  ПОСЛЕ инициализации DB pool, но ДО захвата singleton-lock.
  ``on_shutdown``-hooks вызываются в обратном порядке регистрации.
"""

import importlib
import logging
from bisect import insort
from collections import deque
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI

from app.core.domain import DomainDescriptor

logger = logging.getLogger("audit_workstation.core.domain_registry")

_domains: list[DomainDescriptor] = []
_registered_app_ids: set[int] = set()

# Реестр фабрик доменных компонентов: ключ → callable, возвращающий инстанс.
# Используется для cross-domain DI без прямого импорта классов реализации.
_factories: dict[str, Callable[..., Any]] = {}

# Lifespan-hooks доменов. Сохраняем порядок регистрации; на shutdown
# проходим в обратном порядке. Имя — для логов и идемпотентности.
_startup_hooks: list[tuple[str, Callable[[FastAPI], Awaitable[None]]]] = []
_shutdown_hooks: list[tuple[str, Callable[[FastAPI], Awaitable[None]]]] = []

# Callback-инвалидаторы, вызываемые при изменении состава доменов
# (используется навигационным кешем).
_domain_change_listeners: list[Callable[[], None]] = []

REQUIRED_DOMAINS = {"acts"}


def discover_domains(domains_dir: Path) -> list[DomainDescriptor]:
    """
    Сканирует директорию доменов и возвращает список DomainDescriptor.

    Каждая поддиректория с __init__.py должна экспортировать атрибут `domain`.
    Результат кэшируется — повторный вызов возвращает тот же список.
    """
    global _domains

    if _domains:
        return _domains

    if not domains_dir.exists():
        logger.warning(f"Директория доменов не найдена: {domains_dir}")
        return []

    discovered = []

    for entry in sorted(domains_dir.iterdir()):
        if not entry.is_dir():
            continue
        init_file = entry / "__init__.py"
        if not init_file.exists():
            continue

        module_name = f"app.domains.{entry.name}"
        try:
            module = importlib.import_module(module_name)
        except Exception as exc:
            raise RuntimeError(
                f"Не удалось импортировать домен {module_name}"
            ) from exc

        # Поддержка lazy-инициализации: _build_domain() или domain атрибут
        descriptor = getattr(module, "domain", None)
        if descriptor is None:
            build_fn = getattr(module, "_build_domain", None)
            if callable(build_fn):
                try:
                    descriptor = build_fn()
                except Exception as exc:
                    raise RuntimeError(
                        f"Не удалось собрать домен {module_name}"
                    ) from exc

        if not isinstance(descriptor, DomainDescriptor):
            logger.warning(
                f"Модуль {module_name} не содержит атрибут 'domain' типа DomainDescriptor"
            )
            continue

        if descriptor.package_path is None:
            descriptor.package_path = entry

        # Настройки загружаются ДО регистрации домена —
        # ошибка в settings блокирует запуск, а не падает при первом запросе
        if descriptor.settings_class is not None:
            from app.core.settings_registry import register
            register(descriptor.name, descriptor.settings_class)
            logger.debug(f"Настройки домена {descriptor.name} загружены")

        # Регистрация chat tools
        if descriptor.chat_tools:
            from app.core.chat.tools import register_tools
            register_tools(descriptor.chat_tools)
            logger.debug(
                f"Chat tools домена {descriptor.name}: "
                f"{len(descriptor.chat_tools)}"
            )

        discovered.append(descriptor)
        logger.debug(f"Обнаружен домен: {descriptor.name}")

    # Проверка обязательных доменов
    discovered_names = {d.name for d in discovered}
    missing = REQUIRED_DOMAINS - discovered_names
    if missing:
        raise RuntimeError(
            f"Обязательные домены не обнаружены: {', '.join(sorted(missing))}"
        )

    # Топологическая сортировка по зависимостям
    discovered = _toposort(discovered)

    _domains = discovered
    _notify_domain_change()
    return _domains


def _toposort(domains: list[DomainDescriptor]) -> list[DomainDescriptor]:
    """Топологическая сортировка доменов по полю dependencies."""
    name_to_domain = {d.name: d for d in domains}
    known_names = set(name_to_domain)

    # Валидация: все зависимости должны существовать
    for d in domains:
        unknown = set(d.dependencies) - known_names
        if unknown:
            raise RuntimeError(
                f"Домен '{d.name}' зависит от неизвестных доменов: "
                f"{', '.join(sorted(unknown))}"
            )

    # Алгоритм Кана
    in_degree: dict[str, int] = {d.name: 0 for d in domains}
    dependents: dict[str, list[str]] = {d.name: [] for d in domains}
    for d in domains:
        for dep in d.dependencies:
            in_degree[d.name] += 1
            dependents[dep].append(d.name)

    queue = deque(sorted(name for name, deg in in_degree.items() if deg == 0))
    result: list[DomainDescriptor] = []

    while queue:
        name = queue.popleft()
        result.append(name_to_domain[name])
        for dep_name in dependents[name]:
            in_degree[dep_name] -= 1
            if in_degree[dep_name] == 0:
                insort(queue, dep_name)

    if len(result) != len(domains):
        raise RuntimeError("Циклическая зависимость между доменами")

    return result


def register_domains(
    app: FastAPI,
    domains: list[DomainDescriptor],
    api_prefix: str,
) -> None:
    """
    Регистрирует роутеры и обработчики ошибок доменов в FastAPI приложении.
    """
    global _registered_app_ids
    app_id = id(app)
    if app_id in _registered_app_ids:
        logger.debug("Домены уже зарегистрированы в этом приложении, пропуск")
        return
    _registered_app_ids.add(app_id)

    registered_exc_classes: dict[type[Exception], str] = {}

    from app.api.v1.deps.role_deps import require_admin, require_domain_access

    api_count = 0
    html_count = 0

    for d in domains:
        # Определяем зависимости проверки ролей для домена
        if d.public_api:
            # Общий кросс-доменный API без доменного гейта (центр уведомлений):
            # доступен всем авторизованным, проверка роли на роутер не вешается.
            role_deps = []
        elif d.name == "admin":
            role_deps = [Depends(require_admin())]
        else:
            role_deps = [Depends(require_domain_access(d.name))]

        # API роутеры
        for router, prefix, tags in d.api_routers:
            full_prefix = f"{api_prefix}{prefix}"
            app.include_router(
                router, prefix=full_prefix, tags=tags,
                dependencies=role_deps,
            )
            logger.debug(f"Домен {d.name}: API {full_prefix}")
            api_count += 1

        # HTML роутеры
        for router in d.html_routers:
            app.include_router(router, dependencies=role_deps)
            logger.debug(f"Домен {d.name}: HTML роутер зарегистрирован")
            html_count += 1

        # Обработчики ошибок (с детекцией коллизий)
        if d.exception_handlers:
            for exc_class, handler in d.exception_handlers.items():
                if exc_class in registered_exc_classes:
                    raise RuntimeError(
                        f"Коллизия exception handler: {exc_class.__name__} "
                        f"уже зарегистрирован доменом '{registered_exc_classes[exc_class]}', "
                        f"домен '{d.name}' пытается перезаписать"
                    )
                app.add_exception_handler(exc_class, handler)
                registered_exc_classes[exc_class] = d.name
                logger.debug(f"Домен {d.name}: обработчик {exc_class.__name__}")

    logger.debug(
        f"Роутеры зарегистрированы: {api_count} API, {html_count} HTML",
    )


def get_domain(name: str) -> DomainDescriptor | None:
    """Возвращает домен по имени."""
    for d in _domains:
        if d.name == name:
            return d
    return None


def get_all_domains() -> list[DomainDescriptor]:
    """Возвращает все зарегистрированные домены."""
    return list(_domains)


def reset_registry() -> None:
    """Сбрасывает реестр (для тестов)."""
    global _domains, _registered_app_ids
    _domains = []
    _registered_app_ids = set()
    _factories.clear()
    _startup_hooks.clear()
    _shutdown_hooks.clear()
    # Слушателей уведомляем перед очисткой их списка: пусть инвалидируют
    # кеши, которые могли наполниться от старого набора доменов.
    _notify_domain_change()
    _domain_change_listeners.clear()


# --- Реестр фабрик доменных компонентов ---------------------------------

def register_factory(key: str, factory: Callable[..., Any]) -> None:
    """
    Регистрирует фабрику доменного компонента под строковым ключом.

    Конвенция ключа: ``"<домен>.<компонент>"`` (например,
    ``"admin.user_directory"``). Повторная регистрация под тем же ключом
    перезаписывает предыдущую — это полезно для тестов и стабов.
    """
    if not key or "." not in key:
        raise ValueError(
            f"Ключ фабрики должен иметь формат '<домен>.<компонент>', получено: {key!r}"
        )
    _factories[key] = factory
    logger.debug("Зарегистрирована фабрика: %s", key)


def get_factory(key: str) -> Callable[..., Any]:
    """
    Возвращает зарегистрированную фабрику по ключу.

    Бросает ``KeyError``, если фабрика не зарегистрирована — это
    программная ошибка (отсутствует зависимость домена), а не runtime.
    """
    try:
        return _factories[key]
    except KeyError as exc:
        raise KeyError(
            f"Фабрика '{key}' не зарегистрирована. "
            f"Проверьте, что соответствующий домен инициализирован."
        ) from exc


def has_factory(key: str) -> bool:
    """Проверяет наличие фабрики (для условной логики и тестов)."""
    return key in _factories


# --- Реестр lifespan-hooks ----------------------------------------------

def register_startup_hook(
    name: str,
    callback: Callable[[FastAPI], Awaitable[None]],
) -> None:
    """
    Регистрирует startup-hook. Вызывается из lifespan приложения после
    инициализации БД и регистрации доменных Settings, но до singleton-lock.
    Порядок вызовов соответствует порядку регистрации.
    """
    _startup_hooks.append((name, callback))
    logger.debug("Зарегистрирован startup-hook: %s", name)


def register_shutdown_hook(
    name: str,
    callback: Callable[[FastAPI], Awaitable[None]],
) -> None:
    """
    Регистрирует shutdown-hook. Вызывается из lifespan приложения
    в обратном порядке регистрации.
    """
    _shutdown_hooks.append((name, callback))
    logger.debug("Зарегистрирован shutdown-hook: %s", name)


def get_startup_hooks() -> list[tuple[str, Callable[[FastAPI], Awaitable[None]]]]:
    """Возвращает список startup-hooks в порядке регистрации."""
    return list(_startup_hooks)


def get_shutdown_hooks() -> list[tuple[str, Callable[[FastAPI], Awaitable[None]]]]:
    """Возвращает список shutdown-hooks в порядке регистрации."""
    return list(_shutdown_hooks)


def has_startup_hook(name: str) -> bool:
    """
    Проверяет, зарегистрирован ли startup-hook с данным именем.

    Используется вызывающей стороной для идемпотентной регистрации:
    вместо собственного модульного флага (переживающего reset_registry())
    проверяется актуальное состояние самого реестра.
    """
    return any(hook_name == name for hook_name, _ in _startup_hooks)


# --- Слушатели изменений состава доменов --------------------------------

def add_domain_change_listener(listener: Callable[[], None]) -> None:
    """
    Регистрирует callback-инвалидатор, вызываемый при изменении
    состава доменов (см. ``register_domains``/``reset_registry``).
    Используется кешами, зависящими от ``get_all_domains()``.
    """
    _domain_change_listeners.append(listener)


def _notify_domain_change() -> None:
    """Вызывает всех слушателей изменения состава доменов."""
    for listener in _domain_change_listeners:
        try:
            listener()
        except Exception:
            logger.exception("Ошибка в domain change listener")
