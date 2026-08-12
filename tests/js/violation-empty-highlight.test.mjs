/**
 * Не блокирующая подсветка пустых текст-блоков нарушения (#9-Г, Wave 2).
 *
 * Только визуальный класс + toggle на input — данные/сериализация не
 * затрагиваются. Покрывает createTextBlockElement (violation-rendering.js):
 * класс content-item-wrapper--empty на обёртке блока при рендере и на каждый
 * ввод. Прежние ветки старой модели (createCaseElement/createFreeTextElement,
 * renderList для descriptionList) удалены вместе с типами case/freeText и
 * списочным полем.
 *
 * _browser-stub даёт только заглушки classList (contains всегда false) и
 * addEventListener (no-op) — недостаточно для проверки toggle. Здесь
 * document.createElement локально подменяется на обёртку с реальным
 * Set-трекингом classList и захватом обработчиков событий, без изменения
 * общего _browser-stub.mjs.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppConfig } from '../../static/js/shared/app-config.js';
import { PreviewManager } from '../../static/js/constructor/preview/preview.js';
import '../../static/js/constructor/violation/violation-init.js';
import { ViolationManager } from '../../static/js/constructor/violation/violation-core.js';
import { BLOCK_TYPES } from '../../static/js/constructor/violation/violation-block-types.js';

// Превью — не предмет этого теста, глушим шпионом (как в остальных violation-*.test.mjs).
PreviewManager.scheduleTypingBlock = () => {};
PreviewManager.updateBlock = () => {};

const FIELD = 'additionalContent';

/**
 * Оборачивает элемент, созданный стабом _browser-stub, реальным Set-трекингом
 * classList и захватом addEventListener-колбэков (стаб — no-op заглушки).
 * @param {Object} el - Элемент из document.createElement стаба
 * @returns {Object} Тот же элемент с рабочими classList/addEventListener
 */
function trackElement(el) {
    const classes = new Set();
    const listeners = new Map();
    el.classList = {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, force) => {
            const shouldHave = force === undefined ? !classes.has(c) : force;
            if (shouldHave) classes.add(c); else classes.delete(c);
            return shouldHave;
        },
        contains: (c) => classes.has(c),
    };
    el.addEventListener = (type, cb) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(cb);
    };
    el.blur = () => {};
    el.fire = (type, evt = {}) => (listeners.get(type) || []).forEach((cb) => cb(evt));
    return el;
}

/**
 * Выполняет fn с document.createElement, подменённым на трекающий вариант;
 * возвращает { result, created } — result рендер-функции и все созданные
 * элементы в порядке создания ({tag, el}), чтобы достать нужное поле без
 * реального DOM-обхода (appendChild в стабе — no-op).
 */
function withTrackedDom(fn) {
    const origCreate = document.createElement;
    const created = [];
    document.createElement = (tag) => {
        const el = trackElement(origCreate(tag));
        created.push({ tag, el });
        return el;
    };
    try {
        const result = fn();
        return { result, created };
    } finally {
        document.createElement = origCreate;
    }
}

function makeViolation() {
    return { id: 'v1', [FIELD]: { enabled: true, blocks: [] } };
}

function textBlock(content) {
    return { id: 'b1', type: BLOCK_TYPES.TEXT, content };
}

/** Rich-хост текст-блока — contenteditable-div с классом .violation-field. */
function findRichField(created) {
    return created.find(
        (c) => c.tag === 'div' && c.el.className && c.el.className.includes('violation-field'),
    ).el;
}

/** Рендерит текст-блок и отдаёт обёртку + созданные элементы. */
function renderTextBlock(content) {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation();
    const block = textBlock(content);
    violation[FIELD].blocks.push(block);
    const { result: wrapper, created } = withTrackedDom(
        () => vm.createTextBlockElement(violation, FIELD, block, false),
    );
    return { wrapper, created };
}

test('createTextBlockElement: пустой текст-блок получает класс content-item-wrapper--empty', () => {
    const { wrapper } = renderTextBlock('');
    assert.ok(wrapper.classList.contains('content-item-wrapper--empty'));
});

test('createTextBlockElement: заполненный блок — без класса --empty', () => {
    const { wrapper } = renderTextBlock('Описание нарушения');
    assert.ok(!wrapper.classList.contains('content-item-wrapper--empty'));
});

test('createTextBlockElement: пробелы в content тоже считаются пустотой (trim)', () => {
    const { wrapper } = renderTextBlock('   ');
    assert.ok(wrapper.classList.contains('content-item-wrapper--empty'));
});

test('createTextBlockElement: ввод текста снимает класс --empty динамически (визуальный класс)', () => {
    const { wrapper, created } = renderTextBlock('');
    const field = findRichField(created);

    assert.ok(wrapper.classList.contains('content-item-wrapper--empty'), 'изначально пусто');

    field.textContent = 'Новый текст';
    field.fire('input');

    assert.ok(!wrapper.classList.contains('content-item-wrapper--empty'), 'класс снят после ввода текста');
});

test('createTextBlockElement: очистка поля возвращает класс --empty', () => {
    const { wrapper, created } = renderTextBlock('Было');
    const field = findRichField(created);

    assert.ok(!wrapper.classList.contains('content-item-wrapper--empty'));

    field.textContent = '';
    field.fire('input');

    assert.ok(wrapper.classList.contains('content-item-wrapper--empty'), 'класс возвращается при очистке поля');
});

test('createTextBlockElement: модельное значение \'<br>\' (остаток очищенного contenteditable) — пусто (V24)', () => {
    const { wrapper } = renderTextBlock('<br>');
    assert.ok(wrapper.classList.contains('content-item-wrapper--empty'), '<br>-остаток считается пустым');
});

test('createTextBlockElement: модельное значение \'<div><br></div>\' — пусто (V24)', () => {
    const { wrapper } = renderTextBlock('<div><br></div>');
    assert.ok(wrapper.classList.contains('content-item-wrapper--empty'));
});

test('createTextBlockElement: модельное значение \'&nbsp;\' — пусто (F2/Пункт 2)', () => {
    const { wrapper } = renderTextBlock('&nbsp;');
    assert.ok(wrapper.classList.contains('content-item-wrapper--empty'), 'одинокий &nbsp; считается пустым');
});

test('режим просмотра: живого тумблера нет, класс ставится по модели', () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation();
    const block = textBlock('');
    violation[FIELD].blocks.push(block);

    const { result: wrapper, created } = withTrackedDom(
        () => vm.createTextBlockElement(violation, FIELD, block, true),
    );
    const field = findRichField(created);

    assert.ok(wrapper.classList.contains('content-item-wrapper--empty'));

    field.textContent = 'Правка в RO невозможна';
    field.fire('input');

    assert.ok(wrapper.classList.contains('content-item-wrapper--empty'), 'input-слушателя в RO нет');
});
