/**
 * Copy-paste узлов/поддеревьев между актами и внутри акта (§7).
 *
 * Чистое ядро:
 *  - serializeSubtree: поддерево + записи словарей всех листьев (deep-копии);
 *  - regenerateIds: регенерация id узлов/контента + remap ссылок и ключей словарей;
 *  - filterPinnedFromSubtree: pinned-таблицы (metrics/risk) отброшены (КП-3);
 *  - resetInvoices: invoice-привязки сброшены (КП-4);
 *  - collectImageBlocks / rehostSubtreeImages: перенос картинок в целевой акт (КП-5).
 *
 * Оркестрация (через AppState + официальные мутаторы):
 *  - copyNode/pasteInto round-trip: новый узел с новыми id, ссылки целы;
 *  - КП-3: pinned-дети пропущены, protected/pinned-корень не копируется;
 *  - КП-4: invoice не переносится;
 *  - КП-5: картинки перезаливаются в целевой акт (внутри своего акта — нет);
 *  - КП-6: вставка под лист запрещена, глубина > maxDepth отклонена;
 *  - read-only: вставка запрещена, копирование разрешено.
 *
 * Реальные модули (стабы браузерных глобалов — _browser-stub.mjs, импорт ПЕРВЫМ).
 * Поверх no-op localStorage из stub'а ставим in-memory реализацию (буфер реально
 * читается/пишется).
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AppState } from '../../static/js/constructor/state/state-core.js';
import '../../static/js/constructor/state/state-tree.js';
import '../../static/js/constructor/state/state-content.js';
import { MetricsRiskCoordinator } from '../../static/js/constructor/state/metrics-risk-coordinator.js';
import {
    NodeClipboard,
    CLIPBOARD_STORAGE_KEY,
    CLIPBOARD_FORMAT_VERSION,
    serializeSubtree,
    regenerateIds,
    filterPinnedFromSubtree,
    resetInvoices,
    collectImageBlocks,
    rehostSubtreeImages,
} from '../../static/js/constructor/clipboard/node-clipboard.js';
import {
    getStructureLimits,
    resetImageLimitsForTests,
} from '../../static/js/constructor/violation/violation-image-validator.js';
import { BLOCK_TYPES } from '../../static/js/constructor/violation/violation-block-types.js';
import { TreeUtils } from '../../static/js/constructor/tree/tree-utils.js';
import { AppConfig } from '../../static/js/shared/app-config.js';
import { Notifications } from '../../static/js/shared/notifications.js';

// ── In-memory localStorage поверх no-op stub'а ─────────────────────────────────
const _store = new Map();
globalThis.localStorage = {
    getItem: (k) => (_store.has(k) ? _store.get(k) : null),
    setItem: (k, v) => { _store.set(k, String(v)); },
    removeItem: (k) => { _store.delete(k); },
};

// ── Шпионы Notifications ───────────────────────────────────────────────────────
const notified = { error: [], info: [], success: [], warning: [] };
const originalNotifications = {
    error: Notifications.error,
    info: Notifications.info,
    success: Notifications.success,
    warning: Notifications.warning,
};

beforeEach(() => {
    _store.clear();
    for (const key of Object.keys(notified)) {
        notified[key].length = 0;
        Notifications[key] = (msg) => { notified[key].push(msg); };
    }
    AppState.treeData = null;
    AppState.tables = {};
    AppState.textBlocks = {};
    AppState.violations = {};
    AppState.selectedNode = null;
    AppState._rebuildNodeIndex();
    AppConfig.readOnlyMode.isReadOnly = false;
});

afterEach(() => {
    Object.assign(Notifications, originalNotifications);
    AppConfig.readOnlyMode.isReadOnly = false;
    resetImageLimitsForTests();
});

// ── Хелперы ────────────────────────────────────────────────────────────────────
function addItem(parentId, label = 'Пункт') {
    const res = AppState.addNode(parentId, label, true);
    assert.ok(res.valid, `addNode(${parentId}): ${res.message}`);
    return AppState.findNodeById(parentId).children.at(-1);
}

/** Собирает множество всех node.id в поддереве. */
function collectIds(node, acc = new Set()) {
    acc.add(node.id);
    (node.children || []).forEach(c => collectIds(c, acc));
    return acc;
}

// ── Чистое ядро: serializeSubtree ──────────────────────────────────────────────

test('serializeSubtree: payload содержит версию, узел и записи словарей листьев', () => {
    AppState.initializeTree(true);
    const item = addItem('4', 'Пункт');
    assert.ok(AppState.addTableToNode(item.id).valid);
    assert.ok(AppState.addTextBlockToNode(item.id).valid);
    assert.ok(AppState.addViolationToNode(item.id).valid);

    const rawDicts = {
        tables: AppState.tables,
        textBlocks: AppState.textBlocks,
        violations: AppState.violations,
    };
    const payload = serializeSubtree(item, rawDicts, 42);

    assert.equal(payload.version, CLIPBOARD_FORMAT_VERSION);
    assert.equal(payload.sourceActId, 42);
    assert.equal(payload.node.id, item.id);
    assert.equal(Object.keys(payload.dicts.tables).length, 1);
    assert.equal(Object.keys(payload.dicts.textBlocks).length, 1);
    assert.equal(Object.keys(payload.dicts.violations).length, 1);

    // Deep-копия: мутация payload не трогает живой словарь.
    const tableId = Object.keys(payload.dicts.tables)[0];
    payload.dicts.tables[tableId].grid = null;
    assert.notEqual(AppState.tables[tableId].grid, null);
});

// ── Чистое ядро: regenerateIds ─────────────────────────────────────────────────

