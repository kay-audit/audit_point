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
    _onSelectionPing: null,
    _onBeforeInput: null,
    _onKeydown: null,
    _onCopy: null,
    _onCut: null,

    /** @param {{kind:string,element:HTMLElement,commit:()=>void}} surface EditableSurface (editable-surface.js) */
    mount(surface) {
        if (this._surface === surface) return; // уже активна — не перевешивать
        if (this._surface) this.unmount(); // одна активная поверхность за раз
        this._surface = surface;
        EditorRegistry.setActive(surface);
        textBlockManager.attachToolbarTo(surface); // тулбар с политикой по surface.kind
        this._onInput = () => {
            surface.commit(); // write-through: element → модель на каждый ввод
            // Паритет textblock-пути (БАГ-1): debounce-самолечение живого DOM —
            // normalizeMarkers пере-расставляет caret-guard'ы у новых границ строк;
            // без него guard'ы разъезжаются со структурой и навигация у капсул ломается.
            if (surface.rich && surface.kind === 'violationField') {
                textBlockManager.handleEditorInput(surface.element, null);
            }
        };
        this._onBlur = () => this.unmount();
        surface.element.addEventListener('input', this._onInput);
        surface.element.addEventListener('blur', this._onBlur);

        // БАГ-2: тулбар textblock обновляется по mouseup/keyup → handleSelectionChange —
        // для ЛЮБОЙ смонтированной поверхности (вне гейта rich+violationField ниже).
        this._onSelectionPing = () => textBlockManager.handleSelectionChange();
        surface.element.addEventListener('mouseup', this._onSelectionPing);
        surface.element.addEventListener('keyup', this._onSelectionPing);

        // Task 1.3.4-B2: интерактивный capsule-lifecycle — ТОЛЬКО для полей
        // нарушения (rich + kind='violationField'). Текстблоки сюда не заходят
        // (свой handleEditorFocus-путь, EditorController.mount на них не зовётся),
        // будущий kind='cell' — тоже нет, пока для него не заведена своя политика.
        // attachToolbarTo выше уже вызвал setActiveEditor(surface.element), поэтому
        // attachLinkFootnoteHandlers() (сигнатура без аргумента — берёт
        // this.activeEditor) навешивает обработчики на ПРАВИЛЬНЫЙ элемент.
        if (surface.rich && surface.kind === 'violationField') {
            textBlockManager.installCapsuleObserver(surface.element); // heal-observer (prevent-then-heal)
            this._onBeforeInput = (e) => textBlockManager.handleEditorBeforeInput(e, surface.element, null);
            this._onKeydown = (e) => textBlockManager.handleEditorKeydown(e, surface.element);
            this._onCopy = (e) => textBlockManager.handleEditorCopy(e, surface.element, false);
            // CORE-4: cut без обработчика сериализует буфер ДО beforeinput нативно —
            // guard'ы (U+FEFF) утекали бы в клипборд. isCut=true — тот же метод, что
            // и copy, плюс удаление выделения нативной командой (см. handleEditorCopy).
            this._onCut = (e) => textBlockManager.handleEditorCopy(e, surface.element, true);
            surface.element.addEventListener('beforeinput', this._onBeforeInput);
            surface.element.addEventListener('keydown', this._onKeydown);
            surface.element.addEventListener('copy', this._onCopy);
            surface.element.addEventListener('cut', this._onCut);
            textBlockManager.attachLinkFootnoteHandlers(); // tooltip/dblclick-правка/ПКМ-меню/клик-каретка
        }
    },

    unmount() {
        const surface = this._surface;
        if (!surface) return;
        if (surface.rich && surface.kind === 'violationField') {
            // Гигиена ДО commit — зеркало handleEditorBlur (textblock-editor.js:479-537):
            // висящий save-таймер повторил бы работу после отрыва, «вся капсула как
            // юнит» должна снять визуальную отметку (её уже не почистит
            // handleSelectionChange — фокус ушёл), незавершённая IME-композиция должна
            // слиться, осиротевший якорь размера — не утечь в модель через commit ниже.
            if (surface.element.saveTimeout) {
                clearTimeout(surface.element.saveTimeout);
                surface.element.saveTimeout = null;
            }
            textBlockManager._clearNodeSelected(surface.element);
            if (typeof textBlockManager._flushComposition === 'function') {
                textBlockManager._flushComposition(surface.element);
            }
            if (typeof textBlockManager._cleanOrphanSizeAnchors === 'function') {
                textBlockManager._cleanOrphanSizeAnchors(surface.element, { ignoreCaret: true });
            }
        }
        surface.commit(); // ДО снятия слушателей — иначе висящий ввод теряется
        surface.element.removeEventListener('input', this._onInput);
        surface.element.removeEventListener('blur', this._onBlur);
        surface.element.removeEventListener('mouseup', this._onSelectionPing);
        surface.element.removeEventListener('keyup', this._onSelectionPing);
        if (surface.rich && surface.kind === 'violationField') {
            surface.element.__capsuleObserver?.disconnect();
            surface.element.removeEventListener('beforeinput', this._onBeforeInput);
            surface.element.removeEventListener('keydown', this._onKeydown);
            surface.element.removeEventListener('copy', this._onCopy);
            surface.element.removeEventListener('cut', this._onCut);
        }
        textBlockManager.detachToolbar();
        if (EditorRegistry.getActive() === surface) EditorRegistry.clear(); // ownership-guard
        this._surface = null;
        this._onInput = null;
        this._onBlur = null;
        this._onSelectionPing = null;
        this._onBeforeInput = null;
        this._onKeydown = null;
        this._onCopy = null;
        this._onCut = null;
    },
};

window.EditorController = EditorController;
