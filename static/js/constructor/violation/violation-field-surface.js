/**
 * Поверхности и хост rich-полей нарушения (Task 1.3.2 → 1.3.3).
 *
 * Task 1.3.2 — поверхности по контракту EditableSurface (editable-surface.js):
 *  - ViolationFieldSurface — текстовые поля карточки (violated/established/
 *    reasons/measures/consequences/responsible), запись через setViolationField;
 *  - ViolationContentItemSurface — текст элемента доп. контента (кейс/свободный
 *    текст), запись через setContentItemField.
 * Обе — воплощения контракта после TextBlockSurface (тот остаётся образцом).
 *
 * Два режима записи в модель (см. EditorController, editor-controller.js):
 *  - commit()     — element → модель, БЕЗ ре-рендера (обычный ввод, каретка жива);
 *  - setContent() — модель → element, С ре-рендером (внешняя запись: формализатор,
 *    корректор, improve-text).
 * Обе операции идут ТОЛЬКО через мутаторы (setViolationField/setContentItemField) —
 * единственные защищённые точки записи (requireWrite-guard + превью,
 * violation-mutations.js). Прямая запись в модель здесь запрещена.
 *
 * Task 1.3.3 — хост поля (_createRichFieldEditor) и снятие контроллера при
 * пересоздании DOM (_teardownActiveRichField): живой contenteditable, монтирующий
 * EditorController на фокусе. Здесь же локализована связанность с
 * EditorController/EditorRegistry (violation-core/violation-rendering зовут
 * методы прототипа, своих импортов контроллера не заводят).
 */
import { renderActContent } from '../../shared/sanitize.js';
import { RENDER_CLASSES } from '../render-classes.js';
import { ViolationManager } from './violation-core.js';
import { EditorController } from '../textblock/editor-controller.js';
import { EditorRegistry } from '../textblock/editor-registry.js';
import { textBlockManager } from '../textblock/textblock-core.js';

/**
 * Читает значение поля нарушения по пути мутатора (плоский 'violated' либо
 * точечный 'reasons.content' — до 2 уровней, зеркало разбора пути в
 * setViolationField, violation-mutations.js).
 * @param {Object} violation - Объект нарушения
 * @param {string} path - Путь поля
 * @returns {*} Текущее значение поля
 */
function _readViolationField(violation, path) {
    const parts = path.split('.');
    if (parts.length === 1) return violation[parts[0]];
    return violation[parts[0]]?.[parts[1]];
}

/**
 * Guard-strip (U+FEFF) + validateAndRepairCapsules-репорт — зеркало пред-записи
 * в saveContent/handleEditorBlur (textblock-core.js:127-131,
 * textblock-editor.js:501-508): капсулы поля нарушения (Task 1.3.4) несут те же
 * caret-guard'ы и подвержены тем же инвариантам (дубль-id, расщеплённый клон,
 * пустой data-*), которые НЕЛЬЗЯ пускать в модель→превью→DOCX.
 *
 * Возвращает {html, changed}: html — ВСЕГДА чистый (guard'ы вычищены и
 * _repairCapsulesInRoot прогнан), безопасен для записи в модель БЕЗ условий.
 * changed — признак РЕАЛЬНОЙ структурной починки (дубль-id/расщеплённый клон/
 * пустая капсула), а НЕ косметики: снятие contenteditable и стрип guard'ов
 * МЕНЯЮТ строку всегда при наличии капсулы, но changed не взводят
 * (textblock-capsule-integrity.js:78-89, комментарий «косметика ... changed не
 * взводим») — сравнивать repaired!==html как признак «нужна доп. запись»
 * нельзя (здоровая капсула с guard'ами и без структурных проблем даст
 * changed=false, но строка всё равно отличается). changed нужен ТОЛЬКО для
 * решения о ДОРОГОМ ре-рендере DOM (guard-стрип невидим — без структурной
 * починки визуально нечего перерисовывать). До домешивания капсульного
 * миксина (textblock-editor.js/textblock-capsule-integrity.js) в граф
 * импортов — identity, changed=false.
 * @param {string} html
 * @returns {{html: string, changed: boolean}}
 */
function _repairCapsuleHtml(html) {
    const stripped = textBlockManager._stripGuards ? textBlockManager._stripGuards(html) : html;
    return typeof textBlockManager._repairCapsulesReport === 'function'
        ? textBlockManager._repairCapsulesReport(stripped)
        : { html: stripped, changed: false };
}

