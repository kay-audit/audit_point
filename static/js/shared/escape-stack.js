/**
 * EscapeStack — централизованный стек ESC-обработчиков.
 *
 * Проблема: 20+ компонентов (диалоги, контекстные меню, дропдауны, попапы)
 * вешали `keydown`-listener на ESC независимо. При вложенных оверлеях
 * (диалог → context-menu в нём) ESC закрывал ВСЕ слои сразу либо
 * непредсказуемый из них первым.
 *
 * Решение: один listener на document, LIFO-стек. Событие идёт по слоям сверху
 * вниз; первый слой, забравший ESC себе, останавливает обход и глушит событие
 * через `stopImmediatePropagation`, чтобы старые legacy-handler'ы (если ещё
 * остались) не отрабатывали.
 *
 * Использование:
 *
 *   const unsub = EscapeStack.push(() => { closeMenu(); });
 *   // ... позже:
 *   unsub();  // или EscapeStack.remove(handler)
 *
 * Возвращаемая функция-unsubscribe идемпотентна.
 *
 * Контракт возвращаемого значения:
 *
 *   - `EscapeStack.PASS` — слой отказался от события («ESC сейчас не мой»).
 *     Обход продолжается СЛЕДУЮЩИМ слоем вниз по стеку; если отказались все —
 *     событие уходит в DOM нетронутым, к обычным listener'ам.
 *   - любое другое значение (в т.ч. `undefined` и `false`) и исключение в
 *     хэндлере — «событие съедено»: обход останавливается, событие глушится.
 *
 * Сентинел PASS, а не «голый false»: доминирующий идиом регистрации —
 * `EscapeStack.push(() => this.close())`, и первый же `close()`, вернувший
 * boolean, молча превратил бы слой в пропускающий. Взят `Symbol.for` (реестр
 * по строке), а не `Symbol()`/frozen-объект: EscapeStack дублируется в
 * `window`, и при задвоенном ESM-графе (историческая ловушка проекта —
 * versioned `?v=` в inline-импортах) сравнение по идентичности сломалось бы
 * между копиями модуля; ключ реестра одинаков для всех копий.
 *
 * Отказ нужен слоям, чья принадлежность ESC зависит от состояния: активная
 * зона нарушений забирает ESC только когда каретка НЕ в редактируемом поле,
 * иначе отдаёт его редактору (§5.9). Каскад обязателен — слой зоны встаёт на
 * вершину по одному mouseenter, и без обхода вниз ESC был бы мёртв для панели
 * поиска / корректора / формализатора, пока мышь висит над зоной.
 */
export class EscapeStack {
    /**
     * Сентинел отказа от события (см. контракт в шапке класса).
     * @type {symbol}
     */
    static PASS = Symbol.for('EscapeStack.PASS');

    static _stack = [];
    static _initialized = false;

    static _init() {
        if (this._initialized) return;
        this._initialized = true;
        // capture-фаза — перехватываем до старых legacy-listener'ов в bubbling.
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            // Снимок стека: слой, съедая ESC, обычно снимает себя (close → unsub),
            // и обход по живому массиву сбивал бы индексы. Слои, отказавшиеся от
            // события, стек по контракту не трогают.
            const layers = this._stack.slice();
            for (let i = layers.length - 1; i >= 0; i--) {
                // stopImmediatePropagation — ПОСЛЕ хэндлера, чтобы он успел
                // отказаться от события. Порядок безопасен: остановка, вызванная
                // синхронно внутри listener'а, всё равно блокирует все
                // последующие listener'ы. Исключение = «съедено».
                let passed = false;
                try {
                    passed = layers[i](e) === this.PASS;
                } catch (err) {
                    console.error('[EscapeStack] handler threw:', err);
                }
                if (!passed) {
                    e.stopImmediatePropagation();
                    return;
                }
            }
            // Отказались все слои — событие не глушим: его получат обычные
            // listener'ы (редактор поверхности, текстблок и т.п.).
        }, true);
    }

    /**
     * Регистрирует обработчик ESC. Хэндлеры вызываются сверху вниз, пока
     * очередной не заберёт событие себе. Возвращает функцию-unsubscribe.
     * @param {(e: KeyboardEvent) => void|symbol} handler - Вернуть
     *   `EscapeStack.PASS`, чтобы отказаться от ESC (см. контракт в шапке класса)
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

    /**
     * true, если в стеке есть хоть один слой ESC.
     *
     * Нужен legacy-обработчикам ESC, написанным ДО централизации стека
     * (снятие выделения узла дерева, снятие выделения ячеек таблицы): пока стек
     * непуст, ESC принадлежит его слоям, и до legacy-listener'ов событие
     * доходит только сквозным отказом всех слоёв (PASS). Реагировать на такой
     * ESC нельзя — иначе он незаметно стирает выделение, будучи адресован
     * редактору.
     * @returns {boolean}
     */
    static isActive() {
        return this._stack.length > 0;
    }
}

window.EscapeStack = EscapeStack;
