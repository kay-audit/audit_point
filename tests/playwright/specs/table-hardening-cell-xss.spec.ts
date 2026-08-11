import { test, expect, openAct, SEED_ACTS } from '../fixtures';

/**
 * B8 (table-hardening): XSS-инвариант ячеек таблицы.
 *
 * Содержимое ячеек рендерится через textContent и в редакторе
 * (table-render.js), и в предпросмотре
 * (preview-table-renderer). textContent трактует строку как ТЕКСТ, а не HTML —
 * никакой `<script>`/`<img>` не создаётся как элемент и ничего не исполняется.
 * Этот инвариант критичен (бэкенд НЕ санитизирует ячейки — он полагается на
 * текстовый рендеринг у всех потребителей) и до P8 не был закреплён тестом.
 *
 * Проверяем оба рендера: payload попадает в ячейку как литеральный текст,
 * внутри ячейки нет созданных элементов <script>/<img>, window.__xss не задан.
 *
 * SKIP-GUARD: требует поднятого uvicorn + засиженной БД.
 * Включить: RUN_TABLE_HARDENING_E2E=1 npx playwright test table-hardening
 */
const E2E_ENABLED = process.env.RUN_TABLE_HARDENING_E2E === '1';
const TABLE_ID = 'tbl-seed-1';

const PAYLOAD_SCRIPT = '<script>window.__xss=1</script>';
const PAYLOAD_IMG = '<img src=x onerror="window.__xss=1">';

test.describe('B8 XSS-инвариант ячеек таблицы (textContent)', () => {
  test.skip(
    !E2E_ENABLED,
    'Требует поднятого uvicorn + засиженной БД; запуск под RUN_TABLE_HARDENING_E2E=1'
  );

  test('payload в ячейке остаётся текстом в редакторе и предпросмотре', async ({ page }) => {
    await openAct(page, SEED_ACTS.withContent);

    // Вписываем XSS-payload в две ячейки тела и перерисовываем И редактор,
    // И предпросмотр из AppState (источник истины).
    await page.evaluate(({ tid, p1, p2 }) => {
      // @ts-expect-error AppState — глобал
      const t = window.AppState?.tables?.[tid];
      if (!t) throw new Error('seed-таблица не найдена в AppState');
      t.grid[1][0].content = p1;
      t.grid[1][1].content = p2;
      // @ts-expect-error ItemsRenderer — глобал (редактор)
      window.ItemsRenderer.updateTable(tid);
      // @ts-expect-error PreviewManager — глобал (предпросмотр)
      window.PreviewManager.forceUpdate();
    }, { tid: TABLE_ID, p1: PAYLOAD_SCRIPT, p2: PAYLOAD_IMG });

    // Дать «эффектам» отрисоваться.
    await page.waitForTimeout(200);

    // --- Предпросмотр (виден на step 1, куда приземлил openAct) ---
    const previewSheet = page.locator('#preview .preview-sheet');
    await expect(previewSheet).toBeVisible({ timeout: 5000 });
    const previewCells = page.locator('#preview .preview-sheet table.preview-table td');
    // Payload-текст присутствует в preview-ячейках как литеральный текст.
    const previewTexts = await previewCells.allTextContents();
    expect(previewTexts).toContain(PAYLOAD_SCRIPT);
    expect(previewTexts).toContain(PAYLOAD_IMG);
    // Внутри preview-таблицы НЕ создано элементов script/img из payload'а.
    expect(
      await page.locator('#preview .preview-sheet table.preview-table script').count()
    ).toBe(0);
    expect(
      await page.locator('#preview .preview-sheet table.preview-table img').count()
    ).toBe(0);

    // --- Редактор (step 2) ---
    await page.locator('.step[data-step="2"]').click();
    const editorCell1 = page.locator(
      `td[data-table-id="${TABLE_ID}"][data-row="1"][data-col="0"]`
    );
    const editorCell2 = page.locator(
      `td[data-table-id="${TABLE_ID}"][data-row="1"][data-col="1"]`
    );
    await expect(editorCell1).toBeVisible({ timeout: 5000 });

    // Payload виден как литеральный текст (textContent), а не как элемент.
    await expect(editorCell1).toHaveText(PAYLOAD_SCRIPT);
    await expect(editorCell2).toHaveText(PAYLOAD_IMG);
    // Внутри ячеек нет созданных элементов script/img.
    expect(await editorCell1.locator('script').count()).toBe(0);
    expect(await editorCell2.locator('img').count()).toBe(0);

    // Ничего не исполнилось.
    const xss = await page.evaluate(() => (window as any).__xss);
    expect(xss).toBeUndefined();
  });
});
