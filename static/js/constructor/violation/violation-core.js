/**
 * Управление нарушениями в документе
 * Создает и обрабатывает интерактивные формы для ввода нарушений
 */
import { PreviewManager } from '../preview/preview.js';
import { RENDER_CLASSES } from '../render-classes.js';
import { AppConfig } from '../../shared/app-config.js';
import { AppState } from '../state/state-core.js';
import { EscapeStack } from '../../shared/escape-stack.js';
import { Notifications } from '../../shared/notifications.js';
import { FormalizerPopover } from '../text-actions/formalizer-popover.js';
import { plainToRichHtml } from '../../shared/html-text.js';
import { toggleEmptyClass } from './violation-field-empty.js';

/**
 * true, если элемент редактируемый: поле ввода (textarea/input) либо
 * contenteditable-редактор (rich-поле нарушения, текстблок).
 *
 * Два потребителя: paste-обработчик (#19 — Ctrl+V в редакторе не должен уходить
 * в дополнительный контент, когда мышь/фокус рядом с зоной) и ESC-хэндлер зоны
 * в _setActiveZone (§5.9 — Escape при каретке в поле принадлежит редактору).
 * Предикат жил в violation-paste.js под именем pasteTargetIsEditable, но
 * обратный импорт core → paste замкнул бы цикл: paste расширяет
 * ViolationManager.prototype на module-level и упал бы на TDZ класса (граф
 * входит через violation-core.js). Общее место обоих — этот hub-модуль.
 *
 * @param {EventTarget} target - Элемент (e.target события или document.activeElement)
 * @returns {boolean}
 */
export function isEditableTarget(target) {
    if (!target) return false;
    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return true;
    if (target.closest && target.closest('[contenteditable="true"]')) return true;
    return false;
}

export class ViolationManager {
    constructor() {
        this.selectedViolation = null;
        // Переменная для отслеживания последней позиции при drag
        this.lastDragOverIndex = null;
        // Хранилище активных violation для быстрого доступа.
        // Запись добавляется в createAdditionalContentField (violation-additional-content.js);
        // удаляется через removeViolation при разрушении узла дерева — без этого Map
        // рос бесконтрольно при switch'е между актами / удалении нарушений.
        this.activeViolations = new Map();
        // AbortController'ы document-слушателей drop по violation.id
        // (см. setupFileDragAndDrop): abort при повторной установке поля,
        // удалении нарушения и destroy() — иначе слушатели копились
        // на каждый ре-рендер поля дополнительных материалов.
        this._fileDropControllers = new Map();
        // Текущий активный контейнер для paste (только когда мышь внутри)
        this.currentActiveContainer = null;
        // Позиция курсора для вставки (null означает конец списка)
        this.cursorInsertPosition = null;
        // Unsubscribe ESC-хэндлера активной зоны в EscapeStack
        // (push в _setActiveZone, снятие в _resetActiveZone/destroy).
        this._escapeZoneUnsub = null;
    }

    /**
     * Инициализирует обработчики после загрузки всех модулей
     * Вызывается после подключения всех расширений
     */
    initialize() {
        // Настраиваем глобальный обработчик вставки
        this.setupPasteHandler();
    }

    /**
     * Активирует зону вставки (мышь внутри контейнера дополнительного
     * контента) и регистрирует сброс зоны по ESC через EscapeStack —
     * вместо прежнего собственного document-listener'а в обход стека.
     * Идемпотентен: повторная активация не плодит хэндлеры.
     * @param {HTMLElement} container - Контейнер дополнительного контента
     */
    _setActiveZone(container) {
        this.currentActiveContainer = container;
        if (!this._escapeZoneUnsub) {
            this._escapeZoneUnsub = EscapeStack.push(() => {
                // §5.9: смысл ESC определяет ФОКУС, а не положение мыши. Каретка
                // в редактируемом поле — событие принадлежит редактору (blur поля
                // или отмена inline-правки капсулы): отдаём его через passthrough
                // EscapeStack (строго false = не съедать), иначе один и тот же ESC
                // означал бы разное в зависимости от того, где висит мышь.
                // Сброс зоны — только когда фокус вне поля, а мышь в зоне.
                if (isEditableTarget(document.activeElement)) return false;
                this._resetActiveZone();
                Notifications.info('Активная зона сброшена');
            });
        }
    }

