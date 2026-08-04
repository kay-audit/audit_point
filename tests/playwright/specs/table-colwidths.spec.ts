import { test, expect, openAct, SEED_ACTS } from '../fixtures';

/**
 * P1 (table-column-widths): целые веса colWidths и персист ресайза.
 *
 * Сценарии:
 *  1. Вставка колонки → сериализованный PUT /content проходит со статусом != 422,
 *     а colWidths в payload — все целые (регрессия H1/F3: раньше
 *     _redistributeColumnWidths писал дробные 100/numCols → pydantic 422).
 *  2. Интерактивный ресайз колонки → веса становятся целыми и после save+reload
 *     восстанавливаются из БД (регрессия F2/G2/B7: tableUISizes не персистился).
 *
 * Сохранение в БД — прямым PUT /api/v1/acts/{id}/content от AppState.exportData()
 * (паттерн из 02-edit-item-title.spec.ts), без зависимости от save-indicator.
 *
 * SKIP-GUARD: e2e-харнес требует поднятого uvicorn + засиженной БД
 * (global-setup + fixtures.reseed → python seed.py против DATABASE__*).
 * Включить: RUN_TABLE_COLWIDTHS_E2E=1 npx playwright test table-colwidths
 */
const E2E_ENABLED = process.env.RUN_TABLE_COLWIDTHS_E2E === '1';
const TABLE_ID = 'tbl-seed-1';

async function saveToDb(
  page: import('@playwright/test').Page,
  actId: number,
  tableId: string
) {
  return page.evaluate(
    async ({ id, tid }) => {
      // @ts-expect-error AppState — глобал из state-core.js
      const data = AppState.exportData();
      const r = await fetch(`/api/v1/acts/${id}/content`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });
      return {
        status: r.status,
        colWidths: data.tables[tid]?.colWidths ?? null,
      };
    },
    { id: actId, tid: tableId }
  );
}

test.describe('Table colWidths integer weights & resize persist', () => {
  test.skip(
    !E2E_ENABLED,
    'Требует поднятого uvicorn + засиженной БД; запуск под RUN_TABLE_COLWIDTHS_E2E=1'
  );

  test('вставка колонки не даёт 422 и colWidths остаются целыми', async ({ page }) => {
    await openAct(page, SEED_ACTS.withContent);
    await page.locator('.step[data-step="2"]').click();

    const tableSection = page.locator(`.table-section[data-table-id="${TABLE_ID}"]`);
    await expect(tableSection).toBeVisible({ timeout: 5000 });

    // Вставляем колонку справа от первой ячейки тела через контекстное меню.
    const cell = page.locator(
      `td[data-table-id="${TABLE_ID}"][data-row="1"][data-col="0"]`
    );
    await cell.click();
    await cell.click({ button: 'right' });
    const insertItem = page
      .locator('.context-menu-item', { hasText: 'Вставить колонку справа' })
      .and(page.locator(':not(.disabled)'));
    await expect(insertItem).toBeVisible();
    await insertItem.click();

    // Сериализуем и сохраняем в БД. Регрессия H1/F3: дробные веса → 422.
    const { status, colWidths } = await saveToDb(page, SEED_ACTS.withContent, TABLE_ID);
    expect(status, 'PUT /content не должен возвращать 422').not.toBe(422);
    expect(status).toBeLessThan(300);
    expect(colWidths).not.toBeNull();
    expect(colWidths!.length).toBe(3);
    for (const w of colWidths!) {
      expect(Number.isInteger(w)).toBe(true);
      expect(w).toBeGreaterThan(0);
    }
  });

  test('ресайз колонки даёт целые веса и персистится через reload', async ({ page }) => {
    await openAct(page, SEED_ACTS.withContent);
    await page.locator('.step[data-step="2"]').click();

    const tableSection = page.locator(`.table-section[data-table-id="${TABLE_ID}"]`);
    await expect(tableSection).toBeVisible({ timeout: 5000 });

    const readColWidths = () =>
      page.evaluate(
        // @ts-expect-error AppState — глобал
        (id) => window.AppState?.tables?.[id]?.colWidths?.slice() ?? null,
        TABLE_ID
      );

    const before = await readColWidths();
    expect(before).toEqual([50, 50]);

    // Тянем ручку ресайза первой колонки заголовка вправо.
    const handle = page
      .locator(`th[data-table-id="${TABLE_ID}"][data-col="0"] .resize-handle`)
      .first();
    await expect(handle).toBeAttached();
    const box = await handle.boundingBox();
    if (!box) throw new Error('resize-handle без boundingBox');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();

    // colWidths изменились и остались целыми.
    const after = await readColWidths();
    expect(after).not.toEqual(before);
    for (const w of after!) {
      expect(Number.isInteger(w)).toBe(true);
      expect(w).toBeGreaterThan(0);
    }

    // Сохраняем в БД и перезагружаем — веса восстановятся из БД.
    const { status } = await saveToDb(page, SEED_ACTS.withContent, TABLE_ID);
    expect(status).toBeLessThan(300);

    await openAct(page, SEED_ACTS.withContent);
    await page.locator('.step[data-step="2"]').click();
    await expect(tableSection).toBeVisible({ timeout: 5000 });

    const afterReload = await readColWidths();
    expect(afterReload).toEqual(after);
  });
});
