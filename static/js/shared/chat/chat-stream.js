/**
 * Poll-клиент для получения ответов чата.
 *
 * Отправляет сообщение через FormData (POST → JSON {message_id}),
 * затем опрашивает GET /{message_id} до статуса complete/failed.
 * Декоративный эффект печати — на стороне ChatRenderer.
 */
import { AppConfig } from '../app-config.js';
import { AuthManager } from '../auth.js';

export const ChatStream = {

    /**
     * Отправляет сообщение и опрашивает бэк до готовности ответа.
     *
     * @param {string} conversationId — ID беседы
     * @param {string} message — текст сообщения
     * @param {File[]} files — прикреплённые файлы
     * @param {Object} options
     * @param {string} [options.agentMode='off'] — режим агента (off/adaptive/always)
     * @param {string[]|null} [options.domains=null] — фильтр доменов
     * @param {function(Object): void} [options.onReady] — вызывается с {id, status, content}
     * @param {function(Object): void} [options.onProgress] — каждый тик опроса со status='streaming' (промежуточные блоки и статус очереди агента)
     * @param {function(Error): void} [options.onError] — вызывается при ошибке
     * @param {AbortSignal} [options.signal] — внешний сигнал отмены
     */
    async sendAndPoll(conversationId, message, files = [], options = {}) {
        const { agentMode = 'off', domains = null, onReady, onProgress, onError, signal } = options;

        const fd = this._buildFormData(message, files, domains);
        fd.append('agent_mode', agentMode);

        // Передаём backend'у id акта, в котором сейчас работает пользователь
        // (страница конструктора /constructor?act_id=X). Бэкенд использует
        // его, чтобы AI-ассистент понимал «текущий акт» по умолчанию для
        // операций модификации (create_act/add_processes_to_act и т.п.).
        // Вне конструктора — act_id=null, AI использует контекст диалога
        // (например, явное упоминание КМ пользователем).
        const currentActId = this._detectCurrentActId();
        if (currentActId !== null) {
            fd.append('current_act_id', String(currentActId));
        }

        let res;
        try {
            res = await fetch(
                AppConfig.api.getUrl(AppConfig.chatEndpoints.messages(conversationId)),
                { method: 'POST', body: fd, headers: this._buildHeaders(), signal },
            );
        } catch (e) {
            if (onError) onError(e);
            return;
        }

        if (!res.ok) {
            if (onError) onError(await this._errorFromResponse(res));
            return;
        }

        let body;
        try {
            body = await res.json();
        } catch (e) {
            if (onError) onError(new Error('Неверный ответ сервера'));
            return;
        }

        const messageId = body.message_id;
        if (!messageId) {
            if (onError) onError(new Error('Сервер не вернул message_id'));
            return;
        }

        return this.pollMessage(conversationId, messageId, { onReady, onProgress, onError, signal });
    },

    /**
     * Опрашивает бэк до статуса complete/failed.
     * Используется также для resume при reload/switch посреди ожидания.
     *
     * Таймаут — idle-семантика, зеркало серверной: пока payload меняется
     * (статус очереди, рост блоков) — ждём; замер без изменений дольше
     * фазового лимита — ошибка. Жёсткого потолка нет: источник истины
     * таймаутов — бэкенд (он сам зафейлит черновик по claim/answer-лимитам).
     *
     * @param {string} conversationId
     * @param {string} messageId
     * @param {Object} options
     * @param {function(Object): void} [options.onReady]
     * @param {function(Object): void} [options.onProgress] — каждый тик со status='streaming'
     * @param {function(Error): void} [options.onError]
     * @param {AbortSignal} [options.signal]
     */
    pollMessage(conversationId, messageId, options = {}) {
        const { onReady, onProgress, onError, signal } = options;
        const url = AppConfig.api.getUrl(
            `/api/v1/chat/conversations/${conversationId}/messages/${messageId}`,
        );

        // Idle-лимиты: pending зеркалит серверный claim_timeout (30 мин),
        // остальные фазы — answer_timeout (10 мин); + слак на поллинг.
        const IDLE_LIMIT_PENDING_MS = 31 * 60 * 1000;
        const IDLE_LIMIT_DEFAULT_MS = 11 * 60 * 1000;
        const INTERVAL_PENDING_MS = 4000;  // в очереди — опрашиваем реже
        const INTERVAL_ACTIVE_MS = 1500;
        const MAX_CONSECUTIVE_FETCH_ERRORS = 5;

        let lastChangeAt = Date.now();
        let lastFingerprint = '';
        let consecutiveErrors = 0;

        // Возвращаем Promise, который резолвится в КАЖДОМ терминальном исходе:
        // complete/failed, idle-таймаут, серия сетевых ошибок, отмена через signal.
        // Без этого `await sendAndPoll(...)` разблокировал бы ui:processing
        // сразу после POST, пока polling ещё идёт.
        return new Promise((resolve) => {
            const tick = async () => {
                if (signal && signal.aborted) {
                    resolve();
                    return;
                }

                let msg;
                try {
                    const r = await fetch(url, { headers: this._buildHeaders(), signal });
                    if (!r.ok) {
                        if (onError) onError(await this._errorFromResponse(r));
                        resolve();
                        return;
                    }
                    msg = await r.json();
                    consecutiveErrors = 0;
                } catch (e) {
                    if (signal && signal.aborted) {
                        resolve();
                        return;
                    }
                    // Транзиентная сетевая ошибка: даём бэку шанс ожить,
                    // серия подряд — считаем его мёртвым.
                    consecutiveErrors += 1;
                    if (consecutiveErrors >= MAX_CONSECUTIVE_FETCH_ERRORS) {
                        if (onError) onError(e);
                        resolve();
                        return;
                    }
                    setTimeout(tick, INTERVAL_ACTIVE_MS);
                    return;
                }

                // Отмена могла случиться, пока ответ был в полёте (между fetch
                // и этим местом) — не рендерим в уже покинутый контейнер.
                if (signal && signal.aborted) {
                    resolve();
                    return;
                }

                if (msg.status === 'complete' || msg.status === 'failed') {
                    if (onReady) onReady(msg);
                    resolve();
                    return;
                }

                if (onProgress) {
                    try {
                        onProgress(msg);
                    } catch (e) {
                        console.warn('ChatStream: ошибка onProgress', e);
                    }
                }

                // Idle-детект: «изменилось что-нибудь?» — статус, статус очереди
                // или длины текстов блоков (рост reasoning агента).
                // Ожидаемые поля status_details от бэка: {bus_status: str, queue_ahead: int|null}.
                const fingerprint = JSON.stringify({
                    s: msg.status,
                    d: msg.status_details || null,
                    c: Array.isArray(msg.content)
                        ? msg.content.map((b) => (
                            (b && typeof b.content === 'string') ? b.content.length : 0
                        ))
                        : [],
                });
                if (fingerprint !== lastFingerprint) {
                    lastFingerprint = fingerprint;
                    lastChangeAt = Date.now();
                }

                const busStatus = msg.status_details && msg.status_details.bus_status;
                const idleLimit = (busStatus === 'pending')
                    ? IDLE_LIMIT_PENDING_MS
                    : IDLE_LIMIT_DEFAULT_MS;
                if (Date.now() - lastChangeAt > idleLimit) {
                    if (onError) onError(new Error('Превышено время ожидания ответа.'));
                    resolve();
                    return;
                }

                setTimeout(tick, (busStatus === 'pending') ? INTERVAL_PENDING_MS : INTERVAL_ACTIVE_MS);
            };

            tick();
        });
    },

    /**
     * Прерывает текущий polling (через переданный AbortController).
     * Метод оставлен для совместимости с вызовами в chat-messages.js —
     * реальная отмена идёт через AbortSignal, хранимый в ChatMessages.
     */
    abort() {
        // no-op: отмена производится через AbortSignal в ChatMessages._pollController
    },

    /**
     * Формирует FormData для отправки сообщения.
     *
     * @param {string} message
     * @param {File[]} files
     * @param {string[]|null} [domains]
     * @returns {FormData}
     * @private
     */
    _buildFormData(message, files, domains) {
        const formData = new FormData();
        formData.append('message', message);

        if (domains && domains.length > 0) {
            formData.append('domains', JSON.stringify(domains));
        }

        for (const file of files) {
            formData.append('files', file);
        }

        return formData;
    },

    /**
     * Формирует заголовки запроса (только auth, если пользователь известен).
     *
     * @returns {Object}
     * @private
     */
    _buildHeaders() {
        const headers = {};

        if (typeof AuthManager !== 'undefined' && AuthManager.getCurrentUser()) {
            Object.assign(headers, AuthManager.getAuthHeaders());
        }

        return headers;
    },

    /**
     * Определяет id акта, в котором сейчас работает пользователь.
     *
     * Источники (по приоритету):
     * 1) `?act_id=N` в URL (страница конструктора).
     * 2) meta-тег `<meta name="current-act" content="N">` —
     *    запасной канал, если URL-параметр по какой-то причине не виден
     *    (например, в iframe или hash-роутинге).
     *
     * @returns {number|null}
     * @private
     */
    _detectCurrentActId() {
        // 1) URL ?act_id=
        try {
            const param = new URLSearchParams(window.location.search)
                .get('act_id');
            if (param) {
                const n = parseInt(param, 10);
                if (Number.isFinite(n) && n > 0) return n;
            }
        } catch (_) { /* sandboxed / no URL */ }

        // 2) meta-тег current-act (fallback)
        const meta = document.querySelector('meta[name="current-act"]');
        if (meta) {
            const raw = meta.getAttribute('content');
            const n = parseInt(raw, 10);
            if (Number.isFinite(n) && n > 0) return n;
        }

        return null;
    },

    /**
     * Строит Error из не-ok ответа. Пытается прочитать detail из JSON.
     *
     * @param {Response} response
     * @returns {Promise<Error>}
     * @private
     */
    async _errorFromResponse(response) {
        const fallback = `HTTP ${response.status}: ${response.statusText}`;
        let err;
        try {
            const body = await response.json();
            if (body && typeof body === 'object') {
                err = new Error(body.detail || body.error || fallback);
            }
        } catch { /* тело пустое или не JSON */ }
        if (!err) err = new Error(fallback);
        // Статус нужен вызывающему, чтобы отличить штатное клиентское
        // отклонение (4xx, напр. лимит запросов) от реального сбоя (5xx/сеть).
        err.status = response.status;
        return err;
    },
};

window.ChatStream = ChatStream;
