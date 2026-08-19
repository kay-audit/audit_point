/**
 * Паритет геометрии печатного листа: превью ↔ DOCX (Task C, супersedes B-22).
 *
 * DOM-рендер CSS в node недоступен (нет браузера), поэтому — как и прочие
 * *-parity.test.mjs — тест читает CSS-файлы ТЕКСТОМ и пинит golden-значения
 * из app/domains/acts/formatters/docx/styles.py::Spacing/Sizes:
 *   - line_single (w:line=240, «одинарный» Word-интервал) ⇔ CSS line-height
 *     ~1.15 для Times New Roman 12pt;
 *   - after_pt = 3 (Normal-спейсинг после абзаца) ⇔ margin-bottom: 3pt после
 *     текстблока целиком (_render_textblock зануляет space_after у ВСЕХ
 *     промежуточных w:p, 3pt остаётся только у последнего сегмента);
 *   - blank_line_pt = 6 (add_blank_line после таблицы) ⇔ margin: 6pt у
 *     .preview-table-wrapper на листе.
 *
 * Инвариант: превью текстблока рисует РОВНО то, что уйдёт в Word. С переходом
 * редактора на документную типографику (пункты + печатный интервал) поверхность
 * правки держит ТОТ ЖЕ ритм: единый токен --doc-line-height, а экранную
 * читаемость даёт zoom, который раскладку не меняет.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const typographyCss = readFileSync(
    fileURLToPath(new URL('../../static/css/base/variables/typography.css', import.meta.url)),
    'utf8',
);
const previewPageCss = readFileSync(
    fileURLToPath(new URL('../../static/css/constructor/preview/preview-page.css', import.meta.url)),
    'utf8',
);
const previewTypographyCss = readFileSync(
    fileURLToPath(new URL('../../static/css/constructor/preview/preview-typography.css', import.meta.url)),
    'utf8',
);
const editorContentCss = readFileSync(
    fileURLToPath(new URL('../../static/css/constructor/textblock/textblock-content.css', import.meta.url)),
    'utf8',
);

// Golden-числа из styles.py — держим их в тесте буквально, чтобы разъезд
// значений (кто-то поправит styles.py и забудет CSS) падал явным диффом.
const DOCX_LINE_SINGLE_CSS = '1.15'; // Word «одинарный» для TNR 12pt
const DOCX_SPACING_AFTER_PT = 3; // Spacing.after_pt
const DOCX_BLANK_LINE_PT = 6; // Sizes.blank_line_pt (add_blank_line после таблицы)


test('typography.css: документный --doc-line-height задан как Word-одинарный (1.15)', () => {
    const match = typographyCss.match(/--doc-line-height:\s*([\d.]+)/);
    assert.ok(match, 'токен --doc-line-height не найден в base/variables/typography.css');
    assert.equal(match[1], DOCX_LINE_SINGLE_CSS);
});

test('preview-page.css: --preview-print-line-height — алиас документного токена', () => {
    assert.match(
        previewPageCss,
        /--preview-print-line-height:\s*var\(--doc-line-height\)/,
        'лист превью обязан читать общий --doc-line-height, а не свою копию числа',
    );
});

test('preview-page.css: .preview-sheet использует токен --preview-print-line-height (не хардкод)', () => {
    assert.match(
        previewPageCss,
        /\.preview-sheet\s*\{[^}]*line-height:\s*var\(--preview-print-line-height\)/s,
        '.preview-sheet должен читать line-height из токена',
    );
});

test('preview-typography.css: .preview-sheet .preview-textblock-content — line-height печатного листа', () => {
    const rule = previewTypographyCss.match(
        /\.preview-sheet \.preview-textblock-content\s*\{([^}]*)\}/s,
    );
    assert.ok(rule, 'правило .preview-sheet .preview-textblock-content не найдено');
    assert.match(
        rule[1],
        /line-height:\s*var\(--preview-print-line-height,\s*1\.15\)/,
        `line-height блока на листе не пинит Word-single: ${rule[1]}`,
    );
});

test('preview-typography.css: 3pt после текстблока целиком (Spacing.after_pt)', () => {
    const rule = previewTypographyCss.match(
        /\.preview-sheet \.preview-textblock-content\s*\{([^}]*)\}/s,
    );
    assert.ok(rule, 'правило .preview-sheet .preview-textblock-content не найдено');
    assert.match(
        rule[1],
        new RegExp(`margin-bottom:\\s*${DOCX_SPACING_AFTER_PT}pt`),
        `margin-bottom текстблока ≠ ${DOCX_SPACING_AFTER_PT}pt: ${rule[1]}`,
    );
});

test('preview-typography.css: сегменты текстблока БЕЗ зазора между собой (обнулённый space_after)', () => {
    const rule = previewTypographyCss.match(
        /\.preview-sheet \.preview-textblock-content > \*\s*\{([^}]*)\}/s,
    );
    assert.ok(rule, 'правило сброса margin у сегментов текстблока не найдено');
    assert.match(rule[1], /margin-top:\s*0/);
    assert.match(rule[1], /margin-bottom:\s*0/);
});

test('preview-page.css: .preview-table-wrapper на листе — 6pt (add_blank_line после таблицы)', () => {
    const rule = previewPageCss.match(
        /\.preview-sheet \.preview-table-wrapper\s*\{([^}]*)\}/s,
    );
    assert.ok(rule, 'правило .preview-sheet .preview-table-wrapper не найдено');
    assert.match(
        rule[1],
        new RegExp(`margin:\\s*${DOCX_BLANK_LINE_PT}pt`),
        `margin таблицы ≠ ${DOCX_BLANK_LINE_PT}pt: ${rule[1]}`,
    );
});

test('редактор держит печатный ритм: тот же --doc-line-height, что у листа и DOCX', () => {
    const rule = editorContentCss.match(/\.textblock-editor\s*\{([^}]*)\}/s);
    assert.ok(rule, 'правило .textblock-editor не найдено');
    assert.match(
        rule[1],
        /line-height:\s*var\(--doc-line-height\)/,
        `.textblock-editor обязан читать документный интервал: ${rule[1]}`,
    );
    assert.match(
        rule[1],
        /font-size:\s*var\(--doc-font-size\)/,
        `.textblock-editor обязан читать документный кегль (в пунктах): ${rule[1]}`,
    );
});

test('поверхность правки печатный кегль не масштабирует', () => {
    // Экранный множитель (прежний zoom 1.25) убран: на шаге заполнения рядом с
    // текстом живёт масса элементов конструктора, и раздутый документ их
    // вытеснял. Кегль остаётся печатным, но ровно печатным — ни зума, ни
    // подмены значения.
    const rule = editorContentCss.match(/\.textblock-editor\s*\{([^}]*)\}/s);
    assert.doesNotMatch(
        rule[1],
        /zoom:/,
        `.textblock-editor не должен масштабироваться зумом: ${rule[1]}`,
    );
    // У листа превью зума не было и раньше — иначе геометрия A4 поедет.
    assert.doesNotMatch(previewPageCss, /\.preview-sheet\s*\{[^}]*zoom:/s);
});

test('блоки content в редакторе не добавляют собственный вертикальный отступ', () => {
    // Enter даёт <div>, вставка из Word — <p>, внешняя вставка приносит h1-h6.
    // У всех троих ритм обязан быть одинаковым: свои margin'ы дали бы разный шаг
    // в зависимости от происхождения текста (замер: 34.4px против 18.4px).
    const paraRule = editorContentCss.match(
        /\.textblock-editor p,\s*\n\.violation-textarea p\s*\{([^}]*)\}/s,
    );
    assert.ok(paraRule, 'правило абзацев .textblock-editor p не найдено');
    assert.match(paraRule[1], /margin:\s*0/, `у абзаца остался свой margin: ${paraRule[1]}`);

    const headingRule = editorContentCss.match(
        /\.textblock-editor h1,[^{]*\.violation-textarea h6\s*\{([^}]*)\}/s,
    );
    assert.ok(headingRule, 'правило заголовков редактора не найдено');
    assert.match(headingRule[1], /margin:\s*0/, `у заголовка остался свой margin: ${headingRule[1]}`);
});

test('списки в редакторе не добавляют собственный вертикальный отступ', () => {
    const listRule = editorContentCss.match(
        /\.textblock-editor ul,\s*\n\.textblock-editor ol,[^{]*\{([^}]*)\}/s,
    );
    assert.ok(listRule, 'правило списков .textblock-editor ul/ol не найдено');
    assert.match(listRule[1], /margin:\s*0/, `у списков остался свой margin: ${listRule[1]}`);
    const itemRule = editorContentCss.match(
        /\.textblock-editor li,\s*\n\.violation-textarea li\s*\{([^}]*)\}/s,
    );
    assert.ok(itemRule, 'правило пунктов .textblock-editor li не найдено');
    assert.match(itemRule[1], /margin:\s*0/, `у пунктов остался свой margin: ${itemRule[1]}`);
});
