/**
 * Единая точка регистрации beforeunload-обработчиков.
 *
 * Несколько модулей конструктора (App.scroll-persistence, StorageManager,
 * LockManager) независимо вешали свои beforeunload-листенеры. Без общего
 * реестра при destroy/teardown их легко забыть снять — особенно при switch'е
 * между актами. Helper держит Map<name, handler> и позволяет
 * атомарно unregister по имени.
 *
 * Использование:
 *   LifecycleHelper.registerBeforeUnload('scroll', () => App.persistViewPositionForAct(actId));
 *   LifecycleHelper.unregister('scroll');
 */
export const LifecycleHelper = {
    /**
     * Зарегистрированные beforeunload-обработчики
     * @private
     * @type {Map<string, Function>}
     */
    _handlers: new Map(),

    /**
     * Регистрирует beforeunload-обработчик под именем.
     * Если хендлер с таким именем уже зарегистрирован — старый снимается.
     * @param {string} name
     * @param {(event: BeforeUnloadEvent) => any} handler
     */
    registerBeforeUnload(name, handler) {
        const existing = this._handlers.get(name);
        if (existing) {
            window.removeEventListener('beforeunload', existing);
        }
        this._handlers.set(name, handler);
        window.addEventListener('beforeunload', handler);
    },

    /**
     * Снимает зарегистрированный обработчик по имени. Идемпотентен.
     * @param {string} name
     */
    unregister(name) {
        const handler = this._handlers.get(name);
        if (handler) {
            window.removeEventListener('beforeunload', handler);
            this._handlers.delete(name);
        }
    },

    /**
     * Список зарегистрированных имён (для диагностики).
     * @returns {string[]}
     */
    list() {
        return [...this._handlers.keys()];
    }
};

window.LifecycleHelper = LifecycleHelper;
