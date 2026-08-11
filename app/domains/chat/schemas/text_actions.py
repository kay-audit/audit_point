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


class CorrectResponse(BaseModel):
    """Ответ корректора — обработанный текст."""

    corrected_text: str


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

    ``measures`` («Принятые меры») раскладывается в поле карточки под «Причинами».
    ``recommendations`` — дисплей-онли подсказки аналитику «чего не хватает в
    описании»: показываются в панели-формализаторе, но в карточку и экспорт НЕ
    пишутся (фронт их не применяет); это plain-текст, не HTML.
    """

    violated: str = ""
    established: str = ""
    reasons: str = ""
    measures: str = ""
    responsible: str = ""
    consequences: str = ""
    recommendations: list[str] = Field(default_factory=list)
