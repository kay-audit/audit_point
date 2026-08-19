/**
 * Модуль для редактирования заголовков элементов документа.
 * Обеспечивает inline-редактирование заголовков пунктов, названий таблиц и узлов дерева.
 */
import { isLeafBlockType } from '../block-types.js';
import { ChangelogTracker } from '../changelog-tracker.js';
import { ItemsRenderer } from './items-renderer.js';
import { PreviewManager } from '../preview/preview.js';

export class ItemsTitleEditing {
    /**
     * Запускает режим редактирования заголовка обычного пункта документа.
     * Извлекает базовую метку без нумерации, позволяет отредактировать,
     * затем восстанавливает нумерацию и обновляет дерево и предпросмотр.
     * @param {HTMLElement} titleElement - DOM-элемент заголовка для редактирования
     * @param {Object} node - Узел дерева, связанный с заголовком
     */
    static startEditingItemTitle(titleElement, node) {
        if (titleElement.classList.contains('editing')) return;
        if (node.titleLocked) return; // Заголовок зафиксирован (Process Mining)

        const originalLabel = node.label;

        this._initializeEditing(titleElement, node.label);

        const finishEditing = (cancel = false) => {
            this._cleanupEditing(titleElement);

            if (cancel) {
                titleElement.textContent = originalLabel;
                return;
            }

            this._saveItemTitle(titleElement, node, originalLabel);
        };

        this._attachEditingHandlers(titleElement, finishEditing);
    }

    /**
     * Инициализирует режим редактирования элемента.
     * Делает элемент редактируемым, устанавливает текст и фокус.
     * @param {HTMLElement} element - Элемент для редактирования
     * @param {string} text - Начальный текст
     * @private
     */
    static _initializeEditing(element, text) {
        element.classList.add('editing');
        element.contentEditable = 'true';
        element.textContent = text;
        element.focus();
        element.addEventListener('paste', this._onPastePlainText);

        this._selectAllText(element);
    }

    /**
     * Вставка в подпись — только чистым текстом: форматирование, разметка и
     * переводы строк из буфера отбрасываются (подпись однострочная).
     * Ссылка на обработчик общая для всех подписей (статический метод, не
     * замыкание) — повторный addEventListener на том же элементе браузер
     * игнорирует, дубли слушателей не накапливаются при повторном входе
     * в редактирование одного и того же узла.
     * @param {ClipboardEvent} e - Событие вставки
     * @private
     */
    static _onPastePlainText(e) {
        e.preventDefault();

        const raw = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
        // Переводы строк и табуляции схлопываем в один пробел вместе с
        // окружающими пробелами: многострочный буфер должен лечь в одну строку.
        const text = (raw || '').replace(/\s*[\r\n\t]+\s*/g, ' ');
        if (!text) return;

        // insertText сам заменяет выделение и двигает каретку, оставаясь
        // в нативном undo — тот же путь, что у редактора текстблоков.
        document.execCommand('insertText', false, text);
    }

    /**
     * Выделяет весь текст в элементе для удобного редактирования.
     * @param {HTMLElement} element - Элемент с текстом
     * @private
     */
    static _selectAllText(element) {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    }

    /**
     * Очищает режим редактирования элемента.
     * Убирает contentEditable и класс editing.
     * @param {HTMLElement} element - Элемент для очистки
     * @private
     */
    static _cleanupEditing(element) {
        element.contentEditable = 'false';
        element.classList.remove('editing');
        element.removeEventListener('paste', this._onPastePlainText);
    }

    /**
     * Сохраняет отредактированный заголовок пункта.
     * Восстанавливает нумерацию и обновляет UI.
     * @param {HTMLElement} titleElement - Элемент заголовка
     * @param {Object} node - Узел дерева
     * @param {string} baseLabel - Исходная базовая метка
     * @param {string} originalLabel - Исходная полная метка
     * @private
     */
    static _saveItemTitle(titleElement, node, originalLabel) {
        const newLabel = titleElement.textContent.trim();

        if (!newLabel) {
            // Возвращаем старую метку если новая пустая
            titleElement.textContent = originalLabel;
            return;
        }

        if (newLabel !== originalLabel) {
            node.label = newLabel;
            this._updateUI(node, titleElement);
        } else {
            titleElement.textContent = node.label;
        }
    }

