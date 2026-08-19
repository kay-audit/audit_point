import { test, expect } from '@playwright/test';
import { openAct, SEED_ACTS } from '../fixtures';

// Сид-редактор и guard-символ (U+FEFF).
const EDITOR_SEL = '.textblock-editor[data-text-block-id="txt-seed-1"]';
const GUARD = '\uFEFF';

/**
 * Переходит на шаг 2, фокусирует сид-редактор и задаёт его innerHTML.
 * activeEditor проставляется явно (как в 16-capsule-integrity).
 */
async function setupEditor(page, html: string) {
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.locator('.step[data-step="2"]').click();
  await page.locator(EDITOR_SEL).waitFor({ state: 'visible', timeout: 5000 });
  await page.locator(EDITOR_SEL).click();
  await page.evaluate((h) => {
    const ed = document.querySelector(
      '.textblock-editor[data-text-block-id="txt-seed-1"]',
    ) as HTMLElement;
    const tbm = (window as any).textBlockManager;
    tbm.activeEditor = ed;
    ed.innerHTML = h;
    ed.focus();
  }, html);
}

const FOOTNOTE = (text = 'сноска', id = 'F1') =>
  `<span class="text-footnote" data-footnote-id="${id}" data-footnote-text="прим"` +
  ` contenteditable="false">${text}</span>`;

test.describe('caret-guards у границ визуальных строк (_placeCapGuards)', () => {
  test.beforeEach(async ({ page }) => { await openAct(page, SEED_ACTS.withContent); });

  test('капсула на отдельной строке (br с обеих сторон) → guard слева И справа', async ({ page }) => {
    await setupEditor(page, 'строка1<br>' + FOOTNOTE() + '<br>строка3');
    const r = await page.evaluate((guard) => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      (window as any).textBlockManager.normalizeMarkers(ed);
      const cap = ed.querySelector('.text-footnote')!;
      const prev = cap.previousSibling, next = cap.nextSibling;
      const isGuard = (n: any) => !!(n && n.nodeType === 3 && n.data === guard);
      return { leading: isGuard(prev), trailing: isGuard(next) };
    }, GUARD);
    expect(r.leading).toBe(true);   // ведущий guard у капсулы-в-начале-строки
    expect(r.trailing).toBe(true);  // хвостовой guard у капсулы-в-конце-строки
  });

  test('капсула среди обычного текста → guard НЕ ставится (без овергарда)', async ({ page }) => {
    await setupEditor(page, 'текст ' + FOOTNOTE() + ' хвост');
    const r = await page.evaluate((guard) => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      (window as any).textBlockManager.normalizeMarkers(ed);
      const cap = ed.querySelector('.text-footnote')!;
      const isGuard = (n: any) => !!(n && n.nodeType === 3 && n.data === guard);
      return { leading: isGuard(cap.previousSibling), trailing: isGuard(cap.nextSibling) };
    }, GUARD);
    // Слева/справа обычный текст — каретка встаёт штатно, guard не нужен.
    expect(r.leading).toBe(false);
    expect(r.trailing).toBe(false);
  });

  test('капсула сразу после <br> (начало визуальной строки) → ведущий guard', async ({ page }) => {
    await setupEditor(page, 'текст<br>' + FOOTNOTE() + ' хвост');
    const r = await page.evaluate((guard) => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      (window as any).textBlockManager.normalizeMarkers(ed);
      const cap = ed.querySelector('.text-footnote')!;
      const isGuard = (n: any) => !!(n && n.nodeType === 3 && n.data === guard);
      return { leading: isGuard(cap.previousSibling), prevIsBr:
        !!(cap.previousSibling && cap.previousSibling.previousSibling &&
           (cap.previousSibling.previousSibling as Element).tagName === 'BR') };
    }, GUARD);
    expect(r.leading).toBe(true);
    expect(r.prevIsBr).toBe(true); // guard стоит МЕЖДУ <br> и капсулой
  });
});

