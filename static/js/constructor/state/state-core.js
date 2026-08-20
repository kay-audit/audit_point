/**
 * Ядро управления состоянием приложения
 *
 * Содержит базовые свойства состояния, инициализацию дерева,
 * методы поиска узлов и экспорта данных.
 * Делегирует специализированные операции модулям StateContent, StateTree и ValidationTree.
 */
import { StorageManager } from '../storage-manager.js';
import { ValidationCore } from '../validation/validation-core.js';
import { ValidationTree } from '../validation/validation-tree.js';
import { AppConfig } from '../../shared/app-config.js';
import { KIND_REGULAR, getTableKind } from '../table/table-kind.js';
import { serializeGrid } from '../table/table-serialize.js';
import { VIOLATION_FIELD_KEYS, MANDATORY_FIELD_KEYS } from '../violation/violation-fields.js';
import { BLOCK_TYPES } from '../violation/violation-block-types.js';

export const AppState = {
    /** @type {number} Текущий шаг приложения (1 или 2) */
    currentStep: 1,

    /** @type {Object|null} Корневой узел дерева документа */
    treeData: null,

    /** @type {Object<string, Object>} Таблицы по ID */
    tables: {},

    /** @type {Object<string, Object>} Текстовые блоки по ID */
    textBlocks: {},

    /** @type {Object<string, Object>} Нарушения по ID */
    violations: {},

    /** @type {Object|null} Выбранный узел дерева */
    selectedNode: null,

    /** @type {Array} Выбранные ячейки таблицы */
    selectedCells: [],

    /**
     * Инициализирует базовую структуру дерева
     * @param {boolean} [isProcessBased=true] - Является ли проверка процессной
     * @returns {Object} Корневой узел дерева
     */
    initializeTree(isProcessBased = true) {
        this.treeData = this._createRootStructure(isProcessBased);
        this._createInitialTables(isProcessBased);
        return this.treeData;
    },

    /**
     * Создает корневую структуру дерева с защищенными разделами
     * @private
     * @param {boolean} isProcessBased - Является ли проверка процессной
     * @returns {Object} Корневой узел
     */
    _createRootStructure(isProcessBased) {
        const sections = AppConfig.tree.defaultSections.map(section => {
            // Изменяем название раздела 1 для непроцессной проверки
            if (section.id === '1' && !isProcessBased) {
                return this._createProtectedSection(section.id, 'Характеристика проверяемого направления');
            }
            return this._createProtectedSection(section.id, section.label);
        });

        return {
            id: 'root',
            label: 'Акт',
            children: sections
        };
    },

    /**
     * Создает защищенный раздел первого уровня
     * @private
     * @param {string} id - ID раздела
     * @param {string} label - Название раздела
     * @returns {Object} Узел раздела
     */
    _createProtectedSection(id, label) {
        return {
            id,
            label,
            protected: true,
            deletable: false,
            children: [],
            content: ''
        };
    },

    /**
     * Создаёт опциональный защищённый пункт «Process Mining».
     * protected: нельзя перетаскивать/переименовывать; deletable: можно удалить;
     * titleLocked: заголовок зафиксирован.
     * @private
     * @returns {Object} Узел пункта Process Mining
     */
    _createProcessMiningSection() {
        const cfg = AppConfig.tree.processMiningSection;
        return {
            id: cfg.id,
            label: cfg.label,
            special: cfg.special,
            protected: true,
            deletable: true,
            titleLocked: true,
            type: AppConfig.nodeTypes.ITEM,
            children: [],
            content: ''
        };
    },

    /**
     * Создает предустановленные таблицы при инициализации
     * @private
     * @param {boolean} isProcessBased - Является ли проверка процессной
     */
    _createInitialTables(isProcessBased) {
        if (!AppConfig?.content?.tablePresets) {
            return;
        }

        const presets = AppConfig.content.tablePresets;

        // Ищем узлы по ID
        const node2 = this.findNodeById('2');
        const node3 = this.findNodeById('3');

        // Таблица для раздела 2 создается ТОЛЬКО для процессной проверки
        if (node2 && isProcessBased) {
            this._createQualityAssessmentTable();
        }

        if (node3) {
            // Таблицы для раздела 3
            this._createTableFromPreset('3', presets.dataTools, presets.dataTools.label, true, false);
            this._createTableFromPreset('3', presets.dataSources, presets.dataSources.label, true, false);
            this._createTableFromPreset('3', presets.repositories, presets.repositories.label, true, false);
        }
    },

    /**
     * Создаёт в разделе 2 таблицу «Результаты оценки качества процесса».
     *
     * Общий код для автосоздания при инициализации процессного акта и для
     * пункта контекстного меню (AppState.addQualityAssessmentTable).
     * Таблица protected (нельзя таскать/переименовывать), но deletable —
     * ЯВНО true, иначе гейт state-tree.js::deleteNode отобьёт удаление.
     * Маркер special отличает её от произвольной пользовательской таблицы;
     * kind не заводится сознательно — любой kind !== 'regular' закрепил бы
     * таблицу вверху children со всеми правилами pinned-таблиц.
     *
     * @private
     * @returns {Object|null} Созданный узел таблицы или null, если создать не удалось
     */
    _createQualityAssessmentTable() {
        const preset = AppConfig?.content?.tablePresets?.qualityAssessment;
        const node2 = this.findNodeById('2');
        if (!preset || !node2) {
            return null;
        }

        const result = this._createTableFromPreset('2', preset, preset.label, true, true);
        if (!result.valid) {
            return null;
        }

        // _createSimpleTable добавляет узел в конец children; переносим в начало —
        // таблица задумана как вводная для раздела 2.
        const tableNode = node2.children.pop();
        tableNode.special = 'quality_assessment';
        node2.children.unshift(tableNode);

        return tableNode;
    },

    /**
     * Создает таблицу из пресета
     * @private
     */
    _createTableFromPreset(nodeId, preset, label, isProtected, deletable) {
        if (!preset) {
            return ValidationCore.failure('Пресет не передан');
        }

        return this._createSimpleTable(
            nodeId,
            preset.rows,
            preset.cols,
            preset.headers,
            isProtected,
            deletable,
            label
        );
    },

    /**
     * Создает простую таблицу
     * @private
     * @param {string} nodeId - ID узла
     * @param {number} rows - Количество строк
     * @param {number} cols - Количество колонок
     * @param {string[]} [headers] - Заголовки колонок
     * @param {boolean} [isProtected] - Защита от изменений
     * @param {boolean} [deletable] - Возможность удаления
     * @param {string} [label] - Название таблицы
     * @returns {Object} Результат создания
     */
    _createSimpleTable(nodeId, rows, cols, headers = [], isProtected = false, deletable = true, label = '') {
        const node = this.findNodeById(nodeId);
        if (!node) {
            return ValidationCore.failure(AppConfig.tree.validation.nodeNotFound);
        }

        const validation = ValidationTree.canAddContent(node, AppConfig.nodeTypes.TABLE);
        if (!validation.valid) {
            return validation;
        }

        const tableId = this._generateId('table');
        const tableNode = this._createTableNode(nodeId, tableId, label, isProtected, deletable);

        node.children.push(tableNode);
        this._indexNodeAdded(tableNode, node);

        const grid = this._createTableGrid(rows, cols, headers);
        const table = this._createTableObject(tableId, tableNode.id, grid, cols, isProtected, deletable);

        this.tables[tableId] = table;

        return ValidationCore.success();
    },

    /**
     * Создает узел таблицы в дереве
     * @private
     * @param {string} parentId - ID родительского узла
     * @param {string} tableId - ID таблицы
     * @param {string} label - Название таблицы
     * @param {boolean} protected - Защита
     * @param {boolean} deletable - Возможность удаления
     * @returns {Object} Узел таблицы
     */
    _createTableNode(parentId, tableId, label, isProtected, deletable) {
        const node = {
            id: `${parentId}_table_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
            label: label || AppConfig.tree.labels.table,
            type: AppConfig.nodeTypes.TABLE,
            tableId,
            parentId,
            protected: isProtected,
            deletable
        };

        if (label === '') {
            node.label = AppConfig.tree.labels.table;
            node.customLabel = '';
        } else if (label) {
            node.customLabel = label;
        }

        return node;
    },

    /**
     * Создает сетку таблицы с данными
     * @private
     * @param {number} rows - Количество строк данных
     * @param {number} cols - Количество колонок
     * @param {string[]} headers - Заголовки
     * @returns {Array<Array>} Сетка ячеек
     */
    _createTableGrid(rows, cols, headers) {
        const grid = [];

        const headerRow = this._createHeaderRow(cols, headers);
        grid.push(headerRow);

        for (let r = 1; r <= rows; r++) {
            grid.push(this._createDataRow(r, cols));
        }

        return grid;
    },

    /**
     * Создает строку заголовков
     * @private
     * @param {number} cols - Количество колонок
     * @param {string[]} headers - Тексты заголовков
     * @returns {Array} Строка ячеек заголовка
     */
    _createHeaderRow(cols, headers) {
        return Array.from({length: cols}, (_, c) => ({
            content: headers[c] || `Колонка ${c + 1}`,
            isHeader: true,
            colSpan: 1,
            rowSpan: 1,
            originRow: 0,
            originCol: c
        }));
    },

    /**
     * Создает строку данных
     * @private
     * @param {number} rowIndex - Индекс строки
     * @param {number} cols - Количество колонок
     * @returns {Array} Строка ячеек данных
     */
    _createDataRow(rowIndex, cols) {
        return Array.from({length: cols}, (_, c) => ({
            content: '',
            isHeader: false,
            colSpan: 1,
            rowSpan: 1,
            originRow: rowIndex,
            originCol: c
        }));
    },

    /**
     * Создает объект таблицы
     * @private
     * @param {string} tableId - ID таблицы
     * @param {string} nodeId - ID узла
     * @param {Array} grid - Сетка ячеек
     * @param {number} cols - Количество колонок
     * @param {boolean} protected - Защита
     * @param {boolean} deletable - Возможность удаления
     * @returns {Object} Объект таблицы
     */
    _createTableObject(tableId, nodeId, grid, cols, isProtected, deletable) {
        return {
            id: tableId,
            nodeId,
            grid,
            colWidths: new Array(cols).fill(AppConfig.content.defaults.columnWidth),
            protected: isProtected,
            deletable
        };
    },

    /**
     * Генерирует уникальный ID
     * @private
     * @param {string} prefix - Префикс ID
     * @returns {string} Уникальный ID
     */
    _generateId(prefix) {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 9);
        return `${prefix}_${timestamp}_${random}`;
    },

    /**
     * Индекс id → raw-узел дерева. Держит «сырые» объекты (не Proxy):
     * горячие read-пути ходят по нему без get-трапов. Наружу raw не отдаётся —
     * findNodeById/findParentNode оборачивают результат через _trackedNode.
     * @private
     * @type {Map<string, Object>}
     */
    _nodeIndex: new Map(),

    /**
     * Индекс childId → raw-родитель. Поддерживается синхронно с _nodeIndex.
     * @private
     * @type {Map<string, Object>}
     */
    _parentIndex: new Map(),

    /**
     * Raw-корень, по которому построен индекс. Несовпадение с текущим
     * raw-treeData (замена дерева целиком: загрузка акта, initializeTree,
     * тесты) — сигнал на полный rebuild.
     * @private
     * @type {Object|null}
     */
    _indexRoot: null,

    /**
     * Полностью перестраивает индексы узлов обходом raw-дерева.
     * Вызывается лениво при смене корня (_ensureNodeIndex) и явно после
     * операций, заменяющих узлы по ссылкам (rollback каскада metrics↔risk).
     * @private
     */
    _rebuildNodeIndex() {
        this._nodeIndex.clear();
        this._parentIndex.clear();
        const root = _unwrap(this.treeData) || null;
        this._indexRoot = root;
        if (!root) return;

        const walk = (node, parent) => {
            this._nodeIndex.set(node.id, node);
            if (parent) this._parentIndex.set(node.id, parent);
            if (node.children) {
                for (const child of node.children) walk(child, node);
            }
        };
        walk(root, null);
    },

    /**
     * Гарантирует актуальность индекса относительно текущего корня дерева.
     * @private
     */
    _ensureNodeIndex() {
        const root = _unwrap(this.treeData) || null;
        if (this._indexRoot !== root) this._rebuildNodeIndex();
    },

    /**
     * Регистрирует добавленное поддерево в индексах.
     * Вызывается во ВСЕХ структурных мутациях, добавляющих узлы
     * (addNode/_addAsChild/_addAsSibling, создание контент-узлов,
     * каскадные metrics-таблицы).
     * @private
     * @param {Object} node - Добавленный узел (с поддеревом)
     * @param {Object} parent - Родитель, в children которого вставлен узел
     */
    _indexNodeAdded(node, parent) {
        this._ensureNodeIndex();
        const walk = (n, p) => {
            this._nodeIndex.set(n.id, n);
            if (p) this._parentIndex.set(n.id, p);
            if (n.children) {
                for (const child of n.children) walk(child, n);
            }
        };
        walk(_unwrap(node), _unwrap(parent));
    },

    /**
     * Снимает удалённое поддерево с индексов.
     * @private
     * @param {Object} node - Удалённый узел (с поддеревом)
     */
    _unindexNodeRemoved(node) {
        const walk = (n) => {
            this._nodeIndex.delete(n.id);
            this._parentIndex.delete(n.id);
            if (n.children) {
                for (const child of n.children) walk(child);
            }
        };
        walk(_unwrap(node));
    },

    /**
     * Обновляет индекс родителя после перемещения узла (membership поддерева
     * не меняется — достаточно одной записи).
     * @private
     * @param {Object} node - Перемещённый узел
     * @param {Object} newParent - Новый родитель
     */
    _reindexNodeMoved(node, newParent) {
        this._ensureNodeIndex();
        this._parentIndex.set(_unwrap(node).id, _unwrap(newParent));
    },

    /**
     * Оборачивает raw-узел в tracking-Proxy, если deep-tracking активен.
     * Гарантия: наружу из индекса не выходит raw-объект — мутации через
     * результат findNodeById всегда ловятся markAsUnsaved.
     * @private
     * @param {Object|null} node - Raw-узел из индекса
     * @returns {Object|null}
     */
    _trackedNode(node) {
        if (!node) return null;
        return _isStateTrackingActive() ? _wrapDeep(node) : node;
    },

    /**
     * Ищет узел по ID. Без второго аргумента — O(1) по индексу;
     * с явным начальным узлом — рекурсивный обход поддерева (legacy-режим).
     * @param {string} id - ID искомого узла
     * @param {Object} [node] - Начальный узел для scoped-поиска
     * @returns {Object|null} Найденный узел или null
     */
    findNodeById(id, node) {
        if (node !== undefined) {
            return this._findNodeWalk(id, node);
        }
        return this._trackedNode(this._findNodeRaw(id));
    },

    /**
     * Внутренний raw-поиск узла по индексу (без оборачивания в Proxy).
     * Использовать ТОЛЬКО для read-only путей (сериализация, рендер) —
     * мутации raw-узла обходят dirty-tracking.
     * @private
     * @param {string} id - ID искомого узла
     * @returns {Object|null} Raw-узел или null
     */
    _findNodeRaw(id) {
        if (!this.treeData) return null;

        this._ensureNodeIndex();
        const hit = this._nodeIndex.get(id);
        if (hit) return hit;

        // Промах индекса: страховочный полный обход. Найденный обходом узел —
        // сигнал пропущенной инвалидации (warn), индекс перестраивается.
        const found = this._findNodeWalk(id, this._indexRoot);
        if (found) {
            console.warn(`[AppState] findNodeById('${id}'): промах индекса — найден полным обходом, индекс перестроен (пропущенная инвалидация)`);
            this._rebuildNodeIndex();
            return found;
        }
        return null;
    },

    /**
     * Рекурсивный поиск узла по ID (без индекса).
     * @private
     * @param {string} id - ID искомого узла
     * @param {Object} node - Начальный узел
     * @returns {Object|null}
     */
    _findNodeWalk(id, node) {
        if (!node) return null;
        if (node.id === id) return node;
        if (!node.children) return null;

        for (const child of node.children) {
            const found = this._findNodeWalk(id, child);
            if (found) return found;
        }

        return null;
    },

    /**
     * Находит родительский узел. Без второго аргумента — O(1) по индексу;
     * с явным начальным узлом — рекурсивный обход (legacy-режим).
     * @param {string} nodeId - ID дочернего узла
     * @param {Object} [parent] - Начальный узел для scoped-поиска
     * @returns {Object|null} Родительский узел или null
     */
    findParentNode(nodeId, parent) {
        if (parent !== undefined) {
            return this._findParentWalk(nodeId, parent);
        }
        return this._trackedNode(this._findParentRaw(nodeId));
    },

    /**
     * Внутренний raw-поиск родителя по индексу (без оборачивания в Proxy).
     * @private
     * @param {string} nodeId - ID дочернего узла
     * @returns {Object|null} Raw-родитель или null
     */
    _findParentRaw(nodeId) {
        if (!this.treeData) return null;

        this._ensureNodeIndex();
        const hit = this._parentIndex.get(nodeId);
        if (hit) return hit;
        // Узел известен индексу, но родителя нет — это корень.
        if (this._nodeIndex.has(nodeId)) return null;

        const found = this._findParentWalk(nodeId, this._indexRoot);
        if (found) {
            console.warn(`[AppState] findParentNode('${nodeId}'): промах индекса — найден полным обходом, индекс перестроен (пропущенная инвалидация)`);
            this._rebuildNodeIndex();
            return found;
        }
        return null;
    },

    /**
     * Рекурсивный поиск родителя (без индекса).
     * @private
     * @param {string} nodeId - ID дочернего узла
     * @param {Object} parent - Начальный узел
     * @returns {Object|null}
     */
    _findParentWalk(nodeId, parent) {
        if (!parent?.children) return null;

        for (const child of parent.children) {
            if (child.id === nodeId) return parent;

            const found = this._findParentWalk(nodeId, child);
            if (found) return found;
        }

        return null;
    },

    /**
     * Экспортирует состояние для отправки на бэкенд.
     * Read-only путь: обходы идут по raw-данным (без Proxy get-трапов),
     * результат — новые plain-объекты, исходное состояние не мутируется.
     * @returns {Object} Сериализованное состояние
     */
    exportData() {
        return {
            tree: this._serializeTree(_unwrap(this.treeData)),
            tables: this._serializeTables(),
            textBlocks: this._serializeTextBlocks(),
            violations: this._serializeViolations(),
            invoiceNodeIds: this._collectInvoiceNodeIds()
        };
    },

    /**
     * Собирает ID узлов, у которых есть прикреплённая фактура
     * @private
     * @returns {string[]} Массив ID узлов с фактурами
     */
    _collectInvoiceNodeIds() {
        const ids = [];
        const walk = (node) => {
            if (node.invoice) ids.push(node.id);
            if (node.children) node.children.forEach(walk);
        };
        const rawTree = _unwrap(this.treeData);
        if (rawTree) walk(rawTree);
        return ids;
    },

    /**
     * Сериализует дерево рекурсивно
     * @private
     * @param {Object} node - Узел для сериализации
     * @returns {Object} Сериализованный узел
     */
    _serializeTree(node) {
        const serialized = {
            id: node.id,
            label: node.label,
            type: node.type || AppConfig.nodeTypes.ITEM,
            protected: node.protected || false,
            deletable: node.deletable !== undefined ? node.deletable : true
        };

        // Добавляем ID связанного контента
        const {TABLE, TEXTBLOCK, VIOLATION} = AppConfig.nodeTypes;
        if (node.type === TABLE && node.tableId) {
            serialized.tableId = node.tableId;
        } else if (node.type === TEXTBLOCK && node.textBlockId) {
            serialized.textBlockId = node.textBlockId;
        } else if (node.type === VIOLATION && node.violationId) {
            serialized.violationId = node.violationId;
        } else {
            serialized.content = node.content || '';
        }

        // Дополнительные поля
        if (node.customLabel) serialized.customLabel = node.customLabel;
        if (node.number) serialized.number = node.number;
        if (node.tb?.length) serialized.tb = node.tb;
        if (node.auditPointId) serialized.auditPointId = node.auditPointId;

        // Спец-флаги опционального пункта Process Mining. Без сериализации после
        // reload терялись бы: special → _isUnderProcessMining переставал блокировать
        // нарушения/риски под пунктом; titleLocked → фиксация заголовка.
        if (node.special) serialized.special = node.special;
        if (node.titleLocked) serialized.titleLocked = node.titleLocked;

        // Подвид таблицы (источник истины — узел). Без него после reload
        // спецтаблицы деградируют до обычных (закрепление/каскад/защита).
        // 'regular' = отсутствие подвида — не сериализуется.
        const kind = getTableKind(node);
        if (kind !== KIND_REGULAR) serialized.kind = kind;

        // Рекурсивная сериализация детей
        serialized.children = node.children?.map(child => this._serializeTree(child)) || [];

        return serialized;
    },

    /**
     * Сериализует таблицы
     * @private
     * @returns {Object} Сериализованные таблицы
     */
    _serializeTables() {
        const serialized = {};

        for (const [tableId, table] of Object.entries(_unwrap(this.tables))) {
            serialized[tableId] = {
                id: table.id,
                nodeId: table.nodeId,
                grid: serializeGrid(table.grid),
                colWidths: table.colWidths || [],
                protected: table.protected || false,
                deletable: table.deletable !== undefined ? table.deletable : true
            };

            // Подвид kind: источник истины — узел таблицы. Если узел не
            // найден (рассинхрон) — fallback на kind самого объекта таблицы,
            // чтобы рантайм-подвид пережил round-trip. 'regular' не пишем.
            // Read-only lookup → raw-индекс, O(1) без Proxy.
            const node = this._findNodeRaw?.(table.nodeId);
            const tableKind = node ? getTableKind(node) : getTableKind(table);
            if (tableKind !== KIND_REGULAR) serialized[tableId].kind = tableKind;
        }

        return serialized;
    },

    /**
     * Сериализует текстовые блоки
     * @private
     * @returns {Object} Сериализованные текстовые блоки
     */
    _serializeTextBlocks() {
        const serialized = {};

        for (const [blockId, block] of Object.entries(_unwrap(this.textBlocks))) {
            // Форматирование целиком в inline-HTML content (директива владельца):
            // контейнерного объекта formatting больше нет.
            serialized[blockId] = {
                id: block.id,
                nodeId: block.nodeId,
                content: block.content || ''
            };
        }

        return serialized;
    },

    /**
     * Сериализует нарушения (блочная модель).
     *
     * Состав полей ГЕНЕРИРУЕТСЯ из реестра VIOLATION_FIELD_KEYS — новое поле
     * реестра попадает в payload автоматически (раньше здесь жил ручной
     * белый список литералами: поле вне списка молча терялось при
     * сохранении — топ-риск №1 карты сцеплений).
     * @private
     * @returns {Object} Сериализованные нарушения
     */
    _serializeViolations() {
        const serialized = {};

        for (const [violationId, violation] of Object.entries(_unwrap(this.violations))) {
            const out = {
                id: violation.id,
                nodeId: violation.nodeId,
                fieldOrder: Array.isArray(violation.fieldOrder)
                    ? [...violation.fieldOrder]
                    : null,
            };
            for (const key of VIOLATION_FIELD_KEYS) {
                const container = violation[key];
                out[key] = {
                    enabled: container?.enabled ?? MANDATORY_FIELD_KEYS.includes(key),
                    blocks: Array.isArray(container?.blocks)
                        ? container.blocks.map(block => this._serializeViolationBlock(block))
                        : [],
                };
            }
            serialized[violationId] = out;
        }

        return serialized;
    },

    /**
     * Сериализует ОДИН блок поля нарушения.
     *
     * Текст и картинка — плоские объекты хранимого формата, отдаются как есть.
     * Табличный блок пересобирается через serializeGrid: встроенная таблица
     * обслуживается той же машинерией, что узловые, и её ячейки несут
     * рантайм-поля (mergeSnapshot после объединения). Без пересборки первое же
     * объединение ячеек в нарушении отбило бы сохранение ВСЕГО акта 422
     * (TableCellSchema extra="forbid").
     * @private
     * @param {Object} block - Блок поля нарушения
     * @returns {Object} Блок в хранимом формате
     */
    _serializeViolationBlock(block) {
        if (!block || block.type !== BLOCK_TYPES.TABLE) return block;

        const table = block.table || {};
        return {
            ...block,
            table: {
                grid: serializeGrid(table.grid),
                colWidths: Array.isArray(table.colWidths) ? [...table.colWidths] : [],
            },
        };
    }
};

/**
 * Кеш уже обёрнутых объектов: target → proxy. Защищает от двойной обёртки
 * (ускоряет повторные get'ы) и от бесконечной рекурсии при циклических ссылках.
 * @private
 */
export const _stateProxyCache = new WeakMap();
export const _stateProxyOriginals = new WeakSet();

/**
 * Обратный маппинг proxy → target. Позволяет получить «сырой» объект из
 * прокси (_unwrap) за O(1) — нужен горячим read-путям (индекс узлов,
 * нумерация, сериализация) и set-трапу (в target кладём только raw).
 * @private
 */
export const _stateProxyTargets = new WeakMap();

/**
 * Флаг: deep-tracking AppState активирован (_wrapStateWithProxy выполнен).
 * В тестах/на portal-страницах false — read-API отдают raw-узлы как раньше.
 * @private
 */
let _stateTrackingActive = false;

export function _isStateTrackingActive() {
    return _stateTrackingActive;
}

export function _isTrackable(value) {
    if (value === null || typeof value !== 'object') return false;
    // Не оборачиваем DOM-узлы, Date, RegExp, Map, Set, Blob — у них собственная
    // семантика, прокси может сломать поведение. typeof-guard: в node-тестах
    // DOM-глобала Node нет, а _unwrap зовётся на пути индекса узлов.
    if (typeof Node !== 'undefined' && value instanceof Node) return false;
    if (value instanceof Date || value instanceof RegExp) return false;
    if (value instanceof Map || value instanceof Set || value instanceof WeakMap || value instanceof WeakSet) return false;
    return true;
}

export function _notifyDirty() {
    if (typeof StorageManager !== 'undefined' && StorageManager.markAsUnsaved) {
        StorageManager.markAsUnsaved();
    }
}

/**
 * Рекурсивно оборачивает объект в Proxy. Любая deep-мутация
 * (set/deleteProperty/Array.push/Array[i]=) вызывает markAsUnsaved().
 * @private
 */
export function _wrapDeep(value) {
    if (!_isTrackable(value)) return value;
    // Уже обёрнут — возвращаем тот же прокси (стабильность ссылок для ===).
    if (_stateProxyOriginals.has(value)) return value;
    const cached = _stateProxyCache.get(value);
    if (cached) return cached;

    const handler = {
        get(target, key, receiver) {
            const v = Reflect.get(target, key, receiver);
            // Lazy-wrap: оборачиваем nested при первом обращении.
            return _wrapDeep(v);
        },
        set(target, key, newValue, receiver) {
            const prev = target[key];
            // Прокси-новое: оборачиваем при следующем get (lazy), но в target
            // кладём raw — это сохраняет JSON.stringify семантику и
            // упрощает сравнения ===.
            const raw = _unwrap(newValue);
            const ok = Reflect.set(target, key, raw, receiver);
            if (ok && prev !== raw) {
                _notifyDirty();
            }
            return ok;
        },
        deleteProperty(target, key) {
            const had = Reflect.has(target, key);
            const ok = Reflect.deleteProperty(target, key);
            if (ok && had) {
                _notifyDirty();
            }
            return ok;
        },
    };

    const proxy = new Proxy(value, handler);
    _stateProxyCache.set(value, proxy);
    _stateProxyOriginals.add(proxy);
    _stateProxyTargets.set(proxy, value);
    return proxy;
}

/**
 * Возвращает «сырой» объект из proxy (для индекса узлов, сериализации,
 * JSON.stringify и т.п.) через обратный маппинг proxy → target за O(1).
 * На non-proxy значениях — no-op.
 * @private
 */
export function _unwrap(value) {
    if (!_isTrackable(value)) return value;
    const target = _stateProxyTargets.get(value);
    return target !== undefined ? target : value;
}

/**
 * Обёртка AppState: top-level свойства имеют сеттеры, которые помечают dirty И
 * lazy-оборачивают новое значение в рекурсивный Proxy. Все внутренние мутации
 * (`AppState.tables[id].cells[r][c] = ...`, `node.children.push(...)`, и др.)
 * автоматически попадают в `markAsUnsaved()`.
 *
 * Это закрывает регрессию C-PROXY: до фикса трекался только top-level reassign,
 * ~92% реальных правок проходили мимо dirty-tracking'а.
 * @private
 */
export function _wrapStateWithProxy() {
    // currentStep/selectedNode/selectedCells — чисто UI-состояние (не входят
    // в exportData()), их трекинг вызывал ложный dirty на любом клике/шаге.
    const trackedProperties = [
        'treeData',
        'tables',
        'textBlocks',
        'violations'
    ];

    trackedProperties.forEach(prop => {
        // Стартовое значение — оборачиваем сразу, чтобы deep-мутации работали
        // даже без явного reassign свойства.
        let internalValue = _wrapDeep(AppState[prop]);

        Object.defineProperty(AppState, prop, {
            get() {
                return internalValue;
            },
            set(newValue) {
                // Защита в глубину: сравниваем и по идентичности proxy, и по
                // сырому значению — top-level reassign тем же raw-объектом
                // (не литералом) не должен помечать dirty.
                if (internalValue === newValue || _unwrap(internalValue) === newValue) return;
                internalValue = _wrapDeep(newValue);
                _notifyDirty();
            },
            enumerable: true,
            configurable: true
        });
    });

    _stateTrackingActive = true;

    console.log('State proxy инициализирован (deep-tracking). Отслеживаются:', trackedProperties);
}

/**
 * Инициализирует отслеживание изменений состояния
 *
 * Вызывается автоматически после загрузки DOM и StorageManager.
 * Обертывает критичные свойства AppState для автоматического
 * вызова markAsUnsaved() при любых изменениях.
 */
export function _initStateTracking() {
    // Проверяем доступность StorageManager
    if (typeof StorageManager === 'undefined') {
        console.warn('StorageManager не найден. Автосохранение недоступно.');
        return;
    }

    // Инициализируем Proxy
    _wrapStateWithProxy();
}

// _initStateTracking() вызывается из entries/constructor.js, не из module-level:
// shared/api.js импортирует этот файл и через portal-common.js цепочка доходит
// до portal-страниц, где Proxy-обёртка AppState не нужна и не работает.

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.AppState = AppState;