    /**
     * Сбрасывает активную зону вставки и снимает ESC-хэндлер со стека.
     * Идемпотентен.
     */
    _resetActiveZone() {
        this.currentActiveContainer = null;
        this.cursorInsertPosition = null;
        if (this._escapeZoneUnsub) {
            const unsub = this._escapeZoneUnsub;
            this._escapeZoneUnsub = null;
            unsub();
        }
    }

    /**
     * Удаляет нарушение из реестра активных. Идемпотентен.
     * Вызывать при разрушении DOM-секции нарушения / удалении узла дерева.
     * @param {string} violationId
     */
    removeViolation(violationId) {
        if (!violationId) return;
        // Task 1.3.3: узел нарушения разрушается — снимаем контроллер с его
        // rich-поля, если оно активно (иначе EditorController держал бы
        // detached-хост со слушателями). Best-effort: `?.` на случай вызова до
        // домешивания rich-хелперов (violation-field-surface.js) в изоляции.
        this._teardownActiveRichField?.(violationId);
        this.activeViolations.delete(violationId);
        const controller = this._fileDropControllers.get(violationId);
        if (controller) {
            controller.abort();
            this._fileDropControllers.delete(violationId);
        }

        // #23: активная зона вставки принадлежала удаляемому нарушению — сбрасываем
        // её (иначе paste/ESC работали бы с зоной уже несуществующего нарушения).
        const owner = this.currentActiveContainer?.querySelector?.('.additional-content-items')
            ?.dataset?.violationId;
        if (owner === violationId) {
            this._resetActiveZone();
        }
    }

    /**
     * Полный сброс реестра активных нарушений.
     * Безопасно вызывать при switch'е акта или teardown.
     */
    destroy() {
        this.activeViolations.clear();
        this._fileDropControllers.forEach(controller => controller.abort());
        this._fileDropControllers.clear();
        this._resetActiveZone();
        this.selectedViolation = null;
        this.lastDragOverIndex = null;
    }

    /**
     * Создает элемент нарушения для отображения в интерфейсе
     * @param {Object} violation - Объект нарушения с полями (violated, established, и т.д.)
     * @param {Object} node - Узел дерева, к которому привязано нарушение
     * @returns {HTMLElement} Контейнер с формой нарушения
     */
    createViolationElement(violation, node) {
        // Task 1.3.3: снимаем контроллер с прежнего rich-поля этого нарушения
        // перед пересозданием DOM — иначе после replaceChild/innerHTML='' он
        // держал бы detached-хост со слушателями (commit сохранит последний ввод).
        this._teardownActiveRichField(violation.id);

        // Режим только чтения определяем один раз — для всех полей карточки.
        const isReadOnly = AppConfig.readOnlyMode?.isReadOnly;

        const section = document.createElement('div');
        section.className = RENDER_CLASSES.VIOLATION_SECTION;
        section.dataset.violationId = violation.id;

        const columnsContainer = document.createElement('div');
        columnsContainer.className = 'violation-columns';

        // Колонка "Нарушено"
        const violatedColumn = document.createElement('div');
        violatedColumn.className = 'violation-column';

        const violatedLabel = document.createElement('div');
        violatedLabel.className = 'violation-label';
        violatedLabel.textContent = 'Нарушено:';
        violatedColumn.appendChild(violatedLabel);

        // «Нарушено» — rich-поле (contenteditable). Наполняется из модели, формат
        // переживает ре-рендер; ввод пишется в модель через write-through
        // контроллера (setViolationField). Аудит — diff при сохранении
        // (violation-audit.js), не per-keystroke.
        const violatedField = this._createRichFieldEditor(
            this._makeViolationSurface(violation, 'violated'),
            { placeholder: 'Опишите нарушение...', isReadOnly },
        );
        violatedColumn.appendChild(violatedField);

        // Колонка "Установлено"
        const establishedColumn = document.createElement('div');
        establishedColumn.className = 'violation-column';

        const establishedLabel = document.createElement('div');
        establishedLabel.className = 'violation-label';
        establishedLabel.textContent = 'Установлено:';
        establishedColumn.appendChild(establishedLabel);

        // «Установлено» — rich-поле (симметрично «Нарушено»).
        const establishedField = this._createRichFieldEditor(
            this._makeViolationSurface(violation, 'established'),
            { placeholder: 'Опишите установленное...', isReadOnly },
        );
        establishedColumn.appendChild(establishedField);

        columnsContainer.appendChild(violatedColumn);
        columnsContainer.appendChild(establishedColumn);
        section.appendChild(columnsContainer);

        // Контейнер для дополнительных опциональных полей
        const optionalFieldsContainer = document.createElement('div');
        optionalFieldsContainer.className = 'violation-optional-fields';

        optionalFieldsContainer.appendChild(
            this.createOptionalField(violation, 'descriptionList', 'Описание причин', 'list', isReadOnly)
        );

        optionalFieldsContainer.appendChild(
            this.createAdditionalContentField(violation, isReadOnly)
        );

        const reasonsField = this.createOptionalField(violation, 'reasons', 'Причины', 'text', isReadOnly);
        const measuresField = this.createOptionalField(violation, 'measures', 'Принятые меры', 'text', isReadOnly);
        const consequencesField = this.createOptionalField(violation, 'consequences', 'Последствия', 'text', isReadOnly);
        const responsibleField = this.createOptionalField(violation, 'responsible', 'Ответственные', 'text', isReadOnly);
        optionalFieldsContainer.appendChild(reasonsField);
        optionalFieldsContainer.appendChild(measuresField);
        optionalFieldsContainer.appendChild(consequencesField);
        optionalFieldsContainer.appendChild(responsibleField);

        section.appendChild(optionalFieldsContainer);

        // Формализация: раскладка свободного текста по полям карточки (не в RO-режиме).
        if (!isReadOnly) {
            // Номер пункта нарушения — это номер РОДИТЕЛЬСКОГО пункта (у самого
            // violation-узла number вида «Нарушение N», не «5.x»).
            const pointNumber = AppState.findParentNode(node?.id)?.number || '';
            this._addFormalizeButton(section, violation, pointNumber, {
                violated: violatedField,
                established: establishedField,
                reasons: reasonsField,
                measures: measuresField,
                consequences: consequencesField,
                responsible: responsibleField,
            });
        }

        return section;
    }