test.describe('Issue 3: Enter перед капсулой', () => {
  test.beforeEach(async ({ page }) => { await openAct(page, SEED_ACTS.withContent); });

  test('Enter перед капсулой → стойкий guard и каретка ВПЛОТНУЮ перед капсулой', async ({ page }) => {
    await setupEditor(page, 'текст' + FOOTNOTE());
    // Каретка между «текст» и капсулой (в конце первого текстового узла).
    await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const t = ed.firstChild as Text;            // «текст»
      const r = document.createRange();
      r.setStart(t, t.length); r.collapse(true);
      const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
    });
    await page.keyboard.press('Enter');
    const r = await page.evaluate((guard) => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const cap = ed.querySelector('.text-footnote')!;
      const prev = cap.previousSibling as any;        // ожидаем guard
      const sel = getSelection()!;
      const isGuard = (n: any) => !!(n && n.nodeType === 3 && n.data === guard);
      const isEmpty = (n: any) => n && n.nodeType === 3 && (n.data === '' || n.data === guard);
      // <br> перед капсулой, пропуская guard'ы и пустые текст-узлы (range.insertNode
      // при split в конце текста оставляет пустой узел между <br> и guard'ом).
      let n: any = cap.previousSibling, brBefore = false;
      while (n) {
        if (n.nodeType === 1 && n.tagName === 'BR') { brBefore = true; break; }
        if (!isEmpty(n)) break;
        n = n.previousSibling;
      }
      return {
        guardBeforeCap: isGuard(prev),
        brBeforeCap: brBefore,
        caretInGuard: sel.isCollapsed && sel.anchorNode === prev,
      };
    }, GUARD);
    expect(r.brBeforeCap).toBe(true);     // капсула ушла на новую строку (<br>)
    expect(r.guardBeforeCap).toBe(true);  // перед ней появился стойкий guard
    expect(r.caretInGuard).toBe(true);    // каретка приземлилась перед капсулой
  });
});

test.describe('Issue 2: вертикальная навигация через строку-капсулу', () => {
  test.beforeEach(async ({ page }) => { await openAct(page, SEED_ACTS.withContent); });

  test('ArrowDown со строки 1 заходит на строку-сноску, не перескакивает на строку 3', async ({ page }) => {
    await setupEditor(page, 'строка1<br>' + FOOTNOTE() + '<br>строка3');
    await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      (window as any).textBlockManager.normalizeMarkers(ed);
      // Каретка в начало «строка1».
      const t = ed.firstChild as Text;
      const r = document.createRange();
      r.setStart(t, 0); r.collapse(true);
      const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
      ed.focus();
    });
    await page.keyboard.press('ArrowDown');
    const landing = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const cap = ed.querySelector('.text-footnote')!;
      const sel = getSelection()!;
      const a = sel.anchorNode;
      if (a === cap.previousSibling) return 'leading-guard';
      if (a === cap || (a && cap.contains(a))) return 'capsule';
      if (a === cap.nextSibling) return 'trailing-guard';
      if (a === ed.lastChild) return 'line3';
      if (a === ed.firstChild) return 'line1';
      return 'other:' + (a && a.nodeType === 3 ? JSON.stringify((a as Text).data) : (a as any)?.nodeName);
    });
    // Главное: каретка НЕ проскочила на строку 3 и не осталась на строке 1.
    expect(landing).not.toBe('line3');
    expect(landing).not.toBe('line1');
  });
});

