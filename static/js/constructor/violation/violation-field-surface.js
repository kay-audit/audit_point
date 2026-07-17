/**
 * Поверхность поля нарушения (Task 1.3.2, #31A) — воплощение контракта
 * EditableSurface (editable-surface.js) для текстовых полей карточки
 * нарушения (violated/established/reasons/measures/consequences/responsible).
 * Второе воплощение контракта после TextBlockSurface — поверхность
 * текстблока остаётся образцом, эта копирует её форму под свою модель
 * (violation + путь поля вместо textBlockId).
 *
 * Два режима записи в модель (см. EditorController, editor-controller.js):
 *  - commit()     — element → модель, БЕЗ ре-рендера (обычный ввод, каретка жива);
 *  - setContent() — модель → element, С ре-рендером (внешняя запись: формализатор,
 *    корректор, improve-text).
 * Обе операции идут ТОЛЬКО через ViolationManager.setViolationField —
 * единственную защищённую точку записи (requireWrite-guard + превью,
 * violation-mutations.js). Прямая запись в violation[field] здесь запрещена.
 */
import { renderActContent } from '../../shared/sanitize.js';
import { ViolationManager } from './violation-core.js';

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

// Домешиваем фабрику в прототип ViolationManager (как остальные violation-*).
Object.assign(ViolationManager.prototype, { _makeViolationSurface });

window.ViolationFieldSurface = ViolationFieldSurface;