    /**
     * Добавляет кнопку «Формализовать из текста» вверху секции нарушения.
     * Открывает панель-заполнитель; применение раскладывает извлечённые поля.
     * @param {HTMLElement} section - Секция нарушения
     * @param {Object} violation - Объект нарушения
     * @param {string} pointNumber - Номер пункта (для заголовка панели)
     * @param {Object} controls - Ссылки на DOM-контролы полей карточки
     */
    _addFormalizeButton(section, violation, pointNumber, controls) {
        const bar = document.createElement('div');
        bar.className = 'violation-formalize-bar';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'violation-formalize-btn';
        btn.textContent = '✨ Формализовать из текста';
        btn.title = 'Разложить свободный текст нарушения по полям карточки';
        btn.addEventListener('click', () => {
            FormalizerPopover.open({
                violation,
                pointNumber,
                apply: (fields) => this._applyFormalized(violation, controls, fields),
            });
        });

        bar.appendChild(btn);
        section.insertBefore(bar, section.firstChild);
    }

    /**
     * Пишет извлечённые формализацией поля в объект нарушения и его DOM-контролы.
     * Что LLM не извлекла (пустая строка) — поле НЕ трогаем.
     * @param {Object} violation - Объект нарушения
     * @param {Object} controls - Ссылки на DOM-контролы
     * @param {Object} fields - Ответ формализатора (плоские строки)
     */
    _applyFormalized(violation, controls, fields) {
        // Пишем извлечённое поле через поверхность (setContent) — единый защищённый
        // путь модель+DOM: setViolationField (requireWrite-guard + превью) внутри +
        // renderActContent + капсульная гигиена. Это же делает setContent продовым
        // путём (S4: до этой задачи ни одного продового вызова). Плоскую строку LLM
        // переводим в rich HTML (экранирование + \n → <br>) ДО записи.
        const writeField = (path, fieldDiv, value) => {
            const v = (value || '').trim();
            if (!v) return;                 // не извлечено — не затираем существующее
            const html = plainToRichHtml(v);
            if (fieldDiv) {
                const surface = this._makeViolationSurface(violation, path);
                surface.element = fieldDiv;
                surface.setContent(html);
                // setContent не трогает placeholder-класс — снимаем его (поле теперь
                // непусто), иначе CSS-плейсхолдер (.textblock-editor--empty::before)
                // «Опишите нарушение…» оставался бы серым префиксом перед реальным
                // текстом (#7). Предикат пустоты — общий с подсветкой (T5,
                // violation-field-empty.js).
                toggleEmptyClass(fieldDiv, 'textblock-editor--empty', fieldDiv);
            } else {
                // Поле не смонтировано (нет DOM-хоста) — прямой model-write; DOM его
                // подхватит при следующем рендере карточки.
                this.setViolationField(violation, path, html);
            }
        };
        const setPlain = (name, fieldDiv, value) => writeField(name, fieldDiv, value);
        const setOptional = (name, container, value) => {
            const v = (value || '').trim();
            if (!v) return;
            this.setViolationField(violation, `${name}.enabled`, true);
            const cb = container?.querySelector('.violation-field-toggle input[type="checkbox"]');
            const content = container?.querySelector('.violation-field-content');
            const fieldDiv = container?.querySelector('.violation-field-content .violation-field');
            if (cb) cb.checked = true;
            if (content) content.style.display = 'block';
            writeField(`${name}.content`, fieldDiv, value);
        };

        setPlain('violated', controls.violated, fields.violated);
        setPlain('established', controls.established, fields.established);
        setOptional('reasons', controls.reasons, fields.reasons);
        setOptional('measures', controls.measures, fields.measures);
        setOptional('consequences', controls.consequences, fields.consequences);
        setOptional('responsible', controls.responsible, fields.responsible);
        PreviewManager.updateBlock('violation', violation.id);
    }

