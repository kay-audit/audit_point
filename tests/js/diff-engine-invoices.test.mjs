/**
 * Тесты диффа фактур (#8 full, invoices, решение Q2): раньше снимок версии не
 * хранил фактуры → диффу они были недоступны. Теперь снимок несёт блоб
 * invoices_data = {node_id: реквизиты}, а `_diffInvoices` сравнивает привязки
 * по node_id: added / removed / modified (реквизиты) / unchanged.
 *
 * Обе стороны — одинаковая форма {node_id: инвойс}: старая = блоб снимка
 * (oldData.invoices_data), новая = поле invoices из GET /acts/{id}/content
 * (newData.invoices). Старый снимок без блоба → пустой {} → всё added.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiffEngine } from '../../static/js/portal/acts-manager/diff-engine.js';

function inv(over = {}) {
    return {
        node_id: 'n5', node_number: '5.1', db_type: 'hive',
        schema_name: 's', table_name: 't1', metrics: [], process: null,
        profile_div: null, verification_status: 'pending', ...over,
    };
}

function diffOne(oldI, newI) {
    return DiffEngine._diffInvoices(
        oldI ? { n5: oldI } : {},
        newI ? { n5: newI } : {},
    ).n5;
}

// --- added / removed --------------------------------------------------------

test('фактура только в новой версии → added', () => {
    const d = diffOne(null, inv());
    assert.equal(d.status, 'added');
    assert.deepEqual(d.newData, inv());
});

test('фактура только в старой версии → removed', () => {
    const d = diffOne(inv(), null);
    assert.equal(d.status, 'removed');
    assert.deepEqual(d.oldData, inv());
});

// --- unchanged --------------------------------------------------------------

test('идентичные реквизиты → unchanged', () => {
    const d = diffOne(inv(), inv());
    assert.equal(d.status, 'unchanged');
});

test('различие только в id/created_at/updated_at → unchanged (не реквизиты)', () => {
    const d = diffOne(
        inv({ id: 1, created_at: 'a', updated_at: 'b', created_by: 'x' }),
        inv({ id: 2, created_at: 'c', updated_at: 'd', created_by: 'y' }),
    );
    assert.equal(d.status, 'unchanged');
});

// --- modified: реквизиты ----------------------------------------------------

test('смена table_name → modified + fieldDiffs.table_name', () => {
    const d = diffOne(inv({ table_name: 't1' }), inv({ table_name: 't2' }));
    assert.equal(d.status, 'modified');
    assert.deepEqual(d.fieldDiffs.table_name, { old: 't1', new: 't2' });
});

test('смена db_type/schema_name/verification_status → modified', () => {
    const d = diffOne(
        inv({ db_type: 'hive', schema_name: 's1', verification_status: 'pending' }),
        inv({ db_type: 'greenplum', schema_name: 's2', verification_status: 'verified' }),
    );
    assert.equal(d.status, 'modified');
    assert.deepEqual(d.fieldDiffs.db_type, { old: 'hive', new: 'greenplum' });
    assert.deepEqual(d.fieldDiffs.schema_name, { old: 's1', new: 's2' });
    assert.deepEqual(d.fieldDiffs.verification_status, { old: 'pending', new: 'verified' });
});

test('смена metrics (массив) → modified + fieldDiffs.metrics (JSON-строки)', () => {
    const d = diffOne(
        inv({ metrics: [{ metric_code: 'ФР00001' }] }),
        inv({ metrics: [{ metric_code: 'ФР00002' }] }),
    );
    assert.equal(d.status, 'modified');
    assert.ok(d.fieldDiffs.metrics);
    assert.notEqual(d.fieldDiffs.metrics.old, d.fieldDiffs.metrics.new);
});

test('одинаковые metrics по значению → unchanged', () => {
    const d = diffOne(
        inv({ metrics: [{ metric_code: 'ФР00001' }] }),
        inv({ metrics: [{ metric_code: 'ФР00001' }] }),
    );
    assert.equal(d.status, 'unchanged');
});

// --- фантомный дифф: сравнение по ВИДИМЫМ кодам (#8) -------------------------

test('metrics: одинаковый код, разный служебный атрибут → unchanged (фантом погашен)', () => {
    const d = diffOne(
        inv({ metrics: [{ metric_code: 'ФР00001', metric_name: 'старое имя' }] }),
        inv({ metrics: [{ metric_code: 'ФР00001', metric_name: 'новое имя' }] }),
    );
    assert.equal(d.status, 'unchanged');
});

test('metrics: разный код → modified (реальная смена видима)', () => {
    const d = diffOne(
        inv({ metrics: [{ metric_code: 'ФР00001' }] }),
        inv({ metrics: [{ metric_code: 'ФР00002' }] }),
    );
    assert.equal(d.status, 'modified');
    assert.deepEqual(d.fieldDiffs.metrics, { old: 'ФР00001', new: 'ФР00002' });
});

test('process: одинаковый код, разный служебный атрибут → unchanged', () => {
    const d = diffOne(
        inv({ process: [{ process_code: 'П6152', process_name: 'A' }] }),
        inv({ process: [{ process_code: 'П6152', process_name: 'B' }] }),
    );
    assert.equal(d.status, 'unchanged');
});

// --- §5.10c: сравнение по кодам порядко-независимое --------------------------
// Раньше коды сводились в строку через .map(...).join(', ') без сортировки —
// перестановка тех же кодов (без смысловой правки) давала ложное «изменено».

test('metrics: перестановка тех же кодов → unchanged (порядко-независимое сравнение)', () => {
    const d = diffOne(
        inv({ metrics: [{ metric_code: 'ФР00001' }, { metric_code: 'ФР00002' }] }),
        inv({ metrics: [{ metric_code: 'ФР00002' }, { metric_code: 'ФР00001' }] }),
    );
    assert.equal(d.status, 'unchanged');
});

test('metrics: реальное изменение набора кодов при перестановке → modified', () => {
    const d = diffOne(
        inv({ metrics: [{ metric_code: 'ФР00001' }, { metric_code: 'ФР00002' }] }),
        inv({ metrics: [{ metric_code: 'ФР00003' }, { metric_code: 'ФР00001' }] }),
    );
    assert.equal(d.status, 'modified');
    assert.ok(d.fieldDiffs.metrics);
});

test('process: перестановка тех же кодов → unchanged (порядко-независимое сравнение)', () => {
    const d = diffOne(
        inv({ process: [{ process_code: 'П6152' }, { process_code: 'П6153' }] }),
        inv({ process: [{ process_code: 'П6153' }, { process_code: 'П6152' }] }),
    );
    assert.equal(d.status, 'unchanged');
});

test('process: реальное изменение набора кодов при перестановке → modified', () => {
    const d = diffOne(
        inv({ process: [{ process_code: 'П6152' }, { process_code: 'П6153' }] }),
        inv({ process: [{ process_code: 'П6154' }, { process_code: 'П6152' }] }),
    );
    assert.equal(d.status, 'modified');
    assert.ok(d.fieldDiffs.process);
});

// --- compute-интеграция -----------------------------------------------------

test('compute: изменение фактуры отражается в hasChanges и invoices', () => {
    const tree = { id: 'root', label: 'Акт', children: [] };
    const r = DiffEngine.compute(
        { tree_data: tree, invoices_data: { n5: inv({ table_name: 't1' }) } },
        { tree, invoices: { n5: inv({ table_name: 't2' }) } },
    );
    assert.equal(r.hasChanges, true);
    assert.equal(r.invoices.n5.status, 'modified');
});

test('compute: снимок без invoices_data → фактуры новой стороны = added', () => {
    const tree = { id: 'root', label: 'Акт', children: [] };
    const r = DiffEngine.compute(
        { tree_data: tree },  // старый снимок без блоба invoices_data
        { tree, invoices: { n5: inv() } },
    );
    assert.equal(r.hasChanges, true);
    assert.equal(r.invoices.n5.status, 'added');
});

test('compute: без фактур с обеих сторон → invoices пуст, дерево не даёт hasChanges', () => {
    const tree = { id: 'root', label: 'Акт', children: [] };
    const r = DiffEngine.compute(
        { tree_data: tree },
        { tree },
    );
    assert.deepEqual(r.invoices, {});
    assert.equal(r.hasChanges, false);
});
