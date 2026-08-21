"""Тесты TextCorrectorService (Фича «Корректор»)."""

from unittest.mock import AsyncMock, patch

import pytest

from app.domains.chat.exceptions import (
    TextActionUnavailableError,
    TextActionValidationError,
)
from app.domains.chat.services.text_actions import budget as B
from app.domains.chat.services.text_actions.corrector_service import (
    TextCorrectorService,
)
from app.domains.chat.settings import ChatDomainSettings


def _settings():
    return ChatDomainSettings(api_base="http://x", api_key="x", model="m")


async def test_correct_calls_llm_with_corrector_prompt():
    fake = AsyncMock()
    msg = AsyncMock()
    msg.content = "исправлено"
    resp = AsyncMock()
    resp.choices = [AsyncMock(message=msg)]
    fake.chat.completions.create = AsyncMock(return_value=resp)

    with patch(
        "app.domains.chat.services.text_actions.corrector_service.resolve_target",
        AsyncMock(return_value=(fake, "m")),
    ):
        out = await TextCorrectorService(_settings()).correct("исходый тект")

    assert out.corrected_text == "исправлено"
    kwargs = fake.chat.completions.create.call_args.kwargs
    assert kwargs["temperature"] == 0.1  # корректорская температура
    assert "корректор" in kwargs["messages"][0]["content"]
    assert kwargs["messages"][1]["content"] == "исходый тект"


async def test_correct_readability_mode_uses_readability_prompt():
    fake = AsyncMock()
    msg = AsyncMock()
    msg.content = "улучшено"
    resp = AsyncMock()
    resp.choices = [AsyncMock(message=msg)]
    fake.chat.completions.create = AsyncMock(return_value=resp)

    with patch(
        "app.domains.chat.services.text_actions.corrector_service.resolve_target",
        AsyncMock(return_value=(fake, "m")),
    ):
        out = await TextCorrectorService(_settings()).correct("текст", mode="readability")

    assert out.corrected_text == "улучшено"
    kwargs = fake.chat.completions.create.call_args.kwargs
    assert kwargs["temperature"] == 0.1  # температура улучшайзера D17
    system = kwargs["messages"][0]["content"]
    assert "Пиши, сокращай" in system  # промпт улучшайзера, не корректорский
    assert "корректор банковских документов" not in system.lower()


async def test_correct_rejects_unknown_mode():
    with pytest.raises(TextActionValidationError):
        await TextCorrectorService(_settings()).correct("текст", mode="bogus")


async def test_correct_rejects_empty():
    with pytest.raises(TextActionValidationError):
        await TextCorrectorService(_settings()).correct("   ")


async def test_correct_rejects_too_long():
    s = _settings()
    s.text_actions.max_input_chars = 5
    with pytest.raises(TextActionValidationError):
        await TextCorrectorService(s).correct("слишком длинный текст")


async def test_correct_reports_unavailable_when_no_routes():
    """Нет доступных маршрутов → 503, а не пустой/успешный ответ."""
    with patch(
        "app.domains.chat.services.text_actions.corrector_service.resolve_target",
        AsyncMock(return_value=None),
    ):
        with pytest.raises(TextActionUnavailableError):
            await TextCorrectorService(_settings()).correct("текст")


async def test_correct_uses_model_from_resolved_route():
    """Модель берётся у выбранного маршрута, а не из настроек профиля.

    Маршрут может оказаться fallback'ом с другой моделью — вызов обязан уйти
    с моделью маршрута, иначе провайдер ответит 404 на чужое имя.
    """
    fake = AsyncMock()
    msg = AsyncMock()
    msg.content = "готово"
    resp = AsyncMock()
    resp.choices = [AsyncMock(message=msg)]
    fake.chat.completions.create = AsyncMock(return_value=resp)

    with patch(
        "app.domains.chat.services.text_actions.corrector_service.resolve_target",
        AsyncMock(return_value=(fake, "fallback-model")),
    ):
        await TextCorrectorService(_settings()).correct("текст")

    assert fake.chat.completions.create.call_args.kwargs["model"] == "fallback-model"


def _llm(content: str):
    """Мок LLM-клиента, отдающего заданный текст."""
    fake = AsyncMock()
    msg = AsyncMock()
    msg.content = content
    resp = AsyncMock()
    resp.choices = [AsyncMock(message=msg)]
    fake.chat.completions.create = AsyncMock(return_value=resp)
    return fake


_HEAVY = (
    "В ходе проведения проверки соблюдения порядка ведения бухгалтерского учёта "
    "организацией не было обеспечено представление подтверждающих документов "
    "(за 2 квартал 2024 года), в связи с чем следует отметить, что надлежащий "
    "контроль со стороны соответствующих подразделений весьма затруднён."
)


