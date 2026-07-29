import { test, expect } from '@playwright/test';
import { openAct, SEED_ACTS } from '../fixtures';

// Прогоняет validateAndRepairCapsules в браузере на заданном HTML.
async function repair(page, html: string): Promise<string> {
  return await page.evaluate((h) => {
    // Менеджер текстблоков экспонирован на window в textblock-core.js.
    const mgr = (window as any).textBlockManager;
    return mgr.validateAndRepairCapsules(h);
  }, html);
}

// Редактор с сид-текстблоком
const EDITOR_SEL = '.textblock-editor[data-text-block-id="txt-seed-1"]';

/**
 * Переходит на шаг 2 и вставляет в сид-редактор HTML с одной ссылкой-капсулой.
 * activeEditor устанавливается кликом (через handleEditorFocus) и затем явно
 * переподтверждается — на случай если фокус ушёл при setHTML.
 */
async function focusSeededTextblockWithCapsule(page) {
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.locator('.step[data-step="2"]').click();
  await page.locator(EDITOR_SEL).waitFor({ state: 'visible', timeout: 5000 });
  await page.locator(EDITOR_SEL).click();
  await page.evaluate(() => {
    const ed = document.querySelector(
      '.textblock-editor[data-text-block-id="txt-seed-1"]',
    ) as HTMLElement;
    const tbm = (window as any).textBlockManager;
    tbm.activeEditor = ed;
    ed.innerHTML =
      'до ' +
      '<span class="text-link" data-link-id="cap1" data-link-url="https://a.ru"' +
      ' contenteditable="false">ссылка</span>' +
      ' после';
    tbm.attachLinkFootnoteHandlers();
  });
}

/**
 * Ставит выделение: начало в первом текстовом узле (до капсулы, offset 1),
 * конец — внутри текстового узла капсулы (offset 3). Range пересекает границу
 * contenteditable=false капсулы — именно этот случай провоцирует клонирование
 * при execCommand('bold') / range.deleteContents() без расширения выделения.
 */
async function selectAcrossCapsuleBoundary(page) {
  await page.evaluate(() => {
    const ed = document.querySelector(
      '.textblock-editor[data-text-block-id="txt-seed-1"]',
    ) as HTMLElement;
    const beforeText = ed.firstChild as Text;
    const capsule = ed.querySelector('.text-link')!;
    const capsuleText = capsule.firstChild as Text;
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(beforeText, 1);
    r.setEnd(capsuleText, 3);
    sel.removeAllRanges();
    sel.addRange(r);
  });
}