test('regenerateIds: все id новые, ссылки и ключи словарей переписаны', () => {
    const payload = {
        node: {
            id: 'old_root', type: 'item', children: [
                { id: 'old_tbl', type: 'table', tableId: 'T1', children: [] },
                { id: 'old_txt', type: 'textblock', textBlockId: 'B1', children: [] },
            ],
        },
        dicts: {
            tables: { T1: { id: 'T1', nodeId: 'old_tbl', grid: [[{ content: 'x' }]] } },
            textBlocks: { B1: { id: 'B1', nodeId: 'old_txt', content: 'hi' } },
        },
    };

    let counter = 0;
    const out = regenerateIds(payload, {
        genNodeId: () => `n${++counter}`,
        genContentId: (type) => `${type}_${++counter}`,
    });

    // id узлов — новые.
    const ids = collectIds(out.node);
    assert.ok(!ids.has('old_root') && !ids.has('old_tbl') && !ids.has('old_txt'));

    // Ссылки на словари переписаны и совпадают с ключами новых словарей.
    const tblNode = out.node.children.find(c => c.type === 'table');
    const txtNode = out.node.children.find(c => c.type === 'textblock');
    assert.notEqual(tblNode.tableId, 'T1');
    assert.notEqual(txtNode.textBlockId, 'B1');
    assert.ok(out.dicts.tables[tblNode.tableId], 'запись таблицы под новым id');
    assert.ok(out.dicts.textBlocks[txtNode.textBlockId], 'запись текстблока под новым id');
    assert.equal(out.dicts.tables[tblNode.tableId].nodeId, tblNode.id, 'nodeId записи = id узла');
    assert.equal(out.dicts.tables[tblNode.tableId].id, tblNode.tableId, 'entry.id = новый contentId');

    // Старых ключей в словарях нет.
    assert.equal(out.dicts.tables.T1, undefined);
    assert.equal(out.dicts.textBlocks.B1, undefined);

    // Вход не мутирован.
    assert.equal(payload.node.id, 'old_root');
    assert.ok(payload.dicts.tables.T1);
});

test('regenerateIds: блоки ВСЕХ полей нарушения получают НОВЫЕ id (#22, блочная модель)', () => {
    const payload = {
        node: {
            id: 'old_root', type: 'item', children: [
                { id: 'old_v', type: 'violation', violationId: 'V1', children: [] },
            ],
        },
        dicts: {
            violations: {
                V1: {
                    id: 'V1', nodeId: 'old_v',
                    violated: {
                        enabled: true,
                        blocks: [{ id: 'text_1', type: 'text', content: 'A' }],
                    },
                    codeMining: {
                        enabled: true,
                        blocks: [
                            { id: 'table_1', type: 'table', table: { grid: [], colWidths: [] } },
                            { id: 'image_1', type: 'image', url: '', caption: '', filename: 'a.png', width: 0 },
                        ],
                    },
                },
            },
        },
    };

    let counter = 0;
    const out = regenerateIds(payload, {
        genNodeId: () => `n${++counter}`,
        genContentId: (type) => `${type}_${++counter}`,
    });

    const vNode = out.node.children[0];
    const newEntry = out.dicts.violations[vNode.violationId];

    const violatedIds = newEntry.violated.blocks.map(b => b.id);
    const cmIds = newEntry.codeMining.blocks.map(b => b.id);
    assert.ok(!violatedIds.includes('text_1'), 'id блока violated заменён');
    assert.ok(!cmIds.includes('table_1') && !cmIds.includes('image_1'), 'id блоков codeMining заменены');
    assert.equal(new Set([...violatedIds, ...cmIds]).size, 3, 'все новые id уникальны');
    // Регенерируется только id — содержимое блока сохранено.
    assert.equal(newEntry.violated.blocks[0].content, 'A');
    assert.equal(newEntry.codeMining.blocks[1].filename, 'a.png');

    // Исходный payload (буфер) не мутирован.
    assert.equal(payload.dicts.violations.V1.violated.blocks[0].id, 'text_1');
    assert.equal(payload.dicts.violations.V1.codeMining.blocks[0].id, 'table_1');
});

test('regenerateIds: id блоков уникальны даже при одинаковом Date.now() внутри цикла (#22)', () => {
    const payload = {
        node: { id: 'old_v', type: 'violation', violationId: 'V1', children: [] },
        dicts: {
            violations: {
                V1: {
                    id: 'V1', nodeId: 'old_v',
                    additionalContent: {
                        enabled: true,
                        blocks: Array.from({ length: 20 }, (_, i) => (
                            { id: `text_${i}`, type: 'text', content: `c${i}` }
                        )),
                    },
                },
            },
        },
    };

    const out = regenerateIds(payload, { genNodeId: () => 'n1', genContentId: (type) => `${type}_x` });
    const newEntry = out.dicts.violations[out.node.violationId];
    const ids = newEntry.additionalContent.blocks.map(b => b.id);
    assert.equal(new Set(ids).size, ids.length, 'генератор с индексом — все id уникальны');
});

test('regenerateIds: нарушение с пустыми/отсутствующими контейнерами не падает', () => {
    const payload = {
        node: { id: 'old_v', type: 'violation', violationId: 'V1', children: [] },
        dicts: {
            violations: {
                V1: {
                    id: 'V1', nodeId: 'old_v',
                    violated: { enabled: true, blocks: [] },
                    // остальные поля отсутствуют целиком (повреждённый буфер)
                },
            },
        },
    };

    const out = regenerateIds(payload, { genNodeId: () => 'n1', genContentId: (type) => `${type}_x` });
    const newEntry = out.dicts.violations[out.node.violationId];
    assert.deepEqual(newEntry.violated, { enabled: true, blocks: [] });
    assert.equal(newEntry.reasons, undefined);
});

// ── Чистое ядро: filterPinnedFromSubtree (КП-3) ────────────────────────────────

