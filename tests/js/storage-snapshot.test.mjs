/**
 * Тесты формы и жизненного цикла снимка-черновика в localStorage (M.8, pfe-1, H3).
 *
 * Гарантии:
 *  - снимок пишется под per-act ключом `audit_workstation_state:{actId}`;
 *  - форма снимка: {actId, savedAt, baseUpdatedAt (справочное),
 *    baseContentVersion (база OCC), version, data},
 *    data = результат ЕДИНОГО AppState.exportData() (тот же сериализатор,
 *    что и body PUT /content);
 *  - при записи удаляются снимки других актов и legacy-ключи старого формата;
 *  - в состоянии 'saved' (всё синхронизировано) снимок не пишется;
 *  - повреждённый снимок при чтении удаляется;
 *  - applyRestoredDraftState помечает восстановленный черновик
 *    несинхронизированным и переписывает снимок;
 *  - бэкап конфликтного черновика (`audit_workstation_conflict:{actId}`):
 *    stashConflictSnapshot перемещает снимок в бэкап-ключ, протухшие бэкапы
 *    чистятся тем же TTL, что чужие снимки.
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { StorageManager } from '../../static/js/constructor/storage-manager.js';
import { AppState } from '../../static/js/constructor/state/state-core.js';

/** Функциональная замена localStorage-стаба (стаб из _browser-stub — no-op). */
function makeFakeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
  };
}

beforeEach(() => {
  globalThis.localStorage = makeFakeLocalStorage();
  globalThis.currentActId = 7;
  AppState.treeData = { id: 'root', label: 'Акт', type: 'item', children: [] };
  AppState.tables = {};
  AppState.textBlocks = {};
  AppState.violations = {};
  StorageManager.setBaseUpdatedAt('2026-06-11T10:00:00.123456');
  StorageManager.setBaseContentVersion(5);
  StorageManager._setState('unsaved');
});

afterEach(() => {
  StorageManager.destroy();
  StorageManager._setState('saved');
  StorageManager.setBaseUpdatedAt(null);
  StorageManager.setBaseContentVersion(null);
  globalThis.currentActId = null;
});

test('saveState пишет снимок под per-act ключом с полной формой envelope', () => {
  const ok = StorageManager.saveState(true);

  assert.equal(ok, true);
  const raw = localStorage.getItem('audit_workstation_state:7');
  assert.ok(raw, 'снимок должен лежать под ключом audit_workstation_state:7');

  const snapshot = JSON.parse(raw);
  assert.equal(snapshot.actId, 7);
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.baseUpdatedAt, '2026-06-11T10:00:00.123456');
  assert.equal(snapshot.baseContentVersion, 5, 'база OCC — в конверте снимка');
  assert.ok(Number.isFinite(Date.parse(snapshot.savedAt)), 'savedAt — валидная ISO-метка');

  // data — результат exportData(): тот же сериализатор, что и body PUT
  assert.deepEqual(
    Object.keys(snapshot.data).sort(),
    ['invoiceNodeIds', 'tables', 'textBlocks', 'tree', 'violations']
  );
  assert.equal(snapshot.data.tree.id, 'root');
  assert.deepEqual(snapshot.data, AppState.exportData());
});

