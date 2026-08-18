/**
 * Тесты диалога конфликта черновика в APIClient._maybeRestoreDraft (H3).
 *
 * Три исхода диалога конфликта:
 *  - «Восстановить мой черновик» (true) — данные снимка подставляются в content;
 *  - «Оставить версию из БД» (false, явная кнопка) — снимок удаляется;
 *  - Escape/клик мимо диалога ('dismissed' через escapeResult) — версия БД
 *    грузится, но снимок ОСТАЁТСЯ: случайное закрытие не должно молча
 *    уничтожать черновик, диалог вернётся при следующем открытии.
 * Ветка обычного restore-диалога (метки совпали) сохраняет прежнюю семантику:
 * любое закрытие без подтверждения удаляет снимок.
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { APIClient } from '../../static/js/shared/api.js';
import { StorageManager } from '../../static/js/constructor/storage-manager.js';
import { DialogManager } from '../../static/js/shared/dialog/dialog-confirm.js';

const realRead = StorageManager.readSnapshot;
const realRemove = StorageManager.removeSnapshot;
const realShow = DialogManager.show;

const SERVER_UPDATED_AT = '2026-08-18T12:00:00.000000';
const DRAFT_TREE = { id: 'root', children: [{ id: 'draft-node' }] };

let removeCalls;
let shownOptions;

/** Снимок для вердикта 'conflict' (base ≠ server) или 'restore' (совпадают). */
function stubSnapshot(baseUpdatedAt) {
  StorageManager.readSnapshot = () => ({
    actId: 7,
    savedAt: '2026-08-18T09:00:00.000Z',
    baseUpdatedAt,
    version: 2,
    data: { tree: DRAFT_TREE, tables: {}, textBlocks: {}, violations: {} },
  });
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
  shownOptions = null;
  StorageManager.removeSnapshot = () => { removeCalls++; };
});

afterEach(() => {
  StorageManager.readSnapshot = realRead;
  StorageManager.removeSnapshot = realRemove;
  DialogManager.show = realShow;
});

test('конфликт: «Восстановить мой черновик» → данные снимка подставлены в content', async () => {
  stubSnapshot('2026-08-18T08:00:00.000000');
  DialogManager.show = async (options) => { shownOptions = options; return true; };
  const content = makeContent();

  const restored = await APIClient._maybeRestoreDraft(7, content, SERVER_UPDATED_AT);

  assert.equal(restored, true);
  assert.deepEqual(content.tree, DRAFT_TREE, 'дерево заменено данными черновика');
  assert.equal(removeCalls, 0, 'снимок не удалён до успешного PUT');
  assert.match(shownOptions.message, /изменён пользователем ivanov/);
  assert.match(shownOptions.message, /ПЕРЕЗАПИШЕТ/);
  assert.equal(shownOptions.escapeResult, 'dismissed',
    'диалог конфликта различает Escape и явную кнопку отмены');
});

test('конфликт: явная кнопка «Оставить версию из БД» → снимок удалён', async () => {
  stubSnapshot('2026-08-18T08:00:00.000000');
  DialogManager.show = async () => false;
  const content = makeContent();

  const restored = await APIClient._maybeRestoreDraft(7, content, SERVER_UPDATED_AT);

  assert.equal(restored, false);
  assert.equal(removeCalls, 1, 'явный выбор версии БД — черновик больше не нужен');
  assert.deepEqual(content.tree, makeContent().tree, 'content не мутирован');
});

test('конфликт: Escape/клик мимо диалога → версия БД, но снимок ОСТАЁТСЯ', async () => {
  stubSnapshot('2026-08-18T08:00:00.000000');
  DialogManager.show = async () => 'dismissed';
  const content = makeContent();

  const restored = await APIClient._maybeRestoreDraft(7, content, SERVER_UPDATED_AT);

  assert.equal(restored, false, 'грузится версия из БД');
  assert.equal(removeCalls, 0,
    'случайное закрытие не уничтожает черновик — диалог вернётся при следующем открытии');
  assert.deepEqual(content.tree, makeContent().tree, 'content не мутирован');
});

test('restore-ветка (метки совпали): прежняя семантика — отказ/закрытие удаляет снимок', async () => {
  stubSnapshot(SERVER_UPDATED_AT);
  DialogManager.show = async (options) => { shownOptions = options; return false; };
  const content = makeContent();

  const restored = await APIClient._maybeRestoreDraft(7, content, SERVER_UPDATED_AT);

  assert.equal(restored, false);
  assert.equal(removeCalls, 1, 'в обычном restore-диалоге отказ по-прежнему удаляет снимок');
  assert.equal(shownOptions.escapeResult, undefined,
    'escapeResult в restore-диалог не передаётся — Escape там равен отказу');
});

test('конфликт без имени редактора в metadata → «другим пользователем»', async () => {
  stubSnapshot('2026-08-18T08:00:00.000000');
  DialogManager.show = async (options) => { shownOptions = options; return 'dismissed'; };

  await APIClient._maybeRestoreDraft(7, { metadata: {} }, SERVER_UPDATED_AT);

  assert.match(shownOptions.message, /изменён другим пользователем/);
});
