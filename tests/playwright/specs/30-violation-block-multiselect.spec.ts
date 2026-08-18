import { test, expect, openAct, SEED_ACTS } from '../fixtures';
import type { Page } from '@playwright/test';
import {
  openStep2,
  createViolation,
  seedViolationBlocks,
  violationBlocksSel,
} from '../violation-helpers';

/**
 * Мультивыделение блоков поля нарушения: выделение шапками, групповое
 * перетаскивание и групповое удаление.
 *
 * Сид идёт через модель (seedViolationBlocks), а НЕ через `seedViolationField`:
 * в блочной модели у пустого поля нет ни одного rich-редактора — он живёт
 * внутри блока, и старый хелпер (`.violation-field` → `__surface`) обращается к
 * разметке, которой больше нет.
 *
 * Перетаскивание — синтетическими DragEvent с общим DataTransfer (конвенция
 * 04-tree-dnd/24-violation-field-drop): mouse-based `dragAndDrop` с HTML5-DnD
 * в Chromium нестабилен. Само «перетаскивание начинается только с шапки»
 * (armBlockDrag) проверяют юнит-тесты — синтетическое событие флаг `draggable`
 * не читает.
 */

const FIELD = 'violated';

/** Шапка блока — зона клика выделения и старта перетаскивания. */
function labelSel(vid: string, blockId: string): string {
  return `${violationBlocksSel(vid, FIELD)} .content-item-wrapper[data-block-id="${blockId}"] .content-item-label`;
}

/** Порядок блоков в DOM поля. */
async function domOrder(page: Page, vid: string): Promise<string[]> {
  return await page.evaluate((sel) => {
    const container = document.querySelector(sel) as HTMLElement;
    return [...container.querySelectorAll('.content-item-wrapper')].map(
      (w) => (w as HTMLElement).dataset.blockId as string,
    );
  }, violationBlocksSel(vid, FIELD));
}

/** id блоков, помеченных выделением. */
async function selectedIds(page: Page, vid: string): Promise<string[]> {
  return await page.evaluate((sel) => {
    const container = document.querySelector(sel) as HTMLElement;
    return [...container.querySelectorAll('.content-item-wrapper.block-selected')].map(
      (w) => (w as HTMLElement).dataset.blockId as string,
    );
  }, violationBlocksSel(vid, FIELD));
}

/** Порядок блоков в МОДЕЛИ (источник истины для превью и сохранения). */
async function modelOrder(page: Page, vid: string): Promise<string[]> {
  return await page.evaluate(
    ({ vid, field }) => (window as any).AppState.violations[vid][field].blocks.map(
      (b: { id: string }) => b.id,
    ),
    { vid, field: FIELD },
  );
}

/**
 * Перетаскивает пачку за шапку блока `fromId` и бросает её ПОД блок `overId`
 * (курсор в нижней четверти целевой обёртки — вставка после него).
 */
async function dragPackBelow(
  page: Page,
  vid: string,
  fromId: string,
  overId: string,
): Promise<void> {
  await page.evaluate(
    async ({ containerSel, fromId, overId }) => {
      const container = document.querySelector(containerSel) as HTMLElement;
      const wrapper = (id: string) => container.querySelector(
        `.content-item-wrapper[data-block-id="${id}"]`,
      ) as HTMLElement;

      const source = wrapper(fromId);
      const target = wrapper(overId);
      const dt = new DataTransfer();

      const fire = (el: HTMLElement, type: string, x: number, y: number) => {
        el.dispatchEvent(new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: x,
          clientY: y,
        }));
      };

      const from = source.getBoundingClientRect();
      fire(source, 'dragstart', from.left + 10, from.top + 5);

      const to = target.getBoundingClientRect();
      const x = to.left + to.width / 2;
      const y = to.bottom - to.height / 4;
      fire(target, 'dragenter', x, y);
      fire(target, 'dragover', x, y);
      // dragover троттлится кадром — даём ему прийти до drop.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      fire(target, 'drop', x, y);
      fire(source, 'dragend', x, y);
    },
    { containerSel: violationBlocksSel(vid, FIELD), fromId, overId },
  );
}

test.describe('Мультивыделение блоков нарушения', () => {
  test.beforeEach(async ({ page }) => {
    await openAct(page, SEED_ACTS.withContent);
    await openStep2(page);
  });

  test('Ctrl+клик выделяет два блока, drag за шапку переносит их вместе', async ({ page }) => {
    const vid = await createViolation(page);
    const [b1, b2, b3] = await seedViolationBlocks(page, vid, FIELD, [
      'первый', 'второй', 'третий',
    ]);

    await page.click(labelSel(vid, b1));
    await page.click(labelSel(vid, b2), { modifiers: ['Control'] });

    expect(await selectedIds(page, vid)).toEqual([b1, b2]);

    // Тащим пачку под третий блок: она встаёт непрерывным прогоном в исходном
    // относительном порядке.
    await dragPackBelow(page, vid, b1, b3);

    expect(await modelOrder(page, vid)).toEqual([b3, b1, b2]);
    expect(await domOrder(page, vid)).toEqual([b3, b1, b2]);
    // Выделение переживает перерисовку — оно адресовано id, а не обёрткам.
    expect(await selectedIds(page, vid)).toEqual([b1, b2]);
  });

  test('ПКМ по выделению: «Удалить 2 блока» с подтверждением удаляет оба', async ({ page }) => {
    const vid = await createViolation(page);
    const [b1, b2, b3] = await seedViolationBlocks(page, vid, FIELD, [
      'первый', 'второй', 'третий',
    ]);

    await page.click(labelSel(vid, b1));
    await page.click(labelSel(vid, b3), { modifiers: ['Control'] });

    await page.click(labelSel(vid, b3), { button: 'right' });

    const groupItem = page.locator('.violation-context-menu-item', {
      hasText: 'Удалить 2 блока',
    });
    await expect(groupItem).toBeVisible();
    await groupItem.click();

    // Удаление пачки необратимо — диалог обязателен.
    const dialog = page.locator('.custom-dialog-overlay.visible');
    await expect(dialog).toBeVisible();
    await dialog.locator('.dialog-confirm').click();

    expect(await modelOrder(page, vid)).toEqual([b2]);
    expect(await domOrder(page, vid)).toEqual([b2]);
    expect(await selectedIds(page, vid)).toEqual([]);
  });

  test('клик мимо шапки снимает выделение', async ({ page }) => {
    const vid = await createViolation(page);
    const [b1, b2] = await seedViolationBlocks(page, vid, FIELD, ['первый', 'второй']);

    await page.click(labelSel(vid, b1));
    await page.click(labelSel(vid, b2), { modifiers: ['Control'] });
    expect(await selectedIds(page, vid)).toEqual([b1, b2]);

    // Тело блока — не шапка: выделение снимается (как и клик по тулбару,
    // соседнему полю или пустому месту страницы).
    await page.click(
      `${violationBlocksSel(vid, FIELD)} .content-item-wrapper[data-block-id="${b2}"] .content-item`,
    );

    expect(await selectedIds(page, vid)).toEqual([]);
  });
});
