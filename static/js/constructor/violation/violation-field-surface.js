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
        this._manager.setViolationField(this._violation, this._path, html);
        renderActContent(this.element, html);
    }

    /** element → модель, БЕЗ ре-рендера (обычный ввод — каретка жива). */
    commit() {
        this._manager.setViolationField(this._violation, this._path, this.element.innerHTML);
    }
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
        this._manager.setContentItemField(this._violation, this._item, 'content', html);
        renderActContent(this.element, html);
    }

    /** element → модель, БЕЗ ре-рендера (обычный ввод — каретка жива). */
    commit() {
        this._manager.setContentItemField(this._violation, this._item, 'content', this.element.innerHTML);
    }
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
