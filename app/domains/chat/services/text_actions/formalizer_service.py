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
что не смогла — пусто»). Но отказ ВСЕХ экстракторов — это не пустой результат, а
недоступный LLM: такой случай отдаётся ``TextActionUnavailableError`` (503), иначе
лежащий провайдер неотличим от «модель ничего не нашла».
"""

import asyncio
import html
import logging
import re

from pydantic import BaseModel, Field

from app.domains.chat.exceptions import (
    TextActionUnavailableError,
    TextActionValidationError,
)
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

# Явное имя логгера: handler'ы висят на «audit_workstation» с propagate=False,
# и предупреждения из-под __name__ («app.domains.chat…») уходили в никуда.
logger = logging.getLogger("audit_workstation.chat.text_actions.formalizer")

# Промпт D17 обещает не более 5 рекомендаций — режем на нашей стороне как страховку.
_MAX_RECOMMENDATIONS = 5

# Сообщение пользователю при отказе LLM-провайдера (все экстракторы упали).
_UNAVAILABLE_MESSAGE = "ИИ-сервис недоступен, повторите попытку позже"

_NEWLINE_RE = re.compile(r"\r\n|\r|\n")


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


def _text_to_html(value: str) -> str:
    """Скалярный текст D17 → готовый HTML поля: экранирование + `\\n` → `<br>`.

    Текст от LLM — НЕ разметка: `<`/`&` из него («отклонение <5%», «Иванов & Ко»)
    обязаны доехать до карточки видимым символом, а не съеденным тегом или битой
    сущностью. Перенос строки в rich-поле значим только как `<br>` — голый `\\n`
    не отрисуется ни в превью, ни в DOCX."""
    cleaned = (value or "").strip()
    if not cleaned:
        return ""
    return _NEWLINE_RE.sub("<br>", html.escape(cleaned))


def _established_from(essence: EssenceParsed) -> str:
    """«Установлено» = суть (текст) + метрики (HTML-список, если есть).

    Склейка БЕЗ разделителя: `<ul>` — блочный элемент, он и так начинается с
    новой строки, а голый `\\n` между ними переносом не стал бы."""
    return _text_to_html(essence.essence) + _list_to_html(essence.metrics)


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
        на пустой/слишком длинный ввод и ``TextActionUnavailableError``, когда
        сорвались ВСЕ экстракторы (отказ LLM-провайдера). Сбой ЧАСТИ экстракторов
        толерантен: их поля останутся пустыми, остальные заполнятся.

        После 4 экстракторов — 2-й этап: рекомендации «чего не хватает» по уже
        извлечённым полям (дисплей-онли, в карточку/экспорт не пишутся). Его
        сбой ответ не роняет — рекомендации просто придут пустыми.

        Все значения ответа — готовый HTML (см. ``FormalizeResponse``)."""
        if not text or not text.strip():
            raise TextActionValidationError("Пустой текст для формализации")
        if len(text) > self._max_chars:
            raise TextActionValidationError(
                f"Текст длиннее {self._max_chars} символов — сократите выделение",
            )
        client = build_llm_client(self._settings)
        extractors = (
            (EssenceParsed, ESSENCE_SYSTEM),
            (CausesParsed, CAUSES_SYSTEM),
            (ConsequencesParsed, CONSEQUENCES_SYSTEM),
            (MeasuresParsed, MEASURES_SYSTEM),
        )
        # return_exceptions=True: сбой одного экстрактора не отменяет остальные —
        # разбираем результаты ниже, чтобы отличить пустой разбор от отказа вызова.
        results = await asyncio.gather(
            *(
                self._extract(client, schema_cls, system, text)
                for schema_cls, system in extractors
            ),
            return_exceptions=True,
        )
        parsed = []
        failed = 0
        for (schema_cls, _), result in zip(extractors, results):
            if isinstance(result, BaseException):
                failed += 1
                logger.warning(
                    "Экстрактор %s не дал результата: %s", schema_cls.__name__, result,
                )
                parsed.append(schema_cls())
            else:
                parsed.append(result)
        if failed == len(extractors):
            # Ни один вызов не дошёл до модели — это отказ провайдера, а не
            # «в тексте нечего извлекать»: пустой ответ с HTTP 200 скрыл бы аварию.
            logger.error(
                "Формализация не выполнена: сорвались все %s экстракторов", failed,
            )
            raise TextActionUnavailableError(_UNAVAILABLE_MESSAGE)
        essence, causes, consequences, measures = parsed
        recommendations = await self._recommend(
            client, essence, causes, consequences, measures,
        )
        return FormalizeResponse(
            violated=_text_to_html(essence.norm_doc),
            established=_established_from(essence),
            reasons=_list_to_html(causes.causes),
            responsible=_list_to_html(causes.persons),
            consequences=_text_to_html(consequences.consequences),
            measures=_list_to_html(measures.measures),
            recommendations=recommendations,
        )

    async def _extract(self, client, schema_cls, system: str, text: str):
        """Один экстрактор: JSON-вызов + валидация. Сбой вызова/разбора отдаётся
        исключением — решение «пустое поле или авария» принимает ``formalize``,
        которому видно, упал ли один экстрактор или все сразу."""
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
