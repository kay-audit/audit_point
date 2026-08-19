import sys
import inspect

# ============================================================================
# МОНКИ-ПАТЧ ДЛЯ СОВМЕСТИМОСТИ pymorphy2 С PYTHON 3.12+
# Должен быть выполнен ДО импорта pymorphy2
# ============================================================================
if not hasattr(inspect, 'getargspec'):
    def _getargspec_patched(func):
        """Эмуляция inspect.getargspec через getfullargspec."""
        spec = inspect.getfullargspec(func)
        return (spec.args, spec.varargs, spec.varkw, spec.defaults)
    inspect.getargspec = _getargspec_patched
    # Патчим также getfullargspec, потому что pymorphy2 лезет напрямую в inspect
    if not hasattr(inspect, 'getfullargspec'):
        inspect.getfullargspec = inspect.getfullargspec  # уже есть в 3.12, но на всякий случай

import re
from typing import List, Dict, Optional, Any

import pymorphy2
from razdel import sentenize

# ============================================================================
# ИНИЦИАЛИЗАЦИЯ
# ============================================================================

morph = pymorphy2.MorphAnalyzer()

# ============================================================================
# СПИСКИ МАРКЕРОВ (синхронизированы с промтом редактора)
# ============================================================================

# Жёсткий канцелярит — подлежит замене
BUREAUCRATIC_MARKERS = [
    "в целях",
    "в связи с",
    "по состоянию на",
    "осуществление",
    "осуществить",
    "проведение",
    "провести",
    "оказание",
    "оказать",
    "содействие",
    "является",
    "настоящим",
    "документальное подтверждение",
    "факт оказания",
    "риск признания",
    "недействительный",
    "в ходе",
    "в процессе",
    "в рамках",
    "в части",
    "по причине",
    "со стороны",
    "на предмет",
    "на основании",
    "в соответствии с",
    "с целью",
    "за счёт",
]

# Слова-усилители — пустышки, не несущие смысловой нагрузки
AMPLIFIER_WORDS = [
    "весьма",
    "определённые",
    "определённый",
    "определённая",
    "соответствующие",
    "соответствующий",
    "соответствующая",
    "надлежащий",
    "надлежащая",
    "надлежащее",
    "данные",
    "данный",
    "данная",
]

# Пустые вводные конструкции
EMPTY_INTRO = [
    "следует отметить",
    "необходимо подчеркнуть",
    "необходимо отметить",
    "важно отметить",
    "вместе с тем",
    "в то же время",
    "при этом",
    "кроме того",
    "помимо этого",
    "также",
]

# ============================================================================
# ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
# ============================================================================

def get_pos(word: str) -> Optional[str]:
    """Возвращает часть речи слова."""
    try:
        parsed = morph.parse(word)[0]
        return parsed.tag.POS
    except Exception:
        return None

def get_case(word: str) -> Optional[str]:
    """Возвращает падеж слова."""
    try:
        parsed = morph.parse(word)[0]
        return parsed.tag.case
    except Exception:
        return None

def is_noun(word: str) -> bool:
    """Проверяет, является ли слово существительным."""
    return get_pos(word) == 'NOUN'

def is_verb(word: str) -> bool:
    """Проверяет, является ли слово глаголом."""
    return get_pos(word) == 'VERB'

def is_short_participle(word: str) -> bool:
    """Проверяет, является ли слово кратким причастием."""
    try:
        parsed = morph.parse(word)[0]
        return parsed.tag.POS == 'PRTS'
    except Exception:
        return False

def tokenize_sentence(sentence: str) -> List[str]:
    """Разбивает предложение на слова (только кириллица и латиница)."""
    return re.findall(r'[а-яёa-z]+(?:-[а-яёa-z]+)?', sentence, re.IGNORECASE)

def split_sentences(text: str) -> List[str]:
    """Разбивает текст на предложения."""
    return [sent.text for sent in sentenize(text)]

def count_commas(sentence: str) -> int:
    """Считает запятые в предложении."""
    return sentence.count(',')

