/**
 * Подписи полей нарушения в журнале аудита (ревью №8).
 *
 * dialog-audit-log.js._renderFieldChanges раньше держал локальную карту из
 * шести устаревших ключей скалярной модели нарушения; для полей вне карты
 * (description/codeMining/processMining/additionalContent/fieldOrder) в
 * журнал уходил сырой camelCase-ключ. Теперь подписи берутся из общего
 * реестра VIOLATION_LABELS (static/js/constructor/violation/violation-fields.js)
 * + fieldOrder — атрибут нарушения, а не поле реестра, подписан отдельно.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogDialog } from '../../static/js/portal/acts-manager/dialog-audit-log.js';
import { VIOLATION_FIELD_KEYS } from '../../static/js/constructor/violation/violation-fields.js';

function fieldChanges(fields) {
    return { type: 'violation', fields };
}

test('метки полей нарушения в журнале аудита — русские, из реестра VIOLATION_LABELS', () => {
    const html = AuditLogDialog._renderFieldChanges(fieldChanges({
        description: { changed: true },
        codeMining: { changed: true },
        processMining: { changed: true },
        additionalContent: { changed: true },
    }));
    assert.ok(html.includes('Поле «Описание»: изменено'));
    assert.ok(html.includes('Поле «CodeMining»: изменено'));
    assert.ok(html.includes('Поле «ProcessMining»: изменено'));
    assert.ok(html.includes('Поле «Дополнительный контент»: изменено'));
});

test('fieldOrder подписан как «Порядок полей»', () => {
    const html = AuditLogDialog._renderFieldChanges(fieldChanges({
        fieldOrder: { changed: true },
    }));
    assert.ok(html.includes('Поле «Порядок полей»: изменено'));
    assert.ok(!html.includes('fieldOrder'), 'сырой ключ не должен просачиваться в разметку');
});

test('все 10 полей реестра дают подписи без фолбэка на сырой ключ', () => {
    const fields = {};
    for (const key of VIOLATION_FIELD_KEYS) fields[key] = { changed: true };
    const html = AuditLogDialog._renderFieldChanges(fieldChanges(fields));

    for (const key of VIOLATION_FIELD_KEYS) {
        assert.ok(!html.includes(`«${key}»`), `ключ «${key}» не должен остаться нераспознанным camelCase`);
    }
});

test('неизменившиеся поля (changed=false) не попадают в журнал', () => {
    const html = AuditLogDialog._renderFieldChanges(fieldChanges({
        violated: { changed: true },
        established: { changed: false },
    }));
    assert.ok(html.includes('Нарушено'));
    assert.ok(!html.includes('Установлено'));
});
