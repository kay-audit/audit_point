import { test, expect, openAct, SEED_ACTS } from '../fixtures';

// ---------------------------------------------------------------------------
// Task A: вставка форматирования из Microsoft Word.
//
// Пайплайн _buildWordPasteFragment гоняет РЕАЛЬНЫЙ DOMPurify + real-DOM
// _normalizeWordFontSizes / flatten / реконструкцию капсул. В node-тестах его
// проверить нельзя (нет DOMPurify — юнит-тесты покрыли только чистые предикаты
// _wordFontSizeToPx). Поэтому смысловое покрытие — здесь, вызовом настоящих
// методов textBlockManager в браузере на реальном Word-HTML.
//
// Первичный (надёжный) путь: page.evaluate → tbm._buildWordPasteFragment(html),
// ассерты на получившийся фрагмент. Вторичный (E2E): диспатч ClipboardEvent
// 'paste' с DataTransfer(text/html) → handleEditorPaste → insertHTML, ассерт на
// живой редактор и сохранённый AppState.textBlocks[...].content.
// ---------------------------------------------------------------------------

const EDITOR_SEL = '.textblock-editor[data-text-block-id="txt-seed-1"]';

// Zero-width-no-break-space (U+FEFF) — рантайм-only caret-guard редактора.
const GUARD = '﻿';

// Реалистичный экспорт из Word: центрирование, жирный/курсив, инлайн-стиль с
// pt-размером + цветом + фоном, пустой <o:p>, ссылка, content-control <w:sdt>.
const WORD_HTML = [
  '<meta name=Generator content="Microsoft Word 15">',
  "<p class=MsoNormal style='text-align:center'>",
  "  <b style='mso-bidi-font-weight:normal'>жирный</b>",
  '  <i>курсив</i>',
  "  <span style='font-size:11.0pt;color:#FF0000;background:yellow'>красный 11pt</span>",
  '  <o:p></o:p>',
  '</p>',
  '<p><a href="https://example.com">ссылка</a> и <w:sdt>внутри-контрола</w:sdt> хвост</p>',
].join('\n');

/**
 * Строит Word-фрагмент настоящим методом в браузере и возвращает снимок:
 * сериализованный HTML, видимый текст, набор style-атрибутов и данные капсул.
 */
async function buildWordFrag(page, wordHtml: string) {
  return await page.evaluate((html) => {
    const tbm = (window as any).textBlockManager;
    const frag = tbm._buildWordPasteFragment(html);
    const div = document.createElement('div');
    div.appendChild(frag.cloneNode(true));
    const links = [...div.querySelectorAll('span.text-link')];
    return {
      html: div.innerHTML,
      text: div.textContent || '',
      anchors: div.querySelectorAll('a').length,
      boldText: (div.querySelector('b, strong') as HTMLElement | null)?.textContent ?? null,
      italicText: (div.querySelector('i, em') as HTMLElement | null)?.textContent ?? null,
      linkCount: links.length,
      linkUrls: links.map((a) => a.getAttribute('data-link-url')),
      linkIds: links.map((a) => a.getAttribute('data-link-id')),
      styleAttrs: [...div.querySelectorAll('[style]')].map((e) => e.getAttribute('style') || ''),
    };
  }, wordHtml);
}

/** Переходит на шаг 2, дожидается сид-редактора и делает его активным. */
async function openStep2AndActivate(page) {
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.locator('.step[data-step="2"]').click();
  await page.locator(EDITOR_SEL).waitFor({ state: 'visible', timeout: 5000 });
  await page.locator(EDITOR_SEL).click();
  await page.evaluate(() => {
    const ed = document.querySelector(
      '.textblock-editor[data-text-block-id="txt-seed-1"]',
    ) as HTMLElement;
    (window as any).textBlockManager.activeEditor = ed;
  });
}

