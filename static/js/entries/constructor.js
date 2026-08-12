/**
 * Entry-модуль для редактора актов (/constructor?act_id=...).
 * Импортирует все ~80 модулей конструктора + shared/portal-зависимости.
 * Порядок импортов в большинстве случаев не важен (ESM сам резолвит зависимости
 * через import-граф), но side-effect-модули (state-tree.js делает
 * Object.assign(AppState), violation-init.js инстанцирует ViolationManager)
 * импортируются явно — иначе их module-level код не выполнится.
 */

// Shared infrastructure
import '../shared/app-config.js';
import '../shared/auth.js';
import '../shared/notifications.js';
import '../shared/error-boundary.js';
import '../shared/escape-stack.js';
import '../shared/sanitize.js';
import '../shared/rich-text.js';
import '../shared/api.js';

// Constructor: storage/lifecycle/changelog
import '../constructor/changelog-tracker.js';
import '../constructor/lifecycle-helper.js';
import '../constructor/storage-manager.js';

// App entry-point класс
import '../constructor/app.js';
import '../constructor/navigation-manager.js';
import '../constructor/header/header-exit.js';
import '../constructor/header/format-menu-manager.js';
import '../constructor/header/settings-menu.js';

// Chat (12 модулей) + chat-popup
import '../shared/chat/chat-event-bus.js';
import '../shared/chat/chat-renderer.js';
import '../shared/chat/chat-client-actions.js';
import '../shared/chat/chat-stream.js';
import '../shared/chat/chat-history.js';
import '../shared/chat/chat-ui.js';
import '../shared/chat/chat-files.js';
import '../shared/chat/chat-title.js';
import '../shared/chat/chat-context.js';
import '../shared/chat/chat-messages.js';
import '../shared/chat/chat-manager.js';
import '../constructor/header/chat-popup.js';

// Диалоги
import '../shared/dialog/dialog-base.js';
import '../shared/dialog/dialog-confirm.js';
import '../portal/acts-manager/team-member-search.js';
import '../portal/acts-manager/appendix-number-dropdown.js';
import '../portal/acts-manager/dialog-create-act.js';
import '../constructor/dialog/dialog-help.js';
import '../constructor/dialog/dialog-invoice.js';

// Context-menu (core первым)
import '../constructor/context-menu/context-menu-core.js';
import '../constructor/context-menu/context-menu-tree.js';
import '../constructor/context-menu/context-menu-cells.js';
import '../constructor/context-menu/context-menu-violation.js';
import '../constructor/context-menu/context-menu-links-footnotes.js';

// Services
import '../constructor/services/id-generator.js';
import '../constructor/services/editor-telemetry.js';

// State (state-tree/state-content делают Object.assign(AppState))
import '../constructor/state/state-core.js';
import '../constructor/state/state-tree.js';
import '../constructor/state/state-content.js';
import '../constructor/state/metrics-risk-coordinator.js';
import '../constructor/state/undo-delete.js';

// Clipboard (copy-paste узлов между актами и внутри акта)
import '../constructor/clipboard/node-clipboard.js';

// Tree
import '../constructor/tree/tree-drag-drop.js';
import '../constructor/tree/tree-renderer.js';
import '../constructor/tree/tree-core.js';
import '../constructor/tree/tree-utils.js';

// Items
import '../constructor/items/items-title-editing.js';
import '../constructor/items/items-renderer.js';

// Table
import '../constructor/table/table-cells-operations.js';
import '../constructor/table/table-sizes.js';
import '../constructor/table/table-core.js';

// Preview
import '../constructor/preview/preview.js';
import '../constructor/preview/preview-table-renderer.js';
import '../constructor/preview/preview-textblock-renderer.js';
import '../constructor/preview/preview-violation-renderer.js';

// Textblock
import '../constructor/textblock/textblock-core.js';
import '../constructor/textblock/editor-registry.js';
import '../constructor/textblock/editable-surface.js';
import '../constructor/textblock/editor-controller.js';
import '../constructor/textblock/textblock-editor.js';
import '../constructor/textblock/textblock-formatting.js';
import '../constructor/textblock/textblock-toolbar.js';
import '../constructor/textblock/textblock-links-footnotes.js';
import '../constructor/textblock/textblock-capsule-integrity.js';

// Violation (violation-init.js — последним, инстанцирует ViolationManager)
import '../constructor/violation/violation-core.js';
import '../constructor/violation/violation-mutations.js';
import '../constructor/violation/violation-field-surface.js';
import '../constructor/violation/violation-paste.js';
import '../constructor/violation/violation-blocks.js';
import '../constructor/violation/violation-rendering.js';
import '../constructor/violation/violation-drag-drop.js';
import '../constructor/violation/violation-file-upload.js';
import '../constructor/violation/violation-init.js';

// Validation
import '../constructor/validation/validation-act.js';
import '../constructor/validation/validation-core.js';
import '../constructor/validation/validation-table-core.js';
import '../constructor/validation/validation-table.js';
import '../constructor/validation/validation-tree.js';

// Lock + cross-tab + topbar dropdown-меню
import '../constructor/lock-manager.js';
import '../portal/acts-manager/acts-broadcast.js';
import '../constructor/header/acts-menu.js';
import '../constructor/header/preview-menu.js';

// Центр уведомлений (shared) + живой источник замечаний по таблицам.
import { NotificationCenter } from '../shared/notifications-center/notification-center.js';
import { registerTablesSource } from '../constructor/header/notifications-source-tables.js';
import { registerValidationSource } from '../constructor/header/notifications-source-validation.js';

// Bootstrap конструктора. Раньше app.js и state-core.js сами вешали
// DOMContentLoaded на module-level, но shared/api.js косвенно тянет
// constructor/* на portal-страницы — App.init там стрелял по AppState
// без state-tree.js. Регистрация переехала в entry.
import { App } from '../constructor/app.js';
import { _initStateTracking } from '../constructor/state/state-core.js';
import { UndoDeleteManager } from '../constructor/state/undo-delete.js';
import { NodeClipboard } from '../constructor/clipboard/node-clipboard.js';
import { FindBar } from '../constructor/search/find-bar.js';

/**
 * Инициализирует shared-центр уведомлений в конструкторе и регистрирует
 * живой источник замечаний по таблицам.
 */
function _initNotificationCenter() {
    const center = new NotificationCenter({ enablePersisted: true });
    center.init();
    registerTablesSource(center);
    registerValidationSource(center);
    window.notificationCenter = center;
}

function _bootstrap() {
    App.init();
    setTimeout(_initStateTracking, 0);
    _initNotificationCenter();
    UndoDeleteManager.installHotkey();
    // Copy-paste: шорткаты Ctrl+C/Ctrl+V и пункты меню «Копировать»/«Вставить».
    // installMenuItems — после App.init (там ContextMenuManager.init рендерит #contextMenu).
    NodeClipboard.installHotkey();
    NodeClipboard.installMenuItems();
    // Ctrl+F / Cmd+F — панель поиска/замены по текстблокам (перехватывает
    // браузерный поиск, при необходимости переключает на Step 2).
    FindBar.installHotkey();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _bootstrap);
} else {
    _bootstrap();
}
