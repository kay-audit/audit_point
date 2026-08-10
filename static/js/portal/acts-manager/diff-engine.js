import { INVOICE_DIFF_FIELD_KEYS } from './invoice-diff-fields.js';
import { getOrderedFieldKeys } from '../../constructor/violation/violation-fields.js';
import { BLOCK_TYPES } from '../../constructor/violation/violation-block-types.js';

// Инлайновые теги форматирования — граница тега НЕ считается границей слова
// (сло<b>во</b> визуально сливается с соседним текстом в «слово»). Блочные
// теги (div/p/li/tr/h1-h6/...) и <br> — остаются границей (разрыв
// строки/абзаца), поэтому в _stripHtml обрабатываются по умолчанию (не в
// этом списке).
const INLINE_FORMATTING_TAGS = new Set([
    'b', 'i', 'u', 's', 'em', 'strong', 'span', 'a', 'sub', 'sup', 'code', 'strike', 'del',
]);

// Порог «крупного» контента для пословного сравнения. Строки длиннее (обычно
// base64-картинка, залетевшая в rich-текст, или сам data-URL) через
// _stripHtml/LCS НЕ гоняются — сравниваются на равенство строк, дифф несёт
// только факт смены (флаг oversized). Порядок величины совпадает с внутренним
// лимитом _wordDiff (m * n > 250000).
const LARGE_CONTENT_CHARS = 250000;

/**
 * Вычисление структурного diff между двумя снэпшотами содержимого.
 * Чистый utility-класс без DOM-зависимостей.
 */
export class DiffEngine {
    /**
     * Полный diff двух снэпшотов.
     * @param {Object} oldData - {tree_data, tables_data, textblocks_data, violations_data, invoices_data}
     * @param {Object} newData - {tree, tables, textBlocks, violations, invoices}
     * @returns {Object} {tree, tables, textblocks, violations, invoices, hasChanges}
     */
    static compute(oldData, newData) {
        const treeDiff = this._diffTree(oldData.tree_data, newData.tree);
        const tablesDiff = this._diffTables(oldData.tables_data || {}, newData.tables || {});
        const textblocksDiff = this._diffTextBlocks(oldData.textblocks_data || {}, newData.textBlocks || {});
        const violationsDiff = this._diffViolations(oldData.violations_data || {}, newData.violations || {});
        // Снимки, созданные до миграции invoices_data, блоба не несут → {} →
        // все текущие фактуры покажутся added (обратная совместимость данных
        // снимков не требуется, решение Q2).
        const invoicesDiff = this._diffInvoices(oldData.invoices_data || {}, newData.invoices || {});

        const hasChanges = treeDiff.hasChanges
            || Object.values(tablesDiff).some(t => t.status !== 'unchanged')
            || Object.values(textblocksDiff).some(t => t.status !== 'unchanged')
            || Object.values(violationsDiff).some(v => v.status !== 'unchanged')
            || Object.values(invoicesDiff).some(i => i.status !== 'unchanged');

        return {
            tree: treeDiff, tables: tablesDiff, textblocks: textblocksDiff,
            violations: violationsDiff, invoices: invoicesDiff, hasChanges,
        };
    }

