/**
 * Смоук панели-корректора: цепочка импортов резолвится под браузер-стабом,
 * объект экспортирован с ключевыми методами и в window. Отдельно проверяется
 * чистая логика гейта устаревшего текста (_textChanged) без DOM.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CorrectorPopover } from '../../static/js/constructor/text-actions/corrector-popover.js';

test('CorrectorPopover: ключевые методы существуют', () => {
    for (const m of ['open', 'close', '_accept', '_textChanged', '_rangeText', '_serializeWithBreaks', '_setMode', '_request']) {
        assert.equal(typeof CorrectorPopover[m], 'function', 'нет метода ' + m);
    }
});

// Фейковые DOM-узлы для проверки чистой сериализации без реального DOM.
const el = (tag, children) => ({ nodeType: 1, tagName: tag, childNodes: children || [] });
const txt = (t) => ({ nodeType: 3, textContent: t });

test('_serializeWithBreaks: границы блочных элементов дают перевод строки', () => {
    // Две Enter-строки в редакторе = два нативных <div>.
    const root = el('DIV', [el('DIV', [txt('a')]), el('DIV', [txt('b')])]);
    assert.equal(CorrectorPopover._serializeWithBreaks(root), 'a\nb\n');
});

test('_serializeWithBreaks: <br> даёт перевод строки, инлайн-узлы — нет', () => {
    const root = el('DIV', [txt('a'), el('BR'), txt('b')]);
    assert.equal(CorrectorPopover._serializeWithBreaks(root), 'a\nb');
    const inline = el('DIV', [txt('до '), el('SPAN', [txt('ссылка')]), txt(' после')]);
    assert.equal(CorrectorPopover._serializeWithBreaks(inline), 'до ссылка после');
});

test('_textChanged: выделение через две Enter-строки без правок — не изменение', () => {
    // Пункт 3: исходный (Selection.toString) = 'a\nb'; текущий,
    // реконструированный через границы блоков, = 'a\nb\n' → хвост \n отбрасывается.
    const root = el('DIV', [el('DIV', [txt('a')]), el('DIV', [txt('b')])]);
    const current = CorrectorPopover._serializeWithBreaks(root);
    assert.equal(CorrectorPopover._textChanged('a\nb', current), false);
});

test('_textChanged: убранный перенос между строками — реальная правка', () => {
    // Пользователь склеил две строки в одну — детекция не должна ослабнуть.
    const root = el('DIV', [el('DIV', [txt('ab')])]);
    const current = CorrectorPopover._serializeWithBreaks(root);
    assert.equal(CorrectorPopover._textChanged('a\nb', current), true);
});

test('_setMode: повтор клика по тому же режиму после ошибки повторяет запрос', () => {
    // Пункт 7: после провала _request флаг _lastError=true, и повторный клик
    // по уже активной кнопке должен снова дёрнуть _request.
    const calls = [];
    const orig = CorrectorPopover._request;
    CorrectorPopover._request = function () { calls.push(this._mode); };
    try {
        CorrectorPopover._els = null; // _syncModeButtons ранний выход
        CorrectorPopover._mode = null;
        CorrectorPopover._hasRequested = false;
        CorrectorPopover._lastError = false;

        CorrectorPopover._setMode('fix');           // первый запуск
        assert.equal(calls.length, 1);

        CorrectorPopover._hasRequested = true;       // имитируем «запрос был»
        CorrectorPopover._lastError = false;
        CorrectorPopover._setMode('fix');            // успех → повтор не нужен
        assert.equal(calls.length, 1);

        CorrectorPopover._lastError = true;          // имитируем ошибку
        CorrectorPopover._setMode('fix');            // тот же режим → повтор
        assert.equal(calls.length, 2);
    } finally {
        CorrectorPopover._request = orig;
    }
});

test('CorrectorPopover: экспортирован в window', () => {
    assert.equal(typeof window.CorrectorPopover, 'object');
});

test('_textChanged: идентичный текст — без изменений', () => {
    assert.equal(CorrectorPopover._textChanged('Привет мир', 'Привет мир'), false);
});

test('_textChanged: хвостовой перевод строки не считается изменением', () => {
    assert.equal(CorrectorPopover._textChanged('строка\n', 'строка'), false);
    assert.equal(CorrectorPopover._textChanged('a\nb', 'a\nb'), false);
});

test('_textChanged: прогоны пробелов схлопываются (white-space:normal)', () => {
    assert.equal(CorrectorPopover._textChanged('слово  слово', 'слово слово'), false);
    assert.equal(CorrectorPopover._textChanged('слово слово', 'слово  слово'), false);
});

test('_textChanged: реальная правка слова — изменение', () => {
    assert.equal(CorrectorPopover._textChanged('Привет мир', 'Пока мир'), true);
});

test('_textChanged: недоступный диапазон (null) — считаем изменением', () => {
    assert.equal(CorrectorPopover._textChanged('текст', null), true);
});

// --- Светофор диагностики читаемости (анализатор D17) -----------------------

// Узел с достаточным API: браузер-стаб отдаёт no-op элементы, а здесь нужно
// видеть реально собранное содержимое и состояние classList.
function trackedNode() {
    const node = {
        className: '',
        textContent: '',
        children: [],
        classes: new Set(),
        classList: {
            add: (c) => node.classes.add(c),
            remove: (c) => node.classes.delete(c),
            contains: (c) => node.classes.has(c),
        },
        append: (...kids) => node.children.push(...kids),
        appendChild: (kid) => node.children.push(kid),
    };
    return node;
}

function withDom(fn) {
    const origCreate = document.createElement;
    document.createElement = () => trackedNode();
    try { return fn(); } finally { document.createElement = origCreate; }
}

// Плоский текст собранного поддерева — для проверки содержимого светофора.
function flatText(node) {
    return [node.textContent, ...node.children.map(flatText)].join(' ').trim();
}

const _metrics = (level, penalty, extra = {}) => ({
    level, average_penalty: penalty,
    noun_verb_ratio: 2, longest_genitive_chain: [], avg_word_count: 10,
    bureaucratic_markers_total: 0, ...extra,
});

function renderInto(mode, readability) {
    const box = trackedNode();
    const prev = { els: CorrectorPopover._els, mode: CorrectorPopover._mode,
        r: CorrectorPopover._readability };
    CorrectorPopover._els = { readability: box };
    CorrectorPopover._mode = mode;
    CorrectorPopover._readability = readability;
    try {
        withDom(() => CorrectorPopover._renderReadability());
    } finally {
        CorrectorPopover._els = prev.els;
        CorrectorPopover._mode = prev.mode;
        CorrectorPopover._readability = prev.r;
    }
    return box;
}

test('_renderReadability: режим fix — блок скрыт даже с данными', () => {
    const box = renderInto('fix', {
        before: _metrics('Красный (тяжело)', 150),
        after: _metrics('Зелёный (хорошо)', 12),
    });
    assert.ok(box.classes.has('hidden'), 'блок должен быть скрыт в режиме fix');
});

test('_renderReadability: readability без данных — блок скрыт', () => {
    assert.ok(renderInto('readability', null).classes.has('hidden'));
});

test('_renderReadability: readability с данными — светофор «до → после»', () => {
    const box = renderInto('readability', {
        before: _metrics('Красный (тяжело)', 150),
        after: _metrics('Зелёный (хорошо)', 12),
    });
    assert.equal(box.classes.has('hidden'), false, 'блок должен быть показан');
    const text = flatText(box);
    assert.match(text, /Красный \(тяжело\) 150/);
    assert.match(text, /→/);
    assert.match(text, /Зелёный \(хорошо\) 12/);
});

test('_renderReadability: дельты только по изменившимся метрикам', () => {
    const box = renderInto('readability', {
        before: _metrics('Красный (тяжело)', 150, {
            noun_verb_ratio: 8, bureaucratic_markers_total: 3, avg_word_count: 34,
        }),
        after: _metrics('Зелёный (хорошо)', 12, {
            noun_verb_ratio: 1.5, bureaucratic_markers_total: 3, avg_word_count: 9,
        }),
    });
    const text = flatText(box);
    assert.match(text, /сущ\.\/глаг\. 8→1\.5/);
    assert.match(text, /слов в предл\. 34→9/);
    // Не изменилось — в дельтах не показываем.
    assert.equal(/канцеляризмы/.test(text), false);
});

test('_renderReadability: noun_verb_ratio=null не попадает в дельты', () => {
    const box = renderInto('readability', {
        before: _metrics('Жёлтый (средне)', 40, { noun_verb_ratio: null }),
        after: _metrics('Зелёный (хорошо)', 10, { noun_verb_ratio: 2 }),
    });
    assert.equal(/сущ\.\/глаг\./.test(flatText(box)), false);
});