test.describe('observer-самозалечивание ведущего guard у строки-капсулы', () => {
  test.beforeEach(async ({ page }) => { await openAct(page, SEED_ACTS.withContent); });

  test('удаление guard паттерном «empty-then-remove» (реальный Backspace) → observer восстанавливает', async ({ page }) => {
    await setupEditor(page, 'строка1<br>' + FOOTNOTE() + '<br>строка3');
    await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      (window as any).textBlockManager.normalizeMarkers(ed);
    });
    // Ведущий guard перед капсулой действительно есть.
    const before = await page.evaluate((guard) => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const cap = ed.querySelector('.text-footnote')!;
      return !!(cap.previousSibling && (cap.previousSibling as Text).data === guard);
    }, GUARD);
    expect(before).toBe(true);

    // Имитация РЕАЛЬНОГО Backspace по zero-width guard'у: браузер сперва
    // опустошает текст-узел (characterData U+FEFF→''), затем удаляет уже пустой
    // узел (childList) — в одном батче мутаций. Этот паттерн раньше observer
    // не лечил (removedNode.data==='' ≠ guard, а characterData-узел уже отвязан).
    await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const cap = ed.querySelector('.text-footnote')!;
      const g = cap.previousSibling as Text;
      g.data = '';
      g.remove();
    });

    // Observer должен вернуть guard перед капсулой в пределах 1 секунды.
    await page.waitForFunction((guard) => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]');
      const cap = ed && ed.querySelector('.text-footnote');
      return !!(cap && cap.previousSibling && cap.previousSibling.nodeType === 3 &&
        (cap.previousSibling as Text).data === guard);
    }, GUARD, { timeout: 1000 });
  });
});