    /**
     * Diff дерева. Возвращает объединённое дерево с аннотациями _diff на каждом узле.
     */
    static _diffTree(oldTree, newTree) {
        const oldMap = {};
        const newMap = {};
        const oldMeta = {};
        const newMeta = {};
        this._flattenTree(oldTree, oldMap, oldMeta);
        this._flattenTree(newTree, newMap, newMeta);

        // Ранги среди ОБЩИХ сиблингов — для устойчивого сигнала перестановки.
        const oldRanks = this._siblingRanks(oldMeta, newMeta);
        const newRanks = this._siblingRanks(newMeta, oldMeta);
        // №13: узлы LIS (наибольшей возрастающей подпоследовательности) по
        // новым рангам, взятым в старом порядке — сохранили порядок ДРУГ
        // ОТНОСИТЕЛЬНО ДРУГА, move-бейджа не получают. Без этого перетаскивание
        // ОДНОГО узла сквозь соседей помечало «перемещён» ВСЕХ сдвинутых
        // соседей, а не только реально перетащенный узел.
        const stableOrderIds = this._stableOrderIds(oldMeta, newMeta, newRanks);

        let hasChanges = false;

        // Аннотируем новое дерево
        const annotated = newTree ? JSON.parse(JSON.stringify(newTree)) : null;
        if (annotated) {
            this._annotateTree(annotated, oldMap, (node) => {
                if (!oldMap[node.id]) {
                    hasChanges = true;
                    return 'added';
                }
                const oldNode = oldMap[node.id];

                // Перемещение: смена родителя ИЛИ порядка среди общих сиблингов.
                const oldParent = oldMeta[node.id] ? oldMeta[node.id].parentId : null;
                const newParent = newMeta[node.id] ? newMeta[node.id].parentId : null;
                const parentChanged = oldParent !== newParent;
                const reordered = !parentChanged && oldRanks[node.id] !== newRanks[node.id]
                    && !stableOrderIds.has(node.id);
                if (parentChanged || reordered) {
                    node._moved = true;
                    hasChanges = true;
                    // Направление — только для reordered (тот же родитель, ранги
                    // сопоставимы). При смене родителя ранги считаются СРЕДИ
                    // ОБЩИХ сиблингов разных родителей и несравнимы — направление
                    // не выставляем (_moveDirection остаётся undefined).
                    if (reordered) {
                        node._moveDirection = newRanks[node.id] < oldRanks[node.id] ? 'up' : 'down';
                    }
                }

                // Атрибуты узла (content НЕ диффим — во фронт-модели поле мёртвое,
                // всегда ''; см. state-core._serializeTree).
                const changes = this._nodeFieldChanges(oldNode, node);
                if (changes) {
                    node._fieldChanges = changes;
                    hasChanges = true;
                    return 'modified';
                }
                return 'unchanged';
            });
        }

        // Проверяем удалённые узлы
        const removedNodes = [];
        for (const id of Object.keys(oldMap)) {
            if (!newMap[id]) {
                hasChanges = true;
                removedNodes.push({ ...oldMap[id], _diff: 'removed', children: [] });
            }
        }

        return { tree: annotated, removedNodes, hasChanges };
    }

    static _flattenTree(node, map, meta = null, parentId = null, index = 0) {
        if (!node) return;
        map[node.id] = node;
        if (meta) meta[node.id] = { parentId, index };
        if (node.children) {
            node.children.forEach((child, i) => {
                this._flattenTree(child, map, meta, node.id, i);
            });
        }
    }

    /**
     * ОБЩИЕ сиблинги — узлы, чей родитель ОДИНАКОВ в обоих деревьях (сверяем
     * otherMeta[id].parentId) — сгруппированные по parentId, каждая группа
     * отсортирована по meta-индексу. Вставка/удаление соседа И репарент
     * чужого сиблинга (узел ушёл к другому родителю) не входят в группу —
     * нет ложного сигнала у оставшихся. Глобально удалённый узел не имеет
     * otherMeta → тоже отфильтрован. Общий билдинг-блок для _siblingRanks
     * (ранги) и _stableOrderIds (LIS, №13).
     * @returns {Object} parentId (или '' для корня) → [id...] по meta-индексу.
     */
    static _commonSiblingGroups(meta, otherMeta) {
        const groups = {};
        for (const id of Object.keys(meta)) {
            const parentId = meta[id].parentId;
            // Корень (parentId == null) → сентинел ''. Коллизий нет: реальный
            // parentId — это node.id, всегда непустая строка.
            const key = parentId == null ? '' : parentId;
            (groups[key] || (groups[key] = [])).push(id);
        }
        const result = {};
        for (const key of Object.keys(groups)) {
            result[key] = groups[key]
                .filter(id => otherMeta[id] && otherMeta[id].parentId === meta[id].parentId)
                .sort((a, b) => meta[a].index - meta[b].index);
        }
        return result;
    }

    /**
     * Ранг каждого узла среди ОБЩИХ сиблингов (см. _commonSiblingGroups).
     * Не LCS — простая сортировка по индексу.
     * @returns {Object} id → ранг среди общих сиблингов одного родителя.
     */
    static _siblingRanks(meta, otherMeta) {
        const groups = this._commonSiblingGroups(meta, otherMeta);
        const ranks = {};
        for (const key of Object.keys(groups)) {
            groups[key].forEach((id, rank) => { ranks[id] = rank; });
        }
        return ranks;
    }

