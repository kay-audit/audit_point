/**
 * Не блокирующая подсветка пустых элементов в форме нарушения (#9-Г, Wave 2).
 *
 * Только визуальный класс + toggle на input — данные/сериализация не
 * затрагиваются (нумерация формы computeAdditionalContentNumbers/
 * getTypeSequentialNumber остаётся эталоном и здесь не трогается). Покрывает:
 *  - createCaseElement/createFreeTextElement (violation-rendering.js) —
 *    класс content-item-wrapper--empty на обёртке;
 *  - renderList для descriptionList (violation-core.js) — класс
 *    violation-list-item--empty на строке пункта.
 *
 * _browser-stub даёт только заглушки classList (contains всегда false) и
 * addEventListener (no-op) — недостаточно для проверки toggle. Здесь
 * document.createElement локально подменяется на обёртку с реальным
 * Set-трекингом classList и захватом обработчиков событий, без изменения
 * общего _browser-stub.mjs (не трогаем файлы вне брифа).
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppConfig } from '../../static/js/shared/app-config.js';
import { PreviewManager } from '../../static/js/constructor/preview/preview.js';
import '../../static/js/constructor/violation/violation-init.js';
import { ViolationManager } from '../../static/js/constructor/violation/violation-core.js';
import {
    CONTENT_TYPE_CASE,
    CONTENT_TYPE_FREE_TEXT,
} from '../../static/js/constructor/violation/violation-content-item.js';

// Превью — не предмет этого теста, глушим шпионом (как в остальных violation-*.test.mjs).
PreviewManager.scheduleTypingBlock = () => {};
PreviewManager.updateBlock = () => {};

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
    // blur() зовётся в keydown-обработчиках (Enter/Escape) renderList и
    // setupTextareaHandlers — стаб _browser-stub его не даёт.
    el.blur = () => {};
    // evt по умолчанию {} (обработчики input/focus его не читают);
    // keydown-обработчику нужен объект с key/preventDefault/stopPropagation.
    el.fire = (type, evt = {}) => (listeners.get(type) || []).forEach((cb) => cb(evt));
    return el;
}

/**
 * Выполняет fn с document.createElement, подменённым на трекающий вариант;
 * возвращает { result, created } — result рендер-функции и все созданные
 * элементы в порядке создания ({tag, el}), чтобы достать нужный textarea/input
 * без реального DOM-обхода (appendChild в стабе — no-op).
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
    return {
        id: 'v1',
        descriptionList: { enabled: true, items: [] },
        additionalContent: { enabled: true, items: [] },
    };
}

// --- createCaseElement ---

test('createCaseElement: пустой кейс получает класс content-item-wrapper--empty', () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation();
    const item = { id: 'c1', type: CONTENT_TYPE_CASE, content: '' };

    const { result: wrapper } = withTrackedDom(() => vm.createCaseElement(violation, item, 0, 1, false));

    assert.ok(wrapper.classList.contains('content-item-wrapper--empty'));
});

test('createCaseElement: заполненный кейс — без класса --empty', () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation();
    const item = { id: 'c1', type: CONTENT_TYPE_CASE, content: 'Описание кейса' };

    const { result: wrapper } = withTrackedDom(() => vm.createCaseElement(violation, item, 0, 1, false));

    assert.ok(!wrapper.classList.contains('content-item-wrapper--empty'));
});

test('createCaseElement: пробелы в content тоже считаются пустотой (trim)', () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation();
    const item = { id: 'c1', type: CONTENT_TYPE_CASE, content: '   ' };

    const { result: wrapper } = withTrackedDom(() => vm.createCaseElement(violation, item, 0, 1, false));

    assert.ok(wrapper.classList.contains('content-item-wrapper--empty'));
});

// Task 1.3.3: кейс/свободный текст — теперь contenteditable-div .violation-field
// (не textarea). Живая подсветка пустоты — view-only слушатель input по
// field.textContent; запись модели (item.content) ведёт write-through контроллера
// (commit), в этих визуальных тестах не проверяется (см. violation-rich-fields.test.mjs
// и violation-textarea-handlers.test.mjs).
function findRichField(created) {
    return created.find((c) => c.tag === 'div' && c.el.className && c.el.className.includes('violation-field')).el;
}

test('createCaseElement: ввод текста снимает класс --empty динамически (визуальный класс)', () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation();
    const item = { id: 'c1', type: CONTENT_TYPE_CASE, content: '' };

    const { result: wrapper, created } = withTrackedDom(() => vm.createCaseElement(violation, item, 0, 1, false));
    const field = findRichField(created);

    assert.ok(wrapper.classList.contains('content-item-wrapper--empty'), 'изначально пусто');

    field.textContent = 'Новый текст кейса';
    field.fire('input');

    assert.ok(!wrapper.classList.contains('content-item-wrapper--empty'), 'класс снят после ввода текста');
});

test('createCaseElement: очистка поля возвращает класс --empty', () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation();
    const item = { id: 'c1', type: CONTENT_TYPE_CASE, content: 'Было' };

    const { result: wrapper, created } = withTrackedDom(() => vm.createCaseElement(violation, item, 0, 1, false));
    const field = findRichField(created);

    assert.ok(!wrapper.classList.contains('content-item-wrapper--empty'));

    field.textContent = '';
    field.fire('input');

    assert.ok(wrapper.classList.contains('content-item-wrapper--empty'), 'класс возвращается при очистке поля');
});

// --- createFreeTextElement ---

test('createFreeTextElement: ввод текста снимает класс --empty динамически (визуальный класс)', () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation();
    const item = { id: 'f1', type: CONTENT_TYPE_FREE_TEXT, content: '' };

    const { result: wrapper, created } = withTrackedDom(() => vm.createFreeTextElement(violation, item, 0, 1, false));
    const field = findRichField(created);

    assert.ok(wrapper.classList.contains('content-item-wrapper--empty'));

    field.textContent = 'Произвольный текст';
    field.fire('input');

    assert.ok(!wrapper.classList.contains('content-item-wrapper--empty'));
});

test('createFreeTextElement: заполненный текст — без класса --empty', () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation();
    const item = { id: 'f1', type: CONTENT_TYPE_FREE_TEXT, content: 'Уже заполнено' };

    const { result: wrapper } = withTrackedDom(() => vm.createFreeTextElement(violation, item, 0, 1, false));

    assert.ok(!wrapper.classList.contains('content-item-wrapper--empty'));
});

// --- renderList (descriptionList) ---

test('renderList: пустой пункт descriptionList получает класс violation-list-item--empty', () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation();
    violation.descriptionList.items = ['', 'Заполненный пункт'];
    const container = { innerHTML: '', appendChild() {} };

    const { created } = withTrackedDom(() => vm.renderList(container, violation, 'descriptionList', false));
    const rows = created.filter((c) => c.tag === 'div').map((c) => c.el);

    assert.equal(rows.length, 2);
    assert.ok(rows[0].classList.contains('violation-list-item--empty'), 'пустой пункт подсвечен');
    assert.ok(!rows[1].classList.contains('violation-list-item--empty'), 'заполненный пункт не подсвечен');
});

test('renderList: не-строковые пункты ([null, число]) рендерятся без исключения (#6)', () => {
    // Легаси/битый акт: нормализатор дозаполняет ключи, но не приводит типы
    // внутри items. .trim() на null/числе кинул бы TypeError и уронил рендер
    // всей карточки — String(...) в renderList страхует.
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation();
    violation.descriptionList.items = [null, 5];
    const container = { innerHTML: '', appendChild() {} };

    let created;
    assert.doesNotThrow(() => {
        ({ created } = withTrackedDom(() => vm.renderList(container, violation, 'descriptionList', false)));
    });

    // Оба пункта отрисованы; главное — без TypeError на .trim(). String(null)='null',
    // String(5)='5' — непустые строки, поэтому подсветка --empty не ставится.
    const rows = created.filter((c) => c.tag === 'div').map((c) => c.el);
    assert.equal(rows.length, 2);
    assert.ok(!rows[0].classList.contains('violation-list-item--empty'));
    assert.ok(!rows[1].classList.contains('violation-list-item--empty'));
});

test('renderList: ввод текста в пустой пункт снимает класс, данные пишутся в items[]', () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation();
    violation.descriptionList.items = [''];
    const container = { innerHTML: '', appendChild() {} };

    const { created } = withTrackedDom(() => vm.renderList(container, violation, 'descriptionList', false));
    const row = created.find((c) => c.tag === 'div').el;
    const input = created.find((c) => c.tag === 'input').el;

    assert.ok(row.classList.contains('violation-list-item--empty'));

    input.value = 'Причина один';
    input.fire('input');

    assert.equal(violation.descriptionList.items[0], 'Причина один');
    assert.ok(!row.classList.contains('violation-list-item--empty'));
});

test('renderList: Escape восстанавливает исходное значение и корректно тоггалит класс обратно', () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation();
    violation.descriptionList.items = [''];
    const container = { innerHTML: '', appendChild() {} };

    const { created } = withTrackedDom(() => vm.renderList(container, violation, 'descriptionList', false));
    const row = created.find((c) => c.tag === 'div').el;
    const input = created.find((c) => c.tag === 'input').el;

    // Фокус запоминает исходное значение ('').
    input.fire('focus');
    input.value = 'Черновик, который отменят';
    input.fire('input');
    assert.ok(!row.classList.contains('violation-list-item--empty'), 'после ввода класс снят');

    // Escape восстанавливает исходное ('') — класс --empty должен вернуться.
    input.fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });

    assert.equal(input.value, '', 'input.value откачен к исходному');
    assert.equal(violation.descriptionList.items[0], '', 'данные откачены');
    assert.ok(row.classList.contains('violation-list-item--empty'), 'класс возвращается после Escape');
});
