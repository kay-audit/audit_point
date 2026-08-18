/**
 * Менеджер для управления текстовыми блоками
 * Современный подход с поддержкой расширенного форматирования как в Word
 */
import { PreviewManager } from '../preview/preview.js';
import { AppState } from '../state/state-core.js';
import { ChangelogTracker } from '../changelog-tracker.js';
import { EditorRegistry } from './editor-registry.js';
import { getStructureLimits } from '../violation/violation-image-validator.js';

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

/**
 * Команды УРОВНЯ пункта списка: осмысленны только внутри <li> и потому
 * гейтятся по каретке (см. execCommand). Создание списка (insert*List) сюда не
 * входит — оно стартует как раз вне списка.
 */
const LIST_LEVEL_CMDS = ['indent', 'outdent'];

/**
 * ЖЁСТКИЙ предел глубины списка (0-based): уровень 8 — девятый и последний,
 * который умеет описать w:abstractNum в OOXML (9 уровней); глубже DOCX-сборщик
 * (inline.py) молча клампит на ilvl 8. Это НЕ настройка, а физическая граница
 * формата — UI-потолок задаёт конфигурация (ACTS__TEXTBLOCKS__MAX_LIST_LEVEL,
 * см. _listLevelCeiling), и она этим пределом прижимается.
 */
const HARD_MAX_LIST_LEVEL = 8;

/**
 * Команды, меняющие СТРУКТУРУ списка: после них разметка проходит нормализацию
 * вложенности (_normalizeListNesting, textblock-editor.js).
 */