test.describe('capsule-integrity: validateAndRepairCapsules', () => {
  test.beforeEach(async ({ page }) => { await openAct(page, SEED_ACTS.withContent); });

  test('дубль data-link-id у НЕ-соседних капсул → клону свежий id', async ({ page }) => {
    const html =
      '<span class="text-link" data-link-id="L1" data-link-url="http://a">A</span>' +
      ' текст ' +
      '<span class="text-link" data-link-id="L1" data-link-url="http://b">B</span>';
    const out = await repair(page, html);
    const ids = [...out.matchAll(/data-link-id="([^"]+)"/g)].map(m => m[1]);
    expect(ids.length).toBe(2);
    expect(ids[0]).not.toBe(ids[1]); // дубль устранён
  });

  test('расщеплённый клон (тот же id, соседи, тот же url) → склейка в одну капсулу', async ({ page }) => {
    const html =
      '<span class="text-link" data-link-id="L1" data-link-url="http://a">Ссы</span>' +
      '<span class="text-link" data-link-id="L1" data-link-url="http://a">лка</span>';
    const out = await repair(page, html);
    const count = (out.match(/text-link/g) || []).length;
    expect(count).toBe(1);
    expect(out).toContain('>Ссылка<');
  });

  test('расщеплённый клон (разделитель — guard-узел U+FEFF) → склейка', async ({ page }) => {
    // _isInsignificantText: guard-char (U+FEFF) пропускается как незначимый;
    // _areAdjacentSplit должна видеть капсулы «соседними» и склеить их.
    const guard = '\uFEFF';
    const html =
      '<span class="text-link" data-link-id="L1" data-link-url="http://a">Час</span>' +
      guard +
      '<span class="text-link" data-link-id="L1" data-link-url="http://a">ть</span>';
    const out = await repair(page, html);
    const count = (out.match(/text-link/g) || []).length;
    expect(count).toBe(1);
    expect(out).toContain('>Часть<');
    // guard-символ вычищен _cleanCapGuards в конце _repairCapsulesInRoot
    expect(out).not.toContain(guard);
  });

  test('тот же id + реальный пробел между капсулами → не сливаются (свежий id)', async ({ page }) => {
    // Обычный пробел — значимый текст; _areAdjacentSplit вернёт false.
    const html =
      '<span class="text-link" data-link-id="L1" data-link-url="http://a">A</span>' +
      ' ' +
      '<span class="text-link" data-link-id="L1" data-link-url="http://a">B</span>';
    const out = await repair(page, html);
    const ids = [...out.matchAll(/data-link-id="([^"]+)"/g)].map(m => m[1]);
    expect(ids.length).toBe(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  test('пустой data-footnote-text → разворот в plain-text', async ({ page }) => {
    const html = '<span class="text-footnote" data-footnote-id="F1" data-footnote-text="">слово</span>';
    const out = await repair(page, html);
    expect(out).not.toContain('text-footnote');
    expect(out).toContain('слово');
  });

  test('пустой data-link-url → разворот в plain-text', async ({ page }) => {
    const html = '<span class="text-link" data-link-id="L1" data-link-url="">слово</span>';
    const out = await repair(page, html);
    expect(out).not.toContain('text-link');
    expect(out).toContain('слово');
  });

  test('идемпотентность: повторный прогон не меняет результат', async ({ page }) => {
    const html =
      '<span class="text-link" data-link-id="L1" data-link-url="http://a">A</span>' +
      '<span class="text-footnote" data-footnote-id="F1" data-footnote-text="прим">x</span>';
    const once = await repair(page, html);
    const twice = await repair(page, once);
    expect(twice).toBe(once);
  });

  test('страховка: guard-символ и contenteditable вычищаются', async ({ page }) => {
    const guardChar = '\uFEFF';
    const html = '<span class="text-link" data-link-id="L1" data-link-url="http://a" contenteditable="false">A' + guardChar + '</span>';
    const out = await repair(page, html);
    expect(out).not.toContain(guardChar);
    expect(out).not.toContain('contenteditable');
  });
});

test.describe('capsule-integrity: beforeinput-перехват', () => {
  test.beforeEach(async ({ page }) => { await openAct(page, SEED_ACTS.withContent); });

  test('Backspace, когда каретка сразу за капсулой → капсула удаляется целиком', async ({ page }) => {
    await focusSeededTextblockWithCapsule(page);
    // каретку ставим сразу справа от капсулы (через клик по правой половине)
    await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]');
      const cap = ed.querySelector('.text-link, .text-footnote');
      (window as any).__capId = cap.getAttribute('data-link-id') || cap.getAttribute('data-footnote-id');
      const r = document.createRange();
      r.setStartAfter(cap); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await page.keyboard.press('Backspace');
    const stillThere = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]');
      return !![...ed.querySelectorAll('[data-link-id],[data-footnote-id]')]
        .find(s => (s.getAttribute('data-link-id') || s.getAttribute('data-footnote-id')) === (window as any).__capId);
    });
    expect(stillThere).toBe(false); // капсула удалена целиком, не «надкушена»
  });

  test('выделение через границу + Delete → нет клона, id уникальны, нет осиротевших guard-узлов', async ({ page }) => {
    await focusSeededTextblockWithCapsule(page);
    await selectAcrossCapsuleBoundary(page);
    await page.keyboard.press('Delete');
    const result = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]');
      const ids = [...ed.querySelectorAll('[data-link-id],[data-footnote-id]')]
        .map(s => s.getAttribute('data-link-id') || s.getAttribute('data-footnote-id'));
      // Ищем осиротевшие guard-узлы (U+FEFF без соседней капсулы).
      const GUARD = '\uFEFF';
      let orphanedGuards = 0;
      const walk = (node: Node) => {
        if (node.nodeType === 3 && (node as Text).data === GUARD) {
          const prev = node.previousSibling as Element | null;
          const next = node.nextSibling as Element | null;
          const adjCapsule = (n: Element | null) =>
            n && n.nodeType === 1 &&
            (n.classList.contains('text-link') || n.classList.contains('text-footnote'));
          if (!adjCapsule(prev) && !adjCapsule(next)) orphanedGuards++;
        }
        node.childNodes.forEach(walk);
      };
      walk(ed);
      return { ids, orphanedGuards };
    });
    expect(new Set(result.ids).size).toBe(result.ids.length);
    // Если Chromium обработал Delete нативно (inside-ветка не срабатывает) —
    // orphanedGuards тоже 0, т.к. браузер удаляет весь диапазон корректно.
    expect(result.orphanedGuards).toBe(0);
  });
});

test.describe('capsule-integrity: атомарность при наших операциях', () => {
  test.beforeEach(async ({ page }) => { await openAct(page, SEED_ACTS.withContent); });

  test('bold по выделению через границу капсулы → нет клона, id уникальны', async ({ page }) => {
    await focusSeededTextblockWithCapsule(page);
    await selectAcrossCapsuleBoundary(page);
    await page.keyboard.press('Control+b');
    const ids = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]');
      return [...ed.querySelectorAll('[data-link-id],[data-footnote-id]')]
        .map(s => s.getAttribute('data-link-id') || s.getAttribute('data-footnote-id'));
    });
    expect(new Set(ids).size).toBe(ids.length); // нет дубль-id
  });

  test('paste по выделению через границу капсулы → нет клона', async ({ page }) => {
    await focusSeededTextblockWithCapsule(page);
    await selectAcrossCapsuleBoundary(page);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/html', '<p>ВСТАВКА</p>'); // HTML-ветка → проходит через _expandRangeOutOfMarkers
      dt.setData('text/plain', 'ВСТАВКА');
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]');
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    const ids = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]');
      return [...ed.querySelectorAll('[data-link-id],[data-footnote-id]')]
        .map(s => s.getAttribute('data-link-id') || s.getAttribute('data-footnote-id'));
    });
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Task 4: MutationObserver-страховка
// ---------------------------------------------------------------------------

/**
 * Открывает акт, переходит на шаг 2, ставит ВЕДУЩУЮ капсулу (без текста перед ней),
 * вызывает normalizeMarkers — после этого в редакторе появляется guard U+FEFF
 * перед капсулой. Observer уже установлен (createEditor → installCapsuleObserver).
 */
