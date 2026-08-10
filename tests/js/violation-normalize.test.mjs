/**
 * Тесты нормализации формы нарушения на загрузке акта (находка аудита #20).
 *
 * Блочная модель: normalizeViolations до-заполняет ТОЛЬКО отсутствующие
 * контейнеры {enabled, blocks} и скаляр fieldOrder эталонной формой
 * (createDefaultViolationShape), не перезатирая валидные данные.
 * Модуль без DOM — импортируется напрямую под node:test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createDefaultViolationShape,
    normalizeViolations,
} from '../../static/js/constructor/violation/violation-normalize.js';
import { VIOLATION_FIELD_KEYS, MANDATORY_FIELD_KEYS } from '../../static/js/constructor/violation/violation-fields.js';

test('violations undefined → ранний return, changed=false/count=0', () => {
    assert.deepEqual(normalizeViolations(undefined), { changed: false, count: 0 });
});

test('пустой словарь нарушений → changed=false/count=0', () => {
    assert.deepEqual(normalizeViolations({}), { changed: false, count: 0 });
});

test('createDefaultViolationShape: все 10 полей реестра + fieldOrder=null', () => {
    const shape = createDefaultViolationShape();
    assert.equal(shape.fieldOrder, null);
    for (const key of VIOLATION_FIELD_KEYS) {
        assert.deepEqual(
            shape[key],
            { enabled: MANDATORY_FIELD_KEYS.includes(key), blocks: [] },
            `поле '${key}' — единый контейнер, mandatory-поля включены`
        );
    }
    const extraKeys = Object.keys(shape).filter(
        k => k !== 'fieldOrder' && !VIOLATION_FIELD_KEYS.includes(k)
    );
    assert.deepEqual(extraKeys, [], 'нет полей вне реестра');
});

test('нарушение без measures → до-заполнено эталоном, форма не падает', () => {
    const violations = {
        v1: {
            id: 'v1',
            nodeId: 'n1',
            // measures отсутствует целиком (повреждённый акт)
        },
    };

    const result = normalizeViolations(violations);

    assert.equal(result.changed, true);
    assert.equal(result.count, 1);
    assert.deepEqual(violations.v1.measures, { enabled: false, blocks: [] });
});

test('нарушение без ЛЮБОГО контейнера (только id/nodeId) → все поля дозаполнены', () => {
    const violations = {
        v1: { id: 'v1', nodeId: 'n1' },
    };

    const result = normalizeViolations(violations);

    assert.equal(result.changed, true);
    assert.equal(result.count, 1);
    const { id, nodeId, ...rest } = violations.v1;
    assert.deepEqual(rest, createDefaultViolationShape());
});

test('контейнер присутствует, но без части ключей → дозаполняются только отсутствующие', () => {
    const violations = {
        v1: {
            id: 'v1',
            nodeId: 'n1',
            reasons: { enabled: true }, // blocks отсутствует
        },
    };

    normalizeViolations(violations);

    assert.deepEqual(violations.v1.reasons, { enabled: true, blocks: [] });
});

test('валидные данные НЕ перезатираются (значения сохранены как есть)', () => {
    const full = createDefaultViolationShape();
    full.violated = {
        enabled: true,
        blocks: [{ id: 'text_1_a', type: 'text', content: '<p>уже заполнено</p>' }],
    };
    full.codeMining = {
        enabled: true,
        blocks: [{ id: 'table_1_b', type: 'table', table: { grid: [], colWidths: [] } }],
    };
    full.fieldOrder = [...VIOLATION_FIELD_KEYS].reverse();
    const violations = { v1: { id: 'v1', nodeId: 'n1', ...full } };
    const snapshot = JSON.parse(JSON.stringify(violations.v1));

    const result = normalizeViolations(violations);

    assert.equal(result.changed, false);
    assert.equal(result.count, 0);
    assert.deepEqual(violations.v1, snapshot);
});

test('несколько нарушений: count считает только реально изменённые', () => {
    const violations = {
        v1: { id: 'v1', nodeId: 'n1', ...createDefaultViolationShape() },
        v2: { id: 'v2', nodeId: 'n2' }, // пустой — потребует дозаполнения
    };

    const result = normalizeViolations(violations);

    assert.equal(result.changed, true);
    assert.equal(result.count, 1, 'только v2 потребовал дозаполнения');
});

test('createDefaultViolationShape: каждый вызов возвращает независимый объект (без общих ссылок)', () => {
    const a = createDefaultViolationShape();
    const b = createDefaultViolationShape();
    a.reasons.blocks.push({ id: 'x', type: 'text', content: 'мутация a' });
    a.reasons.enabled = true;
    assert.deepEqual(b.reasons, { enabled: false, blocks: [] }, 'b не затронут мутацией a');
});
