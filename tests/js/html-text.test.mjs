/**
 * Пункт 4 (V25): plainToRichHtml вынесен в shared/html-text.js. Тест фиксирует
 * byte-в-byte поведение переноса: экранирование спецсимволов + `\n` → `<br>`.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainToRichHtml } from '../../static/js/shared/html-text.js';

test('plainToRichHtml: экранирует & < > и переводит \\n в <br>', () => {
    assert.equal(plainToRichHtml('Ромашка & Ко\nстрока2'), 'Ромашка &amp; Ко<br>строка2');
});

test('plainToRichHtml: экранирует кавычки', () => {
    assert.equal(plainToRichHtml('"a" \'b\''), '&quot;a&quot; &#39;b&#39;');
});

test('plainToRichHtml: несколько переносов → несколько <br>', () => {
    assert.equal(plainToRichHtml('a\nb\nc'), 'a<br>b<br>c');
});

test('plainToRichHtml: пустое/null → пустая строка', () => {
    assert.equal(plainToRichHtml(''), '');
    assert.equal(plainToRichHtml(null), '');
    assert.equal(plainToRichHtml(undefined), '');
});
