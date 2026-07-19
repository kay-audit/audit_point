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
import { EditorController } from '../../static/js/constructor/textblock/editor-controller.js';
import { EditorRegistry } from '../../static/js/constructor/textblock/editor-registry.js';
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
//
// Task 7: пункт списка — теперь тоже contenteditable-div .violation-field
// (не <input>), зеркало createCaseElement/createFreeTextElement выше. Живая
// подсветка пустоты — тот же view-only слушатель input по field.textContent;
// запись модели (items[index]) ведёт write-through контроллера (commit
// ViolationListItemSurface), в этих визуальных тестах не проверяется (см.
// violation-rich-fields.test.mjs). Escape-ревёрт не переносится — Escape в
// rich-поле = blur, как во всех rich-полях (без отдельного теста здесь, как
// и у case/freeText выше).
test('renderList: пустой пункт descriptionList получает класс violation-list-item--empty', () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation();
    violation.descriptionList.items = ['', 'Заполненный пункт'];
    const container = { innerHTML: '', appendChild() {} };

    const { created } = withTrackedDom(() => vm.renderList(container, violation, 'descriptionList', false));
    const rows = created
        .filter((c) => c.tag === 'div' && c.el.className && c.el.className.split(' ').includes('violation-list-item'))
        .map((c) => c.el);

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
    const rows = created
        .filter((c) => c.tag === 'div' && c.el.className && c.el.className.split(' ').includes('violation-list-item'))
        .map((c) => c.el);
    assert.equal(rows.length, 2);
    assert.ok(!rows[0].classList.contains('violation-list-item--empty'));
    assert.ok(!rows[1].classList.contains('violation-list-item--empty'));
});

test('renderList: ввод текста в пустой пункт снимает класс --empty динамически (визуальный класс)', () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation();
    violation.descriptionList.items = [''];
    const container = { innerHTML: '', appendChild() {} };

    const { created } = withTrackedDom(() => vm.renderList(container, violation, 'descriptionList', false));
    const row = created.find((c) => c.tag === 'div' && c.el.className && c.el.className.split(' ').includes('violation-list-item')).el;
    const field = findRichField(created);

    assert.ok(row.classList.contains('violation-list-item--empty'));

    field.textContent = 'Причина один';
    field.fire('input');

    assert.ok(!row.classList.contains('violation-list-item--empty'), 'класс снят после ввода текста');
});

test('renderList: очистка пункта возвращает класс --empty', () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation();
    violation.descriptionList.items = ['Заполнено'];
    const container = { innerHTML: '', appendChild() {} };

    const { created } = withTrackedDom(() => vm.renderList(container, violation, 'descriptionList', false));
    const row = created.find((c) => c.tag === 'div' && c.el.className && c.el.className.split(' ').includes('violation-list-item')).el;
    const field = findRichField(created);

    assert.ok(!row.classList.contains('violation-list-item--empty'));

    field.textContent = '';
    field.fire('input');

    assert.ok(row.classList.contains('violation-list-item--empty'), 'класс возвращается при очистке поля');
});

// --- Task 7: индексная адресация переживает удаление пункта --------------
// При удалении пункта список пере-рендеривается целиком (после
// _teardownActiveRichField) — КАЖДЫЙ оставшийся пункт получает НОВУЮ
// поверхность с ТЕКУЩИМ (пост-удаление) индексом. Проверяем сценарий из
// брифа: удаление пункта 0 → правка бывшего пункта 1 (сдвинувшегося на
// index 0) пишет в правильный индекс, а не застревает на старом (1).

