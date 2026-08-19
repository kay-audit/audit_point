import { test, expect, openAct, SEED_ACTS, trackConsoleErrors } from '../fixtures';

/**
 * Регрессии редактора текстблоков (живой Chromium) — баги, которые принципиально
 * НЕ ловятся node:test (стабы _browser-stub.mjs не моделируют Selection,
 * contentEditable=false, нативные события контролов тулбара):
 *
 *  BUG-3  размер шрифта через КАСТОМНЫЙ дропдаун (бывший нативный <select> крал
 *         фокус у contenteditable → ресайз «не работал»). Драйвим РЕАЛЬНЫЕ клики
 *         по триггеру и пунктам — прежний spec звал applyFontSize напрямую и это
 *         слепое пятно пропускало регрессию.
 *  BUG-1  тулбар держится при переходе фокуса между двумя редакторами.
 *  BUG-2  клик по маркеру ставит каретку рядом — можно печатать вплотную к
 *         ведущему/единственному contenteditable=false маркеру.
 *  BUG-6  Enter перед ведущей сноской не расщепляет/не клонирует капсулу.
 *  BUG-4  вставка из Word извлекает ссылки на любой глубине и расширенных схем.
 */

const EDITOR = '.textblock-editor[data-text-block-id="txt-seed-1"]';

async function openTextblock(page) {
  await openAct(page, SEED_ACTS.withContent);
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.locator('.step[data-step="2"]').click();
  await page.locator(EDITOR).waitFor({ state: 'visible', timeout: 5000 });
}

test.describe('Текстблок: размер шрифта (кастомный дропдаун)', () => {
  test('BUG-3: размер применяется к выделению и меняется на КАЖДОЙ смене', async ({ page }) => {
    await openTextblock(page);
    const editor = page.locator(EDITOR);
    const trigger = page.locator('#fontSizeTrigger');

    // нативного <select> больше нет
    await expect(page.locator('#fontSizeSelect')).toHaveCount(0);

    const applySize = async (size: number) => {
      await editor.click({ clickCount: 3 }); // выделить абзац
      await trigger.click();                 // открыть меню (фокус редактора сохраняется)
      await page.locator(`#fontSizeMenu .toolbar-fontsize-option[data-size="${size}"]`).click();
      await page.waitForTimeout(40);
    };

    await applySize(28);
    await expect(trigger.locator('.toolbar-fontsize-value')).toHaveText('28');
    expect(await editor.evaluate((el) => el.querySelector('[style*="font-size: 28pt"]') !== null)).toBe(true);

    // ВТОРАЯ смена — здесь раньше «застывало»
    await applySize(12);
    await expect(trigger.locator('.toolbar-fontsize-value')).toHaveText('12');

    // ТРЕТЬЯ смена
    await applySize(20);
    await expect(trigger.locator('.toolbar-fontsize-value')).toHaveText('20');
  });
});

test.describe('Текстблок: тулбар при переходе между редакторами', () => {
  test('BUG-1: тулбар держится при A→B и серии переключений', async ({ page }) => {
    await openTextblock(page);
    const state = await page.evaluate(async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const tbm = (window as any).textBlockManager;
      const ed1 = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      // второй редактор через штатный createEditor (навешивает focus/blur)
      const tb2 = { id: 'txt-live-2', content: 'Второй блок.' };
      (window as any).AppState.textBlocks['txt-live-2'] = tb2;
      const ed2 = tbm.createEditor(tb2);
      ed1.parentElement!.appendChild(ed2);
      const tb = document.getElementById('globalTextBlockToolbar')!;

      ed1.focus(); await sleep(60);
      ed2.focus(); await sleep(360); // дольше стейл-таймера 200мс
      const afterSwitch = { hidden: tb.classList.contains('hidden'), active: tbm.activeEditor?.dataset.textBlockId };

      ed1.focus(); await sleep(60); ed2.focus(); await sleep(60); ed1.focus(); await sleep(360);
      const afterSeries = { hidden: tb.classList.contains('hidden'), active: tbm.activeEditor?.dataset.textBlockId };

      // регресс: фокус наружу — тулбар обязан скрыться
      (document.body as any).tabIndex = -1; document.body.focus(); await sleep(360);
      const afterOutside = { hidden: tb.classList.contains('hidden'), active: tbm.activeEditor?.dataset.textBlockId ?? null };

      ed2.remove();
      return { afterSwitch, afterSeries, afterOutside };
    });
    expect(state.afterSwitch).toEqual({ hidden: false, active: 'txt-live-2' });
    expect(state.afterSeries).toEqual({ hidden: false, active: 'txt-seed-1' });
    expect(state.afterOutside).toEqual({ hidden: true, active: null });
  });
});