test.describe('смена размера шрифта не ломает caret-guard у капсулы', () => {
  test.beforeEach(async ({ page }) => { await openAct(page, SEED_ACTS.withContent); });

  test('размер на каретке перед капсулой → ведущий guard сохраняется (U+200B-якорь не блокирует)', async ({ page }) => {
    await setupEditor(page, 'строка1<br>' + FOOTNOTE() + '<br>строка3');
    const r = await page.evaluate((guard) => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.normalizeMarkers(ed);
      // Каретка в ведущий guard перед капсулой, затем меняем размер.
      const cap = ed.querySelector('.text-footnote')!;
      const g = cap.previousSibling as Text;
      const rng = document.createRange(); rng.setStart(g, g.length); rng.collapse(true);
      const s = getSelection()!; s.removeAllRanges(); s.addRange(rng);
      tbm.applyFontSize(20);   // вставит <span style="font-size"><U+200B></span> перед капсулой
      const cap2 = ed.querySelector('.text-footnote')!;
      return {
        leading: !!(cap2.previousSibling && cap2.previousSibling.nodeType === 3 &&
          (cap2.previousSibling as Text).data === guard),
        hasZwsp: ed.innerHTML.indexOf('\u200B') !== -1,   // якорь размера на месте
      };
    }, GUARD);
    expect(r.leading).toBe(true);  // guard поставлен НЕСМОТРЯ на U+200B-span рядом
    expect(r.hasZwsp).toBe(true);  // якорь размера не выпилен
  });

  test('после смены размера (с U+200B в сохранённом контенте) reload восстанавливает guard', async ({ page }) => {
    const reloadedLeading = await page.evaluate((guard) => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const tbm = (window as any).textBlockManager;
      // Сохранённый контент с U+200B-якорем размера ВПЛОТНУЮ к капсуле (U+FEFF
      // стрипается при save, U+200B — нет), как после смены размера + reload.
      ed.innerHTML = 'строка1<br><span style="font-size: 20pt;">\u200B</span>' +
        '<span class="text-footnote" data-footnote-id="F1" data-footnote-text="прим">сноска</span>' +
        '<br>строка3';
      tbm.normalizeMarkers(ed);   // именно это выполняется на createEditor (reload)
      const cap = ed.querySelector('.text-footnote')!;
      return !!(cap.previousSibling && cap.previousSibling.nodeType === 3 &&
        (cap.previousSibling as Text).data === guard);
    }, GUARD);
    expect(reloadedLeading).toBe(true);  // раньше reload НЕ чинил — теперь чинит
  });

  test('размер по выделению капсулы → guard с обеих сторон сохраняется', async ({ page }) => {
    await setupEditor(page, 'строка1<br>' + FOOTNOTE() + '<br>строка3');
    const r = await page.evaluate((guard) => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.normalizeMarkers(ed);
      const cap = ed.querySelector('.text-footnote')!;
      const rng = document.createRange(); rng.selectNode(cap);
      const s = getSelection()!; s.removeAllRanges(); s.addRange(rng);
      tbm.applyFontSize(20);   // обернёт капсулу в <span style="font-size">
      const cap2 = ed.querySelector('.text-footnote')!;
      const isG = (n: any) => !!(n && n.nodeType === 3 && n.data === guard);
      return { leading: isG(cap2.previousSibling), trailing: isG(cap2.nextSibling) };
    }, GUARD);
    expect(r.leading).toBe(true);
    expect(r.trailing).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 11: CARET-3 (Home на wrap-строке) и CARET-4 (guard прозрачен для
// Backspace/Delete), плюс контроль CARET-5/CARET-7 (закрыты Task 1).
// ---------------------------------------------------------------------------

test.describe('CARET-3: Home на wrap-строке абзаца, начинающегося капсулой', () => {
  test.beforeEach(async ({ page }) => { await openAct(page, SEED_ACTS.withContent); });

  test('узкий блок, каретка на wrap-продолжении → Home остаётся на ТЕКУЩЕМ экранном ряду', async ({ page }) => {
    // Немного слов — весь абзац укладывается в несколько рядов ЦЕЛИКОМ в
    // пределах вьюпорта: сравнение viewport-relative rect'ов до/после Home
    // некорректно, если между измерениями браузер проскроллит каретку в вид.
    const long = 'слово '.repeat(10).trim();
    await setupEditor(page, FOOTNOTE() + ' ' + long);
    await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      ed.style.width = '160px'; // форсируем перенос длинной строки на несколько рядов
      (window as any).textBlockManager.normalizeMarkers(ed);
    });

    // Каретка в САМОМ конце текста — заведомо на последнем wrap-ряду.
    const pre = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const cap = ed.querySelector('.text-footnote')!;
      const textNode = ed.lastChild as Text;
      const r = document.createRange();
      r.setStart(textNode, textNode.length);
      r.collapse(true);
      const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
      const capRect = cap.getClientRects()[0];
      const caretRect = r.getClientRects()[0] || r.getBoundingClientRect();
      return { onWrapRow: caretRect.top > capRect.bottom - 1, caretTop: caretRect.top };
    });
    expect(pre.onWrapRow).toBe(true); // предусловие теста: каретка ДЕЙСТВИТЕЛЬНО на другом экранном ряду

    await page.keyboard.press('Home');

    const post = await page.evaluate((prevTop: number) => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const cap = ed.querySelector('.text-footnote')!;
      const s = getSelection()!;
      const r = s.getRangeAt(0);
      const caretRect = r.getClientRects()[0] || r.getBoundingClientRect();
      return {
        sameRow: Math.abs(caretRect.top - prevTop) < 2,
        landedBesideCapsule: s.anchorNode === cap.previousSibling,
      };
    }, pre.caretTop);

    expect(post.landedBesideCapsule).toBe(false); // НЕ телепортировало к капсуле строки 1
    expect(post.sameRow).toBe(true);               // Home сработал нативно — тот же wrap-ряд
  });
});