export class ViolationFieldSurface {
    /**
     * @param {Object} violation - Объект нарушения (модель)
     * @param {string} path - Путь поля ('violated' | 'reasons.content' | ...)
     * @param {ViolationManager} manager - Владелец setViolationField
     */
    constructor(violation, path, manager) {
        this._violation = violation;
        this._path = path;
        this._manager = manager;
        this.id = `viol:${violation.id}:${path}`;
        this.kind = 'violationField';
        this.rich = true;
        // Контенthost резолвит вызывающий код (Task 1.3.3, always-live
        // contenteditable) — на момент создания поверхности его может не быть.
        this.element = null;
    }

    getContent() { return _readViolationField(this._violation, this._path); }

    /** Модель → element, С ре-рендером (внешняя запись: формализатор, корректор). */
    setContent(html) {
        // Task 1.3.4-A: html может прийти с caret-guard'ами/битыми капсулами
        // (напр. корректор реконструирует текст выделения из живого DOM). Модель
        // ВСЕГДА получает report.html (guard'ы вычищены) — БЕЗУСЛОВНО, ОДНИМ
        // вызовом (см. докстринг _repairCapsuleHtml: сравнивать по строке
        // нельзя, changed не про guard-стрип). DOM рендерим переданным html
        // немедленно; повторный ре-рендер репаренным — только если репак
        // реально структурно починил капсулу (иначе визуально нечего менять).
        const report = _repairCapsuleHtml(html);
        this._manager.setViolationField(this._violation, this._path, report.html);
        renderActContent(this.element, html);
        if (report.changed) {
            renderActContent(this.element, report.html);
        }
    }

    /** element → модель, БЕЗ ре-рендера (обычный ввод — каретка жива). */
    commit() {
        // Guard-strip + repair ПЕРЕД записью в модель — зеркало saveContent
        // (textblock-core.js:127-131).
        this._manager.setViolationField(
            this._violation, this._path, _repairCapsuleHtml(this.element.innerHTML).html);
    }

    /** Полный сток поверхности (контракт EditableSurface). Отдельного
     * finalize/capsule-heal-шага для полей нарушения нет (капсулы — задача
     * 1.3.4), поэтому persist делегирует в commit. */
    persist() { this.commit(); }
}

/**
 * Поверхность текстового элемента дополнительного контента (кейс/свободный
 * текст). Отличается от ViolationFieldSurface точкой записи: коммитит в
 * item.content через setContentItemField (мутатор элементов контента), а не в
 * поле карточки через setViolationField. kind='violationField' — та же политика
 * тулбара (базовое форматирование без сносок).
 */
export class ViolationContentItemSurface {
    /**
     * @param {Object} violation - Объект нарушения (модель)
     * @param {Object} item - Элемент additionalContent.items[] (кейс/текст)
     * @param {ViolationManager} manager - Владелец setContentItemField
     */
    constructor(violation, item, manager) {
        this._violation = violation;
        this._item = item;
        this._manager = manager;
        this.id = `viol:${violation.id}:item:${item.id}`;
        this.kind = 'violationField';
        this.rich = true;
        this.element = null;
    }

    getContent() { return this._item.content; }

    /** Модель → element, С ре-рендером (внешняя запись). */
    setContent(html) {
        // Task 1.3.4-A: см. ViolationFieldSurface.setContent — модель ВСЕГДА
        // получает report.html безусловно, ре-рендер DOM повторно — только при
        // реальной структурной починке (changed).
        const report = _repairCapsuleHtml(html);
        this._manager.setContentItemField(this._violation, this._item, 'content', report.html);
        renderActContent(this.element, html);
        if (report.changed) {
            renderActContent(this.element, report.html);
        }
    }

    /** element → модель, БЕЗ ре-рендера (обычный ввод — каретка жива). */
    commit() {
        // Guard-strip + repair ПЕРЕД записью — см. ViolationFieldSurface.commit.
        this._manager.setContentItemField(
            this._violation, this._item, 'content', _repairCapsuleHtml(this.element.innerHTML).html);
    }

    /** Полный сток поверхности (контракт EditableSurface). Отдельного
     * finalize/capsule-heal-шага для полей нарушения нет (капсулы — задача
     * 1.3.4), поэтому persist делегирует в commit. */
    persist() { this.commit(); }
}

