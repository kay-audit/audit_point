import { test, expect, openAct, SEED_ACTS } from '../fixtures';

/**
 * UX-доработки предпросмотра конструктора актов.
 *
 * Покрывает три зоны недавней переработки предпросмотра:
 *  (a) колокольчик «Замечания» — счётчик/бейдж по критичности, выпадающий
 *      список, рамка проблемной таблицы на листе и flash-подсветка при переходе;
 *  (b) объединённая шапка таблицы — прижата влево (preview-cell-left), кроме
 *      текстов из centered-набора (остаются по центру);
 *  (c) модальный предпросмотр (#previewMenu) рендерит тот же лист A4, что и
 *      inline-панель (общий рендерер): светлый холст, индикатор зума, fit-to-width.
 *
 * SKIP-GUARD: требует поднятого uvicorn (global-setup) + засиженной БД.
 * Включить: RUN_PREVIEW_UX_E2E=1 npx playwright test 12-preview-ux-refinements
 */
const E2E = process.env.RUN_PREVIEW_UX_E2E === '1';

test.describe('Предпросмотр: UX-доработки (колокольчик, шапки, модал)', () => {
  test.skip(
    !E2E,
    'Требует поднятого uvicorn + засиженной БД; запуск под RUN_PREVIEW_UX_E2E=1'
  );

  test('(a) колокольчик показывает счётчик при пустой таблице', async ({ page }) => {
    await openAct(page, SEED_ACTS.withContent);

    // id первой (единственной) таблицы из seed-данных.
    const tid = await page.evaluate(() => Object.keys(window.AppState.tables)[0]);
    expect(tid).toBeTruthy();

    // Делаем таблицу неполной: оставляем только строку-заголовок → срабатывает
    // предупреждение «нет данных» (severity warning) у collectContentWarnings.
    await page.evaluate((id) => {
      const t = window.AppState.tables[id];
      const headerRow = t.grid[0].map((c) => ({ ...c, isHeader: true }));
      t.grid = [headerRow];
      window.PreviewManager.forceUpdate();
    }, tid);

    // Бейдж виден (не .hidden), его текст — число ≥ 1, цвет — warning.
    const badge = page.locator('#notificationsBadge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveClass(/notif-badge--warning/);
    const badgeCount = Number((await badge.textContent())?.trim());
    expect(badgeCount).toBeGreaterThanOrEqual(1);

    // Рамка проблемной таблицы на листе (warning → оранжевая).
    const wrapper = page.locator(
      `#preview .preview-table-wrapper[data-table-id="${tid}"]`
    );
    await expect(wrapper).toHaveClass(/preview-table-wrapper--warning/);

    // Открываем список замечаний.
    await page.locator('#notificationsBtn').click();
    const menu = page.locator('#notificationsMenu');
    await expect(menu).not.toHaveClass(/\bhidden\b/);

    const items = page.locator('#notificationsMenu .notification-item');
    await expect(items.first()).toBeVisible();
    expect(await items.count()).toBeGreaterThanOrEqual(1);
    await expect(items.first()).toContainText('нет данных');

    // Скриншот тулбара с открытым выпадающим списком.
    await page.screenshot({ path: 'test-results/preview-bell-dropdown.png' });

    // Клик по записи → переход к таблице + кратковременная flash-подсветка.
    // Класс снимается через 1.3с — ассертим оперативно.
    await items.first().click();
    await expect(wrapper).toHaveClass(/flash/, { timeout: 1000 });
  });

  test('(b) объединённая шапка риск-таблицы выровнена влево в предпросмотре', async ({
    page,
  }) => {
    await openAct(page, SEED_ACTS.withContent);

    const tid = await page.evaluate(() => Object.keys(window.AppState.tables)[0]);
    expect(tid).toBeTruthy();

    // Строим объединённую (colSpan = число колонок) шапку с не-centered текстом.
    // Число колонок читаем из самой таблицы, чтобы не зависеть от seed-структуры.
    await page.evaluate((id) => {
      const t = window.AppState.tables[id];
      const n = t.grid[0].length;
      const head = t.grid[0];
      head[0] = {
        ...head[0],
        content: 'Выявлены налоговые риски',
        isHeader: true,
        colSpan: n,
        rowSpan: 1,
        isSpanned: false,
        spanOrigin: null,
      };
      for (let c = 1; c < n; c++) {
        head[c] = {
          ...head[c],
          isHeader: true,
          isSpanned: true,
          spanOrigin: { row: 0, col: 0 },
        };
      }
      t.colWidths = new Array(n).fill(Math.round(100 / n));
      window.PreviewManager.forceUpdate();
    }, tid);

    // Первая th листа — объединённая шапка: класс preview-cell-left + computed left.
    // Класс общий для шапки и данных: правило выравнивания в DOCX одно на всех.
    const th = page.locator('#preview .preview-sheet th').first();
    await expect(th).toBeVisible();
    await expect(th).toHaveClass(/preview-cell-left/);
    const align = await th.evaluate((el) => getComputedStyle(el).textAlign);
    expect(align).toBe('left');

    // Контр-проверка: текст из centered-набора остаётся по центру (нет th-left).
    await page.evaluate((id) => {
      const t = window.AppState.tables[id];
      t.grid[0][0] = {
        ...t.grid[0][0],
        content: 'Количество клиентов / элементов, ед.',
      };
      window.PreviewManager.forceUpdate();
    }, tid);

    const thCentered = page.locator('#preview .preview-sheet th').first();
    await expect(thCentered).toBeVisible();
    await expect(thCentered).not.toHaveClass(/preview-cell-left/);
    const alignCentered = await thCentered.evaluate(
      (el) => getComputedStyle(el).textAlign
    );
    expect(alignCentered).toBe('center');
  });

  test('(c) модальный предпросмотр совпадает с inline (лист A4)', async ({ page }) => {
    await openAct(page, SEED_ACTS.withContent);

    // Открываем модальное меню предпросмотра.
    await page.locator('#previewMenuBtn').click();
    await expect(page.locator('#previewMenu')).not.toHaveClass(/\bhidden\b/);

    const modalSheet = page.locator('#previewMenuBody .preview-sheet');
    await expect(modalSheet).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#previewMenuBody .preview-zoom-indicator')).toBeVisible();

    // Холст модального тела — тот же светлый #f0f0f2.
    const modalBg = await page.evaluate(
      () => getComputedStyle(document.getElementById('previewMenuBody')!).backgroundColor
    );
    expect(modalBg).toBe('rgb(240, 240, 242)');

    // Натуральная ширина листа ≈ 793.7px (A4 @96dpi); масштабированная ЗАПОЛНЯЕТ
    // ширину холста модалки (fit-to-width, паритет с inline).
    const m = await page.evaluate(() => {
      const pane = document.getElementById('previewMenuBody')!;
      const sheetEl = pane.querySelector('.preview-sheet') as HTMLElement;
      const cs = getComputedStyle(pane);
      const padX = parseFloat(cs.paddingLeft || '0') + parseFloat(cs.paddingRight || '0');
      return {
        natural: sheetEl.offsetWidth,
        inner: pane.clientWidth - padX,
        visible: sheetEl.getBoundingClientRect().width,
      };
    });
    expect(Math.abs(m.natural - 793.7)).toBeLessThan(8);
    // Заполнение: масштабированный лист точно вписан в inner модалки.
    expect(m.visible).toBeLessThanOrEqual(m.inner + 1);
    expect(Math.abs(m.visible - m.inner)).toBeLessThanOrEqual(1);

    // Скриншот модального предпросмотра — паритет с inline.
    await page.locator('#previewMenu').screenshot({
      path: 'test-results/preview-modal-parity.png',
    });
  });
});
