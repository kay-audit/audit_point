"""Фича «Формализация нарушения»: раскладка свободного текста по полям карточки.

4 экстрактора D17 (``formalizer_prompts``) читают один и тот же текст параллельно
(``asyncio.gather``); результаты складываются в поля нарушения проекта
(established/violated/reasons/measures/responsible/consequences — «Принятые меры»
раскладываются в поле карточки под «Причинами»). Структуру JSON получаем
провайдер-агностично (промпт → JSON → разбор), БЕЗ ``response_format``.

После экстракторов — 2-й этап: рекомендации «чего не хватает» (промпт D17 берёт на
вход уже извлечённые поля). Это дисплей-онли подсказки аналитику — едут в ответе,
но в карточку/экспорт НЕ пишутся (фронт их не применяет).

Отказ отдельного экстрактора/рекомендаций не роняет формализацию: поле просто
останется пустым, а список рекомендаций — пустым («что LLM выделила — заполняем,
что не смогла — пусто»).
"""

import asyncio
import html
import logging

from pydantic import BaseModel, Field

from app.domains.chat.exceptions import TextActionValidationError
from app.domains.chat.schemas.text_actions import FormalizeResponse
from app.domains.chat.services.llm_client import build_llm_client
from app.domains.chat.services.retry import retry_on_transient
from app.domains.chat.services.text_actions.formalizer_prompts import (
    CAUSES_SYSTEM,
    CONSEQUENCES_SYSTEM,
    ESSENCE_SYSTEM,
    MEASURES_SYSTEM,
    RECOMMENDATIONS_SYSTEM,
    RECOMMENDATIONS_USER_TEMPLATE,
)
from app.domains.chat.services.text_actions.llm_utils import run_json_call
from app.domains.chat.settings import ChatDomainSettings

logger = logging.getLogger(__name__)

# Промпт D17 обещает не более 5 рекомендаций — режем на нашей стороне как страховку.
_MAX_RECOMMENDATIONS = 5


# --- Разобранный вывод экстракторов D17 (зеркало schema.py; поля с дефолтами
#     ради устойчивости к частичному ответу модели: недостающий ключ → пусто) ---

class EssenceParsed(BaseModel):
    essence: str = ""
    norm_doc: str = ""
    metrics: list[str] = Field(default_factory=list)


class CausesParsed(BaseModel):
    causes: list[str] = Field(default_factory=list)
    persons: list[str] = Field(default_factory=list)


class ConsequencesParsed(BaseModel):
    consequences: str = ""


class MeasuresParsed(BaseModel):
    measures: list[str] = Field(default_factory=list)


class RecommendationsParsed(BaseModel):
    recommendations: list[str] = Field(default_factory=list)


def _list_to_html(items: list[str]) -> str:
    """Список D17 → честный HTML-список поля нарушения (`<ul><li>…</li></ul>`).

    Элементы экранируются (текст от LLM — не HTML). Пустой список (или все
    элементы пустые) → пустая строка — поле остаётся незаполненным."""
    cleaned = [s.strip() for s in items if s and s.strip()]
    if not cleaned:
        return ""
    items_html = "".join(f"<li>{html.escape(item)}</li>" for item in cleaned)
    return f"<ul>{items_html}</ul>"


def _established_from(essence: EssenceParsed) -> str:
    """«Установлено» = суть (абзац) + метрики (HTML-список, если есть)."""
    parts: list[str] = []
    if essence.essence.strip():
        parts.append(essence.essence.strip())
    metrics_html = _list_to_html(essence.metrics)
    if metrics_html:
        parts.append(metrics_html)
    return "\n".join(parts)