test.describe('CARET-4: guard прозрачен для Backspace — слияние строк с первого нажатия', () => {
  test.beforeEach(async ({ page }) => { await openAct(page, SEED_ACTS.withContent); });

  test('каретка перед капсулой строки 2 (в guard) → Backspace сразу убирает перенос со строкой 1', async ({ page }) => {
    await setupEditor(page, 'строка1<br>' + FOOTNOTE() + '<br>строка3');
    await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.normalizeMarkers(ed);
      const cap = ed.querySelector('.text-footnote')!;
      // Та же позиция каретки, что и после Home на строке 2 (вплотную перед капсулой).
      tbm._placeCaretBesideMarker(cap, false);
    });

    await page.keyboard.press('Backspace');

    const r = await page.evaluate((guard) => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const cap = ed.querySelector('.text-footnote')!;
      const g = cap.previousSibling as any;
      let n: any = g;
      while (n && n.nodeType === 3 && n.data === guard) n = n.previousSibling;
      return {
        brCount: ed.querySelectorAll('br').length,
        guardSurvived: !!(g && g.nodeType === 3 && g.data === guard),
        mergedWithLine1: n === ed.firstChild,
      };
    }, GUARD);

    expect(r.brCount).toBe(1);            // <br> между «строка1» и капсулой исчез — слияние с ОДНОГО нажатия
    expect(r.guardSurvived).toBe(true);   // guard не уничтожен наблюдателем — каретка просто перешагнула
    expect(r.mergedWithLine1).toBe(true); // капсула примыкает к «строка1» без разделителя
  });
});

test.describe('CARET-5 (контроль Task 1): Enter у капсулы → вертикальная навигация сразу работает', () => {
  test.beforeEach(async ({ page }) => { await openAct(page, SEED_ACTS.withContent); });

  test('Enter перед капсулой, следом ArrowUp без паузы попадает на строку выше', async ({ page }) => {
    await setupEditor(page, 'текст' + FOOTNOTE());
    await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const t = ed.firstChild as Text; // «текст»
      const r = document.createRange();
      r.setStart(t, t.length); r.collapse(true); // каретка между «текст» и капсулой
      const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
    });

    await page.keyboard.press('Enter');   // капсула уходит на строку 2; finalizeEdit ДО каретки (CARET-5)
    await page.keyboard.press('ArrowUp'); // без паузы — гоняем сразу вслед за Enter

    const landing = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const sel = getSelection()!;
      return {
        onLine1: sel.anchorNode === ed.firstChild,
        brCount: ed.querySelectorAll('br').length,
      };
    });
    expect(landing.brCount).toBe(1);    // перенос действительно есть (капсула ушла на строку 2)
    expect(landing.onLine1).toBe(true); // ArrowUp сразу увёл на строку 1 — guard'ы уже на месте
  });
});

test.describe('CARET-7 (контроль Task 1): нативное удаление сноски мимо явных потоков → номер обновляется по debounce', () => {
  test.beforeEach(async ({ page }) => { await openAct(page, SEED_ACTS.withContent); });

  test('выделение целиком вокруг капсулы (не клипающее её) + Backspace: номер соседней сноски пересчитан после debounce', async ({ page }) => {
    await setupEditor(page, 'до ' + FOOTNOTE('сн1', 'F1') + ' меж ' + FOOTNOTE('сн2', 'F2') + ' после');
    await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      // finalizeEdit (не голый renumberAllFootnotes) — чтобы __lastFootnoteCount
      // тоже был проставлен в кэш, как в реальном потоке.
      (window as any).textBlockManager.finalizeEdit(ed, { renumber: true });
    });
    const before = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      return {
        count: ed.querySelectorAll('.text-footnote').length,
        nums: [...ed.querySelectorAll('.text-footnote')].map(n => n.getAttribute('data-footnote-number')),
      };
    });
    expect(before.count).toBe(2);
    expect(before.nums).toEqual(['1', '2']);

    // Выделение ГРАНИЦАМИ в реальном тексте СНАРУЖИ капсулы (не внутри её тела) —
    // beforeinput-слой (_staticRangeTouchesCapsule) его не распознаёт: удаление
    // идёт целиком нативно, мимо removeLinkOrFootnote и мимо атомарного beforeinput.
    await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const before = ed.childNodes[0] as Text; // «до »
      const after = ed.childNodes[2] as Text;  // « меж »
      const r = document.createRange();
      r.setStart(before, before.length);
      r.setEnd(after, 0);
      const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
    });
    await page.keyboard.press('Backspace');

    const immediate = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      return ed.querySelectorAll('.text-footnote').length;
    });
    expect(immediate).toBe(1); // сноска F1 физически удалена нативным Backspace

    // Debounce handleEditorInput (500мс) → finalizeEdit ловит несовпадение числа
    // сносок с кэшем __lastFootnoteCount и перенумеровывает (CARET-7).
    await page.waitForFunction(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]');
      const remaining = ed && ed.querySelector('.text-footnote');
      return !!(remaining && remaining.getAttribute('data-footnote-number') === '1');
    }, { timeout: 2000 });
  });
});

