/**
 * Тесты адаптеров формализатора: запись (Task 1.4.2) и чтение (Task 1.4.3).
 *
 * Запись: `_applyFormalized` переводит ПЛОСКИЕ строки LLM в rich HTML перед
 * записью в модель — экранирует спецсимволы и переносы `\n` → `<br>` (зеркало
 * `_insertCorrected` в corrector-popover.js). Без адаптера `\n` не отрисовался
 * бы, а `&`/`<` в тексте LLM стали бы невалидным содержимым rich-поля.
 *
 * Единственная точка записи в модель — setViolationField (подменяется
 * шпионом); DOM-контролы карточки здесь не нужны (пустой `controls`),
 * поэтому проверяется именно запись в модель, без побочных DOM-эффектов.
 *
 * Чтение: `_gatherSource` прогоняет каждое поле карточки (rich HTML) через
 * `_richToPlain` перед сборкой — иначе LLM увидела бы HTML-теги вместо
 * текста. `_richToPlain` — overridable тест-шов; ниже проверяются (а) сам
 * факт прогона каждого поля через метод (подмена-обёртка) и (б) страйп
 * caret-guard (U+FEFF) реальной реализацией. Настоящий DOM-парсинг
 * HTML-строки (innerHTML) недоступен под node-стабом, поэтому (б) подставляет
 * document.createElement, возвращающий готовые childNodes — как если бы
 * разбор строки уже случился. Разбор настоящих HTML-строк — в Playwright
 * (Task 1.6.3).
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Входная точка графа нарушений — как в entries/constructor.js: violation-init
// мешает rich-хелперы в прототип ViolationManager (см. violation-rich-fields.test.mjs).
import '../../static/js/constructor/violation/violation-init.js';
import { ViolationManager } from '../../static/js/constructor/violation/violation-core.js';
import { FormalizerPopover } from '../../static/js/constructor/text-actions/formalizer-popover.js';

test('_applyFormalized: escaped HTML с <br>, пустое не пишется', () => {
    const vm = new ViolationManager();
    const calls = [];
    vm.setViolationField = (v, p, val) => { calls.push([p, val]); return true; };
    vm._applyFormalized({ id: 'v1', reasons: { enabled: false, content: '' } }, {}, {
        violated: 'Ромашка & Ко\nстрока2', established: '', reasons: 'причина',
    });
    const m = Object.fromEntries(calls);
    assert.equal(m['violated'], 'Ромашка &amp; Ко<br>строка2');
    assert.ok(!('established' in m));
    assert.equal(m['reasons.enabled'], true);
    assert.equal(m['reasons.content'], 'причина');
});

// --- _gatherSource / _richToPlain: адаптер чтения (Task 1.4.3) ---

test('_gatherSource: прогоняет каждое читаемое поле через _richToPlain', () => {
    const original = FormalizerPopover._richToPlain;
    FormalizerPopover._richToPlain = (html) => 'PLAIN[' + html + ']';
    try {
        const violation = {
            violated: 'Нарушено', established: 'Установлено',
            reasons: { enabled: true, content: 'Причины' },
            measures: { enabled: false, content: 'скрыто' },
            consequences: { enabled: true, content: 'Последствия' },
            responsible: { enabled: true, content: 'Иванов' },
        };
        assert.equal(
            FormalizerPopover._gatherSource(violation),
            'PLAIN[Нарушено]\n\nPLAIN[Установлено]\n\nPLAIN[Причины]\n\nPLAIN[Последствия]\n\nPLAIN[Иванов]',
        );
    } finally {
        FormalizerPopover._richToPlain = original;
    }
});

test('_richToPlain: снимает caret-guard (U+FEFF) из сериализованного текста', () => {
    const feff = '\uFEFF';
    // Стаб document.createElement не парсит innerHTML в childNodes (см.
    // _browser-stub.mjs) — подставляем childNodes напрямую, как будто разбор
    // строки уже случился и капсула оставила guard-символы в текстовом узле.
    const fakeTmp = { childNodes: [{ nodeType: 3, textContent: `${feff}текст${feff}` }] };
    const origCreate = globalThis.document.createElement;
    globalThis.document.createElement = () => fakeTmp;
    try {
        const result = FormalizerPopover._richToPlain('<span>любая строка</span>');
        assert.equal(result, 'текст');
        assert.ok(!result.includes(feff));
    } finally {
        globalThis.document.createElement = origCreate;
    }
});