    /**
     * №13: множество id узлов, сохранивших ОТНОСИТЕЛЬНЫЙ порядок между старым
     * и новым деревом — наибольшая возрастающая подпоследовательность (LIS,
     * классический подход диффа перестановок) по новым рангам, взятым в
     * порядке СТАРЫХ рангов. Перетаскивание одного узла сквозь соседей меняет
     * АБСОЛЮТНЫЙ ранг каждого соседа, но не порядок соседей ДРУГ ОТНОСИТЕЛЬНО
     * ДРУГА — узлы вне LIS (обычно только реально перетащенный) получают
     * move-бейдж, узлы внутри LIS — нет.
     * @param {Object} oldMeta
     * @param {Object} newMeta
     * @param {Object} newRanks - _siblingRanks(newMeta, oldMeta)
     * @returns {Set<string>} id узлов внутри LIS (без move-бейджа за reorder).
     */
    static _stableOrderIds(oldMeta, newMeta, newRanks) {
        const groups = this._commonSiblingGroups(oldMeta, newMeta);
        const keep = new Set();
        for (const key of Object.keys(groups)) {
            const ids = groups[key];
            const values = ids.map(id => newRanks[id]);
            for (const idx of this._lisIndices(values)) keep.add(ids[idx]);
        }
        return keep;
    }

    /**
     * Индексы наибольшей возрастающей подпоследовательности массива чисел.
     * O(n²) — сиблингов в группе немного, читаемость важнее асимптотики. При
     * равенстве длин выбирается первая найденная: у простой перестановки пары
     * соседей есть 2 равнозначные LIS (либо один, либо другой сохранил
     * порядок) — выбор конкретной пары не телепатический, но всегда корректный.
     * @param {number[]} values
     * @returns {number[]} Индексы элементов LIS (по возрастанию).
     */
    static _lisIndices(values) {
        const n = values.length;
        if (n === 0) return [];
        const lengths = new Array(n).fill(1);
        const prev = new Array(n).fill(-1);
        for (let i = 1; i < n; i++) {
            for (let j = 0; j < i; j++) {
                if (values[j] < values[i] && lengths[j] + 1 > lengths[i]) {
                    lengths[i] = lengths[j] + 1;
                    prev[i] = j;
                }
            }
        }
        let bestIdx = 0;
        for (let i = 1; i < n; i++) {
            if (lengths[i] > lengths[bestIdx]) bestIdx = i;
        }
        const result = [];
        for (let cur = bestIdx; cur !== -1; cur = prev[cur]) result.push(cur);
        return result.reverse();
    }

    /**
     * Изменения атрибутов узла: label, type, number, customLabel, kind.
     * kind нормализуется к 'regular' (в снимках 'regular' не сериализуется).
     * @returns {Object|null} {field: {old, new}} по изменённым полям или null.
     */
    static _nodeFieldChanges(oldNode, newNode) {
        const changes = {};
        for (const field of ['label', 'type', 'number', 'customLabel']) {
            const oldVal = oldNode[field] == null ? '' : oldNode[field];
            const newVal = newNode[field] == null ? '' : newNode[field];
            if (oldVal !== newVal) changes[field] = { old: oldVal, new: newVal };
        }
        const oldKind = oldNode.kind || 'regular';
        const newKind = newNode.kind || 'regular';
        if (oldKind !== newKind) changes.kind = { old: oldKind, new: newKind };
        return Object.keys(changes).length ? changes : null;
    }

    static _annotateTree(node, oldMap, getStatus) {
        if (!node) return;
        node._diff = getStatus(node);
        if (node.children) {
            for (const child of node.children) {
                this._annotateTree(child, oldMap, getStatus);
            }
        }
    }