test.describe('word-paste: _isWordHtml распознавание', () => {
  test.beforeEach(async ({ page }) => { await openAct(page, SEED_ACTS.withContent); });

  test('true для Word-сигнатур (mso/MsoNormal/<o:p>/Generator), false для plain и своего буфера', async ({ page }) => {
    const res = await page.evaluate((wordHtml) => {
      const tbm = (window as any).textBlockManager;
      return {
        fullFragment: tbm._isWordHtml(wordHtml),
        msoPrefix: tbm._isWordHtml('<span style="mso-fareast-language:RU">x</span>'),
        msoClass: tbm._isWordHtml('<p class=MsoNormal>абзац</p>'),
        oParagraph: tbm._isWordHtml('<p>x<o:p></o:p></p>'),
        generatorMeta: tbm._isWordHtml('<meta name=Generator content="Microsoft Word 15"><p>x</p>'),
        plain: tbm._isWordHtml('<b>x</b>'),
        ownClipboard: tbm._isWordHtml('<div data-aw-clip="1"><b>x</b></div>'),
      };
    }, WORD_HTML);
    expect(res.fullFragment).toBe(true);
    expect(res.msoPrefix).toBe(true);
    expect(res.msoClass).toBe(true);
    expect(res.oParagraph).toBe(true);
    expect(res.generatorMeta).toBe(true);
    expect(res.plain).toBe(false);        // без сигнатур — не Word
    expect(res.ownClipboard).toBe(false); // свой буфер, не Word
  });
});

test.describe('word-paste: _buildWordPasteFragment пайплайн (реальный DOMPurify)', () => {
  test.beforeEach(async ({ page }) => { await openAct(page, SEED_ACTS.withContent); });

  test('инлайн-формат b/i сохранён; весь видимый текст на месте', async ({ page }) => {
    const r = await buildWordFrag(page, WORD_HTML);
    expect(r.boldText).toBe('жирный');   // <b>/<strong> сохранён
    expect(r.italicText).toBe('курсив'); // <i>/<em> сохранён
    // Видимый текст всех фрагментов сохранён.
    expect(r.text).toContain('жирный');
    expect(r.text).toContain('курсив');
    expect(r.text).toContain('красный 11pt');
    expect(r.text).toContain('ссылка');
    expect(r.text).toContain('хвост');
  });

  test('font-size остаётся в пунктах: 11.0pt → 11pt, ни одной px-величины в стилях', async ({ page }) => {
    const r = await buildWordFrag(page, WORD_HTML);
    // Проверяем ТОЛЬКО style-атрибуты: видимый текст «красный 11pt» тоже содержит
    // подстроку «11pt», поэтому по всему html искать pt нельзя.
    const styles = r.styleAttrs.join(' | ').toLowerCase();
    // Word пишет размеры в пунктах — единица редактора теперь та же, поэтому
    // нормализация лишь округляет «11.0pt» до целого.
    expect(r.styleAttrs.some((s) => /font-size:\s*11pt/.test(s))).toBe(true);
    expect(styles).not.toMatch(/[0-9.]+px/); // ни одной px-единицы не просочилось
  });

  test('color / background / text-align отброшены (маппится только набор тулбара)', async ({ page }) => {
    const r = await buildWordFrag(page, WORD_HTML);
    const styles = r.styleAttrs.join(' | ').toLowerCase();
    expect(styles).not.toContain('color');       // #FF0000 отброшен (в т.ч. background-color)
    expect(styles).not.toContain('background');  // фон отброшен
    expect(styles).not.toContain('text-align');  // центрирование отброшено
  });

  test('<a> → капсула ссылки (span.text-link, свежий id), без голого <a>', async ({ page }) => {
    const r = await buildWordFrag(page, WORD_HTML);
    expect(r.anchors).toBe(0);                             // голого <a> не осталось
    expect(r.linkCount).toBe(1);                           // ровно одна капсула
    expect(r.linkUrls).toEqual(['https://example.com']);  // URL прошёл validateLinkUrl
    expect(r.linkIds[0]).toBeTruthy();                    // свежий data-link-id проставлен
  });

  test('Word-шум вычищен (<o:p>/mso-/<w:>), но текст из <w:sdt> сохранён (не data-loss)', async ({ page }) => {
    const r = await buildWordFrag(page, WORD_HTML);
    const html = r.html.toLowerCase();
    expect(html).not.toContain('o:p');   // пустой абзац Word убран
    expect(html).not.toContain('mso-');  // mso-CSS не просочился
    expect(html).not.toContain('<w:');   // content-control-теги убраны
    // Видимый текст внутри <w:sdt> развёрнут (unwrap), а не удалён с содержимым.
    expect(r.text).toContain('внутри-контрола');
  });
});

