/**
 * Модуль управления контентом документа
 *
 * Управляет созданием и удалением таблиц, текстовых блоков и нарушений.
 * Обрабатывает специальные типы таблиц: метрики, регулярные и операционные риски.
 * Делегирует валидацию модулю ValidationTree.
 */

import { ChangelogTracker } from '../changelog-tracker.js';
import { AppState } from './state-core.js';
import { TreeUtils } from '../tree/tree-utils.js';
import { shouldHaveMetricsTable, shouldHaveMainMetrics, buildMetricsTableLabel } from './metrics-risk-core.js';
import { ValidationCore } from '../validation/validation-core.js';
import { ValidationTree } from '../validation/validation-tree.js';
import { AppConfig } from '../../shared/app-config.js';
import { getBlockType } from '../block-types.js';
import {
    KIND_MAIN_METRICS,
    KIND_METRICS,
    KIND_OPERATIONAL_RISK,
    KIND_OTHER_RISK,
    KIND_REGULAR_RISK,
    KIND_TAX_RISK,
} from '../table/table-kind.js';
import { createDefaultViolationShape } from '../violation/violation-normalize.js';

Object.assign(AppState, {
    /**
     * Добавляет таблицу к узлу дерева
     * @param {string} nodeId - ID узла для добавления
     * @param {number} [rows=3] - Количество строк данных (без заголовка)
     * @param {number} [cols=3] - Количество колонок
     * @returns {Object} Результат создания таблицы с полями valid, message
     */
    addTableToNode(nodeId, rows = 3, cols = 3) {
        const guard = ValidationCore.requireWrite('cannotAddContent');
        if (guard) return guard;

        const node = this.findNodeById(nodeId);

        const validation = ValidationTree.canAddContent(node, AppConfig.nodeTypes.TABLE);
        if (!validation.valid) return validation;

        const tableId = this._generateId('table');
        const tableNode = this._createContentNode(nodeId, tableId, AppConfig.nodeTypes.TABLE, '', false, true);

        node.children.push(tableNode);
        this._indexNodeAdded(tableNode, node);

        const headers = this._generateDefaultHeaders(cols);
        const grid = this._createTableGrid(rows, cols, headers);
        const table = this._createTableObject(tableId, tableNode.id, grid, cols, false, true);

        this.tables[tableId] = table;
        if (typeof ChangelogTracker !== 'undefined') {
            ChangelogTracker.record('add_table', tableId, 'Таблица', {nodeId});
        }
        this.generateNumbering();

        return ValidationCore.success();
    },

    /**
     * Генерирует заголовки колонок по умолчанию
     * @private
     * @param {number} cols - Количество колонок
     * @returns {string[]} Массив заголовков
     */
    _generateDefaultHeaders(cols) {
        return Array.from({length: cols}, (_, i) => `Колонка ${i + 1}`);
    },

    /**
     * Добавляет текстовый блок к узлу
     * @param {string} nodeId - ID узла для добавления
     * @returns {Object} Результат создания с полями valid, message
     */
    addTextBlockToNode(nodeId) {
        const guard = ValidationCore.requireWrite('cannotAddContent');
        if (guard) return guard;

        const node = this.findNodeById(nodeId);

        const validation = ValidationTree.canAddContent(node, AppConfig.nodeTypes.TEXTBLOCK);
        if (!validation.valid) return validation;

        const textBlockId = this._generateId('textblock');
        const textBlockNode = this._createContentNode(nodeId, textBlockId, AppConfig.nodeTypes.TEXTBLOCK);

        node.children.push(textBlockNode);
        this._indexNodeAdded(textBlockNode, node);

        const textBlock = this._createTextBlockObject(textBlockId, textBlockNode.id);

        this.textBlocks[textBlockId] = textBlock;
        if (typeof ChangelogTracker !== 'undefined') {
            ChangelogTracker.record('add_textblock', textBlockId, 'Текстовый блок', {nodeId});
        }
        this.generateNumbering();

        return ValidationCore.success();
    },

    /**
     * Добавляет нарушение к узлу
     * @param {string} nodeId - ID узла для добавления
     * @returns {Object} Результат создания с полями valid, message
     */
    addViolationToNode(nodeId) {
        const guard = ValidationCore.requireWrite('cannotAddContent');
        if (guard) return guard;

        if (this._isUnderProcessMining(nodeId)) {
            return ValidationCore.failure('В пункте «Process Mining» нельзя добавлять нарушения');
        }

        const node = this.findNodeById(nodeId);

        const validation = ValidationTree.canAddContent(node, AppConfig.nodeTypes.VIOLATION);
        if (!validation.valid) return validation;

        const violationId = this._generateId('violation');
        const violationNode = this._createContentNode(nodeId, violationId, AppConfig.nodeTypes.VIOLATION);

        node.children.push(violationNode);
        this._indexNodeAdded(violationNode, node);

        const violation = this._createViolationObject(violationId, violationNode.id);

        this.violations[violationId] = violation;
        if (typeof ChangelogTracker !== 'undefined') {
            ChangelogTracker.record('add_violation', violationId, 'Нарушение', {nodeId});
        }
        this.generateNumbering();

        return ValidationCore.success();
    },

    /**
     * Добавляет в раздел 2 таблицу «Результаты оценки качества процесса».
     *
     * Таблица создаётся автоматически при инициализации процессного акта, но
     * её можно удалить — этот мутатор возвращает её обратно (пункт
     * контекстного меню на разделе 2).
     * Идемпотентность: повторный вызов запрещён (проверяется по special).
     *
     * @returns {Object} Результат валидации
     */
    addQualityAssessmentTable() {
        const guard = ValidationCore.requireWrite('cannotAddContent');
        if (guard) return guard;

        const node = this.findNodeById('2');
        if (!node) {
            return ValidationCore.failure(AppConfig.tree.validation.nodeNotFound);
        }
        if (node.children?.some(c => c.special === 'quality_assessment')) {
            return ValidationCore.failure(
                'Таблица «Результаты оценки качества процесса» уже добавлена',
            );
        }

        const tableNode = this._createQualityAssessmentTable();
        if (!tableNode) {
            return ValidationCore.failure('Не удалось создать таблицу');
        }

        if (typeof ChangelogTracker !== 'undefined') {
            ChangelogTracker.record(
                'add_table', tableNode.tableId, tableNode.customLabel, {nodeId: '2'},
            );
        }
        this.generateNumbering();

        return ValidationCore.success();
    },

    /**
     * Создает узел контента (таблица, текстовый блок, нарушение)
     * @private
     * @param {string} parentId - ID родительского узла
     * @param {string} contentId - ID контента
     * @param {'table'|'textblock'|'violation'} type - Тип контента
     * @param {string} [label=''] - Название узла
     * @param {boolean} [isProtected=false] - Защита от изменений
     * @param {boolean} [deletable=true] - Возможность удаления
     * @returns {Object} Узел контента
     */
    _createContentNode(parentId, contentId, type, label = '', isProtected = false, deletable = true) {
        // Метка по умолчанию и поле-ссылка на словарь — из реестра типов блоков.
        const spec = getBlockType(type);

        const node = {
            id: `${parentId}_${type}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
            label: label || spec.defaultLabel,
            type,
            [spec.idProp]: contentId,
            parentId,
            protected: isProtected,
            deletable
        };

        if (label === '') {
            node.customLabel = '';
        } else if (label) {
            node.customLabel = label;
        }

        return node;
    },

    /**
     * Создает объект текстового блока с дефолтными настройками
     * @private
     * @param {string} textBlockId - ID текстового блока
     * @param {string} nodeId - ID узла
     * @returns {Object} Объект текстового блока
     */
    _createTextBlockObject(textBlockId, nodeId) {
        // Форматирование целиком живёт в inline-HTML content (директива
        // владельца): размер, выравнивание и начертание — в самом тексте,
        // контейнерного объекта formatting больше нет.
        return {
            id: textBlockId,
            nodeId,
            content: ''
        };
    },

    /**
     * Создает объект нарушения с дефолтными настройками
     * @private
     * @param {string} violationId - ID нарушения
     * @param {string} nodeId - ID узла
     * @returns {Object} Объект нарушения
     */
    _createViolationObject(violationId, nodeId) {
        // Эталонная дефолт-форма — единый источник с normalizeViolations (#20),
        // иначе два места с одинаковой формой дрейфуют друг от друга.
        return {
            id: violationId,
            nodeId,
            ...createDefaultViolationShape()
        };
    },

    /**
     * Создает таблицу метрик для пункта под разделом 5
     * @private
     * @param {string} nodeId - ID узла
     * @param {string} nodeNumber - Номер узла для подписи
     * @returns {Object} Результат создания
     */
    _createMetricsTable(nodeId, nodeNumber) {
        const node = this.findNodeById(nodeId);

        const validation = ValidationTree.canAddContent(node, AppConfig.nodeTypes.TABLE);
        if (!validation.valid) return validation;

        const tableId = this._generateId('table');
        // Каноническая авто-метка (единый источник с updateMetricsTableLabel).
        const tableLabel = buildMetricsTableLabel(nodeNumber);

        // Сводная таблица неудаляема вручную (deletable=false): guard deleteNode
        // блокирует её. Удаляется только автоматически каскадом при исчезновении рисков.
        const tableNode = this._createContentNode(nodeId, tableId, AppConfig.nodeTypes.TABLE, tableLabel, true, false);
        tableNode.kind = KIND_METRICS;

        node.children.unshift(tableNode);
        this._indexNodeAdded(tableNode, node);

        const grid = this._createMetricsHeaderGrid();
        const preset = AppConfig.content.tablePresets.metrics;

        const table = {
            id: tableId,
            nodeId: tableNode.id,
            grid,
            colWidths: preset.colWidths,
            protected: true,
            // Зеркалит deletable узла: сводная неудаляема вручную.
            deletable: false,
            kind: KIND_METRICS
        };

        this.tables[tableId] = table;
        return ValidationCore.success();
    },

    /**
     * Общая фабрика шапки сводной сетки (двухстрочный заголовок метрик +
     * пустые строки данных). Намеренно ОБЩАЯ для двух подвидов таблиц:
     *  - сводные метрики (`_createMetricsTable` / `_createMainMetricsTable`);
     *  - «Прочие риски» (`_createOtherRiskTable`) — шапка 1:1 со сводной.
     * Любая правка структуры шапки затрагивает оба подвида — это by design.
     * @private
     * @returns {Array<Array>} Сетка ячеек
     */
    _createMetricsHeaderGrid() {
        const grid = [];

        // Первая строка заголовков с объединением
        const headerRow1 = [
            {content: 'Код метрики', isHeader: true, colSpan: 1, rowSpan: 2, originRow: 0, originCol: 0},
            {content: 'Наименование метрики', isHeader: true, colSpan: 1, rowSpan: 2, originRow: 0, originCol: 1},
            {
                content: 'Количество клиентов / элементов, ед.',
                isHeader: true,
                colSpan: 2,
                rowSpan: 1,
                originRow: 0,
                originCol: 2
            },
            {
                content: '',
                isHeader: true,
                colSpan: 1,
                rowSpan: 1,
                isSpanned: true,
                spanOrigin: {row: 0, col: 2},
                originRow: 0,
                originCol: 3
            },
            {content: 'Сумма, руб.', isHeader: true, colSpan: 1, rowSpan: 2, originRow: 0, originCol: 4},
            {content: 'Код БП', isHeader: true, colSpan: 1, rowSpan: 2, originRow: 0, originCol: 5},
            {content: 'Пункт / подпункт акта', isHeader: true, colSpan: 1, rowSpan: 2, originRow: 0, originCol: 6}
        ];
        grid.push(headerRow1);

        // Вторая строка заголовков
        const headerRow2 = [
            {
                content: '',
                isHeader: true,
                colSpan: 1,
                rowSpan: 1,
                isSpanned: true,
                spanOrigin: {row: 0, col: 0},
                originRow: 1,
                originCol: 0
            },
            {
                content: '',
                isHeader: true,
                colSpan: 1,
                rowSpan: 1,
                isSpanned: true,
                spanOrigin: {row: 0, col: 1},
                originRow: 1,
                originCol: 1
            },
            {content: 'ФЛ', isHeader: true, colSpan: 1, rowSpan: 1, originRow: 1, originCol: 2},
            {content: 'ЮЛ', isHeader: true, colSpan: 1, rowSpan: 1, originRow: 1, originCol: 3},
            {
                content: '',
                isHeader: true,
                colSpan: 1,
                rowSpan: 1,
                isSpanned: true,
                spanOrigin: {row: 0, col: 4},
                originRow: 1,
                originCol: 4
            },
            {
                content: '',
                isHeader: true,
                colSpan: 1,
                rowSpan: 1,
                isSpanned: true,
                spanOrigin: {row: 0, col: 5},
                originRow: 1,
                originCol: 5
            },
            {
                content: '',
                isHeader: true,
                colSpan: 1,
                rowSpan: 1,
                isSpanned: true,
                spanOrigin: {row: 0, col: 6},
                originRow: 1,
                originCol: 6
            }
        ];
        grid.push(headerRow2);

        // Строки данных
        for (let r = 2; r < 4; r++) {
            grid.push(this._createDataRow(r, 7));
        }

        return grid;
    },

    /**
     * Создает главную таблицу метрик в разделе 5
     * @private
     * @returns {Object} Результат создания
     */
    _createMainMetricsTable() {
        const node5 = this.findNodeById('5');
        if (!node5) {
            return ValidationCore.failure(AppConfig.tree.validation.nodeNotFound);
        }

        const existingTable = node5.children?.find(
            child => child.type === AppConfig.nodeTypes.TABLE && child.kind === KIND_MAIN_METRICS
        );

        if (existingTable) {
            return ValidationCore.success('Таблица уже существует');
        }

        if (!node5.children) node5.children = [];

        const tableId = this._generateId('table');
        const tableLabel = 'Объем выявленных отклонений';

        // Главная сводная таблица неудаляема вручную (deletable=false).
        const tableNode = this._createContentNode('5', tableId, AppConfig.nodeTypes.TABLE, tableLabel, true, false);
        tableNode.kind = KIND_MAIN_METRICS;

        node5.children.unshift(tableNode);
        this._indexNodeAdded(tableNode, node5);

        const grid = this._createMetricsHeaderGrid();
        const preset = AppConfig.content.tablePresets.metrics;

        const table = {
            id: tableId,
            nodeId: tableNode.id,
            grid,
            colWidths: preset.colWidths,
            protected: true,
            // Зеркалит deletable узла: главная сводная неудаляема вручную.
            deletable: false,
            kind: KIND_MAIN_METRICS
        };

        this.tables[tableId] = table;
        return ValidationCore.success();
    },

    /**
     * Находит все таблицы рисков в поддереве
     * @private
     * @param {Object} node - Корневой узел поддерева
     * @returns {Array<Object>} Массив узлов таблиц рисков
     */
    _findRiskTablesInSubtree(node) {
        // E-4: делегируем единой утилите TreeUtils.findRiskTables.
        // Сама функция оставлена ради обратной совместимости с context-menu-tree.js
        // и state-tree.js, которые её зовут как AppState._findRiskTablesInSubtree.
        return TreeUtils.findRiskTables(node);
    },

    /**
     * Обновляет таблицы метрик после создания таблицы рисков
     * @private
     * @param {string} nodeId - ID узла с новой таблицей рисков
     */
    _updateMetricsTablesAfterRiskTableCreated(nodeId) {
        const node = this.findNodeById(nodeId);
        if (!node) return;

        // Находим узел первого уровня под пунктом 5
        let ancestorNode = node;
        let parentNode = this.findParentNode(ancestorNode.id);

        while (parentNode && parentNode.id !== '5') {
            ancestorNode = parentNode;
            parentNode = this.findParentNode(ancestorNode.id);
        }

        // Создаём таблицу метрик на 5.X ТОЛЬКО если риск на глубоком уровне (5.X.Y+).
        // Единый предикат (metrics-risk-core.shouldHaveMetricsTable).
        if (parentNode?.id === '5' && shouldHaveMetricsTable(ancestorNode, n => this._findRiskTablesInSubtree(n))) {
            const hasMetricsTable = ancestorNode.children?.some(
                child => child.type === AppConfig.nodeTypes.TABLE && child.kind === KIND_METRICS
            );

            if (!hasMetricsTable) {
                this._createMetricsTable(ancestorNode.id, ancestorNode.number);
            }
        }

        // Создаем главную таблицу метрик
        this._createMainMetricsTable();
        this.generateNumbering();
    },

    /**
     * Удаляет таблицы метрик после удаления таблицы рисков.
     * Параметр deletedNodeId был дед-кодом (не использовался внутри тела) — удалён.
     * Функция обходит весь раздел 5 и пересчитывает наличие метрик-таблиц.
     * @private
     */
    _cleanupMetricsTablesAfterRiskTableDeleted() {
        const node5 = this.findNodeById('5');
        if (!node5?.children) return;

        const {TABLE, ITEM} = AppConfig.nodeTypes;
        const findRisks = n => this._findRiskTablesInSubtree(n);
        const firstLevelNodes = node5.children.filter(child =>
            child.type === ITEM && child.number?.match(/^5\.\d+$/)
        );

        // Проверяем каждый узел первого уровня (единый предикат необходимости сводной).
        for (const firstLevelNode of firstLevelNodes) {
            if (!shouldHaveMetricsTable(firstLevelNode, findRisks)) {
                const metricsTableNode = firstLevelNode.children?.find(
                    child => child.type === TABLE && child.kind === KIND_METRICS
                );

                if (metricsTableNode) {
                    delete this.tables[metricsTableNode.tableId];
                    firstLevelNode.children = firstLevelNode.children.filter(
                        child => child.id !== metricsTableNode.id
                    );
                    this._unindexNodeRemoved(metricsTableNode);
                }
            }
        }

        // Проверяем необходимость главной таблицы метрик (единый предикат).
        if (!shouldHaveMainMetrics(node5, findRisks)) {
            const mainMetricsTableNode = node5.children?.find(
                child => child.type === TABLE && child.kind === KIND_MAIN_METRICS
            );

            if (mainMetricsTableNode) {
                delete this.tables[mainMetricsTableNode.tableId];
                node5.children = node5.children.filter(
                    child => child.id !== mainMetricsTableNode.id
                );
                this._unindexNodeRemoved(mainMetricsTableNode);
            }
        }

        this.generateNumbering();
    },

    /**
     * Создает таблицу регулярных рисков
     * @private
     * @param {string} nodeId - ID узла для добавления
     * @returns {Object} Результат создания
     */
    _createRegularRiskTable(nodeId) {
        const node = this.findNodeById(nodeId);

        const validation = ValidationTree.canAddContent(node, AppConfig.nodeTypes.TABLE);
        if (!validation.valid) return validation;

        const preset = AppConfig.content.tablePresets.regularRisk;
        const tableId = this._generateId('table');

        const tableNode = this._createContentNode(nodeId, tableId, AppConfig.nodeTypes.TABLE, preset.label, true, true);
        // E-2: подвид на node (структурное свойство), а не только на table-объекте.
        tableNode.kind = KIND_REGULAR_RISK;

        const insertIdx = this._getFirstNonPinnedIndex(node);
        node.children.splice(insertIdx, 0, tableNode);
        this._indexNodeAdded(tableNode, node);

        const grid = this._createTableGrid(preset.rows, preset.headers.length, preset.headers);

        const table = {
            id: tableId,
            nodeId: tableNode.id,
            grid,
            colWidths: preset.colWidths,
            protected: true,
            deletable: true,
            kind: KIND_REGULAR_RISK
        };

        this.tables[tableId] = table;
        return ValidationCore.success();
    },

    /**
     * Создает таблицу операционных рисков
     * @private
     * @param {string} nodeId - ID узла для добавления
     * @returns {Object} Результат создания
     */
    _createOperationalRiskTable(nodeId) {
        const node = this.findNodeById(nodeId);

        const validation = ValidationTree.canAddContent(node, AppConfig.nodeTypes.TABLE);
        if (!validation.valid) return validation;

        const preset = AppConfig.content.tablePresets.operationalRisk;
        const tableId = this._generateId('table');

        const tableNode = this._createContentNode(nodeId, tableId, AppConfig.nodeTypes.TABLE, preset.label, true, true);
        // E-2: подвид на node.
        tableNode.kind = KIND_OPERATIONAL_RISK;

        const insertIdx = this._getFirstNonPinnedIndex(node);
        node.children.splice(insertIdx, 0, tableNode);
        this._indexNodeAdded(tableNode, node);

        const grid = this._createOperationalRiskGrid();

        const table = {
            id: tableId,
            nodeId: tableNode.id,
            grid,
            colWidths: preset.colWidths,
            protected: true,
            deletable: true,
            kind: KIND_OPERATIONAL_RISK
        };

        this.tables[tableId] = table;
        return ValidationCore.success();
    },

    /**
     * Создает сетку таблицы операционных рисков с объединенными ячейками
     * @private
     * @returns {Array<Array>} Сетка ячеек
     */
    _createOperationalRiskGrid() {
        const grid = [];

        // Первая строка заголовков
        const headerRow1 = [
            {content: 'ОР', isHeader: true, colSpan: 1, rowSpan: 1, originRow: 0, originCol: 0},
            {
                content: 'Отклонения с признаками операционного риска (далее - ОР)',
                isHeader: true,
                colSpan: 5,
                rowSpan: 1,
                originRow: 0,
                originCol: 1
            },
            {
                content: '',
                isHeader: true,
                colSpan: 1,
                rowSpan: 1,
                isSpanned: true,
                spanOrigin: {row: 0, col: 1},
                originRow: 0,
                originCol: 2
            },
            {
                content: '',
                isHeader: true,
                colSpan: 1,
                rowSpan: 1,
                isSpanned: true,
                spanOrigin: {row: 0, col: 1},
                originRow: 0,
                originCol: 3
            },
            {
                content: '',
                isHeader: true,
                colSpan: 1,
                rowSpan: 1,
                isSpanned: true,
                spanOrigin: {row: 0, col: 1},
                originRow: 0,
                originCol: 4
            },
            {
                content: '',
                isHeader: true,
                colSpan: 1,
                rowSpan: 1,
                isSpanned: true,
                spanOrigin: {row: 0, col: 1},
                originRow: 0,
                originCol: 5
            }
        ];
        grid.push(headerRow1);

        // Вторая строка заголовков
        const headerRow2 = [
            {content: 'Код процесса', isHeader: true, colSpan: 1, rowSpan: 1, originRow: 1, originCol: 0},
            {content: 'Блок - владелец процесса', isHeader: true, colSpan: 1, rowSpan: 1, originRow: 1, originCol: 1},
            {
                content: 'Тип рискового события (уровень 2)',
                isHeader: true,
                colSpan: 1,
                rowSpan: 1,
                originRow: 1,
                originCol: 2
            },
            {content: 'Оценка суммы события, руб', isHeader: true, colSpan: 1, rowSpan: 1, originRow: 1, originCol: 3},
            {content: 'Подтип и сумма последствия', isHeader: true, colSpan: 2, rowSpan: 1, originRow: 1, originCol: 4},
            {
                content: '',
                isHeader: true,
                colSpan: 1,
                rowSpan: 1,
                isSpanned: true,
                spanOrigin: {row: 1, col: 4},
                originRow: 1,
                originCol: 5
            }
        ];
        grid.push(headerRow2);

        // Строки данных
        for (let r = 2; r < 4; r++) {
            grid.push(this._createDataRow(r, 6));
        }

        return grid;
    },

    /**
     * Создаёт таблицу налоговых рисков.
     * Шапка двухслойная (как у operational risk): одна объединённая ячейка
     * «Выявлены налоговые риски» сверху + 6 колонок-заголовков снизу.
     * Тело — обычные пустые редактируемые ячейки (без фикс. строк «Недоплата/Переплата»).
     * @private
     * @param {string} nodeId
     * @returns {Object} результат ValidationCore.success()/failure()
     */
    _createTaxRiskTable(nodeId) {
        const node = this.findNodeById(nodeId);

        const validation = ValidationTree.canAddContent(node, AppConfig.nodeTypes.TABLE);
        if (!validation.valid) return validation;

        const preset = AppConfig.content.tablePresets.taxRisk;
        const tableId = this._generateId('table');

        const tableNode = this._createContentNode(nodeId, tableId, AppConfig.nodeTypes.TABLE, preset.label, true, true);
        tableNode.kind = KIND_TAX_RISK;

        const insertIdx = this._getFirstNonPinnedIndex(node);
        node.children.splice(insertIdx, 0, tableNode);
        this._indexNodeAdded(tableNode, node);

        const grid = this._createTaxRiskGrid();

        const table = {
            id: tableId,
            nodeId: tableNode.id,
            grid,
            colWidths: preset.colWidths,
            protected: true,
            deletable: true,
            kind: KIND_TAX_RISK
        };

        this.tables[tableId] = table;
        return ValidationCore.success();
    },

    /**
     * Строит сетку таблицы налоговых рисков.
     * row1: объединённая «Выявлены налоговые риски» (colSpan=6).
     * row2: 6 колонок-заголовков.
     * Далее 2 строки пустых текстовых ячеек.
     * @private
     * @returns {Array<Array>}
     */
    _createTaxRiskGrid() {
        const grid = [];

        const headerRow1 = [
            {content: 'Выявлены налоговые риски', isHeader: true, colSpan: 6, rowSpan: 1, originRow: 0, originCol: 0}
        ];
        for (let c = 1; c < 6; c++) {
            headerRow1.push({
                content: '',
                isHeader: true,
                colSpan: 1,
                rowSpan: 1,
                isSpanned: true,
                spanOrigin: {row: 0, col: 0},
                originRow: 0,
                originCol: c
            });
        }
        grid.push(headerRow1);

        const headerRow2 = [
            {content: 'Код процесса (номер-название)', isHeader: true, colSpan: 1, rowSpan: 1, originRow: 1, originCol: 0},
            {content: 'Клиентский путь (номер-название)', isHeader: true, colSpan: 1, rowSpan: 1, originRow: 1, originCol: 1},
            {content: 'Наименование нормативно-правового акта (НПА), который был нарушен', isHeader: true, colSpan: 1, rowSpan: 1, originRow: 1, originCol: 2},
            {content: 'Статья/пункт НПА', isHeader: true, colSpan: 1, rowSpan: 1, originRow: 1, originCol: 3},
            {content: 'Налоговые последствия', isHeader: true, colSpan: 1, rowSpan: 1, originRow: 1, originCol: 4},
            {content: 'Сумма последствий, руб.', isHeader: true, colSpan: 1, rowSpan: 1, originRow: 1, originCol: 5}
        ];
        grid.push(headerRow2);

        // Тело: 2 пустые строки.
        for (let r = 2; r < 4; r++) {
            grid.push(this._createDataRow(r, 6));
        }

        return grid;
    },

    /**
     * Создаёт таблицу «Прочие риски». Шапка и сетка 1:1 со сводной таблицей метрик
     * (использует общий конструктор `_createMetricsHeaderGrid`), но НЕ автогенерируется
     * `metrics-risk-coordinator`-ом, НЕ агрегирует данные дочерних метрик и НЕ
     * влияет на иерархию пунктов под разделом 5.
     * @private
     * @param {string} nodeId
     * @returns {Object} результат ValidationCore.success()/failure()
     */
    _createOtherRiskTable(nodeId) {
        const node = this.findNodeById(nodeId);

        const validation = ValidationTree.canAddContent(node, AppConfig.nodeTypes.TABLE);
        if (!validation.valid) return validation;

        const metricsPreset = AppConfig.content.tablePresets.metrics;
        const otherPreset = AppConfig.content.tablePresets.otherRisk;
        const tableId = this._generateId('table');

        const tableNode = this._createContentNode(nodeId, tableId, AppConfig.nodeTypes.TABLE, otherPreset.label, true, true);
        tableNode.kind = KIND_OTHER_RISK;

        const insertIdx = this._getFirstNonPinnedIndex(node);
        node.children.splice(insertIdx, 0, tableNode);
        this._indexNodeAdded(tableNode, node);

        // Явно переиспользуем общую шапку метрик: «прочие риски» намеренно
        // имеют ту же сводную сетку (см. docstring _createMetricsHeaderGrid).
        const grid = this._createMetricsHeaderGrid();

        const table = {
            id: tableId,
            nodeId: tableNode.id,
            grid,
            colWidths: metricsPreset.colWidths,
            protected: true,
            deletable: true,
            kind: KIND_OTHER_RISK
        };

        this.tables[tableId] = table;
        return ValidationCore.success();
    }
});