// ---------------------------------------------------------------------------
// Task 13 (CARET-1): Home внутри editing-mode капсулы. Симметрично Task 2:
// капсула в inline-правке (dblclick) — обычный редактируемый контент, поэтому
// Home внутри её тела работает нативно и НЕ выдёргивает каретку в ведущий guard.
// Вызываем keydown-обработчик Home напрямую (детерминированно, без зависимости
// от native-Home landing), как это делают соседние спеки для методов менеджера.
// ---------------------------------------------------------------------------

test.describe('Task 13: Home внутри editing-mode ведущей капсулы не выдёргивает фокус', () => {
  test.beforeEach(async ({ page }) => { await openAct(page, SEED_ACTS.withContent); });

  test('editing-mode капсула + Home → _handleCapsuleCaretKey НЕ перехватывает, каретка в теле', async ({ page }) => {
    await setupEditor(page, FOOTNOTE('длинная сноска', 'F1') + ' хвост');
    const res = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.normalizeMarkers(ed); // ведущий guard перед капсулой
      const cap = ed.querySelector('.text-footnote') as HTMLElement;
      // Входим в режим правки как двойной клик: editing-mode + contenteditable=true.
      cap.classList.add('editing-mode');
      cap.contentEditable = 'true';
      const editingNow = tbm._isEditingCapsule(cap);
      // Каретка ВНУТРИ тела капсулы (конец текста).
      const tn = cap.firstChild as Text;
      const r = document.createRange(); r.setStart(tn, tn.length); r.collapse(true);
      const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
      let prevented = false;
      const intercepted = tbm._handleCapsuleCaretKey(
        { key: 'Home', preventDefault() { prevented = true; } }, ed);
      const anchor = getSelection()!.anchorNode;
      return {
        editingNow,
        intercepted,
        prevented,
        caretInsideCapsule: cap.contains(anchor),
        caretInLeadingGuard: anchor === cap.previousSibling,
      };
    });
    expect(res.editingNow).toBe(true);           // предусловие: капсула в editing-mode
    expect(res.intercepted).toBe(false);         // обработчик НЕ перехватил Home
    expect(res.prevented).toBe(false);           // preventDefault не вызван — нативный Home
    expect(res.caretInsideCapsule).toBe(true);   // каретка осталась в теле капсулы
    expect(res.caretInLeadingGuard).toBe(false); // НЕ выдернута в ведущий guard
  });

  test('регресс-гейт: обычная (не editing) ведущая капсула + Home → перехват сохранён', async ({ page }) => {
    await setupEditor(page, FOOTNOTE('сноска', 'F1') + ' хвост');
    const res = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.normalizeMarkers(ed);
      const cap = ed.querySelector('.text-footnote') as HTMLElement;
      // Каретка в начале хвостового текста — на визуальной строке капсулы, но
      // капсула обычная (contenteditable=false, БЕЗ editing-mode).
      const tail = cap.nextSibling as Text; // « хвост»
      const r = document.createRange(); r.setStart(tail, 0); r.collapse(true);
      const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
      let prevented = false;
      const intercepted = tbm._handleCapsuleCaretKey(
        { key: 'Home', preventDefault() { prevented = true; } }, ed);
      return { intercepted, prevented, editing: tbm._isEditingCapsule(cap) };
    });
    expect(res.editing).toBe(false);   // капсула обычная
    expect(res.intercepted).toBe(true); // Home по-прежнему перехватывается (фикс хирургичен)
    expect(res.prevented).toBe(true);
  });
});
