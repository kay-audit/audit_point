"""Тесты расчёта бюджета вывода и таймаута text-actions (budget.py).

Ворота ввода — 32768 символов; проверяем, что на предельном тексте бюджет и
таймаут остаются осмысленными, а на коротком не проваливаются ниже настройки.
"""

from app.domains.chat.services.text_actions import budget as B
from app.domains.chat.settings import ChatDomainSettings


def _max_chars() -> int:
    """Предельная длина ввода из дефолтов доменных настроек (без .env)."""
    return ChatDomainSettings(
        api_base="http://x", api_key="x", model="m",
    ).text_actions.max_input_chars


def test_estimate_tokens_zero_and_negative():
    assert B.estimate_tokens(0) == 0
    assert B.estimate_tokens(-5) == 0


def test_estimate_tokens_matches_observed_range_at_limit():
    """Предельный ввод укладывается в наблюдаемые 11–14k токенов кириллицы."""
    tokens = B.estimate_tokens(_max_chars())
    assert 11_000 <= tokens <= 14_000


def test_short_input_gets_floor_budget():
    """На коротком выделении бюджет не проваливается ниже нижней границы."""
    assert B.output_budget_tokens(80) == B.MIN_OUTPUT_TOKENS


def test_budget_grows_with_input():
    small = B.output_budget_tokens(2_000)
    large = B.output_budget_tokens(20_000)
    assert B.MIN_OUTPUT_TOKENS < small < large


def test_budget_at_limit_covers_full_rewrite():
    """Предельный ввод: бюджета хватает переписать текст целиком с запасом."""
    chars = _max_chars()
    tokens = B.output_budget_tokens(chars, profile=B.PROFILE_REWRITE)
    assert tokens > B.estimate_tokens(chars)  # ответ может быть длиннее входа
    assert tokens <= B.MAX_OUTPUT_TOKENS


def test_budget_never_exceeds_cap():
    """Кап держит max_tokens в рамках контекстного окна даже на аномалии."""
    assert B.output_budget_tokens(10_000_000) == B.MAX_OUTPUT_TOKENS


def test_extract_profile_is_cheaper_than_rewrite():
    """Выжимке JSON не нужен бюджет копии текста."""
    chars = _max_chars()
    assert (
        B.output_budget_tokens(chars, profile=B.PROFILE_EXTRACT)
        < B.output_budget_tokens(chars, profile=B.PROFILE_REWRITE)
    )


def test_unknown_profile_falls_back_to_rewrite():
    """Ошибиться в сторону большего бюджета безопаснее, чем обрезать ответ."""
    assert (
        B.output_budget_tokens(5_000, profile="bogus")
        == B.output_budget_tokens(5_000, profile=B.PROFILE_REWRITE)
    )


def test_timeout_not_less_than_setting():
    """Настройка per_call_timeout_sec — нижняя граница ожидания."""
    assert B.call_timeout_sec(50, floor_sec=60.0) == 60.0


def test_timeout_grows_with_input():
    short = B.call_timeout_sec(1_000, floor_sec=60.0)
    long = B.call_timeout_sec(_max_chars(), floor_sec=60.0)
    assert long > short >= 60.0


def test_timeout_at_limit_survives_slow_generation():
    """На предельном вводе ждём дольше минуты — иначе гарантированный таймаут."""
    timeout = B.call_timeout_sec(_max_chars(), floor_sec=60.0)
    assert timeout > 300.0
    assert timeout <= B.MAX_ESTIMATED_TIMEOUT_SEC


def test_timeout_ceiling_follows_from_budget_cap():
    """Расчётная часть ожидания ограничена капом бюджета вывода."""
    assert (
        B.call_timeout_sec(10_000_000, floor_sec=60.0) == B.MAX_ESTIMATED_TIMEOUT_SEC
    )


def test_retry_attempts_capped():
    """Дефолтные 5 попыток чата для синхронного text-action слишком много."""
    assert B.retry_attempts(5) == B.MAX_ATTEMPTS_CAP


def test_retry_attempts_respects_lower_setting():
    """Кап, а не подмена: заданное меньшее значение уважается."""
    assert B.retry_attempts(1) == 1


def test_looks_truncated_detects_lost_tail():
    source = "а" * 4_000
    assert B.looks_truncated(source, "а" * 1_000) is True


def test_looks_truncated_false_on_same_length():
    source = "а" * 4_000
    assert B.looks_truncated(source, "а" * 3_990) is False


def test_looks_truncated_ignores_short_input():
    """На коротком выделении обрыв невозможен — доля ничего не значит."""
    source = "а" * (B.TRUNCATION_GUARD_MIN_CHARS - 1)
    assert B.looks_truncated(source, "а") is False


def test_looks_truncated_on_empty_answer():
    assert B.looks_truncated("а" * 1_000, "") is True
