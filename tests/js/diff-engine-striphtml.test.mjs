/**
 * V8 (code review): _stripHtml заменял ЛЮБОЙ тег на пробел, поэтому
 * внутрисловное форматирование (сло<b>во</b>) стриплось в «сло во» —
 * сравнение с «слово» давало ложный текст-дифф, хотя изменилась только
 * разметка. Теперь инлайновые теги форматирования (b/i/u/s/em/strong/span/a/
 * sub/sup/code/strike/del) не создают границу слова; блочные теги и <br>
 * (перенос строки/абзаца) — остаются границей, как и раньше.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiffEngine } from '../../static/js/portal/acts-manager/diff-engine.js';

function diffOne(oldC, newC) {
    return DiffEngine._diffTextBlocks({ tb: { content: oldC } }, { tb: { content: newC } }).tb;
}

// --- юнит: _stripHtml --------------------------------------------------------

test('_stripHtml: внутрисловный инлайн-тег не создаёт пробел', () => {
    assert.equal(DiffEngine._stripHtml('сло<b>во</b>'), 'слово');
    assert.equal(DiffEngine._stripHtml('сло<i>во</i>'), 'слово');
    assert.equal(DiffEngine._stripHtml('сло<u>во</u>'), 'слово');
    assert.equal(DiffEngine._stripHtml('сло<s>во</s>'), 'слово');
    assert.equal(DiffEngine._stripHtml('сло<em>во</em>'), 'слово');
    assert.equal(DiffEngine._stripHtml('сло<strong>во</strong>'), 'слово');
    assert.equal(DiffEngine._stripHtml('сло<span class="x">во</span>'), 'слово');
    assert.equal(DiffEngine._stripHtml('сло<a href="#">во</a>'), 'слово');
    assert.equal(DiffEngine._stripHtml('X<sub>2</sub>'), 'X2');
    assert.equal(DiffEngine._stripHtml('X<sup>2</sup>'), 'X2');
    assert.equal(DiffEngine._stripHtml('сло<code>во</code>'), 'слово');
});

test('_stripHtml: <br> остаётся границей слов (перенос строки)', () => {
    assert.equal(DiffEngine._stripHtml('до<br>после'), 'до после');
    assert.equal(DiffEngine._stripHtml('до<br/>после'), 'до после');
    assert.equal(DiffEngine._stripHtml('до<br />после'), 'до после');
});

test('_stripHtml: границы блочных тегов остаются границей слов (</div><div>, </p><p>)', () => {
    assert.equal(DiffEngine._stripHtml('<div>текст1</div><div>текст2</div>'), 'текст1 текст2');
    assert.equal(DiffEngine._stripHtml('<p>текст1</p><p>текст2</p>'), 'текст1 текст2');
    assert.equal(DiffEngine._stripHtml('<li>текст1</li><li>текст2</li>'), 'текст1 текст2');
});

test('_stripHtml: смешанный случай — блочная граница + внутрисловный инлайн-тег', () => {
    assert.equal(DiffEngine._stripHtml('<div>сло<b>во</b>1</div><div>текст2</div>'), 'слово1 текст2');
});

// --- интеграция: word-diff / formattingOnly через _diffTextBlocks ----------

test('внутрисловное форматирование (сло<b>во</b> vs слово) → formattingOnly=true, НЕ текст-дифф', () => {
    const d = diffOne('сло<b>во</b>', 'слово');
    assert.equal(d.status, 'modified');
    assert.equal(d.formattingOnly, true);
    assert.ok(d.wordDiff.every(p => p.type === 'equal'), 'word-diff не должен содержать вставок/удалений');
});

test('<br>-граница слов: до<br>после vs допосле → текст-дифф ЕСТЬ (formattingOnly=false)', () => {
    const d = diffOne('до<br>после', 'допосле');
    assert.equal(d.status, 'modified');
    assert.equal(d.formattingOnly, false);
    assert.ok(d.wordDiff.some(p => p.type !== 'equal'), 'br — граница слов, должен остаться текст-дифф');
});
