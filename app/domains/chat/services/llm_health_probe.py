"""Фоновая перепроверка доступности primary-LLM при открытом circuit breaker.

Один asyncio-task на процесс. Пока circuit breaker открыт (primary лежит),
все пользовательские запросы мгновенно идут на fallback, а эта задача с
adaptive-backoff пингует primary дешёвым запросом (``client.models.list()``)
и закрывает breaker через ``probe_succeeded()``, как только primary отвечает.

Так перепроверка primary уходит из пути пользователя в фон: юзер не платит
ретраями за восстановление.

Adaptive backoff: при успешном восстановлении интервал сбрасывается в min;
при провальной пробе растёт × multiplier до max. В состоянии closed probe
ничего не пингует (нечего восстанавливать).

Клиент (httpx connection pool под капотом) строится лениво с КОРОТКИМ
таймаутом ``health_probe.timeout_sec`` и не держится в sleep.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Callable

from app.domains.chat.services.circuit_breaker import (
    STATE_CLOSED,
    STATE_HALF_OPEN,
    STATE_OPEN,
    get_breaker,
)
from app.domains.chat.settings import ChatDomainSettings

logger = logging.getLogger(
    "audit_workstation.domains.chat.services.llm_health_probe",
)


class LLMHealthProbe:
    """Process-level фоновый probe primary-LLM при открытом circuit breaker.

    Инжектируемые ``clock``/``sleep``/``client_factory`` упрощают тестирование
    без реального ожидания и без реального HTTP-клиента.
    """

    def __init__(
        self,
        settings: ChatDomainSettings,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Any] = asyncio.sleep,
        client_factory: Callable[[], Any] | None = None,
    ) -> None:
        """
        settings       — ChatDomainSettings (берёт .health_probe и breaker-параметры).
        clock          — провайдер монотонного времени (для тестов).
        sleep          — корутина-усыпитель (для тестов — AsyncMock без ожидания).
        client_factory — фабрика клиента; если None, лениво строит клиента по
                         маршруту профиля через build_llm_client с коротким
                         таймаутом (см. _get_client).
        """
        self._settings = settings
        self._clock = clock
        self._sleep = sleep
        self._client_factory = client_factory

        self._client: Any = None  # лениво строится в _get_client()
        self._stop = False
        self._task: asyncio.Task | None = None
        # Текущий интервал backoff'а — стартует с min.
        self._current_interval: float = settings.health_probe.poll_min_interval_sec
        # Результат последней пробы — для diagnostics (None, пока не пинговали).
        self._last_ping_ok: bool | None = None

    # ── Зависимости ─────────────────────────────────────────────────────────────

    def _get_breaker(self):
        """Возвращает синглтон breaker'а в режиме external_recovery.

        external_recovery=True: таймерного перехода open → half_open нет,
        circuit закрывает только этот фоновый probe через probe_succeeded().
        """
        return get_breaker(
            failure_threshold=self._settings.circuit_breaker_failure_threshold,
            recovery_timeout_sec=self._settings.circuit_breaker_recovery_timeout_sec,
            external_recovery=True,
        )

    def _get_client(self):
        """Лениво строит и кэширует клиента с коротким таймаутом.

        Probe нужен только для primary (в проде — redis-bridge,gigachat).
        Если задан client_factory — используем его (тесты). Иначе строим
        клиента через общую фабрику build_llm_client с probe-таймаутом.
        """
        if self._client is not None:
            return self._client
        if self._client_factory is not None:
            self._client = self._client_factory()
            return self._client
        # Клиент по маршруту primary через общую фабрику (redis-bridge
        # получает heartbeat-ping, HTTP-маршруты — обычный models.list).
        # Короткий probe-таймаут — копией настроек: другой timeout даёт
        # отдельный кэш-ключ, основной клиент не затрагивается.
        from app.domains.chat.services.llm_client import build_llm_client

        probe_settings = self._settings.model_copy(
            update={
                "request_timeout": max(
                    1, int(self._settings.health_probe.timeout_sec),
                ),
            },
        )
        self._client = build_llm_client(probe_settings)
        return self._client

    # ── Проба ───────────────────────────────────────────────────────────────────

    async def _ping(self) -> bool:
        """Пингует primary дешёвым запросом ``client.models.list()``.

        Любое исключение → False (probe не должен падать). Успех → True.
        """
        try:
            client = self._get_client()
            await client.models.list()
            return True
        except Exception:
            logger.debug("llm_health_probe: ping primary не удался", exc_info=True)
            return False

    # ── Тик ───────────────────────────────────────────────────────────────────

    async def _tick(self) -> None:
        """Один шаг перепроверки.

        В closed — ничего не пингуем (нечего восстанавливать), интервал = min.
        В open/half_open — пингуем primary: успех закрывает breaker и сбрасывает
        интервал, провал держит circuit open и растит интервал × multiplier.
        """
        hp = self._settings.health_probe
        breaker = self._get_breaker()

        if breaker.state == STATE_CLOSED:
            self._current_interval = hp.poll_min_interval_sec
            return

        if breaker.state in (STATE_OPEN, STATE_HALF_OPEN):
            ok = await self._ping()
            self._last_ping_ok = ok
            if ok:
                await breaker.probe_succeeded()
                self._current_interval = hp.poll_min_interval_sec
                logger.info(
                    "llm_health_probe: primary восстановлен — circuit закрыт",
                )
            else:
                await breaker.probe_failed()
                self._current_interval = min(
                    self._current_interval * hp.poll_backoff_multiplier,
                    hp.poll_max_interval_sec,
                )

    # ── Основной цикл ─────────────────────────────────────────────────────────

    async def _run(self) -> None:
        """Фоновый цикл. Не падает от одиночных ошибок, пробрасывает CancelledError."""
        while not self._stop:
            try:
                await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(
                    "llm_health_probe: ошибка в основном цикле — продолжаем",
                )
            await self._sleep(self._current_interval)

    # ── Diagnostics ─────────────────────────────────────────────────────────────

    def get_status(self) -> dict:
        """Снимок состояния probe для diagnostics-endpoint'а."""
        try:
            breaker_state = self._get_breaker().state
        except Exception:
            breaker_state = "unknown"
        return {
            "name": "chat.llm_health_probe",
            "running": self._task is not None and not self._task.done(),
            "breaker_state": breaker_state,
            "current_interval_sec": self._current_interval,
            "last_ping_ok": self._last_ping_ok,
        }

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def start(self) -> None:
        """Создаёт asyncio-задачу фонового цикла. Идемпотентно.

        Если health_probe выключен настройками — ранний return (задача не создаётся).
        """
        if not self._settings.health_probe.enabled:
            logger.info("llm_health_probe: отключён настройками — не запускаем")
            return
        if self._task is not None and not self._task.done():
            return
        self._stop = False
        self._task = asyncio.create_task(self._run(), name="chat-llm-health-probe")
        logger.info("llm_health_probe: запущен")

    async def stop(self) -> None:
        """Останавливает фоновый цикл, ждёт завершения и закрывает клиент."""
        self._stop = True
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None

        if self._client is not None:
            close = getattr(self._client, "aclose", None) or getattr(
                self._client, "close", None,
            )
            if close is not None:
                try:
                    await close()
                except Exception:
                    logger.exception(
                        "llm_health_probe: ошибка при закрытии клиента",
                    )
            self._client = None
        logger.info("llm_health_probe: остановлен")
