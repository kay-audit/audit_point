/**
 * Менеджер отрисовки элементов.
 * Координирует рендеринг всех типов элементов документа: обычных пунктов,
 * таблиц, текстовых блоков и нарушений. DOM строится из AppState; обратной
 * синхронизации DOM→state нет — данные пишут live-обработчики ввода
 * (write-through ячеек, input/blur текстблоков и нарушений).
 */
import { ItemsTitleEditing } from './items-title-editing.js';
import { RENDER_CLASSES } from '../render-classes.js';
import { AppState, _unwrap } from '../state/state-core.js';
import { TreeUtils } from '../tree/tree-utils.js';
import { AppConfig } from '../../shared/app-config.js';
import { getBlockType, isLeafBlockType } from '../block-types.js';
import { ChatEventBus } from '../../shared/chat/chat-event-bus.js';
import { Notifications } from '../../shared/notifications.js';
import { createTableElement } from '../table/table-render.js';
import { shouldShowTableTitle, tableTitleText } from '../table/table-title.js';
import { tableManager } from '../table/table-core.js';
import { textBlockManager } from '../textblock/textblock-core.js';
import { violationManager } from '../violation/violation-init.js';

export class ItemsRenderer {
    /**
     * Индекс адресуемых DOM-узлов: id -> HTMLElement.
     * Заполняется в _createItemContainer / renderTable / при отрисовке textblock/violation.
     * Очищается в начале renderAll() и при удалении узлов через updateItem с отсутствующим node.
     * Используется per-node API (updateItem/updateTable/updateTextBlock/updateViolation/updateNodeTitle)
     * для адресного апдейта без пересборки всего поддерева.
     * @type {Map<string, HTMLElement>}
     */
    static _domIndex = new Map();

    /**
     * Полная отрисовка всех элементов из дерева документа в контейнер.
     * Очищает предыдущее содержимое, рендерит структуру заново,
     * привязывает события и восстанавливает сохраненные размеры таблиц.
     */
    static renderAll() {
        const container = document.getElementById('itemsContainer');
        if (!container) return;

        // Дропдаун ТБ живёт в document.body и переживает innerHTML='' —
        // закрываем явно, иначе утекает он сам и его document-слушатель.
        this._closeTbDropdownInItems();
        this._domIndex.clear();
        container.innerHTML = '';
        tableManager.clearSelection();

        // Read-only обход — по raw-дереву (renderItem сам unwrap'ает узлы);
        // write-замыкания получают tracked-узлы точечно.
        const rawTree = _unwrap(AppState.treeData);
        if (rawTree?.children) {
            rawTree.children.forEach(item => {
                container.appendChild(this.renderItem(item, 1));
            });
        }

        tableManager.attachEventListeners();

        // TREE-1: сквозная нумерация сносок по всем редакторам листа единым
        // проходом (в т.ч. read-only) — иначе после полного рендера номера пусты
        // до фокуса. Централизованно здесь, НЕ в каждом createEditor (иначе O(N²)).
        textBlockManager.renumberAllFootnotes();
    }

    /**
     * Per-node API: пересоздаёт DOM поддерева одного item-узла адресно, без renderAll.
     * Используется после структурных изменений в пределах одного узла (add/delete child, move).
     * Fallback на renderAll если узел не найден в _domIndex или в AppState.
     * @param {string} nodeId - ID узла дерева для обновления
     */
    static updateItem(nodeId) {
        if (!nodeId) return this.renderAll();

        const oldEl = this._domIndex.get(`item:${nodeId}`);
        const node = AppState.findNodeById(nodeId);

        if (!oldEl || !node || !oldEl.parentNode) {
            console.warn('[ItemsRenderer.updateItem] узел не найден в _domIndex или AppState, fallback на renderAll:', nodeId);
            return this.renderAll();
        }

        // Заменяемое поддерево может содержать бейдж-якорь открытого дропдауна ТБ —
        // закрываем дропдаун (он в document.body) вместе с его document-слушателем.
        this._closeTbDropdownInItems();

        // Чистим индекс по всему поддереву старого DOM перед заменой
        this._purgeSubtreeFromIndex(oldEl);

        // Определяем level из CSS-класса item-block (level-N)
        const levelMatch = (oldEl.className.match(/level-(\d+)/) || [null, '1']);
        const level = parseInt(levelMatch[1], 10) || 1;

        const newEl = this.renderItem(node, level);
        oldEl.parentNode.replaceChild(newEl, oldEl);

        // Восстанавливаем listeners только в новом поддереве; ширины колонок
        // рендерятся из colWidths через colgroup, отдельное восстановление не нужно.
        tableManager.attachEventListenersToContainer(newEl);

        // TREE-1: пересборка поддерева пересоздаёт входящие в него текстблок-
        // редакторы (номера сносок — рантайм-атрибут, теряются), а удаление/
        // перенос блока со сносками сдвигает сквозную нумерацию последующих —
        // перенумеровываем весь лист единым проходом (как превью после патча).
        textBlockManager.renumberAllFootnotes();
    }

