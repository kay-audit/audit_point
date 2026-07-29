/**
 * Поверхности и хост rich-полей нарушения (Task 1.3.2 → 1.3.3, Task 7).
 *
 * Task 1.3.2 — поверхности по контракту EditableSurface (editable-surface.js):
 *  - ViolationFieldSurface — текстовые поля карточки (violated/established/
 *    reasons/measures/consequences/responsible), запись через setViolationField;
 *  - ViolationContentItemSurface — текст элемента доп. контента (кейс/свободный
 *    текст), запись через setContentItemField.
 * Обе — воплощения контракта после TextBlockSurface (тот остаётся образцом).
 *
 * Task 7 — ViolationListItemSurface: пункт списка описаний (descriptionList),
 * запись по индексу через setViolationListItem. У неё нет setContent — ничто
 * не пишет в пункт списка программно (формализатор раскладывает только 6
 * именованных текстовых полей карточки, см. _applyFormalized); persist
 * ОБЯЗАТЕЛЕН — корректор принимает правку через EditorRegistry.getActive().persist().
 *
 * Два режима записи в модель (см. EditorController, editor-controller.js):
 *  - commit()     — element → модель, БЕЗ ре-рендера (обычный ввод, каретка жива);
 *  - setContent() — модель → element, С ре-рендером (внешняя запись: формализатор,
 *    корректор, improve-text).
 * Обе операции идут ТОЛЬКО через мутаторы (setViolationField/setContentItemField/
 * setViolationListItem) — единственные защищённые точки записи (requireWrite-guard +
 * превью, violation-mutations.js). Прямая запись в модель здесь запрещена.
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
import { isFieldEmpty } from './violation-field-empty.js';
import { parseFieldPath } from './violation-mutations.js';

/**
 * Читает значение поля нарушения по пути мутатора (плоский 'violated' либо
 * точечный 'reasons.content' — до 2 уровней). Разбор пути — общий с write
 * (parseFieldPath, violation-mutations.js, V23) — раньше расходился (read
 * защищён `?.`, write — нет).
 * @param {Object} violation - Объект нарушения
 * @param {string} path - Путь поля
 * @returns {*} Текущее значение поля
 */
function _readViolationField(violation, path) {
    const { key, subKey } = parseFieldPath(path);
    return subKey === null ? violation[key] : violation[key]?.[subKey];
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

/**
 * #12 (основа) + V24: очищенное contenteditable-поле оставляет в DOM
 * `<br>`/`<div><br></div>` — без нормализации write-path коммитил бы этот
 * мусор в модель как есть. Визуально пустое поле (нет текста и значимых
 * inline-элементов, isFieldEmpty — violation-field-empty.js, тот же предикат,
 * что и у подсветки `--empty`) коммитится как `''`. Даёт согласованность:
 * рендер-проверка пустоты по модели после коммита совпадает с DOM-проверкой
 * (пустое поле = '').
 * @param {string} html - Уже репаренный HTML (после _repairCapsuleHtml)
 * @returns {string}
 */
function _normalizeEmptyHtml(html) {
    return isFieldEmpty(html) ? '' : html;
}

/**
 * Task 1.3.4-B1: капсулы (ссылки/сноски), попавшие в DOM через renderActContent
 * (профиль 'acts' срезает contenteditable — он рантайм-only, не в allowlist'е
 * бэк-санитайзера), грузятся РЕДАКТИРУЕМЫМИ атомами: каретка заходит внутрь,
 * Enter у границы клонирует маркер. Ре-применяет ce=false + caret-guard'ы
 * (normalizeMarkers) и навешивает hover-tooltip (_attachInitialTooltipHandlers) —
 * зеркало createEditor (textblock-editor.js:65,72), общее для создания поля и
 * setContent. RO-поля фокус не получают (EditorController.mount не монтируется
 * в RO-ветке _createRichFieldEditor) — без этого вызова их капсулы были бы
 * немы (contenteditable редактируемый, без tooltip).
 * typeof-гварды — как у _repairCapsuleHtml выше: методы — миксин из
 * textblock-editor.js, который поле нарушения не импортирует напрямую (до
 * домешивания в граф импортов — no-op, безопасно под node-стабом без него).
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
        // Task 1.3.4-B1: внешняя запись (формализатор/корректор) может принести
        // капсулы как обычные span'ы — ре-применяем ce=false/caret-guard'ы и
        // навешиваем tooltip (см. докстринг _hardenCapsuleField).
        _hardenCapsuleField(this.element);
    }

    /** element → модель, БЕЗ ре-рендера (обычный ввод — каретка жива). */
    commit() {
        // Guard-strip + repair ПЕРЕД записью в модель — зеркало saveContent
        // (textblock-core.js:127-131). Визуально пустое поле нормализуется в
        // '' (_normalizeEmptyHtml) — см. её докстринг.
        this._manager.setViolationField(
            this._violation, this._path,
            _normalizeEmptyHtml(_repairCapsuleHtml(this.element.innerHTML).html));
    }

    /** Полный сток поверхности (контракт EditableSurface). Отдельного
     * finalize/capsule-heal-шага для полей нарушения нет (капсулы — задача
     * 1.3.4), поэтому persist делегирует в commit. */
    persist() { this.commit(); }
}

