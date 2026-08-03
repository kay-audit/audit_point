/**
 * Основной менеджер дерева элементов акта
 *
 * Управляет состоянием, выделением и координацией между модулями.
 * Делегирует рендеринг и drag-and-drop специализированным классам.
 */
import { App } from '../app.js';
import { ContextMenuManager } from '../context-menu/context-menu-core.js';
import { ItemsTitleEditing } from '../items/items-title-editing.js';
import { AppState } from '../state/state-core.js';
import { TreeDragDrop } from './tree-drag-drop.js';
import { TreeRenderer } from './tree-renderer.js';
import { TreeUtils } from './tree-utils.js';
import { AppConfig } from '../../shared/app-config.js';
import { EscapeStack } from '../../shared/escape-stack.js';

export class TreeManager {
    /**
     * @param {string} containerId - ID элемента-контейнера для дерева
     */
    constructor(containerId) {
        /** @type {HTMLElement} Контейнер для дерева */
        this.container = document.getElementById(containerId);

        /** @type {string|null} ID текущего выбранного узла */
        this.selectedNode = null;

        /** @type {HTMLElement|null} Элемент, который сейчас редактируется */
        this.editingElement = null;

        // Инициализация делегатов для отдельных функций
        this.renderer = new TreeRenderer(this);
        this.dragDrop = new TreeDragDrop(this);

        // Запускаем обработчики для снятия выделения
        this.initDeselectionHandlers();

        // Клавиатурная навигация по дереву (WAI-ARIA Treeview pattern).
        this.initKeyboardNavigation();

        // Инициализируем drag-and-drop
        this.dragDrop.init();

        // Кеш списка видимых treeitem'ов для клавиатурной навигации:
        // без него каждая стрелка пересчитывала полный querySelectorAll+filter.
        // Наблюдаем только childList — он ловит пересборку узлов (render/
        // renderSubtree). Атрибуты НЕ наблюдаем: class-перебор при
        // выделении/драге/подсветке давал ложные инвалидации. Сворачивание —
        // тоже class-toggle (childList его не видит), поэтому кеш на двух
        // точках collapse инвалидируется явно через _invalidateVisibleItemsCache.
        /** @type {HTMLElement[]|null} */
        this._visibleItemsCache = null;
        this._visibleItemsObserver = new MutationObserver(() => {
            this._visibleItemsCache = null;
        });
        this._visibleItemsObserver.observe(this.container, {
            childList: true,
            subtree: true
        });
    }

