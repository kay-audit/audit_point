import { test, expect, openAct, SEED_ACTS } from '../fixtures';

test.describe('Process Mining @smoke', () => {
  test('пункт Process Mining присутствует в дереве сразу после открытия акта', async ({ page }) => {
    await openAct(page, SEED_ACTS.withContent);
    await expect.poll(() =>
      page.evaluate(() => AppState.treeData.children.some(c => c.special === 'process_mining'))
    ).toBe(true);
  });

  test('меню 0 уровня не предлагает «Добавить соседний пункт»', async ({ page }) => {
    await openAct(page, SEED_ACTS.withContent);
    const section = page.locator('li.tree-item[data-node-id="4"]');
    await expect(section).toBeVisible();
    await section.click({ button: 'right' });
    const item = page.locator('#contextMenu [data-action="add-sibling"]');
    await expect(item).toBeHidden();
  });

  test('пункт Process Mining нельзя удалить через меню', async ({ page }) => {
    await openAct(page, SEED_ACTS.withContent);
    const section = page.locator('li.tree-item[data-node-id="6"]');
    await expect(section).toBeVisible();
    await section.click({ button: 'right' });
    await page.locator('#contextMenu [data-action="delete"]').click();
    // Узел остался в дереве — удаление отбито гейтом deletable:false.
    await expect.poll(() =>
      page.evaluate(() => AppState.treeData.children.some(c => c.special === 'process_mining'))
    ).toBe(true);
  });
});