    /**
     * Обновляет UI после изменения метки.
     * Перегенерирует нумерацию, обновляет дерево и предпросмотр.
     * @param {Object} node - Узел дерева
     * @param {HTMLElement} titleElement - Элемент заголовка
     * @private
     */
    static _updateUI(node, titleElement) {
        titleElement.textContent = node.label;
        // Лёгкое обновление DOM-заголовка без полного PreviewManager.update —
        // textSpan в items уже обновлён локально, остаётся только дерево.
        if (typeof ItemsRenderer !== 'undefined') {
            ItemsRenderer.updateNodeTitle(node.id, node.label);
        }
        // Точечное обновление подписи в дереве вместо полного render().
        treeManager.renderer.renderNodeRenamed(node.id);
        // Preview-зона перерисовывается целиком; для редактирования заголовка
        // пункта это адекватная стоимость.
        PreviewManager.update();
    }

    /**
     * Запускает режим редактирования заголовка таблицы.
     * Позволяет задать пользовательское название таблицы (customLabel).
     * Если название очищено, возвращает автоматическую нумерацию.
     * @param {HTMLElement} titleElement - DOM-элемент заголовка таблицы
     * @param {Object} node - Узел дерева таблицы
     */
    static startEditingTableTitle(titleElement, node) {
        if (titleElement.classList.contains('editing')) return;

        const currentLabel = node.customLabel || node.number || node.label;
        this._initializeEditing(titleElement, currentLabel);

        const finishEditing = (cancel = false) => {
            this._cleanupEditing(titleElement);

            if (cancel) {
                titleElement.textContent = currentLabel;
                return;
            }

            this._saveTableTitle(titleElement, node, currentLabel);
        };

        this._attachEditingHandlers(titleElement, finishEditing);
    }

    /**
     * Сохраняет отредактированный заголовок таблицы.
     * Устанавливает customLabel или удаляет его при пустом значении.
     * @param {HTMLElement} titleElement - Элемент заголовка таблицы
     * @param {Object} node - Узел дерева таблицы
     * @param {string} originalLabel - Исходная метка
     * @private
     */
    static _saveTableTitle(titleElement, node, originalLabel) {
        const newLabel = titleElement.textContent.trim();

        if (newLabel) {
            // Сохраняем пользовательское название
            node.customLabel = newLabel;
        } else {
            // Удаляем кастомное название (вернется автонумерация)
            delete node.customLabel;
        }

        titleElement.textContent = node.customLabel || node.number || node.label;
        // Точечное обновление подписи в дереве вместо полного render().
        treeManager.renderer.renderNodeRenamed(node.id);
        PreviewManager.update();
    }

    /**
     * Запускает режим редактирования заголовка узла дерева.
     * Универсальный метод для редактирования любых типов узлов в дереве.
     * @param {HTMLElement} labelElement - DOM-элемент метки узла
     * @param {Object} node - Узел дерева
     * @param {TreeManager} treeManager - Экземпляр менеджера дерева
     */
    static startEditingTreeNode(labelElement, node, treeManager) {
        if (node.titleLocked) return; // Заголовок зафиксирован (Process Mining)
        const item = labelElement.closest('.tree-item');
        if (item.classList.contains('editing')) return;

        item.classList.add('editing');
        treeManager.editingElement = labelElement;

        const originalLabel = node.label;
        const isSpecialType = isLeafBlockType(node.type);

        // Для специальных типов используем customLabel
        if (isSpecialType) {
            labelElement.textContent = node.customLabel || node.number || node.label;
        }

        this._initializeEditing(labelElement, labelElement.textContent);

        const finishEditing = (cancel = false) => {
            this._cleanupTreeNodeEditing(labelElement, item, treeManager);

            if (cancel) {
                if (isSpecialType) {
                    labelElement.textContent = node.customLabel || node.number || node.label;
                } else {
                    labelElement.textContent = originalLabel;
                }
                return;
            }

            this._saveTreeNodeLabel(labelElement, node, originalLabel, isSpecialType);
        };

        this._attachEditingHandlers(labelElement, finishEditing);
    }