/**
 * Фабрика поверхности поля нарушения. Мешается в прототип ViolationManager
 * (как violationMutations, violation-mutations.js) — `this` внутри вызова
 * `vm._makeViolationSurface(...)` это `vm`; setViolationField резолвится в
 * момент вызова через surface._manager, поэтому подмена метода на инстансе
 * (тесты-спаи) остаётся видна.
 * @param {Object} violation - Объект нарушения
 * @param {string} path - Путь поля ('violated' | 'reasons.content' | ...)
 * @returns {ViolationFieldSurface}
 */
function _makeViolationSurface(violation, path) {
    return new ViolationFieldSurface(violation, path, this);
}

/**
 * Фабрика поверхности текстового элемента доп. контента (кейс/свободный текст).
 * Как _makeViolationSurface, но для item.content — see ViolationContentItemSurface.
 * @param {Object} violation - Объект нарушения
 * @param {Object} item - Элемент additionalContent.items[]
 * @returns {ViolationContentItemSurface}
 */
function _makeContentItemSurface(violation, item) {
    return new ViolationContentItemSurface(violation, item, this);
}

/**
 * Создаёт живой contenteditable-хост rich-поля нарушения (Task 1.3.3) —
 * замена прежнего <textarea>. Наполняется из МОДЕЛИ через renderActContent
 * (профиль 'acts'): HTML-формат из модели отображается и переживает ре-рендер
 * (не схлопывается в plain — критерий приёмки). На фокус монтирует
 * EditorController на переданную поверхность; контроллер сам навешивает
 * write-through (input→commit) и blur→unmount — здесь их дублировать нельзя.
 * Хост всегда живой contenteditable (как редактор текстблока); ленивая
 * dblclick-активация отложена в Фазу 2.
 * @param {EditableSurface} surface - поверхность поля (card | content-item)
 * @param {{placeholder?:string, isReadOnly?:boolean}} [options]
 * @returns {HTMLElement} contenteditable-хост поля
 */
function _createRichFieldEditor(surface, { placeholder = '', isReadOnly = false } = {}) {
    const field = document.createElement('div');
    // Task 1.3.4-A: гейт finalizeEdit (шаг б) сравнивает число сносок с кэшем
    // __lastFootnoteCount — без явного 0 на свежем поле кэш undefined,
    // footnoteCount(0)!==undefined триггернул бы renumberAllFootnotes на
    // поле без единой сноски.
    field.__lastFootnoteCount = 0;
    // violation-field — load-bearing (read-only-проход app.js + read-only.css);
    // violation-textarea — существующий визуальный стиль (рамка/паддинги/фокус).
    field.className = `${RENDER_CLASSES.VIOLATION_FIELD} ${RENDER_CLASSES.VIOLATION_TEXTAREA}`;
    if (placeholder) field.dataset.placeholder = placeholder;
    // Хост становится element поверхности ДО наполнения — commit/setContent
    // читают/пишут именно его.
    surface.element = field;
    renderActContent(field, surface.getContent() || '');

    if (isReadOnly) {
        // Режим просмотра: нередактируемо (зеркало textblock createEditor).
        // read-only-проход app.js ищет contenteditable="true" — здесь его нет,
        // поле уже погашено на создании.
        field.contentEditable = 'false';
        field.classList.add('read-only');
        return field;
    }

    field.contentEditable = 'true';
    field.addEventListener('focus', () => EditorController.mount(surface));
    return field;
}

/**
 * Снимает контроллер с активного rich-поля, если оно принадлежит ИМЕННО этому
 * нарушению (id 'viol:<id>:...'). Зовётся ПЕРЕД пересозданием/удалением DOM
 * нарушения (createViolationElement/removeViolation): иначе после
 * replaceChild/innerHTML='' EditorController держал бы detached-хост со
 * слушателями. unmount коммитит последний ввод в модель ДО отрыва DOM — данные
 * не теряются. Ведущее двоеточие в префиксе исключает коллизию id-подстрок
 * (v1 vs v12). Best-effort: под изолированным юнит-тестом реестр пуст → no-op.
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
    _makeViolationSurface,
    _makeContentItemSurface,
    _createRichFieldEditor,
    _teardownActiveRichField,
});

window.ViolationFieldSurface = ViolationFieldSurface;
window.ViolationContentItemSurface = ViolationContentItemSurface;
