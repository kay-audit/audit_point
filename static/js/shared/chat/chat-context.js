/**
 * Контекст чата
 *
 * Управление текущей беседой, knowledge bases и доменами.
 * Интегрируется с ChatHistory через callback.
 */
import { AppConfig } from '../app-config.js';
import { AuthManager } from '../auth.js';
import { ChatEventBus } from './chat-event-bus.js';
import { ChatHistory } from './chat-history.js';
import { ChatTitle } from './chat-title.js';

export const ChatContext = {

    /** @type {boolean} */
    _initialized: false,
    /** @type {string|null} ID текущей активной беседы */
    _currentConversationId: null,

    /** @type {Object<string, string>|null} Маппинг key->label баз знаний */
    _knowledgeBaseMap: null,

    /** @type {Promise<string>|null} Pending promise для ensureConversation (защита от дублей) */
    _pendingEnsure: null,

    /**
     * Стабильная ссылка на обработчик `chat:clear` — нужна для парного `off()`
     * в `destroy()`. Анонимная стрелка ломала бы симметрию: подписаться можно,
     * отписаться — нет (handler-ссылку взять негде, повторный `init()` создал бы
     * второй listener, утечка слушателей при горячей переинициализации).
     */
    _onChatClear: null,

    /**
     * Инициализация: подключение ChatHistory callback
     */
    init() {
        if (this._initialized) return;
        const historyContainer = document.getElementById('chatHistoryContainer');
        if (historyContainer && typeof ChatHistory !== 'undefined') {
            ChatHistory.init(historyContainer);
            ChatHistory.onConversationChange = (conversationId) => {
                this._onConversationSwitch(conversationId);
            };
            ChatHistory.loadConversations();
        }

        this._onChatClear = () => {
            this._currentConversationId = null;
            this._pendingEnsure = null;
        };
        ChatEventBus.on('chat:clear', this._onChatClear);

        this._initialized = true;
    },

    /**
     * Снимает подписки и сбрасывает флаг инициализации.
     * Парно `init()` — для случаев hot-reload и тестов.
     */
    destroy() {
        if (!this._initialized) return;
        if (this._onChatClear) {
            ChatEventBus.off('chat:clear', this._onChatClear);
            this._onChatClear = null;
        }
        this._initialized = false;
    },

    /**
     * Создаёт беседу, если ещё нет активной, и возвращает ID.
     *
     * Опциональные аргументы пробрасываются в `_createConversation()`,
     * чтобы фронт мог сразу задать осмысленный title (см. ChatTitle.derive).
     * Если аргументы не переданы — title не отправляем, бэк проставит дефолт.
     *
     * @param {string} [firstMessageText] — текст первого сообщения пользователя
     * @param {Array<{name?: string}>} [files] — прикреплённые файлы
     * @returns {Promise<string>}
     */
    async ensureConversation(firstMessageText, files) {
        if (this._currentConversationId) {
            return this._currentConversationId;
        }

        // Promise lock: если уже создаём — возвращаем тот же промис
        if (this._pendingEnsure) {
            return this._pendingEnsure;
        }

        this._pendingEnsure = this._createConversation(firstMessageText, files);
        try {
            return await this._pendingEnsure;
        } finally {
            this._pendingEnsure = null;
        }
    },

    /**
     * Внутренний метод создания беседы.
     *
     * @param {string} [firstMessageText] — текст первого сообщения пользователя
     * @param {Array<{name?: string}>} [files] — прикреплённые файлы
     * @returns {Promise<string>}
     * @private
     */
    async _createConversation(firstMessageText, files) {
        // Title вычисляем только если есть исходные данные первого сообщения;
        // без них бэк проставит дефолтное название (не ломаем обратную
        // совместимость для вызовов вроде resetToNew/loadConversations).
        const hasFirstInput = firstMessageText !== undefined
            || (Array.isArray(files) && files.length > 0);
        const title = hasFirstInput
            && typeof ChatTitle !== 'undefined'
            ? ChatTitle.derive(firstMessageText || '', files || [])
            : null;

        // Создаём беседу через ChatHistory, если доступен.
        // Подавляем callback, чтобы _onConversationSwitch
        // не очистил DOM с сообщениями.
        if (typeof ChatHistory !== 'undefined') {
            const origCallback = ChatHistory.onConversationChange;
            ChatHistory.onConversationChange = null;
            await ChatHistory.createConversation(null, { title });
            ChatHistory.onConversationChange = origCallback;
            this._currentConversationId = ChatHistory.getCurrentId();
        } else {
            // Fallback: создаём напрямую
            const endpoint = AppConfig.chatEndpoints.conversations;
            const url = typeof AppConfig !== 'undefined'
                ? AppConfig.api.getUrl(endpoint)
                : endpoint;

            const headers = { 'Content-Type': 'application/json' };
            if (typeof AuthManager !== 'undefined' && AuthManager.getCurrentUser()) {
                Object.assign(headers, AuthManager.getAuthHeaders());
            }

            const body = {};
            if (title) body.title = title;

            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const conversation = await response.json();
            this._currentConversationId = conversation.id;
        }

        return this._currentConversationId;
    },

    /**
     * Возвращает ID текущей беседы
     * @returns {string|null}
     */
    getCurrentConversationId() {
        return this._currentConversationId;
    },

    /**
     * Читает включённые базы знаний из localStorage
     * @returns {string[]} массив label включённых баз
     */
    getEnabledKnowledgeBases() {
        try {
            const data = localStorage.getItem('assistant_knowledge_bases');
            if (!data) return [];

            const state = JSON.parse(data);
            const kbMap = this._getKnowledgeBaseMap();
            const enabled = [];
            for (const [key, label] of Object.entries(kbMap)) {
                if (state[key]) enabled.push(label);
            }
            return enabled;
        } catch {
            return [];
        }
    },

    /**
     * Определяет список доменов для фильтрации tools из meta-тега
     * @returns {string[]|null} массив доменов или null (все tools)
     */
    detectDomains() {
        const meta = document.querySelector('meta[name="chat-domains"]');
        if (!meta) return null;

        try {
            const domains = JSON.parse(meta.content);
            return Array.isArray(domains) ? domains : null;
        } catch {
            return null;
        }
    },

    /**
     * Вызывается при переключении беседы в ChatHistory
     * @param {string|null} conversationId — ID новой беседы
     * @private
     */
    async _onConversationSwitch(conversationId) {
        this._currentConversationId = conversationId;

        if (!conversationId) {
            ChatEventBus.emit('context:conversation-cleared');
            return;
        }

        // Загружаем сообщения выбранной беседы
        try {
            const endpoint = AppConfig.chatEndpoints.messages(conversationId);
            const url = typeof AppConfig !== 'undefined'
                ? AppConfig.api.getUrl(endpoint)
                : endpoint;

            const headers = {};
            if (typeof AuthManager !== 'undefined' && AuthManager.getCurrentUser()) {
                Object.assign(headers, AuthManager.getAuthHeaders());
            }

            const response = await fetch(url, { headers });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const data = await response.json();
            const messages = data.items || [];

            ChatEventBus.emit('context:conversation-switched', {
                conversationId,
                messages,
            });
        } catch (err) {
            console.error('ChatContext: ошибка загрузки сообщений', err);
        }
    },

    /**
     * Опрашивает бэк — есть ли для беседы активный forward к внешнему
     * агенту (незавершённый запрос в шине). Используется при
     * переключении/загрузке беседы, чтобы после перезагрузки страницы
     * фронт мог продолжить polling уже идущего ответа.
     *
     * Возвращает `null` при 204 (нет активных), любой не-ok ответ
     * (404/403/5xx/сеть) — graceful no-op: возвращаем null, UI не валим.
     *
     * @param {string} conversationId
     * @returns {Promise<{request_id: string, status: string, created_at: string}|null>}
     */
    async checkActiveForward(conversationId) {
        if (!conversationId) return null;
        try {
            const endpoint = AppConfig.chatEndpoints.activeForward(conversationId);
            const url = (typeof AppConfig !== 'undefined')
                ? AppConfig.api.getUrl(endpoint)
                : endpoint;

            const headers = {};
            if (typeof AuthManager !== 'undefined' && AuthManager.getCurrentUser()) {
                Object.assign(headers, AuthManager.getAuthHeaders());
            }

            const response = await fetch(url, { headers });
            if (response.status === 204) return null;
            if (!response.ok) return null;
            return await response.json();
        } catch (err) {
            console.warn('ChatContext: ошибка проверки active-forward', err);
            return null;
        }
    },

    /**
     * Возвращает выбранный режим агента ОАРБ.
     * Читает из localStorage['assistant_oarb_mode'];
     * если значение отсутствует или невалидно — возвращает 'always'.
     *
     * @returns {'off'|'adaptive'|'always'}
     */
    getAgentMode() {
        const valid = ['off', 'adaptive', 'always'];
        try {
            const val = localStorage.getItem('assistant_oarb_mode');
            return valid.includes(val) ? val : 'always';
        } catch {
            return 'always';
        }
    },

    /**
     * Загружает маппинг key->label баз знаний из DOM
     * @returns {Object<string, string>}
     * @private
     */
    _getKnowledgeBaseMap() {
        if (this._knowledgeBaseMap !== null) return this._knowledgeBaseMap;

        this._knowledgeBaseMap = {};

        // Источник 1: meta-тег chat-knowledge-bases (JSON массив)
        const meta = document.querySelector('meta[name="chat-knowledge-bases"]');
        if (meta) {
            try {
                const bases = JSON.parse(meta.content);
                if (Array.isArray(bases)) {
                    for (const kb of bases) {
                        if (kb.key && kb.label) {
                            this._knowledgeBaseMap[kb.key] = kb.label;
                        }
                    }
                    return this._knowledgeBaseMap;
                }
            } catch { /* fallback ниже */ }
        }

        // Источник 2: data-атрибуты DOM-элементов
        const options = document.querySelectorAll('.settings-option[data-kb-key]');
        for (const opt of options) {
            const key = opt.dataset.kbKey;
            const label = opt.dataset.kbLabel;
            if (key && label) {
                this._knowledgeBaseMap[key] = label;
            }
        }

        return this._knowledgeBaseMap;
    },
};

window.ChatContext = ChatContext;
