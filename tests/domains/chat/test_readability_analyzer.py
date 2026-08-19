"""Тесты анализатора читаемости (дословный перенос analyzer.py D17, папка 1).

Ожидаемые числа — не «подогнанные под реализацию», а снятые с эталонного
скрипта команды D17: списки маркеров, коэффициенты штрафов и пороги светофора
30/60 — их контракт. Если тест покраснел — расходится перенос, а не ожидание.
"""

from app.domains.chat.services.text_actions import readability_analyzer as A

# Канцелярский эталон: пассив, цепочка родительного падежа из 5 слов,
# 34 слова в предложении, канцеляризмы, усилители, пустое вводное.
_HEAVY = (
    "В ходе проведения проверки соблюдения порядка ведения бухгалтерского учёта "
    "организацией не было обеспечено представление подтверждающих документов "
    "(за 2 квартал 2024 года), в связи с чем следует отметить, что надлежащий "
    "контроль со стороны соответствующих подразделений весьма затруднён."
)

_LIGHT = "Организация не представила документы. Аудитор зафиксировал нарушение."


def test_heavy_text_is_red():
    r = A.analyze_text(_HEAVY)
    assert r["level"] == "Красный (тяжело)"
    assert r["average_penalty"] == 150.0
    assert r["sentence_count"] == 1
    assert r["total_words"] == 34


def test_heavy_text_metrics():
    r = A.analyze_text(_HEAVY)
    assert r["overall_noun_verb_ratio"] == 8.0
    assert r["longest_genitive_chain"] == [
        "проведения", "проверки", "соблюдения", "порядка", "ведения",
    ]
    assert r["bureaucratic_markers_total"] == 3
    assert r["amplifier_total"] == 2
    assert r["intro_total"] == 1
    assert r["passive_count"] == 1


def test_light_text_is_green():
    r = A.analyze_text(_LIGHT)
    assert r["level"] == "Зелёный (хорошо)"
    assert r["average_penalty"] == 0.0
    assert r["overall_noun_verb_ratio"] == 2.0


def test_thresholds_are_30_and_60():
    """Пороги светофора — часть контракта D17, пиним их явно."""
    assert A.level_for(29.9) == "Зелёный (хорошо)"
    assert A.level_for(30.0) == "Жёлтый (средне)"
    assert A.level_for(59.9) == "Жёлтый (средне)"
    assert A.level_for(60.0) == "Красный (тяжело)"


def test_empty_text_is_not_a_crash():
    """У D17 пустой текст даёт не ошибку, а обнулённый отчёт: ветка «error»
    в их ``analyze_text`` недостижима. Перенос это поведение сохраняет."""
    r = A.analyze_text("   ")
    assert r["sentence_count"] == 0
    assert r["average_penalty"] == 0


def test_analyze_for_api_shape():
    p = A.analyze_for_api(_HEAVY)
    assert p is not None
    assert set(p) == {
        "average_penalty", "level", "recommendation", "sentence_count",
        "total_words", "noun_verb_ratio", "longest_genitive_chain",
        "avg_word_count", "avg_comma_count", "bureaucratic_markers_total",
        "amplifier_total", "intro_total", "passive_count", "reasons",
    }
    assert p["level"] == "Красный (тяжело)"
    assert p["average_penalty"] == 150.0
    assert p["noun_verb_ratio"] == 8.0
    assert isinstance(p["reasons"], list) and p["reasons"]


def test_analyze_for_api_none_on_empty():
    """Наружу вердикт «Зелёный, можно подписывать» на пустом тексте отдавать
    нельзя — это решение обёртки, ``analyze_text`` остаётся дословным."""
    assert A.analyze_for_api("") is None
    assert A.analyze_for_api("   ") is None


def test_noun_verb_ratio_without_verbs_is_none():
    """inf в JSON невалиден — на границе DTO это None, а не бесконечность."""
    p = A.analyze_for_api("Отсутствие контроля лимитов.")
    assert p is not None
    assert p["noun_verb_ratio"] is None