test('filterPinnedFromSubtree: pinned-дети (metrics/risk) отброшены', () => {
    const node = {
        id: 'p', type: 'item', children: [
            { id: 'risk', type: 'table', kind: 'regularRisk', children: [] },
            { id: 'metrics', type: 'table', kind: 'metrics', children: [] },
            { id: 'tbl', type: 'table', children: [] },
            { id: 'sub', type: 'item', children: [
                { id: 'risk2', type: 'table', kind: 'operationalRisk', children: [] },
                { id: 'txt', type: 'textblock', children: [] },
            ] },
        ],
    };
    const { node: out, skippedPinned } = filterPinnedFromSubtree(node);

    assert.ok(skippedPinned);
    const ids = collectIds(out);
    assert.ok(!ids.has('risk') && !ids.has('metrics') && !ids.has('risk2'), 'pinned отброшены');
    assert.ok(ids.has('tbl') && ids.has('sub') && ids.has('txt'), 'разрешённые сохранены');
});

test('filterPinnedFromSubtree: без pinned skippedPinned=false', () => {
    const node = { id: 'p', type: 'item', children: [{ id: 'tbl', type: 'table', children: [] }] };
    const { skippedPinned } = filterPinnedFromSubtree(node);
    assert.equal(skippedPinned, false);
});

test('filterPinnedFromSubtree: keepRisk сохраняет риски, отбрасывает metrics', () => {
    const subtree = {
        id: 'p', type: 'item', children: [
            { id: 'm', type: 'table', kind: 'metrics', children: [] },
            { id: 'r', type: 'table', kind: 'regularRisk', children: [] },
            { id: 'c', type: 'item', children: [] },
        ],
    };
    const out = filterPinnedFromSubtree(subtree, { keepRisk: true });
    const ids = out.node.children.map(c => c.id);
    assert.deepEqual(ids.sort(), ['c', 'r']);
    assert.equal(out.skippedPinned, true); // metrics отброшен
});

test('filterPinnedFromSubtree: без опций отбрасывает все pinned (как раньше)', () => {
    const subtree = {
        id: 'p', type: 'item', children: [
            { id: 'r', type: 'table', kind: 'taxRisk', children: [] },
            { id: 'c', type: 'item', children: [] },
        ],
    };
    const out = filterPinnedFromSubtree(subtree);
    assert.deepEqual(out.node.children.map(c => c.id), ['c']);
});

// ── Чистое ядро: resetInvoices (КП-4) ──────────────────────────────────────────

test('resetInvoices: invoice удалён во всём поддереве', () => {
    const node = {
        id: 'p', invoice: { num: 1 }, children: [
            { id: 'c', invoice: { num: 2 }, children: [] },
        ],
    };
    resetInvoices(node);
    assert.equal(node.invoice, undefined);
    assert.equal(node.children[0].invoice, undefined);
});

// ── Чистое ядро: перенос картинок фрагмента (КП-5) ────────────────────────────

test('collectImageBlocks: только image-блоки с непустым image_id, из ВСЕХ полей', () => {
    const violations = {
        v1: {
            additionalContent: { blocks: [
                { id: 'b1', type: BLOCK_TYPES.IMAGE, image_id: 'i1' },
                { id: 'b2', type: 'text', content: 'нет картинки' },
                { id: 'b3', type: BLOCK_TYPES.IMAGE, image_id: '' }, // черновик
            ] },
            codeMining: { blocks: [{ id: 'b4', type: BLOCK_TYPES.IMAGE, image_id: 'i2' }] },
        },
        v2: {},
    };
    // Порядок обхода — по реестру полей (VIOLATION_FIELD_KEYS), а не по
    // порядку ключей объекта: сравниваем состав.
    assert.deepEqual(collectImageBlocks(violations).map(b => b.id).sort(), ['b1', 'b4']);
    assert.deepEqual(collectImageBlocks({}), []);
    assert.deepEqual(collectImageBlocks(null), []);
});

test('rehostSubtreeImages: байты качаются из источника, грузятся в цель, id подменяется', async () => {
    const violations = {
        v1: { additionalContent: { blocks: [
            { id: 'b1', type: BLOCK_TYPES.IMAGE, image_id: 'i1', filename: 'a.png' },
            { id: 'b2', type: BLOCK_TYPES.IMAGE, image_id: 'i2', filename: 'b.png' },
        ] } },
    };
    const fetched = [];
    const uploaded = [];
    const moved = await rehostSubtreeImages(violations, 1, 2, {
        fetchBlob: async (act, id) => { fetched.push([act, id]); return `bytes:${id}`; },
        upload: async (act, blob, name) => {
            uploaded.push([act, blob, name]);
            return { image_id: `new-${blob}` };
        },
    });

    assert.equal(moved, 2);
    assert.deepEqual(fetched, [[1, 'i1'], [1, 'i2']], 'качаем из акта-источника');
    assert.deepEqual(uploaded, [[2, 'bytes:i1', 'a.png'], [2, 'bytes:i2', 'b.png']]);
    assert.deepEqual(
        violations.v1.additionalContent.blocks.map(b => b.image_id),
        ['new-bytes:i1', 'new-bytes:i2'],
    );
});

test('rehostSubtreeImages: повторный image_id гоняется по сети ОДИН раз', async () => {
    const violations = {
        v1: { additionalContent: { blocks: [
            { id: 'b1', type: BLOCK_TYPES.IMAGE, image_id: 'same', filename: 'a.png' },
            { id: 'b2', type: BLOCK_TYPES.IMAGE, image_id: 'same', filename: 'a.png' },
        ] } },
    };
    let calls = 0;
    await rehostSubtreeImages(violations, 1, 2, {
        fetchBlob: async () => { calls += 1; return 'bytes'; },
        upload: async () => ({ image_id: 'new' }),
    });

    assert.equal(calls, 1);
    assert.deepEqual(
        violations.v1.additionalContent.blocks.map(b => b.image_id), ['new', 'new']);
});

