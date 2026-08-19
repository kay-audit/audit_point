import { test, expect, openAct, SEED_ACTS } from '../fixtures';

/**
 * B-23/28/30: контракт кнопки «очистить форматирование» (removeFormat).
 *
 * Node-стабы (tests/js/) не реализуют document.execCommand — реальная
 * DOM-мутация проверяется только здесь, живым Chromium. Эмпирически (ручная
 * проверка через Playwright перед написанием этого файла) removeFormat:
 *  - разворачивает теги b/i/u/strike (текст остаётся, тег снимается);
 *  - снимает inline-style (font-size, color) — при этом «стилевой» span без
 *    других атрибутов разворачивается целиком, а не просто теряет style;
 *  - НЕ трогает contenteditable=false капсулы (.text-link/.text-footnote):
 *    они не входят в editable-поддерево выделения, и execCommand их
 *    пропускает целиком — тот же механизм, что защищает капсулы от bold/italic
 *    (см. _expandRangeOutOfMarkers в textblock-core.js, которым removeFormat
 *    сознательно не пользуется — расширение диапазона ему не нужно).
 */

const EDITOR = '.textblock-editor[data-text-block-id="txt-seed-1"]';

async function openTextblock(page) {
  await openAct(page, SEED_ACTS.withContent);
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.locator('.step[data-step="2"]').click();
  await page.locator(EDITOR).waitFor({ state: 'visible', timeout: 5000 });
}

test.describe('Textblock removeFormat (B-23/28/30)', () => {
  test('контракт: снимает b/i/u/strike и inline font-size/color, текст остаётся', async ({ page }) => {
    await openTextblock(page);
    const editor = page.locator(EDITOR);
    await editor.click();

    await page.evaluate(() => {
      const ed = document.querySelector(
        '.textblock-editor[data-text-block-id="txt-seed-1"]'
      ) as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.activeEditor = ed;
      ed.innerHTML =
        '<b>жирный</b> <i>курсив</i> <u>подчёркнутый</u> <strike>зачёркнутый</strike> ' +
        '<span style="color: rgb(255, 0, 0);">красный</span> ' +
        '<span style="font-size: 24pt;">крупный</span> конец';
    });

    await editor.click();
    await page.keyboard.press('Control+a');
    await page
      .locator('#globalTextBlockToolbar .toolbar-btn[data-command="removeFormat"]')
      .click();

    const html = await editor.innerHTML();
    expect(html).not.toMatch(/<(b|strong|em|u|strike)\b/i);
    expect(html).not.toMatch(/font-size/i);
    expect(html).not.toMatch(/color/i);
    await expect(editor).toHaveText(
      /жирный курсив подчёркнутый зачёркнутый красный крупный конец/
    );
  });

  test('выделение «жирный текст + капсула»: начертание снято, капсула жива/кликабельна, тело сноски цело', async ({
    page,
  }) => {
    await openTextblock(page);
    const editor = page.locator(EDITOR);
    await editor.click();

    // Капсулы (ссылка + сноска) — через evaluate, как в 16-capsule-integrity.spec.ts
    // (создание через UI идёт через prompt(), недоступный из Playwright).
    await page.evaluate(() => {
      const ed = document.querySelector(
        '.textblock-editor[data-text-block-id="txt-seed-1"]'
      ) as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.activeEditor = ed;
      ed.innerHTML =
        'важный текст ' +
        '<span class="text-link" data-link-id="L1" data-link-url="https://a.ru"' +
        ' contenteditable="false">ссылка</span> ' +
        '<span class="text-footnote" data-footnote-id="F1" data-footnote-text="тело сноски"' +
        ' contenteditable="false">сн</span> ' +
        'конец';
      tbm.attachLinkFootnoteHandlers();
    });

    const capsulesBefore = await editor.evaluate((el) =>
      [...el.querySelectorAll('.text-link, .text-footnote')].map((c) => c.outerHTML)
    );
    expect(capsulesBefore.length).toBe(2);

    // Реальное выделение всего + реальный клик по «Ж» (bold) — Chromium дробит
    // <b> вокруг contenteditable=false капсул, не оборачивая их целиком.
    await editor.click();
    await page.keyboard.press('Control+a');
    await page.locator('#globalTextBlockToolbar .toolbar-btn[data-command="bold"]').click();
    expect(await editor.innerHTML()).toMatch(/<b>/i);

    // Выделяем всё (жирный текст + обе капсулы) и жмём очистку формата.
    await editor.click();
    await page.keyboard.press('Control+a');
    await page
      .locator('#globalTextBlockToolbar .toolbar-btn[data-command="removeFormat"]')
      .click();

    // Начертание снято.
    expect(await editor.innerHTML()).not.toMatch(/<b>/i);

    // Капсулы byte-identical до/после — removeFormat их вообще не коснулся.
    const capsulesAfter = await editor.evaluate((el) =>
      [...el.querySelectorAll('.text-link, .text-footnote')].map((c) => c.outerHTML)
    );
    expect(capsulesAfter).toEqual(capsulesBefore);

    // Капсула кликабельна: dblclick включает inline-правку (enableInlineEditing) —
    // сработает только если слушатели капсулы живы (тот же узел, не клон/замена).
    const footnote = editor.locator('.text-footnote');
    await footnote.dblclick();
    await page.waitForTimeout(50);
    await expect(footnote).toHaveAttribute('contenteditable', 'true');
    await expect(footnote).toHaveClass(/\bediting-mode\b/);

    // Выходим кликом вне капсулы (штатный outsideClickHandler) — без изменений текста.
    await editor.click({ position: { x: 2, y: 2 } });
    await page.waitForTimeout(50);
    await expect(footnote).toHaveAttribute('contenteditable', 'false');
    await expect(footnote).not.toHaveClass(/\bediting-mode\b/);

    // Тело сноски и URL ссылки целы.
    await expect(footnote).toHaveAttribute('data-footnote-text', 'тело сноски');
    await expect(editor.locator('.text-link')).toHaveAttribute('data-link-url', 'https://a.ru');
  });
});