test.describe('Текстблок: граница contenteditable=false маркера', () => {
  test('BUG-2: клик по половинам маркера ставит каретку перед/после', async ({ page }) => {
    await openTextblock(page);
    await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.activeEditor = ed;
      ed.innerHTML = '<span class="text-link" data-link-id="L1" data-link-url="https://a.ru" contenteditable="false">ссылка</span>';
      tbm.attachLinkFootnoteHandlers();
    });
    const box = await page.locator(`${EDITOR} .text-link`).boundingBox();
    if (!box) throw new Error('marker box not found');

    // невидимые caret-guard'ы (U+FEFF) и якорь размера (U+200B) вычищаем из текста
    const visibleText = (el: HTMLElement) => el.textContent!.replace(/[\uFEFF\u200B]/g, '');

    // левая половина → каретка ПЕРЕД → "L" уходит до маркера
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height / 2);
    await page.keyboard.type('L');
    await page.waitForTimeout(30);
    expect(await page.locator(EDITOR).evaluate(visibleText)).toMatch(/^L/);

    // правая половина → каретка ПОСЛЕ → "R" уходит за маркер
    await page.mouse.click(box.x + box.width * 0.85, box.y + box.height / 2);
    await page.keyboard.type('R');
    await page.waitForTimeout(30);
    expect(await page.locator(EDITOR).evaluate(visibleText)).toMatch(/R$/);
  });

  test('BUG-6: Enter перед ведущей сноской не клонирует капсулу', async ({ page }) => {
    await openTextblock(page);
    await page.locator(EDITOR).click();
    await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.activeEditor = ed;
      ed.innerHTML = '<span class="text-footnote" data-footnote-id="F1" data-footnote-text="прим" contenteditable="false">сноска</span> хвост';
      tbm.attachLinkFootnoteHandlers();
      tbm.renumberEditorFootnotes();
      const sel = window.getSelection()!; const r = document.createRange();
      r.setStart(ed, 0); r.collapse(true);
      sel.removeAllRanges(); sel.addRange(r);
    });
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(40);
    // сноска ОДНА (нет фантомных клонов), номер не задвоился
    expect(await page.locator(`${EDITOR} .text-footnote`).count()).toBe(1);
  });
});

test.describe('Текстблок: вставка ссылок из Word', () => {
  test('BUG-4: ссылки извлекаются на любой глубине, схемы расширены, js: блокируется', async ({ page }) => {
    await openTextblock(page);
    const res = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.activeEditor = ed; ed.innerHTML = ''; ed.focus();
      const sel = window.getSelection()!; const r = document.createRange();
      r.selectNodeContents(ed); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);

      const wordHtml = '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head>'
        + '<style><!-- p {color:red} --></style></head><body><!--StartFragment-->'
        + '<p class="MsoNormal">Смотри <span style="mso-x"><b><a href="https://example.com/p">сайт</a></b></span>'
        + ' и <a href="file:///C:/d.pdf">файл</a>, раздел <a href="#ch2">ниже</a>'
        + ', а это <a href="javascript:alert(1)">опасно</a>.<o:p></o:p></p><!--EndFragment--></body></html>';
      const ev = { preventDefault() {}, clipboardData: { getData(t: string) {
        if (t === 'text/html') return wordHtml;
        if (t === 'text/plain') return 'Смотри сайт и файл, раздел ниже, а это опасно.';
        return '';
      } } };
      tbm.handleEditorPaste(ev, ed, { id: 'txt-seed-1' });

      const links = [...ed.querySelectorAll('.text-link')].map((a) => a.getAttribute('data-link-url'));
      return { links, hasJs: ed.innerHTML.includes('javascript') };
    });
    expect(res.links).toEqual(['https://example.com/p', 'file:///C:/d.pdf', '#ch2']);
    expect(res.hasJs).toBe(false);
  });

  test('BUG-5: вставка из Word сохраняет переносы абзацев как <br>', async ({ page }) => {
    await openTextblock(page);
    const res = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.activeEditor = ed; ed.innerHTML = ''; ed.focus();
      const sel = window.getSelection()!; const r = document.createRange();
      r.selectNodeContents(ed); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);

      const wordHtml = '<html><body><!--StartFragment-->'
        + '<p class="MsoNormal">Первый абзац</p>'
        + '<p class="MsoNormal">Второй абзац</p>'
        + '<p class="MsoNormal">Третий</p>'
        + '<!--EndFragment--></body></html>';
      const ev = { preventDefault() {}, clipboardData: { getData(t: string) {
        if (t === 'text/html') return wordHtml;
        if (t === 'text/plain') return 'Первый абзац\nВторой абзац\nТретий';
        return '';
      } } };
      tbm.handleEditorPaste(ev, ed, { id: 'txt-seed-1' });
      return { brs: ed.querySelectorAll('br').length, text: ed.textContent };
    });
    // три абзаца → два разделителя-переноса (хвостовой снят)
    expect(res.brs).toBe(2);
    expect(res.text).toContain('Первый абзац');
    expect(res.text).toContain('Второй абзац');
    expect(res.text).toContain('Третий');
  });

  test('BUG-4: вставленная ссылка получает обработчики сразу (без перезахода)', async ({ page }) => {
    await openTextblock(page);
    const res = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.activeEditor = ed; ed.innerHTML = ''; ed.focus();
      const sel = window.getSelection()!; const r = document.createRange();
      r.selectNodeContents(ed); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);

      const wordHtml = '<p>См <a href="https://example.com">сайт</a> тут</p>';
      const ev = { preventDefault() {}, clipboardData: { getData(t: string) {
        return t === 'text/html' ? wordHtml : 'См сайт тут';
      } } };
      tbm.handleEditorPaste(ev, ed, { id: 'txt-seed-1' });
      const marker = ed.querySelector('.text-link') as any;
      // attachLinkFootnoteHandlers вешает набор через AbortController _lfAbort
      return { hasHandlers: !!(marker && marker._lfAbort), ce: marker && marker.getAttribute('contenteditable') };
    });
    expect(res.hasHandlers).toBe(true);
    expect(res.ce).toBe('false');
  });
});

