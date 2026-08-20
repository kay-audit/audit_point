"""Фича «Формализация нарушения»: раскладка свободного текста по полям карточки.

Конвейер D17 целиком, в две стадии. Первая: 4 экстрактора (``formalizer_prompts``)
читают один и тот же текст параллельно (``asyncio.gather``). Вторая, тоже
параллельно: сборщик отчёта (``VIOLATION_SYSTEM``) переписывает извлечённое в
официально-деловой текст, а промпт рекомендаций считает, чего в описании не
хватает. Раунда ожидания вторая стадия не добавляет — оба вызова идут разом.
Структуру JSON получаем провайдер-агностично (промпт → JSON → разбор), БЕЗ
``response_format``.

Раскладка по полям карточки: «Нарушено» и «Описание» берутся прямо у экстрактора
сути (норматив и метрики), остальные пять — у сборщика. Списки применяются ТОЛЬКО
в «Описании»: метрики побулитно расшифровывают сказанное в «Установлено»; прочие
поля — связный текст, а пришедшие списком лица склеиваются через «; ».

Рекомендации — дисплей-онли подсказки аналитику: едут в ответе, но в карточку и
экспорт НЕ пишутся (фронт их не применяет).

Отказ отдельного экстрактора/рекомендаций не роняет формализацию: поле просто
останется пустым, а список рекомендаций — пустым («что LLM выделила — заполняем,
что не смогла — пусто»). Отказ сборщика тоже не роняет: поля собираются напрямую
из экстракторов, в той же строковой форме — оформление карточки не должно зависеть
от того, повезло ли одному вызову. Но отказ ВСЕХ экстракторов — это не пустой
результат, а недоступный LLM: такой случай отдаётся
``TextActionUnavailableError`` (503), иначе лежащий провайдер неотличим от
«модель ничего не нашла».

Цель вызова (клиент + модель) выбирается по плану доступных маршрутов —
``llm_route.resolve_target``, как и в чате: иначе формализатор отказывал бы там,
где чат работает через fallback-маршрут.
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
from app.domains.chat.services.retry import retry_on_transient
from app.domains.chat.services.text_actions.llm_route import resolve_target
from app.domains.chat.services.text_actions.formalizer_prompts import (
    CAUSES_SYSTEM,
    CAUSES_USER,
    CONSEQUENCES_SYSTEM,
    CONSEQUENCES_USER,
    ESSENCE_SYSTEM,
    ESSENCE_USER,
    MEASURES_SYSTEM,
    MEASURES_USER,
    RECOMMENDATIONS_SYSTEM,
    RECOMMENDATIONS_USER,
    VIOLATION_SYSTEM,
    VIOLATION_USER,
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


class ViolationParsed(BaseModel):
    """Разобранный вывод сборщика D17 (зеркало ViolationParser из их schema.py)."""

    violations: str = ""
    causes: str = ""
    consequences: str = ""
    measures: str = ""
    persons: list[str] = Field(default_factory=list)


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


def _join_to_html(items: list[str]) -> str:
    """Список D17 → строка поля карточки (склейка через «; »).

    Списки в карточке применяются только в «Описании» — остальные поля связный
    текст, поэтому массив от модели склеивается детерминированно. Это НЕ то же
    самое, что чинить пустоту постобработкой: склейка от формулировок модели не
    зависит, а «пусто или не пусто» зависит — и потому чинится в промпте."""
    cleaned = [s.strip() for s in items if s and s.strip()]
    return _text_to_html("; ".join(cleaned)) if cleaned else ""


class ViolationFormalizerService:
    """Раскладывает свободный текст нарушения по полям карточки (4 экстрактора D17)."""

    def __init__(self, settings: ChatDomainSettings) -> None:
        self._settings = settings
        ta = settings.text_actions
        # None → модель того маршрута, который выберет resolve_target.
        self._preferred_model = ta.formalizer_model
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
        на пустой/слишком длинный ввод и ``TextActionUnavailableError`` в двух
        случаях: не осталось доступных LLM-маршрутов (тогда не уходит ни одного
        запроса) либо сорвались ВСЕ экстракторы. Сбой ЧАСТИ экстракторов
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
        target = await resolve_target(
            self._settings, preferred_model=self._preferred_model,
        )
        if target is None:
            raise TextActionUnavailableError(_UNAVAILABLE_MESSAGE)
        client, model = target
        extractors = (
            (EssenceParsed, ESSENCE_SYSTEM, ESSENCE_USER),
            (CausesParsed, CAUSES_SYSTEM, CAUSES_USER),
            (ConsequencesParsed, CONSEQUENCES_SYSTEM, CONSEQUENCES_USER),
            (MeasuresParsed, MEASURES_SYSTEM, MEASURES_USER),
        )
        # return_exceptions=True: сбой одного экстрактора не отменяет остальные —
        # разбираем результаты ниже, чтобы отличить пустой разбор от отказа вызова.
        results = await asyncio.gather(
            *(
                self._extract(client, model, schema_cls, system, user, text)
                for schema_cls, system, user in extractors
            ),
            return_exceptions=True,
        )
        parsed = []
        failed = 0
        for (schema_cls, _, _u), result in zip(extractors, results):
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
        # 2-я стадия целиком параллельна: сборщик и рекомендации независимы,
        # поэтому раунда ожидания против прежнего конвейера не добавляется.
        violation, recommendations = await asyncio.gather(
            self._build_violation(
                client, model, essence, causes, consequences, measures,
            ),
            self._recommend(
                client, model, essence, causes, consequences, measures,
            ),
        )
        return self._response(
            essence, causes, consequences, measures, violation, recommendations,
        )

    def _response(
        self,
        essence: EssenceParsed,
        causes: CausesParsed,
        consequences: ConsequencesParsed,
        measures: MeasuresParsed,
        violation: "ViolationParsed | None",
        recommendations: list[str],
    ) -> FormalizeResponse:
        """Раскладка результата по полям карточки.

        «Нарушено» и «Описание» всегда из экстрактора сути: норматив сборщик по
        нашему контракту в текст не вписывает, а метрики — единственный список,
        который карточка показывает побулитно. Остальные пять полей берутся у
        сборщика, а при его сбое — напрямую у экстракторов, в той же строковой
        форме, чтобы оформление не зависело от везения одного вызова."""
        if violation is not None:
            established = _text_to_html(violation.violations)
            reasons = _text_to_html(violation.causes)
            consequences_html = _text_to_html(violation.consequences)
            measures_html = _text_to_html(violation.measures)
            responsible = _join_to_html(violation.persons)
        else:
            established = _text_to_html(essence.essence)
            reasons = _join_to_html(causes.causes)
            consequences_html = _text_to_html(consequences.consequences)
            measures_html = _join_to_html(measures.measures)
            responsible = _join_to_html(causes.persons)
        return FormalizeResponse(
            violated=_text_to_html(essence.norm_doc),
            established=established,
            description=_list_to_html(essence.metrics),
            reasons=reasons,
            measures=measures_html,
            responsible=responsible,
            consequences=consequences_html,
            recommendations=recommendations,
        )

    async def _extract(
        self, client, model: str, schema_cls, system: str, user: str, text: str,
    ):
        """Один экстрактор: JSON-вызов + валидация.

        Раскладка turn'ов — как у D17: входной текст подставляется в system
        (плейсхолдер ``{query}``), в user остаётся короткий приказ со статической
        формой JSON. Сбой вызова/разбора отдаётся исключением — решение «пустое
        поле или авария» принимает ``formalize``, которому видно, упал ли один
        экстрактор или все сразу."""
        raw = await run_json_call(
            client,
            model=model,
            temperature=self._temperature,
            system=system.format(query=text),
            user=user,
            retry_call=self._retry_call,
            timeout=self._timeout,
        )
        return schema_cls.model_validate(raw)

    async def _build_violation(
        self,
        client,
        model: str,
        essence: EssenceParsed,
        causes: CausesParsed,
        consequences: ConsequencesParsed,
        measures: MeasuresParsed,
    ) -> ViolationParsed | None:
        """2-я стадия: сборка полей карточки в официально-деловой текст (D17).

        Идёт параллельно рекомендациям, поэтому раунда ожидания не добавляет.
        Сбой не роняет формализацию — вернём ``None``, и ``_response`` соберёт
        поля напрямую из экстракторов."""
        system = VIOLATION_SYSTEM.format(
            essence=essence.essence,
            doc_ref=essence.norm_doc,
            metrics=essence.metrics,
            causes=causes.causes,
            persons=causes.persons,
            consequences=consequences.consequences,
            measures=measures.measures,
        )
        try:
            raw = await run_json_call(
                client,
                model=model,
                temperature=self._temperature,
                system=system,
                user=VIOLATION_USER,
                retry_call=self._retry_call,
                timeout=self._timeout,
            )
            return ViolationParsed.model_validate(raw)
        except Exception as e:  # noqa: BLE001 — есть фолбэк на сырые экстракторы
            logger.warning("Сборка отчёта не выполнена, фолбэк на экстракторы: %s", e)
            return None

    async def _recommend(
        self,
        client,
        model: str,
        essence: EssenceParsed,
        causes: CausesParsed,
        consequences: ConsequencesParsed,
        measures: MeasuresParsed,
    ) -> list[str]:
        """2-я стадия: подсказки аналитику «чего не хватает» по извлечённым полям.

        Дисплей-онли — в карточку/экспорт не идут (фронт их не применяет). Сбой не
        роняет формализацию: возвращаем пустой список. Отсекаем пустые и режем до
        ``_MAX_RECOMMENDATIONS``."""
        system = RECOMMENDATIONS_SYSTEM.format(
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
                model=model,
                temperature=self._temperature,
                system=system,
                user=RECOMMENDATIONS_USER,
                retry_call=self._retry_call,
                timeout=self._timeout,
            )
            parsed = RecommendationsParsed.model_validate(raw)
        except Exception as e:  # noqa: BLE001 — подсказки необязательны, не роняем поток
            logger.warning("Рекомендации не получены: %s", e)
            return []
        cleaned = [r.strip() for r in parsed.recommendations if r and r.strip()]
        return cleaned[:_MAX_RECOMMENDATIONS]