    /**
     * Очищает режим редактирования узла дерева.
     * Убирает классы и сбрасывает состояние менеджера дерева.
     * @param {HTMLElement} labelElement - Элемент метки
     * @param {HTMLElement} item - Элемент узла дерева
     * @param {TreeManager} treeManager - Экземпляр менеджера дерева
     * @private
     */
    static _cleanupTreeNodeEditing(labelElement, item, treeManager) {
        labelElement.contentEditable = 'false';
        labelElement.removeEventListener('paste', this._onPastePlainText);
        item.classList.remove('editing');
        treeManager.editingElement = null;
    }

    /**
     * Сохраняет отредактированную метку узла дерева.
     * Обрабатывает специальные и обычные типы узлов по-разному.
     * @param {HTMLElement} labelElement - Элемент метки
     * @param {Object} node - Узел дерева
     * @param {string} originalLabel - Исходная метка
     * @param {boolean} isSpecialType - Является ли узел специальным типом
     * @private
     */
    static _saveTreeNodeLabel(labelElement, node, originalLabel, isSpecialType) {
        const newLabel = labelElement.textContent.trim();

        if (isSpecialType) {
            this._saveSpecialNodeLabel(labelElement, node, newLabel, originalLabel);
        } else {
            this._saveRegularNodeLabel(labelElement, node, newLabel, originalLabel);
        }
    }

    /**
     * Сохраняет метку специального узла (таблица, текстовый блок, нарушение).
     * Устанавливает customLabel или восстанавливает автоматическую нумерацию.
     * @param {HTMLElement} labelElement - Элемент метки
     * @param {Object} node - Узел дерева
     * @param {string} newLabel - Новая метка
     * @param {string} originalLabel - Исходная метка
     * @private
     */
    static _saveSpecialNodeLabel(labelElement, node, newLabel, originalLabel) {
        if (newLabel && newLabel !== (node.customLabel || node.number || node.label)) {
            node.customLabel = newLabel;
        } else if (!newLabel) {
            delete node.customLabel;
        }

        labelElement.textContent = node.customLabel || node.number || node.label;
        this._updateTreeUI(node);
    }

    /**
     * Сохраняет метку обычного узла.
     * Обновляет label и перегенерирует нумерацию.
     * @param {HTMLElement} labelElement - Элемент метки
     * @param {Object} node - Узел дерева
     * @param {string} newLabel - Новая метка
     * @param {string} originalLabel - Исходная метка
     * @private
     */
    static _saveRegularNodeLabel(labelElement, node, newLabel, originalLabel) {
        if (newLabel && newLabel !== originalLabel) {
            node.label = newLabel;
            if (typeof ChangelogTracker !== 'undefined') {
                ChangelogTracker.record('rename_node', node.id, newLabel, {old: originalLabel, new: newLabel});
            }
            this._updateTreeUI(node);
        } else if (!newLabel) {
            labelElement.textContent = originalLabel;
        } else {
            labelElement.textContent = node.label;
        }
    }

    /**
     * Обновляет UI дерева и предпросмотра после переименования узла.
     * Точечно обновляет подпись в дереве (полный render не нужен:
     * rename структуру и нумерацию не меняет).
     * @param {Object} node - Переименованный узел
     * @private
     */
    static _updateTreeUI(node) {
        treeManager.renderer.renderNodeRenamed(node.id);
        PreviewManager.update();
    }

    /**
     * Привязывает обработчики событий для редактирования.
     * Обрабатывает потерю фокуса (blur) и нажатия клавиш (Enter/Escape).
     * @param {HTMLElement} element - Редактируемый элемент
     * @param {Function} finishCallback - Callback для завершения редактирования
     * @private
     */
    static _attachEditingHandlers(element, finishCallback) {
        const blurHandler = () => finishCallback(false);

        const keydownHandler = (e) => {
            if (e.key === 'Enter' || e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                element.removeEventListener('blur', blurHandler);
                element.removeEventListener('keydown', keydownHandler);
                finishCallback(e.key === 'Escape');
            }
        };

        element.addEventListener('blur', blurHandler);
        element.addEventListener('keydown', keydownHandler);
    }
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.ItemsTitleEditing = ItemsTitleEditing;