    /**
     * Per-node API: пересоздаёт только указанную table-section, сохраняя размеры колонок/строк.
     * @param {string} tableId - ID таблицы
     */
    static updateTable(tableId) {
        if (!tableId) return this.renderAll();

        // replaceChild оставил бы в selectedCells detached-ячейки старой
        // section (операции по ним читают устаревшие координаты) — снимаем
        // выделение, как это делает renderAll. Закрывает в т.ч. путь ресайза
        // колонок (TableSizes._commitColWidths завершается updateTable).
        tableManager.clearSelection();

        const oldSection = this._domIndex.get(`table:${tableId}`);
        const table = AppState.tables[tableId];

        if (!oldSection || !table || !oldSection.parentNode) {
            console.warn('[ItemsRenderer.updateTable] таблица не найдена в _domIndex или AppState, fallback на renderAll:', tableId);
            return this.renderAll();
        }

        const tableNode = AppState.findNodeById(table.nodeId);
        if (!tableNode) return this.renderAll();

        const newSection = this.renderTable(table, tableNode);
        oldSection.parentNode.replaceChild(newSection, oldSection);
        this._domIndex.set(`table:${tableId}`, newSection);

        tableManager.attachEventListenersToContainer(newSection);
    }

    /**
     * Per-node API: пересоздаёт textblock-секцию для одного блока.
     * @param {string} textBlockId - ID текстового блока
     */
    static updateTextBlock(textBlockId) {
        if (!textBlockId) return this.renderAll();

        const oldEl = this._domIndex.get(`textblock:${textBlockId}`);
        const textBlock = AppState.textBlocks[textBlockId];

        if (!oldEl || !textBlock || !oldEl.parentNode) {
            console.warn('[ItemsRenderer.updateTextBlock] блок не найден, fallback на renderAll:', textBlockId);
            return this.renderAll();
        }

        // Находим связанный node — textBlock.nodeId хранится в данных
        const nodeId = textBlock.nodeId;
        const node = nodeId ? AppState.findNodeById(nodeId) : null;
        if (!node) return this.renderAll();

        const newEl = textBlockManager.createTextBlockElement(textBlock, node);
        oldEl.parentNode.replaceChild(newEl, oldEl);
        this._domIndex.set(`textblock:${textBlockId}`, newEl);

        // TREE-1: пересозданный блок теряет номера сносок (рантайм-атрибут), а
        // смена их числа сдвигает сквозную нумерацию последующих блоков —
        // перенумеровываем весь лист единым проходом.
        textBlockManager.renumberAllFootnotes();
    }

    /**
     * Per-node API: пересоздаёт violation-секцию для одного нарушения.
     * @param {string} violationId - ID нарушения
     */
    static updateViolation(violationId) {
        if (!violationId) return this.renderAll();

        const oldEl = this._domIndex.get(`violation:${violationId}`);
        const violation = AppState.violations[violationId];

        if (!oldEl || !violation || !oldEl.parentNode) {
            console.warn('[ItemsRenderer.updateViolation] нарушение не найдено, fallback на renderAll:', violationId);
            return this.renderAll();
        }

        const nodeId = violation.nodeId;
        const node = nodeId ? AppState.findNodeById(nodeId) : null;
        if (!node) return this.renderAll();

        const newEl = violationManager.createViolationElement(violation, node);
        oldEl.parentNode.replaceChild(newEl, oldEl);
        this._domIndex.set(`violation:${violationId}`, newEl);
    }

