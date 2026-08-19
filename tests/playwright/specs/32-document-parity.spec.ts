import { test, expect, openAct, SEED_ACTS } from '../fixtures';
import { createViolation, seedViolationBlocks, violationBlocksSel } from '../violation-helpers';

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
 *    который висит ТОЛЬКО на inline-панели. Модальное меню предпросмотра,
 *    диалог истории версий и его же вкладка «Сравнение» собираются теми же
 *    рендерами, но без этого класса — у списков оставался глобальный сброс
 *    (padding: 0), и маркеры при list-style-position: outside уезжали за левый
 *    край контента.
 *
 * 3. ГАРНИТУРА. Документ печатается Times New Roman (Fonts.main,
 *    app/domains/acts/formatters/docx/styles.py), а лист A4 был единственной
 *    поверхностью, которая это показывала. Поверхности правки (текстблок, поля
 *    нарушения, ячейки таблиц) и диалог истории версий рисовали интерфейсным
 *    sans — он заметно шире, поэтому строка на экране обрывалась не там, где
 *    оборвётся в Word.
 *
 * Юнит-тестами это не ловится: все три вещи существуют только в каскаде живого
 * движка (вычисленный font-size/font-family, ::marker, геометрия блока).
 */

const EDITOR = '.textblock-editor[data-text-block-id="txt-seed-1"]';
const LIST = '<ul><li>Первый<ul><li>Вложенный</li></ul></li><li>Второй</li></ul>';

/** Втяжка списка = 36pt (w:ind left 720 твипов в DOCX) = 48px при любой плотности. */
const LIST_INDENT_PX = 48;

/** Гарнитура документа (Fonts.main в DOCX-стилях, --doc-font-family в CSS). */
const DOC_FONT = 'Times New Roman';

/** Первое семейство из вычисленного font-family, без кавычек. */
const FAMILY = (sel: string) => {
  const el = document.querySelector(sel) as HTMLElement | null;
  return el ? getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim() : null;
};

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

  test('вход в правку ячейки не меняет ни кегль, ни гарнитуру', async ({ page }) => {
    await openStep2(page);
    const cell = page.locator('.editable-table td').first();
    const resting = await cell.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { size: parseFloat(cs.fontSize), family: cs.fontFamily };
    });

    await cell.dblclick();
    await page.waitForTimeout(150);
    const editing = await page.evaluate(() => {
      const el = document.querySelector(
        '.editable-table td.editing textarea, .editable-table td.editing input'
      );
      if (!el) return null;
      const cs = getComputedStyle(el as HTMLElement);
      return { size: parseFloat(cs.fontSize), family: cs.fontFamily };
    });

    expect(editing).not.toBeNull();
    expect(editing!.size).toBeCloseTo(resting.size, 1);
    // Редактор ячейки задаёт кегль и гарнитуру сам (table-editor.css,
    // table-states.css) — оба обязаны совпасть с ячейкой в покое.
    expect(editing!.family).toBe(resting.family);
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

  test('вкладка «Сравнение» того же диалога: списки тоже с втяжкой', async ({ page }) => {
    // Четвёртая поверхность с тем же контентом: diff-renderer.js гонит HTML
    // текстблока через тот же renderActContent, но в .diff-content, который под
    // прежние селекторы не попадал. Текстблок берём с id, которого в текущем
    // акте НЕТ, — тогда движок диффа считает его удалённым и рендерит РАЗМЕТКУ
    // старой стороны (у статуса modified путь другой: там plain-text с
    // <ins>/<del>, списков в нём не бывает).
    await page.goto('/acts');
    await page.locator('#versionPreviewTemplate').waitFor({ state: 'attached', timeout: 10000 });

    await page.evaluate(([markup, actId]) => {
      const snapshot = {
        version_number: 1,
        created_at: new Date().toISOString(),
        save_type: 'manual',
        username: 'test',
        id: 'ver-diff-1',
        tree_data: {
          children: [
            { type: 'textblock', textBlockId: 'vp-gone-1', number: '1', label: 'Блок', children: [] },
          ],
        },
        textblocks_data: { 'vp-gone-1': { content: markup } },
      };
      // @ts-expect-error VersionPreviewOverlay — глобал из version-preview.js
      window.VersionPreviewOverlay.show(snapshot, 'Тестовый акт', actId);
    }, [LIST, SEED_ACTS.withContent] as const);

    await page.locator('.version-preview-toggle .toggle-btn[data-view="diff"]').click();
    const ul = page.locator('.diff-content .diff-textblock ul').first();
    await expect(ul).toBeVisible({ timeout: 10000 });

    const m = await page.evaluate(
      ([probe, sel]) => new Function('sel', `return (${probe})(sel)`)(sel),
      [LIST_PROBE.toString(), '.diff-content .diff-textblock ul']
    );

    expect(m.pad).toBe(LIST_INDENT_PX);
    expect(m.nestedPad).toBe(LIST_INDENT_PX);
    expect(m.itemOffset).toBeGreaterThan(0);
  });
});

