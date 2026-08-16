import { test, expect, openAct, SEED_ACTS, waitForSaveComplete } from '../fixtures';

/**
 * Многоуровневые списки в rich-редакторе текстблока (B3/C1/D2).
 *
 * Юнит-тесты (`tests/js/textblock-list-nesting.test.mjs`) гоняют нормализатор
 * вложенности на рукописном мини-DOM и не умеют исполнить `document.execCommand`
 * вовсе — здесь же живой Chromium: что реально порождает `execCommand('indent')`,
 * снимает ли `removeFormat` список без потери капсул, переживает ли вложенность
 * round-trip через санитайзер `acts` (DOMPurify недоступен в node), и не теряет
 * ли contenteditable выделение при клике по пунктам дропдауна списков (BUG-3).
 */

const EDITOR = '.textblock-editor[data-text-block-id="txt-seed-1"]';

async function openTextblock(page) {
  await openAct(page, SEED_ACTS.withContent);
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.locator('.step[data-step="2"]').click();
  await page.locator(EDITOR).waitFor({ state: 'visible', timeout: 5000 });
  // StorageManager отключает tracking ~500ms после loadActContent (см. 18/20).
  await page.waitForTimeout(1000);
}

/**
 * Выделяет весь контент редактора и превращает его в маркированный список
 * через дропдаун тулбара (не через клавиатурный шорткат — списки создаются
 * только пунктом меню). Оставляет активный редактор в фокусе.
 */
async function makeUnorderedList(page) {
  const editor = page.locator(EDITOR);
  await editor.click();
  await page.keyboard.press('Control+a');
  await page.locator('#listsTrigger').click();
  await page
    .locator('#listsMenu .toolbar-dropdown-option[data-command="insertUnorderedList"]')
    .click();
}

/** Каждый ul/ol в редакторе содержит ТОЛЬКО <li>-детей — признак валидной вложенности. */
async function hasOnlyValidListNesting(editor): Promise<boolean> {
  return editor.evaluate((ed: HTMLElement) => {
    const lists = ed.querySelectorAll('ul, ol');
    for (const list of Array.from(lists)) {
      for (const child of Array.from(list.children)) {
        if (child.tagName !== 'LI') return false;
      }
    }
    return true;
  });
}

/**
 * 0-based глубина вложенности первого текстового узла, содержащего `needle`
 * (число ul/ol-предков минус один) — тот же расчёт, что `_listLevel` в
 * textblock-editor.js. -1, если текст не найден.
 */
async function listDepthOf(editor, needle: string): Promise<number> {
  return editor.evaluate((ed: HTMLElement, text: string) => {
    const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.textContent && node.textContent.includes(text)) {
        let depth = -1;
        let el: HTMLElement | null = node.parentElement;
        while (el && el !== ed) {
          if (el.tagName === 'UL' || el.tagName === 'OL') depth++;
          el = el.parentElement;
        }
        return depth;
      }
    }
    return -1;
  }, needle);
}

/**
 * После сохранения и перезагрузки акта H3 может предложить восстановить
 * несинхронизированный локальный черновик (диалог «Найден несохранённый
 * черновик» с кнопками Восстановить/Отклонить, см. 18-textblock-alignment).
 * Отклоняем — round-trip тесты проверяют именно копию из БД. Диалог может не
 * появиться (нечего восстанавливать) — тогда просто продолжаем.
 */
async function discardLocalDraftIfPrompted(page): Promise<void> {
  const discardDraft = page.getByRole('button', { name: 'Отклонить' });
  try {
    await discardDraft.waitFor({ state: 'visible', timeout: 2000 });
    await discardDraft.click();
  } catch {
    // Черновика не было.
  }
}

