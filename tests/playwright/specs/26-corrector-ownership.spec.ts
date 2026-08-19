import { test, expect, openAct, SEED_ACTS } from '../fixtures';
import type { Page } from '@playwright/test';
import { openStep2, createViolation, violationFieldSel, seedViolationBlocks } from '../violation-helpers';

/**
 * Сценарий 3: ownership корректора (#1 HIGH). «Улучшить текст» в поле A, во время
 * ожидания ответа клик в поле B, «Принять» — правка коммитится в поле A (владелец
 * захвачен при открытии), поле B не тронуто, тост честный.
 *
 * CorrectorPopover.open захватывает `_ownerSurface = EditorRegistry.getActive()`
 * (гард element===editor). _accept/_persistCorrection НЕ перечитывает активную
 * поверхность — коммитит в ЗАХВАЧЕННУЮ, поэтому уход фокуса на другое поле между
 * запросом и «Принять» не перецеливает правку. Тост success выдаётся ТОЛЬКО при
 * фактическом коммите.
 *
 * Эндпоинт корректора (реальный LLM) мокаем через page.route с задержкой — окно
 * «Обрабатываю…», в котором кликаем поле B. open зовём напрямую (тот же вызов,
 * что делает кнопка ✨ тулбара, textblock-toolbar.js) — детерминированный тайминг.
 */

const CORRECTED = 'Исправленный текст поля А';

/** Фокусирует поле fieldIndex, выделяет его текст и открывает корректор на нём. */
async function openCorrectorOnField(page: Page, vid: string, fieldIndex: number): Promise<void> {
  await page.evaluate(
    ({ sel, fieldIndex }) => {
      const field = document.querySelectorAll(sel)[fieldIndex] as HTMLElement;
      field.focus(); // focus → EditorController.mount → EditorRegistry.setActive(surfaceA)
      const r = document.createRange();
      r.selectNodeContents(field);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
      (window as any).CorrectorPopover.open({ editor: field, range: r, text: s.toString() });
    },
    { sel: violationFieldSel(vid), fieldIndex },
  );
}

/** Текст первого блока поля: в блочной модели поле — контейнер {enabled, blocks}. */
const fieldModel = (page: Page, vid: string, path: 'violated' | 'established') =>
  page.evaluate(
    ({ v, p }) => (window as any).AppState.violations[v][p].blocks[0].content as string,
    { v: vid, p: path },
  );

test.describe('Корректор: ownership поля при уходе фокуса (сценарий 3)', () => {
  test.beforeEach(async ({ page }) => {
    await openAct(page, SEED_ACTS.withContent);
    await openStep2(page);
  });

  test('«Принять» коммитит в поле A (владелец захвачен при открытии), клик в B во время ожидания не перецеливает; B не тронуто; тост честный', async ({
    page,
  }) => {
    // Мок эндпоинта корректора с задержкой — держим окно «Обрабатываю…».
    await page.route('**/api/v1/chat/text-actions/correct', async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ corrected_text: CORRECTED }),
      });
    });

    const vid = await createViolation(page);
    // Сидим блоками: rich-редактор (.violation-field) живёт ВНУТРИ блока, у поля
    // без блоков его нет вовсе — «поверхность поля» без сида не существует.
    const [blockA] = await seedViolationBlocks(page, vid, 'violated', [
      'Текст поля А с ашибками',
    ]); // A = violated
    const [blockB] = await seedViolationBlocks(page, vid, 'established', [
      'Текст поля Б неизменный',
    ]); // B = established

    // Открываем корректор на поле A — владелец должен захватиться сразу.
    await openCorrectorOnField(page, vid, 0);
    await expect(page.locator('.corrector-popover')).toBeVisible();
    const ownerId = await page.evaluate(
      () => (window as any).CorrectorPopover._ownerSurface?.id ?? null,
    );
    expect(ownerId).toBe(`viol:${vid}:violated:block:${blockA}`); // владелец = поле A

    // Запускаем обработку (клик по режиму) — уходит запрос к моку.
    await page.locator('.corrector-mode[data-mode="fix"]').click();
    await expect(page.locator('.corrector-status')).toHaveText('Обрабатываю…');

    // Во время ожидания кликаем поле B → активная поверхность уезжает на B.
    await page.locator(violationFieldSel(vid)).nth(1).click();
    const activeAfterClick = await page.evaluate(
      () => (window as any).EditorRegistry.getActive()?.id ?? null,
    );
    expect(activeAfterClick).toBe(`viol:${vid}:established:block:${blockB}`); // активна теперь B, НЕ A

    // Мок отвечает → диф отрисован, «Принять» доступна.
    await expect(page.locator('.corrector-accept')).toBeEnabled();
    await page.locator('.corrector-accept').click();

    // Правка ушла в поле A (захваченный владелец), НЕ в активную B.
    expect(await fieldModel(page, vid, 'violated')).toContain(CORRECTED);
    expect(await fieldModel(page, vid, 'established')).toBe('Текст поля Б неизменный');

    // Тост честный: успех только при фактическом коммите (фильтруем по тексту —
    // в контейнере ещё висит тост «Акт загружен» с загрузки акта).
    await expect(
      page.locator('.notification-container .notification.success', {
        hasText: 'Текст исправлен',
      }),
    ).toBeVisible();
  });
});
