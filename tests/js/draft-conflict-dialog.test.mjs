/**
 * Тесты диалога конфликта черновика в APIClient._maybeRestoreDraft (H3/OCC).
 *
 * Исходы диалога конфликта для ОБЫЧНОГО снимка:
 *  - «Восстановить мой черновик» (true) — данные снимка подставляются в content;
 *  - «Оставить версию из БД» (false, явная кнопка) — снимок удаляется;
 *  - Escape/клик мимо ('dismissed') — версия БД грузится, а снимок
 *    ПЕРЕМЕЩАЕТСЯ в бэкап-ключ (stashConflictSnapshot): на прежнем месте его
 *    перезаписал бы первый же markAsUnsaved DB-контентом со свежей базой.
 *
 * БЭКАП конфликтного черновика (audit_workstation_conflict:{actId})
 * проверяется, когда обычного снимка нет: конфликтен → тот же диалог
 * (restore → данные+удалить бэкап; «Оставить версию из БД» → удалить бэкап;
 * dismiss → бэкап остаётся); совпал по content_version с сервером → обычный
 * restore-диалог.
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { APIClient } from '../../static/js/shared/api.js';
import { StorageManager } from '../../static/js/constructor/storage-manager.js';
import { DialogManager } from '../../static/js/shared/dialog/dialog-confirm.js';

const realRead = StorageManager.readSnapshot;
const realRemove = StorageManager.removeSnapshot;
const realStash = StorageManager.stashConflictSnapshot;
const realReadBackup = StorageManager.readConflictBackup;
const realRemoveBackup = StorageManager.removeConflictBackup;
const realShow = DialogManager.show;

const SERVER_VERSION = 7;
const DRAFT_TREE = { id: 'root', children: [{ id: 'draft-node' }] };
const BACKUP_TREE = { id: 'root', children: [{ id: 'backup-node' }] };

let removeCalls;
let stashCalls;
let removeBackupCalls;
let shownOptions;

/** Снимок: вердикт 'conflict' (base ≠ server) или 'restore' (совпадают). */
function makeSnapshot(baseContentVersion, tree = DRAFT_TREE) {
  return {
    actId: 7,
    savedAt: '2026-08-18T09:00:00.000Z',
    baseContentVersion,
    version: 2,
    data: { tree, tables: {}, textBlocks: {}, violations: {} },
  };
}

/** Контент из GET с метаданными последнего редактора. */
function makeContent() {
  return {
    metadata: { last_edited_by: 'ivanov', last_edited_at: '2026-08-18T12:00:00' },
    tree: { id: 'root', children: [{ id: 'db-node' }] },
  };
}

beforeEach(() => {
  removeCalls = 0;
  stashCalls = 0;
  removeBackupCalls = 0;
  shownOptions = null;
  StorageManager.readSnapshot = () => null;
  StorageManager.removeSnapshot = () => { removeCalls++; };
  StorageManager.stashConflictSnapshot = () => { stashCalls++; };
  StorageManager.readConflictBackup = () => null;
  StorageManager.removeConflictBackup = () => { removeBackupCalls++; };
});

afterEach(() => {
  StorageManager.readSnapshot = realRead;
  StorageManager.removeSnapshot = realRemove;
  StorageManager.stashConflictSnapshot = realStash;
  StorageManager.readConflictBackup = realReadBackup;
  StorageManager.removeConflictBackup = realRemoveBackup;
  DialogManager.show = realShow;
});

// ─── Обычный снимок ──────────────────────────────────────────────────────────

test('конфликт: «Восстановить мой черновик» → данные снимка подставлены в content', async () => {
  StorageManager.readSnapshot = () => makeSnapshot(5);
  DialogManager.show = async (options) => { shownOptions = options; return true; };
  const content = makeContent();

  const restored = await APIClient._maybeRestoreDraft(7, content, SERVER_VERSION);

  assert.equal(restored, true);
  assert.deepEqual(content.tree, DRAFT_TREE, 'дерево заменено данными черновика');
  assert.equal(removeCalls, 0, 'снимок не удалён до успешного PUT');
  assert.match(shownOptions.message, /изменён пользователем ivanov/);
  assert.match(shownOptions.message, /ПЕРЕЗАПИШЕТ/);
  assert.equal(shownOptions.escapeResult, 'dismissed',
    'диалог конфликта различает Escape и явную кнопку отмены');
});

test('конфликт: явная кнопка «Оставить версию из БД» → снимок удалён', async () => {
  StorageManager.readSnapshot = () => makeSnapshot(5);
  DialogManager.show = async () => false;
  const content = makeContent();

  const restored = await APIClient._maybeRestoreDraft(7, content, SERVER_VERSION);

  assert.equal(restored, false);
  assert.equal(removeCalls, 1, 'явный выбор версии БД — черновик больше не нужен');
  assert.equal(stashCalls, 0);
  assert.deepEqual(content.tree, makeContent().tree, 'content не мутирован');
});

test('конфликт: Escape/клик мимо → снимок ПЕРЕМЕЩЁН в бэкап (не остаётся под штатной перезаписью)', async () => {
  StorageManager.readSnapshot = () => makeSnapshot(5);
  DialogManager.show = async () => 'dismissed';
  const content = makeContent();

  const restored = await APIClient._maybeRestoreDraft(7, content, SERVER_VERSION);

  assert.equal(restored, false, 'грузится версия из БД');
  assert.equal(removeCalls, 0, 'снимок не уничтожен');
  assert.equal(stashCalls, 1,
    'снимок отложен в бэкап-ключ — первый же markAsUnsaved не перезапишет конфликтный черновик');
  assert.deepEqual(content.tree, makeContent().tree, 'content не мутирован');
});