    /**
     * Лёгкая версия per-node API: обновляет ТОЛЬКО текст заголовка пункта.
     * Дешевле updateItem — не пересоздаёт DOM-поддерево, не перепривязывает listeners.
     * @param {string} nodeId - ID узла
     * @param {string} newTitle - Новый текст заголовка
     */
    static updateNodeTitle(nodeId, newTitle) {
        const itemEl = this._domIndex.get(`item:${nodeId}`);
        if (!itemEl) {
            console.warn('[ItemsRenderer.updateNodeTitle] узел не найден в _domIndex:', nodeId);
            return;
        }

        const textSpan = itemEl.querySelector(':scope > .item-header .item-title-text');
        if (textSpan) {
            textSpan.textContent = newTitle;
        }
    }

    /**
     * Удаляет все ключи _domIndex для DOM-поддерева — вызывается перед replaceChild
     * на старом элементе, чтобы индекс не содержал «висячих» ссылок.
     * @param {HTMLElement} rootEl
     * @private
     */
    static _purgeSubtreeFromIndex(rootEl) {
        // item-block элементы
        rootEl.querySelectorAll('.item-block').forEach(el => {
            const id = el.dataset.nodeId;
            if (id) this._domIndex.delete(`item:${id}`);
        });
        if (rootEl.matches && rootEl.matches('.item-block') && rootEl.dataset.nodeId) {
            this._domIndex.delete(`item:${rootEl.dataset.nodeId}`);
        }
        // table-section
        rootEl.querySelectorAll('.table-section').forEach(el => {
            const id = el.dataset.tableId;
            if (id) this._domIndex.delete(`table:${id}`);
        });
        // textblock-section / textblock-editor (ищем по data-атрибуту: он есть у обоих)
        rootEl.querySelectorAll('[data-text-block-id]').forEach(el => {
            const id = el.dataset.textBlockId;
            if (id) this._domIndex.delete(`textblock:${id}`);
        });
        // violation-section
        rootEl.querySelectorAll(`.${RENDER_CLASSES.VIOLATION_SECTION}`).forEach(el => {
            const id = el.dataset.violationId;
            if (id) this._domIndex.delete(`violation:${id}`);
        });
    }

    /**
     * Render-обработчики листовых блоков: тип из реестра → создание DOM-элемента.
     * Сами render-методы живут в своих модулях (renderTable / textBlockManager /
     * violationManager) — здесь только маппинг для диспетча renderItem.
     * Полнота покрытия leaf-типов реестра закреплена tests/js/block-types.test.mjs.
     * @type {Object<string, function(Object, Object): HTMLElement>}
     */
    static _leafRenderers = {
        [AppConfig.nodeTypes.TABLE]: (data, node) => ItemsRenderer.renderTable(data, node),
        [AppConfig.nodeTypes.TEXTBLOCK]: (data, node) => textBlockManager.createTextBlockElement(data, node),
        [AppConfig.nodeTypes.VIOLATION]: (data, node) => violationManager.createViolationElement(data, node),
    };

    /**
     * Рекурсивная отрисовка элемента дерева с обработкой различных типов узлов.
     * Листовые блоки (таблица, текстовый блок, нарушение) диспетчатся через
     * реестр типов (block-types.js): словарь, поле-ссылка и префикс _domIndex
     * берутся из описания типа, создание элемента — из _leafRenderers.
     * @param {Object} node - Узел дерева для отрисовки
     * @param {number} level - Уровень вложенности (определяет размер заголовка)
     * @returns {HTMLElement} Созданный DOM-элемент с содержимым узла
     */
    static renderItem(node, level) {
        // Горячий read-путь: обход по raw-узлу (updateItem может передать proxy).
        node = _unwrap(node);
        const itemDiv = this._createItemContainer(node, level);

        const spec = getBlockType(node.type);
        if (spec && spec.idProp) {
            const data = AppState[spec.dictName][node[spec.idProp]];
            if (data) {
                const el = this._leafRenderers[spec.type](data, node);
                itemDiv.appendChild(el);
                this._domIndex.set(`${spec.domIndexPrefix}:${data.id}`, el);
            }
            return itemDiv;
        }

        // Отрисовка обычного пункта
        this._renderRegularItem(itemDiv, node, level);
        return itemDiv;
    }

    /**
     * Создает базовый контейнер для элемента с идентификаторами.
     * @param {Object} node - Узел дерева
     * @param {number} level - Уровень вложенности
     * @returns {HTMLElement} Контейнер элемента
     * @private
     */
    static _createItemContainer(node, level) {
        const itemDiv = document.createElement('div');
        itemDiv.className = `item-block level-${level}`;
        itemDiv.dataset.nodeId = node.id;
        this._domIndex.set(`item:${node.id}`, itemDiv);
        return itemDiv;
    }