test('rehostSubtreeImages: отказ сервера пробрасывается наверх (вставка не состоится)', async () => {
    const violations = {
        v1: { additionalContent: { blocks: [
            { id: 'b1', type: BLOCK_TYPES.IMAGE, image_id: 'i1', filename: 'a.png' },
        ] } },
    };
    await assert.rejects(
        () => rehostSubtreeImages(violations, 1, 2, {
            fetchBlob: async () => 'bytes',
            upload: async () => { throw new Error('Превышен суммарный размер картинок акта'); },
        }),
        /Превышен суммарный размер/,
    );
});

// ── Оркестрация: copyNode / pasteInto round-trip ───────────────────────────────

test('round-trip: копирование и вставка поддерева даёт новые id, ссылки целы', async () => {
    AppState.initializeTree(true);
    const src = addItem('4', 'Источник');
    assert.ok(AppState.addTableToNode(src.id).valid);
    assert.ok(AppState.addTextBlockToNode(src.id).valid);
    AppState.generateNumbering();

    const srcIds = collectIds(AppState.findNodeById(src.id));
    const tablesBefore = Object.keys(AppState.tables).length;

    assert.ok(NodeClipboard.copyNode(src.id), 'copyNode');
    assert.equal(notified.success.filter(m => m === 'Скопировано').length, 1);

    // Вставляем в другой узел (раздел 4, другой пункт).
    const dest = addItem('4', 'Назначение');
    AppState.generateNumbering();

    assert.ok(await NodeClipboard.pasteInto(dest.id), 'pasteInto');

    const pasted = AppState.findNodeById(dest.id).children.at(-1);
    const pastedIds = collectIds(pasted);
    // Никаких пересечений id с источником.
    for (const id of pastedIds) assert.ok(!srcIds.has(id), `id ${id} не должен совпадать с источником`);

    // Записи словарей: добавились новые (таблица+текстблок), старые целы.
    assert.equal(Object.keys(AppState.tables).length, tablesBefore + 1);

    // Ссылки вставленных узлов указывают на существующие записи словарей.
    const pTable = pasted.children.find(c => c.type === 'table');
    const pText = pasted.children.find(c => c.type === 'textblock');
    assert.ok(AppState.tables[pTable.tableId], 'таблица вставленного узла в словаре');
    assert.ok(AppState.textBlocks[pText.textBlockId], 'текстблок вставленного узла в словаре');
    assert.equal(AppState.tables[pTable.tableId].nodeId, pTable.id);
});

test('copyNode пишет валидный payload в localStorage', () => {
    AppState.initializeTree(true);
    const src = addItem('4');
    assert.ok(NodeClipboard.copyNode(src.id));

    const raw = localStorage.getItem(CLIPBOARD_STORAGE_KEY);
    assert.ok(raw, 'буфер записан');
    const payload = JSON.parse(raw);
    assert.equal(payload.version, CLIPBOARD_FORMAT_VERSION);
    assert.equal(payload.node.id, src.id);
});

// ── КП-3: protected/pinned не копируются как корень ─────────────────────────────

test('КП-3: защищённую секцию (1-5) нельзя копировать', () => {
    AppState.initializeTree(true);
    assert.equal(NodeClipboard.copyNode('1'), false);
    assert.equal(notified.error.length, 1);
    assert.equal(localStorage.getItem(CLIPBOARD_STORAGE_KEY), null, 'буфер не записан');
});

test('КП-3: таблицу рисков (pinned) можно копировать как корень', () => {
    AppState.initializeTree(true);
    const n51 = addItem('5', 'Пункт 5.1');
    AppState.generateNumbering();
    assert.ok(AppState._createRegularRiskTable(n51.id).valid);
    const riskNode = n51.children.find(c => c.kind === 'regularRisk');

    assert.equal(NodeClipboard.copyNode(riskNode.id), true);
    assert.equal(notified.error.length, 0);
});

test('КП-3: pinned-дети поддерева пропускаются при вставке, юзер уведомлён', async () => {
    AppState.initializeTree(true);
    // Источник под §5 с риск-таблицей внутри.
    const n51 = addItem('5', 'Пункт 5.1');
    AppState.generateNumbering();
    assert.ok(AppState._createRegularRiskTable(n51.id).valid);
    AppState.generateNumbering();
    assert.ok(AppState.addTextBlockToNode(n51.id).valid);

    assert.ok(NodeClipboard.copyNode(n51.id), 'копируем 5.1 (не pinned-корень)');

    // Вставляем в раздел 4 (вне §5) — риск-таблица должна быть отброшена.
    const dest = addItem('4', 'Назначение');
    AppState.generateNumbering();
    assert.ok(await NodeClipboard.pasteInto(dest.id));

    const pasted = AppState.findNodeById(dest.id).children.at(-1);
    const hasRisk = (pasted.children || []).some(c => c.kind === 'regularRisk');
    assert.equal(hasRisk, false, 'риск-таблица отброшена');
    assert.ok((pasted.children || []).some(c => c.type === 'textblock'), 'текстблок сохранён');
    assert.equal(notified.warning.filter(m => /пропущен/i.test(m)).length, 1, 'уведомление о пропуске');
});

// ── КП-4: invoice сбрасывается ─────────────────────────────────────────────────

test('КП-4: invoice-привязка не переносится при вставке', async () => {
    AppState.initializeTree(true);
    const n51 = addItem('5', 'Пункт 5.1');
    AppState.generateNumbering();
    AppState.setNodeInvoice(n51.id, { invoiceNumber: 'INV-1' }, { changelog: false });
    assert.ok(AppState.findNodeById(n51.id).invoice, 'invoice выставлен');

    assert.ok(NodeClipboard.copyNode(n51.id));
    const dest = addItem('4', 'Назначение');
    AppState.generateNumbering();
    assert.ok(await NodeClipboard.pasteInto(dest.id));

    const pasted = AppState.findNodeById(dest.id).children.at(-1);
    assert.equal(pasted.invoice, undefined, 'invoice сброшен');
});