test('PERSIST-3: запись снимка акта N сохраняет СВЕЖИЙ чужой снимок, удаляет протухший/битый и legacy', () => {
  const now = Date.now();
  const freshSavedAt = new Date(now - 60 * 1000).toISOString();                 // минуту назад
  const staleSavedAt = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();   // 8 дней назад
  // Свежий несинхронизированный черновик акта 5, открытого в соседней вкладке.
  localStorage.setItem('audit_workstation_state:5', JSON.stringify({ actId: 5, savedAt: freshSavedAt }));
  // Протухший (заброшенный) чужой снимок акта 6.
  localStorage.setItem('audit_workstation_state:6', JSON.stringify({ actId: 6, savedAt: staleSavedAt }));
  // Повреждённый чужой снимок акта 8 — восстановить нечего.
  localStorage.setItem('audit_workstation_state:8', '{битый json');
  localStorage.setItem('audit_workstation_state', '{"legacy":true}');
  localStorage.setItem('audit_workstation_timestamp', '2026-01-01T00:00:00Z');
  localStorage.setItem('посторонний_ключ', 'не трогать');

  StorageManager.saveState(true);

  // Свежий чужой снимок НЕ стёрт — иначе потеряли бы правки соседней вкладки.
  assert.ok(localStorage.getItem('audit_workstation_state:5'), 'свежий чужой снимок выживает');
  // Протухший и повреждённый — удалены для высвобождения места.
  assert.equal(localStorage.getItem('audit_workstation_state:6'), null, 'протухший чужой снимок удалён');
  assert.equal(localStorage.getItem('audit_workstation_state:8'), null, 'битый чужой снимок удалён');
  // Legacy-ключи единого снимка — удаляются всегда.
  assert.equal(localStorage.getItem('audit_workstation_state'), null);
  assert.equal(localStorage.getItem('audit_workstation_timestamp'), null);
  // Снимок текущего акта записан; посторонний ключ не тронут.
  assert.ok(localStorage.getItem('audit_workstation_state:7'));
  assert.equal(localStorage.getItem('посторонний_ключ'), 'не трогать');
});

test('PERSIST-3: чужой снимок ровно на границе TTL сохраняется, за границей — удаляется', () => {
  const now = Date.now();
  const ttl = StorageManager.FOREIGN_SNAPSHOT_TTL_MS;
  // На 1 секунду моложе TTL — ещё свежий.
  localStorage.setItem('audit_workstation_state:5',
    JSON.stringify({ actId: 5, savedAt: new Date(now - ttl + 1000).toISOString() }));
  // На 1 секунду старше TTL — протух.
  localStorage.setItem('audit_workstation_state:6',
    JSON.stringify({ actId: 6, savedAt: new Date(now - ttl - 1000).toISOString() }));

  StorageManager.saveState(true);

  assert.ok(localStorage.getItem('audit_workstation_state:5'), 'в пределах TTL — сохранён');
  assert.equal(localStorage.getItem('audit_workstation_state:6'), null, 'за пределами TTL — удалён');
});

test('в состоянии saved (всё синхронизировано) снимок не пишется', () => {
  StorageManager._setState('saved');

  const ok = StorageManager.saveState(true);

  assert.equal(ok, true);
  assert.equal(localStorage.getItem('audit_workstation_state:7'), null);
});

test('без открытого акта снимок не пишется', () => {
  globalThis.currentActId = null;

  const ok = StorageManager.saveState(true);

  assert.equal(ok, false);
  assert.equal(localStorage.length, 0);
});

test('readSnapshot возвращает снимок, повреждённый JSON удаляет и отдаёт null', () => {
  StorageManager.saveState(true);
  const snap = StorageManager.readSnapshot(7);
  assert.equal(snap.actId, 7);

  localStorage.setItem('audit_workstation_state:7', '{битый json');
  assert.equal(StorageManager.readSnapshot(7), null);
  assert.equal(localStorage.getItem('audit_workstation_state:7'), null, 'битый снимок удалён');
});

test('removeSnapshot удаляет снимок акта', () => {
  StorageManager.saveState(true);
  StorageManager.removeSnapshot(7);
  assert.equal(localStorage.getItem('audit_workstation_state:7'), null);
});

test('saveState после удаления → состояние local-only (жёлтый)', () => {
  StorageManager.saveState(true);
  assert.equal(StorageManager._state, 'local-only');
  assert.equal(StorageManager.hasUnsavedChanges(), false);
  assert.equal(StorageManager.hasUnsyncedChanges(), true);
});

test('applyRestoredDraftState помечает черновик несинхронизированным и пишет снимок', () => {
  StorageManager._setState('saved'); // bootstrap-вызовы markAsSyncedWithDB уже прошли

  StorageManager.applyRestoredDraftState();

  assert.equal(StorageManager._state, 'local-only');
  assert.equal(StorageManager.hasUnsyncedChanges(), true);
  const snap = StorageManager.readSnapshot(7);
  assert.ok(snap, 'снимок переписан свежими метаданными');
  assert.equal(snap.baseUpdatedAt, '2026-06-11T10:00:00.123456');
  assert.equal(snap.baseContentVersion, 5, 'свежая база OCC в переписанном снимке');
});

