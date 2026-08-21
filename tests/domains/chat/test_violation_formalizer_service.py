"""Тесты ViolationFormalizerService (Фича «Формализация нарушения»).

Конвейер D17 целиком: 4 экстрактора параллельно → сборщик отчёта и рекомендации
параллельно. Поля карточки берутся у сборщика, «Нарушено» и «Описание» — прямо у
экстрактора сути. Списки в карточке применяются ТОЛЬКО в «Описании».
"""

import json
from unittest.mock import AsyncMock, patch

import pytest

from app.domains.chat.exceptions import (
    TextActionUnavailableError,
    TextActionValidationError,
)
from app.domains.chat.services.text_actions import budget as B
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


# Маркеры — первые слова ролей из промптов D17; попарно различимы.
_ESSENCE = "старший аналитик по нормативным нарушениям"
_CAUSES = "эксперт по расследованию инцидентов"
_CONSEQUENCES = "аналитик по оценке последствий"
_MEASURES = "аналитик по корректирующим мерам"
_VIOLATION = "редактор официальных аудиторских документов"
_RECOMMENDATIONS = "аудитор процессов комплаенса"

# JSON, который «модель» вернёт каждому промпту — по маркеру в system-промпте.
_BY_PROMPT = {
    _ESSENCE: json.dumps({
        "essence": "Кредит выдан без проверки",
        "norm_doc": "П. 3.1 Регламента",
        "metrics": ["сумма 5 млн руб.", "дата 01.02.2025"],
    }),
    _CAUSES: json.dumps({
        "causes": ["отсутствие проверки", "нет контроля лимитов"],
        "persons": ["Иванов И.И., кредитный инспектор", "Отдел кредитования"],
    }),
    _CONSEQUENCES: json.dumps({"consequences": "Финансовый ущерб 5 млн руб."}),
    _MEASURES: json.dumps({"measures": ["досоздан контроль", "проведён аудит"]}),
    _VIOLATION: json.dumps({
        "violations": "Допущена выдача кредита без проверки заемщика",
        "causes": "Отсутствие проверки и контроля лимитов. Ответственные: Иванов И.И.",
        "consequences": "Причинён финансовый ущерб",
        "measures": "Организован контроль, проведён аудит",
        "persons": ["Иванов И.И., кредитный инспектор", "Отдел кредитования"],
    }),
    _RECOMMENDATIONS: json.dumps({
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


def _run(client):
    return patch(
        "app.domains.chat.services.text_actions.formalizer_service.resolve_target",
        AsyncMock(return_value=(client, "m")),
    )


async def test_formalize_maps_all_fields():
    with _run(_client_by_prompt()):
        out = await ViolationFormalizerService(_settings()).formalize("сырой текст")

    # «Нарушено» — норматив прямо из экстрактора, сборщик его в текст не вписывает.
    assert out.violated == "П. 3.1 Регламента"
    # «Установлено» — связная строка сборщика: без ссылки на норматив и без цифр.
    assert out.established == "Допущена выдача кредита без проверки заемщика"
    # «Описание» — единственное поле карточки со списком: метрики побулитно.
    assert out.description == (
        "<ul><li>сумма 5 млн руб.</li><li>дата 01.02.2025</li></ul>"
    )
    # Остальные поля — связные строки от сборщика.
    assert out.reasons == (
        "Отсутствие проверки и контроля лимитов. Ответственные: Иванов И.И."
    )
    assert out.consequences == "Причинён финансовый ущерб"
    assert out.measures == "Организован контроль, проведён аудит"
    assert out.responsible == "Иванов И.И., кредитный инспектор; Отдел кредитования"
    assert out.recommendations == [
        "Уточните дату выдачи.", "Укажите ответственных лиц.",
    ]


async def test_lists_live_only_in_description():
    """Списки в карточке — только «Описание»; остальные поля связный текст."""
    with _run(_client_by_prompt()):
        out = await ViolationFormalizerService(_settings()).formalize("текст")

    assert "<ul>" in out.description
    for value in (out.violated, out.established, out.reasons,
                  out.measures, out.consequences, out.responsible):
        assert "<ul>" not in value


async def test_empty_fields_stay_empty():
    """Пустое поле остаётся пустым — плейсхолдеров вроде «Не указаны» быть не должно."""
    client = _client_by_prompt({_VIOLATION: json.dumps({
        "violations": "Допущено нарушение",
        "causes": "",
        "consequences": "",
        "measures": "",
        "persons": [],
    })})
    with _run(client):
        out = await ViolationFormalizerService(_settings()).formalize("текст")

    assert out.established == "Допущено нарушение"
    assert out.reasons == ""
    assert out.consequences == ""
    assert out.measures == ""
    assert out.responsible == ""


async def test_falls_back_to_extractors_when_violation_fails():
    """Сбой сборщика не меняет оформление полей — фолбэк даёт ту же форму."""
    client = _client_by_prompt({_VIOLATION: "не json"})
    with _run(client):
        out = await ViolationFormalizerService(_settings()).formalize("текст")

    assert out.violated == "П. 3.1 Регламента"
    assert out.established == "Кредит выдан без проверки"
    assert out.description == (
        "<ul><li>сумма 5 млн руб.</li><li>дата 01.02.2025</li></ul>"
    )
    # Списки экстракторов склеиваются в строку — как и на основном пути.
    assert out.reasons == "отсутствие проверки; нет контроля лимитов"
    assert out.measures == "досоздан контроль; проведён аудит"
    assert out.responsible == "Иванов И.И., кредитный инспектор; Отдел кредитования"
    assert out.consequences == "Финансовый ущерб 5 млн руб."


async def test_description_escapes_html_in_metrics():
    """Элемент списка с разметкой экранируется — текст LLM не HTML."""
    client = _client_by_prompt({_ESSENCE: json.dumps({
        "essence": "суть",
        "norm_doc": "П. 3.1",
        "metrics": ["<b>жирная метрика</b>", "вторая метрика"],
    })})
    with _run(client):
        out = await ViolationFormalizerService(_settings()).formalize("текст")

    assert out.description == (
        "<ul><li>&lt;b&gt;жирная метрика&lt;/b&gt;</li><li>вторая метрика</li></ul>"
    )


async def test_description_empty_without_metrics():
    """Нет метрик → «Описание» пустое, а не пустой `<ul></ul>`."""
    client = _client_by_prompt({_ESSENCE: json.dumps({
        "essence": "Кредит выдан без проверки",
        "norm_doc": "П. 3.1 Регламента",
        "metrics": [],
    })})
    with _run(client):
        out = await ViolationFormalizerService(_settings()).formalize("текст")

    assert out.description == ""


async def test_scalar_fields_escaped_and_newlines_to_br():
    """Скаляр LLM — текст, не разметка: `<`/`&` экранируются, `\\n` → `<br>`."""
    client = _client_by_prompt({
        _ESSENCE: json.dumps({
            "essence": "суть",
            "norm_doc": "П. 3.1 «Ромашка & Ко»",
            "metrics": [],
        }),
        _VIOLATION: json.dumps({
            "violations": "Порог <b> превышен\nвторая строка",
            "causes": "",
            "consequences": "Ущерб <critical>\nи ещё строка",
            "measures": "",
            "persons": [],
        }),
    })
    with _run(client):
        out = await ViolationFormalizerService(_settings()).formalize("текст")

    assert out.violated == "П. 3.1 «Ромашка &amp; Ко»"
    assert out.established == "Порог &lt;b&gt; превышен<br>вторая строка"
    assert out.consequences == "Ущерб &lt;critical&gt;<br>и ещё строка"


async def test_responsible_joined_and_escaped():
    """Список лиц склеивается через «; » и экранируется как обычный текст."""
    client = _client_by_prompt({_VIOLATION: json.dumps({
        "violations": "н", "causes": "", "consequences": "", "measures": "",
        "persons": ["Иванов & Ко", "  ", "Петров П.П."],
    })})
    with _run(client):
        out = await ViolationFormalizerService(_settings()).formalize("текст")

    assert out.responsible == "Иванов &amp; Ко; Петров П.П."


async def test_pipeline_is_six_calls_at_deterministic_temperature():
    client = _client_by_prompt()
    with _run(client):
        await ViolationFormalizerService(_settings()).formalize("текст")

    # 4 экстрактора параллельно + сборщик и рекомендации во 2-й стадии.
    assert client.chat.completions.create.call_count == 6
    for call in client.chat.completions.create.call_args_list:
        assert call.kwargs["temperature"] == 0.01


async def test_extractor_input_goes_into_system_turn():
    """Раскладка turn'ов D17: текст подставляется в system, в user — приказ."""
    client = _client_by_prompt()
    with _run(client):
        await ViolationFormalizerService(_settings()).formalize("СЫРОЙ_ТЕКСТ_МАРКЕР")

    systems = [c.kwargs["messages"][0]["content"]
               for c in client.chat.completions.create.call_args_list]
    users = [c.kwargs["messages"][1]["content"]
             for c in client.chat.completions.create.call_args_list]
    essence_system = next(s for s in systems if _ESSENCE in s)
    assert "СЫРОЙ_ТЕКСТ_МАРКЕР" in essence_system
    assert all("СЫРОЙ_ТЕКСТ_МАРКЕР" not in u for u in users)
    # В user-turn'е — приказ D17 со статической формой JSON вместо
    # LangChain-плейсхолдера {format_instructions}.
    assert all("верни json" in u.lower() for u in users)
    assert all("{format_instructions}" not in u for u in users)


async def test_essence_failure_empties_only_its_own_fields():
    """Экстрактор сути упал → «Нарушено» и «Описание» пусты, прочее уцелело.

    Это единственные поля, которые идут прямо из экстрактора; остальные
    синтезирует сборщик, и на них падение сути так прямо не отражается.
    """
    client = _client_by_prompt({_ESSENCE: "не json вообще"})
    with _run(client):
        out = await ViolationFormalizerService(_settings()).formalize("текст")

    assert out.violated == ""
    assert out.description == ""
    assert out.established == "Допущена выдача кредита без проверки заемщика"


async def test_all_extractors_failed_raises_unavailable():
    """Сорвались ВСЕ экстракторы (провайдер лежит) → 503, а не пустой ответ.

    Пустой FormalizeResponse с HTTP 200 неотличим от «модель ничего не нашла» —
    именно так отказ LLM выглядел как «формализатор всегда возвращает пусто».
    """
    fake = AsyncMock()
    # Не-transient ошибка: retry её не повторяет, тест не ждёт backoff.
    fake.chat.completions.create = AsyncMock(
        side_effect=RuntimeError("LLM-провайдер недоступен"),
    )
    with _run(fake):
        with pytest.raises(TextActionUnavailableError) as exc_info:
            await ViolationFormalizerService(_settings()).formalize("текст")

    assert exc_info.value.status_code == 503
    assert "недоступен" in str(exc_info.value)
    # 4 экстрактора и ни одного вызова 2-й стадии: она не запускается,
    # раз извлекать оказалось нечего.
    assert fake.chat.completions.create.call_count == 4


async def test_partial_failure_returns_partial_result():
    """Упали 3 экстрактора из 4 — это ещё не авария: ответ отдаётся."""
    client = _client_by_prompt({
        _ESSENCE: "не json",
        _CAUSES: "не json",
        _MEASURES: "не json",
    })
    with _run(client):
        out = await ViolationFormalizerService(_settings()).formalize("текст")

    assert out.violated == ""      # поля упавшего экстрактора сути
    assert out.description == ""
    assert out.established == "Допущена выдача кредита без проверки заемщика"


async def test_recommendations_failure_returns_empty():
    """Сбой рекомендаций → пустой список, поля карточки не страдают."""
    client = _client_by_prompt({_RECOMMENDATIONS: "не json вообще"})
    with _run(client):
        out = await ViolationFormalizerService(_settings()).formalize("текст")

    assert out.recommendations == []
    assert out.violated == "П. 3.1 Регламента"


async def test_recommendations_cleaned_and_capped():
    """Пустые строки отсекаются, список режется до 5 (страховка над промптом)."""
    client = _client_by_prompt({_RECOMMENDATIONS: json.dumps({
        "recommendations": ["", "  ", "r1", "r2", "r3", "r4", "r5", "r6", "r7"],
    })})
    with _run(client):
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
    """Все 6 вызовов уходят с моделью выбранного маршрута."""
    client = _client_by_prompt()
    with patch(
        "app.domains.chat.services.text_actions.formalizer_service.resolve_target",
        AsyncMock(return_value=(client, "route-model")),
    ):
        await ViolationFormalizerService(_settings()).formalize("текст")

    assert client.chat.completions.create.call_count == 6
    for call in client.chat.completions.create.call_args_list:
        assert call.kwargs["model"] == "route-model"


async def test_formalize_sets_output_budget_on_every_call():
    """Каждый вызов уходит с max_tokens профиля extract и таймаутом не ниже настройки."""
    source = "текст нарушения. " * 500
    client = _client_by_prompt()
    with _run(client):
        await ViolationFormalizerService(_settings()).formalize(source)

    expected = B.output_budget_tokens(len(source), profile=B.PROFILE_EXTRACT)
    assert client.chat.completions.create.call_count == 6
    for call in client.chat.completions.create.call_args_list:
        assert call.kwargs["max_tokens"] == expected
        assert call.kwargs["timeout"] >= 60.0
