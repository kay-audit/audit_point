/**
 * Поверхность и хост rich-текста блоков нарушения — блочная модель.
 *
 * Единственная поверхность ViolationBlockSurface покрывает оба rich-носителя
 * блока: content текст-блока и caption блока-картинки. Адресация — по
 * СТАБИЛЬНОМУ id блока (не индексу): id поверхности
 * `viol:<vid>:<fieldKey>:block:<blockId>` (content) либо `...:caption`.
 * Прежние поверхности старой модели (ViolationFieldSurface с путями,
 * ViolationContentItemSurface, индексная ViolationListItemSurface) удалены
 * вместе с моделью.
 *
 * Два режима записи в модель (см. EditorController, editor-controller.js):
 *  - commit()     — element → модель, БЕЗ ре-рендера (обычный ввод, каретка жива);
 *  - setContent() — модель → element, С ре-рендером (внешняя запись: формализатор,
 *    корректор, improve-text, undo «Заменить всё»).
 * Обе операции идут ТОЛЬКО через мутатор setBlockField (requireWrite-guard +
 * превью, violation-mutations.js). Прямая запись в модель здесь запрещена.
 *
 * Здесь же — хост поля (_createRichFieldEditor) и снятие контроллера при
 * пересоздании DOM (_teardownActiveRichField): живой contenteditable,
 * монтирующий EditorController на фокусе. Связанность с EditorController/
 * EditorRegistry локализована в этом модуле.
 */
import { renderActContent } from '../../shared/sanitize.js';
import { RENDER_CLASSES } from '../render-classes.js';
import { ViolationManager } from './violation-core.js';
import { EditorController } from '../textblock/editor-controller.js';
import { EditorRegistry } from '../textblock/editor-registry.js';
import { textBlockManager } from '../textblock/textblock-core.js';
import { isFieldEmpty } from './violation-field-empty.js';

/**
 * Guard-strip (U+FEFF) + validateAndRepairCapsules-репорт — зеркало пред-записи
 * в saveContent/handleEditorBlur (textblock-core.js:127-131,
 * textblock-editor.js:501-508): капсулы поля нарушения несут те же
 * caret-guard'ы и подвержены тем же инвариантам (дубль-id, расщеплённый клон,
 * пустой data-*), которые НЕЛЬЗЯ пускать в модель→превью→DOCX.
 *
 * Возвращает {html, changed}: html — ВСЕГДА чистый (guard'ы вычищены и
 * _repairCapsulesInRoot прогнан), безопасен для записи в модель БЕЗ условий.
 * changed — признак РЕАЛЬНОЙ структурной починки, а НЕ косметики (см.
 * textblock-capsule-integrity.js:78-89) — нужен ТОЛЬКО для решения о ДОРОГОМ
 * ре-рендере DOM. До домешивания капсульного миксина в граф импортов —
 * identity, changed=false.
 * @param {string} html
 * @returns {{html: string, changed: boolean}}
 */
function _repairCapsuleHtml(html) {
    const stripped = textBlockManager._stripGuards ? textBlockManager._stripGuards(html) : html;
    return typeof textBlockManager._repairCapsulesReport === 'function'
        ? textBlockManager._repairCapsulesReport(stripped)
        : { html: stripped, changed: false };
}

/**
 * #12 (основа) + V24: очищенное contenteditable-поле оставляет в DOM
 * `<br>`/`<div><br></div>` — без нормализации write-path коммитил бы этот
 * мусор в модель как есть. Визуально пустое поле (isFieldEmpty —
 * violation-field-empty.js, тот же предикат, что у подсветки `--empty`)
 * коммитится как `''` — рендер-проверка пустоты по модели совпадает с DOM.
 * @param {string} html - Уже репаренный HTML (после _repairCapsuleHtml)
 * @returns {string}
 */
function _normalizeEmptyHtml(html) {
    return isFieldEmpty(html) ? '' : html;
}

/**
 * Капсулы (ссылки/сноски), попавшие в DOM через renderActContent, грузятся
 * редактируемыми атомами: ре-применяет ce=false + caret-guard'ы
 * (normalizeMarkers) и навешивает hover-tooltip — зеркало createEditor
 * (textblock-editor.js:65,72), общее для создания поля и setContent.
 * typeof-гварды: методы — миксин из textblock-editor.js (под node-стабом
 * без него — no-op).
 * @param {HTMLElement} element
 */
