/**
 * Менеджер popup-панели чата AI-ассистента в конструкторе
 *
 * Управляет открытием/закрытием popup, ленивой инициализацией ChatManager,
 * свободным изменением размера (corner grip) и сохранением размеров в localStorage.
 */
import { ChatManager } from '../../shared/chat/chat-manager.js';
import { EscapeStack } from '../../shared/escape-stack.js';
import { makeResizablePanel } from '../../shared/resizable-panel.js';

export class ChatPopupManager {
    /** @type {boolean} */
    static _initialized = false;

    static _storageKey = 'chat_popup_size';
    static _minWidth = 480;
    static _maxWidthVw = 80;
    static _minHeight = 300;
    static _maxHeightVh = 85;

    /**
     * Инициализирует popup: кэширует DOM, подключает обработчики
     */
    static setup() {
        this._btn = document.getElementById('chatPopupBtn');
        this._panel = document.getElementById('chatPopupPanel');
        this._resizeCorner = document.getElementById('chatPopupResizeCorner');
        this._closeBtn = this._panel?.querySelector('.chat-close-btn');

        if (!this._btn || !this._panel) {
            console.warn('ChatPopupManager: не найдены необходимые DOM-элементы');
            return;
        }

        // Кнопка toggle
        this._btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });

        // Кнопка закрытия внутри панели
        if (this._closeBtn) {
            this._closeBtn.addEventListener('click', () => {
                this.close();
            });
        }

        // Закрытие по клику вне панели
        document.addEventListener('click', (e) => {
            if (!this._panel.contains(e.target) && !this._btn.contains(e.target)) {
                this.close();
            }
        });

        // Предотвращаем закрытие при клике внутри
        this._panel.addEventListener('click', (e) => e.stopPropagation());

        // Закрытие по Escape — через EscapeStack (push в open, unsub в close).

        // Свободное изменение размера угловой ручкой (общая утилита; панель
        // прижата слева → растёт вправо и вниз). Восстанавливает сохранённый
        // размер и пере-клампит при ресайзе окна сама.
        this._resizer = makeResizablePanel({
            panel: this._panel,
            handle: this._resizeCorner,
            growX: 'right',
            minWidth: this._minWidth,
            maxWidthVw: this._maxWidthVw,
            minHeight: this._minHeight,
            maxHeightVh: this._maxHeightVh,
            storageKey: this._storageKey,
            cursor: 'nwse-resize',
        });

        this._initialized = true;
        console.log('ChatPopupManager: инициализация завершена');
    }

    /**
     * Открывает popup-панель чата
     */
    static open() {
        if (!this._panel) return;

        // Инициализируем ChatManager при каждом открытии — destroy() в close()
        // снимает все listener'ы, поэтому повторный init даёт чистое состояние
        // без накопления подписок.
        if (typeof ChatManager !== 'undefined') {
            ChatManager.init();
        }

        this._panel.classList.remove('hidden');
        this._btn.classList.add('active');

        if (!this._escapeUnsub) {
            this._escapeUnsub = EscapeStack.push(() => this.close());
        }

        // Фокус на поле ввода
        const input = this._panel.querySelector('.chat-input');
        if (input) {
            setTimeout(() => input.focus(), 100);
        }

        // Приветствие «Готов к редактированию» отправляется прямо из
        // context-menu-tree.openChatWithContext() (после установки
        // window.__selectedNode). Здесь никаких действий не требуется.
    }

    /**
     * Закрывает popup-панель чата
     */
    static close() {
        if (!this._panel) return;

        this._panel.classList.add('hidden');
        this._btn.classList.remove('active');

        if (this._escapeUnsub) {
            this._escapeUnsub();
            this._escapeUnsub = null;
        }

        // Снимаем все listener'ы ChatManager, чтобы избежать утечек и дублирования
        // подписок при следующем открытии.
        if (typeof ChatManager !== 'undefined' && ChatManager.destroy) {
            ChatManager.destroy();
        }
    }

    /**
     * Переключает видимость popup-панели
     */
    static toggle() {
        if (this._panel && this._panel.classList.contains('hidden')) {
            this.open();
        } else {
            this.close();
        }
    }
}

// Инициализация при загрузке страницы
document.addEventListener('DOMContentLoaded', () => ChatPopupManager.setup());

// Глобальный доступ
window.ChatPopupManager = ChatPopupManager;
