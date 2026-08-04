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
});
