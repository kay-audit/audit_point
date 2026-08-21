/**
 * Entry-модуль для всех portal-страниц (landing, acts-manager, admin, ck).
 * Импортирует общие зависимости shared/, portal-sidebar, portal-settings,
 * чат-модули, диалоги. Каждый импортируемый файл публикует свои классы
 * на window — для совместимости с inline-скриптами в шаблонах.
 *
 * Page-specific бутстрап (LandingPage.init() и т.п.) — в inline-модуле шаблона.
 */
import '../shared/app-config.js';
import '../shared/auth.js';
import '../shared/api.js';
import '../shared/notifications.js';
import '../shared/error-boundary.js';
import '../shared/escape-stack.js';
import '../shared/sanitize.js';
import '../shared/dialog/dialog-base.js';
import '../shared/dialog/dialog-confirm.js';
import '../portal/portal-sidebar.js';
import '../portal/portal-settings.js';

// Shared-центр уведомлений (без живых источников на портале).
import { NotificationCenter } from '../shared/notifications-center/notification-center.js';

// Слежение за версией приложения (баннер «вышло обновление»).
import { startVersionWatcher } from '../shared/version-watcher.js';

// Чат — 12 модулей. chat-event-bus.js первым (остальные подписываются на module-level).
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
import '../shared/chat/chat-modal.js';

/**
 * Инициализирует shared-центр уведомлений на портале (только персистентные;
 * живых источников на portal-страницах нет). Если разметки колокольчика на
 * странице нет — init() тихо выходит.
 */
function _initNotificationCenter() {
    const center = new NotificationCenter({ enablePersisted: true });
    center.init();
    window.notificationCenter = center;
}

/** Бутстрап общих для портала подсистем: колокольчик + слежение за версией. */
function _bootstrap() {
    _initNotificationCenter();
    // Без meta-тега версии стартер тихо ничего не делает.
    startVersionWatcher();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _bootstrap);
} else {
    _bootstrap();
}