async function setupLeadingCapsuleWithGuard(page) {
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.locator('.step[data-step="2"]').click();
  await page.locator(EDITOR_SEL).waitFor({ state: 'visible', timeout: 5000 });
  await page.evaluate(() => {
    const ed = document.querySelector(
      '.textblock-editor[data-text-block-id="txt-seed-1"]',
    ) as HTMLElement;
    const tbm = (window as any).textBlockManager;
    tbm.activeEditor = ed;
    // Ведущая капсула: перед ней нет текста → _placeCapGuards поставит guard.
    ed.innerHTML =
      '<span class="text-link" data-link-id="cap1" data-link-url="https://a.ru"' +
      ' contenteditable="false">ссылка</span>' +
      ' текст';
    tbm.normalizeMarkers(ed);
  });
}

test.describe('capsule-integrity: observer-самозалечивание', () => {
  test.beforeEach(async ({ page }) => { await openAct(page, SEED_ACTS.withContent); });

  test('программно удалённый guard у ведущей капсулы → восстановлен observer-ом', async ({ page }) => {
    await setupLeadingCapsuleWithGuard(page);
    // Убеждаемся, что guard действительно есть перед удалением.
    const guardPresent = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]');
      return ed && ed.firstChild && ed.firstChild.nodeType === 3 && (ed.firstChild as Text).data === '\uFEFF';
    });
    expect(guardPresent).toBe(true);

    // Удаляем все guard-узлы (имитация «пользователь стёр невидимый символ»).
    await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]');
      [...ed.childNodes].forEach(n => {
        if (n.nodeType === 3 && (n as Text).data === '\uFEFF') n.remove();
      });
    });

    // Observer должен восстановить guard в пределах 1 секунды.
    await page.waitForFunction(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]');
      return !!(ed && ed.firstChild && ed.firstChild.nodeType === 3 && (ed.firstChild as Text).data === '\uFEFF');
    }, { timeout: 1000 });
  });

  test('contenteditable, снятый с капсулы, восстановлен observer-ом', async ({ page }) => {
    await focusSeededTextblockWithCapsule(page);
    await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]');
      const cap = ed.querySelector('.text-link, .text-footnote');
      cap.removeAttribute('contenteditable');
    });
    await page.waitForFunction(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]');
      const cap = ed && ed.querySelector('.text-link, .text-footnote');
      return !!(cap && cap.getAttribute('contenteditable') === 'false');
    }, { timeout: 1000 });
  });
});

// ---------------------------------------------------------------------------
// Task 1 (fix-цикл): самоочистка guard при удалении ПОСЛЕДНЕЙ капсулы (Fix 1).
// Гейт normalize в finalizeEdit расширен: нормализация идёт и когда капсул не
// осталось, но в DOM есть guard-символ U+FEFF — иначе он оставался бы висеть в
// живом редакторе после удаления единственной edge-капсулы.
// ---------------------------------------------------------------------------

test.describe('capsule-integrity: самоочистка guard при удалении последней капсулы', () => {
  test.beforeEach(async ({ page }) => { await openAct(page, SEED_ACTS.withContent); });

  test('удаление ЕДИНСТВЕННОЙ капсулы через removeLinkOrFootnote → в живом DOM нет U+FEFF', async ({ page }) => {
    await setupLeadingCapsuleWithGuard(page); // ведущая капсула + guard U+FEFF перед ней

    // Предусловие: guard есть, капсула ровно одна.
    const before = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]');
      return {
        hasGuard: ed.textContent.includes('\uFEFF'),
        capsules: ed.querySelectorAll('.text-link, .text-footnote').length,
      };
    });
    expect(before.hasGuard).toBe(true);
    expect(before.capsules).toBe(1);

    // Удаляем единственную капсулу штатным потоком → finalizeEdit({renumber:true}).
    await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]');
      const tbm = (window as any).textBlockManager;
      tbm.activeEditor = ed;
      tbm.removeLinkOrFootnote(ed.querySelector('.text-link, .text-footnote'));
    });

    const after = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]');
      return {
        hasGuard: ed.textContent.includes('\uFEFF'),
        capsules: ed.querySelectorAll('.text-link, .text-footnote').length,
      };
    });
    expect(after.capsules).toBe(0);      // капсула удалена
    expect(after.hasGuard).toBe(false);  // осиротевший guard вычищен самоочисткой (Fix 1)
  });
});

// ---------------------------------------------------------------------------
// Task 2 (CARET-1): inline-правка капсулы (двойной клик, editing-mode) — слои 1/2
// целостности трактуют её как обычный редактируемый контент. Печать/Backspace
// правят ТЕЛО капсулы, а не удаляют её целиком и не уходят наружу; после выхода
// правка сохранена, служебный класс editing-mode в content не утекает.
// ---------------------------------------------------------------------------

/** @returns снимок состояния капсулы txt-seed-1 из живого DOM. */
async function capsuleState(page) {
  return await page.evaluate(() => {
    const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]');
    const cap = ed ? ed.querySelector('.text-link') : null;
    return {
      alive: !!cap,
      text: cap ? cap.textContent : null,
      ce: cap ? cap.getAttribute('contenteditable') : null,
      editing: cap ? cap.classList.contains('editing-mode') : false,
      linkUrl: cap ? cap.getAttribute('data-link-url') : null,
      editorText: ed ? ed.textContent : null,
    };
  });
}

