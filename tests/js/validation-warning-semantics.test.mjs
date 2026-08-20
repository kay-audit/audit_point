/**
 * Семантика предупреждений валидации (val-1 / val-2 / val-6).
 *
 * Инварианты:
 *  - ValidationCore.warning() НЕ блокирует операцию: valid === true,
 *    isWarning === true (раньше valid:false смешивал предупреждение с ошибкой);
 *  - ValidationCore.combine(): ошибки доминируют; только-предупреждения дают
 *    неблокирующий результат;
 *  - ValidationAct.validateTb() находит раздел 5 по id (а не по number —
 *    до генерации нумерации поиск по number молча пропускал проверку);
 *  - NavigationManager._showContentWarnings() показывает предупреждения уровнем
 *    'warning' (не 'info') и НЕ блокирует сохранение (#8: WIP сохраняется);
 *  - и показывает ТОЛЬКО то, чего нет у сервера: про таблицу без данных
 *    предупреждает серверный тост в api.js, клиентский дубль убран.
 */
import './_browser-stub.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AppState } from '../../static/js/constructor/state/state-core.js';
import { ValidationCore } from '../../static/js/constructor/validation/validation-core.js';
import { ValidationAct } from '../../static/js/constructor/validation/validation-act.js';
import { ValidationTable } from '../../static/js/constructor/validation/validation-table.js';
import { NavigationManager } from '../../static/js/constructor/navigation-manager.js';
import { Notifications } from '../../static/js/shared/notifications.js';

beforeEach(() => {
    AppState.treeData = { id: 'root', label: 'Акт', children: [] };
    AppState.tables = {};
    AppState._rebuildNodeIndex();
});

// ──────────────────────────────────────────────────────────────────────────
// val-1: warning() не блокирует
// ──────────────────────────────────────────────────────────────────────────

test('warning(): valid === true, isWarning === true (предупреждение не блокирует)', () => {
    const result = ValidationCore.warning('что-то не заполнено');
    assert.equal(result.valid, true);
    assert.equal(result.isWarning, true);
    assert.equal(result.message, 'что-то не заполнено');
});

test('combine(): ошибка доминирует над предупреждением → valid false', () => {
    const result = ValidationCore.combine(
        ValidationCore.failure('ошибка'),
        ValidationCore.warning('предупреждение')
    );
    assert.equal(result.valid, false);
    assert.equal(result.isWarning, false);
    assert.equal(result.message, 'ошибка');
});

test('combine(): только предупреждения → valid true + isWarning', () => {
    const result = ValidationCore.combine(
        ValidationCore.success(),
        ValidationCore.warning('w1'),
        ValidationCore.warning('w2')
    );
    assert.equal(result.valid, true);
    assert.equal(result.isWarning, true);
    assert.equal(result.message, 'w1\nw2');
});

test('combine(): только успехи → success', () => {
    const result = ValidationCore.combine(ValidationCore.success(), ValidationCore.success());
    assert.equal(result.valid, true);
    assert.equal(result.isWarning, false);
});

// ──────────────────────────────────────────────────────────────────────────
// val-6: validateTb находит раздел 5 по id
// ──────────────────────────────────────────────────────────────────────────

test('validateTb: раздел 5 находится по id даже без сгенерированной нумерации', () => {
    // У узла раздела номер ещё не проставлен (generateNumbering не звался) —
    // поиск по number молча пропускал бы проверку.
    AppState.treeData = {
        id: 'root',
        label: 'Акт',
        children: [
            {
                id: '5',
                label: 'Раздел 5',
                children: [
                    { id: 'n51', type: 'item', number: '5.1', label: 'Пункт', children: [] },
                ],
            },
        ],
    };
    AppState._rebuildNodeIndex();

    const result = ValidationAct.validateTb();
    assert.equal(result.isWarning, true, 'leaf 5.1 без ТБ обязан давать предупреждение');
    assert.equal(result.valid, true, 'предупреждение не должно блокировать');
    assert.match(result.message, /5\.1/);
});

