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
import { EditorRegistry, SURFACE_POLICY } from './editor-registry.js';
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
    _onPaste: null,

    /**
     * Гейт интерактивного capsule-lifecycle: rich-поверхность, чью капсульную
     * логику ведёт ИМЕННО EditorController (флаг capsuleLifecycle в
     * SURFACE_POLICY). Заменяет прежний литерал `kind === 'violationField'` —
     * появление kind='cell' в Фазе 2 включит lifecycle одной строкой политики,
     * без правки контроллера. Гейт по `rich` сохранён (non-rich поле капсул не
     * держит независимо от политики).
     * @param {{kind:string, rich:boolean}} surface
     */
    _usesCapsuleLifecycle(surface) {
        return !!(surface?.rich && SURFACE_POLICY[surface.kind]?.capsuleLifecycle);
    },

    /** @param {{kind:string,element:HTMLElement,commit:()=>void}} surface EditableSurface (editable-surface.js) */
    mount(surface) {
        if (this._surface === surface) return; // уже активна — не перевешивать
        if (this._surface) this.unmount(); // одна активная поверхность за раз
        this._surface = surface;
        EditorRegistry.setActive(surface);
        textBlockManager.attachToolbarTo(surface); // тулбар с политикой по surface.kind
        this._onInput = () => {
            if (this._usesCapsuleLifecycle(surface)) {
                // V26: capsule-поверхность (поле нарушения) коммитит ввод в модель
                // ЕДИНЫМ debounce-стоком handleEditorInput → finalizeEdit →
                // active.commit() (мост персистентности). Отдельный write-through
                // убран: он коммитил сразу на каждый ввод, а debounce-мост — ещё
                // раз через 500мс, из-за чего на паузу набора правка коммитилась
                // ДВАЖДЫ. Свежесть модели на случай сохранения ВНУТРИ окна дебаунса
                // держит EditorRegistry.flushActive в persistence-воронке
                // (StorageManager._flushPendingEdits, V20). Здесь же — debounce-
                // самолечение живого DOM (normalizeMarkers пере-расставляет
                // caret-guard'ы у новых границ строк, БАГ-1).
                textBlockManager.handleEditorInput(surface.element, null);
            } else {
                // Не-capsule поверхность: debounce-стока нет — держим write-through
                // (element → модель на каждый ввод).
                surface.commit();
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

        // Task 1.3.4-B2: интерактивный capsule-lifecycle — по политике поверхности
        // (SURFACE_POLICY.capsuleLifecycle, см. _usesCapsuleLifecycle). Сейчас true
        // только у поля нарушения; текстблоки сюда не заходят (свой
        // handleEditorFocus-путь, EditorController.mount на них не зовётся), а
        // будущий kind='cell' включится одной строкой политики. attachToolbarTo
        // выше уже вызвал setActiveEditor(surface.element), поэтому
        // attachLinkFootnoteHandlers() (сигнатура без аргумента — берёт
        // this.activeEditor) навешивает обработчики на ПРАВИЛЬНЫЙ элемент.
        if (this._usesCapsuleLifecycle(surface)) {
            textBlockManager.installCapsuleObserver(surface.element); // heal-observer (prevent-then-heal)
            this._onBeforeInput = (e) => textBlockManager.handleEditorBeforeInput(e, surface.element, null);
            this._onKeydown = (e) => textBlockManager.handleEditorKeydown(e, surface.element);
            this._onCopy = (e) => textBlockManager.handleEditorCopy(e, surface.element, false);
            // CORE-4: cut без обработчика сериализует буфер ДО beforeinput нативно —
            // guard'ы (U+FEFF) утекали бы в клипборд. isCut=true — тот же метод, что
            // и copy, плюс удаление выделения нативной командой (см. handleEditorCopy).
            this._onCut = (e) => textBlockManager.handleEditorCopy(e, surface.element, true);
            // Паритет вставки (I-1): свой путь реконструкции капсул + гейт сносок по
            // SURFACE_POLICY (handleEditorPaste → _reconstructPastedCapsules) — без
            // этого в поле льётся сырой browser-HTML, а сноски вставлялись бы в обход
            // запрета политики.
            this._onPaste = (e) => textBlockManager.handleEditorPaste(e, surface.element, null);
            surface.element.addEventListener('beforeinput', this._onBeforeInput);
            surface.element.addEventListener('keydown', this._onKeydown);
            surface.element.addEventListener('copy', this._onCopy);
            surface.element.addEventListener('cut', this._onCut);
            surface.element.addEventListener('paste', this._onPaste);
            textBlockManager.attachLinkFootnoteHandlers(); // tooltip/dblclick-правка/ПКМ-меню/клик-каретка
        }
    },

    unmount() {
        const surface = this._surface;
        if (!surface) return;
        if (this._usesCapsuleLifecycle(surface)) {
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
        if (this._usesCapsuleLifecycle(surface)) {
            surface.element.removeEventListener('paste', this._onPaste);
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
        this._onPaste = null;
    },

    /**
     * T7 (#6/#14b): drop в rich-поле нарушения. Слушатель навешивается при
     * СОЗДАНИИ поля (_createRichFieldEditor), НЕ на mount — потому что `focus`
     * диспатчится как часть default-action события `drop` (ПОСЛЕ drop-обработчиков),
     * и mount-time слушатель опоздал бы на drop в НЕсфокусированное поле. А это и
     * есть основной сценарий #6: сноска создаётся только в текстблоке → выделение
     * в текстблоке → поле нарушения расфокусировано/не смонтировано → нативный
     * drop капсулы сноски мимо гейта.
     *
     * Не зависит от фокуса/реестра:
     *  - гейт сносок читается из ЗАХВАЧЕННОЙ поверхности (surface.kind), НЕ из
     *    EditorRegistry.getActive() (активна может быть другая поверхность/никакая);
     *  - модель обновляется явным surface.commit(), если поверхность НЕ
     *    смонтирована (иначе санитизированная DOM-вставка жила бы без модели до
     *    случайного blur). Смонтированную коммитит её input-хендлер на insertHTML —
     *    гейт `this._surface !== surface` не даёт двойного коммита.
     * Поле фокусируется (mount отрабатывает штатно): execCommand('insertHTML')
     * работает только в сфокусированном editable + паритет с нативным UX.
     *
     * Файлы (картинка из проводника) → preventDefault + выход: сырой <img> не в
     * модель, событие всплывает к контейнеру доп-контента (violation-file-upload.js
     * читает dataTransfer.files). Drop без HTML (внутренний reorder/дерево, внешний
     * plain) не перехватываем — нативная вставка plain безопасна.
     * @param {DragEvent} e
     * @param {{kind:string, element:HTMLElement, commit:()=>void}} surface Захваченная при создании поверхность
     */
    handleSurfaceDrop(e, surface) {
        const dt = e.dataTransfer;
        if (!dt) return;

        // Файлы — гасим сырой <img>, событие всплывает к контейнеру доп-контента.
        if (dt.files && dt.files.length > 0) {
            e.preventDefault();
            return;
        }

        const html = dt.getData('text/html');
        // Без HTML — нативная вставка plain безопасна, не вмешиваемся.
        if (!html || !html.trim()) return;

        e.preventDefault();
        const plain = dt.getData('text/plain');
        const el = surface.element;
        if (!el) return;

        // Фокус → mount отрабатывает штатно; execCommand работает в сфокусированном
        // editable. В node-стабе focus отсутствует/no-op — mount не срабатывает,
        // модель коммитим явно ниже.
        if (typeof el.focus === 'function') el.focus();

        // CARET-1 (зеркало paste): drop во время inline-правки капсулы → плейн в тело.
        if (el.querySelector && el.querySelector('.editing-mode')) {
            if (plain) document.execCommand('insertText', false, plain);
            if (this._surface !== surface) surface.commit();
            return;
        }

        // Каретка → точка сброса; без неё insertHTML ушёл бы в старое выделение.
        const dropRange = textBlockManager._dropCaretRange(e, el);
        if (dropRange) {
            const sel = window.getSelection();
            if (sel) {
                sel.removeAllRanges();
                sel.addRange(dropRange);
            }
        }

        // Гейт сносок — по политике ЗАХВАЧЕННОЙ поверхности (не из реестра).
        const footnotesBlocked = SURFACE_POLICY[surface.kind]?.footnotes === false;
        textBlockManager._insertSanitizedHtml(el, html, plain, footnotesBlocked);

        // Смонтированная поверхность коммитит через input-хендлер (insertHTML →
        // input → _onInput → commit). НЕ смонтированная (focus не смонтировал) —
        // коммитим явно, иначе DOM-вставка не дойдёт до модели.
        if (this._surface !== surface) surface.commit();
    },
};

window.EditorController = EditorController;
