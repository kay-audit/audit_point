import { INVOICE_DIFF_FIELD_KEYS } from './invoice-diff-fields.js';

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
                const reordered = !parentChanged && oldRanks[node.id] !== newRanks[node.id];
                if (parentChanged || reordered) {
                    node._moved = true;
                    hasChanges = true;
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
     * Ранг каждого узла среди ОБЩИХ сиблингов — тех, кто ребёнок ТОГО ЖЕ
     * родителя в ОБОИХ деревьях (сверяем otherMeta[id].parentId). Ранг считается
     * только по таким узлам, поэтому вставка/удаление соседа И репарент чужого
     * сиблинга (узел ушёл к другому родителю) не сдвигают ранги оставшихся —
     * нет ложного «перемещён». Глобально удалённый узел не имеет otherMeta →
     * тоже отфильтрован. Не LCS — простая сортировка по индексу.
     * @returns {Object} id → ранг среди общих сиблингов одного родителя.
     */
    static _siblingRanks(meta, otherMeta) {
        const groups = {};
        for (const id of Object.keys(meta)) {
            const parentId = meta[id].parentId;
            // Корень (parentId == null) → сентинел ''. Коллизий нет: реальный
            // parentId — это node.id, всегда непустая строка.
            const key = parentId == null ? '' : parentId;
            (groups[key] || (groups[key] = [])).push(id);
        }
        const ranks = {};
        for (const key of Object.keys(groups)) {
            const common = groups[key]
                .filter(id => otherMeta[id] && otherMeta[id].parentId === meta[id].parentId)
                .sort((a, b) => meta[a].index - meta[b].index);
            common.forEach((id, rank) => { ranks[id] = rank; });
        }
        return ranks;
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
                const strippedOld = this._stripHtml(oldContent);
                const strippedNew = this._stripHtml(newContent);
                result[id] = {
                    status: 'modified',
                    oldContent,
                    newContent,
                    wordDiff: this._wordDiff(strippedOld, strippedNew),
                    // Видимый текст совпал, а raw HTML различается → правка только
                    // форматирования (word-diff пуст); рендер показывает бейдж.
                    formattingOnly: strippedOld === strippedNew,
                };
            }
        }

        return result;
    }

    /**
     * Diff нарушений. Возвращает {vId: {status, fieldDiffs}}. Для 6 скалярных
     * rich-полей fieldDiffs[field] несёт wordDiff/formattingOnly — word-diff
     * по видимому тексту, зеркало _diffTextBlocks.
     */
    static _diffViolations(oldViols, newViols) {
        const result = {};
        const allKeys = new Set([...Object.keys(oldViols), ...Object.keys(newViols)]);
        const fields = ['violated', 'established', 'reasons', 'measures', 'consequences', 'responsible'];

        for (const id of allKeys) {
            const oldV = oldViols[id];
            const newV = newViols[id];

            if (!oldV) {
                const fieldDiffs = {};
                const descDiff = this._diffDescriptionList(null, newV);
                if (descDiff.changed) fieldDiffs.descriptionList = descDiff;
                const addDiff = this._diffAdditionalContent(null, newV);
                if (addDiff.changed) fieldDiffs.additionalContent = addDiff;
                result[id] = { status: 'added', newData: newV, fieldDiffs };
                continue;
            }
            if (!newV) {
                const fieldDiffs = {};
                const descDiff = this._diffDescriptionList(oldV, null);
                if (descDiff.changed) fieldDiffs.descriptionList = descDiff;
                const addDiff = this._diffAdditionalContent(oldV, null);
                if (addDiff.changed) fieldDiffs.additionalContent = addDiff;
                result[id] = { status: 'removed', oldData: oldV, fieldDiffs };
                continue;
            }

            const fieldDiffs = {};
            let hasFieldChanges = false;
            for (const field of fields) {
                const oldVal = this._getViolationFieldValue(oldV, field);
                const newVal = this._getViolationFieldValue(newV, field);
                if (oldVal !== newVal) {
                    // Rich-поля (планируется rich-текст) — сравниваем по
                    // ВИДИМОМУ тексту, зеркало _diffTextBlocks (:281-291).
                    // formattingOnly — правка только разметки при совпавшем
                    // видимом тексте.
                    const strippedOld = this._stripHtml(oldVal);
                    const strippedNew = this._stripHtml(newVal);
                    fieldDiffs[field] = {
                        old: oldVal,
                        new: newVal,
                        changed: true,
                        wordDiff: this._wordDiff(strippedOld, strippedNew),
                        formattingOnly: strippedOld === strippedNew,
                    };
                    hasFieldChanges = true;
                }
            }

            // Список описаний (descriptionList) — структурный под-дифф.
            const descDiff = this._diffDescriptionList(oldV, newV);
            if (descDiff.changed) {
                fieldDiffs.descriptionList = descDiff;
                hasFieldChanges = true;
            }

            // Доп.контент (additionalContent) — структурный под-дифф с матчингом по id.
            const addDiff = this._diffAdditionalContent(oldV, newV);
            if (addDiff.changed) {
                fieldDiffs.additionalContent = addDiff;
                hasFieldChanges = true;
            }

            result[id] = {
                status: hasFieldChanges ? 'modified' : 'unchanged',
                fieldDiffs,
                oldData: oldV,
                newData: newV,
            };
        }

        return result;
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
     * Прочие объекты — JSON.stringify, скаляры — String().
     */
    static _invoiceFieldValue(inv, field) {
        const val = inv ? inv[field] : undefined;
        if (val === null || val === undefined) return '';
        if (field === 'metrics' && Array.isArray(val)) {
            return val.map(m => (m && (m.metric_code || m.code || m.metric_name)) || '')
                .filter(Boolean).join(', ');
        }
        if (field === 'process' && Array.isArray(val)) {
            return val.map(m => (m && (m.process_code || m.process_name)) || '')
                .filter(Boolean).join(', ');
        }
        if (typeof val === 'object') return JSON.stringify(val);
        return String(val);
    }

    static _getViolationFieldValue(viol, field) {
        const val = viol[field];
        if (val === null || val === undefined) return '';
        if (typeof val === 'string') return val;
        if (typeof val === 'object' && 'content' in val) {
            // Выключенное опц.поле (enabled=false) канонизируем как пустое:
            // поле пропало из акта, даже если старый content сохранён. Так
            // выключение поля при неизменном content видно как изменение.
            if ('enabled' in val && !val.enabled) return '';
            return val.content || '';
        }
        return String(val);
    }

    /**
     * Структурный дифф списка описаний (descriptionList: {enabled, items:[str]}).
     * Выключенный список канонизируется как пустой (в акте не показан).
     * Пер-элементный diff по позиции: added/removed/modified (modified → word-diff).
     * @returns {{kind, changed, enabled, oldEnabled, items: Array}}
     */
    static _diffDescriptionList(oldV, newV) {
        const oldDl = (oldV && oldV.descriptionList) || {};
        const newDl = (newV && newV.descriptionList) || {};
        const oldEnabled = !!oldDl.enabled;
        const newEnabled = !!newDl.enabled;
        const oldItems = oldEnabled && Array.isArray(oldDl.items) ? oldDl.items : [];
        const newItems = newEnabled && Array.isArray(newDl.items) ? newDl.items : [];

        const maxLen = Math.max(oldItems.length, newItems.length);
        const items = [];
        let changed = false;
        for (let i = 0; i < maxLen; i++) {
            const hasOld = i < oldItems.length;
            const hasNew = i < newItems.length;
            const oldItem = hasOld ? String(oldItems[i] ?? '') : null;
            const newItem = hasNew ? String(newItems[i] ?? '') : null;
            if (!hasOld) {
                items.push({ status: 'added', new: newItem });
                changed = true;
            } else if (!hasNew) {
                items.push({ status: 'removed', old: oldItem });
                changed = true;
            } else if (oldItem !== newItem) {
                items.push({ status: 'modified', old: oldItem, new: newItem, wordDiff: this._wordDiff(oldItem, newItem) });
                changed = true;
            } else {
                items.push({ status: 'unchanged', old: oldItem, new: newItem });
            }
        }
        return { kind: 'list', changed, enabled: newEnabled, oldEnabled, items };
    }

    /**
     * Структурный дифф доп.контента (additionalContent: {enabled, items:[{id,type,...}]}).
     * Выключенный контент канонизируется как пустой. Матчинг элементов по item.id
     * (стабилен в пределах истории ОДНОГО акта). Классификация:
     * added/removed/modified/reordered. case/freeText → word-diff по видимому
     * тексту (_stripHtml); image → строковое сравнение url/filename/width
     * (base64-url НЕ через word-diff); caption (Task 6, rich-поле) — тоже
     * word-diff по видимому тексту, зеркало case/freeText (см. _diffContentItem).
     * reordered — по относительному порядку общих id (устойчив к вставкам/
     * удалениям).
     * @returns {{kind, changed, enabled, oldEnabled, entries: Array}}
     */
    static _diffAdditionalContent(oldV, newV) {
        const oldAc = (oldV && oldV.additionalContent) || {};
        const newAc = (newV && newV.additionalContent) || {};
        const oldEnabled = !!oldAc.enabled;
        const newEnabled = !!newAc.enabled;
        const oldItems = oldEnabled && Array.isArray(oldAc.items) ? oldAc.items : [];
        const newItems = newEnabled && Array.isArray(newAc.items) ? newAc.items : [];

        const oldById = new Map();
        oldItems.forEach((it, idx) => { if (it && it.id != null) oldById.set(it.id, idx); });
        const newById = new Map();
        newItems.forEach((it, idx) => { if (it && it.id != null) newById.set(it.id, idx); });

        // Ранги в последовательности ОБЩИХ id (для устойчивого reorder-сигнала).
        const oldRank = new Map();
        oldItems.forEach((it) => { if (it && it.id != null && newById.has(it.id)) oldRank.set(it.id, oldRank.size); });
        const newRank = new Map();
        newItems.forEach((it) => { if (it && it.id != null && oldById.has(it.id)) newRank.set(it.id, newRank.size); });

        const entries = [];
        let changed = false;

        // Порядок отображения — новая версия; потом дописываем удалённые.
        newItems.forEach((newItem) => {
            const id = newItem && newItem.id;
            if (id == null || !oldById.has(id)) {
                entries.push({ status: 'added', newItem });
                changed = true;
                return;
            }
            const oldItem = oldItems[oldById.get(id)];
            const itemChange = this._diffContentItem(oldItem, newItem);
            const reordered = oldRank.get(id) !== newRank.get(id);
            let status;
            if (itemChange.changed) status = 'modified';
            else if (reordered) status = 'reordered';
            else status = 'unchanged';
            if (status !== 'unchanged') changed = true;
            entries.push({ status, reordered, oldItem, newItem, ...itemChange.detail });
        });

        oldItems.forEach((oldItem) => {
            const id = oldItem && oldItem.id;
            if (id == null || !newById.has(id)) {
                entries.push({ status: 'removed', oldItem });
                changed = true;
            }
        });

        return { kind: 'additional', changed, enabled: newEnabled, oldEnabled, entries };
    }

    /**
     * Сравнение пары элементов доп.контента одного id.
     * image → строковое сравнение метаданных (url — многомегабайтный data-URL,
     * сравнивается СТРОКОЙ, НЕ через word-diff); caption (Task 6, rich-поле) —
     * отдельно, word-diff по видимому тексту (_stripHtml), зеркало
     * case/freeText-ветки ниже — raw HTML в fields.caption.old/new НЕ рендерят
     * напрямую (см. diff-renderer._renderImageEntry). case/freeText → word-diff
     * по видимому тексту (_stripHtml).
     * @returns {{changed: boolean, detail: Object}}
     */
    static _diffContentItem(oldItem, newItem) {
        if ((newItem && newItem.type) === 'image') {
            const fields = {};
            let changed = false;
            for (const key of ['url', 'filename', 'width']) {
                const oldFv = (oldItem && oldItem[key] != null) ? oldItem[key] : '';
                const newFv = (newItem && newItem[key] != null) ? newItem[key] : '';
                if (String(oldFv) !== String(newFv)) {
                    fields[key] = { old: oldFv, new: newFv };
                    changed = true;
                }
            }
            const oldCaption = (oldItem && oldItem.caption) || '';
            const newCaption = (newItem && newItem.caption) || '';
            if (oldCaption !== newCaption) {
                const strippedOld = this._stripHtml(oldCaption);
                const strippedNew = this._stripHtml(newCaption);
                fields.caption = {
                    old: oldCaption,
                    new: newCaption,
                    wordDiff: this._wordDiff(strippedOld, strippedNew),
                    formattingOnly: strippedOld === strippedNew,
                };
                changed = true;
            }
            return { changed, detail: { fields } };
        }
        const oldContent = (oldItem && oldItem.content) || '';
        const newContent = (newItem && newItem.content) || '';
        const typeChanged = (oldItem && oldItem.type) !== (newItem && newItem.type);
        if (oldContent === newContent && !typeChanged) {
            return { changed: false, detail: {} };
        }
        // Rich-поля (case/freeText) — word-diff по ВИДИМОМУ тексту, тем же
        // приёмом, что и скалярные поля нарушения (_diffViolations выше).
        // formattingOnly — правка только разметки при совпавшем видимом
        // тексте (паритет со скалярными полями нарушения).
        const strippedOld = this._stripHtml(oldContent);
        const strippedNew = this._stripHtml(newContent);
        const wordDiff = this._wordDiff(strippedOld, strippedNew);
        return { changed: true, detail: { typeChanged, wordDiff, formattingOnly: strippedOld === strippedNew } };
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

    static _stripHtml(html) {
        if (!html) return '';
        return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    }
}

window.DiffEngine = DiffEngine;