def find_genitive_chain(sentence: str) -> List[str]:
    """
    Находит самую длинную цепочку существительных в родительном падеже.
    Возвращает список слов этой цепочки.
    """
    words = tokenize_sentence(sentence)
    chain, max_chain = [], []
    for word in words:
        if is_noun(word) and get_case(word) == 'gent':
            chain.append(word)
        else:
            if len(chain) > len(max_chain):
                max_chain = chain
            chain = []
    if len(chain) > len(max_chain):
        max_chain = chain
    return max_chain

def detect_passive_voice(sentence: str) -> bool:
    """
    Обнаруживает страдательный залог.
    Паттерн: был/была/было/были + краткое причастие.
    """
    words = tokenize_sentence(sentence)
    for i, word in enumerate(words):
        if word.lower() in ('был', 'была', 'было', 'были'):
            for j in range(i+1, min(i+4, len(words))):
                if is_short_participle(words[j]):
                    return True
    return False

def count_amplifiers(sentence: str) -> int:
    """Подсчитывает слова-усилители в предложении."""
    lower_sent = sentence.lower()
    words = tokenize_sentence(lower_sent)
    count = 0
    for word in words:
        if word in AMPLIFIER_WORDS:
            count += 1
    return count

def count_empty_intro(sentence: str) -> int:
    """Подсчитывает пустые вводные конструкции."""
    lower_sent = sentence.lower()
    count = 0
    for intro in EMPTY_INTRO:
        if intro in lower_sent:
            count += 1
    return count

# ============================================================================
# АНАЛИЗ ОДНОГО ПРЕДЛОЖЕНИЯ
# ============================================================================

def analyze_sentence(sentence: str) -> Dict[str, Any]:
    """
    Анализирует одно предложение по всем метрикам.
    Возвращает словарь с метриками и штрафами.
    """
    words = tokenize_sentence(sentence)
    word_count = len(words)
    comma_count = count_commas(sentence)

    nouns = [w for w in words if is_noun(w)]
    verbs = [w for w in words if is_verb(w)]
    noun_count = len(nouns)
    verb_count = len(verbs)

    # 1. Соотношение существительных к глаголам
    ratio_penalty = 0
    if verb_count > 0:
        ratio = noun_count / verb_count
        if ratio > 4:
            ratio_penalty = 20
        elif ratio > 3:
            ratio_penalty = 10

    # 2. Цепочка родительных падежей
    gen_chain = find_genitive_chain(sentence)
    chain_len = len(gen_chain)
    gen_penalty = (chain_len - 2) * 15 if chain_len > 2 else 0

    # 3. Длина предложения
    length_penalty = (word_count - 25) * 5 if word_count > 25 else 0

    # 4. Запятые (обороты)
    comma_penalty = (comma_count - 2) * 10 if comma_count > 2 else 0

    # 5. Страдательный залог
    passive_penalty = 10 if detect_passive_voice(sentence) else 0

    # 6. Канцелярские маркеры
    lower_sent = sentence.lower()
    found_markers = [m for m in BUREAUCRATIC_MARKERS if m in lower_sent]
    bureau_penalty = len(found_markers) * 5

    # 7. Слова-усилители
    amplifier_count = count_amplifiers(sentence)
    amplifier_penalty = amplifier_count * 5

    # 8. Пустые вводные конструкции
    intro_count = count_empty_intro(sentence)
    intro_penalty = intro_count * 5

    # Итоговый штраф
    total_penalty = (
        ratio_penalty +
        gen_penalty +
        length_penalty +
        comma_penalty +
        passive_penalty +
        bureau_penalty +
        amplifier_penalty +
        intro_penalty
    )

    return {
        'sentence': sentence,
        'word_count': word_count,
        'comma_count': comma_count,
        'noun_count': noun_count,
        'verb_count': verb_count,
        'genitive_chain': gen_chain,
        'has_passive': passive_penalty > 0,
        'bureaucratic_markers_found': found_markers,
        'amplifier_count': amplifier_count,
        'intro_count': intro_count,
        'ratio_penalty': ratio_penalty,
        'gen_penalty': gen_penalty,
        'length_penalty': length_penalty,
        'comma_penalty': comma_penalty,
        'passive_penalty': passive_penalty,
        'bureau_penalty': bureau_penalty,
        'amplifier_penalty': amplifier_penalty,
        'intro_penalty': intro_penalty,
        'total_penalty': total_penalty,
    }

