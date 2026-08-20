import { test, expect, openAct, SEED_ACTS } from '../fixtures';
import { createViolation, seedViolationBlocks, violationBlocksSel } from '../violation-helpers';

/**
 * Паритет «конструктор ↔ превью ↔ Word» для вещей, которые до сих пор
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
 * 4. КЕГЛЬ ТАБЛИЦ ПРЕДПРОСМОТРА ПО ПОВЕРХНОСТЯМ. Таблицы, вышедшие из общего
 *    рендера, доставали печатные 9pt случайно: базовое правило .preview-table
 *    стоит на UI-токене --font-size-sm, а тот на портале прибит к 12px
 *    (portal/layout/density.css) — ровно 9pt. Правка плотности портала увела бы
 *    таблицы от печатного кегля, а нарушения рядом (честный документный токен)
 *    остались бы на месте. Кегль переведён на --doc-font-size-small с прицелом
 *    в корень рендера (.preview-table-wrapper); вкладка «Сравнение» с её голой
 *    таблицей без обёртки сознательно осталась на интерфейсном кегле.
 *
 * Юнит-тестами это не ловится: всё перечисленное существует только в каскаде
 * живого движка (вычисленный font-size/font-family, ::marker, геометрия блока).
 */

const EDITOR = '.textblock-editor[data-text-block-id="txt-seed-1"]';
const LIST = '<ul><li>Первый<ul><li>Вложенный</li></ul></li><li>Второй</li></ul>';

/** Втяжка списка = 36pt (w:ind left 720 твипов в DOCX) = 48px при любой плотности. */
const LIST_INDENT_PX = 48;

/** Гарнитура документа (Fonts.main в DOCX-стилях, --doc-font-family в CSS). */
const DOC_FONT = 'Times New Roman';

/**
 * «Мелкий» печатный кегль документа: 9pt (Sizes.table_data_pt) = 12px.
 * Токен --doc-font-size-small; равенство CSS ↔ Python сторожит
 * tests/test_document_typography_tokens.py.
 */
const DOC_SMALL_PX = 12;

/** Заведомо «дикое» значение UI-шкалы для фальсификации: 9pt им быть не может. */
const PROBE_UI_PX = 40;

/** Первое семейство из вычисленного font-family, без кавычек. */
const FAMILY = (sel: string) => {
  const el = document.querySelector(sel) as HTMLElement | null;
  return el ? getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim() : null;
};

