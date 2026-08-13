/**
 * Менеджер чата с AI-ассистентом — фасад
 *
 * Тонкий оркестратор: инициализирует модули, делегирует
 * вызовы через ChatEventBus. Сохраняет обратную совместимость
 * публичного API для ChatModalManager, ChatPopupManager и LandingPage.
 *
 * Модули:
 *   ChatEventBus  — шина событий
 *   ChatUI        — typing, processing, scroll, resize
 *   ChatFiles     — валидация, drag-drop, превью файлов
 *   ChatContext   — KB, домены, conversation management
 *   ChatMessages  — отправка, polling ответа, рендеринг сообщений
 */
import { ChatContext } from './chat-context.js';
import { ChatEventBus } from './chat-event-bus.js';
import { ChatFiles } from './chat-files.js';
import { ChatMessages } from './chat-messages.js';
import { ChatRenderer } from './chat-renderer.js';
import { ChatUI } from './chat-ui.js';

export class ChatManager {

    /** @type {boolean} */
    static _initialized = false;
    /** @type {HTMLInputElement|null} */
    static _input = null;
    /** @type {AbortController|null} Снимает все DOM-listener'ы по abort() */
    static _abortController = null;
    /**
     * @type {boolean} Атомарный флаг блокировки повторных sendMessage до первого await.
     * Нужен, чтобы двойной клик/Enter не отправил два запроса (ChatUI.isProcessing
     * становится true только после ui:processing — это уже после await'ов).
     */
    static _isSending = false;

    /**
     * Инициализация: кеширование DOM, запуск модулей
     */
    static init() {
        if (this._initialized) return;

        const messagesContainer = document.querySelector('.chat-messages');
        const input = document.querySelector('.chat-input');
        const sendBtn = document.querySelector('.chat-send-btn');

        if (!messagesContainer || !input || !sendBtn) {
            console.warn('ChatManager: не найдены необходимые DOM-элементы');
            return;
        }

        // Активируем input и кнопку
        input.disabled = false;
        input.placeholder = 'Введите сообщение...';
        sendBtn.disabled = false;

        // Скрываем placeholder
        const placeholder = document.querySelector('.chat-placeholder');
        if (placeholder) {
            placeholder.classList.add('chat-placeholder-hidden');
        }

        // Инициализация модулей
        const domRefs = { messagesContainer, input, sendBtn };

        ChatUI.init(domRefs);
        ChatFiles.init(domRefs);
        ChatMessages.init(domRefs);
        ChatContext.init();

        // Прогрев кеша иконок (fire-and-forget, init не блокируется).
        if (typeof ChatRenderer._loadIcons === 'function') {
            ChatRenderer._loadIcons().catch(console.error);
        }

        // Общий AbortController — снимает все DOM-listener'ы при destroy().
        this._abortController = new AbortController();
        const signal = this._abortController.signal;

        // Кнопка очистки чата
        const clearBtn = document.querySelector('.chat-clear-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => this.clearChat(), { signal });
        }

        // Обработчики ввода
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        }, { signal });

        input.addEventListener('input', () => {
            ChatUI.autoResizeInput();
        }, { signal });

        sendBtn.addEventListener('click', () => {
            this.sendMessage();
        }, { signal });

        this._input = input;
        this._initialized = true;
        console.log('ChatManager: инициализация завершена');
    }

    /**
     * Полная очистка ресурсов: снимает DOM-listener'ы, отписывает модули.
     * Идемпотентно. Используется ChatPopupManager при закрытии panel'а,
     * чтобы каждое открытие давало свежие listener'ы и AbortController.
     */
    static destroy() {
        if (!this._initialized) return;
        if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
        }
        // Каскадная очистка субмодулей (у ChatUI и ChatContext destroy() пока нет).
        if (typeof ChatMessages !== 'undefined' && ChatMessages.destroy) {
            ChatMessages.destroy();
        }
        if (typeof ChatFiles !== 'undefined' && ChatFiles.destroy) {
            ChatFiles.destroy();
        }
        this._input = null;
        this._isSending = false;
        this._initialized = false;
    }

    /**
     * Отправляет сообщение пользователя.
     *
     * ВАЖНО: проверка и установка _isSending выполняются строго до первого await —
     * иначе двойной клик/Enter за один тик микрозадач отправит два запроса
     * (ChatUI.isProcessing переключается только после ui:processing-эмита).
     */
    static async sendMessage() {
        if (this._isSending) return;
        this._isSending = true;
        try {
            if (ChatUI.isProcessing()) return;

            const text = this._input.value.trim();
            if (!text) return;

            const files = ChatFiles.getPendingFiles();

            this._input.value = '';
            ChatUI.autoResizeInput();

            ChatEventBus.emit('chat:send-request', { text, files });
        } finally {
            this._isSending = false;
        }
    }

    /**
     * Полная очистка чата
     */
    static clearChat() {
        if (ChatUI.isProcessing()) return;

        ChatFiles.clear();
        ChatEventBus.emit('chat:clear');
    }
}

window.ChatManager = ChatManager;