function _hardenCapsuleField(element) {
    if (typeof textBlockManager.normalizeMarkers === 'function') {
        textBlockManager.normalizeMarkers(element);
    }
    if (typeof textBlockManager._attachInitialTooltipHandlers === 'function') {
        textBlockManager._attachInitialTooltipHandlers(element);
    }
}

export class ViolationBlockSurface {
    /**
     * @param {Object} violation - Объект нарушения (модель)
     * @param {string} fieldKey - Ключ поля реестра ('violated' | 'codeMining' | ...)
     * @param {Object} block - Блок поля (text — attr 'content'; image — attr 'caption')
     * @param {ViolationManager} manager - Владелец setBlockField
     * @param {string} [attr='content'] - Rich-носитель блока ('content' | 'caption')
     */
    constructor(violation, fieldKey, block, manager, attr = 'content') {
        this._violation = violation;
        this._fieldKey = fieldKey;
        this._block = block;
        this._manager = manager;
        this._attr = attr;
        this.id = attr === 'content'
            ? `viol:${violation.id}:${fieldKey}:block:${block.id}`
            : `viol:${violation.id}:${fieldKey}:block:${block.id}:${attr}`;
        this.kind = 'violationField';
        this.rich = true;
        // Контент-хост резолвит вызывающий код (always-live contenteditable) —
        // на момент создания поверхности его может не быть.
        this.element = null;
    }

    getContent() { return this._block[this._attr]; }

    /** Модель → element, С ре-рендером (внешняя запись: формализатор, корректор). */
    setContent(html) {
        // html может прийти с caret-guard'ами/битыми капсулами (корректор
        // реконструирует текст выделения из живого DOM). Модель ВСЕГДА получает
        // report.html (guard'ы вычищены) — БЕЗУСЛОВНО, ОДНИМ вызовом (сравнивать
        // repaired!==html нельзя, changed не про guard-стрип). DOM рендерим
        // переданным html немедленно; повторный ре-рендер репаренным — только
        // если репак реально структурно починил капсулу.
        const report = _repairCapsuleHtml(html);
        this._manager.setBlockField(
            this._violation, this._fieldKey, this._block.id, this._attr, report.html);
        renderActContent(this.element, html);
        if (report.changed) {
            renderActContent(this.element, report.html);
        }
        // Внешняя запись может принести капсулы как обычные span'ы —
        // ре-применяем ce=false/caret-guard'ы и tooltip.
        _hardenCapsuleField(this.element);
    }

    /** element → модель, БЕЗ ре-рендера (обычный ввод — каретка жива). */
    commit() {
        // Guard-strip + repair ПЕРЕД записью в модель — зеркало saveContent
        // (textblock-core.js:127-131). Визуально пустое поле нормализуется в ''.
        this._manager.setBlockField(
            this._violation, this._fieldKey, this._block.id, this._attr,
            _normalizeEmptyHtml(_repairCapsuleHtml(this.element.innerHTML).html));
    }

    /** Полный сток поверхности (контракт EditableSurface). ОБЯЗАТЕЛЕН: корректор
     * принимает правку через EditorRegistry.getActive().persist(). Отдельного
     * finalize/capsule-heal-шага для полей нарушения нет — делегирует в commit. */
    persist() { this.commit(); }
}

/**
 * Фабрика поверхности блока. Мешается в прототип ViolationManager (как
 * violationMutations) — `this` внутри вызова `vm._makeBlockSurface(...)` это
 * `vm`; setBlockField резолвится в момент вызова через surface._manager,
 * поэтому подмена метода на инстансе (тесты-спаи) остаётся видна.
 * @param {Object} violation - Объект нарушения
 * @param {string} fieldKey - Ключ поля реестра
 * @param {Object} block - Блок поля
 * @param {string} [attr='content'] - Rich-носитель ('content' | 'caption')
 * @returns {ViolationBlockSurface}
 */
function _makeBlockSurface(violation, fieldKey, block, attr = 'content') {
    return new ViolationBlockSurface(violation, fieldKey, block, this, attr);
}

