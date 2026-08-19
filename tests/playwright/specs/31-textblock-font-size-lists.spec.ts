import { test, expect, openAct, SEED_ACTS } from '../fixtures';

/**
 * Размер шрифта в списках и единица измерения (живой Chromium).
 *
 * Юнит-тесты этого не ловят принципиально: стабы node:test не моделируют ни
 * Selection, ни Range (нет ни splitText-обновления живых диапазонов, ни
 * intersectsNode, ни TreeWalker по реальному дереву), а `::marker` вообще
 * существует только в движке рендеринга.
 *
 * Что закрываем:
 *  - фантомные пункты: смена размера на выделении ЧЕРЕЗ НЕСКОЛЬКО <li> раньше
 *    звала range.extractContents() и оборачивала фрагмент одним span — в списке
 *    оставались пустые <li>-огрызки (в них нельзя встать кареткой), а сами
 *    пункты уезжали ВНУТРЬ span прямо в <ul>;
 *  - маркер: размер жил на span внутри <li>, а ::marker наследует кегль от
 *    САМОГО <li> — буллит/номер застывал на базовом;
 *  - единица: в разметку уходят ПУНКТЫ (то же число, что попадёт в Word), а не
 *    пиксели.
 */

const EDITOR = '.textblock-editor[data-text-block-id="txt-seed-1"]';

async function openTextblock(page) {
  await openAct(page, SEED_ACTS.withContent);
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.locator('.step[data-step="2"]').click();
  await page.locator(EDITOR).waitFor({ state: 'visible', timeout: 5000 });
  // StorageManager отключает tracking ~500ms после loadActContent (см. 18/20/29).
  await page.waitForTimeout(1000);
}

/** Кладёт в редактор готовый список из трёх пунктов и ставит фокус. */
async function seedList(page, html: string) {
  const editor = page.locator(EDITOR);
  await editor.evaluate((ed: HTMLElement, markup: string) => {
    ed.innerHTML = markup;
  }, html);
  await editor.click();
}