/** Вычисленный font-size в px. */
const FONT_PX = (sel: string) => {
  const el = document.querySelector(sel) as HTMLElement | null;
  return el ? parseFloat(getComputedStyle(el).fontSize) : null;
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
      return {
        cell: px(document.querySelector('.editable-table td')!),
        header: px(document.querySelector('.editable-table th')!),
        body: px(body),
        // Экранного множителя у поверхностей правки нет: кегль читается как
        // есть, без поправки на zoom (см. следующий сценарий).
        bodyZoom: parseFloat(getComputedStyle(body).zoom as string) || 1,
      };
    }, EDITOR);

    // Печатные 9pt = 12px. Ячейка НЕ может быть мельче: на экране документ
    // показывается крупнее печатного, а не мельче (было 9.75px).
    expect(m.cell).toBeGreaterThanOrEqual(12);
    // Шапка таблицы в DOCX того же кегля, что и данные (table_header_pt = 9).
    expect(m.header).toBeCloseTo(m.cell, 1);
    // Пропорция к телу — вордовская: 9pt / 12pt.
    expect(m.cell / m.body).toBeCloseTo(9 / 12, 2);
    expect(m.bodyZoom).toBe(1);
  });

  test('поверхности правки показывают печатный кегль без экранного множителя', async ({ page }) => {
    await openStep2(page);
    const vid = await createViolation(page);
    await seedViolationBlocks(page, vid, 'violated', ['проба масштаба']);
    await page.locator(violationBlocksSel(vid, 'violated') + ' .violation-textarea')
      .first().waitFor({ state: 'visible', timeout: 5000 });

    // Прежний zoom 1.25 убран (решение владельца): на шаге заполнения вокруг
    // текста живёт масса элементов конструктора, и раздутый документ их
    // вытеснял. Проверяем не конкретный кегль (он настраиваемый —
    // ACTS__TEXTBLOCKS__FONT_SIZE_DEFAULT), а именно отсутствие множителя:
    // накопленный zoom по всей цепочке предков обязан быть ровно 1.
    const zooms = await page.evaluate((sels) => Object.fromEntries(
      (sels as string[]).map((sel) => {
        let node = document.querySelector(sel) as HTMLElement | null;
        if (!node) return [sel, null];
        let z = 1;
        while (node) {
          z *= parseFloat(getComputedStyle(node).zoom as string) || 1;
          node = node.parentElement;
        }
        return [sel, z];
      })
    ), ['.textblock-editor', '.violation-textarea', '.editable-table td']);

    for (const [sel, z] of Object.entries(zooms)) {
      expect(z, sel + ' не должен масштабироваться').toBe(1);
    }
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

test.describe('Кегль таблиц предпросмотра — по поверхностям', () => {
  test('лист A4: таблица печатного кегля и за UI-шкалой не идёт', async ({ page }) => {
    await openAct(page, SEED_ACTS.withContent);
    await page.setViewportSize({ width: 1680, height: 1000 });
    await page.locator('.step[data-step="1"]').click();
    await page.locator('#preview .preview-sheet').waitFor({ state: 'visible', timeout: 5000 });

    const CELL = '#preview .preview-sheet .preview-table td';
    await page.locator(CELL).first().waitFor({ state: 'attached', timeout: 5000 });

    const before = await page.evaluate(
      ([probe, sel]) => new Function('sel', 'return (' + probe + ')(sel)')(sel),
      [FONT_PX.toString(), CELL] as const
    );
    expect(before).toBeCloseTo(DOC_SMALL_PX, 1);

    // Фальсификация: уводим UI-шкалу в заведомо чужое значение. Печатный кегль
    // обязан остаться на месте — он приходит из --doc-font-size-small, а не из
    // плотности интерфейса.
    const after = await page.evaluate(
      ([probe, sel, px]) => {
        document.documentElement.style.setProperty('--font-size-sm', px + 'px');
        return new Function('sel', 'return (' + probe + ')(sel)')(sel);
      },
      [FONT_PX.toString(), CELL, PROBE_UI_PX] as const
    );
    expect(after).toBeCloseTo(DOC_SMALL_PX, 1);
  });

  test('диалог версий: рендер — документный кегль, вкладка «Сравнение» — интерфейсный', async ({ page }) => {
    // Портал: корневой font-size 13px против 12px в конструкторе, --font-size-sm
    // прибит к 12px. Именно здесь совпадение «12px == 9pt» и маскировало протечку.
    await page.goto('/acts');
    await page.locator('#versionPreviewTemplate').waitFor({ state: 'attached', timeout: 10000 });

    // Узел БЕЗ id — тот же приём, что у теста списков во вкладке «Сравнение»:
    // движок диффа не находит его в текущем акте и рендерит СТАРУЮ сторону,
    // то есть нашу таблицу (в UI-вкладке она рисуется из снимка напрямую).
    await page.evaluate((actId) => {
      const cell = (content: string, isHeader = false) => ({
        content,
        colSpan: 1,
        rowSpan: 1,
        isHeader,
        isSpanned: false,
        originRow: null,
        originCol: null,
        spanOrigin: null,
      });
      const snapshot = {
        version_number: 1,
        created_at: new Date().toISOString(),
        save_type: 'manual',
        username: 'test',
        id: 'ver-tbl-size-1',
        tree_data: {
          children: [
            { type: 'table', tableId: 'vp-gone-tbl-1', number: '1', label: 'Таблица', children: [] },
          ],
        },
        tables_data: {
          'vp-gone-tbl-1': {
            colWidths: [50, 50],
            grid: [
              [cell('Колонка A', true), cell('Колонка B', true)],
              [cell('Значение A'), cell('Значение B')],
            ],
          },
        },
      };
      // @ts-expect-error VersionPreviewOverlay — глобал из version-preview.js
      window.VersionPreviewOverlay.show(snapshot, 'Тестовый акт', actId);
    }, SEED_ACTS.withContent);

    const RENDERED = '.version-preview-ui .preview-table-wrapper .preview-table td';
    const DIFF = '.diff-content table.preview-table td';

    await page.locator(RENDERED).first().waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('.version-preview-toggle .toggle-btn[data-view="diff"]').click();
    await page.locator(DIFF).first().waitFor({ state: 'visible', timeout: 10000 });

    const measure = () => page.evaluate(
      ([probe, sels]) => Object.fromEntries(
        (sels as string[]).map((s) => [s, new Function('sel', 'return (' + probe + ')(sel)')(s)])
      ),
      [FONT_PX.toString(), [RENDERED, DIFF]] as const
    );

    const before = await measure();
    // Обе поверхности сейчас дают одно и то же число — 12px. У рендера это 9pt,
    // у вкладки сравнения — интерфейсные 12px портала; различает их только
    // фальсификация ниже.
    expect(before[RENDERED]).toBeCloseTo(DOC_SMALL_PX, 1);
    expect(before[DIFF]).toBeCloseTo(DOC_SMALL_PX, 1);

    await page.evaluate(
      (px) => document.documentElement.style.setProperty('--font-size-sm', px + 'px'),
      PROBE_UI_PX
    );
    const after = await measure();

    // Ключевая регрессия: пока таблица рендера стояла на --font-size-sm, она
    // уезжала вместе с плотностью портала — и молча расходилась с 9pt нарушений.
    expect(after[RENDERED], 'таблица общего рендера обязана держать печатный кегль')
      .toBeCloseTo(DOC_SMALL_PX, 1);
    // Вкладка сравнения исключена сознательно: инструмент сверки со своим
    // интерфейсным кеглем (docs/architecture/textblock-editor-architecture.md §13).
    expect(after[DIFF], 'вкладка «Сравнение» обязана остаться на интерфейсной шкале')
      .toBeCloseTo(PROBE_UI_PX, 1);
  });
});

test.describe('Заголовки пунктов — печатный кегль, а не UI-шкала', () => {
  /**
   * Печатное тело акта: 12pt (Sizes.body_pt) = 16px. Заголовок пункта в Word
   * идёт ровно этим кеглем и жирным на любой глубине
   * (docx/formatter.py::_render_item), глубину несёт номер рубрикатора.
   */
  const DOC_BODY_PX = 16;

  test('лист A4: все уровни одного печатного кегля и за UI-шкалой не идут', async ({ page }) => {
    await openAct(page, SEED_ACTS.withContent);
    await page.setViewportSize({ width: 1680, height: 1000 });
    await page.locator('.step[data-step="1"]').click();
    await page.locator('#preview .preview-sheet').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#preview .preview-heading').first().waitFor({ state: 'attached', timeout: 5000 });

    const probe = () => page.evaluate(() => {
      const sheet = document.querySelector('#preview .preview-sheet') as HTMLElement;
      const heads = [...document.querySelectorAll('#preview .preview-heading')] as HTMLElement[];
      const byTag = new Map<string, number>();
      for (const h of heads) {
        if (!byTag.has(h.tagName)) byTag.set(h.tagName, parseFloat(getComputedStyle(h).fontSize));
      }
      const first = heads[0];
      return {
        sizes: [...byTag.entries()],
        body: parseFloat(getComputedStyle(sheet).fontSize),
        weight: getComputedStyle(first).fontWeight,
        color: getComputedStyle(first).color,
      };
    });

    const before = await probe();
    // Разные уровни вложенности — минимум два тега на сеяном акте, и все они
    // обязаны дать ОДНО число: в Word ступеней кегля по глубине нет.
    expect(before.sizes.length).toBeGreaterThan(1);
    for (const [tag, px] of before.sizes) {
      expect(px, `${tag} обязан идти печатным кеглем тела`).toBeCloseTo(DOC_BODY_PX, 1);
    }
    expect(before.body).toBeCloseTo(DOC_BODY_PX, 1);
    // Жирный — как run.bold в DOCX; цвет чёрный, как весь лист (серого в акте нет).
    expect(Number(before.weight)).toBeGreaterThanOrEqual(700);
    expect(before.color).toBe('rgb(0, 0, 0)');

    // Фальсификация: уводим ВСЮ UI-шкалу заголовков в чужое значение. Раньше
    // .preview h2/h3/h4 стояли ровно на этих токенах и уехали бы вместе с ней.
    await page.evaluate((px) => {
      for (const t of ['xl', 'lg', 'base', 'sm', '2xl']) {
        document.documentElement.style.setProperty(`--font-size-${t}`, px + 'px');
      }
    }, PROBE_UI_PX);

    const after = await probe();
    for (const [tag, px] of after.sizes) {
      expect(px, `${tag} уехал вместе с плотностью интерфейса`).toBeCloseTo(DOC_BODY_PX, 1);
    }
  });

  test('модалка предпросмотра рисует заголовки так же, как inline-панель', async ({ page }) => {
    await openAct(page, SEED_ACTS.withContent);
    await page.setViewportSize({ width: 1680, height: 1000 });
    await page.locator('.step[data-step="1"]').click();
    await page.locator('#preview .preview-heading').first().waitFor({ state: 'attached', timeout: 5000 });

    await page.evaluate(() => (window as any).previewMenuManager.open());
    await page.locator('#previewMenuBody .preview-heading').first().waitFor({ state: 'attached', timeout: 5000 });

    // Правила заголовков и абзацев были написаны дважды — в preview-typography.css
    // для .preview и в preview-menu.css для .preview-menu-body — и разошлись
    // молча (в модалке абзац шёл экранным интервалом 1.75 против печатного 1.15).
    const m = await page.evaluate(() => {
      const read = (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight) };
      };
      return {
        inline: read('#preview .preview-heading'),
        modal: read('#previewMenuBody .preview-heading'),
      };
    });

    expect(m.modal).not.toBeNull();
    expect(m.modal!.size).toBeCloseTo(m.inline!.size, 1);
    expect(m.modal!.size).toBeCloseTo(DOC_BODY_PX, 1);
    expect(m.modal!.weight).toBe(m.inline!.weight);
  });

  test('заголовок из контента текстблока печатается плоским текстом', async ({ page }) => {
    await openStep2(page);
    await page.locator(EDITOR).evaluate((ed: HTMLElement) => {
      ed.innerHTML = '<h2>Чужой заголовок</h2><div>Обычная строка</div>';
      ed.dispatchEvent(new Event('input', { bubbles: true }));
      (window as any).textBlockManager?.finalizeEdit?.(ed);
      (window as any).Preview?.update?.();
    });
    await page.waitForTimeout(600);

    const CONTENT = '#preview .preview-sheet .preview-textblock-content';
    await page.locator(`${CONTENT} h2`).first().waitFor({ state: 'attached', timeout: 5000 });

    // В DOCX h1–h6 входят в _BLOCK_TAGS (docx/builders/inline.py): тег режется в
    // абзац базового кегля, bold не выставляется. Лист обязан показывать то же,
    // а не UA-дефолт 1.5em bold — и не правило заголовка ПУНКТА, которое здесь
    // не при чём (оно висит на классе .preview-heading).
    const m = await page.evaluate((sel) => {
      const box = document.querySelector(sel) as HTMLElement;
      const h = box.querySelector('h2') as HTMLElement;
      const px = (el: HTMLElement) => parseFloat(getComputedStyle(el).fontSize);
      return {
        heading: px(h),
        body: px(box),
        weight: Number(getComputedStyle(h).fontWeight),
        classed: h.classList.contains('preview-heading'),
      };
    }, CONTENT);

    expect(m.classed, 'чужой заголовок не должен получать класс пункта').toBe(false);
    expect(m.heading).toBeCloseTo(m.body, 1);
    expect(m.weight).toBeLessThan(700);
  });
});

