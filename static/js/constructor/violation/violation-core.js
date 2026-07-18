/**
 * Управление нарушениями в документе
 * Создает и обрабатывает интерактивные формы для ввода нарушений
 */
import { PreviewManager } from '../preview/preview.js';
import { RENDER_CLASSES } from '../render-classes.js';
import { renderActContent, SafeHTML } from '../../shared/sanitize.js';
import { AppConfig } from '../../shared/app-config.js';
import { AppState } from '../state/state-core.js';
import { EscapeStack } from '../../shared/escape-stack.js';
import { Notifications } from '../../shared/notifications.js';
import { FormalizerPopover } from '../text-actions/formalizer-popover.js';

/**
 * Адаптер записи формализатора: переводит ПЛОСКУЮ строку LLM в rich HTML —
 * экранирует спецсимволы и переносы `\n` → `<br>` (зеркало `_insertCorrected`
 * в corrector-popover.js). Без этого `\n` не отрисовался бы, а `&`/`<` из
 * текста LLM попали бы в rich-модель как невалидный HTML.
 * @param {string} v - Плоское значение поля от формализатора
 * @returns {string} HTML для setViolationField/renderActContent
 */
function plainToRichHtml(v) {
    return SafeHTML.escapeHtml(v).replace(/\n/g, '<br>');
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
        const setPlain = (name, fieldDiv, value) => {
            const v = (value || '').trim();
            if (!v) return;                 // не извлечено — не затираем существующее
            // Плоская строка LLM → rich HTML (экранирование + \n → <br>) ДО записи.
            const html = plainToRichHtml(v);
            // Запись только через setViolationField — единственную защищённую точку
            // (requireWrite-guard + превью); прямая запись миновала бы её.
            this.setViolationField(violation, name, html);
            // Модель → rich-поле (contenteditable): renderActContent, не .value.
            if (fieldDiv) renderActContent(fieldDiv, html);
        };
        const setOptional = (name, container, value) => {
            const v = (value || '').trim();
            if (!v) return;
            const html = plainToRichHtml(v);
            this.setViolationField(violation, `${name}.enabled`, true);
            this.setViolationField(violation, `${name}.content`, html);
            const cb = container?.querySelector('.violation-field-toggle input[type="checkbox"]');
            const content = container?.querySelector('.violation-field-content');
            const fieldDiv = container?.querySelector('.violation-field-content .violation-field');
            if (cb) cb.checked = true;
            if (content) content.style.display = 'block';
            if (fieldDiv) renderActContent(fieldDiv, html);
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
     * Настраивает обработчики событий для текстового поля с поддержкой отмены.
     * Применяется ко всем текстовым полям формы нарушения: «Нарушено»/
     * «Установлено», кейсы/свободный текст (textarea) и подпись картинки
     * (однострочный input).
     *
     * @param {HTMLTextAreaElement|HTMLInputElement} field - Поле ввода
     * @param {Function} onUpdate - Callback обновления данных (значение)
     * @param {boolean} [multiline=true] - true для textarea (Shift+Enter — новая
     *   строка); false для однострочного input (любой Enter сохраняет и снимает
     *   фокус, Shift+Enter для него бессмыслен)
     */
    setupTextareaHandlers(field, onUpdate, multiline = true) {
        let originalValue = field.value;

        // Обновляем данные при каждом изменении
        const handleInput = () => {
            onUpdate(field.value);
        };

        // Обработка горячих клавиш
        const handleKeyDown = (e) => {
            if (e.key === 'Enter' && multiline && e.shiftKey) {
                // Shift+Enter в textarea — добавить новую строку (стандартное поведение)
                e.stopPropagation();
            } else if (e.key === 'Enter') {
                // Enter — сохранить изменения и снять фокус. Для однострочного
                // input сюда попадает любой Enter (в т.ч. с Shift).
                e.preventDefault();
                field.blur();
            } else if (e.key === 'Escape') {
                // Escape — отменить изменения и восстановить исходное значение.
                // onUpdate зовём ТОЛЬКО при реальном изменении, иначе Escape в
                // нетронутом поле поднимал бы ложный markAsUnsaved и ложную
                // запись аудита (#18-В).
                e.preventDefault();
                e.stopPropagation();
                if (field.value !== originalValue) {
                    field.value = originalValue;
                    onUpdate(originalValue);
                }
                field.blur();
            }
        };

        // Запоминаем исходное значение при получении фокуса
        const handleFocus = () => {
            originalValue = field.value;
        };

        field.addEventListener('input', handleInput);
        field.addEventListener('keydown', handleKeyDown);
        field.addEventListener('focus', handleFocus);
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
     * Отрисовывает маркированный список элементов
     * @param {HTMLElement} container - Контейнер для списка
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldName - Имя поля со списком
     */
    renderList(container, violation, fieldName, isReadOnly = false) {
        container.innerHTML = '';

        violation[fieldName].items.forEach((item, index) => {
            const itemContainer = document.createElement('div');
            itemContainer.className = 'violation-list-item';
            // Подсветка пустого пункта (#9-Г, Wave 2): не блокирует ввод, только визуальный сигнал.
            // String(...) — страховка от не-строкового элемента ([null]/число из
            // легаси/битого акта): нормализатор дозаполняет ключи, но не приводит
            // типы внутри items, иначе .trim() кинул бы TypeError и уронил рендер карточки.
            itemContainer.classList.toggle('violation-list-item--empty', !String(item).trim());

            const input = document.createElement('input');
            input.type = 'text';
            input.className = RENDER_CLASSES.VIOLATION_LIST_INPUT;
            input.value = item;
            input.placeholder = `Пункт ${index + 1}`;

            if (isReadOnly) {
                input.readOnly = true;
                input.classList.add('read-only');
            } else {
                let originalValue = item;

                // Обновляем массив при вводе
                input.addEventListener('input', () => {
                    this.setViolationListItem(violation, fieldName, index, input.value);
                    itemContainer.classList.toggle('violation-list-item--empty', !input.value.trim());
                });

                // Обработка горячих клавиш для элементов списка
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        // Enter — сохранить и снять фокус
                        e.preventDefault();
                        input.blur();
                    } else if (e.key === 'Escape') {
                        // Escape — отменить изменения
                        e.preventDefault();
                        input.value = originalValue;
                        violation[fieldName].items[index] = originalValue;
                        itemContainer.classList.toggle('violation-list-item--empty', !String(originalValue).trim());
                        input.blur();
                        PreviewManager.updateBlock('violation', violation.id);
                    }
                });

                // Запоминаем исходное значение
                input.addEventListener('focus', () => {
                    originalValue = input.value;
                });
            }

            // Кнопка удаления элемента списка
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'violation-list-delete-btn';
            deleteBtn.textContent = '×';
            deleteBtn.disabled = isReadOnly;

            if (!isReadOnly) {
                deleteBtn.addEventListener('click', () => {
                    if (this.removeViolationListItem(violation, fieldName, index)) {
                        this.renderList(container, violation, fieldName, isReadOnly);
                    }
                });
            }

            itemContainer.appendChild(input);
            itemContainer.appendChild(deleteBtn);
            container.appendChild(itemContainer);
        });
    }
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.ViolationManager = ViolationManager;
