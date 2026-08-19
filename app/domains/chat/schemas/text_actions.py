"""Request/response DTO эндпоинтов text-actions."""

from typing import Literal

from pydantic import BaseModel, Field


class CorrectRequest(BaseModel):
    """Запрос на обработку выделенного текста.

    ``mode``: ``fix`` — орфография/пунктуация, ``readability`` — улучшение
    читаемости/структуры.
    """

    text: str = Field(..., min_length=1)
    mode: Literal["fix", "readability"] = "fix"


class ReadabilityMetrics(BaseModel):
    """Снимок диагностики читаемости (анализатор D17, папка 1).

    ``noun_verb_ratio`` — ``None``, когда в тексте нет глаголов: анализатор
    отдаёт в этом случае ``float('inf')``, а такого значения в JSON нет.
    """

    average_penalty: float
    level: str
    recommendation: str
    sentence_count: int
    total_words: int
    noun_verb_ratio: float | None = None
    longest_genitive_chain: list[str] = Field(default_factory=list)
    avg_word_count: float
    avg_comma_count: float
    bureaucratic_markers_total: int
    amplifier_total: int
    intro_total: int
    passive_count: int
    reasons: list[str] = Field(default_factory=list)


class ReadabilityReport(BaseModel):
    """Диагностика до и после правки — как в ``process()`` наработки D17."""

    before: ReadabilityMetrics
    after: ReadabilityMetrics


class CorrectResponse(BaseModel):
    """Ответ корректора — обработанный текст и (для ``readability``) диагностика.

    ``readability`` заполняется ТОЛЬКО в режиме ``readability``: анализатор меряет
    канцелярит, к правке букв в режиме ``fix`` он отношения не имеет. ``None``
    также при сбое анализатора — исправленный текст пользователю важнее метрик.
    """

    corrected_text: str
    readability: ReadabilityReport | None = None


class FormalizeRequest(BaseModel):
    """Запрос на формализацию: свободный текст нарушения."""

    text: str = Field(..., min_length=1)


class FormalizeResponse(BaseModel):
    """Поля карточки нарушения, извлечённые из текста (пустые — что LLM не нашла).

    КОНТРАКТ: значения всех шести полей — **готовый HTML**, безопасный для вставки
    в rich-поле карточки. Текст модели экранирован (`html.escape`), переводы строк
    переведены в `<br>`, перечисления пришли списком `<ul><li>…</li></ul>`. Фронту
    не нужно ни угадывать «это уже разметка или ещё текст», ни экранировать
    повторно — только санитизировать профилем 'acts' перед вставкой.

    ``description`` («Описание») — ЕДИНСТВЕННОЕ поле, куда приходит HTML-список:
    метрики нарушения побулитно расшифровывают сказанное в «Установлено».
    Остальные поля — связные строки: списки в карточке применяются только здесь.

    ``measures`` («Принятые меры») раскладывается в поле карточки под «Причинами».
    ``recommendations`` — дисплей-онли подсказки аналитику «чего не хватает в
    описании»: показываются в панели-формализаторе, но в карточку и экспорт НЕ
    пишутся (фронт их не применяет); это plain-текст, не HTML.
    """

    violated: str = ""
    established: str = ""
    description: str = ""
    reasons: str = ""
    measures: str = ""
    responsible: str = ""
    consequences: str = ""
    recommendations: list[str] = Field(default_factory=list)