// ── КП-5: перенос картинок в целевой акт ──────────────────────────────────────

/** Стенд сети для перезаливки картинок: GET байтов + POST в целевой акт. */
function installImageNetworkStub({ failUpload = false } = {}) {
    const calls = { get: [], post: [] };
    globalThis.location = { origin: 'http://test', pathname: '/' };
    AppConfig.api._resetCache();
    globalThis.fetch = async (url, opts) => {
        if (!opts || opts.method !== 'POST') {
            calls.get.push(url);
            return { ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3])]) };
        }
        calls.post.push(url);
        if (failUpload) {
            return {
                ok: false,
                status: 409,
                json: async () => ({ detail: 'Акт заблокирован другим пользователем' }),
            };
        }
        return { ok: true, json: async () => ({ image_id: 'target-image' }) };
    };
    return calls;
}

/** Узел с нарушением, несущим одну картинку-ссылку. */
function addNodeWithImage(parentId, label) {
    const src = addItem(parentId, label);
    assert.ok(AppState.addViolationToNode(src.id).valid);
    const violationId = src.children.find(c => c.violationId)?.violationId;
    AppState.violations[violationId].additionalContent = {
        enabled: true,
        blocks: [{
            id: 'img1', type: BLOCK_TYPES.IMAGE, image_id: 'source-image',
            caption: '', filename: 'shot.png', width: 0,
        }],
    };
    return src;
}

/** image_id первой картинки вставленного узла. */
function pastedImageId(destId) {
    const pasted = AppState.findNodeById(destId).children.at(-1);
    const vid = pasted.violationId
        || pasted.children?.find(c => c.violationId)?.violationId;
    return AppState.violations[vid].additionalContent.blocks[0].image_id;
}

test('КП-5: вставка в ДРУГОЙ акт перезаливает картинку и подменяет image_id', async () => {
    AppState.initializeTree(true);
    window.currentActId = 1;
    const src = addNodeWithImage('4', 'С картинкой');
    assert.ok(NodeClipboard.copyNode(src.id));

    // Целевой акт — другой: картинка источника там недоступна.
    window.currentActId = 2;
    const calls = installImageNetworkStub();
    const dest = addItem('4', 'Назначение');
    AppState.generateNumbering();

    assert.equal(await NodeClipboard.pasteInto(dest.id), true);
    assert.deepEqual(calls.get, ['http://test/api/v1/acts/1/images/source-image']);
    assert.deepEqual(calls.post, ['http://test/api/v1/acts/2/images']);
    assert.equal(pastedImageId(dest.id), 'target-image', 'блок ссылается на картинку ЦЕЛЕВОГО акта');
});

test('КП-5: вставка внутри СВОЕГО акта в сеть не ходит — ссылка остаётся прежней', async () => {
    AppState.initializeTree(true);
    window.currentActId = 1;
    const src = addNodeWithImage('4', 'С картинкой');
    assert.ok(NodeClipboard.copyNode(src.id));

    const calls = installImageNetworkStub();
    const dest = addItem('4', 'Назначение');
    AppState.generateNumbering();

    assert.equal(await NodeClipboard.pasteInto(dest.id), true);
    assert.deepEqual(calls.get, [], 'байты не качаются');
    assert.deepEqual(calls.post, [], 'и не заливаются заново');
    assert.equal(pastedImageId(dest.id), 'source-image');
});

test('КП-5: отказ переноса картинок отменяет вставку целиком', async () => {
    AppState.initializeTree(true);
    window.currentActId = 1;
    const src = addNodeWithImage('4', 'С картинкой');
    assert.ok(NodeClipboard.copyNode(src.id));

    window.currentActId = 2;
    installImageNetworkStub({ failUpload: true });
    const dest = addItem('4', 'Назначение');
    AppState.generateNumbering();

    const childrenBefore = AppState.findNodeById(dest.id).children?.length || 0;
    assert.equal(await NodeClipboard.pasteInto(dest.id), false, 'вставка отклонена');
    assert.equal(
        AppState.findNodeById(dest.id).children?.length || 0, childrenBefore,
        'ничего не вставлено',
    );
    assert.equal(
        notified.error.filter(m => /заблокирован/i.test(m)).length, 1,
        'показан текст отказа сервера',
    );
});

// ── КП-6: штатная валидация ────────────────────────────────────────────────────

test('КП-6: вставка внутрь листового блока (таблицы) запрещена', async () => {
    AppState.initializeTree(true);
    const src = addItem('4');
    assert.ok(NodeClipboard.copyNode(src.id));

    const holder = addItem('4', 'Держатель');
    assert.ok(AppState.addTableToNode(holder.id).valid);
    const tableNode = holder.children.find(c => c.type === 'table');

    assert.equal(await NodeClipboard.pasteInto(tableNode.id), false);
    assert.equal(notified.error.length, 1);
});

test('КП-6: вставка с превышением maxDepth отклонена', async () => {
    AppState.initializeTree(true);
    // Источник глубиной 3 уровня (item→item→item).
    const a = addItem('4', 'A');
    const b = addItem(a.id, 'B');
    addItem(b.id, 'C');
    AppState.generateNumbering();
    assert.ok(NodeClipboard.copyNode(a.id));

    // Назначение на глубине, при которой 3-уровневое поддерево превысит maxDepth (4).
    // 4 (depth1) → d2 → d3 ; вставка a сюда даст 4+ уровней.
    const d2 = addItem('4', 'd2');
    const d3 = addItem(d2.id, 'd3');
    AppState.generateNumbering();

    assert.equal(await NodeClipboard.pasteInto(d3.id), false);
    assert.equal(notified.error.filter(m => /вложенност/i.test(m)).length, 1);
});

