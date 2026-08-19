import { test, expect, openAct, SEED_ACTS } from '../fixtures';
import type { Page } from '@playwright/test';
import {
  openStep2,
  createViolation,
  violationFieldSel,
  seedViolationBlocks,
} from '../violation-helpers';

/**
 * Сценарий 2: поиск/замена + undo по rich-полям нарушения.
 *
 * ActSearchEngine.buildTargets собирает `.textblock-editor` и `.violation-field`
 * ЕДИНЫМ селектором в порядке документа: нарушение между текстблоками даёт цели
 * v, tb, v (не «уплывает» в конец). FindBar._replaceAll снимает поля нарушения
 * ОТДЕЛЬНО от AppState.textBlocks (партиция по isViolationField →
 * snapshotSurfaceContents), а _undoReplaceAll восстанавливает их через
 * target.setContent. Замена, опустошившая поле, синкает класс
 * `textblock-editor--empty` (persist → _toggleEmptyClass).
 *
 * Нарушение в секции 1 (ДО сид-текстблока секции 2) и в секции 3 (ПОСЛЕ) дают
 * настоящий интерлив v1/tb/v2 (секции — не-leaf, contentType-гейт их пропускает).
 */

const BAR = '#actFindBar';
const counter = (page: Page) => page.locator(`${BAR} [data-role="counter"]`);
const findInput = (page: Page) => page.locator(`${BAR} [data-role="find"]`);
const replaceInput = (page: Page) => page.locator(`${BAR} [data-role="replace"]`);

/** Сидит текстблок txt-seed-1 и синкает AppState.textBlocks[id].content (как в 22-спеке). */
async function seedTextblock(page: Page, html: string): Promise<void> {
  await page.evaluate((h) => {
    const ed = document.querySelector(
      '.textblock-editor[data-text-block-id="txt-seed-1"]',
    ) as HTMLElement;
    const tbm = (window as any).textBlockManager;
    tbm.activeEditor = ed;
    ed.innerHTML = h;
    tbm.finalizeEdit(ed);
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
  }, html);
}

async function openBar(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).FindBar.open());
  await expect(page.locator(BAR)).not.toHaveClass(/\bhidden\b/);
}

/**
 * Текст поля «Нарушено» из модели. В блочной модели поле — контейнер
 * {enabled, blocks}, поэтому склеиваем содержимое блоков: сценарии сидят одним
 * блоком, и склейка даёт ровно его текст (а опустошённое поле — пустую строку).
 */
const violatedModel = (page: Page, vid: string) =>
  page.evaluate((v) => {
    const blocks = (window as any).AppState.violations[v].violated.blocks || [];
    return blocks.map((b: any) => b.content).join('') as string;
  }, vid);
const tbModel = (page: Page) =>
  page.evaluate(() => (window as any).AppState.textBlocks['txt-seed-1'].content as string);

test.describe('Find/Replace по полям нарушения (сценарий 2)', () => {
  test.beforeEach(async ({ page }) => {
    await openAct(page, SEED_ACTS.withContent);
    await openStep2(page);
  });

  test('«Заменить всё» + «Отменить»: цели идут v1/tb/v2, замена пишет в модель, undo восстанавливает', async ({
    page,
  }) => {
    const vid1 = await createViolation(page, '1'); // нарушение в секции 1 (ДО текстблока секции 2)
    const vid2 = await createViolation(page, '3'); // нарушение в секции 3 (ПОСЛЕ)
    // Сидим ПОСЛЕ обоих createViolation — renderAll внутри них пересоздаёт DOM.
    await seedTextblock(page, 'кот сидит');
    // Поле-цель поиска = редактор ВНУТРИ блока, поэтому сид идёт блоками:
    // у поля без блоков нет ни одного `.violation-field`, и buildTargets его
    // не увидит вовсе.
    const [b1] = await seedViolationBlocks(page, vid1, 'violated', ['кот думает']);
    const [b2] = await seedViolationBlocks(page, vid2, 'violated', ['кот спит']);

    // Порядок целей в документе: v1 (секция 1) → tb (секция 2) → v2 (секция 3).
    const order = await page.evaluate(
      () => (window as any).ActSearchEngine.buildTargets().map((t: any) => t.id) as string[],
    );
    const iV1 = order.indexOf(`viol:${vid1}:violated:block:${b1}`);
    const iTb = order.indexOf('txt-seed-1');
    const iV2 = order.indexOf(`viol:${vid2}:violated:block:${b2}`);
    expect(iV1).toBeGreaterThanOrEqual(0);
    expect(iTb).toBeGreaterThan(iV1);
    expect(iV2).toBeGreaterThan(iTb);

    await openBar(page);
    await findInput(page).fill('кот');
    await expect(counter(page)).toHaveText('1 / 3'); // v1.violated + tb + v2.violated

    await replaceInput(page).fill('пёс');
    await page.locator(`${BAR} [data-role="replaceAll"]`).click();
    await page.locator('.custom-dialog .dialog-confirm').click();
    await expect(counter(page)).toHaveText('0 / 0');

    // Замена записана в модель всех трёх поверхностей (поля нарушения — через
    // surface.commit, текстблок — через AppState.textBlocks).
    expect(await violatedModel(page, vid1)).toBe('пёс думает');
    expect(await tbModel(page)).toContain('пёс');
    expect(await tbModel(page)).not.toContain('кот');
    expect(await violatedModel(page, vid2)).toBe('пёс спит');

    // «Отменить замену» восстанавливает исходники всех трёх.
    const undoBtn = page.locator(`${BAR} [data-role="undo"]`);
    await expect(undoBtn).toBeVisible();
    await undoBtn.click();
    expect(await violatedModel(page, vid1)).toBe('кот думает');
    expect(await tbModel(page)).toContain('кот');
    expect(await tbModel(page)).not.toContain('пёс');
    expect(await violatedModel(page, vid2)).toBe('кот спит');
  });

  test('замена, опустошающая поле нарушения, ставит класс --empty и пишет пустую модель', async ({
    page,
  }) => {
    const vid = await createViolation(page, '1');
    await seedViolationBlocks(page, vid, 'violated', ['удалить']);

    await openBar(page);
    await findInput(page).fill('удалить');
    await expect(counter(page)).toHaveText('1 / 1');
    await replaceInput(page).fill('');
    await page.locator(`${BAR} [data-role="replaceAll"]`).click();
    await page.locator('.custom-dialog .dialog-confirm').click();
    await expect(counter(page)).toHaveText('0 / 0');

    const res = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      return { empty: el.classList.contains('textblock-editor--empty') };
    }, violationFieldSel(vid));
    expect(res.empty).toBe(true); // пустое поле подсвечено плейсхолдером
    const model = await violatedModel(page, vid);
    expect(model === '' || model == null).toBe(true); // модель опустошена
  });
});