async def test_fix_mode_has_no_readability_report():
    """Анализатор меряет канцелярит — к правке букв он отношения не имеет."""
    with patch(
        "app.domains.chat.services.text_actions.corrector_service.resolve_target",
        AsyncMock(return_value=(_llm("исправлено"), "m")),
    ):
        out = await TextCorrectorService(_settings()).correct("текст", mode="fix")

    assert out.readability is None


async def test_readability_mode_reports_before_and_after():
    with patch(
        "app.domains.chat.services.text_actions.corrector_service.resolve_target",
        AsyncMock(return_value=(_llm("Организация не представила документы."), "m")),
    ):
        out = await TextCorrectorService(_settings()).correct(_HEAVY, mode="readability")

    assert out.readability is not None
    assert out.readability.before.level == "Красный (тяжело)"
    assert out.readability.after.level == "Зелёный (хорошо)"
    assert out.readability.before.average_penalty > out.readability.after.average_penalty


async def test_correct_passes_budget_and_timeout_by_input_length():
    """max_tokens и таймаут считаются от длины ввода, а не берутся фиксированными."""
    long_text = "Проверка соблюдения порядка ведения учёта. " * 400  # ≈17k символов
    fake = _llm(long_text)  # объём сохранён — guard короткого ответа не при делах

    with patch(
        "app.domains.chat.services.text_actions.corrector_service.resolve_target",
        AsyncMock(return_value=(fake, "m")),
    ):
        await TextCorrectorService(_settings()).correct(long_text)

    kwargs = fake.chat.completions.create.call_args.kwargs
    assert kwargs["max_tokens"] >= B.MIN_OUTPUT_TOKENS
    assert kwargs["max_tokens"] == B.output_budget_tokens(
        len(long_text), profile=B.PROFILE_REWRITE,
    )
    # Настроечные 60 секунд — нижняя граница; на длинном тексте ждём дольше.
    assert kwargs["timeout"] > 60.0


async def test_correct_short_input_keeps_configured_timeout():
    """Короткое выделение не должно получать таймаут меньше настроенного."""
    fake = _llm("исправлено")

    with patch(
        "app.domains.chat.services.text_actions.corrector_service.resolve_target",
        AsyncMock(return_value=(fake, "m")),
    ):
        await TextCorrectorService(_settings()).correct("короткий текст")

    assert fake.chat.completions.create.call_args.kwargs["timeout"] == 60.0


async def test_fix_mode_rejects_suspiciously_short_answer():
    """Корректор орфографии обязан сохранять объём: короткий ответ — обрыв."""
    source = "Слово. " * 200  # ≈1400 символов
    with patch(
        "app.domains.chat.services.text_actions.corrector_service.resolve_target",
        AsyncMock(return_value=(_llm("Слово. " * 20), "m")),
    ):
        with pytest.raises(TextActionUnavailableError):
            await TextCorrectorService(_settings()).correct(source, mode="fix")


async def test_readability_mode_allows_short_answer():
    """«Пиши, сокращай» сокращает по своей природе — guard к нему неприменим."""
    source = (
        "В ходе проведения проверки соблюдения порядка ведения учёта "
        "организацией не было обеспечено представление документов. " * 20
    )
    short = "Организация не представила документы."

    with patch(
        "app.domains.chat.services.text_actions.corrector_service.resolve_target",
        AsyncMock(return_value=(_llm(short), "m")),
    ):
        out = await TextCorrectorService(_settings()).correct(
            source, mode="readability",
        )

    assert out.corrected_text == short


async def test_fix_mode_allows_normal_length_answer():
    """Обычная правка букв объём не теряет — guard не срабатывает."""
    source = "Проверка провидена с нарушением сроков. " * 40
    answer = "Проверка проведена с нарушением сроков. " * 40

    with patch(
        "app.domains.chat.services.text_actions.corrector_service.resolve_target",
        AsyncMock(return_value=(_llm(answer), "m")),
    ):
        out = await TextCorrectorService(_settings()).correct(source, mode="fix")

    assert out.corrected_text == answer.strip()


async def test_readability_report_is_optional_on_analyzer_failure():
    """Сбой анализатора не роняет корректуру — текст важнее диагностики."""
    with patch(
        "app.domains.chat.services.text_actions.corrector_service.resolve_target",
        AsyncMock(return_value=(_llm("улучшено"), "m")),
    ), patch(
        "app.domains.chat.services.text_actions.corrector_service.analyze_for_api",
        side_effect=RuntimeError("словарь не поднялся"),
    ):
        out = await TextCorrectorService(_settings()).correct("текст", mode="readability")

    assert out.corrected_text == "улучшено"
    assert out.readability is None
