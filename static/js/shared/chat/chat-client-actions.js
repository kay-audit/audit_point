/**
 * ClientActionsRegistry — реестр и исполнитель чисто-клиентских команд.
 *
 * Вызывается из ChatRenderer при получении блока type === 'client_action'.
 * Стандартные команды: open_url, notify, trigger_sdk.
 * Домены могут регистрировать свои через ClientActionsRegistry.register(...).
 */


export const handlers = {};

// Ключ sessionStorage для уже исполненных block_id.
// Идемпотентность нужна, чтобы перезагрузка страницы или повторный
// рендер того же ответа не приводили к повторному redirect/notify.
export const EXECUTED_STORAGE_KEY = 'chat:executedActions';
// Soft cap, чтобы Set не рос бесконечно.
export const EXECUTED_MAX_SIZE = 500;

/** @type {Set<string>} */
export const executed = (() => {
    try {
        const raw = sessionStorage.getItem(EXECUTED_STORAGE_KEY);
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) return new Set(arr);
        }
    } catch (_) { /* sessionStorage недоступен или битый JSON */ }
    return new Set();
})();

export function _persistExecuted() {
    try {
        // При переполнении выкидываем самые старые (insertion order Set).
        let arr = Array.from(executed);
        if (arr.length > EXECUTED_MAX_SIZE) {
            arr = arr.slice(arr.length - EXECUTED_MAX_SIZE);
            executed.clear();
            arr.forEach(id => executed.add(id));
        }
        sessionStorage.setItem(EXECUTED_STORAGE_KEY, JSON.stringify(arr));
    } catch (_) { /* квота / приватный режим */ }
}

export const ClientActionsRegistry = {
    register(name, fn) {
        if (typeof fn !== 'function') {
            console.error(
                `ClientActionsRegistry.register: handler для "${name}" не функция`
            );
            return;
        }
        handlers[name] = fn;
    },

    execute(action, params) {
        const fn = handlers[action];
        if (!fn) {
            console.warn(`ClientActionsRegistry: неизвестная команда "${action}"`);
            return;
        }
        try {
            fn(params || {});
        } catch (err) {
            console.error(`ClientActionsRegistry: ошибка в "${action}":`, err);
        }
    },

    /**
     * Идемпотентное исполнение client_action.
     *
     * Если у блока есть {@code block_id} — сохраняем его в sessionStorage
     * и при повторном вызове с тем же id молча выходим (отчёт в console).
     * Если block_id отсутствует (старые сообщения / бэк ещё не передаёт) —
     * выполняем как раньше, с warning'ом.
     *
     * Контракт с бэком: блок имеет вид {action, params, label, block_id}.
     * Поле block_id (string uuid) проставляется на сервере; фронт его
     * только читает и хранит.
     *
     * @param {{action: string, params?: Object, block_id?: string}} block
     */
    executeBlock(block) {
        if (!block || typeof block !== 'object') return;
        const blockId = block.block_id;
        if (blockId) {
            if (executed.has(blockId)) {
                return; // уже выполняли — молча выходим
            }
            executed.add(blockId);
            _persistExecuted();
        } else {
            console.warn(
                'ClientActionsRegistry.executeBlock: block_id отсутствует;'
                + ' идемпотентность отключена для этого действия'
            );
        }
        this.execute(block.action, block.params || {});
    },

    isRegistered(action) {
        return typeof handlers[action] === 'function';
    },

    list() {
        return Object.keys(handlers);
    },

    /**
     * Очищает кеш исполненных block_id (для тестов).
     */
    _resetExecuted() {
        executed.clear();
        try { sessionStorage.removeItem(EXECUTED_STORAGE_KEY); } catch (_) {}
    },
};

// ── Стандартные команды ────────────────────────────────────────────

// Whitelist URL-схем для open_url. Совпадает с backend ALLOWED_OPEN_URL_SCHEMES
// в app/core/chat/blocks.py — defense in depth, чтобы при пропуске
// валидации на бэке (новый источник ClientActionBlock) фронт всё равно
// отверг javascript:..., data:..., vbscript:..., file:...
export const ALLOWED_OPEN_URL_SCHEMES = ['http://', 'https://', 'mailto:', '/'];

