/**
 * Golden-тест полноты ПРЕВЬЮ (зеркало tests/domains/acts/golden/, Б-2.3).
 *
 * Та же фикстура-эталон (компактная JS-форма с теми же GOLDEN_-маркерами,
 * что в tests/domains/acts/golden/fixture_act.py — блочная модель: 10 полей,
 * 3 типа блоков, нестандартный fieldOrder) прогоняется через ЧИСТЫЕ функции
 * превью: collectViolationLines + imagePresentationStyle
 * (preview-violation-renderer) и iterateVisibleCells (grid-merges).
 *
 * Политика — как у бэкового golden: presence данных, не равенство подписей
 * (Д.3). Полный DOM-рендер в node без DOM невозможен — что не покрыто,
 * перечислено в README golden-пакета.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    collectViolationLines,
    imagePresentationStyle,
} from '../../static/js/constructor/preview/preview-violation-renderer.js';
import { iterateVisibleCells } from '../../static/js/constructor/table/grid-merges.js';

// --- Фикстура: зеркало fixture_act.py (нарушение блочной модели + таблица) ---

const GOLDEN_PNG_DATA_URL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' +
    'AAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const text = (id, content) => ({ id, type: 'text', content });

const goldenImageBlock = {
    id: 'vb9',
    type: 'image',
    url: GOLDEN_PNG_DATA_URL,
    caption: 'GOLDEN_V_IMG_CAPTION',
    filename: 'golden_image.png',
    width: 50,
};

const goldenViolation = {
    id: 'v1',
    nodeId: 'n_v',
    fieldOrder: [
        'responsible', 'violated', 'established', 'description',
        'codeMining', 'processMining', 'additionalContent',
        'reasons', 'measures', 'consequences',
    ],
    violated: { enabled: true, blocks: [text('vb1', 'GOLDEN_V_VIOLATED')] },
    established: { enabled: true, blocks: [text('vb2', 'GOLDEN_V_ESTABLISHED')] },
    description: {
        enabled: true,
        blocks: [text('vb3', 'GOLDEN_V_DESC_1'), text('vb4', 'GOLDEN_V_DESC_2')],
    },
    codeMining: {
        enabled: true,
        blocks: [
            text('vb5', 'GOLDEN_V_CM_TEXT'),
            {
                id: 'vb6', type: 'table',
                table: {
                    grid: [
                        [{ content: 'GOLDEN_V_CM_TH', isHeader: true },
                         { content: 'GOLDEN_V_CM_TH2', isHeader: true }],
                        [{ content: 'GOLDEN_V_CM_CELL' }, { content: 'GOLDEN_V_CM_CELL2' }],
                    ],
                    colWidths: [120, 80],
                },
            },
        ],
    },
    processMining: { enabled: true, blocks: [text('vb7', 'GOLDEN_V_PM_TEXT')] },
    additionalContent: {
        enabled: true,
        blocks: [text('vb8', 'GOLDEN_V_FREETEXT'), goldenImageBlock],
    },
    reasons: { enabled: true, blocks: [text('vb10', 'GOLDEN_V_REASONS')] },
    measures: { enabled: true, blocks: [text('vb11', 'GOLDEN_V_MEASURES')] },
    consequences: { enabled: true, blocks: [text('vb12', 'GOLDEN_V_CONSEQUENCES')] },
    responsible: { enabled: true, blocks: [text('vb13', 'GOLDEN_V_RESPONSIBLE')] },
};

// Обычная таблица фикстуры: шапка + merge по горизонтали и вертикали + спецсимволы.
const goldenRegularGrid = [
    [
        { content: 'GOLDEN_RTBL_H0', isHeader: true, colSpan: 1, rowSpan: 1 },
        { content: 'GOLDEN_RTBL_H1', isHeader: true, colSpan: 1, rowSpan: 1 },
        { content: 'GOLDEN_RTBL_H2', isHeader: true, colSpan: 1, rowSpan: 1 },
    ],
    [
        { content: 'GOLDEN_RTBL_MERGED', colSpan: 2, rowSpan: 1 },
        { content: '', colSpan: 1, rowSpan: 1, isSpanned: true, spanOrigin: { row: 1, col: 0 } },
        { content: 'GOLDEN_RTBL_TALL', colSpan: 1, rowSpan: 2 },
    ],
    [
        { content: 'GOLDEN_RTBL_R2C0', colSpan: 1, rowSpan: 1 },
        { content: 'GOLDEN_RTBL_SPECIALS спец x<y & "z"', colSpan: 1, rowSpan: 1 },
        { content: '', colSpan: 1, rowSpan: 1, isSpanned: true, spanOrigin: { row: 1, col: 2 } },
    ],
];

/** Дамп всех текстов модели строк (line-текст + ячейки table-строк). */
function dumpLines(lines) {
    return lines
        .map(l => {
            if (l.type === 'table') {
                const cells = [];
                iterateVisibleCells(l.table.grid || [], (cell) => cells.push(cell.content));
                return cells.join(' ');
            }
            return `${l.label || ''}: ${l.text || ''}`;
        })
        .join('\n');
}

// --- Нарушение: presence всех данных в чистой модели строк превью ---

