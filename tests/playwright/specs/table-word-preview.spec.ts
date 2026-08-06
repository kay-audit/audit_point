import { test, expect, openAct, SEED_ACTS } from '../fixtures';

/**
 * P2 (table-word-preview): предпросмотр как лист A4 с Word-геометрией.
 *
 * Проверяет (R2 «лист», F1, F4):
 *  (a) #preview содержит .preview-sheet шириной ≈210мм (≈794px @96dpi);
 *  (b) таблица предпросмотра имеет <colgroup>, чьи <col> пропорциональны
 *      colWidths таблицы (паритет с DOCX);
 *  (c) ячейка с \n рендерится в несколько визуальных строк (white-space
 *      pre-wrap → clientHeight выше однострочной);
 *  (d) заголовочная ячейка имеет фон #D9D9D9 (rgb(217,217,217)).
 *
 * SKIP-GUARD: e2e-харнес требует поднятого uvicorn (global-setup) + засиженной
 * БД. Включить: RUN_TABLE_PREVIEW_E2E=1 npx playwright test table-word-preview
 */
const E2E_ENABLED = process.env.RUN_TABLE_PREVIEW_E2E === '1';
const TABLE_ID = 'tbl-seed-1';

test.describe('Preview как лист A4 (Word-геометрия)', () => {
  test.skip(
    !E2E_ENABLED,
    'Требует поднятого uvicorn + засиженной БД; запуск под RUN_TABLE_PREVIEW_E2E=1'
  );

  test('лист A4, пропорции колонок, переносы строк, фон шапки', async ({ page }) => {
    await openAct(page, SEED_ACTS.withContent);

    // (c)+ подготовка: впишем \n в ячейку тела и зададим неравные colWidths,
    // затем перерисуем предпросмотр целиком (источник истины — AppState).
    await page.evaluate((tid) => {
      // @ts-expect-error AppState — глобал из state-core.js
      const t = window.AppState?.tables?.[tid];
      if (!t) throw new Error('seed-таблица не найдена в AppState');
      t.colWidths = [30, 70];
      // grid[1][0] — первая ячейка тела (под шапкой).
      t.grid[1][0].content = 'Первая строка\nВторая строка\nТретья строка';
      // @ts-expect-error PreviewManager — глобал из preview.js
      window.PreviewManager.forceUpdate();
    }, TABLE_ID);

    const sheet = page.locator('#preview .preview-sheet');
    await expect(sheet).toBeVisible({ timeout: 5000 });

    // (a) Лист A4 ≈ 210мм. При 96dpi: 210мм = 210/25.4*96 ≈ 793.7px.
    // Лист масштабируется через transform: scale(k) (fit-to-width), поэтому
    // getBoundingClientRect() вернёт МАСШТАБИРОВАННУЮ ширину. Натуральную
    // (неискажённую transform'ом) ширину даёт offsetWidth.
    const naturalWidth = await sheet.evaluate((el) => el.offsetWidth);
    expect(Math.abs(naturalWidth - 793.7)).toBeLessThan(8);

    // (a+) Fit-to-width: лист ЗАПОЛНЯЕТ ширину холста (масштаб может быть >100%)
    // без горизонтального скролла. Масштабированная ширина листа (rect) ≈ внутренней
    // ширине #preview; у самого #preview нет горизонтального переполнения.
    const fit = await page.evaluate(() => {
      const pane = document.getElementById('preview')!;
      const sheetEl = pane.querySelector('.preview-sheet') as HTMLElement;
      const cs = getComputedStyle(pane);
      const padX = parseFloat(cs.paddingLeft || '0') + parseFloat(cs.paddingRight || '0');
      const inner = pane.clientWidth - padX;
      const visibleSheet = sheetEl.getBoundingClientRect().width;
      return {
        inner,
        visibleSheet,
        overflow: pane.scrollWidth - pane.clientWidth,
      };
    });
    // Заполнение: масштабированный лист точно вписан в inner (без переполнения).
    expect(fit.visibleSheet).toBeLessThanOrEqual(fit.inner + 1);
    expect(Math.abs(fit.visibleSheet - fit.inner)).toBeLessThanOrEqual(1);
    expect(fit.overflow).toBeLessThanOrEqual(1);

    // (a++) Индикатор зума виден и показывает целочисленный процент (заполнение
    // ширины → может быть >100%, напр. «120%»).
    const zoom = page.locator('#preview .preview-zoom-indicator');
    await expect(zoom).toBeVisible();
    expect((await zoom.textContent())?.trim()).toMatch(/^\d+%$/);

    // (a+++) Inline-подложка #preview — белая (--bg-primary), единая по стилю с
    // подложкой дерева: лист занимает её целиком, границу рисуют рамка и тень
    // самой подложки. Серый холст #f0f0f2 остался только у модалки
    // (#previewMenuBody) — см. preview-page.css / preview-menu.css.
    const canvasBg = await page.evaluate(
      () => getComputedStyle(document.getElementById('preview')!).backgroundColor
    );
    expect(canvasBg).toBe('rgb(255, 255, 255)');

    const table = page.locator('#preview .preview-sheet table.preview-table').first();
    await expect(table).toBeVisible();

    // (b) colgroup пропорционален colWidths [30,70] → ~30%/70%.
    const colPercents = await table.evaluate((el) => {
      const cols = Array.from(el.querySelectorAll('colgroup col')) as HTMLElement[];
      return cols.map((c) => parseFloat(c.style.width));
    });
    expect(colPercents.length).toBe(2);
    expect(Math.abs(colPercents[0] - 30)).toBeLessThan(0.01);
    expect(Math.abs(colPercents[1] - 70)).toBeLessThan(0.01);

    // (c) Ячейка с \n: white-space=pre-wrap и высота больше однострочной.
    const multilineCell = table.locator('td').first();
    const ws = await multilineCell.evaluate(
      (el) => getComputedStyle(el).whiteSpace
    );
    expect(ws).toBe('pre-wrap');

    const cellHeight = await multilineCell.evaluate((el) => el.clientHeight);
    const lineHeight = await multilineCell.evaluate((el) => {
      const lh = getComputedStyle(el).lineHeight;
      return lh === 'normal' ? parseFloat(getComputedStyle(el).fontSize) * 1.2 : parseFloat(lh);
    });
    // 3 строки текста → высота заметно больше одной строки.
    expect(cellHeight).toBeGreaterThan(lineHeight * 2);

    // (c+) F1: текст ячейки показан ЦЕЛИКОМ, без обрезки (раньше резал до «…»).
    // Третья строка длиннее старого лимита — должна быть полной.
    const cellText = await multilineCell.evaluate((el) => el.textContent);
    expect(cellText).toBe('Первая строка\nВторая строка\nТретья строка');
    expect(cellText).not.toContain('…');

    // (d) Шапка: фон #D9D9D9 = rgb(217, 217, 217).
    const headerBg = await table
      .locator('th')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(headerBg).toBe('rgb(217, 217, 217)');

    // Скриншот листа — для демонстрации владельцу.
    await sheet.screenshot({ path: 'test-results/table-word-preview-sheet.png' });
  });
});
