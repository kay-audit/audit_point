/**
 * Пункт 3 (#14a): `_richToPlain` санитизирует HTML-строку поля профилем 'acts'
 * ДО присваивания в innerHTML временного узла. Сырой innerHTML в detached-узле
 * Chromium фетчит src-ресурсы (img и пр.), а on*-атрибуты дают mXSS-вектор.
 *
 * DOMPurify в node без DOM не поднимается — фейк ниже фиксирует КОНТРАКТ (что
 * долетает до sanitize и что кладётся в innerHTML), как в
 * sanitize-render-act-content.test.mjs.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FormalizerPopover } from '../../static/js/constructor/text-actions/formalizer-popover.js';
import { SAFE_HTML_PROFILES } from '../../static/js/shared/sanitize.js';

test('пункт3: _richToPlain прогоняет html через DOMPurify (профиль acts) до присваивания в innerHTML', () => {
    const calls = [];
    const assigned = [];
    // Фейковый tmp: innerHTML-сеттер записывает присвоенное; childNodes пуст,
    // чтобы serializeVisibleText не падал (возврат метода в этом тесте не важен).
    const fakeTmp = {
        childNodes: [],
        set innerHTML(v) { assigned.push(v); },
        get innerHTML() { return assigned.length ? assigned[assigned.length - 1] : ''; },
    };
    const origCreate = globalThis.document.createElement;
    const origDP = globalThis.window.DOMPurify;
    globalThis.document.createElement = () => fakeTmp;
    globalThis.window.DOMPurify = {
        sanitize: (html, cfg) => {
            calls.push({ html, cfg });
            // Фейк профиля 'acts': <img> нет в ALLOWED_TAGS — вырезаем его целиком.
            return String(html).replace(/<img\b[^>]*>/gi, '');
        },
    };
    try {
        FormalizerPopover._richToPlain('<img src="http://evil.example/pixel.gif" onerror="alert(1)">видимый');

        assert.equal(calls.length, 1, 'html прошёл через DOMPurify ровно раз');
        assert.equal(calls[0].cfg, SAFE_HTML_PROFILES.acts, 'санитизация профилем acts');
        assert.ok(calls[0].html.includes('<img'), 'на вход санитайзеру ушёл исходный html с img');
        assert.equal(assigned.length, 1, 'в innerHTML присвоено ровно раз');
        assert.ok(!assigned[0].includes('<img'), 'в innerHTML попал санитизированный html без img');
        assert.ok(!assigned[0].includes('onerror'), 'on*-вектор вырезан до присваивания');
    } finally {
        globalThis.document.createElement = origCreate;
        globalThis.window.DOMPurify = origDP;
    }
});