    /**
     * Создает опциональное поле с чекбоксом для включения/выключения
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldName - Имя поля в объекте violation
     * @param {string} label - Текст метки поля
     * @param {string} type - Тип поля ('list' или 'text')
     * @returns {HTMLElement} Контейнер с опциональным полем
     */
    createOptionalField(violation, fieldName, label, type, isReadOnly = false) {
        // #20 страховка А: дешёвая защита от отсутствующего под-объекта поля
        // (старые/повреждённые данные до normalizeViolations на загрузке).
        // Не перезатирает валидные данные — подставляет дефолт только при
        // полном отсутствии поля; последующие чтения (в т.ч. renderList) безопасны.
        if (!violation[fieldName] || typeof violation[fieldName] !== 'object') {
            violation[fieldName] = { enabled: false, items: [], content: '' };
        }

        const fieldContainer = document.createElement('div');
        fieldContainer.className = 'violation-optional-field';

        // Чекбокс для включения/выключения поля
        const checkboxContainer = document.createElement('div');
        checkboxContainer.className = 'violation-field-toggle';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `${violation.id}-${fieldName}`;
        checkbox.checked = violation[fieldName].enabled;
        checkbox.disabled = isReadOnly;

        // В режиме просмотра чекбокс заблокирован, мутирующий слушатель не вешаем.
        // Уже включённые секции остаются раскрытыми (display ниже) для чтения.
        if (!isReadOnly) {
            checkbox.addEventListener('change', () => {
                this.setViolationField(violation, `${fieldName}.enabled`, checkbox.checked);
                contentContainer.style.display = checkbox.checked ? 'block' : 'none';
            });
        }

        const checkboxLabel = document.createElement('label');
        checkboxLabel.htmlFor = checkbox.id;
        checkboxLabel.textContent = label;
        checkboxLabel.className = 'violation-field-label';

        checkboxContainer.appendChild(checkbox);
        checkboxContainer.appendChild(checkboxLabel);
        fieldContainer.appendChild(checkboxContainer);

        // Контейнер для содержимого поля
        const contentContainer = document.createElement('div');
        contentContainer.className = 'violation-field-content';
        contentContainer.style.display = violation[fieldName].enabled ? 'block' : 'none';

        // Создаем либо список, либо текстовое поле
        if (type === 'list') {
            const listContainer = document.createElement('div');
            listContainer.className = 'violation-list-container';

            const addButton = document.createElement('button');
            addButton.className = 'violation-list-add-btn';
            addButton.textContent = '+ Добавить пункт';
            addButton.disabled = isReadOnly;

            if (!isReadOnly) {
                addButton.addEventListener('click', () => {
                    if (this.addViolationListItem(violation, fieldName)) {
                        // Список пере-рендеривается целиком — снимаем контроллер с
                        // активного rich-поля ЭТОГО нарушения ПЕРЕД пере-рендером,
                        // иначе после innerHTML='' он держал бы detached-хост со
                        // слушателями (зеркало createViolationElement).
                        this._teardownActiveRichField(violation.id);
                        this.renderList(listContainer, violation, fieldName, isReadOnly);
                    }
                });
            }

            contentContainer.appendChild(addButton);
            contentContainer.appendChild(listContainer);
            this.renderList(listContainer, violation, fieldName, isReadOnly);

        } else if (type === 'text') {
            // Опциональное текстовое поле (reasons/measures/consequences/
            // responsible) — rich-поле (contenteditable), путь `${fieldName}.content`.
            const field = this._createRichFieldEditor(
                this._makeViolationSurface(violation, `${fieldName}.content`),
                { placeholder: label ? `Введите ${label.toLowerCase()}...` : '...', isReadOnly },
            );
            contentContainer.appendChild(field);
        }

        fieldContainer.appendChild(contentContainer);
        return fieldContainer;
    }