/**
 * Поверхность текстового элемента дополнительного контента (кейс/свободный
 * текст/подпись картинки). Отличается от ViolationFieldSurface точкой записи:
 * коммитит в item[field] через setContentItemField (мутатор элементов
 * контента), а не в поле карточки через setViolationField. kind='violationField'
 * — та же политика тулбара (базовое форматирование без сносок).
 *
 * field (Task 6) — какое поле item'а несёт rich-текст: 'content' у кейса/
 * свободного текста (дефолт, существующие вызовы не передают field), 'caption'
 * у подписи картинки. id для НЕ-content поля несёт суффикс `:<field>`
 * (`viol:<vid>:item:<iid>:caption`) — 'content' оставлен без суффикса ради
 * обратной совместимости существующих id (тесты/снапшоты); префикс
 * `viol:<id>:` для _teardownActiveRichField продолжает матчить в обоих случаях.
 */
export class ViolationContentItemSurface {
    /**
     * @param {Object} violation - Объект нарушения (модель)
     * @param {Object} item - Элемент additionalContent.items[] (кейс/текст/картинка)
     * @param {ViolationManager} manager - Владелец setContentItemField
     * @param {string} [field='content'] - Поле item'а ('content' | 'caption')
     */
    constructor(violation, item, manager, field = 'content') {
        this._violation = violation;
        this._item = item;
        this._manager = manager;
        this._field = field;
        this.id = field === 'content'
            ? `viol:${violation.id}:item:${item.id}`
            : `viol:${violation.id}:item:${item.id}:${field}`;
        this.kind = 'violationField';
        this.rich = true;
        this.element = null;
    }

    getContent() { return this._item[this._field]; }

    /** Модель → element, С ре-рендером (внешняя запись). */
    setContent(html) {
        // Task 1.3.4-A: см. ViolationFieldSurface.setContent — модель ВСЕГДА
        // получает report.html безусловно, ре-рендер DOM повторно — только при
        // реальной структурной починке (changed).
        const report = _repairCapsuleHtml(html);
        this._manager.setContentItemField(this._violation, this._item, this._field, report.html);
        renderActContent(this.element, html);
        if (report.changed) {
            renderActContent(this.element, report.html);
        }
        // Task 1.3.4-B1: см. ViolationFieldSurface.setContent — ре-применяем
        // ce=false/caret-guard'ы и навешиваем tooltip (_hardenCapsuleField).
        _hardenCapsuleField(this.element);
    }

    /** element → модель, БЕЗ ре-рендера (обычный ввод — каретка жива). */
    commit() {
        // Guard-strip + repair + нормализация пустоты — см. ViolationFieldSurface.commit.
        this._manager.setContentItemField(
            this._violation, this._item, this._field,
            _normalizeEmptyHtml(_repairCapsuleHtml(this.element.innerHTML).html));
    }

    /** Полный сток поверхности (контракт EditableSurface). Отдельного
     * finalize/capsule-heal-шага для полей нарушения нет (капсулы — задача
     * 1.3.4), поэтому persist делегирует в commit. */
    persist() { this.commit(); }
}

/**
 * Поверхность пункта списка описаний нарушения (Task 7). Отличается от
 * ViolationContentItemSurface точкой записи: коммитит по индексу через
 * setViolationListItem (мутатор списка), а не item[field] через
 * setContentItemField. Индексная адресация — surface держит
 * (violation, fieldName, index); при add/remove пунктов список
 * пере-рендеривается целиком (renderList, violation-core.js), и КАЖДЫЙ
 * пункт получает НОВУЮ поверхность с текущим индексом — застревания старых
 * индексов нет (пере-рендер идёт ПОСЛЕ _teardownActiveRichField).
 */
export class ViolationListItemSurface {
    /**
     * @param {Object} violation - Объект нарушения (модель)
     * @param {string} fieldName - Имя поля-списка ('descriptionList' | ...)
     * @param {number} index - Индекс пункта
     * @param {ViolationManager} manager - Владелец setViolationListItem
     */
    constructor(violation, fieldName, index, manager) {
        this._violation = violation;
        this._fieldName = fieldName;
        this._index = index;
        this._manager = manager;
        this.id = `viol:${violation.id}:list:${fieldName}:${index}`;
        this.kind = 'violationField';
        this.rich = true;
        this.element = null;
    }

