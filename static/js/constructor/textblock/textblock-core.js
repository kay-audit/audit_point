/**
 * Менеджер для управления текстовыми блоками
 * Современный подход с поддержкой расширенного форматирования как в Word
 */
import { PreviewManager } from '../preview/preview.js';
import { AppState } from '../state/state-core.js';
import { ChangelogTracker } from '../changelog-tracker.js';
import { EditorRegistry } from './editor-registry.js';

/**
 * Узел — inline-капсула (ссылка/сноска, contenteditable=false-атом)?
 * Самостоятельный предикат (единый источник истины): прототипный `_isCapsule`
 * делегирует сюда, а движок поиска (act-search-engine.js) импортирует напрямую —
 * не завися от порядка загрузки/навешивания миксина textblock-editor.js. Литералы
 * 1/3 вместо Node.* — без зависимости от глобала Node (как в _capsuleAncestor).
 * @param {Node} node
 * @returns {boolean}
 */
export function isCapsuleNode(node) {
    return !!(node && node.nodeType === 1 && node.classList &&
        (node.classList.contains('text-link') || node.classList.contains('text-footnote')));
}

/**
 * Узел НЕ даёт каретке видимой опоры рядом с капсулой: пустой/zero-width текст
 * (включая U+FEFF-guard и U+200B-якорь размера) ЛИБО инлайн-элемент ТОЛЬКО из
 * zero-width-символов. Капсулы, <br>, <img> и пустые элементы — значимы.
 * Самостоятельный предикат (см. isCapsuleNode): прототипный `_isZeroWidthNode`
 * делегирует сюда, движок поиска импортирует напрямую.
 * @param {Node} n
 * @returns {boolean}
 */
export function isZeroWidthNode(n) {
    if (!n) return false;
    if (n.nodeType === 3) {
        return /^[\uFEFF\u200B]*$/.test(n.data);            // '' или только FEFF/ZWSP
    }
    if (n.nodeType === 1 && !isCapsuleNode(n) && n.tagName !== 'BR') {
        const t = n.textContent || '';
        return t.length > 0 && /^[\uFEFF\u200B]+$/.test(t); // span ТОЛЬКО из zero-width (не <img>/пустой)
    }
    return false;
}