// ─── Бэкап конфликтного черновика ────────────────────────────────────────────

test('stashConflictSnapshot перемещает снимок в бэкап-ключ (оригинал удаляется)', () => {
  StorageManager.saveState(true);
  const original = StorageManager.readSnapshot(7);

  StorageManager.stashConflictSnapshot(7);

  assert.equal(localStorage.getItem('audit_workstation_state:7'), null,
    'обычный снимок удалён — штатная перезапись его больше не достанет');
  const backup = StorageManager.readConflictBackup(7);
  assert.deepEqual(backup, original, 'бэкап — точная копия снимка');
});

test('stashConflictSnapshot без снимка — no-op', () => {
  StorageManager.stashConflictSnapshot(7);
  assert.equal(StorageManager.readConflictBackup(7), null);
});

test('removeConflictBackup удаляет бэкап; повреждённый бэкап при чтении удаляется', () => {
  StorageManager.saveState(true);
  StorageManager.stashConflictSnapshot(7);
  StorageManager.removeConflictBackup(7);
  assert.equal(localStorage.getItem('audit_workstation_conflict:7'), null);

  localStorage.setItem('audit_workstation_conflict:7', '{битый json');
  assert.equal(StorageManager.readConflictBackup(7), null);
  assert.equal(localStorage.getItem('audit_workstation_conflict:7'), null, 'битый бэкап удалён');
});

test('PERSIST-3/TTL: протухший бэкап конфликта чистится при записи снимка, свежий — выживает', () => {
  const now = Date.now();
  const freshSavedAt = new Date(now - 60 * 1000).toISOString();
  const staleSavedAt = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
  // Свежий бэкап ТЕКУЩЕГО акта (dismiss прошлой сессии) и протухший чужой.
  localStorage.setItem('audit_workstation_conflict:7',
    JSON.stringify({ actId: 7, savedAt: freshSavedAt }));
  localStorage.setItem('audit_workstation_conflict:5',
    JSON.stringify({ actId: 5, savedAt: staleSavedAt }));

  StorageManager.saveState(true);

  assert.ok(localStorage.getItem('audit_workstation_conflict:7'),
    'свежий бэкап — носитель правок, не трогаем (даже текущего акта)');
  assert.equal(localStorage.getItem('audit_workstation_conflict:5'), null,
    'заброшенный бэкап (старше 7 дней) удалён');
});

test('PERSIST-3/TTL: позиции просмотра чистятся тем же TTL — иначе копились бы по одной на акт', () => {
  const now = Date.now();
  // Позиция просмотра пишется на КАЖДЫЙ когда-либо открытый акт, и этот
  // проход — единственная точка уборки per-act ключей.
  localStorage.setItem('audit_workstation_viewpos:5',
    JSON.stringify({ step: 1, savedAt: new Date(now - 60 * 1000).toISOString() }));
  localStorage.setItem('audit_workstation_viewpos:6',
    JSON.stringify({ step: 2, savedAt: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString() }));

  StorageManager.saveState(true);

  assert.ok(localStorage.getItem('audit_workstation_viewpos:5'),
    'свежая позиция (акт в работе) сохраняется');
  assert.equal(localStorage.getItem('audit_workstation_viewpos:6'), null,
    'позиция давно заброшенного акта удалена');
});

test('getLastSaveTimestamp читает savedAt снимка текущего акта', () => {
  assert.equal(StorageManager.getLastSaveTimestamp(), null);
  StorageManager.saveState(true);
  const snap = StorageManager.readSnapshot(7);
  assert.equal(StorageManager.getLastSaveTimestamp(), snap.savedAt);
});

test('clearStorage удаляет все per-act снимки и legacy-ключи', () => {
  StorageManager.saveState(true);
  localStorage.setItem('audit_workstation_state', '{"legacy":true}');
  localStorage.setItem('audit_workstation_timestamp', 'x');

  StorageManager.clearStorage();

  assert.equal(localStorage.getItem('audit_workstation_state:7'), null);
  assert.equal(localStorage.getItem('audit_workstation_state'), null);
  assert.equal(localStorage.getItem('audit_workstation_timestamp'), null);
  assert.equal(StorageManager._state, 'saved');
});