export function isAllowedUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    return ALLOWED_OPEN_URL_SCHEMES.some(s => url.startsWith(s));
}

/**
 * Разрешает относительные пути с учётом JupyterHub-прокси.
 *
 * Бэк-handler'ы (admin.open_admin_panel, acts.open_act_page и т.п.)
 * отдают url'ы в виде "/admin", "/constructor?act_id=...". В деплое за
 * JupyterHub proxy реальные ресурсы живут под /user/{user}/proxy/{port}/...
 * Без подстановки префикса браузер уходит на корень origin'а (например
 * /hub/admin), что 404.
 *
 * Абсолютные http(s)/mailto URL остаются как есть.
 */
export function resolveProxyUrl(url) {
    if (typeof url !== 'string' || !url) return url;
    if (!url.startsWith('/')) return url;
    if (typeof AppConfig !== 'undefined'
        && AppConfig.api
        && typeof AppConfig.api.getUrl === 'function') {
        return AppConfig.api.getUrl(url);
    }
    return url;
}

ClientActionsRegistry.register('open_url', ({ url }) => {
    if (!isAllowedUrl(url)) {
        console.warn(`open_url: запрещённая схема URL: ${String(url).slice(0, 40)}`);
        return;
    }
    window.location.href = resolveProxyUrl(url);
});

// Конструктор актов: после модификации структуры (add_item / add_table
// / delete_node / move_node) ассистент возвращает client_action с
// action='refresh_act', чтобы UI перечитал содержимое без перезагрузки
// страницы (раньше возвращался open_url, эквивалентный Ctrl+Shift+R).
//
// Действие идемпотентно: повторный вызов с тем же act_id — безвреден.
ClientActionsRegistry.register('refresh_act', ({ act_id }) => {
    if (!act_id) {
        console.warn('refresh_act: не передан act_id');
        return;
    }
    // На разных страницах по-разному: на конструкторе вызываем
    // APIClient.loadActContent(act_id) — перечитывает дерево/таблицы/
    // текстовые блоки/нарушения в state и обновляет рендер. На других
    // страницах (sidebar landing и т.д.) — просто navigation на
    // /constructor?act_id={act_id}, чтобы пользователь увидел
    // изменения в привычном месте.
    if (typeof window.APIClient !== 'undefined'
        && typeof window.APIClient.loadActContent === 'function'
        && document.getElementById('treePanel') !== null) {
        // Мы в конструкторе — обновляем in-place.
        window.APIClient.loadActContent(act_id).catch((err) => {
            console.error('refresh_act: ошибка загрузки акта', err);
        });
    } else {
        // Вне конструктора — переходим.
        window.location.href = resolveProxyUrl(
            `/constructor?act_id=${act_id}`
        );
    }
});

ClientActionsRegistry.register('notify', ({ message, level }) => {
    const lvl = level || 'info';
    if (window.Notifications && typeof window.Notifications.show === 'function') {
        window.Notifications.show(message, lvl);
    } else {
        // Fallback, если модуль уведомлений ещё не подключён
        console.log(`[notify:${lvl}] ${message}`);
    }
});

// Whitelist методов для trigger_sdk. Без него LLM мог бы вызвать любую
// функцию window: alert, eval-аналоги, fetch, и т.д.
export const ALLOWED_SDK_METHODS = new Set([
    // Пусто по умолчанию: проект пока не использует trigger_sdk.
    // Добавляй сюда явно, когда понадобится конкретный SDK-метод.
]);

ClientActionsRegistry.register('trigger_sdk', ({ method, args }) => {
    if (typeof method !== 'string' || !ALLOWED_SDK_METHODS.has(method)) {
        console.warn(`trigger_sdk: метод "${method}" не в whitelist`);
        return;
    }
    if (typeof window[method] !== 'function') {
        console.warn(`trigger_sdk: метод "${method}" не существует в window`);
        return;
    }
    window[method](...(Array.isArray(args) ? args : []));
});

window.ClientActionsRegistry = ClientActionsRegistry;
