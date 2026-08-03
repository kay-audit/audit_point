"""
Зависимости для проверки ролей пользователей.

Предоставляет get_user_roles, require_domain_access, require_admin
для использования в FastAPI Depends при регистрации роутеров.
"""

import logging
from typing import Callable

from cachetools import TTLCache
from fastapi import Depends, HTTPException, Request

from app.api.v1.deps.auth_deps import get_username
from app.auth.user_repository import (
    USER_CACHE_EPOCH_KEY_PREFIX,
    read_user_cache_epoch,
)
from app.core.redis import get_redis
from app.db.connection import get_db, get_adapter

logger = logging.getLogger("audit_workstation.api.deps.roles")

# Кеш ролей: maxsize=256, ttl=5 секунд.
# TTL короткий — это последняя линия защиты от устаревших прав при отсутствии
# межпроцессной инвалидации (см. invalidate_user_roles_cache). L2 — Redis,
# см. _ROLES_CACHE_KEY_PREFIX ниже: переживает рестарт процесса и разделяется
# между процессами (в отличие от L1).
_roles_cache: TTLCache = TTLCache(maxsize=256, ttl=5)

# Полный ключ — префикс + username + номер эпохи (см. read_user_cache_epoch).
_ROLES_CACHE_KEY_PREFIX = "cache:roles:"
_ROLES_CACHE_TTL_SEC = 300

# Роли, автоматически назначаемые пользователю при первом обращении.
DEFAULT_ROLE_NAMES: tuple[str, ...] = ("Цифровой акт", "Чат-ассистент", "SQL-агент")


async def get_user_roles(username: str = Depends(get_username)) -> list[dict]:
    """
    Возвращает список ролей текущего пользователя.

    Двухуровневый кеш: L1 — in-process TTLCache 5с, L2 — Redis 300с.
    Промах обоих — SQL, результат заполняет оба уровня. Рантайм-сбой Redis —
    L2 молча пропускается, путь как до введения кеша. Если у пользователя нет
    ролей, автоматически назначает дефолтные роли (см. DEFAULT_ROLE_NAMES).
    """
    logger.debug("get_user_roles: username=%s", username)
    if username in _roles_cache:
        return _roles_cache[username]

    redis = get_redis()
    cached = None
    # Ключ фиксируется ДО похода в БД — см. read_user_cache_epoch.
    cache_key: str | None = None
    try:
        epoch = await read_user_cache_epoch(redis, username)
        cache_key = f"{_ROLES_CACHE_KEY_PREFIX}{username}:v{epoch}"
        cached = await redis.get_json(cache_key)
    except Exception as e:
        logger.warning("Redis недоступен при чтении кеша ролей: %s", e)
    if cached is not None:
        _roles_cache[username] = cached
        return cached

    adapter = get_adapter()
    roles_table = adapter.get_table_name("roles")
    user_roles_table = adapter.get_table_name("user_roles")

    async with get_db() as conn:
        rows = await conn.fetch(
            f"""
            SELECT r.id, r.name, r.domain_name
            FROM {user_roles_table} ur
            JOIN {roles_table} r ON ur.role_id = r.id
            WHERE ur.username = $1
            """,
            username,
        )

        if not rows:
            rows = await _auto_assign_default_roles(conn, username, roles_table, user_roles_table)

    result = [dict(r) for r in rows]
    _roles_cache[username] = result
    if cache_key is not None:
        try:
            await redis.set_json(cache_key, result, ex=_ROLES_CACHE_TTL_SEC)
        except Exception as e:
            logger.warning("Redis недоступен при записи кеша ролей: %s", e)
    return result


async def _auto_assign_default_roles(conn, username, roles_table, user_roles_table):
    """
    Автоматически назначает дефолтные роли (DEFAULT_ROLE_NAMES) пользователю без ролей.
    """
    role_rows = await conn.fetch(
        f"SELECT id, name FROM {roles_table} WHERE name = ANY($1::text[])",
        list(DEFAULT_ROLE_NAMES),
    )
    found_names = {r["name"] for r in role_rows}
    missing = [n for n in DEFAULT_ROLE_NAMES if n not in found_names]
    for name in missing:
        logger.warning(f"Роль '{name}' не найдена для auto-assign")

    if not role_rows:
        return []

    from app.db.connection import get_adapter as _get_adapter
    adapter = _get_adapter()

    for role_row in role_rows:
        role_id = role_row["id"]
        if adapter.supports_on_conflict():
            await conn.execute(
                f"""
                INSERT INTO {user_roles_table} (username, role_id, assigned_by)
                VALUES ($1, $2, 'auto')
                ON CONFLICT (username, role_id) DO NOTHING
                """,
                username, role_id,
            )
        else:
            # GreenPlum: UNIQUE отсутствует — INSERT ... WHERE NOT EXISTS вместо
            # INSERT + except (который на GP никогда не срабатывал бы). Одним
            # statement'ом сужает окно гонки на дубль (без UNIQUE не закрывает
            # полностью), но раздельные SELECT+INSERT были бы ещё шире.
            await conn.execute(
                f"""
                INSERT INTO {user_roles_table} (username, role_id, assigned_by)
                SELECT $1::varchar, $2::bigint, 'auto'
                WHERE NOT EXISTS (
                    SELECT 1 FROM {user_roles_table}
                    WHERE username = $1 AND role_id = $2
                )
                """,
                username, role_id,
            )

    assigned_names = ", ".join(sorted(found_names))
    logger.info(f"Auto-assign: роли [{assigned_names}] назначены пользователю {username}")

    return await conn.fetch(
        f"""
        SELECT r.id, r.name, r.domain_name
        FROM {user_roles_table} ur
        JOIN {roles_table} r ON ur.role_id = r.id
        WHERE ur.username = $1
        """,
        username,
    )


