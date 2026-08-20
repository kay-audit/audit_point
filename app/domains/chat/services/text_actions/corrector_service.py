"""Фича «Корректор»: обработка выделенного текста LLM в двух режимах (one-shot).

``fix`` — орфография/пунктуация (дословный промпт D17 ``AUDITOR_SYSTEM_PROMPT``),
``readability`` — улучшайзер «Пиши, сокращай» (дословный промпт D17
``READABILITY_SYSTEM_PROMPT``). Перенос наработок D17 на нативную LLM-инфру домена чата:
``retry_on_transient`` вместо vLLM/LangChain; логика вызова — одно синхронное
обращение к модели, промпт/температура выбираются по режиму.

Цель вызова (клиент + модель) выбирается по плану доступных маршрутов —
``llm_route.resolve_target``, как и в чате. Прибитый к primary-профилю клиент
означал бы, что корректор молчит там, где чат работает через fallback.
"""

import logging
from typing import Literal

from starlette.concurrency import run_in_threadpool

from app.domains.chat.exceptions import (
    TextActionUnavailableError,
    TextActionValidationError,
)
from app.domains.chat.schemas.text_actions import (
    CorrectResponse,
    ReadabilityMetrics,
    ReadabilityReport,
)
from app.domains.chat.services.retry import retry_on_transient
from app.domains.chat.services.text_actions.llm_route import resolve_target
from app.domains.chat.services.text_actions.llm_utils import run_text_call
from app.domains.chat.services.text_actions.prompts import (
    AUDITOR_SYSTEM_PROMPT,
    READABILITY_SYSTEM_PROMPT,
)
from app.domains.chat.services.text_actions.readability_analyzer import analyze_for_api
from app.domains.chat.settings import ChatDomainSettings

# Явное имя логгера: handler'ы висят на «audit_workstation» с propagate=False,
# и предупреждения из-под __name__ («app.domains.chat…») уходили бы в никуда.
logger = logging.getLogger("audit_workstation.chat.text_actions.corrector")

CorrectMode = Literal["fix", "readability"]


class TextCorrectorService:
    """Прогоняет выделенный текст через LLM в выбранном режиме (``fix``/``readability``)."""

    def __init__(self, settings: ChatDomainSettings) -> None:
        self._settings = settings
        ta = settings.text_actions
        # None → модель того маршрута, который выберет resolve_target.
        self._preferred_model = ta.corrector_model
        self._timeout = ta.per_call_timeout_sec
        self._max_chars = ta.max_input_chars
        # Промпт и температура — по режиму.
        self._prompts = {
            "fix": AUDITOR_SYSTEM_PROMPT,
            "readability": READABILITY_SYSTEM_PROMPT,
        }
        self._temperatures = {
            "fix": ta.corrector_temperature,
            "readability": ta.readability_temperature,
        }
        r = settings.retry
        self._retry_call = retry_on_transient(
            on_429=r.on_429,
            on_5xx=r.on_5xx,
            max_attempts=r.max_attempts,
            connect_max_attempts=r.connect_max_attempts,
            backoff_base=r.backoff_base_sec,
        )

    async def correct(self, text: str, mode: CorrectMode = "fix") -> CorrectResponse:
        """Вернуть обработанный текст и — для режима ``readability`` — диагностику
        читаемости до и после правки. Кидает ``TextActionValidationError`` на
        неизвестный режим, пустой/слишком длинный ввод и
        ``TextActionUnavailableError``, когда не осталось ни одного доступного
        LLM-маршрута."""
        if mode not in self._prompts:
            raise TextActionValidationError(f"Неизвестный режим корректора: {mode}")
        if not text or not text.strip():
            raise TextActionValidationError("Пустой текст для корректуры")
        if len(text) > self._max_chars:
            raise TextActionValidationError(
                f"Текст длиннее {self._max_chars} символов — сократите выделение",
            )
        target = await resolve_target(
            self._settings, preferred_model=self._preferred_model,
        )
        if target is None:
            raise TextActionUnavailableError(
                "ИИ-сервис недоступен, повторите попытку позже",
            )
        client, model = target
        corrected = await run_text_call(
            client,
            model=model,
            temperature=self._temperatures[mode],
            system=self._prompts[mode],
            user=text,
            retry_call=self._retry_call,
            timeout=self._timeout,
        )
        return CorrectResponse(
            corrected_text=corrected,
            readability=await self._readability(mode, text, corrected),
        )

    async def _readability(
        self, mode: CorrectMode, before: str, after: str,
    ) -> ReadabilityReport | None:
        """Диагностика «до/после» для режима ``readability``.

        Порядок повторяет ``process()`` наработки D17: анализ ДО → генерация →
        анализ ПОСЛЕ. Анализатор синхронный и CPU-bound (до ~1.2 с на предельном
        тексте), поэтому оба замера уходят в пул потоков — иначе встанет event
        loop. Сбой диагностики корректуру не роняет: возвращаем ``None`` и пишем
        warning, потому что исправленный текст пользователю важнее метрик.
        """
        if mode != "readability":
            return None
        try:
            before_payload = await run_in_threadpool(analyze_for_api, before)
            after_payload = await run_in_threadpool(analyze_for_api, after)
        except Exception as e:  # noqa: BLE001 — диагностика необязательна
            logger.warning("Диагностика читаемости не выполнена: %s", e)
            return None
        if not before_payload or not after_payload:
            return None
        return ReadabilityReport(
            before=ReadabilityMetrics(**before_payload),
            after=ReadabilityMetrics(**after_payload),
        )