# ============================================================================
# АНАЛИЗ ВСЕГО ТЕКСТА
# ============================================================================

def analyze_text(text: str) -> Dict[str, Any]:
    """
    Точка входа модуля.
    Принимает текст, возвращает словарь с полной статистикой.
    """
    sentences = split_sentences(text)
    if not sentences:
        return {'error': 'Текст пуст или не содержит предложений.'}

    results = []
    total_penalty = 0
    for sent in sentences:
        if sent.strip():
            r = analyze_sentence(sent)
            results.append(r)
            total_penalty += r['total_penalty']

    avg_penalty = total_penalty / len(results) if results else 0

    # Определение уровня (единая шкала с промтом)
    if avg_penalty < 30:
        level = "Зелёный (хорошо)"
        recommendation = "Текст читается легко, можно подписывать."
    elif avg_penalty < 60:
        level = "Жёлтый (средне)"
        recommendation = "Синтаксис перегружен, рекомендуется упростить."
    else:
        level = "Красный (тяжело)"
        recommendation = "Канцелярит! Требуется полная переработка."

    # Сбор агрегированной статистики
    total_words = sum(r['word_count'] for r in results)
    total_nouns = sum(r['noun_count'] for r in results)
    total_verbs = sum(r['verb_count'] for r in results)
    overall_ratio = total_nouns / total_verbs if total_verbs > 0 else float('inf')
    avg_word_count = total_words / len(results) if results else 0
    avg_comma_count = sum(r['comma_count'] for r in results) / len(results) if results else 0

    # Самая длинная цепочка родительных падежей
    max_gen_chain = max((r['genitive_chain'] for r in results), key=len, default=[])
    max_gen_len = len(max_gen_chain)

    # Суммарные показатели
    total_bureau = sum(len(r['bureaucratic_markers_found']) for r in results)
    total_amplifiers = sum(r['amplifier_count'] for r in results)
    total_intros = sum(r['intro_count'] for r in results)
    passive_count = sum(1 for r in results if r['has_passive'])

    # Формирование причин уровня
    reasons = []
    if avg_penalty >= 60:
        reasons.append(f"Средний индекс тяжести {avg_penalty:.1f} превышает порог 60")
    elif avg_penalty >= 30:
        reasons.append(f"Средний индекс тяжести {avg_penalty:.1f} — верхняя граница Зелёного")
    if overall_ratio > 4:
        reasons.append(f"Соотношение существительных к глаголам {overall_ratio:.2f} > 4 (избыток существительных)")
    elif overall_ratio > 3:
        reasons.append(f"Соотношение существительных к глаголам {overall_ratio:.2f} > 3")
    if max_gen_len > 3:
        reasons.append(f"Цепочка родительного падежа из {max_gen_len} слов: {', '.join(max_gen_chain)} (норма ? 2)")
    if avg_word_count > 25:
        reasons.append(f"Средняя длина предложения {avg_word_count:.1f} слов > 25")
    if avg_comma_count > 2:
        reasons.append(f"Среднее количество запятых {avg_comma_count:.1f} > 2 (перегруженность оборотами)")
    if total_bureau > 3:
        reasons.append(f"Обнаружено {total_bureau} бюрократических маркеров")
    if total_amplifiers > 2:
        reasons.append(f"Обнаружено {total_amplifiers} слов-усилителей")
    if total_intros > 1:
        reasons.append(f"Обнаружено {total_intros} пустых вводных конструкций")
    if passive_count > 0:
        reasons.append(f"В {passive_count} предложениях есть страдательный залог")
    if not reasons:
        reasons.append("Все показатели в норме")

    return {
        'text': text,
        'sentence_count': len(results),
        'total_words': total_words,
        'average_penalty': avg_penalty,
        'level': level,
        'recommendation': recommendation,
        'details': results,
        'overall_noun_verb_ratio': overall_ratio,
        'longest_genitive_chain': max_gen_chain,
        'bureaucratic_markers_total': total_bureau,
        'amplifier_total': total_amplifiers,
        'intro_total': total_intros,
        'reasons': reasons,
        'avg_word_count': avg_word_count,
        'avg_comma_count': avg_comma_count,
        'passive_count': passive_count,
    }