test.describe('Вертикальный ритм листа — Normal-спейсинг Word, а не UI-шкала', () => {
  /**
   * В Word ритм акта задан ОДНИМ правилом стиля Normal: 0pt до абзаца и 3pt
   * после (Spacing.before_pt / after_pt, docx/styles.py). Ступеней «чем выше
   * уровень заголовка, тем больше воздуха» в документе нет. Единственный
   * собственный воздух — пустая строка-распорка (add_blank_line): абзац без
   * текста, высота = кегль его метки (Sizes.blank_line_pt) на одинарном
   * интервале. Она стоит до и после плашки раздела и после каждой таблицы.
   *
   * Лист же стоял на --spacing-* — это rem, то есть ПЛОТНОСТЬ ИНТЕРФЕЙСА
   * (корень 12px в конструкторе против 13px на портале, layout/density.css).
   * Отсюда 15/18/24px над заголовками против печатных 0 и 10.5px под абзацем
   * против печатных 4. Равенство токенов CSS ↔ Python сторожит
   * tests/test_document_typography_tokens.py; здесь — вычисленный каскад.
   */
  const PX_PER_PT = 4 / 3;
  /** Spacing.after_pt = 3pt. */
  const SPACE_AFTER_PX = 3 * PX_PER_PT;
  /** Распорка: Sizes.blank_line_pt (6pt) × одинарный интервал (1.15). */
  const BLANK_LINE_PX = 6 * 1.15 * PX_PER_PT;
  /** Над разделом: распорка ПЛЮС интервал предыдущего абзаца (CSS схлопывает по максимуму). */
  const SECTION_TOP_PX = SPACE_AFTER_PX + BLANK_LINE_PX;

  /** Снимает вертикальные margin'ы (и padding) всего, чем рисуется лист. */
  const rhythm = (page: import('@playwright/test').Page) => page.evaluate(() => {
    const sheet = document.querySelector('#preview .preview-sheet') as HTMLElement;
    const box = (el: HTMLElement) => {
      const cs = getComputedStyle(el);
      return {
        top: parseFloat(cs.marginTop),
        bottom: parseFloat(cs.marginBottom),
        padTop: parseFloat(cs.paddingTop),
        padLeft: parseFloat(cs.paddingLeft),
      };
    };
    /** Элемент есть на листе — меряем его; нет — подсовываем зонд того же класса.
     *  Зонд обкладывается пустыми соседями: без них он становится :last-child,
     *  а под этот псевдокласс в предпросмотре заведены правила обнуления
     *  нижнего отступа — мерился бы не тот ритм. */
    const probe = (selector: string, tag = 'div') => {
      const live = sheet.querySelector(selector) as HTMLElement | null;
      if (live) return box(live);
      const el = document.createElement(tag);
      el.className = selector.replace(/^[a-z0-9]*\./i, '').split('.').join(' ');
      const head = document.createElement('span');
      const tail = document.createElement('span');
      sheet.append(head, el, tail);
      const measured = box(el);
      head.remove(); el.remove(); tail.remove();
      return measured;
    };
    const heads = [...sheet.querySelectorAll('.preview-heading')] as HTMLElement[];
    const byTag = new Map<string, ReturnType<typeof box>>();
    for (const h of heads) if (!byTag.has(h.tagName)) byTag.set(h.tagName, box(h));
    return {
      headings: [...byTag.entries()],
      content: probe('.preview-content'),
      tableTitle: probe('h4.preview-table-title', 'h4'),
      tableWrapper: probe('.preview-table-wrapper'),
    };
  });

  test('лист A4: заголовки, абзацы и таблицы идут печатным ритмом', async ({ page }) => {
    await openAct(page, SEED_ACTS.withContent);
    await page.setViewportSize({ width: 1680, height: 1000 });
    await page.locator('.step[data-step="1"]').click();
    await page.locator('#preview .preview-sheet').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#preview .preview-heading').first().waitFor({ state: 'attached', timeout: 5000 });

    const before = await rhythm(page);

    // Заголовки: минимум два уровня на сеяном акте — и ни у одного из них нет
    // собственных ступеней воздуха, кроме раздела верхнего уровня (h2).
    expect(before.headings.length).toBeGreaterThan(1);
    for (const [tag, m] of before.headings) {
      if (tag === 'H2') {
        expect(m.top, 'над разделом — распорка плюс интервал предыдущего абзаца').toBeCloseTo(SECTION_TOP_PX, 1);
        expect(m.bottom, 'под разделом — распорка').toBeCloseTo(BLANK_LINE_PX, 1);
      } else {
        expect(m.top, `${tag}: интервала ДО абзаца в Word нет`).toBeCloseTo(0, 1);
        expect(m.bottom, `${tag}: интервал после — Normal-спейсинг`).toBeCloseTo(SPACE_AFTER_PX, 1);
      }
    }

    // Контент пункта — обычный абзац: ни собственных полей, ни своего ритма.
    expect(before.content.bottom).toBeCloseTo(SPACE_AFTER_PX, 1);
    expect(before.content.padTop, 'у абзаца акта нет своих полей').toBeCloseTo(0, 1);
    expect(before.content.padLeft, 'у абзаца акта нет своих полей').toBeCloseTo(0, 1);

    // Подпись таблицы — тоже обычный абзац; воздух над ней даёт предыдущий элемент.
    expect(before.tableTitle.top).toBeCloseTo(0, 1);
    expect(before.tableTitle.bottom).toBeCloseTo(SPACE_AFTER_PX, 1);

    // Таблица: сверху ничего своего, снизу — распорка (add_blank_line после КАЖДОЙ таблицы).
    expect(before.tableWrapper.top).toBeCloseTo(0, 1);
    expect(before.tableWrapper.bottom).toBeCloseTo(BLANK_LINE_PX, 1);

    // Фальсификация: уводим ВСЮ шкалу отступов интерфейса в чужое значение.
    // Прежние правила листа стояли ровно на этих токенах и уехали бы вместе с ней.
    await page.evaluate((px) => {
      for (const t of ['xs', 'sm', '', 'md', 'lg', 'xl', '2xl']) {
        document.documentElement.style.setProperty(`--spacing${t ? '-' + t : ''}`, px + 'px');
      }
    }, PROBE_UI_PX);

    const after = await rhythm(page);
    for (const [tag, m] of after.headings) {
      if (tag === 'H2') continue;
      expect(m.top, `${tag} уехал вместе с плотностью интерфейса`).toBeCloseTo(0, 1);
      expect(m.bottom, `${tag} уехал вместе с плотностью интерфейса`).toBeCloseTo(SPACE_AFTER_PX, 1);
    }
    expect(after.content.bottom).toBeCloseTo(SPACE_AFTER_PX, 1);
    expect(after.content.padLeft).toBeCloseTo(0, 1);
    expect(after.tableTitle.bottom).toBeCloseTo(SPACE_AFTER_PX, 1);
    expect(after.tableWrapper.bottom).toBeCloseTo(BLANK_LINE_PX, 1);
  });
});

