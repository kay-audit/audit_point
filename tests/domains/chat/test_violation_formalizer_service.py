"""Тесты ViolationFormalizerService (Фича «Формализация нарушения»)."""

import json
from unittest.mock import AsyncMock, patch

import pytest

from app.domains.chat.exceptions import (
    TextActionUnavailableError,
    TextActionValidationError,
)
from app.domains.chat.services.text_actions.formalizer_service import (
    ViolationFormalizerService,
)
from app.domains.chat.services.text_actions.llm_utils import extract_json
from app.domains.chat.settings import ChatDomainSettings


def _settings():
    return ChatDomainSettings(api_base="http://x", api_key="x", model="m")


def _resp(content: str):
    msg = AsyncMock()
    msg.content = content
    r = AsyncMock()
    r.choices = [AsyncMock(message=msg)]
    return r


# JSON, который «модель» вернёт каждому экстрактору — по фразе в system-промпте.
_BY_PROMPT = {
    "аналитик нормативных нарушений": json.dumps({
        "essence": "Кредит выдан без проверки",
        "norm_doc": "П. 3.1 Регламента",
        "metrics": ["сумма 5 млн руб.", "дата 01.02.2025"],
    }),
    "эксперт по расследованию инцидентов": json.dumps({
        "causes": ["отсутствие проверки", "нет контроля лимитов"],
        "persons": ["Иванов И.И., кредитный инспектор", "Отдел кредитования"],
    }),
    "Каждое последствие": json.dumps({"consequences": "Финансовый ущерб 5 млн руб."}),
    "аналитик корректирующих мер": json.dumps({
        "measures": ["досоздан контроль", "проведён аудит"],
    }),
    "аудитор процессов": json.dumps({
        "recommendations": ["Уточните дату выдачи.", "Укажите ответственных лиц."],
    }),
}


def _client_by_prompt(overrides: dict[str, str] | None = None):
    """Мок LLM-клиента: JSON-ответ выбирается по маркеру в system-промпте."""
    table = dict(_BY_PROMPT)
    if overrides:
        table.update(overrides)
    fake = AsyncMock()

    async def _create(**kwargs):
        system = kwargs["messages"][0]["content"]
        for marker, payload in table.items():
            if marker in system:
                return _resp(payload)
        return _resp("{}")

    fake.chat.completions.create = AsyncMock(side_effect=_create)
    return fake


async def test_formalize_maps_all_fields():
    with patch(
        "app.domains.chat.services.text_actions.formalizer_service.resolve_target",
        AsyncMock(return_value=(_client_by_prompt(), "m")),
    ):
        out = await ViolationFormalizerService(_settings()).formalize("сырой текст")

    assert out.violated == "П. 3.1 Регламента"  # скаляр — экранированный текст
    assert out.established == (
        "Кредит выдан без проверки"
        "<ul><li>сумма 5 млн руб.</li><li>дата 01.02.2025</li></ul>"
    )  # суть — текстом, метрики — честным HTML-списком, без голого \n между ними
    assert out.reasons == (
        "<ul><li>отсутствие проверки</li><li>нет контроля лимитов</li></ul>"
    )
    assert out.responsible == (
        "<ul><li>Иванов И.И., кредитный инспектор</li><li>Отдел кредитования</li></ul>"
    )
    assert out.consequences == "Финансовый ущерб 5 млн руб."  # скаляр — как есть
    assert out.measures == (
        "<ul><li>досоздан контроль</li><li>проведён аудит</li></ul>"
    )
    assert out.recommendations == [
        "Уточните дату выдачи.", "Укажите ответственных лиц.",
    ]


async def test_formalize_list_items_escape_html():
    """Элемент списка с HTML-разметкой экранируется — текст LLM не HTML."""
    client = _client_by_prompt({
        "эксперт по расследованию инцидентов": json.dumps({
            "causes": ["<b>жирная причина</b>", "вторая причина"],
            "persons": [],
        }),
    })
    with patch(
        "app.domains.chat.services.text_actions.formalizer_service.resolve_target",
        AsyncMock(return_value=(client, "m")),
    ):
        out = await ViolationFormalizerService(_settings()).formalize("текст")

    assert out.reasons == (
        "<ul><li>&lt;b&gt;жирная причина&lt;/b&gt;</li><li>вторая причина</li></ul>"
    )
    assert out.responsible == ""  # пустой список → пустая строка, не <ul></ul>