test.describe('Текстблок: рендер из сохранённого контента (reload)', () => {
  test('BUG-2.2: contenteditable=false ре-применяется при createEditor (бэк его срезал)', async ({ page }) => {
    await openTextblock(page);
    const res = await page.evaluate(() => {
      const tbm = (window as any).textBlockManager;
      // Контент, каким он приходит из БД: бэк-санитайзер (bleach) срезал
      // contenteditable — его нет в allowlist'е span-атрибутов.
      const tb = {
        id: 'txt-reload',
        content: '<span class="text-link" data-link-id="L1" data-link-url="https://a.ru">ссылка</span> хвост'
          + '<span class="text-footnote" data-footnote-id="F1" data-footnote-text="п">сн</span>',
      };
      (window as any).AppState.textBlocks['txt-reload'] = tb;
      const ed = tbm.createEditor(tb);
      const markers = [...ed.querySelectorAll('.text-link, .text-footnote')];
      return { ce: markers.map((m) => m.getAttribute('contenteditable')) };
    });
    // normalizeMarkers восстановил рантайм-атрибут на ВСЕХ маркерах
    expect(res.ce).toEqual(['false', 'false']);
  });

  test('BUG-1: размер маркера не откатывается после выхода и возврата в блок', async ({ page }) => {
    await openTextblock(page);
    const res = await page.evaluate(async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const tbm = (window as any).textBlockManager;
      ed.focus(); tbm.activeEditor = ed;
      ed.innerHTML = 'до <span class="text-link" data-link-id="L1" data-link-url="https://a.ru" contenteditable="false">ссылка</span> после';
      tbm.attachLinkFootnoteHandlers();

      const selectMarker = () => {
        const m = ed.querySelector('.text-link')!;
        const sel = window.getSelection()!; const r = document.createRange();
        r.selectNode(m); sel.removeAllRanges(); sel.addRange(r);
      };
      // две смены размера → вложенность OUTER20[ SPAN36[ MARKER ] ]
      selectMarker(); tbm.applyFontSize(20);
      selectMarker(); tbm.applyFontSize(36);
      const sizeLive = (ed.querySelector('.text-link') as HTMLElement).style.fontSize;

      // выход и возврат: blur → focus (focus-обёртка зовёт applyFormattingToNewNodes,
      // в т.ч. через setTimeout(100))
      ed.dispatchEvent(new FocusEvent('blur'));
      await sleep(10);
      ed.focus();
      tbm.handleEditorFocus(ed, (window as any).AppState.textBlocks['txt-seed-1']);
      await sleep(160);
      const sizeAfter = (ed.querySelector('.text-link') as HTMLElement).style.fontSize;
      return { sizeLive, sizeAfter };
    });
    expect(res.sizeLive).toBe('36pt');
    // BUG-1: раньше inheritFormattingToElement откатывал маркер на внешний 20pt
    expect(res.sizeAfter).toBe('36pt');
  });
});