test.describe('word-paste: E2E вставка в живой редактор', () => {
  test.beforeEach(async ({ page }) => { await openAct(page, SEED_ACTS.withContent); });

  test('paste Word-HTML → формат/размер в DOM и в сохранённом content; цвет отброшен', async ({ page }) => {
    await openStep2AndActivate(page);
    const res = await page.evaluate((wordHtml) => {
      const ed = document.querySelector(
        '.textblock-editor[data-text-block-id="txt-seed-1"]',
      ) as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.activeEditor = ed;
      ed.innerHTML = '';
      ed.focus();
      const s = window.getSelection()!;
      const r = document.createRange();
      r.selectNodeContents(ed);
      r.collapse(false);
      s.removeAllRanges();
      s.addRange(r);

      const dt = new DataTransfer();
      dt.setData('text/html', wordHtml);
      dt.setData('text/plain', 'жирный курсив красный 11pt\nссылка и внутри-контрола хвост');
      // handleEditorPaste: e.preventDefault → _buildPasteFragment (Word-ветка) →
      // execCommand('insertHTML') → finalizeEdit (пишет AppState.content).
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));

      const saved = ((window as any).AppState?.textBlocks?.['txt-seed-1']?.content) || '';
      return {
        domHtml: ed.innerHTML,
        domText: ed.textContent || '',
        links: [...ed.querySelectorAll('span.text-link')].map((a) => a.getAttribute('data-link-url')),
        boldCount: ed.querySelectorAll('b, strong').length,
        italicCount: ed.querySelectorAll('i, em').length,
        anchors: ed.querySelectorAll('a').length,
        saved,
      };
    }, WORD_HTML);

    // Если синтетический insertHTML не отработал бы (untrusted-gesture), вставки
    // не было бы вовсе — это ловится ассертами ниже (links/bold пусты). В этом
    // харнессе execCommand('insertHTML') под Playwright работает (см. spec 16).
    expect(res.links).toEqual(['https://example.com']); // ссылка стала капсулой
    expect(res.anchors).toBe(0);                         // голого <a> нет
    expect(res.boldCount).toBeGreaterThan(0);            // <b> дожил до DOM
    expect(res.italicCount).toBeGreaterThan(0);          // <i> дожил до DOM
    expect(res.domHtml).toContain('11pt');               // pt→px в живом DOM
    expect(res.domText).toContain('внутри-контрола');    // текст из <w:sdt> сохранён

    // Reload-parity: сохранённый content (то, что уйдёт в БД/превью) сохранил
    // размер и ссылку, но НЕ цвет — редактор совпадёт с превью после reload.
    expect(res.saved).toMatch(/font-size:\s*11pt/);                     // размер в сохранённом content
    expect(res.saved).toContain('data-link-url="https://example.com"'); // капсула-ссылка сохранена
    expect(res.saved.toLowerCase()).not.toContain('color');             // цвет/фон не сохранены
    expect(res.saved.toLowerCase()).not.toContain('text-align');        // выравнивание не сохранено
    expect(res.saved).not.toContain(GUARD);                             // caret-guard'ы стрипнуты
  });
});
