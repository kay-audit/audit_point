/**
 * Обработчик контекстного меню для блоков поля нарушения
 */
import { ContextMenuManager } from './context-menu-core.js';
import { BLOCK_TYPES } from '../violation/violation-block-types.js';
import { getImageLimits } from '../violation/violation-image-validator.js';

export class ViolationContextMenu {
    constructor() {
        this.currentMenu = null;
    }

    show(x, y, params = {}) {
        const {
            violation,
            fieldKey,
            contentContainer,
            blockId = null,
            insertPosition = 0
        } = params;

        // Добавляем проверку на обязательные параметры
        if (!violation || !fieldKey || !contentContainer) {
            console.error('ViolationContextMenu: violation, fieldKey и contentContainer обязательны');
            return;
        }

        this.removeExistingMenu();

        this.currentMenu = this.createMenu(violation, fieldKey, contentContainer, blockId, insertPosition);
        this.currentMenu.style.left = `${x}px`;
        this.currentMenu.style.top = `${y}px`;

        document.body.appendChild(this.currentMenu);
        ContextMenuManager.positionMenu(this.currentMenu, x, y);
    }

    createMenu(violation, fieldKey, contentContainer, blockId, insertPosition) {
        const menu = document.createElement('div');
        menu.className = 'violation-context-menu';
        menu.style.cssText = `
            position: fixed;
            background: white;
            border: 1px solid var(--border, #e0e0e0);
            border-radius: var(--radius, 4px);
            box-shadow: var(--shadow-lg, 0 10px 25px rgba(0, 0, 0, 0.15));
            z-index: 10000;
            min-width: 200px;
            padding: 4px 0;
            font-family: inherit;
        `;

        // action — тип блока из violation-block-types.js (один источник строк,
        // без ручного маппинга подписи в тип).
        const addItems = [
            {label: '📄 Добавить текст', action: BLOCK_TYPES.TEXT},
            {label: '📊 Добавить таблицу', action: BLOCK_TYPES.TABLE},
            {label: '🖼️ Добавить изображение', action: BLOCK_TYPES.IMAGE}
        ];

        // Единый гейт лимита (#4): при достижении лимита ПО ПОЛЮ пункты
        // добавления строятся в disabled-виде — реальный отказ всё равно
        // проверяется в _insertBlocksBulk, здесь только UX-подсказка заранее.
        const blocksCount = violation[fieldKey]?.blocks?.length || 0;
        const limitReached = blocksCount >= getImageLimits().maxItemsPerViolation;

        addItems.forEach(item => {
            menu.appendChild(this.createMenuItem(item.label, () => {
                this.handleAddBlock(violation, fieldKey, item.action, contentContainer, insertPosition);
                this.removeExistingMenu();
                ContextMenuManager.hide();
            }, false, limitReached));
        });

        if (blockId !== null) {
            menu.appendChild(this.createSeparator());
            menu.appendChild(this.createMenuItem('🗑️ Удалить', () => {
                this.handleDelete(violation, fieldKey, blockId, contentContainer);
                this.removeExistingMenu();
                ContextMenuManager.hide();
            }, true));
        }

        return menu;
    }

    createMenuItem(label, clickHandler, isDanger = false, disabled = false) {
        const item = document.createElement('div');
        item.className = 'violation-context-menu-item';
        item.textContent = label;

        if (disabled) {
            item.setAttribute('aria-disabled', 'true');
            item.style.cssText = `
                padding: 8px 16px;
                cursor: default;
                font-size: 0.875rem;
                user-select: none;
                color: var(--text-disabled, #999);
            `;
            return item;
        }

        const dangerColor = isDanger ? 'color: var(--danger, #dc3545);' : '';
        item.style.cssText = `
            padding: 8px 16px;
            cursor: pointer;
            transition: background-color 0.2s;
            font-size: 0.875rem;
            user-select: none;
            ${dangerColor}
        `;

        item.addEventListener('mouseenter', () => {
            const bgColor = isDanger ? 'rgba(220, 53, 69, 0.1)' : 'var(--primary-subtle, #f0f0f0)';
            item.style.backgroundColor = bgColor;
        });

        item.addEventListener('mouseleave', () => {
            item.style.backgroundColor = 'transparent';
        });

        item.addEventListener('click', (e) => {
            e.stopPropagation();
            clickHandler();
        });

        return item;
    }

    createSeparator() {
        const separator = document.createElement('div');
        separator.style.cssText = 'height: 1px; background-color: var(--border, #e0e0e0); margin: 4px 0;';
        return separator;
    }

    handleAddBlock(violation, fieldKey, type, contentContainer, insertPosition) {
        if (!violation || !fieldKey || !contentContainer) return;

        // Картинка идёт своим конвейером (выбор файлов → качество → ресайз),
        // текст и таблица создаются пустыми блоками.
        if (type === BLOCK_TYPES.IMAGE) {
            violationManager?.triggerImageUploadAtPosition?.(
                violation,
                fieldKey,
                contentContainer,
                insertPosition
            );
            return;
        }

        violationManager?.addBlockAtPosition?.(
            violation,
            fieldKey,
            type,
            contentContainer,
            insertPosition
        );
    }

    handleDelete(violation, fieldKey, blockId, contentContainer) {
        if (!violation || !fieldKey || !blockId || !contentContainer) return;

        // Гейт read-only (#11) — внутри мутатора removeBlock, тем же
        // guard'ом, что и остальные мутации нарушения.
        violationManager?.removeBlockFromField?.(violation, fieldKey, blockId, contentContainer);
    }

    removeExistingMenu() {
        if (this.currentMenu) {
            this.currentMenu.remove();
            this.currentMenu = null;
        }
    }
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.ViolationContextMenu = ViolationContextMenu;
