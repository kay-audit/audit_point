/**
 * Страж конфигурации SafeHTML-профилей (5.2.3 + M.19).
 *
 * Профиль 'acts' — allowlist, зеркальный бэк-whitelist
 * app/domains/acts/utils/html_sanitizer.py: проверяем состав тегов
 * (включая s/strike/del) и атрибутов (data-* ссылок/сносок), отсутствие
 * опасных тегов и on*-обработчиков. Поведенческая проверка самого DOMPurify
 * в node невозможна (нужен DOM) — она покрыта fallback-веткой (textContent)
 * и e2e. Здесь фиксируем контракт конфига.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    SafeHTML, SAFE_HTML_PROFILES, ACTS_CSS_PROPERTIES, filterCssDeclarations,
} from '../../static/js/shared/sanitize.js';

const acts = SAFE_HTML_PROFILES.acts;

test('acts-профиль существует и является allowlist (ALLOWED_TAGS/ALLOWED_ATTR)', () => {
    assert.ok(acts, 'профиль acts отсутствует');
    assert.ok(Array.isArray(acts.ALLOWED_TAGS), 'нет ALLOWED_TAGS');
    assert.ok(Array.isArray(acts.ALLOWED_ATTR), 'нет ALLOWED_ATTR');
    assert.equal(acts.FORBID_TAGS, undefined, 'allowlist не должен опираться на FORBID_TAGS');
});

test('acts: M.19-теги зачёркивания в whitelist', () => {
    for (const tag of ['s', 'strike', 'del']) {
        assert.ok(acts.ALLOWED_TAGS.includes(tag), `нет тега <${tag}>`);
    }
});

test('acts: состав тегов зеркалит бэк-whitelist html_sanitizer.py', () => {
    const backendTags = [
        'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del',
        'span', 'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div',
    ];
    assert.deepEqual([...acts.ALLOWED_TAGS].sort(), [...backendTags].sort());
});

test('acts: опасные теги не входят в whitelist', () => {
    for (const tag of ['script', 'iframe', 'svg', 'object', 'embed', 'form', 'style']) {
        assert.ok(!acts.ALLOWED_TAGS.includes(tag), `опасный тег <${tag}> в whitelist`);
    }
});

test('acts: data-атрибуты ссылок и сносок сохранены', () => {
    for (const attr of [
        'data-link-id', 'data-link-url', 'data-footnote-id', 'data-footnote-text',
        'href', 'title', 'class', 'style',
    ]) {
        assert.ok(acts.ALLOWED_ATTR.includes(attr), `нет атрибута ${attr}`);
    }
});

test('acts: ни одного on*-обработчика в ALLOWED_ATTR', () => {
    assert.ok(acts.ALLOWED_ATTR.every((a) => !/^on/i.test(a)));
});

test('acts: CSS-allowlist зеркалит бэк ALLOWED_CSS_PROPERTIES (#10/#14)', () => {
    const backendCss = [
        'font-size', 'color', 'background-color',
        'font-weight', 'font-style', 'text-decoration', 'text-decoration-line',
        'text-align',
    ];
    assert.deepEqual([...ACTS_CSS_PROPERTIES].sort(), [...backendCss].sort());
    // Профиль несёт allowlist для хука фильтрации inline-style.
    assert.deepEqual(acts.__cssAllowlist, ACTS_CSS_PROPERTIES);
    // text-decoration-line обязателен — иначе зачёркивание из внешнего контента
    // срезалось бы и расходилось бы между превью и экспортом.
    assert.ok(ACTS_CSS_PROPERTIES.includes('text-decoration-line'));
    // TB-1: text-align обязателен — иначе per-line выравнивание блочных
    // элементов (execCommand justify*) пропадало бы в превью и после reload.
    assert.ok(ACTS_CSS_PROPERTIES.includes('text-align'));
});

test('per-tag политика style: div/p — text-align, li — ещё и font-size, span — полный allowlist', () => {
    const css = [...ACTS_CSS_PROPERTIES];
    // div: чужие свойства режутся, остаётся один text-align.
    assert.deepEqual(
        filterCssDeclarations(
            'DIV',
            [['font-size', '40px'], ['color', 'red'], ['text-align', 'center']],
            css,
        ),
        ['text-align:center;'],
    );
    // Не-enum значения (inherit/start) срезают style целиком.
    assert.deepEqual(filterCssDeclarations('div', [['text-align', 'inherit']], css), []);
    assert.deepEqual(filterCssDeclarations('p', [['text-align', 'start']], css), []);
    // p — та же блочная политика, что div.
    assert.deepEqual(
        filterCssDeclarations('p', [['font-weight', 'bold'], ['text-align', 'right']], css),
        ['text-align:right;'],
    );
    // span: полный CSS-allowlist без изменений (font-size живёт, чужое — нет).
    assert.deepEqual(
        filterCssDeclarations('span', [['font-size', '20px'], ['position', 'fixed']], css),
        ['font-size:20px;'],
    );
    // li — блок с исключением: text-align И собственный font-size (от него
    // наследует ::marker), но не цвет. Зеркало _ITEM_STYLE_TAGS бэка.
    assert.deepEqual(
        filterCssDeclarations(
            'li',
            [['font-size', '18pt'], ['text-align', 'center'], ['color', 'red']],
            css,
        ).sort(),
        ['font-size:18pt;', 'text-align:center;'],   // порядок деклараций не значим
    );
    assert.deepEqual(filterCssDeclarations('li', [['color', 'red']], css), []);
});

test('fallback без DOMPurify: sanitize экранирует HTML (и для профиля acts)', () => {
    // В node-тестах window.DOMPurify отсутствует — рабочая ветка fallback.
    const out = SafeHTML.sanitize('<s>x</s><script>alert(1)</script>', 'acts');
    assert.ok(!out.includes('<script>'), 'сырой <script> прошёл в fallback');
    assert.ok(out.includes('&lt;script&gt;'), 'fallback не экранировал разметку');
});

test('escapeHtml экранирует все спецсимволы', () => {
    assert.equal(
        SafeHTML.escapeHtml(`<a href="x" onclick='y'>&`),
        '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;',
    );
});