// ── PERSIST-2: лимит текстблоков-на-узел при вставке (insertNodeAt) ────────────

test('paste: узел-текстблок отклоняется, если цель уже на лимите текстблоков', async () => {
    AppState.initializeTree(true);
    getStructureLimits().textBlocksPerNode = 1;

    const src = addItem('4', 'Источник');
    assert.ok(AppState.addTextBlockToNode(src.id).valid);
    const srcTextBlock = src.children.find(c => c.type === 'textblock');
    assert.ok(NodeClipboard.copyNode(srcTextBlock.id), 'копируем одиночный текстблок');

    const dest = addItem('4', 'Назначение на лимите');
    assert.ok(AppState.addTextBlockToNode(dest.id).valid); // уже 1 текстблок = лимит

    const childrenBefore = AppState.findNodeById(dest.id).children.length;
    assert.equal(await NodeClipboard.pasteInto(dest.id), false, 'вставка отклонена — цель на лимите');
    assert.equal(AppState.findNodeById(dest.id).children.length, childrenBefore, 'ничего не вставлено');
    assert.equal(notified.error.filter(m => /текстовых блоков/i.test(m)).length, 1, 'тост про лимит текстблоков');
});

test('paste: поддерево нарушает ТЕКУЩИЙ лимит текстблоков (лимит снижен после копирования) — отказ, дерево не меняется', async () => {
    AppState.initializeTree(true);
    getStructureLimits().textBlocksPerNode = 5;

    const src = addItem('4', 'Источник с 3 текстблоками');
    assert.ok(AppState.addTextBlockToNode(src.id).valid);
    assert.ok(AppState.addTextBlockToNode(src.id).valid);
    assert.ok(AppState.addTextBlockToNode(src.id).valid);
    assert.ok(NodeClipboard.copyNode(src.id));

    // Лимит снижается между копированием и вставкой.
    getStructureLimits().textBlocksPerNode = 2;

    const dest = addItem('4', 'Назначение');
    const childrenBefore = AppState.findNodeById(dest.id).children?.length || 0;
    assert.equal(await NodeClipboard.pasteInto(dest.id), false, 'вставка отклонена — поддерево нарушает текущий лимит');
    assert.equal(AppState.findNodeById(dest.id).children?.length || 0, childrenBefore, 'ничего не вставлено');
});

test('paste: текстблок в цель НЕ на лимите — проходит как раньше', async () => {
    AppState.initializeTree(true);
    getStructureLimits().textBlocksPerNode = 2;

    const src = addItem('4', 'Источник');
    assert.ok(AppState.addTextBlockToNode(src.id).valid);
    const srcTextBlock = src.children.find(c => c.type === 'textblock');
    assert.ok(NodeClipboard.copyNode(srcTextBlock.id));

    const dest = addItem('4', 'Назначение');
    assert.equal(await NodeClipboard.pasteInto(dest.id), true, 'вставка проходит — цель не на лимите');
});

// ── read-only ──────────────────────────────────────────────────────────────────

test('read-only: вставка запрещена, копирование разрешено', async () => {
    AppState.initializeTree(true);
    // Узлы готовим ДО включения read-only (структурные мутации в нём запрещены).
    const src = addItem('4');
    const dest = addItem('4', 'Назначение');

    AppConfig.readOnlyMode.isReadOnly = true;

    // Копирование разрешено даже в read-only.
    assert.ok(NodeClipboard.copyNode(src.id), 'copyNode в read-only');

    assert.equal(await NodeClipboard.pasteInto(dest.id), false, 'pasteInto в read-only');
    assert.equal(notified.warning.length >= 1, true);
});

// ── readClipboard: устаревший/битый буфер ──────────────────────────────────────

test('readClipboard: версия не та → null', () => {
    localStorage.setItem(CLIPBOARD_STORAGE_KEY, JSON.stringify({ version: 999, node: {} }));
    assert.equal(NodeClipboard.readClipboard(), null);
    assert.equal(NodeClipboard.canPaste(), false);
});

test('readClipboard: битый JSON → null', () => {
    localStorage.setItem(CLIPBOARD_STORAGE_KEY, '{не json');
    assert.equal(NodeClipboard.readClipboard(), null);
});

test('pasteInto: пустой буфер → info, ничего не вставлено', async () => {
    AppState.initializeTree(true);
    const dest = addItem('4');
    assert.equal(await NodeClipboard.pasteInto(dest.id), false);
    assert.equal(notified.info.length, 1);
});

// ── refreshMenuState: доступность пунктов меню ─────────────────────────────────

/** Фейковый пункт меню с рабочим classList.toggle. */
function makeMenuItem() {
    const classes = new Set();
    return {
        classList: {
            toggle: (c, on) => { on ? classes.add(c) : classes.delete(c); },
            contains: (c) => classes.has(c),
        },
        _disabled: () => classes.has('disabled'),
    };
}

test('refreshMenuState: «Копировать» отключено для protected/pinned, «Вставить» — для пустого буфера/листа', () => {
    AppState.initializeTree(true);
    const copyItem = makeMenuItem();
    const pasteItem = makeMenuItem();
    NodeClipboard._copyMenuItem = copyItem;
    NodeClipboard._pasteMenuItem = pasteItem;

    // Обычный item, буфер пуст: копировать можно, вставить — нет.
    const item = addItem('4', 'Обычный');
    AppState.generateNumbering();
    NodeClipboard.refreshMenuState(AppState.findNodeById(item.id));
    assert.equal(copyItem._disabled(), false, 'копировать доступно для обычного узла');
    assert.equal(pasteItem._disabled(), true, 'вставить недоступно при пустом буфере');

    // Protected-секция: копировать нельзя.
    NodeClipboard.refreshMenuState(AppState.findNodeById('1'));
    assert.equal(copyItem._disabled(), true, 'копировать недоступно для защищённой секции');

    // После копирования буфер не пуст → вставить доступно для item.
    assert.ok(NodeClipboard.copyNode(item.id));
    NodeClipboard.refreshMenuState(AppState.findNodeById(item.id));
    assert.equal(pasteItem._disabled(), false, 'вставить доступно при непустом буфере');

    // Лист (таблица): вставить нельзя.
    assert.ok(AppState.addTableToNode(item.id).valid);
    const tableNode = AppState.findNodeById(item.id).children.find(c => c.type === 'table');
    NodeClipboard.refreshMenuState(tableNode);
    assert.equal(pasteItem._disabled(), true, 'вставить недоступно для листового блока');

    NodeClipboard._copyMenuItem = null;
    NodeClipboard._pasteMenuItem = null;
});