test('renderList: после удаления пункта 0 — поверхность бывшего пункта 1 адресует ТЕКУЩИЙ индекс (0), commit пишет туда же', () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = { id: 'v1', descriptionList: { enabled: true, items: ['первый', 'второй'] } };
    const container = { innerHTML: '', appendChild() {} };

    const { created: created1 } = withTrackedDom(() => vm.renderList(container, violation, 'descriptionList', false));
    const deleteButtons = created1
        .filter((c) => c.tag === 'button' && c.el.className === 'violation-list-delete-btn')
        .map((c) => c.el);
    assert.equal(deleteButtons.length, 2, 'по кнопке удаления на пункт');

    // Удаляем ПЕРВЫЙ пункт ('первый') — 'второй' сдвигается на index 0,
    // список пере-рендеривается (deleteBtn.click → _teardownActiveRichField
    // → renderList заново).
    const { created: created2 } = withTrackedDom(() => deleteButtons[0].fire('click'));
    assert.deepEqual(violation.descriptionList.items, ['второй'], 'первый пункт удалён, второй сдвинулся на index 0');

    const field = findRichField(created2);
    const mounts = [];
    const origMount = EditorController.mount;
    EditorController.mount = (s) => mounts.push(s);
    try {
        field.fire('focus');
        assert.equal(mounts.length, 1, 'focus монтирует поверхность на НОВОЕ поле');
        const surface = mounts[0];
        assert.equal(surface.id, 'viol:v1:list:descriptionList:0',
            'новая поверхность адресует ТЕКУЩИЙ индекс (0), а не бывший индекс (1) — застревания нет');

        surface.element = field;
        field.innerHTML = 'второй изменён';
        surface.commit();
        assert.equal(violation.descriptionList.items[0], 'второй изменён',
            'commit пишет в правильный (текущий) индекс 0, а не в устаревший 1');
    } finally {
        EditorController.mount = origMount;
    }
});

// --- Ревью Issue 1: teardown ДОЛЖЕН идти ДО мутации (splice), не после ------
// Сценарий из ревью: поверхность ПОЗДНЕГО пункта смонтирована (активна в
// EditorRegistry) БЕЗ промежуточного blur, пользователь удаляет БОЛЕЕ РАННИЙ
// пункт того же списка. _teardownActiveRichField коммитит смонтированную
// поверхность через EditorController.unmount — если это происходит ПОСЛЕ
// splice (старый порядок), commit пишет по устаревшему (пред-сплайс) индексу
// в УЖЕ сдвинутый массив: индекс 3 в массиве длины 3 — это `items[3] = ...`,
// JS-массив тихо ДОБАВЛЯЕТ фантомный 4-й элемент вместо записи в существующий
// пункт. Правильный порядок (teardown → commit ДО splice) не даёт этому
// возникнуть. Реальный EditorController.mount/тулбар — вне scope node-теста
// (см. докстринг файла, Playwright); здесь unmount заменён на его
// СУЩЕСТВЕННОЕ для этого сценария поведение (commit активной поверхности) —
// тот же приём, что в остальных _teardownActiveRichField-тестах
// (violation-rich-fields.test.mjs), которые тоже подменяют unmount целиком.
test('renderList: удаление раннего пункта при смонтированной (без blur) поверхности позднего — commit уходит в правильный пред-сплайс индекс, без фантомного дубля', () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = { id: 'v1', descriptionList: { enabled: true, items: ['первый', 'второй', 'третий', 'четвёртый'] } };
    const container = { innerHTML: '', appendChild() {} };

    const { created } = withTrackedDom(() => vm.renderList(container, violation, 'descriptionList', false));
    const deleteButtons = created
        .filter((c) => c.tag === 'button' && c.el.className === 'violation-list-delete-btn')
        .map((c) => c.el);
    assert.equal(deleteButtons.length, 4, 'по кнопке удаления на пункт');

    // Поверхность ПОЗДНЕГО пункта (index 3, 'четвёртый') активна — как если
    // бы пользователь был сфокусирован на ней в момент клика на удаление.
    const lateSurface = vm._makeViolationListItemSurface(violation, 'descriptionList', 3);
    lateSurface.element = { innerHTML: 'четвёртый — правится в фокусе' };
    EditorRegistry.setActive(lateSurface);
    const origUnmount = EditorController.unmount;
    EditorController.unmount = () => { EditorRegistry.getActive()?.commit(); EditorRegistry.clear(); };
    try {
        // Удаляем ПЕРВЫЙ пункт (index 0) — НЕ тот, что смонтирован.
        withTrackedDom(() => deleteButtons[0].fire('click'));

        assert.deepEqual(violation.descriptionList.items, [
            'второй', 'третий', 'четвёртый — правится в фокусе',
        ], 'commit смонтированной поверхности ушёл в правильный (пред-сплайс) пункт 3 — без фантомного дубля и без потери правки');
    } finally {
        EditorController.unmount = origUnmount;
        EditorRegistry.clear();
    }
});