/** Выделяет текст от начала пункта `from` до конца пункта `to` (0-based). */
async function selectAcrossItems(page, from: number, to: number) {
  await page.locator(EDITOR).evaluate((ed: HTMLElement, [a, b]: number[]) => {
    const items = ed.querySelectorAll('li');
    const range = document.createRange();
    range.setStart(items[a].firstChild!, 0);
    const endNode = items[b].firstChild!;
    range.setEnd(endNode, endNode.textContent!.length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, [from, to]);
}

/** Применяет размер реальными кликами по дропдауну тулбара. */
async function applySize(page, size: number) {
  await page.locator('#fontSizeTrigger').click();
  await page.locator(`#fontSizeMenu .toolbar-fontsize-option[data-size="${size}"]`).click();
  await page.waitForTimeout(60);
}

test.describe('Размер шрифта в списках', () => {
  test('мультивыделение пунктов не порождает фантомных <li>', async ({ page }) => {
    await openTextblock(page);
    await seedList(page, '<ul><li>Первый пункт</li><li>Второй пункт</li><li>Третий пункт</li></ul>');
    await selectAcrossItems(page, 0, 2);
    await applySize(page, 20);

    const state = await page.locator(EDITOR).evaluate((ed: HTMLElement) => ({
      items: ed.querySelectorAll('li').length,
      empty: Array.from(ed.querySelectorAll('li')).filter(li => !li.textContent!.trim()).length,
      itemsInsideSpan: ed.querySelectorAll('span li').length,
      // <ul> обязан содержать только <li> — span прямым ребёнком списка невалиден
      strayChildren: Array.from(ed.querySelectorAll('ul, ol'))
        .flatMap(l => Array.from(l.children))
        .filter(c => c.tagName !== 'LI').length,
      text: ed.textContent,
    }));

    expect(state.items).toBe(3);
    expect(state.empty).toBe(0);
    expect(state.itemsInsideSpan).toBe(0);
    expect(state.strayChildren).toBe(0);
    expect(state.text).toContain('Первый пункт');
    expect(state.text).toContain('Третий пункт');
  });

  test('пункт, покрытый целиком, отдаёт размер маркеру', async ({ page }) => {
    await openTextblock(page);
    await seedList(page, '<ul><li>Первый пункт</li><li>Второй пункт</li></ul>');
    await selectAcrossItems(page, 0, 0);
    await applySize(page, 28);

    const marker = await page.locator(EDITOR).evaluate((ed: HTMLElement) => {
      const items = ed.querySelectorAll('li');
      const px = (el: Element, pseudo?: string) =>
        parseFloat(getComputedStyle(el, pseudo).fontSize);
      return {
        firstInline: (items[0] as HTMLElement).style.fontSize,
        firstMarker: px(items[0], '::marker'),
        firstText: px(items[0]),
        secondMarker: px(items[1], '::marker'),
      };
    });

    // 28pt на самом <li> — от него наследует ::marker.
    expect(marker.firstInline).toBe('28pt');
    expect(marker.firstMarker).toBeCloseTo(marker.firstText, 1);
    // Соседний пункт не задет.
    expect(marker.secondMarker).toBeLessThan(marker.firstMarker);
  });

  test('частичное выделение внутри пункта не трогает маркер и соседний текст', async ({ page }) => {
    await openTextblock(page);
    await seedList(page, '<ul><li>абвгде</li></ul>');
    await page.locator(EDITOR).evaluate((ed: HTMLElement) => {
      const text = ed.querySelector('li')!.firstChild!;
      const range = document.createRange();
      range.setStart(text, 2);
      range.setEnd(text, 4);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await applySize(page, 24);

    const state = await page.locator(EDITOR).evaluate((ed: HTMLElement) => {
      const li = ed.querySelector('li')!;
      return {
        html: li.innerHTML,
        text: li.textContent,
        liInline: (li as HTMLElement).style.fontSize,
        sized: Array.from(li.querySelectorAll('[style*="font-size"]')).map(el => ({
          size: (el as HTMLElement).style.fontSize, text: el.textContent,
        })),
      };
    });

    expect(state.text).toBe('абвгде');
    // Пункт покрыт НЕ целиком — размер на <li> не поднимается (маркер прежний).
    expect(state.liInline).toBe('');
    expect(state.sized).toEqual([{ size: '24pt', text: 'вг' }]);
  });

  test('в разметку уходят пункты, а не пиксели', async ({ page }) => {
    await openTextblock(page);
    const editor = page.locator(EDITOR);
    await editor.click();
    await page.keyboard.press('Control+a');
    await applySize(page, 14);

    const html = await editor.evaluate((ed: HTMLElement) => ed.innerHTML);
    expect(html).toContain('font-size: 14pt');
    expect(html).not.toMatch(/font-size:\s*\d+px/);
    await expect(page.locator('#fontSizeTrigger .toolbar-fontsize-value')).toHaveText('14');
  });

  test('размер пункта переживает сохранение и перезагрузку', async ({ page }) => {
    // Регрессия: размер на <li> жил только в живом DOM — санитайзер не разрешал
    // style у пункта вовсе и срезал его на save, после reload маркер возвращался
    // к базовому кеглю. Живой DOM этого не показывает, ловится только round-trip.
    await openTextblock(page);
    await seedList(page, '<ul><li>Первый пункт</li><li>Второй пункт</li></ul>');
    await selectAcrossItems(page, 0, 0);
    await applySize(page, 28);

    await page.keyboard.press('Control+s');
    await page.waitForTimeout(1200);
    await page.reload();
    await page.locator('.step[data-step="2"]').click();
    await page.locator(EDITOR).waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(1000);

    const after = await page.locator(EDITOR).evaluate((ed: HTMLElement) => {
      const li = ed.querySelector('li') as HTMLElement;
      return {
        inline: li.style.fontSize,
        marker: parseFloat(getComputedStyle(li, '::marker').fontSize),
        text: parseFloat(getComputedStyle(li).fontSize),
      };
    });

    expect(after.inline).toBe('28pt');
    expect(after.marker).toBeCloseTo(after.text, 1);
  });

  test('вложенные пункты вместе с родителем — размер у каждого <li> свой', async ({ page }) => {
    await openTextblock(page);
    await seedList(page, '<ul><li>Родитель<ul><li>Ребёнок</li></ul></li><li>Сосед</li></ul>');
    // Выделяем родителя вместе с подпунктом целиком.
    await page.locator(EDITOR).evaluate((ed: HTMLElement) => {
      const items = ed.querySelectorAll('li');
      const range = document.createRange();
      range.setStart(items[0].firstChild!, 0);
      const child = items[1].firstChild!;
      range.setEnd(child, child.textContent!.length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await applySize(page, 18);

    const sizes = await page.locator(EDITOR).evaluate((ed: HTMLElement) =>
      Array.from(ed.querySelectorAll('li')).map(li => ({
        text: li.firstChild?.textContent,
        inline: (li as HTMLElement).style.fontSize,
      })),
    );

    // Родитель и ребёнок покрыты целиком → у каждого свой размер (ребёнок не
    // просто наследует родительский: иначе непокрытый подпункт менял бы кегль).
    expect(sizes[0].inline).toBe('18pt');
    expect(sizes[1].inline).toBe('18pt');
    // Сосед не тронут.
    expect(sizes[2].inline).toBe('');
  });
});