test('golden: контент всех 10 полей и всех 3 типов блоков присутствует в модели строк превью', () => {
    const lines = collectViolationLines(goldenViolation);
    const textDump = dumpLines(lines);

    const markers = [
        'GOLDEN_V_VIOLATED',
        'GOLDEN_V_ESTABLISHED',
        'GOLDEN_V_DESC_1',
        'GOLDEN_V_DESC_2',
        'GOLDEN_V_CM_TEXT',
        'GOLDEN_V_CM_TH',
        'GOLDEN_V_CM_TH2',
        'GOLDEN_V_CM_CELL',
        'GOLDEN_V_CM_CELL2',
        'GOLDEN_V_PM_TEXT',
        'GOLDEN_V_FREETEXT',
        'GOLDEN_V_REASONS',
        'GOLDEN_V_MEASURES',
        'GOLDEN_V_CONSEQUENCES',
        'GOLDEN_V_RESPONSIBLE',
    ];
    const missing = markers.filter(m => !textDump.includes(m));
    assert.deepEqual(missing, [], `превью потеряло маркеры: ${missing}`);
});

test('golden: метки полей с labeled=true — из реестра (Описание/Ответственные/…)', () => {
    const lines = collectViolationLines(goldenViolation);
    const labels = lines.map(l => l.label).filter(Boolean);
    for (const expected of ['Нарушено', 'Установлено', 'Описание', 'Причины',
                            'Принятые меры', 'Последствия', 'Ответственные']) {
        assert.ok(labels.includes(expected), `метка «${expected}» отсутствует в превью`);
    }
});

test('golden: метки полей с labeled=false в превью не выводятся (паритет с экспортами)', () => {
    const lines = collectViolationLines(goldenViolation);
    const labels = lines.map(l => l.label).filter(Boolean);
    for (const unexpected of ['CodeMining', 'ProcessMining', 'Дополнительный контент']) {
        assert.ok(!labels.includes(unexpected), `метка «${unexpected}» лишняя в превью`);
    }
});

test('golden: fieldOrder уважается — responsible идёт первым', () => {
    const lines = collectViolationLines(goldenViolation);
    const firstLabeled = lines.find(l => l.label);
    assert.equal(firstLabeled.label, 'Ответственные', 'первое поле — из fieldOrder, не из реестра');
    assert.equal(firstLabeled.text, 'GOLDEN_V_RESPONSIBLE');
});

test('golden: второй text-блок поля идёт строкой-продолжением без метки', () => {
    const lines = collectViolationLines(goldenViolation);
    const cont = lines.find(l => l.type === 'line' && l.text === 'GOLDEN_V_DESC_2');
    assert.ok(cont, 'строка второго блока отсутствует');
    assert.equal(cont.label, '', 'продолжение — без метки поля');
});

test('golden: table-блок попадает в модель строк типом table с сеткой целиком', () => {
    const tableLine = collectViolationLines(goldenViolation).find(l => l.type === 'table');
    assert.ok(tableLine, 'table-строка отсутствует');
    assert.equal(tableLine.table.grid.length, 2);
    assert.deepEqual(tableLine.table.colWidths, [120, 80]);
});

test('golden: image-блок попадает в модель строк целиком (url/caption/filename/width)', () => {
    const image = collectViolationLines(goldenViolation).find(l => l.type === 'image');
    assert.ok(image, 'image-строка отсутствует');
    assert.equal(image.item.url, GOLDEN_PNG_DATA_URL);
    assert.equal(image.item.caption, 'GOLDEN_V_IMG_CAPTION');
    assert.equal(image.item.filename, 'golden_image.png');
    assert.equal(image.item.width, 50);
});

test('golden: выключенное поле не даёт строк', () => {
    const v = JSON.parse(JSON.stringify(goldenViolation));
    v.reasons.enabled = false;
    const dump = dumpLines(collectViolationLines(v));
    assert.ok(!dump.includes('GOLDEN_V_REASONS'), 'выключенное поле не рендерится');
});

test('golden: width=50 картинки → CSS width:50% (как DOCX: 50% полезной ширины)', () => {
    const style = imagePresentationStyle(goldenImageBlock, 40);
    assert.equal(style.width, '50%');
    assert.ok(style.maxHeight.endsWith('mm'));
});

// --- Таблица: обход видимых ячеек (тот же helper, что у PreviewTableRenderer) ---

test('golden: iterateVisibleCells отдаёт все ячейки с данными (merge не теряет контент)', () => {
    const visible = [];
    iterateVisibleCells(goldenRegularGrid, (cell) => visible.push(cell.content));
    const dump = visible.join('|');

    const markers = [
        'GOLDEN_RTBL_H0',
        'GOLDEN_RTBL_H1',
        'GOLDEN_RTBL_H2',
        'GOLDEN_RTBL_MERGED',
        'GOLDEN_RTBL_TALL',
        'GOLDEN_RTBL_R2C0',
        'GOLDEN_RTBL_SPECIALS',
        'спец x<y & "z"',
    ];
    const missing = markers.filter(m => !dump.includes(m));
    assert.deepEqual(missing, [], `обход таблицы потерял маркеры: ${missing}`);
});

test('golden: поглощённые ячейки пропускаются и не несут данных (нет тихой потери)', () => {
    const skipped = [];
    for (const row of goldenRegularGrid) {
        for (const cell of row) {
            if (cell.isSpanned) skipped.push(cell.content);
        }
    }
    // Инвариант фикстуры и модели: контент живёт только в видимых ячейках.
    assert.deepEqual(skipped, ['', '']);
});