test.describe('Текстблок: каретка у капсулы (гибрид Варианта 2)', () => {
  test('CARET: guard-узлы расставлены при рендере и вычищены при сохранении', async ({ page }) => {
    await openTextblock(page);
    const res = await page.evaluate(() => {
      const tbm = (window as any).textBlockManager;
      const tb = {
        id: 'txt-guard',
        content: '<span class="text-link" data-link-id="L1" data-link-url="https://a.ru">ссылка</span> хвост'
          + '<span class="text-footnote" data-footnote-id="F1" data-footnote-text="п">сн</span>',
      };
      (window as any).AppState.textBlocks['txt-guard'] = tb;
      const ed = tbm.createEditor(tb);
      document.body.appendChild(ed);
      // ведущая капсула (text-link первой) → перед ней guard U+FEFF;
      // хвостовая (text-footnote последней) → guard после неё.
      const leadGuard = ed.firstChild && ed.firstChild.nodeType === 3
        && (ed.firstChild as Text).data === '\uFEFF';
      const tailGuard = ed.lastChild && ed.lastChild.nodeType === 3
        && (ed.lastChild as Text).data === '\uFEFF';
      // saveContent стрипает guard'ы из хранимого content
      tbm.saveContent('txt-guard', ed.innerHTML);
      const stored = (window as any).AppState.textBlocks['txt-guard'].content as string;
      ed.remove();
      return { leadGuard, tailGuard, storedHasGuard: stored.indexOf('\uFEFF') !== -1 };
    });
    expect(res.leadGuard).toBe(true);
    expect(res.tailGuard).toBe(true);
    expect(res.storedHasGuard).toBe(false);   // в БД/превью/DOCX guard'ы не уходят
  });

  test('CARET: Home + ввод печатает текст ПЕРЕД ведущей капсулой (клавиатура)', async ({ page }) => {
    await openTextblock(page);
    await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.activeEditor = ed;
      ed.innerHTML = '<span class="text-link" data-link-id="L1" data-link-url="https://a.ru" contenteditable="false">ссылка</span> хвост';
      tbm.normalizeMarkers(ed);          // расставит guard перед ведущей капсулой
      tbm.attachLinkFootnoteHandlers();
      ed.focus();
      const sel = window.getSelection()!; const r = document.createRange();
      r.selectNodeContents(ed); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); // каретка в конец
    });
    await page.keyboard.press('Home');       // → каретка в guard перед капсулой
    await page.keyboard.type('НАЧАЛО');
    await page.waitForTimeout(30);
    const text = await page.locator(EDITOR).evaluate(
      (el) => el.textContent!.replace(/[\uFEFF\u200B]/g, ''));
    expect(text.startsWith('НАЧАЛО')).toBe(true);
    expect(text).toContain('ссылка');
  });

  test('CARET: ← печатает перед ведущей капсулой, → печатает после хвостовой', async ({ page }) => {
    await openTextblock(page);
    await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.activeEditor = ed;
      // единственная капсула — она и ведущая, и хвостовая
      ed.innerHTML = '<span class="text-link" data-link-id="L1" data-link-url="https://a.ru" contenteditable="false">ссылка</span>';
      tbm.normalizeMarkers(ed);
      tbm.attachLinkFootnoteHandlers();
      ed.focus();
      const sel = window.getSelection()!; const r = document.createRange();
      r.selectNodeContents(ed); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); // каретка после капсулы
    });
    // → у хвостовой капсулы → guard после неё → печатаем "ПОСЛЕ"
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('ПОСЛЕ');
    // Home → перед ведущей капсулой → печатаем "ДО"
    await page.keyboard.press('Home');
    await page.keyboard.type('ДО');
    await page.waitForTimeout(30);
    const text = await page.locator(EDITOR).evaluate(
      (el) => el.textContent!.replace(/[\uFEFF\u200B]/g, ''));
    expect(text.startsWith('ДО')).toBe(true);
    expect(text.endsWith('ПОСЛЕ')).toBe(true);
    expect(text).toContain('ссылка');
  });
});
