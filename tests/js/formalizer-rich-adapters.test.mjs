/**
 * Тесты адаптера ЧТЕНИЯ формализатора (Task 1.4.3).
 *
 * Адаптер записи (`_applyFormalized` — раскладка ответа по блочным полям и
 * перевод плоских строк в rich HTML) живёт в
 * formalizer-apply-surface.test.mjs.
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
import { FormalizerPopover } from '../../static/js/constructor/text-actions/formalizer-popover.js';

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
