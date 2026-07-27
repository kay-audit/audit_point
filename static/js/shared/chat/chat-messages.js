/**
 * Менеджер сообщений чата
 *
 * Отправка сообщений через poll-клиент, рендеринг user/bot сообщений в DOM.
 * При получении готового ответа применяет декоративный эффект печати.
 */

import { ChatContext } from './chat-context.js';
import { ChatEventBus } from './chat-event-bus.js';
import { ChatFeedback } from './chat-feedback.js';
import { ChatFiles } from './chat-files.js';
import { ChatRenderer } from './chat-renderer.js';
import { ChatStream } from './chat-stream.js';
import { Notifications } from '../notifications.js';

/**
 * Whitelist известных типов блоков сообщений.
 * Синхронизировать с `MessageBlock` union из `app/core/chat/blocks.py`
 * и с `_DiscriminatedBlock` из `app/core/chat/schemas.py`.
 */
export const KNOWN_BLOCK_TYPES = new Set([
    'text',
    'code',
    'reasoning',
    'file',
    'image',
    'plan',
    'error',
    'buttons',
    'client_action',
]);

export const ChatMessages = {

    /** @type {Set<string>} */
    KNOWN_BLOCK_TYPES,

    /** @type {boolean} */
    _initialized: false,
    /** @type {HTMLElement|null} */
    _messagesContainer: null,

    /** @type {HTMLElement|null} DOM-узел welcome-сообщения для восстановления при очистке */
    _welcomeNode: null,

    /**
     * AbortController текущего polling. Отменяется при переключении беседы
     * или явной очистке, чтобы typing-bubble не зависал при навигации.
     * @type {AbortController|null}
     */
    _pollController: null,

    /**
     * Реестр инкрементально отрисованных блоков: контейнер → Map
     * (block_id → {sb, renderedLen, queue}). WeakMap — контейнеры умирают
     * при перерисовке беседы, реестр уходит с ними.
     */
    _incrementalRegistry: new WeakMap(),

    /**
     * Инициализация: кеширование DOM, подписка на события
     *
     * @param {Object} data
     * @param {HTMLElement} data.messagesContainer
     */
    init({ messagesContainer }) {
        if (this._initialized) return;
        this._messagesContainer = messagesContainer;

        // Кэшируем welcome-сообщение как DOM-узел
        const welcomeEl = this._messagesContainer.querySelector('.chat-message-bot');
        if (welcomeEl) {
            this._welcomeNode = welcomeEl.cloneNode(true);
        }

        this._onSendRequest = (data) => this._send(data);
        this._onConversationSwitched = (data) => {
            this._abortPoll();
            if (!data.conversationId) {
                this._restoreWelcome();
                return;
            }
            this._renderConversationMessages(data);
        };
        this._onConversationCleared = () => {
            this._abortPoll();
            this._restoreWelcome();
        };
        this._onChatClear = () => {
            this._abortPoll();
            this._restoreWelcome();
        };

        ChatEventBus.on('chat:send-request', this._onSendRequest);
        ChatEventBus.on('context:conversation-switched', this._onConversationSwitched);
        ChatEventBus.on('context:conversation-cleared', this._onConversationCleared);
        ChatEventBus.on('chat:clear', this._onChatClear);

        this._initialized = true;
    },

    /**
     * Снимает все подписки на шину событий. Идемпотентно.
     */
    destroy() {
        if (!this._initialized) return;
        this._abortPoll();
        if (this._onSendRequest) {
            ChatEventBus.off('chat:send-request', this._onSendRequest);
            this._onSendRequest = null;
        }
        if (this._onConversationSwitched) {
            ChatEventBus.off('context:conversation-switched', this._onConversationSwitched);
            this._onConversationSwitched = null;
        }
        if (this._onConversationCleared) {
            ChatEventBus.off('context:conversation-cleared', this._onConversationCleared);
            this._onConversationCleared = null;
        }
        if (this._onChatClear) {
            ChatEventBus.off('chat:clear', this._onChatClear);
            this._onChatClear = null;
        }
        this._initialized = false;
    },

    /**
     * Отменяет текущий polling, если он активен.
     * @private
     */
    _abortPoll() {
        if (this._pollController) {
            this._pollController.abort();
            this._pollController = null;
        }
    },

    /**
     * Отправляет сообщение пользователя и запускает poll-цикл.
     *
     * @param {Object} data
     * @param {string} data.text — текст сообщения
     * @param {File[]} data.files — прикреплённые файлы
     * @private
     */
    async _send({ text, files }) {
        ChatEventBus.emit('ui:processing', { state: true });

        try {
            const conversationId = await ChatContext.ensureConversation(text, files);

            // Рендерим user-сообщение
            if (files.length > 0) {
                const fileBlocks = files.map(f => ({
                    type: 'file', name: f.name, size: f.size,
                }));
                this._renderUserMessageWithFiles(text, fileBlocks);
            } else {
                this._addUserMessage(text);
            }

            ChatFiles.clear();

            // Показываем typing-bubble сразу
            const botContainer = this._addBotMessageStreaming();

            // Режим агента: читает localStorage['assistant_oarb_mode'] через ChatContext
            const agentMode = (window.ChatContext
                && typeof ChatContext.getAgentMode === 'function'
                && ChatContext.getAgentMode()) || 'off';

            // Создаём AbortController для этого polling-цикла
            this._abortPoll();
            const controller = new AbortController();
            this._pollController = controller;

            await ChatStream.sendAndPoll(conversationId, text, files, {
                agentMode,
                domains: ChatContext.detectDomains(),
                onReady: (msg) => {
                    this._renderReadyMessage(botContainer, msg);
                    ChatEventBus.emit('ui:scroll-bottom');
                },
                onProgress: (msg) => {
                    this._renderProgress(botContainer, msg);
                },
                onError: (err) => {
                    this._renderError(botContainer, err);
                    ChatEventBus.emit('ui:scroll-bottom');
                },
                signal: controller.signal,
            });
        } catch (err) {
            console.error('ChatMessages: ошибка отправки', err);
            this.renderMessage('bot', 'Произошла ошибка. Попробуйте ещё раз.');
        } finally {
            ChatEventBus.emit('ui:processing', { state: false });
        }
    },

    /**
     * Рендерит готовый ответ бота с декоративным эффектом печати.
     *
     * @param {HTMLElement} botContainer — контейнер .chat-message-content
     * @param {Object} msg — {id, status, content}
     * @private
     */
    async _renderReadyMessage(botContainer, msg) {
        ChatRenderer.removeTypingPlaceholder(botContainer);
        this._updateQueueStatus(botContainer, null); // снять строку статуса очереди
        const msgEl = botContainer.parentElement;
        if (msgEl) msgEl.classList.remove('chat-message-bot--streaming');

        const blocks = Array.isArray(msg.content) ? msg.content : [];
        const reg = this._incrementalRegistry.get(botContainer);

        if (msg.status === 'failed') {
            if (msgEl) msgEl.classList.add('chat-message--failed');
            // Уже допечатанные блоки не перерисовываем; новые (включая error) —
            // мгновенно, без анимации.
            const fresh = reg
                ? blocks.filter((b) => !(b && b.block_id && reg.has(b.block_id)))
                : blocks;
            ChatRenderer.renderBlocks(botContainer, fresh, { execute: false });
        } else if (!reg || reg.size === 0) {
            // Инкрементального рендера не было (обычный LLM-ответ) — как раньше.
            // Дожидаемся конца анимации, чтобы панель реакций встала ПОД ответом.
            await ChatRenderer.typeOutBlocks(botContainer, blocks);
        } else {
            await this._typeOutRemaining(botContainer, blocks, reg);
        }
        this._incrementalRegistry.delete(botContainer);
        // Панель обратной связи под ответом ассистента — включая failed:
        // дизлайк на ошибочном ответе — первичный сигнал «почему ошибка»
        // (см. docs/guides/chat-observability-and-feedback.md).
        // Свежий ответ оценок ещё не имеет (initial=null); conversationId
        // берём из активного контекста (poll-ответ его не содержит).
        if (msg.id) {
            ChatFeedback.attach(botContainer, {
                conversationId: ChatContext.getCurrentConversationId(),
                messageId: msg.id,
                initial: msg.feedback || null,
            });
            ChatEventBus.emit('ui:scroll-bottom');
        }
    },

    /**
     * Прогресс ожидания ответа: строка статуса очереди + допечатывание
     * частичных блоков (reasoning агента) по мере роста.
     *
     * @param {HTMLElement} botContainer
     * @param {Object} msg — {id, status, content, status_details?}
     * @private
     */
    _renderProgress(botContainer, msg) {
        this._updateQueueStatus(botContainer, msg.status_details || null);
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        if (blocks.length) this._renderIncrementalBlocks(botContainer, blocks);
    },

    /**
     * Создаёт/обновляет/удаляет строку статуса очереди над typing-индикатором.
     * details=null или неизвестный bus_status → строка удаляется.
     * @private
     */
    _updateQueueStatus(botContainer, details) {
        const text = this._queueStatusText(details);
        let label = botContainer.querySelector(':scope > .chat-typing-status');
        if (!text) {
            if (label) label.remove();
            return;
        }
        if (!label) {
            label = document.createElement('div');
            label.className = 'chat-typing-status';
            const placeholder = botContainer.querySelector(':scope > .chat-typing-placeholder');
            if (placeholder) {
                botContainer.insertBefore(label, placeholder);
            } else {
                botContainer.appendChild(label);
            }
        }
        if (label.textContent !== text) label.textContent = text;
    },

    /**
     * Текст статуса по status_details из GET-ответа.
     * @private
     */
    _queueStatusText(details) {
        if (!details || !details.bus_status) return '';
        if (details.bus_status === 'pending') {
            const n = details.queue_ahead;
            if (typeof n === 'number' && n > 0) {
                return `В очереди: впереди ${n} ${this._pluralizeRequests(n)}`;
            }
            return 'В очереди: вы следующий';
        }
        if (details.bus_status === 'processing' || details.bus_status === 'in_progress') {
            return 'Агент работает над ответом…';
        }
        return '';
    },

    /**
     * Русская плюрализация слова «запрос».
     * @private
     */
    _pluralizeRequests(n) {
        const mod10 = n % 10;
        const mod100 = n % 100;
        if (mod10 === 1 && mod100 !== 11) return 'запрос';
        if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'запроса';
        return 'запросов';
    },

    /**
     * Допечатывает дельты частичных блоков (по block_id). Накопление без
     * дублей: рендерим только text.slice(renderedLen); анимации на один блок
     * выстраиваются в очередь promise'ов, чтобы дельты не перемешивались.
     * @private
     */
    _renderIncrementalBlocks(botContainer, blocks) {
        let reg = this._incrementalRegistry.get(botContainer);
        if (!reg) {
            reg = new Map();
            this._incrementalRegistry.set(botContainer, reg);
        }
        const signal = this._pollController && this._pollController.signal;
        let appended = false;

        for (const block of blocks) {
            if (!block || typeof block.block_id !== 'string' || !block.block_id) continue;
            if (!ChatRenderer.isStreamingBlockType(block.type)) continue;
            const text = block.content || '';
            let entry = reg.get(block.block_id);
            if (!entry) {
                const sb = ChatRenderer.createStreamingBlock(block.type, block.block_id);
                ChatRenderer.appendBlock(botContainer, sb.element);
                entry = { sb, renderedLen: 0, queue: Promise.resolve() };
                reg.set(block.block_id, entry);
                appended = true;
            }
            if (text.length > entry.renderedLen) {
                const delta = text.slice(entry.renderedLen);
                entry.renderedLen = text.length;
                entry.queue = entry.queue.then(
                    () => ChatRenderer.appendTextAnimated(entry.sb, delta, { signal }),
                );
            }
        }
        if (appended) ChatEventBus.emit('ui:scroll-bottom');
    },

    /**
     * Посев инкрементального рендера при resume (reload/переключение беседы
     * во время ожидания ответа): накопленные text/reasoning-блоки черновика
     * рендерятся МГНОВЕННО, а реестр запоминает их длину — последующий
     * поллинг допечатает только новые дельты, не переанимируя всё с нуля.
     * @private
     */
    _seedIncrementalBlocks(botContainer, blocks) {
        let reg = this._incrementalRegistry.get(botContainer);
        if (!reg) {
            reg = new Map();
            this._incrementalRegistry.set(botContainer, reg);
        }
        for (const block of blocks) {
            if (!block || typeof block.block_id !== 'string' || !block.block_id) continue;
            if (!ChatRenderer.isStreamingBlockType(block.type)) continue;
            if (reg.has(block.block_id)) continue;
            const text = block.content || '';
            const sb = ChatRenderer.createStreamingBlock(block.type, block.block_id);
            ChatRenderer.appendBlock(botContainer, sb.element);
            sb.appendText(text);
            sb.finalize();
            reg.set(block.block_id, { sb, renderedLen: text.length, queue: Promise.resolve() });
        }
    },

    /**
     * Финальный рендер после инкрементального: уже допечатанные блоки получают
     * только недостающий хвост, новые — печатаются как обычно.
     * @private
     */
    async _typeOutRemaining(botContainer, blocks, reg) {
        const signal = this._pollController && this._pollController.signal;
        for (const block of blocks) {
            const bid = (block && typeof block.block_id === 'string') ? block.block_id : null;
            const entry = bid ? reg.get(bid) : null;
            if (entry && ChatRenderer.isStreamingBlockType(block.type)) {
                const text = block.content || '';
                if (text.length > entry.renderedLen) {
                    const delta = text.slice(entry.renderedLen);
                    entry.renderedLen = text.length;
                    entry.queue = entry.queue.then(
                        () => ChatRenderer.appendTextAnimated(entry.sb, delta, { signal }),
                    );
                }
                await entry.queue;
            } else if (entry) {
                // Нетекстовый блок уже в DOM (отрисован инкрементально) — пропускаем.
            } else {
                await ChatRenderer.typeOutSingleBlock(botContainer, block, { signal });
            }
        }
        ChatEventBus.emit('ui:scroll-bottom');
    },

    /**
     * Показывает ошибку получения ответа в typing-bubble.
     *
     * @param {HTMLElement} botContainer
     * @param {Error} err
     * @private
     */
    _renderError(botContainer, err) {
        if (err && err.name === 'AbortError') return; // отмена — молча

        ChatRenderer.removeTypingPlaceholder(botContainer);
        this._updateQueueStatus(botContainer, null); // снять строку статуса очереди
        const msgEl = botContainer.parentElement;
        if (msgEl) msgEl.classList.remove('chat-message-bot--streaming');

        // Показываем реальный текст ошибки (бэк уже отдаёт дружелюбное сообщение,
        // напр. про лимит одновременных запросов), а не общую заглушку.
        const text = (err && err.message)
            ? err.message
            : 'Не удалось получить ответ. Попробуйте ещё раз.';

        // Штатное клиентское отклонение (4xx, напр. лимит запросов) уже показано
        // пользователю — это не сбой, логируем warn'ом, а не красным error'ом.
        const status = err && err.status;
        if (typeof status === 'number' && status >= 400 && status < 500) {
            console.warn('ChatMessages: запрос отклонён —', text);
        } else {
            console.error('ChatMessages: ошибка получения ответа', err);
        }
        const errDiv = document.createElement('div');
        errDiv.className = 'chat-error';
        errDiv.textContent = text;
        botContainer.appendChild(errDiv);

        // Тост — пусть пользователь увидит даже при переключении беседы
        if (typeof Notifications !== 'undefined' && typeof Notifications.error === 'function') {
            try { Notifications.error(text); } catch { /* некритично */ }
        }
    },

    /**
     * Создаёт DOM бот-сообщения для стриминга.
     *
     * @param {Object} [options]
     * @param {boolean} [options.withPlaceholder=true]
     * @returns {HTMLElement} — контейнер .chat-message-content
     * @private
     */
    _addBotMessageStreaming({ withPlaceholder = true } = {}) {
        const msg = document.createElement('div');
        msg.className = 'chat-message chat-message-bot';
        if (withPlaceholder) {
            msg.classList.add('chat-message-bot--streaming');
        }

        const avatar = document.createElement('div');
        avatar.className = 'chat-message-avatar';
        avatar.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;

        const content = document.createElement('div');
        content.className = 'chat-message-content';

        if (withPlaceholder) {
            content.appendChild(ChatRenderer.createTypingPlaceholder());
        }

        msg.appendChild(avatar);
        msg.appendChild(content);

        this._messagesContainer.appendChild(msg);

        return content;
    },

    /**
     * Добавляет сообщение пользователя в DOM
     * @param {string} text
     * @private
     */
    _addUserMessage(text) {
        this.renderMessage('user', text);
    },

    /**
     * Рендерит пользовательское сообщение с файлами
     *
     * @param {string} text — текст сообщения
     * @param {Array<Object>} fileBlocks — файловые блоки
     * @private
     */
    _renderUserMessageWithFiles(text, fileBlocks) {
        const msg = document.createElement('div');
        msg.className = 'chat-message chat-message-user';

        const avatar = document.createElement('div');
        avatar.className = 'chat-message-avatar';
        avatar.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z"
                  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;

        const content = document.createElement('div');
        content.className = 'chat-message-content';

        if (text) {
            const lines = text.split('\n');
            for (const line of lines) {
                const p = document.createElement('p');
                p.textContent = line;
                content.appendChild(p);
            }
        }

        if (fileBlocks && fileBlocks.length > 0) {
            for (const fb of fileBlocks) {
                const el = ChatRenderer.renderBlock(fb);
                if (el) content.appendChild(el);
            }
        }

        msg.appendChild(avatar);
        msg.appendChild(content);
        this._messagesContainer.appendChild(msg);
        ChatEventBus.emit('ui:scroll-bottom');
    },

    /**
     * Показывает system-greeting в чате: «Акт КМ-X • Выбранный блок: N».
     *
     * Это info-баннер, который отображается при вызове «AI-ассистент» из
     * контекстного меню. НЕ вызывает LLM, не создаёт user-сообщение,
     * не отправляет ничего на бэкенд — только рисует DOM-блок.
     *
     * Контекст (KМ + выбранный узел) уже передан в window.__selectedNode
     * и будет автоматически приложен к следующему user-сообщению через
     * ChatStream.sendAndPoll (selected_node_id + current_act_id в FormData
     * попадают в system prompt LLM).
     *
     * Идемпотентно: если system-greeting уже есть — обновляем его текст
     * (это нужно, когда пользователь вызвал AI-ассистента на другом
     * узле — контекст обновляется без дубля баннера и без потери
     * уже отправленных сообщений).
     *
     * @param {Object} ctx — {id, number, label, type} (из window.__selectedNode)
     */
    showNodeContext(ctx) {
        if (!ctx || !this._messagesContainer) return;
        const kmLabel = (window.actMetadata && window.actMetadata.km_number)
            || (window.currentActId ? `id=${window.currentActId}` : '');
        const nodeDesc = ctx.number
            ? `${ctx.number} «${ctx.label || ''}»`
            : (ctx.id || '?');

        // Ищем существующий баннер и обновляем.
        const existing = this._messagesContainer.querySelector(
            '.chat-message-system'
        );
        if (existing) {
            const textEl = existing.querySelector('.chat-system-text');
            if (textEl) {
                textEl.textContent = kmLabel
                    ? `Акт ${kmLabel} • Блок: ${nodeDesc}`
                    : `Блок: ${nodeDesc}`;
            }
            ChatEventBus.emit('ui:scroll-bottom');
            return;
        }

        // Иначе создаём новый. Без аватара, по центру, с иконкой.
        const msg = document.createElement('div');
        msg.className = 'chat-message chat-message-system';
        msg.setAttribute('data-source', 'node-context');

        const content = document.createElement('div');
        content.className = 'chat-message-content';

        const icon = document.createElement('span');
        icon.className = 'chat-system-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = '📋';

        const label = document.createElement('span');
        label.className = 'chat-system-label';
        label.textContent = 'Контекст';

        const text = document.createElement('span');
        text.className = 'chat-system-text';
        text.textContent = kmLabel
            ? `Акт ${kmLabel} • Блок: ${nodeDesc}`
            : `Блок: ${nodeDesc}`;

        content.appendChild(icon);
        content.appendChild(label);
        content.appendChild(text);
        msg.appendChild(content);
        this._messagesContainer.appendChild(msg);
        ChatEventBus.emit('ui:scroll-bottom');
    },

    /**
     * Создаёт DOM-элемент сообщения и вставляет в контейнер
     *
     * @param {'user'|'bot'} role
     * @param {string} text
     */
    renderMessage(role, text) {
        const msg = document.createElement('div');
        msg.className = `chat-message chat-message-${role}`;

        const avatar = document.createElement('div');
        avatar.className = 'chat-message-avatar';

        if (role === 'bot') {
            avatar.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>`;
        } else {
            avatar.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z"
                      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>`;
        }

        const content = document.createElement('div');
        content.className = 'chat-message-content';

        const lines = text.split('\n');
        for (const line of lines) {
            const p = document.createElement('p');
            p.textContent = line;
            content.appendChild(p);
        }

        msg.appendChild(avatar);
        msg.appendChild(content);

        this._messagesContainer.appendChild(msg);
        ChatEventBus.emit('ui:scroll-bottom');
    },

    /**
     * Рендерит все сообщения загруженной беседы.
     * Для assistant-сообщений со status==='streaming' ставит typing-bubble
     * и возобновляет polling, чтобы закрыть сценарий reload/switch в процессе ожидания.
     *
     * @param {Object} data
     * @param {string} data.conversationId
     * @param {Array} data.messages
     * @private
     */
    _renderConversationMessages({ conversationId, messages }) {
        this._messagesContainer.replaceChildren();

        for (const msg of messages) {
            const blocks = Array.isArray(msg.content) ? msg.content : [];

            if (msg.role === 'user') {
                const textBlock = blocks.find(b => b.type === 'text');
                const text = textBlock ? (textBlock.content || '') : '';
                const fileBlocks = blocks.filter(b => b.type === 'file');
                this._renderUserMessageWithFiles(text, fileBlocks);
            } else if (msg.role === 'assistant') {
                const isStreaming = msg.status === 'streaming';
                const isFailed = msg.status === 'failed';

                if (blocks.length > 0 || isStreaming) {
                    const container = this._addBotMessageStreaming({
                        withPlaceholder: isStreaming,
                    });
                    if (!isStreaming) {
                        ChatRenderer.renderBlocks(container, blocks, { execute: false });
                    } else if (blocks.length > 0) {
                        // Resume: накопленный черновик показываем сразу (без
                        // анимации) и seed'им реестр — поллинг допечатает
                        // только новые дельты.
                        this._seedIncrementalBlocks(container, blocks);
                    }
                    if (isFailed) {
                        const msgEl = container.parentElement;
                        if (msgEl) msgEl.classList.add('chat-message--failed');
                    }
                    // Панель обратной связи + восстановление ранее выставленной
                    // оценки текущего пользователя (msg.feedback из GET истории).
                    // failed-сообщения тоже оцениваются («почему ошибка»).
                    if (!isStreaming && msg.id) {
                        ChatFeedback.attach(container, {
                            conversationId: msg.conversation_id || conversationId,
                            messageId: msg.id,
                            initial: msg.feedback || null,
                        });
                    }
                    // Если сообщение ещё в статусе streaming — возобновляем polling
                    if (isStreaming && msg.id) {
                        this._abortPoll();
                        const controller = new AbortController();
                        this._pollController = controller;
                        ChatStream.pollMessage(conversationId, msg.id, {
                            onReady: (m) => {
                                this._renderReadyMessage(container, m);
                                ChatEventBus.emit('ui:scroll-bottom');
                            },
                            // Resume после reload: накопленный черновик уже отрисован
                            // мгновенно через _seedIncrementalBlocks, реестр знает
                            // renderedLen — progress-тики допечатывают только дельты.
                            onProgress: (m) => this._renderProgress(container, m),
                            onError: (e) => {
                                this._renderError(container, e);
                                ChatEventBus.emit('ui:scroll-bottom');
                            },
                            signal: controller.signal,
                        });
                    }
                } else {
                    this.renderMessage('bot', '');
                }
            }
        }

        ChatEventBus.emit('ui:scroll-bottom');
    },

    /**
     * Восстанавливает welcome-сообщение
     * @private
     */
    _restoreWelcome() {
        this._messagesContainer.replaceChildren();
        if (this._welcomeNode) {
            this._messagesContainer.appendChild(this._welcomeNode.cloneNode(true));
        }
    },
};

window.ChatMessages = ChatMessages;

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.KNOWN_BLOCK_TYPES = KNOWN_BLOCK_TYPES;