    /**
     * Отрисовка обычного пункта документа с заголовком и дочерними элементами.
     * @param {HTMLElement} itemDiv - Контейнер элемента
     * @param {Object} node - Узел дерева
     * @param {number} level - Уровень вложенности
     * @private
     */
    static _renderRegularItem(itemDiv, node, level) {
        const header = this._createItemHeader(node, level);
        itemDiv.appendChild(header);

        if (node.children?.length > 0) {
            itemDiv.appendChild(this._renderChildren(node.children, level));
        }
    }

    /**
     * Создает заголовок пункта с возможностью редактирования.
     * Для незащищенных элементов добавляет обработчик двойного клика.
     * @param {Object} node - Узел дерева
     * @param {number} level - Уровень вложенности
     * @returns {HTMLElement} Заголовок пункта
     * @private
     */
    static _createItemHeader(node, level) {
        const header = document.createElement('div');
        header.className = 'item-header';

        const title = document.createElement(`h${Math.min(level + 1, 6)}`);
        title.className = 'item-title';

        // Номер — нередактируемый
        if (node.number) {
            const numberSpan = document.createElement('span');
            numberSpan.className = 'item-number';
            numberSpan.textContent = node.number + '. ';
            title.appendChild(numberSpan);
        }

        // Текст заголовка — редактируемый
        const textSpan = document.createElement('span');
        textSpan.className = 'item-title-text';
        textSpan.textContent = node.label;
        title.appendChild(textSpan);

        if (!node.protected) {
            // Tracked-узел: замыкание редактирования пишет node.label,
            // запись обязана ловиться markAsUnsaved.
            this._setupTitleEditing(textSpan, AppState._trackedNode(node));
        }

        header.appendChild(title);

        // Селектор ТБ для узлов под разделом 5
        if (TreeUtils.isUnderSection5(node)) {
            header.appendChild(this._createTbSelector(node));
        }

        return header;
    }

    /**
     * Настраивает редактирование заголовка по двойному клику.
     * Нативное событие dblclick — браузер сам различает одиночный/двойной клик
     * (раньше это эмулировал ручной 300мс таймер).
     * @param {HTMLElement} title - Элемент заголовка
     * @param {Object} node - Узел дерева
     * @private
     */
    static _setupTitleEditing(textSpan, node) {
        textSpan.addEventListener('dblclick', () => {
            ItemsTitleEditing.startEditingItemTitle(textSpan, node);
        });

        textSpan.style.cursor = 'pointer';
    }

    /**
     * Создает селектор ТБ для узла на Шаге 2
     * @param {Object} node - Узел дерева
     * @returns {HTMLElement} Контейнер с селектором ТБ
     * @private
     */
    static _createTbSelector(node) {
        const container = document.createElement('div');
        container.className = 'tb-selector';

        const label = document.createElement('span');
        label.className = 'tb-selector-label';
        label.textContent = 'ТБ:';
        container.appendChild(label);

        const isLeaf = TreeUtils.isTbLeaf(node);

        if (isLeaf) {
            // Кликабельный бейдж (аналогично tree-renderer)
            const badge = document.createElement('span');
            const tbList = node.tb || [];

            if (tbList.length > 0) {
                badge.className = 'tb-selector-badge tb-selector-badge--assigned';
                badge.textContent = tbList.join(', ');
                badge.title = tbList.map(abbr => {
                    const bank = AppConfig.territorialBanks.find(b => b.abbr === abbr);
                    return bank ? `${bank.name} (${abbr})` : abbr;
                }).join(', ');
            } else {
                badge.className = 'tb-selector-badge tb-selector-badge--empty';
                badge.textContent = 'Выбрать';
                badge.title = 'Назначить территориальный банк';
            }

            if (!AppConfig.readOnlyMode?.isReadOnly) {
                badge.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this._showTbDropdownInItems(badge, node);
                });
            }

