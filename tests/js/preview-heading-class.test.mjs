/**
 * Заголовок пункта в предпросмотре размечается классом, а не голым тегом.
 *
 * В Word пункт любой глубины печатается одинаково — 12pt Times жирным
 * (app/domains/acts/formatters/docx/formatter.py::_render_item: Sizes.body_pt +
 * run.bold), глубину несёт номер рубрикатора. Оформление живёт в CSS
 * (`.preview-heading`, static/css/constructor/preview/preview-typography.css),
 * JS отвечает только за структуру: какой тег и какой класс.
 *
 * Класс обязателен, и это не стилистика: allowlist санитайзера пропускает
 * h1–h6 внутрь контента текстблока (static/js/shared/sanitize.js), а такие
 * «чужие» заголовки Word печатает плоским текстом без жирного (_BLOCK_TAGS в
 * docx/builders/inline.py). Правило по голому тегу задело бы и их — поэтому
 * прицел именно в класс. Страж CSS-стороны —
 * tests/test_document_css_font_size_ratchet.py.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PreviewManager } from '../../static/js/constructor/preview/preview.js';
import { AppConfig } from '../../static/js/shared/app-config.js';

/** Контейнер, собирающий appendChild в массив. */
function collector() {
  const children = [];
  return { children, appendChild(el) { children.push(el); } };
}

/** Рендерит заголовок пункта и возвращает получившийся элемент. */
function renderHeading(child, level) {
  const container = collector();
  PreviewManager._renderHeading(child, container, level);
  return container.children[0];
}

test('заголовок пункта получает класс preview-heading на любой глубине', () => {
  for (const level of [1, 2, 3, 4, 5]) {
    const heading = renderHeading({ id: 'n', label: 'Пункт', number: '1' }, level);
    assert.equal(heading.className, 'preview-heading', `уровень ${level}`);
  }
});

test('уровень тега растёт с вложенностью и упирается в maxHeadingLevel', () => {
  const max = AppConfig.preview.maxHeadingLevel;
  assert.equal(renderHeading({ label: 'Раздел' }, 1).tagName, 'H2');
  assert.equal(renderHeading({ label: 'Подпункт' }, 2).tagName, 'H3');
  assert.equal(renderHeading({ label: 'Глубже' }, 3).tagName, `H${max}`);
  assert.equal(renderHeading({ label: 'Ещё глубже' }, 9).tagName, `H${max}`);
});

test('номер рубрикатора остаётся в тексте заголовка', () => {
  assert.equal(
    renderHeading({ label: 'Общие положения', number: '1.2' }, 2).textContent,
    '1.2. Общие положения',
  );
  assert.equal(
    renderHeading({ label: 'Без номера' }, 2).textContent,
    'Без номера',
  );
});

test('оформление не уезжает в инлайн-стиль — им заведует CSS', () => {
  const heading = renderHeading({ label: 'Раздел', number: '1' }, 1);
  assert.equal(heading.style.fontSize, undefined, 'кегль выставлен инлайном');
  assert.equal(heading.style.fontWeight, undefined, 'начертание выставлено инлайном');
});
