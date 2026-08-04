/**
 * Тесты чистого расчёта масштаба fit-to-width (computeFitScale).
 *
 * computeFitScale возвращает долю ширины панели к натуральной ширине листа:
 * по умолчанию лист ЗАПОЛНЯЕТ ширину панели (масштаб может быть >1 на широкой
 * панели). Опциональный maxScale ограничивает рост сверху. Безопасен к
 * нулю/отрицательным/NaN/Infinity-значениям (вернёт 1, а не ломает рендер).
 * Логика чистая, без DOM — модуль под node:test импортируется безопасно
 * благодаря window-guard'у.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFitScale,
  isNegligibleRefit,
} from '../../static/js/constructor/preview/preview-fit.js';

test('узкая панель: масштаб = доля ширины (<1)', () => {
  assert.equal(computeFitScale(400, 800), 0.5);
});

test('широкая панель заполняет ширину (масштаб >1)', () => {
  assert.equal(computeFitScale(1600, 800), 2);
});

test('точное совпадение ширины даёт 100%', () => {
  assert.equal(computeFitScale(800, 800), 1);
});

test('заполнение ширины без капа: 1000/500 = 2', () => {
  assert.equal(computeFitScale(1000, 500), 2);
});

test('maxScale ограничивает рост сверху: 1000/500 кап 1.4 = 1.4', () => {
  assert.equal(computeFitScale(1000, 500, 1.4), 1.4);
});

test('нулевая натуральная ширина → 1 (защита)', () => {
  assert.equal(computeFitScale(400, 0), 1);
});

test('отрицательная натуральная ширина → 1 (защита)', () => {
  assert.equal(computeFitScale(400, -5), 1);
});

test('NaN ширины панели → 1 (защита)', () => {
  assert.equal(computeFitScale(NaN, 800), 1);
});

test('Infinity ширины панели → 1 (защита)', () => {
  assert.equal(computeFitScale(Infinity, 800), 1);
});

test('нулевая ширина панели → 1 (защита)', () => {
  assert.equal(computeFitScale(0, 800), 1);
});

// --- isNegligibleRefit: гейт переприменения масштаба ---

test('refit: первый расчёт (applied=null) всегда применяется', () => {
  assert.equal(isNegligibleRefit(null, 794, 1123, 1.02), false);
});

test('refit: субпиксельный сдвиг масштаба (<0.5px ширины) пропускается', () => {
  const applied = { natW: 794, natH: 1123, k: 1.0281 };
  // Δk×natW = 0.0004×794 ≈ 0.32px < 0.5px → дребезг, не переприменяем.
  assert.equal(isNegligibleRefit(applied, 794, 1123, 1.0285), true);
});

test('refit: заметный сдвиг масштаба применяется', () => {
  const applied = { natW: 794, natH: 1123, k: 1.0281 };
  // Скроллбар (−15px панели): Δk×natW ≈ 15px — обязаны применить.
  assert.equal(isNegligibleRefit(applied, 794, 1123, 1.047), false);
});

test('refit: изменение натуральной высоты листа применяется даже при том же k', () => {
  const applied = { natW: 794, natH: 1123, k: 1.0281 };
  assert.equal(isNegligibleRefit(applied, 794, 1500, 1.0281), false);
});

test('refit: изменение натуральной ширины листа применяется', () => {
  const applied = { natW: 794, natH: 1123, k: 1.0281 };
  assert.equal(isNegligibleRefit(applied, 800, 1123, 1.0281), false);
});

test('refit: полное совпадение пропускается', () => {
  const applied = { natW: 794, natH: 1123, k: 1.0281 };
  assert.equal(isNegligibleRefit(applied, 794, 1123, 1.0281), true);
});
