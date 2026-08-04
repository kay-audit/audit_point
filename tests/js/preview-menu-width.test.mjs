/**
 * Ширина модального предпросмотра (#previewMenu): базовое значение и его запись.
 *
 * Базовая ширина — половина окна. Она берётся при отсутствии сохранённой и к
 * ней возвращает двойной клик по ручке ресайза.
 *
 * Отдельно закрыт баг сброса: _saveWidth читал offsetWidth, а после _setWidth
 * ширина ещё анимируется transition'ом — в localStorage уходило ПРЕЖНЕЕ
 * значение, и базовая ширина не переживала перезагрузку страницы.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PreviewMenuManager } from '../../static/js/constructor/header/preview-menu.js';

/** Менеджер без init(): DOM не нужен, проверяется только арифметика ширины. */
function makeManager({ offsetWidth, defaultWidth }) {
  const manager = Object.create(PreviewMenuManager.prototype);
  manager.menu = { offsetWidth, style: {} };
  manager.defaultWidth = defaultWidth;
  return manager;
}

/** Подменяет localStorage на запоминающий; возвращает восстановитель. */
function captureStorage(store) {
  const original = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = v;
    },
    removeItem: (k) => {
      delete store[k];
    },
  };
  return () => {
    globalThis.localStorage = original;
  };
}

test('базовая ширина — половина окна', () => {
  const originalInnerWidth = globalThis.innerWidth;
  const originalError = console.error;
  globalThis.innerWidth = 1600;
  console.error = () => {}; // init() без DOM ругается и выходит — это ожидаемо
  try {
    const manager = new PreviewMenuManager();
    assert.equal(manager.defaultWidth, 800);
  } finally {
    console.error = originalError;
    globalThis.innerWidth = originalInnerWidth;
  }
});

test('сброс к базовой ширине сохраняет базовую, а не анимируемую', () => {
  const store = {};
  const restore = captureStorage(store);
  try {
    const manager = makeManager({ offsetWidth: 1500, defaultWidth: 960 });
    manager._resetWidth();
    assert.equal(manager.menu.style.width, '960px');
    assert.equal(store['preview-menu-width'], '960');
  } finally {
    restore();
  }
});

test('без аргумента сохраняется фактическая ширина', () => {
  const store = {};
  const restore = captureStorage(store);
  try {
    const manager = makeManager({ offsetWidth: 1234, defaultWidth: 960 });
    manager._saveWidth();
    assert.equal(store['preview-menu-width'], '1234');
  } finally {
    restore();
  }
});

test('дробная половина окна округляется при сохранении', () => {
  const store = {};
  const restore = captureStorage(store);
  try {
    const manager = makeManager({ offsetWidth: 1500, defaultWidth: 683.5 });
    manager._resetWidth();
    assert.equal(store['preview-menu-width'], '684');
  } finally {
    restore();
  }
});