test.describe('capsule-integrity: inline-правка капсулы (editing-mode)', () => {
  test.beforeEach(async ({ page }) => { await openAct(page, SEED_ACTS.withContent); });

  test('dblclick → печать/Backspace правят ТЕЛО капсулы; пауза не сбивает режим; выход сохраняет данные', async ({ page }) => {
    await focusSeededTextblockWithCapsule(page); // 'до <link>ссылка</link> после'

    // Двойной клик → editing-mode + выделение всего тела капсулы (setTimeout 0).
    await page.locator(`${EDITOR_SEL} .text-link`).dblclick();
    await page.waitForFunction(() => {
      const cap = document.querySelector(
        '.textblock-editor[data-text-block-id="txt-seed-1"] .text-link',
      );
      const sel = window.getSelection();
      return !!(cap && cap.classList.contains('editing-mode') &&
        cap.getAttribute('contenteditable') === 'true' &&
        sel && sel.rangeCount > 0 && !sel.isCollapsed &&
        cap.contains(sel.getRangeAt(0).commonAncestorContainer));
    }, { timeout: 2000 });
    // outside/key-listeners навешиваются в setTimeout(100) — ждём их для Enter-выхода.
    await page.waitForTimeout(150);

    // Печать по выделению заменяет ТЕЛО капсулы (было "ссылка"), не уходит наружу.
    await page.keyboard.type('НОВЫ');
    const afterType = await capsuleState(page);
    expect(afterType.alive).toBe(true);
    expect(afterType.text).toBe('НОВЫ');            // тело заменено
    expect(afterType.linkUrl).toBe('https://a.ru'); // атрибут капсулы цел
    expect(afterType.editorText).toContain('до ');   // текст снаружи не тронут
    expect(afterType.editorText).toContain(' после');
    expect(afterType.editorText).not.toContain('ссылка'); // старое тело ушло

    // Backspace удаляет символ ВНУТРИ, капсула не «съедается» целиком (слой 1).
    await page.keyboard.press('Backspace');
    const afterBksp = await capsuleState(page);
    expect(afterBksp.alive).toBe(true);
    expect(afterBksp.text).toBe('НОВ');

    // Пауза дольше input-debounce (500мс): автосток редактора НЕ должен сбросить
    // contenteditable капсулы и НЕ должен утечь editing-mode в сохранённый content.
    await page.waitForTimeout(700);
    const afterPause = await capsuleState(page);
    expect(afterPause.alive).toBe(true);
    expect(afterPause.editing).toBe(true);  // режим правки не слетел
    expect(afterPause.ce).toBe('true');     // НЕ склобберено normalizeMarkers
    const leaked = await page.evaluate(() => {
      const tb = (window as any).AppState?.textBlocks?.['txt-seed-1'];
      return tb?.content || '';
    });
    expect(leaked).not.toContain('editing-mode'); // служебный класс не сохранён

    // Выход по Enter → finishEditing снимает режим и вызывает finalizeEdit(editor).
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const cap = document.querySelector(
        '.textblock-editor[data-text-block-id="txt-seed-1"] .text-link',
      );
      return !!(cap && !cap.classList.contains('editing-mode') &&
        cap.getAttribute('contenteditable') === 'false');
    }, { timeout: 2000 });

    const saved = await page.evaluate(() => {
      const tb = (window as any).AppState?.textBlocks?.['txt-seed-1'];
      return tb?.content || '';
    });
    const finalState = await capsuleState(page);
    expect(finalState.linkUrl).toBe('https://a.ru');           // данные капсулы целы
    expect(finalState.text).toBe('НОВ');
    expect(saved).toContain('data-link-url="https://a.ru"');   // правка в сохранённом content
    expect(saved).toContain('>НОВ<');
    expect(saved).not.toContain('editing-mode');               // класс не утёк и на выходе
    expect(saved).not.toContain('contenteditable');            // рантайм-атрибут стрипнут
  });

  test('полное удаление текста внутри editing-mode капсулы оставляет редактор чистым (без битой капсулы/сирот-guard); observer не вмешивается', async ({ page }) => {
    // Требование №3: пустое тело капсулы в режиме правки не должно приводить к её
    // удалению observer'ом. Наши слои её не трогают (editing-mode), а нативный
    // Delete Chromium сам убирает опустевший inline-span (ссылка «разворачивается»
    // в plain-text — то же поведение, что у removeLinkOrFootnote с пустым значением).
    // Проверяем инвариант устойчиво к браузеру: после выхода нет ни битой капсулы
    // (пустой data-link-url), ни осиротевших caret-guard'ов, текст вокруг цел.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await focusSeededTextblockWithCapsule(page);
    await page.locator(`${EDITOR_SEL} .text-link`).dblclick();
    await page.waitForFunction(() => {
      const cap = document.querySelector(
        '.textblock-editor[data-text-block-id="txt-seed-1"] .text-link',
      );
      return !!(cap && cap.classList.contains('editing-mode') &&
        cap.getAttribute('contenteditable') === 'true');
    }, { timeout: 2000 });
    await page.waitForTimeout(150);

    // Выделяем всё тело капсулы и удаляем.
    await page.evaluate(() => {
      const cap = document.querySelector(
        '.textblock-editor[data-text-block-id="txt-seed-1"] .text-link',
      );
      const r = document.createRange();
      r.selectNodeContents(cap);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await page.keyboard.press('Delete');
    // Ждём дольше цикла observer + возможного debounce.
    await page.waitForTimeout(400);
    // Выход по Enter (finishEditing снимает режим).
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    const clean = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]');
      const caps = [...ed.querySelectorAll('.text-link, .text-footnote')];
      const GUARD = '\uFEFF';
      let orphanGuards = 0;
      const adj = (n) => n && n.nodeType === 1 &&
        (n.classList.contains('text-link') || n.classList.contains('text-footnote'));
      const walk = (node) => {
        if (node.nodeType === 3 && node.data === GUARD &&
            !adj(node.previousSibling) && !adj(node.nextSibling)) orphanGuards++;
        node.childNodes.forEach(walk);
      };
      walk(ed);
      return {
        brokenCaps: caps.filter(c => !(c.getAttribute('data-link-url') || '').trim()).length,
        text: ed.textContent.replace(/[\uFEFF\u200B]/g, ''),
        orphanGuards,
      };
    });
    expect(clean.brokenCaps).toBe(0);        // ни одной пустой/битой капсулы
    expect(clean.orphanGuards).toBe(0);      // осиротевших guard-узлов нет
    expect(clean.text).toContain('до');      // текст вокруг капсулы цел
    expect(clean.text).toContain('после');
    expect(errors).toEqual([]);              // никаких исключений на детач-узле
  });

  test('обычная (не-editing) капсула сохраняет атомарность: Backspace справа удаляет целиком', async ({ page }) => {
    // Регресс-гейт требования №4: критерий editing-mode НЕ ослабил обычные капсулы.
    await focusSeededTextblockWithCapsule(page);
    await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]');
      const cap = ed.querySelector('.text-link');
      const r = document.createRange();
      r.setStartAfter(cap); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await page.keyboard.press('Backspace');
    const gone = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]');
      return ed.querySelector('.text-link') === null;
    });
    expect(gone).toBe(true); // обычная капсула удалена целиком (атомарность цела)
  });
});