            container.appendChild(badge);
        } else {
            // Read-only для не-leaf: показываем вычисленные ТБ
            const computed = TreeUtils.getComputedTb(node);
            if (computed.length > 0) {
                const badgesContainer = document.createElement('div');
                badgesContainer.className = 'tb-selector-badges';

                computed.forEach(abbr => {
                    const b = document.createElement('span');
                    b.className = 'tb-selector-badge tb-selector-badge--computed';
                    b.textContent = abbr;
                    const bank = AppConfig.territorialBanks.find(x => x.abbr === abbr);
                    if (bank) b.title = bank.name;
                    badgesContainer.appendChild(b);
                });

                container.appendChild(badgesContainer);
            } else {
                const empty = document.createElement('span');
                empty.className = 'tb-selector-empty';
                empty.textContent = 'не назначен';
                container.appendChild(empty);
            }
        }

        return container;
    }

    /**
     * Показывает дропдаун для выбора ТБ на Шаге 2
     * @param {HTMLElement} badge - Элемент бейджа
     * @param {Object} node - Узел дерева
     * @private
     */
    static _showTbDropdownInItems(badge, node) {
        // Закрываем предыдущий дропдаун
        this._closeTbDropdownInItems();

        const dropdown = document.createElement('div');
        dropdown.className = 'tb-dropdown';
        const currentTb = node.tb || [];

        AppConfig.territorialBanks.forEach(bank => {
            const item = document.createElement('label');
            item.className = 'tb-dropdown-item';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = currentTb.includes(bank.abbr);
            checkbox.addEventListener('change', () => {
                // Единая точка записи ТБ + changelog + 'node:tb-changed' событие.
                // Бейджи в items и в дереве обновляют подписчики на событие.
                AppState.setNodeTb(node.id, bank.abbr, checkbox.checked);
            });

            const nameSpan = document.createElement('span');
            nameSpan.className = 'tb-dropdown-item-name';
            nameSpan.textContent = bank.name;

            const abbrSpan = document.createElement('span');
            abbrSpan.className = 'tb-dropdown-item-abbr';
            abbrSpan.textContent = bank.abbr;

            item.appendChild(checkbox);
            item.appendChild(nameSpan);
            item.appendChild(abbrSpan);
            dropdown.appendChild(item);
        });

        document.body.appendChild(dropdown);
        const rect = badge.getBoundingClientRect();
        dropdown.style.top = `${rect.bottom + 4}px`;
        dropdown.style.left = `${rect.left}px`;

        // Корректировка позиции
        const dRect = dropdown.getBoundingClientRect();
        if (dRect.right > window.innerWidth) {
            dropdown.style.left = `${window.innerWidth - dRect.width - 8}px`;
        }
        if (dRect.bottom > window.innerHeight) {
            dropdown.style.top = `${rect.top - dRect.height - 4}px`;
        }

        const closeHandler = (e) => {
            if (!dropdown.contains(e.target) && e.target !== badge) {
                this._closeTbDropdownInItems();
                document.removeEventListener('mousedown', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', closeHandler), 0);

        this._currentTbDropdown = dropdown;
        this._currentTbCloseHandler = closeHandler;
    }

    /**
     * Закрывает текущий дропдаун ТБ на Шаге 2
     * @private
     */
    static _closeTbDropdownInItems() {
        if (this._currentTbDropdown) {
            this._currentTbDropdown.remove();
            this._currentTbDropdown = null;
        }
        if (this._currentTbCloseHandler) {
            document.removeEventListener('mousedown', this._currentTbCloseHandler);
            this._currentTbCloseHandler = null;
        }
    }

    /**
     * Обновляет бейдж ТБ на Шаге 2 после изменения
     * @param {HTMLElement} badge - Элемент бейджа
     * @param {Object} node - Узел дерева
     * @private
     */
    static _updateTbBadgeInItems(badge, node) {
        const tbList = node.tb || [];
        if (tbList.length > 0) {
            badge.className = 'tb-selector-badge tb-selector-badge--assigned';
            badge.textContent = tbList.join(', ');
            badge.title = tbList.map(abbr => {
                const bank = AppConfig.territorialBanks.find(b => b.abbr === abbr);
                return bank ? `${bank.name} (${abbr})` : abbr;
            }).join(', ');
        } else {
            badge.className = 'tb-selector-badge tb-selector-badge--empty';
            badge.textContent = 'Выбрать';
            badge.title = 'Назначить территориальный банк';
        }
    }

    /**
     * Обновляет TB-селекторы родительских узлов на Шаге 2
     * @param {Object} node - Узел дерева
     * @private
     */
    static _updateParentTbInItems(node) {
        let parent = AppState.findParentNode(node.id);
        while (parent && parent.id !== 'root') {
            if (TreeUtils.isUnderSection5(parent)) {
                const parentBlock = document.querySelector(`.item-block[data-node-id="${parent.id}"]`);
                if (parentBlock) {
                    const oldSelector = parentBlock.querySelector(':scope > .item-header .tb-selector');
                    if (oldSelector) {
                        const newSelector = this._createTbSelector(parent);
                        oldSelector.replaceWith(newSelector);
                    }
                }
            }
            parent = AppState.findParentNode(parent.id);
        }
    }

    /**
     * Рекурсивная отрисовка дочерних элементов.
     * Для таблиц, текстовых блоков и нарушений не увеличивает уровень вложенности.
     * @param {Array} children - Массив дочерних узлов
     * @param {number} parentLevel - Уровень родительского элемента
     * @returns {HTMLElement} Контейнер с дочерними элементами
     * @private
     */
    static _renderChildren(children, parentLevel) {
        const childrenDiv = document.createElement('div');
        childrenDiv.className = 'item-children';

        children.forEach(child => {
            const childLevel = isLeafBlockType(child.type) ? parentLevel : parentLevel + 1;
            childrenDiv.appendChild(this.renderItem(child, childLevel));
        });

        return childrenDiv;
    }

    /**
     * Визуализация таблицы для документа.
     * Создает секцию с заголовком (если есть customLabel) и саму таблицу.
     * @param {Object} table - Данные таблицы из AppState.tables
     * @param {Object} node - Узел дерева таблицы
     * @returns {HTMLElement} Блок секции таблицы
     */
    static renderTable(table, node) {
        const section = document.createElement('div');
        section.className = 'table-section';
        section.dataset.tableId = table.id;

        // Единый с превью и DOCX предикат показа заголовка (render-8).
        if (shouldShowTableTitle(node)) {
            section.appendChild(this._createTableTitle(table, node));
        }

        section.appendChild(createTableElement(table, table.id));
        return section;
    }

    /**
     * Создает заголовок таблицы с возможностью редактирования.
     * Для защищенных таблиц показывает уведомление при попытке редактирования.
     * @param {Object} table - Данные таблицы
     * @param {Object} node - Узел дерева таблицы
     * @returns {HTMLElement} Заголовок таблицы
     * @private
     */
    static _createTableTitle(table, node) {
        const tableTitle = document.createElement('h4');
        tableTitle.className = 'table-title';
        tableTitle.contentEditable = false;
        tableTitle.textContent = tableTitleText(node);

        // Применяем стили
        Object.assign(tableTitle.style, {
            marginBottom: '10px',
            fontWeight: 'normal',
            textDecoration: 'underline',
            cursor: table.protected ? 'default' : 'pointer'
        });

        if (!table.protected) {
            // Tracked-узел: замыкание пишет node.customLabel.
            this._setupTableTitleEditing(tableTitle, AppState._trackedNode(node));
        } else {
            tableTitle.addEventListener('click', () => {
                Notifications.info('Название защищенной таблицы нельзя редактировать');
            });
        }

        return tableTitle;
    }

    /**
     * Настраивает редактирование заголовка таблицы по двойному клику.
     * Нативное событие dblclick вместо ручного 300мс таймера.
     * @param {HTMLElement} tableTitle - Элемент заголовка таблицы
     * @param {Object} node - Узел дерева таблицы
     * @private
     */
    static _setupTableTitleEditing(tableTitle, node) {
        tableTitle.addEventListener('dblclick', () => {
            ItemsTitleEditing.startEditingTableTitle(tableTitle, node);
        });
    }
}

// Подписчик на 'node:tb-changed' — обновляет бейджи ТБ на шаге 2 без полного
// renderAll. Симметричен подписчику в TreeRenderer (он обновляет дерево).
// AppState.setNodeTb эмитит событие, оба подписчика срабатывают независимо.
window.ChatEventBus?.on?.('node:tb-changed', ({nodeId}) => {
    const node = typeof AppState !== 'undefined' ? AppState.findNodeById?.(nodeId) : null;
    if (!node) return;

    const itemBlock = document.querySelector(`.item-block[data-node-id="${nodeId}"]`);
    if (itemBlock) {
        const badge = itemBlock.querySelector(':scope > .item-header .tb-selector-badge');
        if (badge) ItemsRenderer._updateTbBadgeInItems(badge, node);
    }

    ItemsRenderer._updateParentTbInItems(node);
});

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.ItemsRenderer = ItemsRenderer;
