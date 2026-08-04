/**
 * №8 код-ревью: sanitizeReport.changed должен помечать акт несохранённым.
 *
 * sanitizeActContent (M.13-фронт) лечит несогласованные данные (сироты
 * словарей, устаревшие бэк-референсы) ПРЯМО в content внутри _applyActContent,
 * но результат нигде не персистился: акт не помечался unsaved, и каждое
 * следующее открытие лечило те же данные заново (идентичный серверный отчёт
 * уходил в лог раз за разом). Фикс — тот же паттерн, что уже применяется для
 * fontNorm/violationsNorm (api.js, setTimeout после re-enable tracking): если
 * sanitizeReport.changed и акт не read-only — StorageManager.markAsUnsaved().
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { APIClient } from '../../static/js/shared/api.js';
import { AppConfig } from '../../static/js/shared/app-config.js';

const originalMaybeRestoreDraft = APIClient._maybeRestoreDraft;
const originalTimings = AppConfig.timings.enableTrackingAfterLoad;
const originalIsReadOnly = AppConfig.readOnlyMode.isReadOnly;
const originalUserRole = AppConfig.readOnlyMode.userRole;
const originalAppState = window.AppState;
const originalStorageManager = window.StorageManager;

let markAsUnsavedCalls;

beforeEach(() => {
  markAsUnsavedCalls = 0;
  // Черновик вне скоупа этого теста — обходим весь диалог восстановления.
  APIClient._maybeRestoreDraft = async () => false;
  // Без задержки: тест ждёт срабатывания через один макротаск.
  AppConfig.timings.enableTrackingAfterLoad = 0;
  AppConfig.readOnlyMode.isReadOnly = false;
  AppConfig.readOnlyMode.userRole = null;
  window.AppState = {
    treeData: null,
    tables: {},
    textBlocks: {},
    violations: {},
    initializeTree() {},
    generateNumbering() {},
  };
  window.StorageManager = {
    setBaseUpdatedAt() {},
    disableTracking() {},
    enableTracking() {},
    markAsUnsaved() { markAsUnsavedCalls++; },
    applyRestoredDraftState() {},
  };
});

afterEach(() => {
  APIClient._maybeRestoreDraft = originalMaybeRestoreDraft;
  AppConfig.timings.enableTrackingAfterLoad = originalTimings;
  AppConfig.readOnlyMode.isReadOnly = originalIsReadOnly;
  AppConfig.readOnlyMode.userRole = originalUserRole;
  window.AppState = originalAppState;
  window.StorageManager = originalStorageManager;
});

/** Ждём срабатывания setTimeout(..., enableTrackingAfterLoad) внутри _applyActContent. */
function flushEnableTrackingTimeout() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

test('sanitizeReport.changed=true (вылеченный бэк-референс) → markAsUnsaved вызван', async () => {
  const content = {
    metadata: { updated_at: '2026-08-04T00:00:00.000000' },
    tree: {
      id: 'root', label: 'Акт',
      children: [{ id: 'n1', type: 'table', tableId: 't1', children: [] }],
    },
    tables: { t1: { id: 't1', nodeId: 'призрак', grid: [] } }, // будет вылечено на n1
    textBlocks: {},
    violations: {},
  };

  await APIClient._applyActContent(7, content);
  await flushEnableTrackingTimeout();

  assert.equal(content.tables.t1.nodeId, 'n1', 'санитайзер действительно вылечил запись (проверка сетапа)');
  assert.equal(markAsUnsavedCalls, 1);
});

test('sanitizeReport.changed=true (отброшенная сирота) → markAsUnsaved вызван', async () => {
  const content = {
    metadata: { updated_at: '2026-08-04T00:00:00.000000' },
    tree: { id: 'root', label: 'Акт', children: [] },
    tables: { t_orphan: { id: 't_orphan', nodeId: 'нет_такого_узла', grid: [] } },
    textBlocks: {},
    violations: {},
  };

  await APIClient._applyActContent(7, content);
  await flushEnableTrackingTimeout();

  assert.equal(content.tables.t_orphan, undefined, 'сирота дропнута (проверка сетапа)');
  assert.equal(markAsUnsavedCalls, 1);
});

test('sanitizeReport.changed=false (данные уже согласованы) → markAsUnsaved НЕ вызван', async () => {
  const content = {
    metadata: { updated_at: '2026-08-04T00:00:00.000000' },
    tree: {
      id: 'root', label: 'Акт',
      children: [{ id: 'n1', type: 'table', tableId: 't1', children: [] }],
    },
    tables: { t1: { id: 't1', nodeId: 'n1', grid: [] } }, // уже согласовано, лечить нечего
    textBlocks: {},
    violations: {},
  };

  await APIClient._applyActContent(7, content);
  await flushEnableTrackingTimeout();

  assert.equal(markAsUnsavedCalls, 0);
});

test('sanitizeReport.changed=true, но read-only → markAsUnsaved НЕ вызван (как у fontNorm/violationsNorm)', async () => {
  AppConfig.readOnlyMode.isReadOnly = true;
  const content = {
    metadata: { updated_at: '2026-08-04T00:00:00.000000' },
    tree: {
      id: 'root', label: 'Акт',
      children: [{ id: 'n1', type: 'table', tableId: 't1', children: [] }],
    },
    tables: { t1: { id: 't1', nodeId: 'призрак', grid: [] } },
    textBlocks: {},
    violations: {},
    userPermission: { canEdit: false, role: 'Участник' },
  };
  // read-only banner трогает document.body.insertBefore, которого нет в
  // browser-stub'е — подменяем на no-op, баннер вне скоупа этого теста.
  const originalShowBanner = APIClient._showReadOnlyBanner;
  APIClient._showReadOnlyBanner = () => {};

  try {
    await APIClient._applyActContent(7, content);
    await flushEnableTrackingTimeout();

    assert.equal(content.tables.t1.nodeId, 'n1', 'санитайзер вылечил запись независимо от read-only (проверка сетапа)');
    assert.equal(markAsUnsavedCalls, 0, 'read-only акт не помечается unsaved (нет прав на PUT)');
  } finally {
    APIClient._showReadOnlyBanner = originalShowBanner;
  }
});
