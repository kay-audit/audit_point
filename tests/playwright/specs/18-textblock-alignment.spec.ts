import { test, expect, openAct, SEED_ACTS, waitForSaveComplete } from '../fixtures';

/**
 * TB-1: round-trip per-line выравнивания текстблока.
 *
 * Кнопка justifyCenter (execCommand) пишет text-align в style блочного
 * элемента live-DOM. Раньше выравнивание жило только до reload: превью-профиль
 * 'acts' фильтровал CSS без text-align, а bleach на PUT разрешал style только
 * на span — центр исчезал из БД. Теперь text-align легализован во всех трёх
 * слоях (DOMPurify-превью, bleach, DOCX): центрируем строку → видим центр в
 * превью → сохраняем в БД → reload → центр жив в редакторе.
 */

const EDITOR = '.textblock-editor[data-text-block-id="txt-seed-1"]';

async function openTextblock(page) {
  await openAct(page, SEED_ACTS.withContent);
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.locator('.step[data-step="2"]').click();
  await page.locator(EDITOR).waitFor({ state: 'visible', timeout: 5000 });
  // StorageManager отключает tracking ~500ms после loadActContent.
  await page.waitForTimeout(1000);
}

test.describe('Textblock alignment round-trip (TB-1)', () => {
  test('центрирование живёт в редакторе, превью и БД после reload', async ({ page }) => {
    await openTextblock(page);
    const editor = page.locator(EDITOR);
    await expect(editor).toHaveText(/Исходный текст/);

    // Выделяем весь текст и жмём «по центру» на глобальном тулбаре.
    await editor.click();
    await page.keyboard.press('Control+a');
    const centerBtn = page.locator(
      '#globalTextBlockToolbar .toolbar-btn[data-command="justifyCenter"]'
    );
    await expect(centerBtn).toBeVisible({ timeout: 3000 });
    await centerBtn.click();

    // execCommand записал text-align в блочную разметку редактора.
    await expect(editor).toHaveText(/Исходный текст/);
    expect(await editor.innerHTML()).toMatch(/text-align:\s*center/i);

    // input-debounce (500ms) прокинул content в AppState → индикатор «грязный».
    const indicator = page.locator('#saveIndicatorBtn');
    await expect(indicator).toHaveClass(/\bunsaved\b|\blocal-only\b/, { timeout: 4000 });

    // Сохраняем в БД (PUT → bleach обязан пропустить text-align на div).
    await page.keyboard.press('Control+s');
    await waitForSaveComplete(page);

    // Превью (DOMPurify-профиль 'acts') показывает центр: на step1 лист
    // содержит центрированный блочный элемент с нашим текстом.
    await page.locator('.step[data-step="1"]').click();
    const previewBlock = page.locator(
      '#preview .preview-textblock-content div[style*="text-align"]',
      { hasText: 'Исходный текст' }
    );
    // Переключение на step1 планирует ререндер превью через requestAnimationFrame
    // (App._handleStepTransition) — обычный .evaluate() мог поймать промежуточный
    // кадр перестройки DOM и вернуть пустой computed style. toHaveCSS — web-first
    // ассерт, повторяет попытки, пока превью не осядет.
    await expect(previewBlock).toBeVisible({ timeout: 5000 });
    await expect(previewBlock).toHaveCSS('text-align', 'center');

    // Reload: контент пришёл из БД — центр пережил bleach и доехал в редактор.
    await openAct(page, SEED_ACTS.withContent);

    // Снимок в localStorage (StorageManager пишет его при уходе со страницы)
    // теперь переживает повторное открытие акта: блокировки уехали на TTL-ключи
    // и больше не трогают acts.updated_at, а H3 считает снимок устаревшим
    // только после сохранения акта. Отклоняем черновик — проверяем копию из БД.
    const discardDraft = page.getByRole('button', { name: 'Отклонить' });
    await discardDraft.waitFor({ state: 'visible', timeout: 5000 });
    await discardDraft.click();

    await page.locator('.step[data-step="2"]').click();
    await editor.waitFor({ state: 'visible', timeout: 5000 });
    await expect(editor).toHaveText(/Исходный текст/);
    expect(await editor.innerHTML()).toMatch(/text-align:\s*center/i);
  });
});
