import { test, expect, openAct, SEED_ACTS, waitForSaveComplete } from '../fixtures';

/**
 * Inline-edit заголовка пункта на step2 + персистентность после reload.
 *
 * DOM-flow (разведано через MCP Playwright):
 *  - step2 рендерит `.item-block[data-node-id=X]` для каждого узла.
 *  - У узла-«item» заголовок: `.item-block > .item-header .item-title-text`.
 *  - Двойной клик (через 2x click в items-renderer.js) → span получает
 *    класс `editing` и `contenteditable="true"`.
 *  - blur коммитит изменение в AppState; индикатор → `local-only` (red).
 *    Ctrl+S → DB-save, индикатор → `saved`.
 */
test.describe('Edit item title @smoke', () => {
  test('переход на step2 рендерит items-container с контентом', async ({ page }) => {
    await openAct(page, SEED_ACTS.withContent);
    await page.locator('.step[data-step="2"]').click();
    const items = page.locator('#itemsContainer');
    await expect(items).toBeVisible();
    await expect(items.locator('.item-block').first()).toBeAttached({ timeout: 10000 });
  });

  test('переименование пункта сохраняется после reload', async ({ page }) => {
    await openAct(page, SEED_ACTS.withContent);
    await page.locator('.step[data-step="2"]').click();

    const title = page.locator(
      '.item-block[data-node-id="2.1"] > .item-header .item-title-text'
    );
    await expect(title).toBeVisible({ timeout: 5000 });

    // items-renderer.js слушает 'click' и считает clickCount===2 как dblclick
    // (а НЕ 'dblclick' event). Playwright's .dblclick() диспатчит mousedown/up
    // дважды + 'dblclick' — два 'click' тоже бьют → handler срабатывает.
    // Используем нативный dblclick для надёжности (он диспатчит и 2x click).
    await title.dblclick();

    await expect(page.locator('.item-title-text.editing')).toBeVisible({
      timeout: 3000,
    });

    // Очистка + ввод через клавиатуру. После dblclick элемент в фокусе.
    const NEW_TITLE = 'E2E переименование';
    await page.keyboard.press('Control+a');
    await page.keyboard.type(NEW_TITLE);

    // Дождаться что текст в DOM появился (повышенная надёжность).
    await expect(page.locator('.item-title-text.editing')).toHaveText(NEW_TITLE);

    // Enter триггерит finishEditing(false) в items-title-editing.js
    // → node.label = NEW_TITLE (мутирует AppState.treeData глубоко).
    await page.keyboard.press('Enter');

    // Сохранение в БД через прямой API-вызов (PUT /api/v1/acts/{id}/content).
    // Идёт от текущего AppState (AppState.exportData) — даёт надёжный E2E
    // без зависимости от UI-флоу кнопки сохранения.
    const saveStatus = await page.evaluate(async (actId) => {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error AppState — глобал из state-core.js
      const data = AppState.exportData();
      const r = await fetch(`/api/v1/acts/${actId}/content`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });
      return r.status;
    }, SEED_ACTS.withContent);
    expect(saveStatus, 'DB-save должен вернуть 2xx').toBeLessThan(300);

    // Reload и проверить персистентность.
    await page.reload();
    await page.locator('.step[data-step="2"]').click();
    const titleAfter = page.locator(
      '.item-block[data-node-id="2.1"] > .item-header .item-title-text'
    );
    await expect(titleAfter).toHaveText(NEW_TITLE, { timeout: 10000 });
  });
});
