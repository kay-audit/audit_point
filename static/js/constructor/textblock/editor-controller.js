/**
 * Перемонтируемый контроллер активной поверхности редактирования (Task 1.3.1).
 * То, что Фаза 0 сознательно отложила из mount/unmount (D4, editor-registry.js):
 * полноценный lifecycle поверх EditorRegistry + editor-agnostic тулбара.
 * Одна активная поверхность за раз; между сессиями редактирования контроллер
 * НЕ держит ссылок на DOM — mount навешивает слушатели и тулбар, unmount
 * коммитит модель И снимает их.
 *
 * Поле нарушения (Task 1.3.3) — always-live contenteditable, вызывает
 * mount(surface) на фокусе; contenteditable — свойство самого поля, контроллер
 * его не выставляет и не снимает.
 */
import { EditorRegistry } from './editor-registry.js';
import { textBlockManager } from './textblock-core.js';

export const EditorController = {
    _surface: null,
    _onInput: null,
    _onBlur: null,

    /** @param {{kind:string,element:HTMLElement,commit:()=>void}} surface EditableSurface (editable-surface.js) */
    mount(surface) {
        if (this._surface === surface) return; // уже активна — не перевешивать
        if (this._surface) this.unmount(); // одна активная поверхность за раз
        this._surface = surface;
        EditorRegistry.setActive(surface);
        textBlockManager.attachToolbarTo(surface); // тулбар с политикой по surface.kind
        this._onInput = () => surface.commit(); // write-through: element → модель на каждый ввод
        this._onBlur = () => this.unmount();
        surface.element.addEventListener('input', this._onInput);
        surface.element.addEventListener('blur', this._onBlur);
    },

    unmount() {
        const surface = this._surface;
        if (!surface) return;
        surface.commit(); // ДО снятия слушателей — иначе висящий ввод теряется
        surface.element.removeEventListener('input', this._onInput);
        surface.element.removeEventListener('blur', this._onBlur);
        textBlockManager.detachToolbar();
        if (EditorRegistry.getActive() === surface) EditorRegistry.clear(); // ownership-guard
        this._surface = null;
        this._onInput = null;
        this._onBlur = null;
    },
};

window.EditorController = EditorController;