# ============================================================================
# ВЫВОД ОТЧЁТА
# ============================================================================

def print_report(analysis: Dict[str, Any]) -> None:
    """Выводит отчёт анализа в читаемом виде."""
    if 'error' in analysis:
        print("Ошибка:", analysis['error'])
        return

    print("=" * 60)
    print("АНАЛИЗ ЧИТАЕМОСТИ ТЕКСТА (АУДИТОРСКИЙ АКТ)")
    print("=" * 60)
    print(f"Количество предложений: {analysis['sentence_count']}")
    print(f"Общее количество слов:    {analysis['total_words']}")
    print(f"Средний индекс тяжести:   {analysis['average_penalty']:.1f}")
    print(f"Уровень сложности:        {analysis['level']}")
    print(f"Рекомендация:             {analysis['recommendation']}")

    if analysis.get('reasons'):
        print("\nПричины присвоения уровня:")
        for reason in analysis['reasons']:
            print(f"  • {reason}")

    print(f"\nДополнительная статистика:")
    print(f"  • Соотношение сущ./глаг.:       {analysis['overall_noun_verb_ratio']:.2f}")
    print(f"  • Средняя длина предложения:    {analysis.get('avg_word_count', 0):.1f} слов")
    print(f"  • Среднее число запятых:        {analysis.get('avg_comma_count', 0):.1f}")
    chain_str = ', '.join(analysis['longest_genitive_chain']) if analysis['longest_genitive_chain'] else 'нет'
    print(f"  • Самая длинная цепочка Р.п.:   {chain_str}")
    print(f"  • Бюрократических маркеров:     {analysis['bureaucratic_markers_total']}")
    print(f"  • Слов-усилителей:              {analysis.get('amplifier_total', 0)}")
    print(f"  • Пустых вводных:               {analysis.get('intro_total', 0)}")
    print(f"  • Предложений с пассивом:       {analysis.get('passive_count', 0)}")

# ============================================================================
# ТОЧКА ВХОДА ДЛЯ АВТОНОМНОГО ЗАПУСКА
# ============================================================================

#if __name__ == "__main__":
    # Тестовый пример
#    test_text = """
#    В ходе проведения проверки соблюдения порядка ведения учёта объектов основных средств,
#    аудиторами было установлено, что в нарушение требований пункта 4.2 ПБУ 6/01
#    не было обеспечено надлежащее оформление первичных учетных документов по причине
#    отсутствия подписей членов комиссии в актах о приеме-передаче объектов основных средств
#    по форме ОС-1 №245 от 14.03.2024 и №301 от 05.04.2024 на общую сумму 1 250 000 рублей,
#    что является существенным нарушением.
#    """

#    result = analyze_text(test_text)
#    print_report(result)
    
    # ============================================================================
# ТОЧКА ВХОДА ДЛЯ АВТОНОМНОГО ЗАПУСКА
# ============================================================================

#if __name__ == "__main__":
    # Тестовый пример
#    test_text = """
#    В ходе проведения проверки соблюдения порядка ведения учёта объектов основных средств,
#    аудиторами было установлено, что в нарушение требований пункта 4.2 ПБУ 6/01
#    не было обеспечено надлежащее оформление первичных учетных документов по причине
#   отсутствия подписей членов комиссии в актах о приеме-передаче объектов основных средств
#   по форме ОС-1 №245 от 14.03.2024 и №301 от 05.04.2024 на общую сумму 1 250 000 рублей,
#    что является существенным нарушением.
#    """

#    result = analyze_text(test_text)
#    print_report(result)