    /**
     * Diff таблиц. Возвращает {tableId: {status, cellDiffs, oldData, newData}}
     */
    static _diffTables(oldTables, newTables) {
        const result = {};
        const allKeys = new Set([...Object.keys(oldTables), ...Object.keys(newTables)]);

        for (const id of allKeys) {
            const oldT = oldTables[id];
            const newT = newTables[id];

            if (!oldT) {
                result[id] = { status: 'added', newData: newT, cellDiffs: [] };
                continue;
            }
            if (!newT) {
                result[id] = { status: 'removed', oldData: oldT, cellDiffs: [] };
                continue;
            }

            // Сравниваем ячейки
            const oldGrid = oldT.grid || [];
            const newGrid = newT.grid || [];
            const cellDiffs = [];
            const cellAttrs = [];
            const oldCols = oldGrid.length ? Math.max(...oldGrid.map(r => r.length)) : 0;
            const newCols = newGrid.length ? Math.max(...newGrid.map(r => r.length)) : 0;
            const maxRows = Math.max(oldGrid.length, newGrid.length);
            const maxCols = Math.max(oldCols, newCols);

            for (let r = 0; r < maxRows; r++) {
                for (let c = 0; c < maxCols; c++) {
                    const oldCell = oldGrid[r]?.[c];
                    const newCell = newGrid[r]?.[c];
                    const oldContent = oldCell?.content ?? '';
                    const newContent = newCell?.content ?? '';
                    if (oldContent !== newContent) {
                        cellDiffs.push({ row: r, col: c, old: oldContent, new: newContent });
                    }
                    // Атрибуты структуры — только для ячеек, присутствующих в
                    // ОБЕИХ сетках (иначе это изменение размера → gridResized).
                    if (oldCell && newCell) {
                        const attrs = this._cellAttrChanges(oldCell, newCell);
                        if (attrs) cellAttrs.push({ row: r, col: c, ...attrs });
                    }
                }
            }

            // Флаги структуры: ширины колонок, размер сетки, атрибуты ячеек.
            // Прагматично — только факт изменения, без выравнивания сеток/LCS.
            const oldW = oldT.colWidths || [];
            const newW = newT.colWidths || [];
            const structure = { cellAttrs };
            if (JSON.stringify(oldW) !== JSON.stringify(newW)) {
                structure.colWidths = { old: oldW, new: newW };
            }
            if (oldGrid.length !== newGrid.length || oldCols !== newCols) {
                structure.gridResized = {
                    oldRows: oldGrid.length, oldCols,
                    newRows: newGrid.length, newCols,
                };
            }
            structure.changed = !!structure.colWidths || !!structure.gridResized || cellAttrs.length > 0;

            result[id] = {
                status: (cellDiffs.length > 0 || structure.changed) ? 'modified' : 'unchanged',
                cellDiffs,
                structure,
                oldData: oldT,
                newData: newT,
            };
        }

        return result;
    }

    /**
     * Изменения структурных атрибутов ячейки: isHeader / colSpan / rowSpan.
     * Дефолты (false/1/1) нормализуют отсутствие поля в старом снимке.
     * @returns {Object|null} {isHeader?, colSpan?, rowSpan?} {old,new} или null.
     */
    static _cellAttrChanges(oldCell, newCell) {
        const attrs = {};
        const spec = [['isHeader', false], ['colSpan', 1], ['rowSpan', 1]];
        for (const [key, dflt] of spec) {
            const oldVal = oldCell[key] ?? dflt;
            const newVal = newCell[key] ?? dflt;
            if (oldVal !== newVal) attrs[key] = { old: oldVal, new: newVal };
        }
        return Object.keys(attrs).length ? attrs : null;
    }

    /**
     * Diff текстблоков. Возвращает {tbId: {status, oldContent, newContent, wordDiff}}
     */
    static _diffTextBlocks(oldTBs, newTBs) {
        const result = {};
        const allKeys = new Set([...Object.keys(oldTBs), ...Object.keys(newTBs)]);

        for (const id of allKeys) {
            const oldTB = oldTBs[id];
            const newTB = newTBs[id];

            if (!oldTB) {
                result[id] = { status: 'added', newContent: newTB?.content || '' };
                continue;
            }
            if (!newTB) {
                result[id] = { status: 'removed', oldContent: oldTB?.content || '' };
                continue;
            }

            const oldContent = oldTB.content || '';
            const newContent = newTB.content || '';
            if (oldContent === newContent) {
                result[id] = { status: 'unchanged', content: oldContent };
            } else {
                // Видимый текст совпал, а raw HTML различается → правка только
                // форматирования (word-diff пуст); рендер показывает бейдж.
                result[id] = {
                    status: 'modified',
                    oldContent,
                    newContent,
                    ...this._richWordDiff(oldContent, newContent),
                };
            }
        }

        return result;
    }