const LIST_STRUCTURE_CMDS = [...LIST_LEVEL_CMDS, 'insertUnorderedList', 'insertOrderedList'];

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
        // Открытое меню класс hidden на тулбаре НЕ закрывает: дропдаун держит
        // своё состояние сам. Без явного закрытия меню переживает смену
        // поверхности (detachToolbar → hideToolbar) и всплывает при re-attach
        // уже над ДРУГОЙ поверхностью. Метод миксина тулбара — зовём защитно
        // (hideToolbar есть у всех поверхностей и вызывается рано).
        if (typeof this._closeToolbarDropdowns === 'function') {
            this._closeToolbarDropdowns();
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
            // Вложенность списков приводим к валидной и здесь, а не только на
            // пути indent/outdent: правка могла прийти мимо execCommand (paste,
            // undo, внешний источник), а невалидную разметку не понимают ни
            // DOCX-сегментатор, ни MD/TXT, ни CSS превью.
            const normalized = this._normalizeListNestingHtml
                ? this._normalizeListNestingHtml(stripped) : stripped;
            textBlock.content = this.validateAndRepairCapsules
                ? this.validateAndRepairCapsules(normalized) : normalized;
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
     * Потолок глубины списка (0-based) НА МОМЕНТ ПРОВЕРКИ: UI-настройка
     * ACTS__TEXTBLOCKS__MAX_LIST_LEVEL (GET /acts/limits → getStructureLimits),
     * прижатая жёстким пределом формата HARD_MAX_LIST_LEVEL.
     *
     * Значение читаем вызовом каждый раз, а не константой на импорте: ответ
     * /acts/limits приходит асинхронно (до него действует фолбэк AppConfig), да
     * и зафиксированное на module-level значение в графе с циклом импортов дало
     * бы undefined. Единственное место сравнения глубины — гейт execCommand
     * ниже; тулбар зовёт этот же метод, чтобы гасить пункт «Уровень глубже».
     * @returns {number}
     */
    _listLevelCeiling() {
        const configured = getStructureLimits()?.maxListLevel;
        return (typeof configured === 'number' && configured > 0)
            ? Math.min(configured, HARD_MAX_LIST_LEVEL)
            : HARD_MAX_LIST_LEVEL;
    }

    /**
     * Общий сток команд уровня списка (indent/outdent исполняются своим кодом):
     * нормализация — страховка на чужую разметку, уже лежащую в блоке (paste,
     * undo, старый контент), затем запись в модель. Возвращает true как
     * результат самой команды.
     * @returns {boolean}
     */
    _commitListLevelChange() {
        if (typeof this._normalizeListNesting === 'function') {
            this._normalizeListNesting(this.activeEditor);
        }
        this.saveContent(this.activeEditor.dataset.textBlockId, this.activeEditor.innerHTML);
        return true;
    }

    /**
     * Выполняет команду форматирования
     */
    execCommand(command, value = null) {
        if (!this.activeEditor) return false;

        this.activeEditor.focus();

        // Гейт уровня списка: indent/outdent осмысленны только внутри <li>.
        // Вне списка Chromium заворачивает абзац в <blockquote>, которого нет в
        // allowlist санитайзера 'acts' — отступ выглядел бы применённым, а на
        // перезагрузке молча исчезал. Тихий no-op, нативная команда не идёт.
        // Гейт стоит ЗДЕСЬ, а не в тулбаре: через execCommand проходят все пути
        // (меню, Tab/Shift+Tab, программный вызов), дизейбл кнопки покрыл бы
        // только один. Здесь же — потолок глубины (_listLevelCeiling): раньше
        // его знала ТОЛЬКО Tab-ветка (_handleListTab), и пункт меню «уровень
        // глубже» углублял мимо него.
        if (LIST_LEVEL_CMDS.includes(command) && typeof this._caretListItem === 'function') {
            const sel = (typeof window.getSelection === 'function') ? window.getSelection() : null;
            const range = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0) : null;
            const li = range ? this._caretListItem(range, this.activeEditor) : null;
            if (!li) return false;
            // Двигаем ВСЕ пункты выделения, а не только тот, где начало
            // диапазона: нативные команды двигали выделение целиком, и Tab/
            // Shift+Tab по нескольким строкам списка обязаны работать так же.
            const items = (typeof this._selectedListItems === 'function')
                ? this._selectedListItems(range, this.activeEditor) : [li];

            // Обе команды уровня исполняем САМИ (_indentListItem/
            // _outdentListItem, textblock-editor.js): нативный indent порождает
            // список-сироту, из которого валидную форму без пустого <li>-хоста
            // не собрать (маркеры хостов выстраивались в строку), а нативный
            // outdent роняет пункт рядом с подсписком или прямо внутрь чужого
            // <li>. Сток общий, см. _commitListLevelChange.
            if (command === 'indent') {
                const movable = items.filter(item => typeof this._listLevel !== 'function'
                    || this._listLevel(item, this.activeEditor) < this._listLevelCeiling());
                if (!movable.length) return false;
                if (typeof this._indentListItem === 'function') {
                    let changed = false;
                    for (const item of movable) {
                        if (this._indentListItem(item)) changed = true;
                    }
                    return changed ? this._commitListLevelChange() : false;
                }
            } else if (typeof this._outdentListItem === 'function') {
                let changed = false;
                for (const item of items) {
                    if (this._outdentListItem(item)) changed = true;
                }
                return changed ? this._commitListLevelChange() : false;
            }
        }

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
            // Структурные команды списка: Chromium после indent/outdent кладёт
            // вложенный <ul>/<ol> прямо внутрь списка, минуя <li>. Чиним ДО
            // записи в модель — и живой DOM (каретка переезжает с поддеревом),
            // и то, что уйдёт в saveContent.
            if (LIST_STRUCTURE_CMDS.includes(command)
                    && typeof this._normalizeListNesting === 'function') {
                this._normalizeListNesting(this.activeEditor);
            }
            // D2: нативный removeFormat снимает только inline-формат — блочный
            // (список, выравнивание, отступы) добираем своим проходом.
            if (command === 'removeFormat' && typeof this._removeBlockFormat === 'function') {
                this._removeBlockFormat(this.activeEditor);
            }
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