test('copyNode: одиночную таблицу рисков копировать можно', () => {
    AppState.initializeTree(true);
    AppState.addNode('5', 'Пункт', true);
    const p = AppState.findNodeById('5').children.at(-1);
    assert.ok(AppState._createRegularRiskTable(p.id).valid);
    AppState.generateNumbering();
    const riskNode = AppState.findNodeById(p.id).children.find(c => c.kind);
    assert.ok(riskNode, 'risk-узел не создан');
    assert.equal(NodeClipboard.copyNode(riskNode.id), true);
});

test('copyNode: сводную (metrics) таблицу копировать нельзя', () => {
    AppState.initializeTree(true);
    AppState.addNode('5', 'Пункт', true);
    const p = AppState.findNodeById('5').children.at(-1);
    AppState.addNode(p.id, 'Подпункт', true);
    const sub = AppState.findNodeById(p.id).children.at(-1);
    assert.ok(AppState._createRegularRiskTable(sub.id).valid); // риск на 5.x.y → metrics на 5.x
    AppState.generateNumbering();
    assert.ok(MetricsRiskCoordinator.onRiskTableAdded(sub.id)); // авто-создаёт metrics на p
    const metricsNode = AppState.findNodeById(p.id).children.find(c => c.kind === 'metrics');
    assert.ok(metricsNode, 'metrics-узел не создан');
    assert.equal(NodeClipboard.copyNode(metricsNode.id), false);
});

// ── Task 9: вставка с рисками в §5 и без ──────────────────────────────────────

function makeRiskUnder5() {
    AppState.initializeTree(true);
    AppState.addNode('5', 'Пункт', true);
    const p = AppState.findNodeById('5').children.at(-1);
    assert.ok(AppState._createRegularRiskTable(p.id).valid);
    MetricsRiskCoordinator.onRiskTableAdded(p.id);
    AppState.generateNumbering();
    return p;
}

test('paste: таблица рисков сохраняется при вставке в пункт раздела 5', async () => {
    const p = makeRiskUnder5();
    const riskNode = AppState.findNodeById(p.id).children.find(c => c.kind);
    assert.ok(NodeClipboard.copyNode(riskNode.id));
    // второй пункт 5.2 — цель
    AppState.addNode('5', 'Пункт 2', true);
    const p2 = AppState.findNodeById('5').children.at(-1);
    assert.equal(await NodeClipboard.pasteInto(p2.id), true);
    assert.ok(AppState.findNodeById(p2.id).children.some(c => c.kind && c.kind.endsWith('Risk')));
});

test('paste: таблица рисков отбрасывается при вставке вне раздела 5', async () => {
    const p = makeRiskUnder5();
    const riskNode = AppState.findNodeById(p.id).children.find(c => c.kind);
    assert.ok(NodeClipboard.copyNode(riskNode.id));
    // цель — раздел 4 (вне §5): risk-корень заблокирован явной проверкой (не пункт §5)
    assert.equal(await NodeClipboard.pasteInto('4'), false);
    assert.equal(AppState.findNodeById('4').children.length, 0);
});

test('paste: вставка в §5 с конфликтом уровней рисков — отклоняется, дерево не меняется', async () => {
    AppState.initializeTree(true);
    // Источник: пункт с подпунктом, риск на уровне подпункта (5.x.y)
    AppState.addNode('5', 'Источник', true);
    const src = AppState.findNodeById('5').children.at(-1);
    AppState.addNode(src.id, 'Подпункт', true);
    const sub = AppState.findNodeById(src.id).children.at(-1);
    assert.ok(AppState._createRegularRiskTable(sub.id).valid);
    MetricsRiskCoordinator.onRiskTableAdded(sub.id);
    AppState.generateNumbering();
    assert.ok(NodeClipboard.copyNode(src.id)); // в буфере — поддерево с риском на уровне подпункта
    // Удаляем источник, чтобы в дереве не осталось подпунктовых рисков
    assert.ok(AppState.deleteNode(src.id));
    // Создаём риск на уровне ПУНКТА (5.1)
    AppState.addNode('5', 'Пункт', true);
    const p = AppState.findNodeById('5').children.at(-1);
    assert.ok(AppState._createRegularRiskTable(p.id).valid);
    MetricsRiskCoordinator.onRiskTableAdded(p.id);
    AppState.generateNumbering();
    // Вставка буфера (подпунктовый риск) в §5 при наличии пунктового риска → конфликт уровней → блок
    const before = AppState.findNodeById('5').children.length;
    assert.equal(await NodeClipboard.pasteInto('5'), false);
    assert.equal(AppState.findNodeById('5').children.length, before, 'дерево не изменилось');
});

test('paste: пункт с рисками в раздел 5 пересоздаёт сводную таблицу', async () => {
    const p = makeRiskUnder5(); // p содержит риск на уровне пункта 5.1
    assert.ok(NodeClipboard.copyNode(p.id));
    // вставляем как новый пункт в корень §5
    assert.equal(await NodeClipboard.pasteInto('5'), true);
    const node5 = AppState.findNodeById('5');
    assert.ok(node5.children.some(c => c.kind === 'mainMetrics'), 'общая сводная должна существовать');
});

