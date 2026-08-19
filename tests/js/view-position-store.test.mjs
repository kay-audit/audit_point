/**
 * Персист позиции просмотра акта (шаг + скролл + якорь) — чистые функции
 * view-position-store.js: ключ per-act, load/save round-trip, защита от
 * битых/чужих данных, кламп step, дефолты для отсутствующих полей.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    viewPositionKey,
    loadViewPosition,
    saveViewPosition,
} from '../../static/js/constructor/state/view-position-store.js';

/** Минимальный in-memory Storage. */
function makeStorage() {
    const data = new Map();
    return {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => data.set(k, String(v)),
        removeItem: (k) => data.delete(k),
        _data: data,
    };
}

test('ключ строится per-act по образцу ключей черновика/collapsed-набора', () => {
    assert.equal(viewPositionKey(42), 'audit_workstation_viewpos:42');
});

test('save → load round-trip сохраняет позицию целиком', () => {
    const storage = makeStorage();
    const pos = {
        step: 2,
        scroll: { treeColumn: 100, previewColumn: 50, step2: 200 },
        anchorNodeId: 'n5',
    };
    saveViewPosition(storage, 7, pos);
    assert.deepEqual(loadViewPosition(storage, 7), pos);
});

test('позиции разных актов не пересекаются', () => {
    const storage = makeStorage();
    saveViewPosition(storage, 1, { step: 1, scroll: { treeColumn: 1, previewColumn: 0, step2: 0 }, anchorNodeId: null });
    saveViewPosition(storage, 2, { step: 2, scroll: { treeColumn: 2, previewColumn: 0, step2: 0 }, anchorNodeId: 'x' });
    assert.equal(loadViewPosition(storage, 1).step, 1);
    assert.equal(loadViewPosition(storage, 2).step, 2);
    assert.equal(loadViewPosition(storage, 2).anchorNodeId, 'x');
});

test('битый JSON → null', () => {
    const storage = makeStorage();
    storage.setItem(viewPositionKey(7), '{нев');
    assert.equal(loadViewPosition(storage, 7), null);
});

test('чужая форма (массив, скаляр) → null', () => {
    const storage = makeStorage();
    storage.setItem(viewPositionKey(7), '[1,2,3]');
    assert.equal(loadViewPosition(storage, 7), null);

    storage.setItem(viewPositionKey(7), '"строка"');
    assert.equal(loadViewPosition(storage, 7), null);
});

test('отсутствующие поля восстанавливаются дефолтами', () => {
    const storage = makeStorage();
    storage.setItem(viewPositionKey(7), '{}');
    assert.deepEqual(loadViewPosition(storage, 7), {
        step: 1,
        scroll: { treeColumn: 0, previewColumn: 0, step2: 0 },
        anchorNodeId: null,
    });

    storage.setItem(viewPositionKey(7), JSON.stringify({ step: 2, scroll: { treeColumn: 10 } }));
    assert.deepEqual(loadViewPosition(storage, 7), {
        step: 2,
        scroll: { treeColumn: 10, previewColumn: 0, step2: 0 },
        anchorNodeId: null,
    });
});

test('step клампится в 1|2', () => {
    const storage = makeStorage();
    storage.setItem(viewPositionKey(7), JSON.stringify({ step: 5 }));
    assert.equal(loadViewPosition(storage, 7).step, 1);

    storage.setItem(viewPositionKey(7), JSON.stringify({ step: 'два' }));
    assert.equal(loadViewPosition(storage, 7).step, 1);

    storage.setItem(viewPositionKey(7), JSON.stringify({ step: 2 }));
    assert.equal(loadViewPosition(storage, 7).step, 2);
});

test('без actId load отдаёт null, save — no-op', () => {
    const storage = makeStorage();
    assert.equal(loadViewPosition(storage, null), null);
    saveViewPosition(storage, null, { step: 1, scroll: { treeColumn: 0, previewColumn: 0, step2: 0 }, anchorNodeId: null });
    assert.equal(storage._data.size, 0);
});

test('запись помечается savedAt — по ней общий TTL-проход чистит заброшенные позиции', () => {
    const storage = makeStorage();
    saveViewPosition(storage, 7, {
        step: 1,
        scroll: { treeColumn: 0, previewColumn: 0, step2: 0 },
        anchorNodeId: null,
    });

    const raw = JSON.parse(storage.getItem(viewPositionKey(7)));
    assert.ok(Number.isFinite(Date.parse(raw.savedAt)),
        'метка времени в том же формате, что у снимков-черновиков');
});

test('savedAt не протекает в загруженную позицию (форма для потребителей неизменна)', () => {
    const storage = makeStorage();
    const pos = {
        step: 2,
        scroll: { treeColumn: 1, previewColumn: 2, step2: 3 },
        anchorNodeId: 'n1',
    };
    saveViewPosition(storage, 7, pos);

    assert.deepEqual(loadViewPosition(storage, 7), pos);
});