/**
 * Создаёт живой contenteditable-хост rich-текста блока — наполняется из МОДЕЛИ
 * через renderActContent (профиль 'acts'): HTML-формат переживает ре-рендер.
 * На фокус монтирует EditorController на переданную поверхность; контроллер
 * сам навешивает write-through (input→commit) и blur→unmount — здесь их
 * дублировать нельзя.
 * @param {ViolationBlockSurface} surface - Поверхность блока
 * @param {{placeholder?:string, isReadOnly?:boolean}} [options]
 * @returns {HTMLElement} contenteditable-хост поля
 */
function _createRichFieldEditor(surface, { placeholder = '', isReadOnly = false } = {}) {
    const field = document.createElement('div');
    // Гейт finalizeEdit сравнивает число сносок с кэшем __lastFootnoteCount —
    // без явного 0 на свежем поле кэш undefined, footnoteCount(0)!==undefined
    // триггернул бы renumberAllFootnotes на поле без единой сноски.
    field.__lastFootnoteCount = 0;
    // violation-field — load-bearing (read-only-проход app.js + read-only.css +
    // ЛИСТОВОЙ маркер целей поиска — не вешать на контейнеры с вложенными
    // таблицами!); violation-textarea — существующий визуальный стиль.
    field.className = `${RENDER_CLASSES.VIOLATION_FIELD} ${RENDER_CLASSES.VIOLATION_TEXTAREA}`;
    if (placeholder) field.dataset.placeholder = placeholder;
    // Хост становится element поверхности ДО наполнения — commit/setContent
    // читают/пишут именно его.
    surface.element = field;
    // Обратная ссылка хост→поверхность (линчпин поиска/замены): даёт
    // ViolationFieldSearchTarget (act-search-engine.js) адресовать persist/undo
    // без data-*-атрибутов — движок остаётся violation-агностичным.
    field.__surface = surface;
    renderActContent(field, surface.getContent() || '');

    // Чиним уже-битые капсулы при открытии (дубль-id и т.п.) — только не-RO:
    // RO ничего не пишет обратно в модель. V27: повторный рендер — только если
    // репак реально что-то починил.
    if (!isReadOnly) {
        const report = _repairCapsuleHtml(field.innerHTML);
        if (report.changed) {
            renderActContent(field, report.html);
        }
    }
    // ce=false/caret-guard'ы + tooltip — в ОБОИХ режимах: капсула должна быть
    // атомом и на просмотре.
    _hardenCapsuleField(field);

    // Placeholder (.textblock-editor--empty ставится JS-тоглом, CSS B-26).
    if (!isReadOnly && typeof textBlockManager._toggleEmptyClass === 'function') {
        textBlockManager._toggleEmptyClass(field);
    }

    if (isReadOnly) {
        // Режим просмотра: нередактируемо (зеркало textblock createEditor).
        field.contentEditable = 'false';
        field.classList.add('read-only');
        return field;
    }

    field.contentEditable = 'true';
    field.addEventListener('focus', () => EditorController.mount(surface));
    // T7 (#6/#14b): drop-обработчик навешиваем ПРИ СОЗДАНИИ поля, НЕ на mount —
    // focus приходит как default-action события drop (ПОСЛЕ drop-обработчиков).
    field.addEventListener('drop', (e) => EditorController.handleSurfaceDrop(e, surface));
    return field;
}

/**
 * Снимает контроллер с активного rich-поля, если оно принадлежит ИМЕННО этому
 * нарушению (id 'viol:<id>:...'). Зовётся ПЕРЕД пересозданием/удалением DOM
 * нарушения: иначе после replaceChild/innerHTML='' EditorController держал бы
 * detached-хост со слушателями. unmount коммитит последний ввод в модель ДО
 * отрыва DOM — данные не теряются. Ведущее двоеточие в префиксе исключает
 * коллизию id-подстрок (v1 vs v12). Best-effort: под изолированным юнит-тестом
 * реестр пуст → no-op.
 * @param {string} violationId
 */
function _teardownActiveRichField(violationId) {
    const active = EditorRegistry.getActive();
    if (active && typeof active.id === 'string'
        && active.id.startsWith(`viol:${violationId}:`)) {
        EditorController.unmount();
    }
}

// Домешиваем фабрики и хелперы в прототип ViolationManager (как остальные violation-*).
Object.assign(ViolationManager.prototype, {
    _makeBlockSurface,
    _createRichFieldEditor,
    _teardownActiveRichField,
});

window.ViolationBlockSurface = ViolationBlockSurface;