export class TextBlockManager {
    constructor() {
        this.selectedTextBlock = null;
        this.globalToolbar = null;
        this.activeEditor = null;

        // Конфигурация доступных размеров шрифта
        this.fontSizes = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];
    }

    /**
     * Показывает панель инструментов
     */
    showToolbar() {
        if (this.globalToolbar) {
            this.globalToolbar.classList.remove('hidden');
        }
    }

    /**
     * Скрывает панель инструментов
     */
    hideToolbar() {
        if (this.globalToolbar) {
            this.globalToolbar.classList.add('hidden');
        }
    }

    /**
     * Устанавливает активный редактор
     */
    setActiveEditor(editor) {
        this.activeEditor = editor;
    }

    /**
     * Очищает активный редактор
     */
    clearActiveEditor() {
        this.activeEditor = null;
    }

    /**
     * Получает текстовый блок по ID
     */
    getTextBlock(textBlockId) {
        return AppState.textBlocks[textBlockId] || null;
    }

    /**
     * Принудительно коммитит pending-правку активного текстблок-редактора.
     *
     * Ввод в редактор сохраняется в state через debounce 500мс
     * (textblock-editor.js::handleEditorInput), поэтому таймерный автосейв /
     * экспорт / переключение акта могут прочитать exportData() без последних
     * символов, ещё висящих в debounce. Метод вызывается из persistence-воронок
     * (StorageManager._flushPendingEdits) ДО exportData(): если в фокусе
     * textblock-редактор с непогашенным saveTimeout — переносим его innerHTML
     * в state и снимаем таймер (он бы повторил ту же работу).
     *
     * @returns {boolean} true если был закоммичен pending-редактор
     */
    flushActiveEditor() {
        const editor = document.activeElement;
        if (!editor || !editor.classList || !editor.classList.contains('textblock-editor')) {
            return false;
        }
        if (!editor.saveTimeout) {
            return false;
        }
        clearTimeout(editor.saveTimeout);
        editor.saveTimeout = null;
        const textBlockId = editor.dataset.textBlockId;
        this.saveContent(textBlockId, editor.innerHTML);
        return true;
    }

    /**
     * Сохраняет контент текстового блока
     */
    saveContent(textBlockId, content) {
        const textBlock = this.getTextBlock(textBlockId);
        if (textBlock) {
            // Снимаем caret-guard'ы + чиним инварианты капсул (дубль-id,
            // расщеплённый клон, пустой data-*) ПЕРЕД записью в БД.
            const stripped = this._stripGuards ? this._stripGuards(content) : content;
            textBlock.content = this.validateAndRepairCapsules
                ? this.validateAndRepairCapsules(stripped) : stripped;
            // TB-5: changelog пишем в общем стоке saveContent, чтобы правки МИМО
            // input-события (смена размера, Enter-ветки, HTML-paste, нативное
            // удаление) тоже попадали в аудит-историю. _recordDebounced
            // коалесцирует серию правок одного блока в одну запись (ключ
            // modify_textblock_<id>).
            if (typeof ChangelogTracker !== 'undefined') {
                ChangelogTracker._recordDebounced(
                    'modify_textblock', textBlockId, '', { field: 'content' }, 5000);
            }
            // Контентная правка одного блока → точечный патч превью.
            PreviewManager.updateBlock('textblock', textBlockId);
        }
    }

    /**
     * Единый сток завершения правки текстблока: пересчитывает производные
     * состояния в фиксированном порядке, чтобы ни один путь правки (Enter у
     * капсулы, paste, нативное удаление, смена размера, observer-heal) не забывал
     * часть шагов (класс багов «забытый вызов»). Порядок важен: нормализация
     * двигает caret-guard'ы, поэтому вызывающие, которые сами ставят каретку,
     * обязаны звать finalizeEdit ДО установки каретки.
     * @param {HTMLElement} editor Редактор блока (обычно this.activeEditor).
     * @param {{renumber?: boolean}} [opts]
     *   renumber=true — принудительная перенумерация сносок (потоки создания/
     *   правки/удаления маркера, где номер может измениться без изменения числа
     *   .text-footnote).
     */
    finalizeEdit(editor, opts = {}) {
        if (!editor || !editor.dataset) return;

        // (а) Guard'ы капсул — если в блоке ЕСТЬ капсулы (обычная правка) ЛИБО в
        // живом DOM остались guard-символы U+FEFF. Второе условие даёт самоочистку
        // после удаления ПОСЛЕДНЕЙ капсулы из ЛЮБОГО пути (removeLinkOrFootnote,
        // beforeinput): normalizeMarkers на редакторе без капсул только вычищает
        // guard'ы (_cleanCapGuards), новых не ставит. Иначе пропуск (перф: обычный
        // ввод в plain-текст без невидимок). U+200B-якорь размера намеренно НЕ
        // триггерит — normalizeMarkers его и не трогает.
        const hasCapsules = !!editor.querySelector('[data-link-url],[data-footnote-text]');
        const hasGuardChars = (editor.textContent || '').includes('\uFEFF');
        if ((hasCapsules || hasGuardChars) && typeof this.normalizeMarkers === 'function') {
            this.normalizeMarkers(editor);
        }

        // (б) Перенумерация сносок — по изменению их числа с прошлого стока (кэш
        // editor.__lastFootnoteCount ловит нативное удаление/paste поверх сноски,
        // где create/remove-потоки не срабатывают — CARET-7) ЛИБО по явному
        // запросу opts.renumber. Перенумеровываем ГЛОБАЛЬНО (весь лист, TREE-1):
        // смена числа сносок в ЭТОМ блоке сдвигает сквозные номера в ПОСЛЕДУЮЩИХ
        // блоках. Гейт по счётчику держит это дёшево — обычный ввод без правки
        // сносок сюда не заходит. Счётчик считаем на ПЕРЕДАННОМ editor; глобальный
        // проход примирит __lastFootnoteCount всех редакторов, а строка ниже
        // фиксирует его и для этого (единственный путь, когда проход не звался).
        const footnoteCount = editor.querySelectorAll('.text-footnote').length;
        if ((opts.renumber === true || footnoteCount !== editor.__lastFootnoteCount) &&
                typeof this.renumberAllFootnotes === 'function') {
            this.renumberAllFootnotes();
        }
        editor.__lastFootnoteCount = footnoteCount;

        // (в) Класс пустоты (placeholder).
        this._toggleEmptyClass(editor);

        // (в.1) TB-4: снять осиротевшие якоря размера (пустой span из одного
        // U+200B без каретки внутри) ДО сериализации — иначе копятся в content.
        // Якорь ПОД КАРЕТКОЙ переживает save (B-2). Метод — в textblock-editor.js.
        if (typeof this._cleanOrphanSizeAnchors === 'function') {
            this._cleanOrphanSizeAnchors(editor);
        }

        // (г) Запись в state.content + точечный патч превью (changelog — внутри
        // saveContent, общий для всех путей правки).
        this.saveContent(editor.dataset.textBlockId, editor.innerHTML);

        // (д) Мост персистентности (Task 1.3.4-A): finalizeEdit — сток не только
        // для текстблоков. Если editor НЕ текстблок (нет привязанного
        // textBlockId либо блок не найден в state) и именно он сейчас
        // смонтирован как активная поверхность (EditorRegistry) — коммитим её.
        // Аддитивно: у текстблока dataset.textBlockId валиден → сюда не заходит
        // (шаг (г) выше уже сделал saveContent).
        if (!this.getTextBlock(editor.dataset.textBlockId)) {
            const active = EditorRegistry.getActive();
            if (active && active.element === editor) {
                active.commit();
            }
        }
    }

    /**
     * @private DRY: ближайший предок-капсула (ссылка/сноска, contenteditable=false-
     * атом) узла в пределах редактора, ИЛИ null. Капсулу в inline-правке
     * (editing-mode) трактуем как обычный текст → null (её границы не атомарны,
     * CARET-1). Единый обход границ для обоих expand-хелперов —
     * _expandRangeOutOfMarkers (живой Range, textblock-toolbar.js) и
     * _expandStaticRangeOutOfMarkers (StaticRange, textblock-capsule-integrity.js)
     * — и для _rangeIsWholeCapsule; раньше дублировался. Живёт в core (базовый
     * класс), т.к. используется из обоих миксинов. Литерал 3 (а не Node.TEXT_NODE)
     * — без зависимости от глобала Node (как в исходных копиях).
     * @param {Node} node
     * @param {HTMLElement} editor
     * @returns {Element|null}
     */
    _capsuleAncestor(node, editor) {
        let el = node && node.nodeType === 3 ? node.parentElement : node;
        while (el && el !== editor && editor && editor.contains(el)) {
            if (this._isCapsule(el)) return this._isEditingCapsule(el) ? null : el;
            el = el.parentElement;
        }
        return null;
    }

    /**
     * Выполняет команду форматирования
     */
    execCommand(command, value = null) {
        if (!this.activeEditor) return false;

        this.activeEditor.focus();

        // Атомарность капсулы: inline-форматные команды по выделению, заходящему
        // ВНУТРЬ тела маркера, иначе клонируют его (дубль ссылки). Расширяем
        // выделение за целые капсулы (как уже делает applyFontSize). Блочные
        // (justify*) и insert* не трогаем.
        const FORMAT_CMDS = ['bold', 'italic', 'underline', 'strikeThrough'];
        if (FORMAT_CMDS.includes(command) && typeof this._expandRangeOutOfMarkers === 'function') {
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
                const r = sel.getRangeAt(0);
                this._expandRangeOutOfMarkers(r);
                sel.removeAllRanges();
                sel.addRange(r);
            }
        }

        const result = document.execCommand(command, false, value);

        if (result) {
            const textBlockId = this.activeEditor.dataset.textBlockId;
            this.saveContent(textBlockId, this.activeEditor.innerHTML);
        }

        return result;
    }

    /**
     * Проверяет состояние команды форматирования
     */
    queryCommandState(command) {
        try {
            return document.queryCommandState(command);
        } catch (e) {
            return false;
        }
    }

    /**
     * Получает значение команды
     */
    queryCommandValue(command) {
        try {
            return document.queryCommandValue(command);
        } catch (e) {
            return '';
        }
    }
}

export const textBlockManager = new TextBlockManager();

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.TextBlockManager = TextBlockManager;
window.textBlockManager = textBlockManager;