test('validateTb: все leaf с ТБ → success', () => {
    AppState.treeData = {
        id: 'root',
        label: 'Акт',
        children: [
            {
                id: '5',
                label: 'Раздел 5',
                number: '5',
                children: [
                    { id: 'n51', type: 'item', number: '5.1', label: 'Пункт', tb: ['ББ'], children: [] },
                ],
            },
        ],
    };
    AppState._rebuildNodeIndex();

    const result = ValidationAct.validateTb();
    assert.equal(result.valid, true);
    assert.equal(result.isWarning, false);
});

// ──────────────────────────────────────────────────────────────────────────
// val-1 + val-2: предупреждения в _showContentWarnings — уровень 'warning', без блокировки
// ──────────────────────────────────────────────────────────────────────────

test('_showContentWarnings: tb-предупреждение показывается уровнем warning и не блокирует', () => {
    AppState.treeData = {
        id: 'root',
        label: 'Акт',
        children: [
            {
                id: '5',
                label: 'Раздел 5',
                number: '5',
                children: [
                    { id: 'n51', type: 'item', number: '5.1', label: 'Пункт', children: [] },
                ],
            },
        ],
    };
    AppState.tables = {};
    AppState._rebuildNodeIndex();

    const shown = [];
    const originalShow = Notifications.show;
    Notifications.show = (message, type) => { shown.push({ message, type }); return 'id'; };
    try {
        NavigationManager._showContentWarnings();
        assert.equal(shown.length, 1);
        assert.equal(shown[0].type, 'warning', 'предупреждение обязано показываться уровнем warning');
        assert.match(shown[0].message, /Не назначен ТБ/);
    } finally {
        Notifications.show = originalShow;
    }
});

test('_showContentWarnings: таблица без данных НЕ даёт клиентского тоста (о ней предупреждает сервер)', () => {
    // Дедупликация тостов: про таблицу без данных бэк присылает `table_no_data`
    // и api.js показывает единый тост «Работа не закончена: …». Клиентский тост
    // был вторым предупреждением на одно нажатие «Сохранить».
    AppState.treeData = { id: 'root', label: 'Акт', children: [] };
    AppState.tables = {
        t1: {
            id: 't1',
            nodeId: 'n1',
            grid: [
                [{ content: 'A', isHeader: true, colSpan: 1, rowSpan: 1, originRow: 0, originCol: 0 }],
            ],
            colWidths: [100],
        },
    };
    AppState._rebuildNodeIndex();

    const shown = [];
    const originalShow = Notifications.show;
    Notifications.show = (message, type) => { shown.push({ message, type }); return 'id'; };
    try {
        NavigationManager._showContentWarnings();
        assert.deepEqual(shown, [], 'клиентский тост о таблице без данных показываться не должен');
    } finally {
        Notifications.show = originalShow;
    }
});

test('ValidationTable: построитель текста validateData удалён (осиротел вместе с тостом)', () => {
    assert.equal(typeof ValidationTable.validateData, 'undefined');
});

// ──────────────────────────────────────────────────────────────────────────
// #8: экспорт блокируется на сломанной структуре, но это отдельный гейт
//     от сохранения в БД (сохранение WIP не блокируется — проверяется в e2e).
// ──────────────────────────────────────────────────────────────────────────

test('_validateForExport: сломанная структура (нет разделов 1–5) блокирует экспорт', () => {
    AppState.treeData = { id: 'root', label: 'Акт', children: [] };
    AppState._rebuildNodeIndex();
    const errors = [];
    const originalError = Notifications.error;
    Notifications.error = (message) => { errors.push(message); return 'id'; };
    try {
        const ok = NavigationManager._validateForExport();
        assert.equal(ok, false, 'экспорт сломанной структуры обязан блокироваться');
        assert.ok(errors.length >= 1);
    } finally {
        Notifications.error = originalError;
    }
});
