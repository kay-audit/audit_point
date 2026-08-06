import { test, expect, openAct, SEED_ACTS } from '../fixtures';

/**
 * Форматы экспорта в меню настроек конструктора.
 *
 * Покрывает две зоны, которые легко потерять при рефакторинге:
 *  (a) дефолтный набор галочек живёт в HTML-шаблоне
 *      (templates/constructor/header/header_settings_menu.html) и ничем больше
 *      не задаётся: на чистом localStorage должен быть отмечен только DOCX.
 *      Дефолт «TXT» продержался незамеченным с 2025-10-15 до репорта с ПРОМа.
 *  (b) кнопка «сохранить и скачать» при нуле выбранных форматов обязана
 *      предупредить, а не молча сохранить в БД без единого файла —
 *      NavigationManager._runSave, ветка `else if (withExport)`. Гард по
 *      withExport обязателен: Ctrl+S (saveToDatabase) идёт тем же путём с
 *      пустым formats по построению и ругаться не должен.
 */
test.describe('Форматы экспорта: дефолт и нулевой выбор', () => {
  test('на чистом localStorage отмечен только DOCX', async ({ page }) => {
    await openAct(page, SEED_ACTS.empty);

    // Ключа быть не должно: _saveFormats пишет только по change чекбокса,
    // то есть дефолт приходит из шаблона, а не из сохранённого выбора.
    const saved = await page.evaluate(() => localStorage.getItem('selected_formats'));
    expect(saved, 'на чистом состоянии selected_formats не должен существовать').toBeNull();

    await page.locator('#settingsMenuBtn').click();
    await expect(page.locator('#settingsMenu')).not.toHaveClass(/\bhidden\b/);

    const menu = page.locator('#exportFormatsMenu');
    await expect(menu).toBeVisible();

    await expect(menu.locator('input[value="docx"]')).toBeChecked();
    await expect(menu.locator('input[value="txt"]')).not.toBeChecked();
    await expect(menu.locator('input[value="md"]')).not.toBeChecked();

    const selected = await page.evaluate(() => window.FormatMenuManager.getSelectedFormats());
    expect(selected).toEqual(['docx']);
  });

  test('все галочки сняты → «сохранить и скачать» предупреждает, а не молчит', async ({ page }) => {
    await openAct(page, SEED_ACTS.empty);

    await page.locator('#settingsMenuBtn').click();
    const menu = page.locator('#exportFormatsMenu');
    await expect(menu).toBeVisible();

    // Снимаем DOCX — единственный отмеченный по умолчанию. force: чекбокс
    // перекрыт стилизованной меткой.
    await menu.locator('input[value="docx"]').uncheck({ force: true });

    const selected = await page.evaluate(() => window.FormatMenuManager.getSelectedFormats());
    expect(selected, 'после снятия всех галочек список форматов пуст').toEqual([]);

    await page.locator('#closeSettingsMenuBtn').click();

    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));

    await page.locator('#saveIndicatorBtn').click();

    // Акт пустой, поэтому _showContentWarnings сыплет своими предупреждениями —
    // ищем строго нужное по тексту.
    await expect(
      page.locator('.notification', { hasText: 'Выберите формат экспорта в настройках' })
    ).toBeVisible({ timeout: 10000 });

    // Сохранение в БД при этом проходит, а экспорт не запускается.
    const exportCalls = requests.filter((u) => u.includes('/export/save-act'));
    expect(exportCalls, `не должно быть вызовов save-act: ${exportCalls.join(', ')}`).toHaveLength(0);
  });
});