test.describe('Элементы листа, которых Word печатает иначе, чем рисовало превью', () => {
  /**
   * Аудит превью ↔ DOCX выявил несколько мест, где лист не повторял файл:
   *
   *  - раздел верхнего уровня в Word — не строка текста, а ПЛАШКА-рубрикатор:
   *    таблица 1×2 во всю рабочую ширину с заливкой DEEAF6, рамками 0.5pt и
   *    номером в узкой ячейке справа (docx/builders/rubricator.py);
   *  - блок подписи «Руководитель аудиторской проверки … ФИО» печатается
   *    безусловно (build_signature), а превью обрывалось на последнем узле;
   *  - ячейки таблиц Word ЦЕНТРИРУЕТ — и шапку, и данные (_fill_cell: ветка
   *    одна на всех), превью же прижимало данные влево;
   *  - поля ячейки в Word — 5.4pt по бокам (дефолт w:tblCellMar), 0 сверху и
   *    интервал абзаца снизу; в превью стояли подобранные на глаз 2pt/4pt;
   *  - content пункта уходит в файл выровненным по ширине и с сохранёнными
   *    переносами строк (python-docx превращает перевод строки в w:br).
   */
  const PX_PER_PT = 4 / 3;
  /** Заливка плашки — Palette.rubricator_shade (DEEAF6). */
  const PLATE_SHADE = 'rgb(222, 234, 246)';
  /** Высота строки плашки — PLATE_ROW_HEIGHT_TWIPS (510 твипов = 0.9 см). */
  const PLATE_MIN_HEIGHT_PX = 0.9 * 96 / 2.54;
  /** Узкая ячейка номера — LEFT_CELL_CM (0.8 см). */
  const PLATE_NUMBER_WIDTH_PX = 0.8 * 96 / 2.54;
  /** Поле ячейки по бокам — дефолт OOXML w:tblCellMar, 108 твипов. */
  const CELL_PAD_X_PX = 5.4 * PX_PER_PT;
  /** Над подписью — пустой абзац (12pt × 1.15) плюс два Normal-интервала. */
  const SIGNATURE_TOP_PX = 12 * 1.15 * PX_PER_PT + 2 * 3 * PX_PER_PT;

  /** Открывает шаг 1 сеяного акта и дожидается собранного листа. */
  async function openSheet(page: import('@playwright/test').Page) {
    await openAct(page, SEED_ACTS.withContent);
    await page.setViewportSize({ width: 1680, height: 1000 });
    await page.locator('.step[data-step="1"]').click();
    await page.locator('#preview .preview-sheet').waitFor({ state: 'visible', timeout: 5000 });
  }

  test('раздел верхнего уровня — плашка-рубрикатор, а не строка текста', async ({ page }) => {
    await openSheet(page);
    await page.locator('#preview .preview-rubricator').first().waitFor({ state: 'attached', timeout: 5000 });

    const plate = await page.evaluate(() => {
      const sheet = document.querySelector('#preview .preview-sheet') as HTMLElement;
      const el = sheet.querySelector('.preview-rubricator') as HTMLElement;
      const cs = getComputedStyle(el);
      const num = el.querySelector('.preview-rubricator-number') as HTMLElement;
      const title = el.querySelector('.preview-rubricator-title') as HTMLElement;
      const numCs = getComputedStyle(num);
      const sheetCs = getComputedStyle(sheet);
      // offsetWidth — раскладочные px, до transform-масштаба листа.
      const usable = sheet.offsetWidth
        - parseFloat(sheetCs.paddingLeft) - parseFloat(sheetCs.paddingRight);
      return {
        tag: el.tagName,
        background: cs.backgroundColor,
        borderWidth: parseFloat(cs.borderTopWidth),
        minHeight: parseFloat(cs.minHeight),
        height: el.offsetHeight,
        firstColumn: parseFloat(cs.gridTemplateColumns.split(' ')[0]),
        numberAlign: numCs.textAlign,
        numberWeight: Number(numCs.fontWeight),
        numberDivider: parseFloat(numCs.borderRightWidth),
        titleWeight: Number(getComputedStyle(title).fontWeight),
        widthGap: usable - el.offsetWidth,
      };
    });

    expect(plate.tag, 'плашка остаётся заголовком раздела').toBe('H2');
    expect(plate.background).toBe(PLATE_SHADE);
    expect(plate.borderWidth, 'рамка плашки 0.5pt').toBeGreaterThan(0);
    expect(plate.minHeight).toBeCloseTo(PLATE_MIN_HEIGHT_PX, 0);
    expect(plate.height, 'высота «не меньше» 0.9 см').toBeGreaterThanOrEqual(PLATE_MIN_HEIGHT_PX - 0.5);
    expect(plate.firstColumn, 'узкая ячейка номера — 0.8 см').toBeCloseTo(PLATE_NUMBER_WIDTH_PX, 0);
    expect(plate.numberAlign, 'номер прижат вправо, к заголовку').toBe('right');
    // Жирность метки абзаца в плашке НЕ выставляется (в отличие от пункта):
    // жирный там только заголовок.
    expect(plate.numberWeight).toBeLessThan(700);
    expect(plate.titleWeight).toBeGreaterThanOrEqual(700);
    expect(plate.numberDivider, 'рамки у каждой ячейки → линия между номером и названием').toBeGreaterThan(0);
    expect(Math.abs(plate.widthGap), 'плашка во всю рабочую ширину текста').toBeLessThan(1.5);
  });

  test('лист заканчивается блоком подписи, ФИО — у правого поля', async ({ page }) => {
    await openSheet(page);
    await page.locator('#preview .preview-signature').waitFor({ state: 'attached', timeout: 5000 });

    const sig = await page.evaluate(() => {
      const sheet = document.querySelector('#preview .preview-sheet') as HTMLElement;
      const el = sheet.querySelector('.preview-signature') as HTMLElement;
      const fio = el.querySelector('.preview-signature-fio') as HTMLElement;
      const label = el.querySelector('.preview-signature-label') as HTMLElement;
      // Плашка растянута на рабочую ширину — сравниваем правые края с ней,
      // тогда масштаб листа (transform) сокращается сам.
      const plate = sheet.querySelector('.preview-rubricator') as HTMLElement;
      return {
        isLast: sheet.lastElementChild === el,
        label: label.textContent,
        fio: fio.textContent || '',
        marginTop: parseFloat(getComputedStyle(el).marginTop),
        rightGap: plate.getBoundingClientRect().right - fio.getBoundingClientRect().right,
        leftGap: fio.getBoundingClientRect().left - label.getBoundingClientRect().right,
      };
    });

    expect(sig.isLast, 'подпись — последний элемент листа').toBe(true);
    expect(sig.label).toBe('Руководитель аудиторской проверки');
    expect(sig.fio.length, 'ФИО либо прочерк-заглушка, но не пусто').toBeGreaterThan(0);
    expect(sig.marginTop, 'пустой абзац-воздух перед подписью').toBeCloseTo(SIGNATURE_TOP_PX, 1);
    // Правый tab-stop билдера стоит ровно на рабочей ширине текста.
    expect(Math.abs(sig.rightGap)).toBeLessThan(1.5);
    expect(sig.leftGap, 'между меткой и ФИО — свободное место таба').toBeGreaterThan(0);
  });

  test('ячейки таблиц: вордовские поля и центрирование данных', async ({ page }) => {
    await openSheet(page);
    await page.locator('#preview .preview-sheet .preview-table td').first().waitFor({ state: 'attached', timeout: 5000 });

    const cells = await page.evaluate(() => {
      const read = (el: HTMLElement) => {
        const cs = getComputedStyle(el);
        return {
          align: cs.textAlign,
          verticalAlign: cs.verticalAlign,
          padTop: parseFloat(cs.paddingTop),
          padLeft: parseFloat(cs.paddingLeft),
          padBottom: parseFloat(cs.paddingBottom),
        };
      };
      const sheet = document.querySelector('#preview .preview-sheet') as HTMLElement;
      return {
        data: read(sheet.querySelector('.preview-table td') as HTMLElement),
        header: read(sheet.querySelector('.preview-table th') as HTMLElement),
      };
    });

    for (const [what, m] of Object.entries(cells)) {
      // Word центрирует одиночную ячейку независимо от заголовочности.
      expect(m.align, `${what}: выравнивание по горизонтали`).toBe('center');
      expect(m.verticalAlign, `${what}: по вертикали`).toBe('middle');
      expect(m.padLeft, `${what}: поле ячейки по бокам`).toBeCloseTo(CELL_PAD_X_PX, 1);
      expect(m.padTop, `${what}: сверху поля нет`).toBeCloseTo(0, 1);
      expect(m.padBottom, `${what}: снизу — интервал абзаца в ячейке`).toBeCloseTo(3 * PX_PER_PT, 1);
    }
  });

  test('текст пункта: по ширине и с сохранёнными переносами строк', async ({ page }) => {
    await openSheet(page);

    // Элемент есть не в каждом акте — меряем каскад на зонде того же класса.
    const m = await page.evaluate(() => {
      const sheet = document.querySelector('#preview .preview-sheet') as HTMLElement;
      const live = sheet.querySelector('.preview-content') as HTMLElement | null;
      const el = live || document.createElement('div');
      if (!live) { el.className = 'preview-content'; sheet.appendChild(el); }
      const cs = getComputedStyle(el);
      const out = { align: cs.textAlign, whiteSpace: cs.whiteSpace };
      if (!live) el.remove();
      return out;
    });

    expect(m.align, 'в DOCX абзац пункта идёт JUSTIFY').toBe('justify');
    // python-docx превращает перевод строки в w:br — в Word он виден, а HTML
    // без pre-wrap схлопывал его в пробел.
    expect(m.whiteSpace).toBe('pre-wrap');
  });
});