test.describe('Textblock multilevel lists (B3/C1/D2)', () => {
  test('Tab углубляет уровень пункта списка, Shift+Tab поднимает; вложенность валидна', async ({
    page,
  }) => {
    await openTextblock(page);
    const editor = page.locator(EDITOR);

    await makeUnorderedList(page);
    expect(await editor.evaluate((ed) => ed.querySelectorAll('li').length)).toBe(1);

    // Второй пункт того же уровня — иначе Chromium-у нечего вкладывать под Tab.
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Второй пункт');
    expect(await editor.evaluate((ed) => ed.querySelectorAll('li').length)).toBe(2);
    expect(await listDepthOf(editor, 'Второй пункт')).toBe(0);

    await page.keyboard.press('Tab');
    expect(await listDepthOf(editor, 'Второй пункт')).toBe(1);
    expect(await hasOnlyValidListNesting(editor)).toBe(true);
    // Именно валидная форма — вложенный ul уезжает ВНУТРЬ предыдущего <li>, а
    // не chromium-овское <ul><li>a</li><ul>…</ul></ul> (список рядом с li).
    const nestedParentTag = await editor.evaluate(
      (ed) => ed.querySelector('ul ul, ul ol, ol ul, ol ol')?.parentElement?.tagName
    );
    expect(nestedParentTag).toBe('LI');

    await page.keyboard.press('Shift+Tab');
    expect(await listDepthOf(editor, 'Второй пункт')).toBe(0);
    expect(await hasOnlyValidListNesting(editor)).toBe(true);
  });

  test('Tab вне списка не перехвачен — фокус уходит нативно, blockquote не появляется', async ({
    page,
  }) => {
    await openTextblock(page);
    const editor = page.locator(EDITOR);

    await editor.click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Tab');

    // Никакого preventDefault на голом Tab вне списка — фокус ушёл со страницы.
    await expect(editor).not.toBeFocused();
    expect(await editor.innerHTML()).not.toMatch(/<blockquote/i);
    await expect(editor).toHaveText(/Исходный текст/);
  });

  test('Пункты меню «Уровень глубже»/«Уровень выше» делают то же, что Tab/Shift+Tab', async ({
    page,
  }) => {
    await openTextblock(page);
    const editor = page.locator(EDITOR);

    await makeUnorderedList(page);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Второй пункт');
    expect(await listDepthOf(editor, 'Второй пункт')).toBe(0);

    await page.locator('#listsTrigger').click();
    await page
      .locator('#listsMenu .toolbar-dropdown-option[data-command="indent"]')
      .click();
    expect(await listDepthOf(editor, 'Второй пункт')).toBe(1);
    expect(await hasOnlyValidListNesting(editor)).toBe(true);

    await page.locator('#listsTrigger').click();
    await page
      .locator('#listsMenu .toolbar-dropdown-option[data-command="outdent"]')
      .click();
    expect(await listDepthOf(editor, 'Второй пункт')).toBe(0);
  });

  test('Гейт: indent вне списка — тихий no-op, blockquote не появляется ни до, ни после перезагрузки', async ({
    page,
  }) => {
    await openTextblock(page);
    const editor = page.locator(EDITOR);

    await editor.click();
    await page.keyboard.press('Home');
    const before = await editor.innerHTML();
    // Сам фокус-клик в pristine-редактор уже помечает акт «unsaved» (существующее
    // поведение, не связанное со списками — blur/focus-сток пишет textBlock.content
    // безусловно). Берём индикатор ПОСЛЕ клика как базу, чтобы проверить именно
    // отсутствие ДОПОЛНИТЕЛЬНОЙ мутации от самого no-op indent.
    const indicatorBeforeAttempt = await page.locator('#saveIndicatorBtn').getAttribute('class');

    // Каретка вне <li> → пункт «Уровень глубже» помечен aria-disabled (UI-слой,
    // textblock-toolbar.js::_updateListsTriggerState): видим, но неактивен.
    await page.locator('#listsTrigger').click();
    const indentOption = page.locator(
      '#listsMenu .toolbar-dropdown-option[data-command="indent"]'
    );
    await expect(indentOption).toHaveAttribute('aria-disabled', 'true');

    // Форс-клик в обход собственной actionability-проверки Playwright —
    // проверяем сам JS-гейт (toolbar-dropdown.js: клик по aria-disabled-пункту
    // не зовёт onSelect, меню остаётся открытым) И нижний гейт execCommand
    // (textblock-core.js: indent/outdent вне <li> — тихий no-op).
    await indentOption.click({ force: true });
    expect(await editor.innerHTML()).toBe(before);
    expect(await editor.innerHTML()).not.toMatch(/<blockquote/i);
    await expect(page.locator('#listsMenu')).toBeVisible();
    // no-op сам по себе не добавляет новую запись поверх уже случившегося на фокусе.
    expect(await page.locator('#saveIndicatorBtn').getAttribute('class')).toBe(
      indicatorBeforeAttempt
    );

    await page.keyboard.press('Escape');
    await expect(page.locator('#listsMenu')).toBeHidden();

    await openAct(page, SEED_ACTS.withContent);
    await discardLocalDraftIfPrompted(page);
    await page.locator('.step[data-step="2"]').click();
    const reloadedEditor = page.locator(EDITOR);
    await reloadedEditor.waitFor({ state: 'visible', timeout: 5000 });

    expect(await reloadedEditor.innerHTML()).not.toMatch(/<blockquote/i);
    await expect(reloadedEditor).toHaveText(/Исходный текст/);
  });

  test('Многоуровневый список переживает сохранение и перезагрузку', async ({ page }) => {
    await openTextblock(page);
    const editor = page.locator(EDITOR);

    await makeUnorderedList(page);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Подпункт первого уровня');
    await page.keyboard.press('Tab');

    expect(await listDepthOf(editor, 'Подпункт первого уровня')).toBe(1);
    expect(await hasOnlyValidListNesting(editor)).toBe(true);

    const indicator = page.locator('#saveIndicatorBtn');
    await expect(indicator).toHaveClass(/\bunsaved\b|\blocal-only\b/, { timeout: 4000 });
    await page.keyboard.press('Control+s');
    await waitForSaveComplete(page);

    // Reload: контент пришёл из БД — bleach обязан пропустить ul/ol/li с вложенностью.
    await openAct(page, SEED_ACTS.withContent);
    await discardLocalDraftIfPrompted(page);
    await page.locator('.step[data-step="2"]').click();
    const reloadedEditor = page.locator(EDITOR);
    await reloadedEditor.waitFor({ state: 'visible', timeout: 5000 });

    expect(await listDepthOf(reloadedEditor, 'Подпункт первого уровня')).toBe(1);
    expect(await hasOnlyValidListNesting(reloadedEditor)).toBe(true);
    await expect(reloadedEditor).toHaveText(/Исходный текст/);
    await expect(reloadedEditor).toHaveText(/Подпункт первого уровня/);
  });

  test('Капсулы ссылки и сноски внутри пункта списка целы после indent/outdent', async ({
    page,
  }) => {
    await openTextblock(page);
    const editor = page.locator(EDITOR);
    await editor.click();

    // Капсулы — через evaluate (создание через UI идёт через prompt(),
    // недоступный из Playwright, см. 16-capsule-integrity.spec.ts).
    await page.evaluate(() => {
      const ed = document.querySelector(
        '.textblock-editor[data-text-block-id="txt-seed-1"]'
      ) as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.activeEditor = ed;
      ed.innerHTML =
        '<ul><li>Первый пункт</li>' +
        '<li><span class="text-link" data-link-id="L1" data-link-url="https://a.ru"' +
        ' contenteditable="false">ссылка</span> текст ' +
        '<span class="text-footnote" data-footnote-id="F1" data-footnote-text="тело сноски"' +
        ' contenteditable="false">сн</span> конец</li></ul>';
      tbm.attachLinkFootnoteHandlers();
    });

    const capsulesBefore = await editor.evaluate((el) =>
      [...el.querySelectorAll('.text-link, .text-footnote')].map((c) => c.outerHTML)
    );
    expect(capsulesBefore.length).toBe(2);

    // Каретка — в конце текстового узла второго <li> (после обеих капсул).
    await page.evaluate(() => {
      const ed = document.querySelector(
        '.textblock-editor[data-text-block-id="txt-seed-1"]'
      ) as HTMLElement;
      const li = ed.querySelectorAll('li')[1];
      const textNode = li.lastChild as Text;
      const range = document.createRange();
      range.setStart(textNode, textNode.length);
      range.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      ed.focus();
    });

    await page.keyboard.press('Tab');
    expect(await listDepthOf(editor, 'конец')).toBe(1);
    expect(await hasOnlyValidListNesting(editor)).toBe(true);
    expect(
      await editor.evaluate((el) =>
        [...el.querySelectorAll('.text-link, .text-footnote')].map((c) => c.outerHTML)
      )
    ).toEqual(capsulesBefore);

    await page.keyboard.press('Shift+Tab');
    expect(await listDepthOf(editor, 'конец')).toBe(0);
    expect(
      await editor.evaluate((el) =>
        [...el.querySelectorAll('.text-link, .text-footnote')].map((c) => c.outerHTML)
      )
    ).toEqual(capsulesBefore);
  });

  test('Расширенный removeFormat снимает список и выравнивание, капсулы остаются целы (D2)', async ({
    page,
  }) => {
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
        '<ul><li style="text-align: center;"><b>Первый пункт</b> с ' +
        '<span class="text-link" data-link-id="L1" data-link-url="https://a.ru"' +
        ' contenteditable="false">ссылкой</span></li>' +
        '<li>Второй пункт со ' +
        '<span class="text-footnote" data-footnote-id="F1" data-footnote-text="тело сноски"' +
        ' contenteditable="false">сноской</span></li></ul>';
      tbm.attachLinkFootnoteHandlers();
    });

    const capsulesBefore = await editor.evaluate((el) =>
      [...el.querySelectorAll('.text-link, .text-footnote')].map((c) => c.outerHTML)
    );
    expect(capsulesBefore.length).toBe(2);

    await editor.click();
    await page.keyboard.press('Control+a');
    await page
      .locator('#globalTextBlockToolbar .toolbar-btn[data-command="removeFormat"]')
      .click();

    const html = await editor.innerHTML();
    expect(html).not.toMatch(/<(ul|ol|li|b|strong)\b/i);
    expect(html).not.toMatch(/text-align/i);

    const capsulesAfter = await editor.evaluate((el) =>
      [...el.querySelectorAll('.text-link, .text-footnote')].map((c) => c.outerHTML)
    );
    expect(capsulesAfter).toEqual(capsulesBefore);
    await expect(editor).toHaveText(/Первый пункт с ссылкой/);
    await expect(editor).toHaveText(/Второй пункт со сноской/);
  });

  test('Дропдауны тулбара открываются, применяют команду и не теряют выделение редактора (BUG-3)', async ({
    page,
  }) => {
    await openTextblock(page);
    const editor = page.locator(EDITOR);
    await editor.click();
    await page.keyboard.press('Control+a');

    // pointerdown/mousedown триггера — preventDefault, иначе contenteditable
    // потерял бы выделение раньше click, и команда ушла бы в ветку «каретка».
    await page.locator('#alignTrigger').click();
    await expect(page.locator('#alignMenu')).toBeVisible();
    expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(false);

    await page
      .locator('#alignMenu .toolbar-dropdown-option[data-command="justifyCenter"]')
      .click();
    await expect(page.locator('#alignMenu')).toBeHidden();
    expect(await editor.innerHTML()).toMatch(/text-align:\s*center/i);

    // Тот же контракт — у дропдауна списков.
    await editor.click();
    await page.keyboard.press('Control+a');
    await page.locator('#listsTrigger').click();
    await expect(page.locator('#listsMenu')).toBeVisible();
    expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(false);

    await page
      .locator('#listsMenu .toolbar-dropdown-option[data-command="insertUnorderedList"]')
      .click();
    await expect(page.locator('#listsMenu')).toBeHidden();
    expect(await editor.evaluate((ed) => ed.querySelectorAll('li').length)).toBeGreaterThan(0);
  });
});