    /**
     * Diff нарушений (блочная модель). Все 10 полей реестра — контейнеры
     * {enabled, blocks}, поэтому под-дифф у них ОДНОЙ формы (раньше их было
     * три несовместимых: скаляры / список описаний / доп.контент).
     *
     * Возвращает {vId: {status, fields, fieldOrder?, oldData, newData}}:
     *   fields[key] = {
     *       changed: true,
     *       enabled?: {old, new, changed},          // только если enabled различается
     *       blocks?:  {entries: [...], reordered},  // только если состав/содержимое блоков изменились
     *   }
     *   fieldOrder? = {old: [ключи], new: [ключи]}  // только если видимый порядок различается
     * Поля в `fields` вставляются в ПОРЯДКЕ ОТОБРАЖЕНИЯ новой версии
     * (getOrderedFieldKeys) — рендер обходит Object.keys без своей сортировки.
     * Неизменившиеся поля в `fields` не попадают.
     */
    static _diffViolations(oldViols, newViols) {
        const result = {};
        const allKeys = new Set([...Object.keys(oldViols), ...Object.keys(newViols)]);

        for (const id of allKeys) {
            const oldV = oldViols[id];
            const newV = newViols[id];

            const fields = {};
            let changed = false;
            // Порядок отображения новой версии; для удалённого нарушения — старой.
            for (const key of getOrderedFieldKeys(newV || oldV)) {
                const fieldDiff = this._diffViolationField(
                    oldV ? oldV[key] : null,
                    newV ? newV[key] : null,
                );
                if (!fieldDiff.changed) continue;
                fields[key] = fieldDiff;
                changed = true;
            }

            const fieldOrder = this._diffFieldOrder(oldV, newV);
            if (fieldOrder) changed = true;

            let status;
            if (!oldV) status = 'added';
            else if (!newV) status = 'removed';
            else status = changed ? 'modified' : 'unchanged';

            result[id] = { status, fields, oldData: oldV, newData: newV };
            if (fieldOrder) result[id].fieldOrder = fieldOrder;
        }

        return result;
    }

    /**
     * Дифф видимого порядка полей. Сравниваются РАЗВЁРНУТЫЕ порядки
     * (getOrderedFieldKeys): `fieldOrder: null` и явный массив, совпадающий со
     * стандартным порядком, — один и тот же вид акта, изменением не считаются.
     * @returns {{old: string[], new: string[]}|null}
     */
    static _diffFieldOrder(oldV, newV) {
        const oldOrder = getOrderedFieldKeys(oldV);
        const newOrder = getOrderedFieldKeys(newV);
        const same = oldOrder.length === newOrder.length
            && oldOrder.every((key, i) => key === newOrder[i]);
        return same ? null : { old: [...oldOrder], new: [...newOrder] };
    }

    /**
     * Дифф одного поля нарушения: флаг enabled + блоки.
     * Выключенное поле канонизируется как ПУСТОЕ (из акта оно пропало), поэтому
     * выключение при неизменных блоках видно как удаление всех блоков.
     * @returns {{changed: boolean, enabled?: Object, blocks?: Object}}
     */
    static _diffViolationField(oldField, newField) {
        const oldEnabled = !!(oldField && oldField.enabled);
        const newEnabled = !!(newField && newField.enabled);
        const blocks = this._diffBlocks(this._fieldBlocks(oldField), this._fieldBlocks(newField));

        const diff = { changed: false };
        if (oldEnabled !== newEnabled) {
            diff.enabled = { old: oldEnabled, new: newEnabled, changed: true };
            diff.changed = true;
        }
        if (blocks.changed) {
            diff.blocks = { entries: blocks.entries, reordered: blocks.reordered };
            diff.changed = true;
        }
        return diff;
    }

    /**
     * Блоки поля с канонизацией: выключенное поле и повреждённые данные
     * (поля нет, blocks не массив) → пустой список.
     * @returns {Array}
     */
    static _fieldBlocks(field) {
        if (!field || typeof field !== 'object' || !field.enabled) return [];
        return Array.isArray(field.blocks) ? field.blocks : [];
    }

