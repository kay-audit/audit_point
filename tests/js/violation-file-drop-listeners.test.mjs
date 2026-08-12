/**
 * Один document-слушатель drop на менеджер нарушений (ревью №16).
 *
 * Зона приёма файлов у карточки своя на каждое из десяти полей, но
 * document-слушатель, который сбрасывает подсветку при промахе мимо зоны,
 * ОДИН на ViolationManager: раньше он вешался внутри setupFileDragAndDrop, и
 * одна карточка давала десять одинаковых слушателей на document, а каждый
 * ре-рендер контейнера — ещё десять.
 *
 * Реальные модули конструктора импортируются под node:test через
 * _browser-stub (см. конвенцию в violation-blocks-limit.test.mjs).
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppConfig } from '../../static/js/shared/app-config.js';
import '../../static/js/constructor/violation/violation-init.js';
import { ViolationManager } from '../../static/js/constructor/violation/violation-core.js';
import { VIOLATION_FIELD_KEYS } from '../../static/js/constructor/violation/violation-fields.js';

/**
 * Фейковый контейнер блоков поля: запоминает навешанные слушатели (чтобы
 * тест мог их дёрнуть), состояние классов и своё содержимое для contains().
 */
function makeContainer(name) {
    const classes = new Set();
    const handlers = new Map();
    const inner = { name: `${name}-inner` };
    return {
        name,
        inner,
        classes,
        classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            contains: (c) => classes.has(c),
        },
        addEventListener: (type, handler) => {
            if (!handlers.has(type)) handlers.set(type, []);
            handlers.get(type).push(handler);
        },
        fire: (type, event) => (handlers.get(type) || []).forEach(h => h(event)),
        contains: (target) => target === inner,
        querySelectorAll: () => [],
        querySelector: () => null,
    };
}

/** Событие файлового drag: types содержит 'Files', preventDefault — no-op. */
function fileDragEvent(target) {
    return {
        target,
        dataTransfer: { types: ['Files'], files: [] },
        preventDefault() {},
        stopPropagation() {},
    };
}

/**
 * Перехватывает document.addEventListener: считает подписки на 'drop' и
 * отдаёт последний зарегистрированный обработчик с его options.
 */
function spyDocumentDrop() {
    const calls = [];
    const original = document.addEventListener;
    document.addEventListener = (type, handler, options) => {
        if (type === 'drop') calls.push({ handler, options });
    };
    return {
        calls,
        get last() { return calls[calls.length - 1]; },
        restore: () => { document.addEventListener = original; },
    };
}

/** Менеджер с зонами приёма на все десять полей одного нарушения. */
function setupAllFields(manager, violationId) {
    const containers = new Map();
    for (const fieldKey of VIOLATION_FIELD_KEYS) {
        const items = makeContainer(`${violationId}:${fieldKey}`);
        containers.set(fieldKey, items);
        manager.setupFileDragAndDrop(items, { id: violationId }, fieldKey, makeContainer('content'));
    }
    return containers;
}

test('десять полей карточки дают ОДИН document-слушатель drop', () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const spy = spyDocumentDrop();
    try {
        const manager = new ViolationManager();
        setupAllFields(manager, 'v1');

        assert.equal(spy.calls.length, 1, 'document-слушатель ставится ровно один раз на менеджер');
        assert.equal(manager._fileDropZones.size, VIOLATION_FIELD_KEYS.length,
            'зона приёма регистрируется на каждое поле');
        assert.ok(spy.last.options?.signal, 'слушатель привязан к AbortController менеджера');
    } finally {
        spy.restore();
    }
});

test('второе нарушение и ре-рендер полей не добавляют новых слушателей', () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const spy = spyDocumentDrop();
    try {
        const manager = new ViolationManager();
        setupAllFields(manager, 'v1');
        setupAllFields(manager, 'v2');
        // Ре-рендер карточки: те же ключи зон переустанавливаются поверх.
        setupAllFields(manager, 'v1');

        assert.equal(spy.calls.length, 1, 'слушатель по-прежнему один');
        assert.equal(manager._fileDropZones.size, 2 * VIOLATION_FIELD_KEYS.length,
            'зоны не копятся при повторной установке того же поля');
    } finally {
        spy.restore();
    }
});

test('removeViolation снимает зоны нарушения, слушатель остаётся общим', () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const spy = spyDocumentDrop();
    try {
        const manager = new ViolationManager();
        setupAllFields(manager, 'v1');
        setupAllFields(manager, 'v2');

        manager.removeViolation('v1');

        assert.equal(manager._fileDropZones.size, VIOLATION_FIELD_KEYS.length,
            'сняты зоны только удалённого нарушения');
        assert.ok([...manager._fileDropZones.keys()].every(k => k.startsWith('v2:')));
        assert.equal(spy.calls.length, 1, 'слушатель не переставляется');
        assert.equal(manager._documentDropController.signal.aborted, false,
            'общий слушатель живёт до destroy()');
    } finally {
        spy.restore();
    }
});

test('destroy() снимает слушатель, следующая зона ставит его заново', () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const spy = spyDocumentDrop();
    try {
        const manager = new ViolationManager();
        setupAllFields(manager, 'v1');
        const controller = manager._documentDropController;

        manager.destroy();

        assert.equal(controller.signal.aborted, true, 'AbortController слушателя сработал');
        assert.equal(manager._fileDropZones.size, 0, 'зоны забыты');
        assert.equal(manager._documentDropController, null);

        // Switch акта: карточки строятся заново — слушатель нужен снова.
        setupAllFields(manager, 'v2');
        assert.equal(spy.calls.length, 2, 'после destroy() слушатель ставится ровно один раз');
    } finally {
        spy.restore();
    }
});

test('drop мимо зоны сбрасывает её подсветку, drop внутри зоны — нет', () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const spy = spyDocumentDrop();
    try {
        const manager = new ViolationManager();
        const containers = setupAllFields(manager, 'v1');
        const documentDrop = spy.last.handler;

        const violated = containers.get('violated');
        const reasons = containers.get('reasons');
        // Файловый drag вошёл в обе зоны — обе подсвечены.
        violated.fire('dragenter', fileDragEvent(violated.inner));
        reasons.fire('dragenter', fileDragEvent(reasons.inner));
        assert.equal(violated.classes.has('drag-over-file'), true);
        assert.equal(reasons.classes.has('drag-over-file'), true);

        // Промах мимо всех зон — сбрасываются обе.
        documentDrop({ target: { name: 'somewhere-else' } });
        assert.equal(violated.classes.has('drag-over-file'), false);
        assert.equal(reasons.classes.has('drag-over-file'), false);

        // Drop внутри зоны — её состояние держит собственный drop-обработчик поля.
        violated.fire('dragenter', fileDragEvent(violated.inner));
        reasons.fire('dragenter', fileDragEvent(reasons.inner));
        documentDrop({ target: violated.inner });
        assert.equal(violated.classes.has('drag-over-file'), true, 'своя зона не сбрасывается');
        assert.equal(reasons.classes.has('drag-over-file'), false, 'соседняя зона сбрасывается');
    } finally {
        spy.restore();
    }
});

test('режим просмотра: зона не регистрируется и слушатель не ставится', () => {
    AppConfig.readOnlyMode.isReadOnly = true;
    const spy = spyDocumentDrop();
    try {
        const manager = new ViolationManager();
        setupAllFields(manager, 'v1');

        assert.equal(spy.calls.length, 0);
        assert.equal(manager._fileDropZones.size, 0);
    } finally {
        spy.restore();
        AppConfig.readOnlyMode.isReadOnly = false;
    }
});
