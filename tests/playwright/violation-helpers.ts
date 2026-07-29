import type { Page } from '@playwright/test';

/**
 * Хелперы для e2e-сценариев с полями нарушения (rich-editor-followups).
 *
 * Сид актов (seed.py) НЕ содержит нарушений — поле `.violation-field` появляется
 * в DOM только через рантайм-создание (createViolation). Все три сценария волны
 * (drop капсул в поле, find/replace по полям, ownership корректора) стартуют с
 * этого шага.
 */

/** Селектор редактируемого поля нарушения. querySelector по нему в DOM-порядке:
 *  первое совпадение = поле «Нарушено» (violated), второе = «Установлено»
 *  (established) — обе колонки всегда видимы. */
export function violationFieldSel(vid: string): string {
  return `.violation-section[data-violation-id="${vid}"] .violation-field`;
}

/**
 * Переходит на шаг 2 конструктора и дожидается рендера контента (сид-текстблок
 * txt-seed-1 — надёжный сигнал готовности #itemsContainer, как в 16/22-спеках).
 */
export async function openStep2(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.locator('.step[data-step="2"]').click();
  await page
    .locator('.textblock-editor[data-text-block-id="txt-seed-1"]')
    .waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Создаёт нарушение под узлом nodeId (по умолчанию — сид-пункт «2.1» акта 999002),
 * ре-рендерит контент через ItemsRenderer.renderAll и возвращает id созданного
 * нарушения. Бросает, если addViolationToNode вернул невалидный результат.
 */
export async function createViolation(page: Page, nodeId = '2.1'): Promise<string> {
  return await page.evaluate((nid) => {
    const AppState = (window as any).AppState;
    const res = AppState.addViolationToNode(nid);
    if (res && res.valid === false) {
      throw new Error(`addViolationToNode(${nid}) отклонён: ${res.message}`);
    }
    (window as any).ItemsRenderer.renderAll();
    const ids = Object.keys(AppState.violations);
    return ids[ids.length - 1];
  }, nodeId);
}

/**
 * Наполняет rich-поле нарушения текстом через его поверхность (setContent —
 * штатный путь модель→DOM). path: 'violated' | 'established' | ...
 */
export async function seedViolationField(
  page: Page,
  vid: string,
  fieldIndex: number,
  html: string,
): Promise<void> {
  await page.evaluate(
    ({ sel, fieldIndex, html }) => {
      const field = document.querySelectorAll(sel)[fieldIndex] as HTMLElement & {
        __surface?: { setContent: (h: string) => void };
      };
      field.__surface!.setContent(html);
    },
    { sel: violationFieldSel(vid), fieldIndex, html },
  );
}
