import { test, expect, openAct, SEED_ACTS } from '../fixtures';

/**
 * Операции с ячейками таблицы через контекстное меню.
 *
 * DOM-flow (разведано через MCP):
 *  - Таблица: `.table-section[data-table-id=X] table.editable-table`
 *  - Ячейка: `td[data-table-id=X][data-row=R][data-col=C]` (header — `th`)
 *  - Выделение: click + ctrl-click (table-core.js:77 — без ctrl сбрасывает,
 *    с ctrl добавляет); selectedCells получает класс `.selected`.
 *  - Context-menu: contextmenu-эвент на ячейке → `.context-menu` (block-display)
 *    с пунктами «🔗 Объединить ячейки», «↩️ Разъединить ячейку»,
 *    «⬆️ Вставить строку выше», «⬇️ Вставить строку ниже», «🗑️ Удалить строку»,
 *    «⬅️ Вставить колонку слева», «➡️ Вставить колонку справа», «🗑️ Удалить колонку».
 *  - После merge: ячейка с (data-row, data-col) первой получает colSpan=2,
 *    вторая помечается isSpanned и из DOM удаляется.
 */
test.describe('Table cell operations @smoke', () => {
  test('merge cells через context-menu увеличивает colSpan', async ({ page }) => {
    await openAct(page, SEED_ACTS.withContent);
    await page.locator('.step[data-step="2"]').click();

    // Дождаться рендера таблицы.
    const tableSection = page.locator('.table-section[data-table-id="tbl-seed-1"]');
    await expect(tableSection).toBeVisible({ timeout: 5000 });

    // Селекторы: [1,0] и [1,1] — это data-row="1" (вторая строка, body).
    const cell00 = page.locator(
      'td[data-table-id="tbl-seed-1"][data-row="1"][data-col="0"]'
    );
    const cell01 = page.locator(
      'td[data-table-id="tbl-seed-1"][data-row="1"][data-col="1"]'
    );

    // Сначала проверяем что обе ячейки на месте (colspan атрибут может быть
    // отсутствовать — это эквивалент 1; не проверяем явно).
    await expect(cell00).toBeVisible();
    await expect(cell01).toBeVisible();

    // Выделение: click + ctrl-click.
    await cell00.click();
    await cell01.click({ modifiers: ['Control'] });

    // Проверим что обе .selected.
    await expect(cell00).toHaveClass(/\bselected\b/);
    await expect(cell01).toHaveClass(/\bselected\b/);

    // Right-click для контекстного меню.
    await cell01.click({ button: 'right' });

    // Меню .context-menu (block) с пунктом «🔗 Объединить ячейки».
    const mergeItem = page.locator('.context-menu-item', {
      hasText: 'Объединить ячейки',
    }).and(page.locator(':not(.disabled)'));
    await expect(mergeItem).toBeVisible();
    await mergeItem.click();

    // После merge: cell00 имеет colSpan=2, cell01 удалена из DOM.
    await expect(cell00).toHaveAttribute('colspan', '2');
    await expect(cell01).toHaveCount(0);
  });

  test('печать в ячейке переживает автосейв (не сбрасывается через ~3с)', async ({ page }) => {
    // Регрессия: воронка автосейва (StorageManager._flushPendingEdits, дебаунс
    // 3с) дёргала textarea.blur() у редактируемой ячейки → finishEditing удалял
    // textarea из DOM и ронял фокус посреди набора текста. Фикс — недеструктивный
    // commitPendingEdit, textarea должна пережить паузу дольше 3с.
    await openAct(page, SEED_ACTS.withContent);
    await page.locator('.step[data-step="2"]').click();

    const tableSection = page.locator('.table-section[data-table-id="tbl-seed-1"]');
    await expect(tableSection).toBeVisible({ timeout: 5000 });

    const cell = page.locator(
      'td[data-table-id="tbl-seed-1"][data-row="1"][data-col="0"]'
    );
    await expect(cell).toBeVisible();

    // Вход в редактирование — двойной клик (table-core.js).
    await cell.dblclick();
    const textarea = cell.locator('textarea');
    await expect(textarea).toBeVisible();
    await expect(textarea).toBeFocused();

    // Сид-значение ячейки затираем выделением: набор идёт с чистого листа.
    await textarea.press('Control+a');
    await textarea.pressSequentially('первая часть');

    // Пауза дольше дебаунса автосейва (3с) — textarea не должна быть удалена
    // из DOM, фокус не должен сброситься.
    await page.waitForTimeout(4500);

    await expect(cell.locator('textarea')).toBeVisible();
    await expect(cell).toHaveClass(/\bediting\b/);
    await expect(textarea).toBeFocused();

    await textarea.pressSequentially(' и вторая часть');
    await textarea.blur();

    await expect(cell).toHaveText('первая часть и вторая часть');
  });
});
