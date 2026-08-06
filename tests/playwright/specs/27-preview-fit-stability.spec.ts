import { test, expect, openAct, SEED_ACTS } from '../fixtures';

/**
 * Стабильность fit-to-width масштаба предпросмотра (петля скроллбара).
 *
 * Баг: масштаб листа считается от ширины панели, а ширина панели зависит от
 * вертикального скроллбара колонки, которым управляет высота отмасштабированного
 * листа. В полосе высот окна (~24px) состояния «скроллбар есть/нет» сменяют друг
 * друга каждый кадр: масштаб пульсирует (например 1.028 ↔ 1.047), скроллбар
 * мигает — визуально превью «дёргается» (репро: 72 смены состояния за 73 кадра).
 *
 * Тест вычисляет полосу из живой геометрии и сканирует высоты окна вокруг неё:
 * на КАЖДОЙ высоте после паузы на сходимость масштаб обязан замереть
 * (≤2 различимых состояний за ~40 кадров).
 */

/** Семплирует состояния (transform листа + ширина панели) по кадрам. */
async function sampleStates(page: import('@playwright/test').Page): Promise<number> {
  return await page.evaluate(async () => {
    const distinct: string[] = [];
    let prev: string | null = null;
    const t0 = performance.now();
    await new Promise<void>((done) => {
      const tick = () => {
        const pane = document.querySelector('#preview') as HTMLElement | null;
        const sheet = pane?.querySelector('.preview-sheet') as HTMLElement | null;
        const key = `${pane?.clientWidth}|${sheet?.style.transform}`;
        if (key !== prev) {
          distinct.push(key);
          prev = key;
        }
        if (performance.now() - t0 < 700) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    return distinct.length;
  });
}

test.describe('Предпросмотр: стабильность fit-масштаба', () => {
  test('масштаб не осциллирует ни на одной высоте окна вокруг полосы скроллбара', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openAct(page, SEED_ACTS.withContent);
    // Спек гоняется проектом chromium-scrollbars (без --hide-scrollbars, см.
    // playwright.config.ts) — иначе headless рисует overlay-скроллбары вне
    // layout и петля физически невозможна. Стиль пришпиливает ширину 17px
    // (как классический скроллбар Windows) независимо от темы платформы.
    await page.addStyleTag({
      content: '.column::-webkit-scrollbar { width: 17px; }',
    });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(300);

    // Оценка полосы: высота окна, при которой контент колонки предпросмотра
    // перестаёт нуждаться в скроллбаре. Замер в состоянии «скроллбар есть»
    // занижает цель (без скроллбара панель шире → лист выше), поэтому скан
    // идёт с запасом вверх.
    const guess = await page.evaluate(() => {
      const col = document.querySelector('#preview')?.closest('.column');
      if (!col) return null;
      return innerHeight + (col.scrollHeight - col.clientHeight);
    });
    expect(guess, 'колонка предпросмотра со скроллбаром не найдена').not.toBeNull();

    let worst = { h: 0, states: 0 };
    for (let h = guess! - 8; h <= guess! + 44; h += 4) {
      await page.setViewportSize({ width: 1920, height: h });
      // Пауза на сходимость: одиночные пересчёты (смена ширины) успевают
      // примениться, вечная петля — нет.
      await page.waitForTimeout(250);
      const states = await sampleStates(page);
      if (states > worst.states) worst = { h, states };
    }

    expect(
      worst.states,
      `масштаб предпросмотра осциллирует на высоте окна ${worst.h}px: ` +
        `${worst.states} смен состояния за ~40 кадров (петля «скроллбар ↔ масштаб»)`
    ).toBeLessThanOrEqual(2);
  });

  test('перерендер не роняет масштаб и не схлопывает панель', async ({ page }) => {
    await openAct(page, SEED_ACTS.withContent);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(400);

    const before = await page.evaluate(
      () => (document.querySelector('#preview .preview-sheet') as HTMLElement).style.transform
    );
    expect(before, 'масштаб не применился при первичном рендере').toMatch(/^scale\(/);

    // Полная пересборка листа тем же контентом. Лист и sizer создаются заново,
    // без inline-стилей: если масштаб применяется отложенно (следующим кадром),
    // в отрисовку попадает кадр с нулевой высотой панели, а замер ширины в этом
    // состоянии даёт ещё и промежуточный неверный масштаб.
    const trace = await page.evaluate(async () => {
      const seen: string[] = [];
      let minHeight = Infinity;
      const t0 = performance.now();
      (window as any).PreviewManager.update();
      await new Promise<void>((done) => {
        const tick = () => {
          const pane = document.querySelector('#preview') as HTMLElement;
          const sheet = pane.querySelector('.preview-sheet') as HTMLElement | null;
          minHeight = Math.min(minHeight, pane.clientHeight);
          const tr = sheet ? sheet.style.transform || 'NONE' : 'NONE';
          if (seen[seen.length - 1] !== tr) seen.push(tr);
          if (performance.now() - t0 < 700) requestAnimationFrame(tick);
          else done();
        };
        requestAnimationFrame(tick);
      });
      return { seen, minHeight };
    });

    expect(
      trace.minHeight,
      'панель предпросмотра схлопнулась в нулевую высоту — кадр пустого превью'
    ).toBeGreaterThan(0);
    expect(
      trace.seen,
      `масштаб менялся во время перерендера: ${trace.seen.join(' -> ')}`
    ).toEqual([before]);
  });

  test('модалка предпросмотра: forceUpdate при открытом меню не гасит лист', async ({
    page,
  }) => {
    await openAct(page, SEED_ACTS.withContent);
    await page.evaluate(() => (window as any).previewMenuManager.open());
    await page.waitForTimeout(600);

    const before = await page.evaluate(
      () =>
        (document.querySelector('#previewMenuBody .preview-sheet') as HTMLElement | null)?.style
          .transform ?? 'NONE'
    );
    expect(before, 'масштаб не применился при открытии меню').toMatch(/^scale\(/);

    // Ширина модалки задана явными пикселями и не меняется от высоты листа,
    // поэтому пересчёт даёт тот же k. Память о применённом расчёте относится к
    // прежнему листу — без её сброса новый лист остаётся без стилей навсегда.
    await page.evaluate(() => (window as any).previewMenuManager.forceUpdate());
    await page.waitForTimeout(900);

    const after = await page.evaluate(() => {
      const pane = document.querySelector('#previewMenuBody') as HTMLElement;
      const sheet = pane.querySelector('.preview-sheet') as HTMLElement | null;
      return {
        transform: sheet ? sheet.style.transform || 'NONE' : 'NONE',
        height: pane.clientHeight,
      };
    });

    expect(after.transform, 'лист модалки остался немасштабированным').toMatch(/^scale\(/);
    expect(after.height, 'тело модалки схлопнулось в нулевую высоту').toBeGreaterThan(0);
  });
});
