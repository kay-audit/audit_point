"""Нативные хелперы вызова LLM для text-actions (без LangChain)."""

import json
import logging
import re

from app.domains.chat.exceptions import TextActionUnavailableError

logger = logging.getLogger("audit_workstation.chat.text_actions.llm")

# Сообщение пользователю, когда модель упёрлась в потолок ответа. Отдельная
# ошибка вместо тихой подстановки обрезанного текста: в акт аудита нельзя
# вставлять текст с потерянным хвостом, а отличить его от нормального
# пользователь не может.
_TRUNCATED_MESSAGE = (
    "Ответ ИИ-сервиса оборвался на середине — текст не поместился в ответ "
    "модели. Сократите выделение и повторите."
)

_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)

# Обёртка ``` … ``` вокруг ВСЕГО ответа (модель завернула текст в код-блок).
_CODE_FENCE_RE = re.compile(r"^\s*```[^\n]*\n(.*?)\n```\s*$", re.DOTALL)

# Ведущая преамбула-ярлык, которую промпты корректора ПРЯМО запрещают
# («Исправленный текст:», «Вот улучшенный вариант:» …). Рассуждающие провайдеры
# (напр. Anthropic) иногда добавляют её вопреки запрету. Матчим ТОЛЬКО как
# отдельную ведущую строку (обязателен перевод строки после двоеточия) — чтобы
# не срезать реальный первый абзац, если он случайно начнётся с этих слов.
_PREAMBLE_RE = re.compile(
    r"^\s*(?:вот\s+)?(?:исправленн\w+|улучшенн\w+)\s+(?:текст|вариант)\s*:[ \t]*\n+",
    re.IGNORECASE,
)


def strip_think(text: str) -> str:
    """Убрать блоки рассуждений reasoning-модели (``<think>…</think>``).

    Подстраховка на случай, если sglang не сконфигурирован с
    ``--reasoning-parser`` и рассуждения попали в ``content``.
    """
    return _THINK_RE.sub("", text or "")


def clean_text_response(text: str) -> str:
    """Очистить ``text → text`` ответ LLM от «мусора вокруг полезной нагрузки».

    Тот же принцип устойчивости, что у ``extract_json`` для формализации: не
    доверяем модели вернуть ТОЛЬКО payload, а вычищаем обрамление. Здесь payload —
    сам исправленный текст, поэтому срезаем: рассуждения ``<think>…</think>``,
    обёртку ``` ``` вокруг всего ответа и ведущую преамбулу-ярлык, запрещённую
    промптом («Исправленный текст:» и т.п.). Провайдер-агностично — защищает диф
    корректора от рассуждающих моделей (Anthropic и др.), как формализатор защищён
    разбором JSON.
    """
    cleaned = strip_think(text or "").strip()
    fence = _CODE_FENCE_RE.match(cleaned)
    if fence:
        cleaned = fence.group(1).strip()
    cleaned = _PREAMBLE_RE.sub("", cleaned, count=1)
    return cleaned.strip()


def _finish_reason(resp) -> str | None:
    """``finish_reason`` первого choice, если провайдер его прислал."""
    try:
        reason = resp.choices[0].finish_reason
    except (AttributeError, IndexError, TypeError):
        return None
    return reason if isinstance(reason, str) else None


async def _raw_call(
    client,
    *,
    model: str,
    temperature: float,
    system: str,
    user: str,
    retry_call,
    timeout: float,
    max_tokens: int,
) -> str:
    """Общий транспорт one-shot вызова LLM — возвращает сырой ``content``.

    ``retry_call`` — обёртка ``retry_on_transient`` над вызываемым; она сама
    ретраит transient-ошибки, ``timeout`` ограничивает каждую попытку. Пост-
    обработку (очистка текста / разбор JSON) делают публичные обёртки.

    ``max_tokens`` обязателен: без него действовал дефолтный потолок провайдера,
    и на длинном тексте ответ обрезался молча. Считается по длине ввода —
    ``budget.output_budget_tokens``.

    ``finish_reason="length"`` означает, что модель упёрлась в потолок и ответ
    неполон. Такой результат отдаётся ошибкой (``TextActionUnavailableError``),
    а не подставляется пользователю: обрезанный текст внешне неотличим от
    готового. Проверка транспортная — работает для всех действий, включая
    сокращающие, потому что это факт от провайдера, а не догадка по длине.
    """
    wrapped = retry_call(client.chat.completions.create)
    resp = await wrapped(
        model=model,
        temperature=temperature,
        stream=False,
        timeout=timeout,
        max_tokens=max_tokens,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    if _finish_reason(resp) == "length":
        logger.warning(
            "text-action: ответ модели %s оборван по max_tokens=%s", model, max_tokens,
        )
        raise TextActionUnavailableError(_TRUNCATED_MESSAGE)
    return resp.choices[0].message.content or ""


async def run_text_call(
    client,
    *,
    model: str,
    temperature: float,
    system: str,
    user: str,
    retry_call,
    timeout: float,
    max_tokens: int,
) -> str:
    """One-shot вызов LLM ``text → text`` (Фича «Корректор»).

    Ответ чистится ``clean_text_response`` (рассуждения/обёртки/преамбулы — как в
    формализаторе, чтобы диф не пачкали рассуждающие провайдеры).
    """
    content = await _raw_call(
        client,
        model=model,
        temperature=temperature,
        system=system,
        user=user,
        retry_call=retry_call,
        timeout=timeout,
        max_tokens=max_tokens,
    )
    return clean_text_response(content)


def extract_json(text: str) -> dict:
    """Достаёт JSON-объект из ответа LLM (Фича «Формализация»).

    Срезает ``<think>…</think>`` и разбирает первый сбалансированный ``{…}``-блок
    через ``raw_decode`` (хвост после объекта игнорируется) — провайдер-агностично
    защищает разбор от протёкших рассуждений, префиксов-пояснений и лишних скобок
    в прозе вокруг JSON. Кандидаты (позиции ``{``) перебираются по очереди: скобки
    из текста (напр. ``{данных}``) не парсятся как JSON и пропускаются. Кидает
    ``ValueError`` на отсутствующий/битый объект.
    """
    cleaned = strip_think(text or "")
    decoder = json.JSONDecoder()
    idx = cleaned.find("{")
    while idx != -1:
        try:
            obj, _ = decoder.raw_decode(cleaned, idx)
        except json.JSONDecodeError:
            idx = cleaned.find("{", idx + 1)
            continue
        if isinstance(obj, dict):
            return obj
        idx = cleaned.find("{", idx + 1)
    raise ValueError("В ответе LLM не найден JSON-объект")


async def run_json_call(
    client,
    *,
    model: str,
    temperature: float,
    system: str,
    user: str,
    retry_call,
    timeout: float,
    max_tokens: int,
) -> dict:
    """One-shot вызов LLM с разбором JSON-ответа (Фича «Формализация»).

    Тот же транспорт, что ``run_text_call``, но результат — распарсенный dict
    (см. ``extract_json``). Провайдер-специфичный ``response_format`` НЕ
    используется: структуру задаёт промпт, надёжность даёт разбор ответа.
    """
    content = await _raw_call(
        client,
        model=model,
        temperature=temperature,
        system=system,
        user=user,
        retry_call=retry_call,
        timeout=timeout,
        max_tokens=max_tokens,
    )
    return extract_json(content)
