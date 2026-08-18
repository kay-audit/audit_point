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

/** Контейнер блоков КОНКРЕТНОГО поля нарушения (адрес поля — в его dataset). */
export function violationBlocksSel(vid: string, fieldKey = 'violated'): string {
  return `.violation-blocks-items[data-violation-id="${vid}"][data-field-key="${fieldKey}"]`;
}

/**
 * Наполняет поле нарушения текст-блоками и перерисовывает карточку.
 *
 * Сид идёт через МОДЕЛЬ, а не через UI: в блочной модели пустое поле не имеет
 * ни одного rich-редактора (он живёт внутри блока), поэтому «дотянуться до
 * поверхности» до появления блоков нечем. id блоков задаются детерминированно
 * — по ним удобно проверять порядок после перетаскивания.
 *
 * @returns id созданных блоков в порядке поля
 */
export async function seedViolationBlocks(
  page: Page,
  vid: string,
  fieldKey: string,
  contents: string[],
): Promise<string[]> {
  return await page.evaluate(
    ({ vid, fieldKey, contents }) => {
      const AppState = (window as any).AppState;
      const violation = AppState.violations[vid];
      if (!violation) throw new Error(`нарушение ${vid} не найдено в AppState`);

      const blocks = contents.map((content, i) => ({
        id: `e2e-${fieldKey}-${i + 1}`,
        type: 'text',
        content,
      }));
      violation[fieldKey] = { enabled: true, blocks };
      (window as any).ItemsRenderer.renderAll();
      return blocks.map((b) => b.id);
    },
    { vid, fieldKey, contents },
  );
}
