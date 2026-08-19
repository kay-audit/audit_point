import { test, expect, openAct, SEED_ACTS } from '../fixtures';

/**
 * Паритет «конструктор ↔ превью ↔ Word» для двух вещей, которые до сих пор
 * жили по интерфейсным правилам, а не по документным.
 *
 * 1. КЕГЛЬ ТАБЛИЦ. Ячейки конструктора считались от --font-size-sm, то есть от
 *    плотности интерфейса (корневой font-size 12px, layout/density.css): замер
 *    давал 9.75px — МЕНЬШЕ печатных 9pt (=12px), тогда как тело текстблока
 *    показывается на 25% КРУПНЕЕ печатного (зум читаемости). Таблица на экране
 *    выходила вдвое мельче тела вместо вордовских 9:12.
 *
 * 2. ВТЯЖКА СПИСКОВ. Правила списков превью были привязаны к классу .preview,
 *    который висит ТОЛЬКО на inline-панели. Модальное меню предпросмотра и
 *    диалог истории версий собираются теми же рендерами, но без этого класса —
 *    у списков оставался глобальный сброс (padding: 0), и маркеры при
 *    list-style-position: outside уезжали за левый край контента.
 *
 * Юнит-тестами это не ловится: обе вещи существуют только в каскаде живого
 * движка (вычисленный font-size, ::marker, геометрия блока).
 */

const EDITOR = '.textblock-editor[data-text-block-id="txt-seed-1"]';
const LIST = '<ul><li>Первый<ul><li>Вложенный</li></ul></li><li>Второй</li></ul>';

/** Втяжка списка = 36pt (w:ind left 720 твипов в DOCX) = 48px при любой плотности. */
const LIST_INDENT_PX = 48;

async function openStep2(page) {
  await openAct(page, SEED_ACTS.withContent);
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.locator('.step[data-step="2"]').click();
  await page.locator(EDITOR).waitFor({ state: 'visible', timeout: 5000 });
  // StorageManager отключает tracking ~500ms после loadActContent (см. 18/20/29).
  await page.waitForTimeout(1000);
}

/** Кладёт список в текстблок и пересобирает предпросмотр. */
async function seedListAndPreview(page) {
  await page.locator(EDITOR).evaluate((ed: HTMLElement, html: string) => {
    ed.innerHTML = html;
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    (window as any).textBlockManager?.finalizeEdit?.(ed);
    (window as any).Preview?.update?.();
  }, LIST);
  await page.waitForTimeout(600);
}

/**
 * Втяжка списка и положение пункта относительно левого края списка.
 * Смещение > 0 означает, что маркеру есть где встать: при нулевой втяжке пункт
 * стоит вплотную к краю, и маркер рисуется ЗА пределами блока.
 */
const LIST_PROBE = (sel: string) => {
  const ul = document.querySelector(sel) as HTMLElement | null;
  if (!ul) return null;
  const li = ul.querySelector('li') as HTMLElement;
  const nested = ul.querySelector('ul') as HTMLElement | null;
  const pad = (n: HTMLElement) =>
    parseFloat(getComputedStyle(n).paddingLeft) + parseFloat(getComputedStyle(n).marginLeft);
  return {
    pad: pad(ul),
    nestedPad: nested ? pad(nested) : null,
    itemOffset: Math.round((li.getBoundingClientRect().left - ul.getBoundingClientRect().left) * 10) / 10,
  };
};

test.describe('Кегль таблиц — документный, а не интерфейсный', () => {
  test('ячейка не мельче печатных 9pt и держит вордовскую пропорцию 9:12 к телу', async ({ page }) => {
    await openStep2(page);

    const m = await page.evaluate((sel) => {
      const px = (el: Element) => parseFloat(getComputedStyle(el as HTMLElement).fontSize);
      const body = document.querySelector(sel) as HTMLElement;
      // Тело текстблока увеличено CSS-зумом, а getComputedStyle отдаёт кегль ДО
      // зума — экранный размер получается умножением. У таблицы зума нет, её
      // множитель уже внутри кегля, поэтому сравнивать надо экранные величины.
      const zoom = parseFloat(getComputedStyle(body).zoom as string) || 1;
      return {
        cell: px(document.querySelector('.editable-table td')!),
        header: px(document.querySelector('.editable-table th')!),
        bodyOnScreen: px(body) * zoom,
      };
    }, EDITOR);

    // Печатные 9pt = 12px. Ячейка НЕ может быть мельче: на экране документ
    // показывается крупнее печатного, а не мельче (было 9.75px).
    expect(m.cell).toBeGreaterThanOrEqual(12);
    // Шапка таблицы в DOCX того же кегля, что и данные (table_header_pt = 9).
    expect(m.header).toBeCloseTo(m.cell, 1);
    // Пропорция к телу — вордовская: 9pt / 12pt.
    expect(m.cell / m.bodyOnScreen).toBeCloseTo(9 / 12, 2);
  });

  test('вход в правку ячейки не меняет кегль', async ({ page }) => {
    await openStep2(page);
    const cell = page.locator('.editable-table td').first();
    const resting = await cell.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

    await cell.dblclick();
    await page.waitForTimeout(150);
    const editing = await page.evaluate(() => {
      const el = document.querySelector(
        '.editable-table td.editing textarea, .editable-table td.editing input'
      );
      return el ? parseFloat(getComputedStyle(el as HTMLElement).fontSize) : null;
    });

    expect(editing).not.toBeNull();
    expect(editing!).toBeCloseTo(resting, 1);
  });
});