class ViolationFormalizerService:
    """Раскладывает свободный текст нарушения по полям карточки (4 экстрактора D17)."""

    def __init__(self, settings: ChatDomainSettings) -> None:
        self._settings = settings
        ta = settings.text_actions
        # None → основная модель профиля чата.
        self._model = ta.formalizer_model or settings.model
        self._temperature = ta.formalizer_temperature
        self._timeout = ta.per_call_timeout_sec
        self._max_chars = ta.max_input_chars
        r = settings.retry
        self._retry_call = retry_on_transient(
            on_429=r.on_429,
            on_5xx=r.on_5xx,
            max_attempts=r.max_attempts,
            connect_max_attempts=r.connect_max_attempts,
            backoff_base=r.backoff_base_sec,
        )

    async def formalize(self, text: str) -> FormalizeResponse:
        """Разложить текст по полям карточки. Кидает ``TextActionValidationError``
        на пустой/слишком длинный ввод. Сбой отдельного экстрактора → пустое поле.

        После 4 экстракторов — 2-й этап: рекомендации «чего не хватает» по уже
        извлечённым полям (дисплей-онли, в карточку/экспорт не пишутся)."""
        if not text or not text.strip():
            raise TextActionValidationError("Пустой текст для формализации")
        if len(text) > self._max_chars:
            raise TextActionValidationError(
                f"Текст длиннее {self._max_chars} символов — сократите выделение",
            )
        client = build_llm_client(self._settings)
        essence, causes, consequences, measures = await asyncio.gather(
            self._extract(client, EssenceParsed, ESSENCE_SYSTEM, text),
            self._extract(client, CausesParsed, CAUSES_SYSTEM, text),
            self._extract(client, ConsequencesParsed, CONSEQUENCES_SYSTEM, text),
            self._extract(client, MeasuresParsed, MEASURES_SYSTEM, text),
        )
        recommendations = await self._recommend(
            client, essence, causes, consequences, measures,
        )
        return FormalizeResponse(
            violated=essence.norm_doc.strip(),
            established=_established_from(essence),
            reasons=_list_to_html(causes.causes),
            responsible=_list_to_html(causes.persons),
            consequences=consequences.consequences.strip(),
            measures=_list_to_html(measures.measures),
            recommendations=recommendations,
        )

    async def _extract(self, client, schema_cls, system: str, text: str):
        """Один экстрактор: JSON-вызов + валидация. Любой сбой → пустой результат
        (частичная толерантность — поле карточки останется пустым)."""
        try:
            raw = await run_json_call(
                client,
                model=self._model,
                temperature=self._temperature,
                system=system,
                user=text,
                retry_call=self._retry_call,
                timeout=self._timeout,
            )
            return schema_cls.model_validate(raw)
        except Exception as e:  # noqa: BLE001 — сбой экстрактора не роняет формализацию
            logger.warning(
                "Экстрактор %s не дал результата: %s", schema_cls.__name__, e,
            )
            return schema_cls()

    async def _recommend(
        self,
        client,
        essence: EssenceParsed,
        causes: CausesParsed,
        consequences: ConsequencesParsed,
        measures: MeasuresParsed,
    ) -> list[str]:
        """2-й этап: подсказки аналитику «чего не хватает» по извлечённым полям.

        Дисплей-онли — в карточку/экспорт не идут (фронт их не применяет). Сбой не
        роняет формализацию: возвращаем пустой список. Отсекаем пустые и режем до
        ``_MAX_RECOMMENDATIONS``."""
        user = RECOMMENDATIONS_USER_TEMPLATE.format(
            essence=essence.essence,
            norm_doc=essence.norm_doc,
            metrics=essence.metrics,
            causes=causes.causes,
            persons=causes.persons,
            consequences=consequences.consequences,
            measures=measures.measures,
        )
        try:
            raw = await run_json_call(
                client,
                model=self._model,
                temperature=self._temperature,
                system=RECOMMENDATIONS_SYSTEM,
                user=user,
                retry_call=self._retry_call,
                timeout=self._timeout,
            )
            parsed = RecommendationsParsed.model_validate(raw)
        except Exception as e:  # noqa: BLE001 — подсказки необязательны, не роняем поток
            logger.warning("Рекомендации не получены: %s", e)
            return []
        cleaned = [r.strip() for r in parsed.recommendations if r and r.strip()]
        return cleaned[:_MAX_RECOMMENDATIONS]
