/**
 * Тесты жизненного цикла слушателей и таймеров StorageManager (pfe-10/12/3).
 *
 * Гарантии:
 *  - pfe-10: destroy() снимает beforeunload (через LifecycleHelper) и click,
 *    а не только гасит таймеры; своего слушателя popstate у StorageManager
 *    нет — событием владеет ActsMenuManager (tests/js/popstate-single-owner.test.mjs);
 *  - pfe-12: повторный init/_setupEventHandlers идемпотентен — старые интервалы
 *    и навигационные слушатели не дублируются (нет утечки двойных таймеров и
 *    PUT-каналов);
 *  - pfe-3: re-entrant вызов saveState во время уже идущего сохранения
 *    пропускается (lock «идёт сохранение») — периодический и явный save не
 *    пишут одновременно с одним снимком.
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { StorageManager } from '../../static/js/constructor/storage-manager.js';
import { LifecycleHelper } from '../../static/js/constructor/lifecycle-helper.js';
import { AppState } from '../../static/js/constructor/state/state-core.js';

/** Функциональный localStorage (стаб из _browser-stub — no-op). */
function makeFakeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
    clear: () => map.clear(),
  };
}

let added;
let removed;

beforeEach(() => {
  globalThis.localStorage = makeFakeLocalStorage();
  globalThis.currentActId = 7;
  AppState.treeData = { id: 'root', label: 'Акт', type: 'item', children: [] };
  AppState.tables = {};
  AppState.textBlocks = {};
  AppState.violations = {};
  AppState._dragInProgress = false;

  added = [];
  removed = [];
  // Перехватываем регистрацию слушателей на window И document.
  globalThis.addEventListener = (type, handler) => added.push({ target: 'window', type, handler });
  globalThis.removeEventListener = (type, handler) => removed.push({ target: 'window', type, handler });
  globalThis.document.addEventListener = (type, handler) => added.push({ target: 'document', type, handler });
  globalThis.document.removeEventListener = (type, handler) => removed.push({ target: 'document', type, handler });
  // history-стабы для _setupNavigationInterception.
  globalThis.history = { replaceState() {}, pushState() {}, back() {} };
  globalThis.location = { href: 'http://test/', hostname: 'test', pathname: '/' };

  LifecycleHelper._handlers.clear();
  StorageManager._setState('saved');
});

afterEach(() => {
  StorageManager.destroy();
  StorageManager._setState('saved');
  LifecycleHelper._handlers.clear();
  delete globalThis.addEventListener;
  delete globalThis.removeEventListener;
  delete globalThis.history;
  delete globalThis.location;
  globalThis.currentActId = null;
});

// ─── pfe-10: destroy снимает слушатели ──────────────────────────────────────

test('pfe-10: destroy снимает beforeunload через LifecycleHelper', () => {
  StorageManager._setupEventHandlers();
  assert.ok(LifecycleHelper.list().includes('storage:unsaved-warning'));

  StorageManager.destroy();
  assert.ok(
    !LifecycleHelper.list().includes('storage:unsaved-warning'),
    'beforeunload-обработчик снят из реестра'
  );
});

test('pfe-10: destroy снимает click', () => {
  StorageManager._setupEventHandlers();

  StorageManager.destroy();

  assert.ok(removed.some((l) => l.type === 'click'), 'click снят');
});

test('pfe-10: снятый click — та же функция, что добавлялась', () => {
  StorageManager._setupEventHandlers();
  const addedClick = added.find((l) => l.type === 'click');

  StorageManager.destroy();

  assert.ok(removed.some((l) => l.type === 'click' && l.handler === addedClick.handler));
});

test('StorageManager не подписывается на popstate — событием владеет ActsMenuManager', () => {
  StorageManager._setupEventHandlers();

  // Прежде страж вешал сюда собственный слушатель и гонялся с переключателем
  // акта: его диалог всплывал уже после того, как переключение сняло лок и
  // подменило AppState. Теперь решение отдаётся владельцу события через
  // confirmHistoryNavigation.
  assert.equal(added.filter((l) => l.type === 'popstate').length, 0);
});

// ─── pfe-12: повторный init идемпотентен ────────────────────────────────────

test('pfe-12: повторный _setupEventHandlers не плодит интервалы (старые погашены)', () => {
  StorageManager._setupEventHandlers();
  const firstSaveInterval = StorageManager._periodicSaveInterval;
  const firstDbInterval = StorageManager._periodicDbSaveInterval;
  assert.ok(firstSaveInterval != null);
  assert.ok(firstDbInterval != null);

  StorageManager._setupEventHandlers();
  // Новые интервалы заведены, старые — другие идентификаторы (пересозданы).
  assert.notEqual(StorageManager._periodicSaveInterval, firstSaveInterval);
  assert.notEqual(StorageManager._periodicDbSaveInterval, firstDbInterval);
});

test('pfe-12: повторный _setupEventHandlers снимает прежний click', () => {
  StorageManager._setupEventHandlers();
  const firstClick = added.find((l) => l.type === 'click').handler;

  StorageManager._setupEventHandlers();

  assert.ok(
    removed.some((l) => l.type === 'click' && l.handler === firstClick),
    'прежний click снят перед повторной регистрацией'
  );
});

test('pfe-12: после двойного init активен ровно один навигационный слушатель', () => {
  StorageManager._setupEventHandlers();
  StorageManager._setupEventHandlers();

  // На каждый тип: added - removed == 1 (одна живая регистрация).
  const liveCount = (type) =>
    added.filter((l) => l.type === type).length - removed.filter((l) => l.type === type).length;
  assert.equal(liveCount('click'), 1);
  assert.equal(liveCount('popstate'), 0, 'StorageManager на popstate не подписан');
});

// ─── pfe-3: lock «идёт сохранение» ──────────────────────────────────────────

test('pfe-3: re-entrant saveState во время сохранения пропускается', () => {
  StorageManager._setState('unsaved');

  let reentrantResult = null;
  let writes = 0;
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (k, v) => {
    writes += 1;
    // Имитируем побочный вызов saveState изнутри сохранения (периодический
    // тик прилетел во время явного save) — он должен быть отброшен guard'ом.
    if (reentrantResult === null) {
      reentrantResult = StorageManager.saveState(true);
    }
    realSetItem(k, v);
  };

  StorageManager.saveState(true);

  assert.equal(reentrantResult, false, 're-entrant save отброшен (lock держит первый)');
  assert.equal(writes, 1, 'снимок записан ровно один раз');
});

test('pfe-3: после завершения save флаг сброшен — следующий save проходит', () => {
  StorageManager._setState('unsaved');
  const ok1 = StorageManager.saveState(true);
  assert.equal(ok1, true);
  assert.equal(StorageManager._saveInProgress, false, 'флаг сброшен после save');

  StorageManager._setState('unsaved');
  const ok2 = StorageManager.saveState(true);
  assert.equal(ok2, true, 'последовательный save не блокируется');
});

test('pfe-3: исключение в saveState сбрасывает флаг (не залипает lock)', () => {
  StorageManager._setState('unsaved');
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = () => { throw new Error('quota'); };

  StorageManager.saveState(true); // упадёт внутри, но не должен оставить lock
  localStorage.setItem = realSetItem;

  assert.equal(StorageManager._saveInProgress, false, 'lock снят даже при ошибке');
});
