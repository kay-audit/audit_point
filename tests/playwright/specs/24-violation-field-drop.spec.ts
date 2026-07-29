import { test, expect, openAct, SEED_ACTS } from '../fixtures';
import type { Page } from '@playwright/test';
import { openStep2, createViolation, violationFieldSel } from '../violation-helpers';

/**
 * Сценарий 1 (T7 #6): нативный drag капсул (сноска + ссылка) из текстблока в
 * НЕсфокусированное поле нарушения — EditorController.handleSurfaceDrop.
 *
 * Ключевые инварианты:
 *  - drop-слушатель живёт на поле с СОЗДАНИЯ (_createRichFieldEditor), поэтому
 *    несфокусированное поле принимает drop (focus приходит как default-action
 *    события drop, ПОСЛЕ обработчиков);
 *  - гейт сносок берётся из ЗАХВАЧЕННОЙ поверхности (violationField → footnotes
 *    заблокированы): сноска разворачивается в plain-текст, ссылка (F3
 *    own-реконструкция по маркерам, без метки data-aw-clip) выживает с URL;
 *  - модель нарушения обновляется (commit несмонтированного поля).
 *
 * Нативный drag сериализует выделение БЕЗ метки data-aw-clip — воспроизводим,
 * диспатча DragEvent('drop') с DataTransfer(text/html) капсульной разметки.
 */

// Капсулы БЕЗ метки data-aw-clip — как их отдаёт нативный drag выделения.
const FOOTNOTE_LINK_HTML =
  'до ' +
  '<span class="text-footnote" data-footnote-id="F1" data-footnote-text="тело сноски"' +
  ' contenteditable="false">якорь</span>' +
  ' середина ' +
  '<span class="text-link" data-link-id="L1" data-link-url="https://a.ru"' +
  ' contenteditable="false">ссылка</span>' +
  ' хвост';

/** Диспатчит нативный drop с DataTransfer(text/html) в центр элемента. */
async function dropHtmlInto(
  page: Page,
  selector: string,
  html: string,
  plain: string,
): Promise<void> {
  await page.evaluate(
    ({ selector, html, plain }) => {
      const el = document.querySelector(selector) as HTMLElement;
      const r = el.getBoundingClientRect();
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      dt.setData('text/plain', plain);
      const ev = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
        clientX: Math.round(r.left + r.width / 2),
        clientY: Math.round(r.top + Math.min(12, r.height / 2)),
      });
      el.dispatchEvent(ev);
    },
    { selector, html, plain },
  );
}

test.describe('violation-field drop (T7 #6): нативный drag капсул из текстблока', () => {
  test.beforeEach(async ({ page }) => {
    await openAct(page, SEED_ACTS.withContent);
    await openStep2(page);
  });

  test('drop сноски+ссылки в НЕсфокусированное поле: сноска вырезана целиком, ссылка жива с URL, модель обновлена', async ({
    page,
  }) => {
    const vid = await createViolation(page);
    const fieldSel = violationFieldSel(vid); // querySelector → первое поле (violated)

    // Поле НЕ в фокусе — drop сам его сфокусирует (обработчик с создания поля).
    await dropHtmlInto(page, fieldSel, FOOTNOTE_LINK_HTML, 'до якорь середина ссылка хвост');

    const live = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const link = el.querySelector('.text-link') as HTMLElement | null;
      return {
        footnotes: el.querySelectorAll('.text-footnote').length,
        links: el.querySelectorAll('.text-link').length,
        linkUrl: link?.getAttribute('data-link-url') ?? null,
        linkText: link?.textContent ?? null,
        text: (el.textContent || '').replace(/[﻿​]/g, ''),
      };
    }, fieldSel);

    // Сноска вырезана ЦЕЛИКОМ (footnotes:false → удаление без текста-фолбэка,
    // _reconstructPastedCapsules): ни капсулы, ни её якоря «якорь» не осталось.
    expect(live.footnotes).toBe(0);
    expect(live.text).not.toContain('якорь');
    // Окружающий текст drag'а вставлен.
    expect(live.text).toContain('до');
    expect(live.text).toContain('середина');
    expect(live.text).toContain('хвост');
    // Ссылка реконструирована own-путём (маркеры без data-aw-clip) — жива с URL.
    expect(live.links).toBe(1);
    expect(live.linkUrl).toBe('https://a.ru');
    expect(live.linkText).toBe('ссылка');

    // Модель нарушения обновлена (commit несмонтированного поля): ссылка есть,
    // сноски (data-footnote-text/якорь) нет.
    const model = await page.evaluate((v) => (window as any).AppState.violations[v].violated, vid);
    expect(model).toContain('data-link-url="https://a.ru"');
    expect(model).not.toContain('data-footnote-text');
    expect(model).not.toContain('якорь');
  });

  test('контраст: та же сноска под textblock-политикой (_buildPasteFragment fromDrop) остаётся живой капсулой', async ({
    page,
  }) => {
    // Гейт сносок специфичен для поверхности: у текстблока footnotesBlocked=false,
    // поэтому та же капсула-сноска реконструируется (в поле нарушения — нет).
    const res = await page.evaluate((html) => {
      const tbm = (window as any).textBlockManager;
      const frag = tbm._buildPasteFragment(html, false, true); // footnotesBlocked=false, fromDrop=true
      const holder = document.createElement('div');
      holder.appendChild(frag);
      const fn = holder.querySelector('.text-footnote') as HTMLElement | null;
      return {
        footnotes: holder.querySelectorAll('.text-footnote').length,
        footnoteBody: fn?.getAttribute('data-footnote-text') ?? null,
        links: holder.querySelectorAll('.text-link').length,
        linkUrl:
          (holder.querySelector('.text-link') as HTMLElement | null)?.getAttribute(
            'data-link-url',
          ) ?? null,
      };
    }, FOOTNOTE_LINK_HTML);

    expect(res.footnotes).toBe(1); // сноска жива — политика текстблока её разрешает
    expect(res.footnoteBody).toBe('тело сноски');
    expect(res.links).toBe(1); // ссылка тоже жива
    expect(res.linkUrl).toBe('https://a.ru');
  });
});
