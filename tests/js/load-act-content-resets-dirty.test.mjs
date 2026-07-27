/**
 * Регрессионный тест: после AI-операции (refresh_act от modify_act_tree,
 * add_table_row, fill_table и т.д.) beforeunload ошибочно срабатывал.
 *
 * Корень: _applyActContent загружал свежие данные с сервера, но
 * НЕ сбрасывал _isSyncedWithDB — StorageManager продолжал считать
 * акт «грязным». Фикс: внутри setTimeout после enableTracking()
 * _applyActContent вызывает StorageManager.markAsSyncedWithDB().
 *
 * Сценарий: пользователь сделал ручную правку (_state='unsaved'),
 * AI-ассистент выполнил операцию на бэкенде, бэкенд вернул
 * client_action refresh_act, фронт вызвал loadActContent →
 * _applyActContent → _isSyncedWithDB должен стать true.
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { APIClient } from '../../static/js/shared/api.js';
import { StorageManager } from '../../static/js/constructor/storage-manager.js';
import { AuthManager } from '../../static/js/shared/auth.js';
import { AppConfig } from '../../static/js/shared/app-config.js';

// Spy: подсчитываем вызовы markAsSyncedWithDB/markAsUnsaved.
const realMarkAsSyncedWithDB = StorageManager.markAsSyncedWithDB;
const realMarkAsUnsaved = StorageManager.markAsUnsaved;
const realSetBaseUpdatedAt = StorageManager.setBaseUpdatedAt;
const realGetUser = AuthManager.getCurrentUser;
const realGetUrl = AppConfig.api.getUrl;

let markAsSyncedWithDBCalls = 0;
let markAsUnsavedCalls = 0;

beforeEach(() => {
    StorageManager.destroy();
    StorageManager._trackingDepth = 0;
    StorageManager._setState('saved');
    StorageManager._dirtyEpoch = 0;
    StorageManager._baseUpdatedAt = null;

    markAsSyncedWithDBCalls = 0;
    markAsUnsavedCalls = 0;
    StorageManager.markAsSyncedWithDB = function (...args) {
        markAsSyncedWithDBCalls++;
        return realMarkAsSyncedWithDB.apply(this, args);
    };
    StorageManager.markAsUnsaved = function (...args) {
        markAsUnsavedCalls++;
        return realMarkAsUnsaved.apply(this, args);
    };
    StorageManager.setBaseUpdatedAt = () => {};

    AuthManager.getCurrentUser = () => 'user42';
    AppConfig.api.getUrl = (endpoint) => endpoint;
    AppConfig.readOnlyMode.isReadOnly = false;
    AppConfig.readOnlyMode.userRole = null;

    // _applyActContent ожидает несколько глобалов.
    globalThis.window.AppState = {
        treeData: { id: 'root', children: [] },
        tables: {},
        textBlocks: {},
        violations: {},
        changelog: [],
        invoiceNodeIds: [],
        currentStep: 0,
        selectedNode: null,
        selectedCells: [],
        exportData() {
            return {
                tree: this.treeData,
                tables: this.tables,
                textBlocks: this.textBlocks,
                violations: this.violations,
            };
        },
        initializeTree: () => {},
        generateNumbering: () => {},
    };
    globalThis.window.treeManager = { render: () => {} };
    globalThis.window.ItemsRenderer = { renderAll: () => {} };
    globalThis.window.PreviewManager = { update: () => {} };
    globalThis.window.ViolationAudit = { snapshot: () => {} };
    globalThis.window.textBlockManager = { fontSizes: [] };
    // normalizeFontSizes/normalizeViolations — настоящие функции в sanitize/renderer.
    // Через window вызов — fallback (нет функции) даст { changed: false }.
    globalThis.window.normalizeFontSizes = undefined;
    globalThis.window.normalizeViolations = undefined;

    // _maybeRestoreDraft используется; стабим, что он false.
    APIClient._maybeRestoreDraft = async () => false;
    // _showReadOnlyBanner использует DOM insertBefore; в тестах не нужно.
    APIClient._showReadOnlyBanner = () => {};

    // Ускоряем setTimeout чтобы тесты не ждали реальных 500мс.
    AppConfig.timings.enableTrackingAfterLoad = 5;
});

afterEach(() => {
    StorageManager.markAsSyncedWithDB = realMarkAsSyncedWithDB;
    StorageManager.markAsUnsaved = realMarkAsUnsaved;
    StorageManager.setBaseUpdatedAt = realSetBaseUpdatedAt;
    AuthManager.getCurrentUser = realGetUser;
    AppConfig.api.getUrl = realGetUrl;
    delete APIClient._maybeRestoreDraft;
    delete APIClient._showReadOnlyBanner;
    delete globalThis.window.AppState;
    delete globalThis.window.treeManager;
    delete globalThis.window.ItemsRenderer;
    delete globalThis.window.PreviewManager;
    delete globalThis.window.ViolationAudit;
    delete globalThis.window.textBlockManager;
});

const sampleContent = () => ({
    metadata: { updated_at: '2026-01-01T00:00:00Z' },
    // Непустое дерево (минимум 1 ребёнок) — иначе _applyActContent
    // вызовет AppState.initializeTree(), которого нет в test-стабе.
    tree: { id: 'root', children: [{ id: 'sec-1', type: 'item', children: [] }] },
    tables: {},
    textBlocks: {},
    violations: {},
    changelog: [],
    invoiceNodeIds: [],
});

const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('regression: _applyActContent сбрасывает _isSyncedWithDB после загрузки', async () => {
    // Сценарий: до AI-операции у пользователя остались несохранённые
    // правки (или просто включён tracking и _state='unsaved' от прошлой
    // сессии). Это имитирует обычное состояние конструктора.
    StorageManager.markAsUnsaved();
    assert.equal(StorageManager._isSyncedWithDB, false,
        'precondition: до _applyActContent акт грязный');

    await APIClient._applyActContent(7, sampleContent());
    await waitFor(20);

    assert.equal(StorageManager._isSyncedWithDB, true,
        'После _applyActContent акт должен быть синхронизирован с БД');
    assert.equal(StorageManager._hasUnsavedChanges, false,
        '_hasUnsavedChanges должен быть сброшен');
    assert.equal(markAsSyncedWithDBCalls, 1,
        'markAsSyncedWithDB должен быть вызван ровно 1 раз');
});

test('regression: refresh_act (AI-операция) оставляет акт синхронизированным', async () => {
    // Имитация полного цикла: фасад loadActContent вызывает _applyActContent.
    StorageManager.markAsUnsaved();
    APIClient._fetchWithTimeout = async () => ({
        ok: true,
        status: 200,
        json: async () => sampleContent(),
    });
    await APIClient.loadActContent(7);
    await waitFor(20);
    assert.equal(StorageManager._isSyncedWithDB, true,
        'После loadActContent (_fetchActContent + _applyActContent) — saved');
    assert.equal(markAsSyncedWithDBCalls, 1,
        'markAsSyncedWithDB вызван 1 раз за полный цикл');
});

test('regression: если FontNormalizer изменил данные — после синхронизации вновь unsaved', async () => {
    // Нормализация (например, шрифта) может реально изменить данные.
    // Тогда после _applyActContent нужно: сначала markAsSyncedWithDB,
    // затем markAsUnsaved (т.к. изменения локальные).
    StorageManager.markAsUnsaved();
    globalThis.window.normalizeFontSizes = () => ({ changed: true, count: 3 });
    markAsUnsavedCalls = 0;  // сбросить после precondition
    await APIClient._applyActContent(7, sampleContent());
    await waitFor(20);
    // Финальный _state должен быть 'unsaved' (т.к. fontNorm.changed).
    assert.equal(StorageManager._isSyncedWithDB, false,
        'После normalize акт снова грязный');
    assert.equal(markAsUnsavedCalls >= 1, true,
        'markAsUnsaved должен быть вызван хотя бы раз');
    assert.equal(markAsSyncedWithDBCalls, 1,
        'markAsSyncedWithDB вызван ровно 1 раз перед повторным unsaved');
});

test('regression: в read-only mode markAsUnsaved не вызывается после normalize', async () => {
    // Зритель без прав на PUT — нормализация не должна помечать unsaved,
    // иначе beforeunload будет срабатывать на ровном месте.
    StorageManager.markAsUnsaved();
    AppConfig.readOnlyMode.isReadOnly = true;
    globalThis.window.normalizeFontSizes = () => ({ changed: true, count: 3 });
    // Сбрасываем счётчик ПОСЛЕ precondition (markAsUnsaved от setup).
    markAsUnsavedCalls = 0;
    await APIClient._applyActContent(7, sampleContent());
    await waitFor(20);
    assert.equal(StorageManager._isSyncedWithDB, true,
        'В read-only акт остаётся синхронизированным даже при normalize.changed');
    assert.equal(markAsUnsavedCalls, 0,
        'markAsUnsaved НЕ должен вызываться в read-only mode');
});

test('regression: applyRestoredDraftState идёт ПОСЛЕ markAsSyncedWithDB (черновик остаётся unsaved)', async () => {
    // applyRestoredDraftState() идёт ПОСЛЕ markAsSyncedWithDB().
    // Проверяем, что финальное состояние = unsaved (черновик ещё не в БД).
    StorageManager.markAsUnsaved();
    APIClient._maybeRestoreDraft = async () => true;  // draft восстановлен
    await APIClient._applyActContent(7, sampleContent());
    await waitFor(20);
    assert.equal(StorageManager._isSyncedWithDB, false,
        'При восстановленном draft акт остаётся unsaved');
    assert.equal(StorageManager._hasUnsavedChanges, true,
        '_hasUnsavedChanges остаётся true');
});

test('regression: после AI-операции несколько раз подряд — каждая сбрасывает dirty', async () => {
    // Симулируем 3 последовательные AI-операции: каждая вызывает refresh_act.
    for (let i = 0; i < 3; i++) {
        StorageManager.markAsUnsaved();  // имитация ручной правки
        await APIClient._applyActContent(7, sampleContent());
        await waitFor(20);
        assert.equal(StorageManager._isSyncedWithDB, true,
            `После операции #${i + 1} акт синхронизирован`);
    }
    assert.equal(markAsSyncedWithDBCalls, 3,
        'markAsSyncedWithDB вызван 3 раза (по одному на операцию)');
});