test('paste: одиночный риск на уровень пункта при рисках на подпунктах — отклоняется', async () => {
    AppState.initializeTree(true);
    AppState.addNode('5', 'Пункт1', true);
    const p1 = AppState.findNodeById('5').children.at(-1);
    AppState.addNode(p1.id, 'Подпункт', true);
    const sub = AppState.findNodeById(p1.id).children.at(-1);
    assert.ok(AppState._createRegularRiskTable(sub.id).valid);
    MetricsRiskCoordinator.onRiskTableAdded(sub.id);
    AppState.generateNumbering();
    const risk = AppState.findNodeById(sub.id).children.find(c => c.kind && c.kind.endsWith('Risk'));
    assert.ok(NodeClipboard.copyNode(risk.id));
    AppState.addNode('5', 'Пункт2', true);
    const p2 = AppState.findNodeById('5').children.at(-1);
    AppState.generateNumbering();
    const before = AppState.findNodeById(p2.id).children.length;
    assert.equal(await NodeClipboard.pasteInto(p2.id), false);
    assert.equal(AppState.findNodeById(p2.id).children.length, before);
});

test('paste: второй риск того же типа на один пункт — отклоняется', async () => {
    AppState.initializeTree(true);
    AppState.addNode('5', 'Пункт', true);
    const p = AppState.findNodeById('5').children.at(-1);
    assert.ok(AppState._createRegularRiskTable(p.id).valid);
    MetricsRiskCoordinator.onRiskTableAdded(p.id);
    AppState.generateNumbering();
    const risk = AppState.findNodeById(p.id).children.find(c => c.kind && c.kind.endsWith('Risk'));
    assert.ok(NodeClipboard.copyNode(risk.id));
    const before = AppState.findNodeById(p.id).children.length;
    assert.equal(await NodeClipboard.pasteInto(p.id), false);
    assert.equal(AppState.findNodeById(p.id).children.length, before);
});

test('paste: одиночная таблица рисков встаёт в pinned-зону (вверху), а не в конец', async () => {
    AppState.initializeTree(true);
    // 5.1 — источник копирования риск-таблицы (риск на уровне пункта)
    AppState.addNode('5', 'Источник', true);
    const src = AppState.findNodeById('5').children.at(-1);
    assert.ok(AppState._createRegularRiskTable(src.id).valid);
    MetricsRiskCoordinator.onRiskTableAdded(src.id);
    AppState.generateNumbering();
    const risk = AppState.findNodeById(src.id).children.find(c => c.kind && c.kind.endsWith('Risk'));
    assert.ok(NodeClipboard.copyNode(risk.id));

    // 5.2 — цель с уже существующим текстблоком (не-pinned контент)
    AppState.addNode('5', 'Цель', true);
    const dest = AppState.findNodeById('5').children.at(-1);
    assert.ok(AppState.addTextBlockToNode(dest.id).valid);
    AppState.generateNumbering();

    assert.equal(await NodeClipboard.pasteInto(dest.id), true);
    const kids = AppState.findNodeById(dest.id).children;
    const riskIdx = kids.findIndex(c => c.kind && c.kind.endsWith('Risk'));
    const textIdx = kids.findIndex(c => c.type === 'textblock');
    assert.ok(riskIdx !== -1 && textIdx !== -1, 'и риск, и текстблок присутствуют');
    assert.ok(riskIdx < textIdx, 'таблица рисков должна быть выше текстблока (pinned-инвариант)');
});

test('paste: обычный подпункт в пункт 5.X при рисках на уровне пунктов — отклоняется', async () => {
    AppState.initializeTree(true);
    // 5.1 с риском на уровне пункта
    AppState.addNode('5', 'Пункт1', true);
    const p1 = AppState.findNodeById('5').children.at(-1);
    assert.ok(AppState._createRegularRiskTable(p1.id).valid);
    MetricsRiskCoordinator.onRiskTableAdded(p1.id);
    AppState.generateNumbering();

    // Копируем обычный (без рисков) пункт из раздела 4
    const plain = addItem('4', 'Обычный');
    AppState.generateNumbering();
    assert.ok(NodeClipboard.copyNode(plain.id));

    // Вставка обычного подпункта в 5.X запрещена (паритет с «Добавить подпункт»)
    const before = AppState.findNodeById(p1.id).children.length;
    assert.equal(await NodeClipboard.pasteInto(p1.id), false);
    assert.equal(AppState.findNodeById(p1.id).children.length, before, 'подпункт не добавлен');
    assert.equal(notified.error.filter(m => /подпункт/i.test(m)).length, 1);
});

test('paste: провал регенерации сводных таблиц откатывает вставку целиком', async () => {
    const p = makeRiskUnder5();
    const risk = AppState.findNodeById(p.id).children.find(c => c.kind);
    assert.ok(NodeClipboard.copyNode(risk.id));
    AppState.addNode('5', 'Цель', true);
    const dest = AppState.findNodeById('5').children.at(-1);
    AppState.generateNumbering();

    const tablesBefore = Object.keys(AppState.tables).length;
    const destChildrenBefore = AppState.findNodeById(dest.id).children.length;

    // Симулируем провал каскада метрик (вернул false → вставка должна откатиться).
    const orig = MetricsRiskCoordinator.onSubtreeMoved;
    MetricsRiskCoordinator.onSubtreeMoved = () => false;
    try {
        assert.equal(await NodeClipboard.pasteInto(dest.id), false, 'вставка возвращает false при провале каскада');
    } finally {
        MetricsRiskCoordinator.onSubtreeMoved = orig;
    }

    assert.equal(AppState.findNodeById(dest.id).children.length, destChildrenBefore, 'вставленный узел откатан');
    assert.equal(Object.keys(AppState.tables).length, tablesBefore, 'записи словаря таблиц откатаны');
});