    /**
     * Дифф списка блоков с матчингом по СТАБИЛЬНОМУ block.id (id живёт весь
     * жизненный цикл блока; при копировании нарушения регенерируется).
     * Классификация: added/removed/modified/reordered/unchanged. reordered —
     * по относительному порядку ОБЩИХ id (устойчив к вставкам/удалениям).
     * @returns {{entries: Array, changed: boolean, reordered: boolean}}
     */
    static _diffBlocks(oldBlocks, newBlocks) {
        const oldById = new Map();
        oldBlocks.forEach((b, i) => { if (b && b.id != null) oldById.set(b.id, i); });
        const newById = new Map();
        newBlocks.forEach((b, i) => { if (b && b.id != null) newById.set(b.id, i); });

        // Ранги в последовательности ОБЩИХ id — устойчивый сигнал перестановки.
        const oldRank = new Map();
        oldBlocks.forEach((b) => { if (b && b.id != null && newById.has(b.id)) oldRank.set(b.id, oldRank.size); });
        const newRank = new Map();
        newBlocks.forEach((b) => { if (b && b.id != null && oldById.has(b.id)) newRank.set(b.id, newRank.size); });

        const entries = [];
        let changed = false;
        let reordered = false;

        // Порядок отображения — новая версия; удалённые дописываем следом.
        newBlocks.forEach((newBlock) => {
            const id = newBlock && newBlock.id;
            if (id == null || !oldById.has(id)) {
                entries.push({
                    status: 'added', reordered: false,
                    type: this._blockType(null, newBlock), newBlock,
                });
                changed = true;
                return;
            }
            const oldBlock = oldBlocks[oldById.get(id)];
            const pair = this._diffBlockPair(oldBlock, newBlock);
            const moved = oldRank.get(id) !== newRank.get(id);
            let status;
            if (pair.changed) status = 'modified';
            else if (moved) status = 'reordered';
            else status = 'unchanged';
            if (status !== 'unchanged') changed = true;
            if (moved) reordered = true;
            entries.push({
                status, reordered: moved,
                type: this._blockType(oldBlock, newBlock),
                oldBlock, newBlock, ...pair.detail,
            });
        });

        oldBlocks.forEach((oldBlock) => {
            const id = oldBlock && oldBlock.id;
            if (id == null || !newById.has(id)) {
                entries.push({
                    status: 'removed', reordered: false,
                    type: this._blockType(oldBlock, null), oldBlock,
                });
                changed = true;
            }
        });

        return { entries, changed, reordered };
    }

    /** Тип блока для рендера: из новой версии, иначе из старой, иначе текст. */
    static _blockType(oldBlock, newBlock) {
        return (newBlock && newBlock.type) || (oldBlock && oldBlock.type) || BLOCK_TYPES.TEXT;
    }

    /**
     * Сравнение пары блоков одного id. Диспетчер по типу НОВОГО блока:
     *  - text  → word-diff по видимому тексту (с перф-гвардом, см. _blockTextDiff);
     *  - image → атрибуты; url многомегабайтный, сравнивается СТРОКОЙ (только
     *            факт смены), caption — rich-поле, word-diff;
     *  - table → плоское сравнение ячеек grid по (row, col) + факт смены размера
     *            сетки; содержимое ячеек через LCS/word-diff НЕ гоняется (перф).
     * Смена типа при том же id — повреждённые данные; фиксируем флагом
     * typeChanged и считаем блок изменённым.
     * @returns {{changed: boolean, detail: Object}}
     */
    static _diffBlockPair(oldBlock, newBlock) {
        const type = this._blockType(oldBlock, newBlock);
        let result;
        if (type === BLOCK_TYPES.IMAGE) result = this._diffImageBlock(oldBlock, newBlock);
        else if (type === BLOCK_TYPES.TABLE) result = this._diffTableBlock(oldBlock, newBlock);
        else result = this._diffTextBlockPair(oldBlock, newBlock);

        const typeChanged = (oldBlock && oldBlock.type) !== (newBlock && newBlock.type);
        if (typeChanged) {
            return { changed: true, detail: { ...result.detail, typeChanged: true } };
        }
        return result;
    }

    /** Text-блок: word-diff по видимому тексту rich-HTML. */
    static _diffTextBlockPair(oldBlock, newBlock) {
        const oldContent = (oldBlock && oldBlock.content) || '';
        const newContent = (newBlock && newBlock.content) || '';
        if (oldContent === newContent) return { changed: false, detail: {} };
        return { changed: true, detail: this._blockTextDiff(oldContent, newContent) };
    }

    /** Image-блок: url/filename/width строкой, caption — rich-поле с word-diff. */
    static _diffImageBlock(oldBlock, newBlock) {
        const fields = {};
        let changed = false;
        for (const key of ['url', 'filename', 'width']) {
            const oldVal = (oldBlock && oldBlock[key] != null) ? oldBlock[key] : '';
            const newVal = (newBlock && newBlock[key] != null) ? newBlock[key] : '';
            if (String(oldVal) !== String(newVal)) {
                fields[key] = { old: oldVal, new: newVal };
                changed = true;
            }
        }
        const oldCaption = (oldBlock && oldBlock.caption) || '';
        const newCaption = (newBlock && newBlock.caption) || '';
        if (oldCaption !== newCaption) {
            fields.caption = { old: oldCaption, new: newCaption, ...this._blockTextDiff(oldCaption, newCaption) };
            changed = true;
        }
        return { changed, detail: { fields } };
    }