    /**
     * Отрисовывает маркированный список элементов. Пункт — rich-поле
     * (Task 7, contenteditable через _createRichFieldEditor), как остальные
     * текстовые поля нарушения; write-through в модель ведёт EditorController
     * (commit на input), Escape в rich-поле = blur (ревёрта нет — как во
     * всех rich-полях, паритет с case/freeText/caption).
     * @param {HTMLElement} container - Контейнер для списка
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldName - Имя поля со списком
     */
    renderList(container, violation, fieldName, isReadOnly = false) {
        container.innerHTML = '';

        violation[fieldName].items.forEach((item, index) => {
            const itemContainer = document.createElement('div');
            itemContainer.className = 'violation-list-item';
            // Подсветка пустого пункта (#9-Г, Wave 2): не блокирует ввод, только
            // визуальный сигнал. Единый предикат с live-тумблером ниже (#12/V24)
            // — toggleEmptyClass (violation-field-empty.js). String(...) —
            // страховка от не-строкового элемента ([null]/число из легаси/битого
            // акта): нормализатор дозаполняет ключи, но не приводит типы внутри
            // items, иначе isFieldEmpty получил бы не-строку и рендер карточки
            // мог упасть.
            toggleEmptyClass(itemContainer, 'violation-list-item--empty', String(item));

            const field = this._createRichFieldEditor(
                this._makeViolationListItemSurface(violation, fieldName, index),
                { placeholder: `Пункт ${index + 1}`, isReadOnly },
            );
            field.classList.add('violation-textarea--compact');

            if (!isReadOnly) {
                // Живая подсветка пустоты (#9-Г) — только визуальный класс, без
                // записи модели (её ведёт write-through контроллера через commit,
                // зеркало createCaseElement/createFreeTextElement).
                field.addEventListener('input', () => {
                    toggleEmptyClass(itemContainer, 'violation-list-item--empty', field);
                });
            }

            // Кнопка удаления элемента списка
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'violation-list-delete-btn';
            deleteBtn.textContent = '×';
            deleteBtn.disabled = isReadOnly;

            if (!isReadOnly) {
                deleteBtn.addEventListener('click', () => {
                    // Teardown ПЕРЕД removeViolationListItem (splice), не после
                    // (ревью Issue 1): unmount коммитит смонтированную поверхность
                    // БЕЗУСЛОВНО, а ViolationListItemSurface адресует по индексу —
                    // если смонтирован более ПОЗДНИЙ пункт этого же нарушения
                    // (фокус на нём не снят), commit ДО splice пишет по его
                    // текущему (ещё валидному) индексу; commit ПОСЛЕ splice попал
                    // бы по устаревшему индексу в уже сдвинутый массив (фантомный
                    // дубль / перезапись чужого пункта). Зеркало createViolationElement
                    // (:141) — teardown строго до мутации/пересборки.
                    this._teardownActiveRichField(violation.id);
                    if (this.removeViolationListItem(violation, fieldName, index)) {
                        this.renderList(container, violation, fieldName, isReadOnly);
                    }
                });
            }

            itemContainer.appendChild(field);
            itemContainer.appendChild(deleteBtn);
            container.appendChild(itemContainer);
        });
    }
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.ViolationManager = ViolationManager;
