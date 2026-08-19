"""Тест дословности корректорского промпта D17."""

from app.domains.chat.services.text_actions import prompts as P


def test_auditor_prompt_verbatim_markers():
    # Ключевые дословные маркеры из D17 (папка 1, orphography_v2.py).
    assert "корректор банковских документов" in P.AUDITOR_SYSTEM_PROMPT
    assert "трансакция" in P.AUDITOR_SYSTEM_PROMPT
    assert "транзакция" in P.AUDITOR_SYSTEM_PROMPT
    assert "ПРИМЕР НЕПРАВИЛЬНОЙ РАБОТЫ" in P.AUDITOR_SYSTEM_PROMPT
    # Промпт статичен — без рантайм-плейсхолдеров.
    assert "{format_instructions}" not in P.AUDITOR_SYSTEM_PROMPT
    assert len(P.AUDITOR_SYSTEM_PROMPT) > 500


def test_readability_prompt_verbatim_markers():
    # Ключевые дословные маркеры из D17 (папка 1, reading_text_test_prompt.txt).
    assert "Пиши, сокращай" in P.READABILITY_SYSTEM_PROMPT
    assert "Ты НЕ аудитор. Ты НЕ анализируешь содержание." in P.READABILITY_SYSTEM_PROMPT
    assert "ПРАВИЛО ОТКАТА" in P.READABILITY_SYSTEM_PROMPT
    assert "НЕПРИКОСНОВЕННО" in P.READABILITY_SYSTEM_PROMPT
    # Промпт статичен — без рантайм-плейсхолдеров.
    assert "{" not in P.READABILITY_SYSTEM_PROMPT
    assert len(P.READABILITY_SYSTEM_PROMPT) > 3000