    /**
     * Table-блок: изменённые ячейки списком {row, col, old, new} + факт смены
     * размера сетки. Без LCS/word-diff по содержимому ячеек — таблица может
     * нести сотни ячеек, а попарный LCS по каждой съел бы рендер диффа.
     * gridResized нужен, чтобы добавление/удаление ПУСТЫХ строк/колонок не
     * выглядело «без изменений» (изменённых ячеек при этом ноль).
     */
    static _diffTableBlock(oldBlock, newBlock) {
        const oldGrid = (oldBlock && oldBlock.table && oldBlock.table.grid) || [];
        const newGrid = (newBlock && newBlock.table && newBlock.table.grid) || [];
        const oldCols = oldGrid.length ? Math.max(...oldGrid.map(r => (r ? r.length : 0))) : 0;
        const newCols = newGrid.length ? Math.max(...newGrid.map(r => (r ? r.length : 0))) : 0;
        const maxRows = Math.max(oldGrid.length, newGrid.length);
        const maxCols = Math.max(oldCols, newCols);

        const cells = [];
        for (let r = 0; r < maxRows; r++) {
            for (let c = 0; c < maxCols; c++) {
                const oldContent = oldGrid[r]?.[c]?.content ?? '';
                const newContent = newGrid[r]?.[c]?.content ?? '';
                if (oldContent !== newContent) {
                    cells.push({ row: r, col: c, old: oldContent, new: newContent });
                }
            }
        }

        const detail = { cells };
        if (oldGrid.length !== newGrid.length || oldCols !== newCols) {
            detail.gridResized = {
                oldRows: oldGrid.length, oldCols,
                newRows: newGrid.length, newCols,
            };
        }
        return { changed: cells.length > 0 || !!detail.gridResized, detail };
    }

    /**
     * Word-diff содержимого блока с перф-гвардом. Крупный контент (base64
     * картинки, залетевший в rich-текст) через _stripHtml/LCS не гоняется —
     * дифф несёт только факт смены (oversized: true, wordDiff: null), рендер
     * показывает текстовую сводку вместо пословной подсветки.
     * @returns {{wordDiff: Array|null, formattingOnly: boolean, oversized?: boolean}}
     */
    static _blockTextDiff(oldHtml, newHtml) {
        const oldLen = oldHtml ? oldHtml.length : 0;
        const newLen = newHtml ? newHtml.length : 0;
        if (oldLen > LARGE_CONTENT_CHARS || newLen > LARGE_CONTENT_CHARS) {
            return { wordDiff: null, formattingOnly: false, oversized: true };
        }
        return this._richWordDiff(oldHtml, newHtml);
    }

    /**
     * Diff фактур по привязке node_id → реквизиты. Обе стороны — {node_id: инвойс}
     * одной формы (старая = блоб снимка, новая = поле invoices из /content).
     * Возвращает {node_id: {status, fieldDiffs, oldData, newData}}.
     * Сравниваются только реквизиты (не id/created_at/updated_at/created_by):
     * смена служебных полей не должна выглядеть как правка фактуры.
     * @returns {Object} node_id → результат диффа фактуры.
     */
    static _diffInvoices(oldInvoices, newInvoices) {
        const result = {};
        const allKeys = new Set([...Object.keys(oldInvoices), ...Object.keys(newInvoices)]);
        const fields = INVOICE_DIFF_FIELD_KEYS;

        for (const nodeId of allKeys) {
            const oldInv = oldInvoices[nodeId];
            const newInv = newInvoices[nodeId];

            if (!oldInv) {
                result[nodeId] = { status: 'added', newData: newInv };
                continue;
            }
            if (!newInv) {
                result[nodeId] = { status: 'removed', oldData: oldInv };
                continue;
            }

            const fieldDiffs = {};
            let changed = false;
            for (const field of fields) {
                const oldVal = this._invoiceFieldValue(oldInv, field);
                const newVal = this._invoiceFieldValue(newInv, field);
                if (oldVal !== newVal) {
                    fieldDiffs[field] = { old: oldVal, new: newVal };
                    changed = true;
                }
            }

            result[nodeId] = {
                status: changed ? 'modified' : 'unchanged',
                fieldDiffs,
                oldData: oldInv,
                newData: newInv,
            };
        }

        return result;
    }