async def test_formalize_established_without_metrics_has_no_list():
    """Нет метрик → established — просто абзац сути, без `<ul>`."""
    client = _client_by_prompt({
        "аналитик нормативных нарушений": json.dumps({
            "essence": "Кредит выдан без проверки",
            "norm_doc": "П. 3.1 Регламента",
            "metrics": [],
        }),
    })
    with patch(
        "app.domains.chat.services.text_actions.formalizer_service.resolve_target",
        AsyncMock(return_value=(client, "m")),
    ):
        out = await ViolationFormalizerService(_settings()).formalize("текст")

    assert out.established == "Кредит выдан без проверки"


async def test_formalize_temperature_deterministic():
    client = _client_by_prompt()
    with patch(
        "app.domains.chat.services.text_actions.formalizer_service.resolve_target",
        AsyncMock(return_value=(client, "m")),
    ):
        await ViolationFormalizerService(_settings()).formalize("текст")
    # 4 экстрактора параллельно + 2-й этап рекомендаций.
    assert client.chat.completions.create.call_count == 5
    for call in client.chat.completions.create.call_args_list:
        assert call.kwargs["temperature"] == 0.01


async def test_formalize_extractor_failure_leaves_field_empty():
    """Битый JSON от одного экстрактора → его поля пустые, остальные заполнены."""
    client = _client_by_prompt(
        {"эксперт по расследованию инцидентов": "не json вообще"},
    )
    with patch(
        "app.domains.chat.services.text_actions.formalizer_service.resolve_target",
        AsyncMock(return_value=(client, "m")),
    ):
        out = await ViolationFormalizerService(_settings()).formalize("текст")

    assert out.reasons == ""       # экстрактор причин упал
    assert out.responsible == ""
    assert out.violated == "П. 3.1 Регламента"  # остальные не пострадали
    assert out.consequences == "Финансовый ущерб 5 млн руб."


async def test_formalize_all_extractors_failed_raises_unavailable():
    """Сорвались ВСЕ экстракторы (провайдер лежит) → 503, а не пустой ответ.

    Пустой FormalizeResponse с HTTP 200 неотличим от «модель ничего не нашла» —
    именно так отказ LLM выглядел как «формализатор всегда возвращает пусто».
    """
    fake = AsyncMock()
    # Не-transient ошибка: retry её не повторяет, тест не ждёт backoff.
    fake.chat.completions.create = AsyncMock(
        side_effect=RuntimeError("LLM-провайдер недоступен"),
    )
    with patch(
        "app.domains.chat.services.text_actions.formalizer_service.resolve_target",
        AsyncMock(return_value=(fake, "m")),
    ):
        with pytest.raises(TextActionUnavailableError) as exc_info:
            await ViolationFormalizerService(_settings()).formalize("текст")

    assert exc_info.value.status_code == 503
    assert "недоступен" in str(exc_info.value)
    # 4 экстрактора и ни одного вызова рекомендаций: 2-й этап не запускается,
    # раз извлекать оказалось нечего.
    assert fake.chat.completions.create.call_count == 4


async def test_formalize_partial_failure_returns_partial_result():
    """Упали 3 экстрактора из 4 — это ещё не авария: отдаём частичный результат."""
    client = _client_by_prompt({
        "аналитик нормативных нарушений": "не json",
        "эксперт по расследованию инцидентов": "не json",
        "аналитик корректирующих мер": "не json",
    })
    with patch(
        "app.domains.chat.services.text_actions.formalizer_service.resolve_target",
        AsyncMock(return_value=(client, "m")),
    ):
        out = await ViolationFormalizerService(_settings()).formalize("текст")

    assert out.consequences == "Финансовый ущерб 5 млн руб."  # уцелевший экстрактор
    assert out.violated == ""
    assert out.established == ""
    assert out.reasons == ""
    assert out.measures == ""