test.describe('Гарнитура — документная, а не интерфейсная', () => {
  test('поверхности правки рисуют тем же шрифтом, что печатается', async ({ page }) => {
    await openStep2(page);

    // Поле нарушения появляется только рантайм-созданием: сид актов нарушений
    // не содержит (см. violation-helpers).
    const vid = await createViolation(page);
    await seedViolationBlocks(page, vid, 'violated', ['проба гарнитуры']);
    await page.locator(violationBlocksSel(vid, 'violated') + ' .violation-textarea')
      .first().waitFor({ state: 'visible', timeout: 5000 });

    const editing = await page.evaluate(
      ([probe, sels]) => Object.fromEntries(
        (sels as string[]).map((s) => [s, new Function('sel', 'return (' + probe + ')(sel)')(s)])
      ),
      [FAMILY.toString(), [
        '.textblock-editor',
        '.editable-table td',
        '.editable-table th',
        '.violation-textarea',
      ]] as const
    );

    await page.locator('.step[data-step="1"]').click();
    await page.locator('#preview .preview-sheet').waitFor({ state: 'visible', timeout: 5000 });
    const sheet = await page.evaluate(
      ([probe, sel]) => new Function('sel', 'return (' + probe + ')(sel)')(sel),
      [FAMILY.toString(), '#preview .preview-sheet'] as const
    );

    // Лист A4 — эталон: он и до этой правки печатал документную гарнитуру.
    expect(sheet).toBe(DOC_FONT);
    for (const [sel, family] of Object.entries(editing)) {
      expect(family, sel + ' обязан рисовать документной гарнитурой').toBe(DOC_FONT);
    }
  });

  test('диалог версий: контент рендеров документный, обвязка диалога — интерфейсная', async ({ page }) => {
    await page.goto('/acts');
    await page.locator('#versionPreviewTemplate').waitFor({ state: 'attached', timeout: 10000 });

    await page.evaluate((actId) => {
      const snapshot = {
        version_number: 1,
        created_at: new Date().toISOString(),
        save_type: 'manual',
        username: 'test',
        id: 'ver-font-1',
        tree_data: {
          children: [
            { type: 'textblock', textBlockId: 'vp-gone-1', number: '1', label: 'Блок', children: [] },
          ],
        },
        textblocks_data: { 'vp-gone-1': { content: '<p>Проба гарнитуры</p>' } },
      };
      // @ts-expect-error VersionPreviewOverlay — глобал из version-preview.js
      window.VersionPreviewOverlay.show(snapshot, 'Тестовый акт', actId);
    }, SEED_ACTS.withContent);

    await page.locator('.version-preview-ui .preview-textblock-content').first()
      .waitFor({ state: 'visible', timeout: 5000 });

    const m = await page.evaluate(
      ([probe, sels]) => Object.fromEntries(
        (sels as string[]).map((s) => [s, new Function('sel', 'return (' + probe + ')(sel)')(s)])
      ),
      [FAMILY.toString(), [
        '.version-preview-ui .preview-textblock-content',
        '.version-preview-ui .version-preview-label',
        '.version-preview-ui',
      ]] as const
    );

    // Ключевая регрессия: диалог листа не строит, и весь контент шёл sans.
    expect(m['.version-preview-ui .preview-textblock-content']).toBe(DOC_FONT);
    // Граница: обвязку рисует сам диалог (version-preview.js), она интерфейсная.
    expect(m['.version-preview-ui .version-preview-label']).not.toBe(DOC_FONT);
    expect(m['.version-preview-ui']).not.toBe(DOC_FONT);

    // Вкладка сравнения исключена сознательно: инструмент сверки со своим
    // интерфейсным кеглем, а не отрисовка листа.
    await page.locator('.version-preview-toggle .toggle-btn[data-view="diff"]').click();
    await page.locator('.diff-content .diff-textblock').first()
      .waitFor({ state: 'visible', timeout: 10000 });
    const diff = await page.evaluate(
      ([probe, sel]) => new Function('sel', 'return (' + probe + ')(sel)')(sel),
      [FAMILY.toString(), '.diff-content .diff-textblock'] as const
    );
    expect(diff).not.toBe(DOC_FONT);
  });
});