    /**
     * Нормализованное строковое значение реквизита фактуры для сравнения.
     * metrics/process сравниваем по ВИДИМЫМ кодам — в дифе показываются только
     * *_code (см. diff-renderer._invoiceFieldText). Сравнение всего объекта
     * через JSON.stringify реагировало бы на служебные атрибуты и помечало
     * фактуру «изменено» при неизменном видимом тексте (фантомный дифф).
     * Коды сортируются перед join СОЗНАТЕЛЬНО — сравнение порядко-независимое:
     * перестановка тех же кодов не смысловая правка (рендер _invoiceFieldText
     * в diff-renderer.js показывает хранимый порядок как есть, здесь не трогаем).
     * Прочие объекты — JSON.stringify, скаляры — String().
     */
    static _invoiceFieldValue(inv, field) {
        const val = inv ? inv[field] : undefined;
        if (val === null || val === undefined) return '';
        if (field === 'metrics' && Array.isArray(val)) {
            return val.map(m => (m && (m.metric_code || m.code || m.metric_name)) || '')
                .filter(Boolean).sort().join(', ');
        }
        if (field === 'process' && Array.isArray(val)) {
            return val.map(m => (m && (m.process_code || m.process_name)) || '')
                .filter(Boolean).sort().join(', ');
        }
        if (typeof val === 'object') return JSON.stringify(val);
        return String(val);
    }

    /**
     * Word-level diff двух строк.
     * @returns [{type: 'equal'|'insert'|'delete', text}]
     */
    static _wordDiff(oldText, newText) {
        const oldWords = oldText.split(/\s+/).filter(Boolean);
        const newWords = newText.split(/\s+/).filter(Boolean);

        if (oldWords.length === 0 && newWords.length === 0) return [];
        if (oldWords.length === 0) return [{ type: 'insert', text: newWords.join(' ') }];
        if (newWords.length === 0) return [{ type: 'delete', text: oldWords.join(' ') }];

        // LCS
        const m = oldWords.length;
        const n = newWords.length;

        // Ограничение: для слишком длинных текстов — упрощённый diff
        if (m * n > 250000) {
            return [
                { type: 'delete', text: oldWords.join(' ') },
                { type: 'insert', text: newWords.join(' ') },
            ];
        }

        const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (oldWords[i - 1] === newWords[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }
        }

        // Backtrack
        const ops = [];
        let i = m, j = n;
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
                ops.push({ type: 'equal', text: oldWords[i - 1] });
                i--; j--;
            } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                ops.push({ type: 'insert', text: newWords[j - 1] });
                j--;
            } else {
                ops.push({ type: 'delete', text: oldWords[i - 1] });
                i--;
            }
        }

        ops.reverse();

        // Группируем последовательные одинаковые операции
        const grouped = [];
        for (const op of ops) {
            const last = grouped[grouped.length - 1];
            if (last && last.type === op.type) {
                last.text += ' ' + op.text;
            } else {
                grouped.push({ ...op });
            }
        }

        return grouped;
    }

    /**
     * Word-diff + флаг formattingOnly по паре rich-HTML строк — общее ядро
     * для всех rich-полей (текстблоки, text-блоки нарушения, подпись под
     * картинкой): сравнение по ВИДИМОМУ тексту (_stripHtml). formattingOnly —
     * правка затронула только разметку (видимый текст совпал, word-diff без
     * вставок/удалений). Перф-гвард на крупный контент — в _blockTextDiff.
     * @returns {{wordDiff: Array, formattingOnly: boolean}}
     */
    static _richWordDiff(oldHtml, newHtml) {
        const strippedOld = this._stripHtml(oldHtml);
        const strippedNew = this._stripHtml(newHtml);
        return {
            wordDiff: this._wordDiff(strippedOld, strippedNew),
            formattingOnly: strippedOld === strippedNew,
        };
    }

    /**
     * Видимый текст HTML-строки. Инлайновые теги форматирования (см.
     * INLINE_FORMATTING_TAGS) вырезаются БЕЗ пробела — тег внутри слова не
     * должен разбивать его на два («сло<b>во</b>» → «слово», не «сло во»).
     * Прочие теги (блочные, <br>) заменяются пробелом — граница слова.
     */
    static _stripHtml(html) {
        if (!html) return '';
        return html
            .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (match, tag) => (
                INLINE_FORMATTING_TAGS.has(tag.toLowerCase()) ? '' : ' '
            ))
            .replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
}

window.DiffEngine = DiffEngine;