test.describe('Втяжка списков — во всех поверхностях предпросмотра', () => {
  test('редактор, inline-панель и модальное меню дают одну втяжку, маркер внутри', async ({ page }) => {
    await openStep2(page);
    await seedListAndPreview(page);

    const inEditor = await page.evaluate(
      ([probe, sel]) => new Function('sel', `return (${probe})(sel)`)(sel),
      [LIST_PROBE.toString(), `${EDITOR} ul`]
    );
    const inInline = await page.evaluate(
      ([probe, sel]) => new Function('sel', `return (${probe})(sel)`)(sel),
      [LIST_PROBE.toString(), '#preview .preview-textblock-content ul']
    );

    await page.locator('#previewMenuBtn').click();
    await page.waitForTimeout(600);
    const inModal = await page.evaluate(
      ([probe, sel]) => new Function('sel', `return (${probe})(sel)`)(sel),
      [LIST_PROBE.toString(), '#previewMenuBody .preview-textblock-content ul']
    );

    // Одна и та же документная втяжка везде, включая вложенный уровень.
    expect(inEditor.pad).toBe(LIST_INDENT_PX);
    expect(inEditor.nestedPad).toBe(LIST_INDENT_PX);
    expect(inInline.pad).toBe(LIST_INDENT_PX);
    // Ключевая регрессия: модальное меню раньше давало 0 — маркеры за краем.
    expect(inModal.pad).toBe(LIST_INDENT_PX);
    expect(inModal.nestedPad).toBe(LIST_INDENT_PX);

    // Пункт отступает от края списка => маркеру есть где встать. Геометрию
    // спрашиваем только у видимых поверхностей: inline-панель на шаге 2 скрыта,
    // её прямоугольники нулевые (вычисленные стили при этом достоверны).
    expect(inEditor.itemOffset).toBeGreaterThan(0);
    expect(inModal.itemOffset).toBeGreaterThan(0);
  });

  test('диалог истории версий: та же втяжка при другой плотности интерфейса', async ({ page }) => {
    // Портал грузит preview-typography.css, но его корневой font-size 13px
    // против 12px в конструкторе. Втяжка задана в пунктах и потому не «плывёт».
    await page.goto('/acts');
    await page.locator('#versionPreviewTemplate').waitFor({ state: 'attached', timeout: 10000 });

    await page.evaluate((markup) => {
      const snapshot = {
        version_number: 1,
        created_at: new Date().toISOString(),
        save_type: 'manual',
        username: 'test',
        id: 'ver-list-1',
        tree_data: {
          children: [
            { type: 'textblock', textBlockId: 'vp-tb-1', number: '1', label: 'Блок', children: [] },
          ],
        },
        textblocks_data: { 'vp-tb-1': { content: markup } },
      };
      // @ts-expect-error VersionPreviewOverlay — глобал из version-preview.js
      window.VersionPreviewOverlay.show(snapshot, 'Тестовый акт', 1);
    }, LIST);

    const ul = page.locator('.version-preview-ui .preview-textblock-content ul').first();
    await expect(ul).toBeVisible({ timeout: 5000 });

    const m = await page.evaluate(
      ([probe, sel]) => new Function('sel', `return (${probe})(sel)`)(sel),
      [LIST_PROBE.toString(), '.version-preview-ui .preview-textblock-content ul']
    );
    const rootFontSize = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).fontSize)
    );

    // Плотность портала отличается от конструкторской — значит втяжка не в rem.
    expect(rootFontSize).not.toBe(12);
    expect(m.pad).toBe(LIST_INDENT_PX);
    expect(m.nestedPad).toBe(LIST_INDENT_PX);
    expect(m.itemOffset).toBeGreaterThan(0);
  });
});