// ---------------------------------------------------------------------------
// Task 3 (CARET-2 / CORE-4 / CARET-6): round-trip капсул через буфер обмена
// (copy/cut → paste со свежими id и живым телом), гейт пустого paste, undo,
// строгая политика внешнего HTML, и paste во время inline-правки капсулы.
// ---------------------------------------------------------------------------

/** Переходит на шаг 2, дожидается сид-редактора и делает его активным. */
async function openStep2AndActivate(page) {
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.locator('.step[data-step="2"]').click();
  await page.locator(EDITOR_SEL).waitFor({ state: 'visible', timeout: 5000 });
  await page.locator(EDITOR_SEL).click();
  await page.evaluate(() => {
    const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
    (window as any).textBlockManager.activeEditor = ed;
  });
}

test.describe('capsule-integrity: буфер обмена (Task 3)', () => {
  test.beforeEach(async ({ page }) => { await openAct(page, SEED_ACTS.withContent); });

  test('cut капсулы-сноски → paste переносит тело и id, номер пересчитан (CARET-2)', async ({ page }) => {
    await openStep2AndActivate(page);
    const res = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.activeEditor = ed;
      ed.innerHTML =
        'до ' +
        '<span class="text-footnote" data-footnote-id="F1" data-footnote-text="тело сноски"' +
        ' contenteditable="false">сн</span>' +
        ' после';
      tbm.attachLinkFootnoteHandlers();
      ed.focus();

      // Выделяем капсулу целиком и вырезаем в синтетический буфер.
      const cap = ed.querySelector('.text-footnote')!;
      const origId = cap.getAttribute('data-footnote-id');
      const r = document.createRange(); r.selectNode(cap);
      const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
      const dt = new DataTransfer();
      ed.dispatchEvent(new ClipboardEvent('cut', { clipboardData: dt, bubbles: true, cancelable: true }));
      const clipHtml = dt.getData('text/html');
      const clipPlain = dt.getData('text/plain');
      const capGone = ed.querySelector('.text-footnote') === null;

      // Каретка в конец, вставляем из того же буфера.
      const r2 = document.createRange(); r2.selectNodeContents(ed); r2.collapse(false);
      s.removeAllRanges(); s.addRange(r2);
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));

      const cap2 = ed.querySelector('.text-footnote');
      return {
        clipHtml, clipPlain, capGone, origId,
        alive: !!cap2,
        body: cap2 ? cap2.getAttribute('data-footnote-text') : null,
        id: cap2 ? cap2.getAttribute('data-footnote-id') : null,
        num: cap2 ? cap2.getAttribute('data-footnote-number') : null,
        text: cap2 ? cap2.textContent!.replace(/[\uFEFF\u200B]/g, '') : null,
      };
    });
    // Буфер помечен своим форматом, тело сноски в нём, guard не утёк (CORE-4).
    expect(res.clipHtml).toContain('data-aw-clip');
    expect(res.clipHtml).toContain('data-footnote-text="тело сноски"');
    expect(res.clipHtml).not.toContain('\uFEFF');
    expect(res.clipPlain).toBe('сн');
    // Cut удалил капсулу; paste восстановил её тело со свежим id и номером.
    expect(res.capGone).toBe(true);
    expect(res.alive).toBe(true);
    expect(res.body).toBe('тело сноски');       // тело сноски НЕ потеряно (CARET-2)
    expect(res.id).not.toBe(res.origId);         // свежий id у копии
    expect(res.text).toBe('сн');
    expect(res.num).toBe('1');                   // перенумерована на рендере
  });

  test('copy стрипает caret-guard U+FEFF из буфера, хотя в DOM он есть (CORE-4)', async ({ page }) => {
    await openStep2AndActivate(page);
    const res = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.activeEditor = ed;
      // Ведущая капсула → normalizeMarkers ставит guard U+FEFF перед ней.
      ed.innerHTML =
        '<span class="text-link" data-link-id="L1" data-link-url="https://a.ru"' +
        ' contenteditable="false">ссыл</span> хвост';
      tbm.normalizeMarkers(ed);
      tbm.attachLinkFootnoteHandlers();
      ed.focus();
      const domHasGuard = ed.textContent!.includes('\uFEFF');

      const s = getSelection()!;
      const r = document.createRange(); r.selectNodeContents(ed);
      s.removeAllRanges(); s.addRange(r);
      const dt = new DataTransfer();
      ed.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
      return {
        domHasGuard,
        clipHtml: dt.getData('text/html'),
        clipPlain: dt.getData('text/plain'),
      };
    });
    expect(res.domHasGuard).toBe(true);           // в живом DOM guard действительно есть
    expect(res.clipHtml).not.toContain('\uFEFF'); // в буфер не утёк (CORE-4)
    expect(res.clipPlain).not.toContain('\uFEFF');
    expect(res.clipHtml).toContain('data-aw-clip');
  });

  test('round-trip своего буфера сохраняет инлайн-формат и реконструирует ссылку', async ({ page }) => {
    await openStep2AndActivate(page);
    const res = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.activeEditor = ed;
      ed.innerHTML =
        '<b>жир</b> ' +
        '<span class="text-link" data-link-id="L1" data-link-url="https://a.ru"' +
        ' contenteditable="false">ссыл</span>';
      tbm.attachLinkFootnoteHandlers();
      ed.focus();

      const s = getSelection()!;
      const r = document.createRange(); r.selectNodeContents(ed);
      s.removeAllRanges(); s.addRange(r);
      const dt = new DataTransfer();
      ed.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
      const clipHtml = dt.getData('text/html');

      const r2 = document.createRange(); r2.selectNodeContents(ed); r2.collapse(false);
      s.removeAllRanges(); s.addRange(r2);
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));

      const links = [...ed.querySelectorAll('.text-link')];
      return {
        clipHtml,
        linkCount: links.length,
        uniqueIds: new Set(links.map((a) => a.getAttribute('data-link-id'))).size,
        urls: links.map((a) => a.getAttribute('data-link-url')),
        boldCount: ed.querySelectorAll('b').length,
      };
    });
    expect(res.clipHtml).toContain('data-aw-clip');
    expect(res.linkCount).toBe(2);                       // оригинал + вставленная копия
    expect(res.uniqueIds).toBe(2);                       // свежий id у копии (id не делится)
    expect(res.urls).toEqual(['https://a.ru', 'https://a.ru']); // URL прошёл validateLinkUrl
    expect(res.boldCount).toBe(2);                       // инлайн-формат <b> сохранён
  });

  test('Ctrl+Z после paste откатывает вставку (insertHTML в undo-стеке, §6.9)', async ({ page }) => {
    await openStep2AndActivate(page);
    const res = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.activeEditor = ed;
      ed.innerHTML = 'абв';
      ed.focus();
      const s = getSelection()!;
      const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false);
      s.removeAllRanges(); s.addRange(r);

      const dt = new DataTransfer();
      dt.setData('text/html', '<p>ЭКС</p>');
      dt.setData('text/plain', 'ЭКС');
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      const afterPaste = ed.textContent;
      document.execCommand('undo');
      const afterUndo = ed.textContent;
      return { afterPaste, afterUndo };
    });
    expect(res.afterPaste).toContain('ЭКС');       // вставка произошла
    expect(res.afterUndo).not.toContain('ЭКС');    // Ctrl+Z откатил её (нативный undo)
  });

  test('пустой после санитизации фрагмент (img, пустой plain) не съедает выделение (CARET-6)', async ({ page }) => {
    await openStep2AndActivate(page);
    const res = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.activeEditor = ed;
      ed.innerHTML = 'раз два три';
      ed.focus();
      const t = ed.firstChild as Text;
      const r = document.createRange();
      r.setStart(t, 4); r.setEnd(t, 7); // 'два'
      const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
      const selText = r.toString();

      const dt = new DataTransfer();
      dt.setData('text/html', '<img src=x onerror=alert(1)>'); // весь фрагмент вырежет DOMPurify
      dt.setData('text/plain', '');                            // пустой plain
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return { selText, text: ed.textContent };
    });
    expect(res.selText).toBe('два');
    expect(res.text).toBe('раз два три'); // выделение не съедено, ничего не вставлено (CARET-6)
  });

  test('внешний HTML — строгая политика: формат схлопнут, выживает только ссылка', async ({ page }) => {
    await openStep2AndActivate(page);
    const res = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.activeEditor = ed;
      ed.innerHTML = ''; ed.focus();
      const s = getSelection()!;
      const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false);
      s.removeAllRanges(); s.addRange(r);

      const dt = new DataTransfer();
      dt.setData('text/html', '<b>жирный</b> <a href="https://x.ru">ссыл</a>'); // БЕЗ метки data-aw-clip
      dt.setData('text/plain', 'жирный ссыл');
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return {
        links: [...ed.querySelectorAll('.text-link')].map((a) => a.getAttribute('data-link-url')),
        boldCount: ed.querySelectorAll('b').length,
        text: ed.textContent,
      };
    });
    expect(res.links).toEqual(['https://x.ru']); // ссылка сохранена как капсула
    expect(res.boldCount).toBe(0);               // <b> схлопнут (строгая политика не изменилась)
    expect(res.text).toContain('жирный');        // текст сохранён как plain
  });

  test('paste во время inline-правки капсулы идёт плейн-текстом в тело, не клоббит капсулу (CARET-1)', async ({ page }) => {
    await focusSeededTextblockWithCapsule(page); // 'до <link>ссылка</link> после'
    await page.locator(`${EDITOR_SEL} .text-link`).dblclick();
    await page.waitForFunction(() => {
      const cap = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"] .text-link');
      return !!(cap && cap.classList.contains('editing-mode') &&
        cap.getAttribute('contenteditable') === 'true');
    }, { timeout: 2000 });
    await page.waitForTimeout(150); // выделение тела капсулы ставится в setTimeout(0)

    const res = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const dt = new DataTransfer();
      // HTML с капсулой-сноской + plain: в editing-mode HTML игнорируется.
      dt.setData('text/html', '<span class="text-footnote" data-footnote-text="тело">X</span>');
      dt.setData('text/plain', 'ВСТАВКА');
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      const cap = ed.querySelector('.text-link');
      return {
        linkAlive: !!cap,
        footnotes: ed.querySelectorAll('.text-footnote').length,
        capText: cap ? cap.textContent : null,
        linkUrl: cap ? cap.getAttribute('data-link-url') : null,
      };
    });
    expect(res.linkAlive).toBe(true);          // капсула не склоблена
    expect(res.footnotes).toBe(0);             // HTML не реконструирован в капсулу (только plain)
    expect(res.capText).toContain('ВСТАВКА');  // plain вставлен в тело капсулы
    expect(res.linkUrl).toBe('https://a.ru');  // атрибуты капсулы целы
  });

  test('copy из read-only редактора → paste в редактируемый: капсула реконструирована (CARET-2 между актами)', async ({ page }) => {
    await openStep2AndActivate(page);
    const res = await page.evaluate(() => {
      const tbm = (window as any).textBlockManager;
      const AppConfig = (window as any).AppConfig;

      // 1) Строим read-only редактор с ВЕДУЩЕЙ сноской (normalizeMarkers ставит
      //    guard U+FEFF перед ней — он есть и в RO-DOM).
      AppConfig.readOnlyMode.isReadOnly = true;
      const roTb = {
        id: 'txt-ro-src',
        content: '<span class="text-footnote" data-footnote-id="RO1" data-footnote-text="тело RO"' +
          ' contenteditable="false">сн</span> хвост',
      };
      (window as any).AppState.textBlocks['txt-ro-src'] = roTb;
      const roEd = tbm.createEditor(roTb) as HTMLElement;
      document.body.appendChild(roEd);
      AppConfig.readOnlyMode.isReadOnly = false; // цель paste — редактируемая

      const roIsReadOnly = roEd.getAttribute('contenteditable') === 'false';
      const roHasGuard = roEd.textContent!.includes('\uFEFF');

      // 2) Копируем из RO-редактора, НЕ ставя activeEditor — проверяем, что
      //    handleEditorCopy editor-относительный (передаёт свой editor).
      tbm.activeEditor = null;
      const s = getSelection()!;
      const r = document.createRange(); r.selectNodeContents(roEd);
      s.removeAllRanges(); s.addRange(r);
      const dt = new DataTransfer();
      roEd.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
      const clipHtml = dt.getData('text/html');

      // 3) Вставляем в редактируемый сид-редактор.
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      tbm.activeEditor = ed;
      ed.innerHTML = ''; ed.focus();
      const r2 = document.createRange(); r2.selectNodeContents(ed); r2.collapse(false);
      s.removeAllRanges(); s.addRange(r2);
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));

      const cap = ed.querySelector('.text-footnote');
      roEd.remove();
      return {
        roIsReadOnly, roHasGuard,
        clipHasMark: clipHtml.includes('data-aw-clip'),
        clipHasBody: clipHtml.includes('data-footnote-text="тело RO"'),
        clipHasGuard: clipHtml.includes('\uFEFF'),
        pastedBody: cap ? cap.getAttribute('data-footnote-text') : null,
        pastedId: cap ? cap.getAttribute('data-footnote-id') : null,
      };
    });
    expect(res.roIsReadOnly).toBe(true);    // редактор действительно read-only
    expect(res.roHasGuard).toBe(true);      // guard в RO-DOM присутствует
    expect(res.clipHasMark).toBe(true);     // буфер помечен своим форматом
    expect(res.clipHasBody).toBe(true);     // тело сноски унесено в буфер
    expect(res.clipHasGuard).toBe(false);   // U+FEFF стрипнут даже в RO (CORE-4)
    expect(res.pastedBody).toBe('тело RO'); // капсула реконструирована в редактируемом
    expect(res.pastedId).not.toBe('RO1');   // свежий id
  });

  test('свой буфер с javascript:-URL в data-link-url → развёрнут в текст, ноль ссылок/anchor (граница доверия)', async ({ page }) => {
    await openStep2AndActivate(page);
    const res = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.activeEditor = ed;
      ed.innerHTML = ''; ed.focus();
      const s = getSelection()!;
      const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false);
      s.removeAllRanges(); s.addRange(r);
      const dt = new DataTransfer();
      dt.setData('text/html',
        '<div data-aw-clip="1"><span class="text-link" data-link-url="javascript:alert(1)">x</span></div>');
      dt.setData('text/plain', 'x');
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return {
        links: ed.querySelectorAll('.text-link').length,
        anchors: ed.querySelectorAll('a').length,
        hasJs: ed.innerHTML.includes('javascript'),
        text: ed.textContent!.replace(/[\uFEFF\u200B]/g, ''),
      };
    });
    expect(res.links).toBe(0);      // капсула-ссылка НЕ создана
    expect(res.anchors).toBe(0);    // и anchor тоже
    expect(res.hasJs).toBe(false);  // javascript: не просочился
    expect(res.text).toBe('x');     // развёрнуто в видимый текст
  });

  test('_isOwnClipboardHtml: точная attribute-проверка, устойчива к CF_HTML-обёртке', async ({ page }) => {
    await openStep2AndActivate(page);
    const res = await page.evaluate(() => {
      const tbm = (window as any).textBlockManager;
      return {
        bare: tbm._isOwnClipboardHtml('<div data-aw-clip="1">x</div>'),
        wrapped: tbm._isOwnClipboardHtml(
          '<html><body><!--StartFragment--><div data-aw-clip="1">x</div><!--EndFragment--></body></html>'),
        substringInText: tbm._isOwnClipboardHtml('<p>про data-aw-clip в тексте</p>'),
        external: tbm._isOwnClipboardHtml('<p>внешний Word</p>'),
      };
    });
    expect(res.bare).toBe(true);             // наш буфер
    expect(res.wrapped).toBe(true);          // наш буфер под обёрткой браузера (CF_HTML)
    expect(res.substringInText).toBe(false); // подстрока в ТЕКСТЕ — НЕ наш буфер
    expect(res.external).toBe(false);
  });

  test('F3 _hasCapsuleMarkers: точная attribute-проверка (data-link-url/footnote), устойчива к CF_HTML', async ({ page }) => {
    await openStep2AndActivate(page);
    const res = await page.evaluate(() => {
      const tbm = (window as any).textBlockManager;
      return {
        link: tbm._hasCapsuleMarkers('<span class="text-link" data-link-url="http://a.ru">a</span>'),
        footnote: tbm._hasCapsuleMarkers('<span class="text-footnote" data-footnote-text="тело">1</span>'),
        wrapped: tbm._hasCapsuleMarkers(
          '<html><body><!--StartFragment--><span data-link-url="http://a.ru">a</span><!--EndFragment--></body></html>'),
        substringInText: tbm._hasCapsuleMarkers('<p>про data-link-url в тексте</p>'),
        external: tbm._hasCapsuleMarkers('<p>внешний <a href="http://x">линк</a></p>'),
      };
    });
    expect(res.link).toBe(true);             // капсула-ссылка нашего формата
    expect(res.footnote).toBe(true);         // капсула-сноска нашего формата
    expect(res.wrapped).toBe(true);          // капсула под обёрткой браузера (CF_HTML)
    expect(res.substringInText).toBe(false); // подстрока в ТЕКСТЕ — НЕ капсула
    expect(res.external).toBe(false);        // внешний <a href> — НЕ наша капсула
  });

  test('F3 drop-путь: капсулы БЕЗ метки data-aw-clip → own-реконструкция (ссылка жива, img/js вырезаны)', async ({ page }) => {
    await openStep2AndActivate(page);
    // Нативный drag выделения теряет data-aw-clip. _buildPasteFragment с
    // fromDrop=true опознаёт капсулы по маркерам и ведёт own-путём: ссылка с
    // валидным URL выживает, спуф javascript:-URL разворачивается в текст,
    // <img onerror> рядом режется ТЕМ ЖЕ DOMPurify (own-путь не слабее внешнего).
    const res = await page.evaluate(() => {
      const tbm = (window as any).textBlockManager;
      const html = '<span class="text-link" data-link-url="http://a.ru">жив</span>'
        + '<img src=x onerror="window.__xss=1">'
        + '<span class="text-link" data-link-url="javascript:alert(1)">спуф</span>';
      // footnotesBlocked=false (textblock-политика): ссылки гейт не касается.
      const frag = tbm._buildPasteFragment(html, false, true);
      const holder = document.createElement('div');
      holder.appendChild(frag);
      return {
        links: holder.querySelectorAll('.text-link').length,
        liveUrl: holder.querySelector('.text-link')?.getAttribute('data-link-url') || null,
        imgs: holder.querySelectorAll('img').length,
        hasJs: holder.innerHTML.includes('javascript'),
        xss: (window as any).__xss === 1,
        text: holder.textContent!.replace(/[﻿​]/g, ''),
      };
    });
    expect(res.links).toBe(1);            // выжила ровно валидная ссылка
    expect(res.liveUrl).toBe('http://a.ru');
    expect(res.imgs).toBe(0);             // <img onerror> вырезан санитайзером
    expect(res.hasJs).toBe(false);        // javascript:-URL не просочился
    expect(res.xss).toBe(false);          // onerror не исполнился
    expect(res.text).toContain('жив');
    expect(res.text).toContain('спуф');   // спуф-капсула развёрнута в видимый текст
  });

  test('own-paste фильтрует style до CSS-allowlist профиля acts (font-size живёт, margin режется)', async ({ page }) => {
    await openStep2AndActivate(page);
    const res = await page.evaluate(() => {
      const ed = document.querySelector('.textblock-editor[data-text-block-id="txt-seed-1"]') as HTMLElement;
      const tbm = (window as any).textBlockManager;
      tbm.activeEditor = ed;
      ed.innerHTML = ''; ed.focus();
      const s = getSelection()!;
      const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false);
      s.removeAllRanges(); s.addRange(r);
      const dt = new DataTransfer();
      dt.setData('text/html',
        '<div data-aw-clip="1"><span style="font-size:24px;margin:99px">Т</span></div>');
      dt.setData('text/plain', 'Т');
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      const span = ed.querySelector('span[style]');
      return {
        style: span ? span.getAttribute('style') : null,
        text: ed.textContent!.replace(/[\uFEFF\u200B]/g, ''),
      };
    });
    expect(res.style).toContain('font-size');  // разрешённое свойство сохранено
    expect(res.style).not.toContain('margin'); // неразрешённое отфильтровано (контракт acts)
    expect(res.text).toBe('Т');
  });
});