test('restore-ветка (версии совпали): прежняя семантика — отказ/закрытие удаляет снимок', async () => {
  StorageManager.readSnapshot = () => makeSnapshot(SERVER_VERSION);
  DialogManager.show = async (options) => { shownOptions = options; return false; };

  const restored = await APIClient._maybeRestoreDraft(7, makeContent(), SERVER_VERSION);

  assert.equal(restored, false);
  assert.equal(removeCalls, 1, 'в обычном restore-диалоге отказ по-прежнему удаляет снимок');
  assert.equal(shownOptions.escapeResult, undefined,
    'escapeResult в restore-диалог не передаётся — Escape там равен отказу');
});

test('конфликт без имени редактора в metadata → «другим пользователем»', async () => {
  StorageManager.readSnapshot = () => makeSnapshot(5);
  DialogManager.show = async (options) => { shownOptions = options; return 'dismissed'; };

  await APIClient._maybeRestoreDraft(7, { metadata: {} }, SERVER_VERSION);

  assert.match(shownOptions.message, /изменён другим пользователем/);
});

// ─── Бэкап конфликтного черновика ────────────────────────────────────────────

test('бэкап конфликтен: restore → данные из бэкапа + бэкап удалён', async () => {
  StorageManager.readConflictBackup = () => makeSnapshot(5, BACKUP_TREE);
  DialogManager.show = async (options) => { shownOptions = options; return true; };
  const content = makeContent();

  const restored = await APIClient._maybeRestoreDraft(7, content, SERVER_VERSION);

  assert.equal(restored, true);
  assert.deepEqual(content.tree, BACKUP_TREE, 'подставлены данные бэкапа');
  assert.equal(removeBackupCalls, 1, 'бэкап удалён — правки стали обычным несинхронизированным состоянием');
  assert.match(shownOptions.message, /ПЕРЕЗАПИШЕТ/, 'тот же диалог конфликта');
});

test('бэкап конфликтен: «Оставить версию из БД» → бэкап удалён', async () => {
  StorageManager.readConflictBackup = () => makeSnapshot(5, BACKUP_TREE);
  DialogManager.show = async () => false;

  const restored = await APIClient._maybeRestoreDraft(7, makeContent(), SERVER_VERSION);

  assert.equal(restored, false);
  assert.equal(removeBackupCalls, 1);
});

test('бэкап конфликтен: dismiss → бэкап остаётся до следующего открытия', async () => {
  StorageManager.readConflictBackup = () => makeSnapshot(5, BACKUP_TREE);
  DialogManager.show = async () => 'dismissed';

  const restored = await APIClient._maybeRestoreDraft(7, makeContent(), SERVER_VERSION);

  assert.equal(restored, false);
  assert.equal(removeBackupCalls, 0, 'бэкап не тронут — диалог вернётся');
  assert.equal(stashCalls, 0, 'перекладывать бэкап в бэкап не нужно');
});

test('бэкап совпал по content_version с сервером → обычный restore-диалог', async () => {
  // Кто-то откатил версию / с тех пор контент не менялся: конфликт исчез.
  StorageManager.readConflictBackup = () => makeSnapshot(SERVER_VERSION, BACKUP_TREE);
  DialogManager.show = async (options) => { shownOptions = options; return true; };
  const content = makeContent();

  const restored = await APIClient._maybeRestoreDraft(7, content, SERVER_VERSION);

  assert.equal(restored, true);
  assert.deepEqual(content.tree, BACKUP_TREE);
  assert.equal(removeBackupCalls, 1, 'бэкап удалён после восстановления');
  assert.match(shownOptions.message, /Найден несохранённый черновик/, 'обычный диалог, не конфликтный');
  assert.equal(shownOptions.escapeResult, undefined);
});

test('бэкап структурно бит → молча удаляется, диалога нет', async () => {
  StorageManager.readConflictBackup = () => ({ savedAt: 'x', baseContentVersion: 5, data: null });
  let dialogShown = false;
  DialogManager.show = async () => { dialogShown = true; return false; };

  const restored = await APIClient._maybeRestoreDraft(7, makeContent(), SERVER_VERSION);

  assert.equal(restored, false);
  assert.equal(removeBackupCalls, 1, 'битый бэкап удалён');
  assert.equal(dialogShown, false);
});

test('discard обычного снимка не мешает предложить валидный бэкап', async () => {
  StorageManager.readSnapshot = () => ({ savedAt: 'x', data: null }); // битый → discard
  StorageManager.readConflictBackup = () => makeSnapshot(5, BACKUP_TREE);
  DialogManager.show = async () => true;
  const content = makeContent();

  const restored = await APIClient._maybeRestoreDraft(7, content, SERVER_VERSION);

  assert.equal(restored, true, 'после discard основного снимка бэкап всё равно предложен');
  assert.equal(removeCalls, 1, 'битый основной снимок удалён');
  assert.deepEqual(content.tree, BACKUP_TREE);
});

test('при валидном обычном снимке бэкап в этой сессии не трогается', async () => {
  StorageManager.readSnapshot = () => makeSnapshot(SERVER_VERSION);
  let backupRead = false;
  StorageManager.readConflictBackup = () => { backupRead = true; return null; };
  DialogManager.show = async () => true;

  const restored = await APIClient._maybeRestoreDraft(7, makeContent(), SERVER_VERSION);

  assert.equal(restored, true);
  assert.equal(backupRead, false, 'основной снимок главнее — бэкап не читается');
});