    getContent() { return this._violation[this._fieldName].items[this._index]; }

    /** element → модель, БЕЗ ре-рендера (обычный ввод — каретка жива). */
    commit() {
        // Guard-strip + repair + нормализация пустоты в модель — зеркало
        // ViolationFieldSurface.commit/ViolationContentItemSurface.commit.
        this._manager.setViolationListItem(
            this._violation, this._fieldName, this._index,
            _normalizeEmptyHtml(_repairCapsuleHtml(this.element.innerHTML).html));
    }

    /** Полный сток поверхности (контракт EditableSurface). ОБЯЗАТЕЛЕН: корректор
     * принимает правку через EditorRegistry.getActive().persist() (см. _accept в
     * corrector-popover.js) — без persist приятие правки в пункте списка упадёт
     * (прецедент фикса 1.3.3). Отдельного finalize/capsule-heal-шага для полей
     * нарушения нет, поэтому persist делегирует в commit. */
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
 * Фабрика поверхности текстового элемента доп. контента (кейс/свободный текст/
 * подпись картинки). Как _makeViolationSurface, но для item[field] — see
 * ViolationContentItemSurface.
 * @param {Object} violation - Объект нарушения
 * @param {Object} item - Элемент additionalContent.items[]
 * @param {string} [field='content'] - Поле item'а ('content' | 'caption')
 * @returns {ViolationContentItemSurface}
 */
function _makeContentItemSurface(violation, item, field = 'content') {
    return new ViolationContentItemSurface(violation, item, this, field);
}

/**
 * Фабрика поверхности пункта списка описаний (Task 7). Как _makeViolationSurface,
 * но адресация по индексу — см. ViolationListItemSurface.
 * @param {Object} violation - Объект нарушения
 * @param {string} fieldName - Имя поля-списка ('descriptionList' | ...)
 * @param {number} index - Индекс пункта
 * @returns {ViolationListItemSurface}
 */
function _makeViolationListItemSurface(violation, fieldName, index) {
    return new ViolationListItemSurface(violation, fieldName, index, this);
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
    // Обратная ссылка хост→поверхность (линчпин поиска/замены): даёт
    // ViolationFieldSearchTarget (act-search-engine.js) адресовать persist/undo
    // без data-*-атрибутов — движок остаётся violation-агностичным. Ставим в
    // ЕДИНСТВЕННОЙ точке создания поля, ДО RO-ветки ниже (RO-поля тоже ищутся,
    // строка замены в них скрыта отдельным механизмом).
    field.__surface = surface;
    renderActContent(field, surface.getContent() || '');

    // Task 1.3.4-B1: чиним уже-битые капсулы старых актов при открытии
    // (дубль-id и т.п.) — round-trip как в createEditor O1 (textblock-editor.js
    // :55-58). Только не-RO: RO ничего не пишет обратно в модель (нет
    // commit/setContent от пользовательского ввода), чинить незачем то, что
    // никогда не покинет эту DOM-копию.
    // V27: поле УЖЕ отрисовано строкой выше (surface.getContent()) — второй
    // renderActContent имеет смысл ТОЛЬКО если репак реально что-то починил
    // (гейт как у report.changed в setContent выше), иначе это безусловный
    // повторный рендер на КАЖДОЙ из ≥8 фабрик поля на карточку.
    if (!isReadOnly) {
        const report = _repairCapsuleHtml(field.innerHTML);
        if (report.changed) {
            renderActContent(field, report.html);
        }
    }
    // ce=false/caret-guard'ы + tooltip — в ОБОИХ режимах: капсула должна быть
    // атомом и на просмотре (см. докстринг _hardenCapsuleField).
    _hardenCapsuleField(field);

    // Placeholder (.textblock-editor--empty ставится JS-тоглом, CSS B-26) — на
    // свежесозданном поле класс иначе не появится и подсказка не видна.
    if (!isReadOnly && typeof textBlockManager._toggleEmptyClass === 'function') {
        textBlockManager._toggleEmptyClass(field);
    }

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
    // T7 (#6/#14b): drop-обработчик навешиваем ПРИ СОЗДАНИИ поля, НЕ на mount —
    // focus приходит как default-action события drop (ПОСЛЕ drop-обработчиков),
    // поэтому mount-time слушатель пропустил бы drop в несфокусированное поле
    // (сценарий #6). Санитизация + гейт сносок по политике поверхности + commit
    // модели — в EditorController.handleSurfaceDrop.
    field.addEventListener('drop', (e) => EditorController.handleSurfaceDrop(e, surface));
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
    _makeViolationListItemSurface,
    _createRichFieldEditor,
    _teardownActiveRichField,
});

window.ViolationFieldSurface = ViolationFieldSurface;
window.ViolationContentItemSurface = ViolationContentItemSurface;
window.ViolationListItemSurface = ViolationListItemSurface;
