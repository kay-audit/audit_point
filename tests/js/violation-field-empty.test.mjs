/**
 * Тесты единого предиката пустоты rich-полей нарушения (#12, V24,
 * violation-field-empty.js) — чистые функции, без DOM/санитайзера.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFieldEmpty, toggleEmptyClass } from '../../static/js/constructor/violation/violation-field-empty.js';

// --- isFieldEmpty: строковый случай (сырое значение модели) ------------------

test('isFieldEmpty: пустая строка/null/undefined — пусто', () => {
    assert.equal(isFieldEmpty(''), true);
    assert.equal(isFieldEmpty(null), true);
    assert.equal(isFieldEmpty(undefined), true);
});

test('isFieldEmpty: только пробелы — пусто', () => {
    assert.equal(isFieldEmpty('   '), true);
});

test('isFieldEmpty: \'<br>\' — пусто (легаси-остаток очищенного contenteditable)', () => {
    assert.equal(isFieldEmpty('<br>'), true);
});

test('isFieldEmpty: \'<div><br></div>\' — пусто', () => {
    assert.equal(isFieldEmpty('<div><br></div>'), true);
});

test('isFieldEmpty: непустой текст — не пусто', () => {
    assert.equal(isFieldEmpty('текст'), false);
});

// --- F2/Пункт 2: строковая ветка декодирует &nbsp; перед проверкой пустоты
// (паритет с DOM-веткой, где браузер decode'ит entity в textContent ДО trim,
// и с бэкенд-валидацией clean_html, которая тот же ввод считает пустым) -----

test('isFieldEmpty: \'&nbsp;\' — пусто (decode перед проверкой)', () => {
    assert.equal(isFieldEmpty('&nbsp;'), true);
});

test('isFieldEmpty: \'<div>&nbsp;</div>\' — пусто', () => {
    assert.equal(isFieldEmpty('<div>&nbsp;</div>'), true);
});

test('isFieldEmpty: несколько &nbsp; подряд/с пробелами — пусто', () => {
    assert.equal(isFieldEmpty('&nbsp;&nbsp; &nbsp;'), true);
});

test('isFieldEmpty: числовые формы &#160;/&#xa0; — тоже пусто', () => {
    assert.equal(isFieldEmpty('&#160;'), true);
    assert.equal(isFieldEmpty('&#xa0;'), true);
    assert.equal(isFieldEmpty('&#xA0;'), true);
});

test('isFieldEmpty: nbsp вперемешку с реальным текстом — не пусто', () => {
    assert.equal(isFieldEmpty('&nbsp;текст&nbsp;'), false);
});

test('isFieldEmpty: теги без текста (\'<b></b>\') — пусто', () => {
    assert.equal(isFieldEmpty('<b></b>'), true);
});

test('isFieldEmpty: <img> без текста — НЕ пусто (значимый inline-элемент)', () => {
    assert.equal(isFieldEmpty('<img src="x.png">'), false);
});

test('isFieldEmpty: капсула-ссылка без видимого текста — НЕ пусто', () => {
    assert.equal(isFieldEmpty('<span class="text-link" data-link-url="/x"></span>'), false);
});

test('isFieldEmpty: капсула-сноска без видимого текста — НЕ пусто', () => {
    assert.equal(isFieldEmpty('<span class="text-footnote" data-footnote-text="прим."></span>'), false);
});

// --- isFieldEmpty: DOM-случай (живой элемент, формула _toggleEmptyClass) -----

test('isFieldEmpty: элемент с пустым textContent и без inline-элементов — пусто', () => {
    const el = { textContent: '', querySelector: () => null };
    assert.equal(isFieldEmpty(el), true);
});

test('isFieldEmpty: элемент с непустым textContent — не пусто', () => {
    const el = { textContent: 'текст', querySelector: () => null };
    assert.equal(isFieldEmpty(el), false);
});

test('isFieldEmpty: элемент с textContent из одних caret-guard/якорь-символов — пусто', () => {
    const guard = String.fromCharCode(0xFEFF);
    const anchor = String.fromCharCode(0x200B);
    const el = { textContent: `${guard}${anchor}`, querySelector: () => null };
    assert.equal(isFieldEmpty(el), true);
});

test('isFieldEmpty: элемент без видимого текста, но с querySelector-совпадением (капсула/картинка) — не пусто', () => {
    const el = { textContent: '', querySelector: () => ({}) };
    assert.equal(isFieldEmpty(el), false);
});

test('isFieldEmpty: элемент без querySelector (минимальный фейк) — не роняет проверку', () => {
    const el = { textContent: 'x' };
    assert.equal(isFieldEmpty(el), false);
    const empty = { textContent: '' };
    assert.equal(isFieldEmpty(empty), true);
});

// --- toggleEmptyClass -----------------------------------------------------

test('toggleEmptyClass: пустой source → classList.toggle(className, true)', () => {
    const calls = [];
    const target = { classList: { toggle: (c, v) => calls.push({ c, v }) } };
    toggleEmptyClass(target, 'my--empty', '');
    assert.deepEqual(calls, [{ c: 'my--empty', v: true }]);
});

test('toggleEmptyClass: непустой source → classList.toggle(className, false)', () => {
    const calls = [];
    const target = { classList: { toggle: (c, v) => calls.push({ c, v }) } };
    toggleEmptyClass(target, 'my--empty', 'текст');
    assert.deepEqual(calls, [{ c: 'my--empty', v: false }]);
});