async def test_formalize_scalar_fields_escaped_and_newlines_to_br():
    """Скаляр LLM — текст, не разметка: `<`/`&` экранируются, `\\n` → `<br>`."""
    client = _client_by_prompt({
        "аналитик нормативных нарушений": json.dumps({
            "essence": "Порог <b> превышен\nвторая строка",
            "norm_doc": "П. 3.1 «Ромашка & Ко»",
            "metrics": [],
        }),
        "Каждое последствие": json.dumps({
            "consequences": "Ущерб <critical>\nи ещё строка",
        }),
    })
    with patch(
        "app.domains.chat.services.text_actions.formalizer_service.resolve_target",
        AsyncMock(return_value=(client, "m")),
    ):
        out = await ViolationFormalizerService(_settings()).formalize("текст")

    assert out.violated == "П. 3.1 «Ромашка &amp; Ко»"
    assert out.established == "Порог &lt;b&gt; превышен<br>вторая строка"
    assert out.consequences == "Ущерб &lt;critical&gt;<br>и ещё строка"


async def test_formalize_recommendations_failure_returns_empty():
    """Сбой рекомендаций → пустой список, поля карточки не страдают."""
    client = _client_by_prompt({"аудитор процессов": "не json вообще"})
    with patch(
        "app.domains.chat.services.text_actions.formalizer_service.resolve_target",
        AsyncMock(return_value=(client, "m")),
    ):
        out = await ViolationFormalizerService(_settings()).formalize("текст")

    assert out.recommendations == []
    assert out.violated == "П. 3.1 Регламента"  # экстракторы отработали


async def test_formalize_recommendations_cleaned_and_capped():
    """Пустые строки отсекаются, список режется до 5 (страховка над промптом)."""
    client = _client_by_prompt({"аудитор процессов": json.dumps({
        "recommendations": ["", "  ", "r1", "r2", "r3", "r4", "r5", "r6", "r7"],
    })})
    with patch(
        "app.domains.chat.services.text_actions.formalizer_service.resolve_target",
        AsyncMock(return_value=(client, "m")),
    ):
        out = await ViolationFormalizerService(_settings()).formalize("текст")

    assert out.recommendations == ["r1", "r2", "r3", "r4", "r5"]


async def test_formalize_rejects_empty():
    with pytest.raises(TextActionValidationError):
        await ViolationFormalizerService(_settings()).formalize("   ")


async def test_formalize_rejects_too_long():
    s = _settings()
    s.text_actions.max_input_chars = 5
    with pytest.raises(TextActionValidationError):
        await ViolationFormalizerService(s).formalize("слишком длинный текст")


def test_extract_json_strips_think_and_grabs_object():
    raw = '<think>рассуждаю…</think> Вот ответ: {"essence": "x", "metrics": []} — готово'
    assert extract_json(raw) == {"essence": "x", "metrics": []}


def test_extract_json_raises_without_object():
    with pytest.raises(ValueError):
        extract_json("нет json")


async def test_formalize_reports_unavailable_when_no_routes():
    """Нет доступных маршрутов → 503 и ни одного запроса к провайдеру.

    Отличие от «сорвались все экстракторы»: там четыре вызова всё-таки ушли,
    здесь мы знаем заранее, что идти некуда.
    """
    with patch(
        "app.domains.chat.services.text_actions.formalizer_service.resolve_target",
        AsyncMock(return_value=None),
    ):
        with pytest.raises(TextActionUnavailableError):
            await ViolationFormalizerService(_settings()).formalize("текст")


async def test_formalize_uses_model_from_resolved_route():
    """Все 5 вызовов уходят с моделью выбранного маршрута."""
    client = _client_by_prompt()
    with patch(
        "app.domains.chat.services.text_actions.formalizer_service.resolve_target",
        AsyncMock(return_value=(client, "route-model")),
    ):
        await ViolationFormalizerService(_settings()).formalize("текст")

    assert client.chat.completions.create.call_count == 5
    for call in client.chat.completions.create.call_args_list:
        assert call.kwargs["model"] == "route-model"
