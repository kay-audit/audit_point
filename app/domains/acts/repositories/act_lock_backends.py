"""Бэкенд блокировок актов: ключ Redis с TTL.

Источник истины о блокировке — не колонки таблицы актов, а ключ
``lock:act:{act_id}`` со сроком жизни ``duration_minutes``. Ключ исчезает
сам, поэтому существование ключа И ЕСТЬ признак живой блокировки: сравнений
дат при чтении не осталось, отдельный сборщик просроченных локов не нужен.

Все мутации идут Lua-скриптами: «прочитать владельца и решить» обязано быть
одной операцией, иначе между чтением и записью успевает влезть конкурент.

``locked_at``/``lock_expires_at`` считают часы приложения и кладут в значение
ключа (фронту нужна ISO-строка), а фактическое истечение определяет TTL Redis.
Небольшой дрейф двух часов допустим: до переезда время тоже было чужим —
серверным временем БД.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta

from app.core.redis import RedisAdapter

logger = logging.getLogger("audit_workstation.db.repository.lock")

# Ключ блокировки одного акта. Префикс общий для всех ключей приложения в Redis.
KEY_PREFIX = "lock:act:"


def _key(act_id: int) -> str:
    return f"{KEY_PREFIX}{act_id}"


def _make_payload(username: str, duration_minutes: float) -> tuple[dict, dict, int]:
    """Готовит значение ключа, ответ вызывающему и TTL в миллисекундах.

    Возвращает тройку ``(payload, info, ttl_ms)``: ``payload`` едет в хранилище
    (даты — ISO-строки), ``info`` уходит наверх в форме прежнего SQL-ответа
    (даты — ``datetime``).
    """
    now = datetime.now()
    until = now + timedelta(minutes=duration_minutes)
    payload = {
        "locked_by": username,
        "locked_at": now.isoformat(),
        "locked_until": until.isoformat(),
    }
    info = {"locked_by": username, "locked_at": now, "lock_expires_at": until}
    return payload, info, int(duration_minutes * 60_000)


def _payload_to_info(payload: dict) -> dict:
    """Разворачивает значение ключа в прежнюю форму ответа репозитория.

    ``lock_expired`` всегда ``False``: до истёкшей блокировки чтение не
    доходит — ключа с ней уже нет. Поле сохранено, потому что на него
    смотрит ``AccessGuard.require_lock_owner`` (проверка H9).
    """
    return {
        "locked_by": payload["locked_by"],
        "locked_at": datetime.fromisoformat(payload["locked_at"]),
        "lock_expires_at": datetime.fromisoformat(payload["locked_until"]),
        "lock_expired": False,
    }


# Захват свободного ключа ИЛИ продление своего: чужой лок не трогаем.
# ARGV: 1 — username, 2 — значение ключа (JSON), 3 — TTL в мс.
_LUA_ACQUIRE = """
local raw = redis.call('GET', KEYS[1])
if raw ~= false and cjson.decode(raw)['locked_by'] ~= ARGV[1] then
  return nil
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', tonumber(ARGV[3]))
return ARGV[2]
"""

# Продление своей блокировки + диагностика отказа одним заходом (без TOCTOU:
# «кто держит, если не я» читается в той же атомарной операции).
# Ответ: {0} — блокировки нет, {0, raw} — чужая, {1, новое значение} — продлена.
_LUA_EXTEND = """
local raw = redis.call('GET', KEYS[1])
if raw == false then
  return {0}
end
if cjson.decode(raw)['locked_by'] ~= ARGV[1] then
  return {0, raw}
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', tonumber(ARGV[3]))
return {1, ARGV[2]}
"""

# Снятие строго своей блокировки: DEL без проверки владельца сорвал бы чужую
# работу, если ключ успел смениться между чтением и удалением.
_LUA_RELEASE = """
local raw = redis.call('GET', KEYS[1])
if raw == false or cjson.decode(raw)['locked_by'] ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[1])
return 1
"""


class RedisLockBackend:
    """Блокировки в Redis: значение — JSON, срок жизни — нативный TTL ключа."""

    def __init__(self, redis: RedisAdapter):
        self._redis = redis

    async def acquire(
        self, act_id: int, username: str, duration_minutes: float,
    ) -> dict | None:
        """Захватывает блокировку или продлевает свою; ``None`` — держит другой."""
        payload, info, ttl_ms = _make_payload(username, duration_minutes)
        written = await self._redis.eval(
            _LUA_ACQUIRE,
            [_key(act_id)],
            [username, json.dumps(payload, ensure_ascii=False), ttl_ms],
        )
        return info if written else None

    async def extend(
        self, act_id: int, username: str, duration_minutes: float,
    ) -> dict:
        """Продлевает свою блокировку: ``{extended, locked_by, lock_expires_at}``."""
        payload, info, ttl_ms = _make_payload(username, duration_minutes)
        extended, *rest = await self._redis.eval(
            _LUA_EXTEND,
            [_key(act_id)],
            [username, json.dumps(payload, ensure_ascii=False), ttl_ms],
        )
        if extended:
            return {
                "extended": True,
                "locked_by": username,
                "lock_expires_at": info["lock_expires_at"],
            }
        if not rest:
            return {"extended": False, "locked_by": None, "lock_expires_at": None}
        current = _payload_to_info(json.loads(rest[0]))
        return {
            "extended": False,
            "locked_by": current["locked_by"],
            "lock_expires_at": current["lock_expires_at"],
        }

    async def release(self, act_id: int, username: str) -> bool:
        """Снимает свою блокировку; чужую снять нельзя."""
        deleted = await self._redis.eval(
            _LUA_RELEASE, [_key(act_id)], [username],
        )
        return bool(deleted)

    async def info(self, act_id: int) -> dict | None:
        """Состояние живой блокировки или ``None``, если её нет."""
        raw = await self._redis.get(_key(act_id))
        if raw is None:
            return None
        return _payload_to_info(json.loads(raw))

    async def bulk_info(self, act_ids: list[int]) -> dict[int, dict]:
        """Состояния живых блокировок пачкой; незаблокированных актов в ответе нет."""
        if not act_ids:
            return {}
        values = await self._redis.mget([_key(act_id) for act_id in act_ids])
        return {
            act_id: _payload_to_info(json.loads(raw))
            for act_id, raw in zip(act_ids, values)
            if raw is not None
        }
