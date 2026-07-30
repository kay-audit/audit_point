/**
 * EscapeStack — централизованный стек ESC-обработчиков.
 *
 * Проблема: 20+ компонентов (диалоги, контекстные меню, дропдауны, попапы)
 * вешали `keydown`-listener на ESC независимо. При вложенных оверлеях
 * (диалог → context-menu в нём) ESC закрывал ВСЕ слои сразу либо
 * непредсказуемый из них первым.
 *
 * Решение: один listener на document, LIFO-стек. При нажатии ESC срабатывает
 * только верхний хэндлер, и событие останавливается через
 * `stopImmediatePropagation`, чтобы старые legacy-handler'ы (если ещё остались)
 * не отрабатывали.
 *
 * Использование:
 *
 *   const unsub = EscapeStack.push(() => { closeMenu(); });
 *   // ... позже:
 *   unsub();  // или EscapeStack.remove(handler)
 *
 * Возвращаемая функция-unsubscribe идемпотентна.
 *
 * Протокол passthrough (§5.9): хэндлер может вернуть строго `false` — тогда
 * событие НЕ останавливается и уходит дальше к обычным listener'ам. Нужно
 * слоям, чья принадлежность ESC зависит от состояния: активная зона нарушений
 * забирает ESC только когда каретка НЕ в редактируемом поле, иначе отдаёт его
 * редактору. Любое другое возвращаемое значение (в т.ч. undefined) и исключение
 * в хэндлере означают «событие съедено» — обратная совместимость полная.
 */
export class EscapeStack {
    static _stack = [];
    static _initialized = false;

    static _init() {
        if (this._initialized) return;
        this._initialized = true;
        // capture-фаза — перехватываем до старых legacy-listener'ов в bubbling.
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (this._stack.length === 0) return;
            const top = this._stack[this._stack.length - 1];
            // stopImmediatePropagation — ПОСЛЕ хэндлера, чтобы он мог отказаться
            // от события (вернуть false). Порядок безопасен: остановка,
            // вызванная синхронно внутри listener'а, всё равно блокирует все
            // последующие listener'ы. Исключение = «съедено» (прежняя семантика).
            let passthrough = false;
            try {
                passthrough = top(e) === false;
            } catch (err) {
                console.error('[EscapeStack] handler threw:', err);
            }
            if (!passthrough) e.stopImmediatePropagation();
        }, true);
    }

    /**
     * Регистрирует обработчик ESC. Хэндлер вызывается, только если он на вершине стека.
     * Возвращает функцию-unsubscribe.
     * @param {(e: KeyboardEvent) => void|false} handler - Вернуть `false`, чтобы
     *   пропустить ESC дальше (passthrough, см. шапку класса)
     * @returns {() => void}
     */
    static push(handler) {
        if (!this._initialized) this._init();
        this._stack.push(handler);
        let removed = false;
        return () => {
            if (removed) return;
            removed = true;
            this.remove(handler);
        };
    }

    /**
     * Удаляет хэндлер из стека (если он там есть).
     * @param {(e: KeyboardEvent) => void} handler
     */
    static remove(handler) {
        const idx = this._stack.lastIndexOf(handler);
        if (idx !== -1) this._stack.splice(idx, 1);
    }

    /**
     * Текущий размер стека (для отладки/тестов).
     */
    static size() {
        return this._stack.length;
    }
}

window.EscapeStack = EscapeStack;