def require_domain_access(domain_name: str) -> Callable:
    """
    Фабрика зависимости: проверяет доступ пользователя к домену.

    Админ имеет доступ ко всем доменам. При отказе доступа факт записывается
    в ``access_denied_audit`` через батчер (без блокировки запроса). Если
    батчер не поднят (например, в тестах) — отказ логируется в warning.
    """
    async def _check(
        request: Request,
        username: str = Depends(get_username),
        roles: list[dict] = Depends(get_user_roles),
    ):
        if any(r["name"] == "Админ" for r in roles):
            return
        if not any(r["domain_name"] == domain_name for r in roles):
            await _log_access_denied(
                request=request,
                username=username,
                domain=domain_name,
                roles=roles,
            )
            raise HTTPException(status_code=403, detail="Нет доступа к разделу")
    return _check


async def _log_access_denied(
    *,
    request: Request,
    username: str,
    domain: str,
    roles: list[dict],
) -> None:
    """Кладёт запись об отказе доступа в аудит admin-домена через реестр фабрик.

    Связь с admin — через ``domain_registry.get_factory`` без прямого импорта:
    admin-домен инкапсулирует батчер и тип записи (``AccessDeniedRecord``).
    Если запись не удалось положить — фабрика не зарегистрирована (admin-домен
    не поднят, например в изолированных тестах) либо батчер ещё не поднят
    (recorder вернул ``False``) — отказ логируется в warning. Цель — не
    помешать 403-ответу.
    """
    from app.core.domain_registry import get_factory, has_factory

    role_names = sorted({r.get("name", "") for r in roles if r.get("name")})
    reason = (
        f"roles=[{', '.join(role_names) or '<none>'}], "
        f"missing domain_name='{domain}'"
    )

    recorded = False
    if has_factory("admin.access_denied_audit"):
        record_denied = get_factory("admin.access_denied_audit")()
        recorded = await record_denied(
            username=username,
            domain=domain,
            path=str(request.url.path),
            method=request.method,
            reason=reason,
        )

    if not recorded:
        logger.warning(
            "Отказ доступа username=%s domain=%s path=%s method=%s reason=%s "
            "(аудит не записан — батчер не поднят)",
            username, domain, request.url.path, request.method, reason,
        )


def require_admin() -> Callable:
    """Фабрика зависимости: только администраторы."""
    async def _check(roles: list[dict] = Depends(get_user_roles)):
        if not any(r["name"] == "Админ" for r in roles):
            raise HTTPException(status_code=403, detail="Только для администраторов")
    return _check


async def invalidate_user_roles_cache(username: str) -> None:
    """Явная инвалидация кеша ролей и user-контекста при назначении/снятии роли.

    Чистит L1 (in-process) и поднимает общую эпоху пользовательских кэшей —
    одним INCR обесцениваются оба ключа сразу, и роли (см. get_user_roles), и
    user-контекст (``AuthUserRepository.get_user_context``): у обоих кешей один
    и тот же идентификатор, username == sub из JWT == user_id справочника
    (см. докстринг ``AuthUserRepository.find_by_id``).

    INCR вместо DEL — защита от гонки: запрос, начавший читать БД до
    инвалидации, допишет результат уже после неё, и с DEL устаревшие права
    жили бы весь TTL (300с). Подробнее — ``read_user_cache_epoch``.

    ВАЖНО: инвалидация L1 работает только в пределах текущего процесса.
    В multi-process / multi-instance деплое (в первую очередь JupyterHub,
    где каждый пользователь запускает собственный процесс приложения)
    очистка кеша в одном процессе НЕ затронет кеш в других процессах.
    Для таких случаев единственной защитой остаётся короткий TTL (5 сек)
    — это сознательный компромисс между свежестью прав и нагрузкой на БД.
    Тот же TTL ограничивает и гонку внутри процесса: L1 версиями не защищён,
    но переживает её максимум 5 секунд. Эпоха разделяется между процессами,
    поэтому L2 закрыт полностью — но сбой Redis здесь не должен ронять
    admin-операцию (assign/remove роли), поэтому только предупреждение в лог;
    самоисцеление — TTL L2 (300с).
    """
    _roles_cache.pop(username, None)

    try:
        await get_redis().incr(f"{USER_CACHE_EPOCH_KEY_PREFIX}{username}")
    except Exception as e:
        logger.warning("Redis недоступен при инвалидации кеша ролей: %s", e)