    /**
     * Инициализация обработчиков для снятия выделения
     *
     * Настраивает реакцию на клики вне дерева и нажатие ESC.
     */
    initDeselectionHandlers() {
        // Снимаем выделение при клике вне контейнера дерева
        document.addEventListener('click', (e) => {
            if (!this.container.contains(e.target)) {
                this.clearSelection();
            }
        });

        // Снимаем выделение при нажатии ESC (но не во время редактирования).
        // Legacy-listener: написан до централизации ESC в EscapeStack, живёт в
        // bubbling. Пока в стеке есть слой (диалог, панель поиска, активная зона
        // нарушений), ESC принадлежит ему; сюда событие доходит только сквозным
        // отказом всех слоёв (PASS) — снимать по нему выделение нельзя, иначе
        // Escape, адресованный редактору, незаметно стирает выделение дерева.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !this.editingElement && !EscapeStack.isActive()) {
                this.clearSelection();
            }
        });
    }

    /**
     * Снятие выделения всех узлов
     *
     * Убирает все классы выделения и сбрасывает ссылки на выбранный узел.
     */
    clearSelection() {
        // Убираем класс selected со всех элементов и сбрасываем aria-selected.
        this.container.querySelectorAll('.tree-item.selected')
            .forEach(el => {
                el.classList.remove('selected');
                el.setAttribute('aria-selected', 'false');
            });

        // Убираем класс parent-selected со всех родительских элементов
        this.container.querySelectorAll('.tree-item.parent-selected')
            .forEach(el => el.classList.remove('parent-selected'));

        // Сбрасываем выбранный узел
        this.selectedNode = null;
        AppState.selectedNode = null;

        // Roving tabindex: при отсутствии выделенного — первый элемент должен быть фокусируемым.
        if (this.renderer?._applyRovingTabindex) {
            this.renderer._applyRovingTabindex();
        }
    }

    /**
     * Выбор узла
     *
     * Снимает выделение со всех узлов и выделяет указанный,
     * также подсвечивает родительские элементы.
     *
     * @param {HTMLElement} itemElement - Элемент li, который нужно выделить
     */
    selectNode(itemElement) {
        // Снимаем выделение со всех элементов
        this.container.querySelectorAll('.tree-item.selected')
            .forEach(el => {
                el.classList.remove('selected');
                el.setAttribute('aria-selected', 'false');
            });
        this.container.querySelectorAll('.tree-item.parent-selected')
            .forEach(el => el.classList.remove('parent-selected'));

        // Выделяем текущий элемент
        itemElement.classList.add('selected');
        itemElement.setAttribute('aria-selected', 'true');
        this.selectedNode = itemElement.dataset.nodeId;
        AppState.selectedNode = this.selectedNode;

        // Подсвечиваем родительские элементы
        this._highlightParentNodes(itemElement);

        // Roving tabindex: только выделенный treeitem должен быть в tab-order.
        if (this.renderer?._applyRovingTabindex) {
            this.renderer._applyRovingTabindex();
        }
    }

    /**
     * Подсвечивает родительские узлы
     * @private
     * @param {HTMLElement} itemElement - Элемент для начала подсветки
     */
    _highlightParentNodes(itemElement) {
        let currentElement = itemElement.parentElement;

        while (currentElement) {
            // Если это ul с классом tree-children, его родитель - li
            if (currentElement.classList?.contains('tree-children')) {
                const parentLi = currentElement.parentElement;
                if (parentLi?.classList.contains('tree-item')) {
                    parentLi.classList.add('parent-selected');
                }
            }

            currentElement = currentElement.parentElement;

            // Прерываем, если дошли до основного контейнера
            if (currentElement?.id === this.container.id) {
                break;
            }
        }
    }

    /**
     * Обработчик Ctrl+Click для перехода к элементу в превью
     *
     * @param {Object} node - Узел дерева
     * @param {HTMLElement} itemElement - Элемент li для выделения
     */
    handleCtrlClick(node, itemElement) {
        ContextMenuManager.hide();
        this.selectNode(itemElement);

        // Проверяем, что мы на шаге 1 (конструктор)
        if (typeof App !== 'undefined' && AppState.currentStep === 1) {
            const targetNodeId = node.id;

            // Переходим на шаг 2 (превью)
            App.goToStep(2);

            // Используем цепочку requestAnimationFrame + timeout для надежности
            const delay = AppConfig.tree.scrollSettings.transitionDelay;

            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    setTimeout(() => {
                        this._scrollToPreviewElement(targetNodeId);
                    }, delay);
                });
            });
        }
    }

    /**
     * Прокручивает страницу до элемента в превью
     * @private
     * @param {string} targetNodeId - ID целевого узла
     */
    _scrollToPreviewElement(targetNodeId) {
        const itemsContainer = document.getElementById('itemsContainer');
        if (!itemsContainer) {
            console.warn('itemsContainer не найден');
            return;
        }

        const targetElement = this._findPreviewElement(itemsContainer, targetNodeId);
        if (!targetElement) {
            console.warn(`Элемент с node-id="${targetNodeId}" не найден`);
            return;
        }

        this._performScroll(targetElement);
        this._animateHighlight(targetElement);
    }

    /**
     * Находит элемент в превью по различным селекторам
     * @private
     * @param {HTMLElement} container - Контейнер для поиска
     * @param {string} nodeId - ID узла
     * @returns {HTMLElement|null} Найденный элемент или null
     */
    _findPreviewElement(container, nodeId) {
        // Попытка 1: ищем .item-block с data-node-id
        let element = container.querySelector(`.item-block[data-node-id="${nodeId}"]`);
        if (element) return element;

        // Попытка 2: ищем любой элемент с data-node-id и находим ближайший .item-block
        const nodeElement = container.querySelector(`[data-node-id="${nodeId}"]`);
        if (nodeElement) {
            const itemBlock = nodeElement.closest('.item-block');
            if (itemBlock) return itemBlock;

            // Если сам элемент имеет класс item-block
            if (nodeElement.classList.contains('item-block')) {
                return nodeElement;
            }
        }

        // Попытка 3: поиск в item-container, затем ближайший item-block
        const itemContainers = container.querySelectorAll('.item-container');
        for (const cont of itemContainers) {
            if (cont.dataset.nodeId === nodeId) {
                const itemBlock = cont.querySelector('.item-block');
                if (itemBlock) return itemBlock;
                return cont;
            }
        }

        return null;
    }

    /**
     * Выполняет плавную прокрутку к элементу
     * @private
     * @param {HTMLElement} element - Целевой элемент
     */
    _performScroll(element) {
        const scrollContainer = document.getElementById('step2');
        if (!scrollContainer) return;

        const header = document.querySelector('.header');
        const headerHeight = header ? header.offsetHeight : 0;
        const padding = AppConfig.tree.scrollSettings.headerOffset;

        const elementTop = element.getBoundingClientRect().top
            - scrollContainer.getBoundingClientRect().top
            + scrollContainer.scrollTop;

        scrollContainer.scrollTo({
            top: elementTop - headerHeight - padding,
            behavior: AppConfig.tree.scrollSettings.behavior
        });
    }

    /**
     * Анимирует подсветку элемента через CSS класс
     * @private
     * @param {HTMLElement} element - Элемент для подсветки
     */
    _animateHighlight(element) {
        // Убираем старую анимацию если она была
        element.classList.remove('highlight-flash');

        // Форсируем reflow для перезапуска анимации
        void element.offsetWidth;

        // Добавляем анимацию подсветки элемента
        element.classList.add('highlight-flash');

        // Удаляем класс после завершения анимации (2 секунды)
        setTimeout(() => {
            element.classList.remove('highlight-flash');
        }, 2000);
    }

    /**
     * Рендеринг дерева
     *
     * Делегирует выполнение в TreeRenderer.
     *
     * @param {Object} [node=AppState.treeData] - Корневой узел для рендеринга
     */
    render(node = AppState.treeData) {
        this.renderer.render(node);
    }

    /**
     * Клавиатурная навигация (WAI-ARIA Treeview pattern):
     * ArrowDown/Up — следующий/предыдущий видимый treeitem,
     * ArrowRight — раскрыть свёрнутый или перейти к первому ребёнку,
     * ArrowLeft — свернуть раскрытый или перейти к родителю,
     * Home/End — первый/последний видимый,
     * Enter — выделить узел (эквивалент клика),
     * F2 — войти в режим редактирования заголовка.
     */
    initKeyboardNavigation() {
        this.container.addEventListener('keydown', (e) => {
            // Не перехватываем клавиши, если идёт редактирование (label.contentEditable).
            if (this.editingElement) return;
            const active = document.activeElement;
            if (!active || !this.container.contains(active)) return;

            const li = active.closest('li.tree-item');
            if (!li) return;

            const key = e.key;

            // Alt+стрелки — клавиатурная перестановка узла (#34) поверх
            // AppState.moveNode (см. _reorderViaKeyboard). Проверяем ДО обычной
            // навигации: preventDefault/stopPropagation подавляют браузерные
            // Alt+←/→ (Назад/Вперёд) при фокусе внутри дерева.
            if (e.altKey && !e.ctrlKey && !e.metaKey &&
                ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) {
                e.preventDefault();
                e.stopPropagation();
                this._reorderViaKeyboard(li, key);
                return;
            }

            if (![
                'ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft',
                'Home', 'End', 'Enter', 'F2'
            ].includes(key)) return;

            e.preventDefault();
            e.stopPropagation();

            switch (key) {
                case 'ArrowDown': {
                    const next = this._nextVisibleTreeItem(li);
                    if (next) this._focusTreeItem(next);
                    break;
                }
                case 'ArrowUp': {
                    const prev = this._prevVisibleTreeItem(li);
                    if (prev) this._focusTreeItem(prev);
                    break;
                }
                case 'ArrowRight': {
                    if (li.hasAttribute('aria-expanded')) {
                        if (li.classList.contains('collapsed')) {
                            this._setExpanded(li, true);
                        } else {
                            // Уже раскрыт → к первому ребёнку.
                            const childUl = li.querySelector(':scope > ul.tree-children');
                            const firstChild = childUl?.querySelector(':scope > li.tree-item');
                            if (firstChild) this._focusTreeItem(firstChild);
                        }
                    }
                    break;
                }
                case 'ArrowLeft': {
                    if (li.hasAttribute('aria-expanded') && !li.classList.contains('collapsed')) {
                        this._setExpanded(li, false);
                    } else {
                        // Перейти к родителю.
                        const parentUl = li.parentElement;
                        const parentLi = parentUl?.closest('li.tree-item');
                        if (parentLi) this._focusTreeItem(parentLi);
                    }
                    break;
                }
                case 'Home': {
                    const first = this.container.querySelector('li.tree-item');
                    if (first) this._focusTreeItem(first);
                    break;
                }
                case 'End': {
                    const all = this._allVisibleTreeItems();
                    if (all.length) this._focusTreeItem(all[all.length - 1]);
                    break;
                }
                case 'Enter': {
                    this.selectNode(li);
                    break;
                }
                case 'F2': {
                    // Запуск редактирования заголовка: дёргаем dblclick-подобный путь.
                    const label = li.querySelector(':scope > .tree-label');
                    if (label && !li.classList.contains('protected') && typeof ItemsTitleEditing !== 'undefined') {
                        const nodeId = li.dataset.nodeId;
                        const node = (typeof AppState !== 'undefined')
                            ? AppState.findNodeById(nodeId)
                            : null;
                        if (node) {
                            const editTarget = label.querySelector('.tree-node-text') || label;
                            ItemsTitleEditing.startEditingTreeNode(editTarget, node, this);
                        }
                    }
                    break;
                }
            }
        });
    }

    /**
     * Клавиатурная перестановка узла (Alt+стрелки, находка #34, вариант Б).
     * Максимальный reuse: соседа/цель выбираем из AppState (children реального
     * родителя, пропуская закреплённые pinned-таблицы — TreeUtils.isPinnedTable),
     * а само перемещение и рендер-побочку делает dragDrop.moveProgrammatically
     * (тот же путь, что и drag-and-drop) — единственный источник валидации
     * (protected/depth/§5-risk/process-mining/first-level/лимиты) и тостов.
     *
     * Маппинг: Alt+↑ — перед предыдущим незакреплённым соседом; Alt+↓ — после
     * следующего незакреплённого соседа; Alt+→ (indent) — ребёнком предыдущего
     * незакреплённого соседа (если тот может принять ребёнка); Alt+← (outdent) —
     * после текущего родителя (уровень 0 — родитель root — не имеет цели для
     * outdent, тихий no-op; попытка получить level-1 из более глубокого узла
     * дойдёт до moveNode и получит явный отказ с сообщением).
     *
     * @param {HTMLElement} li - Элемент узла, к которому применяется перестановка
     * @param {'ArrowUp'|'ArrowDown'|'ArrowLeft'|'ArrowRight'} key - Клавиша со стрелкой
     */
    async _reorderViaKeyboard(li, key) {
        // Тихий no-op в режиме только чтения — как handleDragStart для drag-and-drop.
        if (AppConfig.readOnlyMode?.isReadOnly) return;

        const nodeId = li.dataset.nodeId;
        const node = AppState.findNodeById(nodeId);
        const parent = AppState.findParentNode(nodeId);
        if (!node || !parent) return;

        const siblings = parent.children || [];
        const idx = siblings.indexOf(node);
        if (idx === -1) return;

        let targetId = null;
        let position = null;
        let expandTargetId = null;

        if (key === 'ArrowUp') {
            const sibling = this._nearestNonPinnedSibling(siblings, idx, -1);
            if (sibling) {
                targetId = sibling.id;
                position = 'before';
            }
        } else if (key === 'ArrowDown') {
            const sibling = this._nearestNonPinnedSibling(siblings, idx, 1);
            if (sibling) {
                targetId = sibling.id;
                position = 'after';
            }
        } else if (key === 'ArrowRight') {
            const prevSibling = this._nearestNonPinnedSibling(siblings, idx, -1);
            if (prevSibling && this.dragDrop.canAcceptAsChild(prevSibling, node)) {
                targetId = prevSibling.id;
                position = 'child';
                expandTargetId = prevSibling.id;
            }
        } else if (key === 'ArrowLeft') {
            if (parent.id !== 'root') {
                targetId = parent.id;
                position = 'after';
            }
        }

        if (!targetId || !position) return;

        const result = await this.dragDrop.moveProgrammatically(nodeId, targetId, position);
        if (!result.valid) return;

        // Раскрываем нового родителя при indent, если он был свёрнут.
        if (expandTargetId) {
            const parentLi = this.renderer._domIndex.get(expandTargetId);
            if (parentLi) this._setExpanded(parentLi, true);
        }

        // Рефокус на перемещённый узел — сбрасывает roving tabindex на него.
        const movedLi = this.renderer._domIndex.get(nodeId);
        if (movedLi) this._focusTreeItem(movedLi);
    }

    /**
     * Сбрасывает кеш видимых treeitem'ов. Вызывается явно из точек
     * сворачивания (class-toggle, который childList-наблюдатель не ловит):
     * toggle-иконка в TreeRenderer и клавиатурный _setExpanded.
     * @private
     */
    _invalidateVisibleItemsCache() {
        this._visibleItemsCache = null;
    }

    /**
     * Все «видимые» treeitem'ы — те, чьи предки не collapsed.
     * Результат кешируется; кеш сбрасывается MutationObserver'ом (childList,
     * ловит ререндер) и явно в точках collapse через _invalidateVisibleItemsCache.
     * @private
     * @returns {HTMLElement[]}
     */
    _allVisibleTreeItems() {
        if (this._visibleItemsCache) return this._visibleItemsCache;

        const all = Array.from(this.container.querySelectorAll('li.tree-item'));
        this._visibleItemsCache = all.filter(li => {
            // Если любой предок-tree-item имеет .collapsed — li невидим.
            let parentLi = li.parentElement?.closest('li.tree-item');
            while (parentLi) {
                if (parentLi.classList.contains('collapsed')) return false;
                parentLi = parentLi.parentElement?.closest('li.tree-item');
            }
            return true;
        });
        return this._visibleItemsCache;
    }

    /** @private */
    _nextVisibleTreeItem(li) {
        const list = this._allVisibleTreeItems();
        const idx = list.indexOf(li);
        return idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;
    }

    /** @private */
    _prevVisibleTreeItem(li) {
        const list = this._allVisibleTreeItems();
        const idx = list.indexOf(li);
        return idx > 0 ? list[idx - 1] : null;
    }

    /**
     * Ближайший не-закреплённый сосед в siblings от индекса idx в направлении step.
     * @param {Array} siblings - Массив дочерних узлов
     * @param {number} idx - Индекс исходного узла
     * @param {number} step - Шаг направления: -1 (вверх/влево) или +1 (вниз)
     * @returns {Object|null} Узел-сосед или null, если такого нет
     * @private
     */
    _nearestNonPinnedSibling(siblings, idx, step) {
        for (let i = idx + step; i >= 0 && i < siblings.length; i += step) {
            if (!TreeUtils.isPinnedTable(siblings[i])) return siblings[i];
        }
        return null;
    }

    /**
     * Раскрывает/сворачивает узел синхронно с toggle-иконкой и aria-expanded.
     * @private
     */
    _setExpanded(li, expanded) {
        if (!li.hasAttribute('aria-expanded')) return;
        const isCollapsed = li.classList.contains('collapsed');
        if (expanded && isCollapsed) {
            li.classList.remove('collapsed');
        } else if (!expanded && !isCollapsed) {
            li.classList.add('collapsed');
        } else {
            return;
        }
        // Сворачивание — class-toggle, childList-наблюдатель его не видит:
        // инвалидируем кеш видимых узлов явно.
        this._invalidateVisibleItemsCache();
        li.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        const toggle = li.querySelector(':scope > .toggle-icon');
        if (toggle && AppConfig?.tree?.interaction?.toggleIcons) {
            const icons = AppConfig.tree.interaction.toggleIcons;
            toggle.textContent = expanded ? icons.expanded : icons.collapsed;
        }
        // Персист свёрнутости per-act (M.24) — симметрично клику по toggle-иконке.
        this.renderer?.persistCollapsed?.(li.dataset.nodeId, !expanded);
    }

    /**
     * Переводит roving tabindex на указанный li и устанавливает фокус.
     * @private
     */
    _focusTreeItem(li) {
        // Сбрасываем tabindex у всех, ставим 0 на целевой.
        this.container.querySelectorAll('li.tree-item').forEach(el => el.setAttribute('tabindex', '-1'));
        li.setAttribute('tabindex', '0');
        li.focus();
    }
}

// Создаем глобальный экземпляр менеджера дерева
export const treeManager = new TreeManager('tree');

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.TreeManager = TreeManager;
window.treeManager = treeManager;
