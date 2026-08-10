/**
 * Управление нарушениями в документе
 * Создает и обрабатывает интерактивные формы для ввода нарушений
 */
import { PreviewManager } from '../preview/preview.js';
import { RENDER_CLASSES } from '../render-classes.js';
import { AppConfig } from '../../shared/app-config.js';
import { AppState } from '../state/state-core.js';
import { EscapeStack } from '../../shared/escape-stack.js';
import { isEditableTarget } from '../../shared/editable-target.js';
import { Notifications } from '../../shared/notifications.js';
import { FormalizerPopover } from '../text-actions/formalizer-popover.js';
import { plainToRichHtml } from '../../shared/html-text.js';
import { VIOLATION_FIELDS, getOrderedFieldKeys } from './violation-fields.js';
import { createTextBlock } from './violation-block-types.js';
import { openFieldOrderDialog } from './violation-field-order-dialog.js';
import { loadImageLimits } from './violation-image-validator.js';

/** Дескриптор поля по ключу — реестр закрыт, карту строим один раз. */
const FIELD_BY_KEY = new Map(VIOLATION_FIELDS.map(f => [f.key, f]));

/**
 * Поля, которые заполняет формализатор (контракт FormalizeResponse — шесть
 * строк). CodeMining/ProcessMining он не трогает (спека §3.5).
 */
const FORMALIZED_FIELD_KEYS = [
    'violated', 'established', 'reasons', 'measures', 'consequences', 'responsible',
];

/**
 * Пересоздаёт секцию нарушения существующим путём обновления (ItemsRenderer
 * держит DOM-индекс, прямая замена узла оставила бы в нём висячую ссылку).
 *
 * Обращение через window-глобал, а НЕ через import: items-renderer.js стоит
 * НАД графом нарушений — он импортирует violationManager (violation-init.js),
 * и обратный статический импорт добавил бы ещё одно ребро цикла в и без того
 * закольцованный граф (violation-core → preview → state-core →
 * storage-manager → items-renderer → violation-init). Тот же приём, что у
 * context-menu-violation.js с глобальным violationManager.
 *
 * @param {string} violationId
 */
function rerenderViolationSection(violationId) {
    window.ItemsRenderer?.updateViolation?.(violationId);
}

// Предикат «цель — редактируемое поле» общий с глобальными хоткеями Ctrl+Z /
// Ctrl+C/Ctrl+V (shared/editable-target.js): раньше у каждой подсистемы была
// своя копия, и они разошлись. Ре-экспорт — потому что потребитель графа
// нарушений (violation-paste.js, #19) импортирует предикат отсюда: hub-модуль
// остаётся его точкой входа, обратный импорт core → paste замкнул бы цикл.
export { isEditableTarget };

export class ViolationManager {
    constructor() {
        this.selectedViolation = null;
        // Переменная для отслеживания последней позиции при drag
        this.lastDragOverIndex = null;
        // Хранилище активных violation для быстрого доступа.
        // Запись добавляется в createViolationElement; удаляется через
        // removeViolation при разрушении узла дерева — без этого Map рос
        // бесконтрольно при switch'е между актами / удалении нарушений.
        this.activeViolations = new Map();
        // AbortController'ы document-слушателей drop по violation.id
        // (см. setupFileDragAndDrop): abort при повторной установке поля,
        // удалении нарушения и destroy() — иначе слушатели копились
        // на каждый ре-рендер контейнера блоков.
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
     * Активирует зону вставки (мышь внутри контейнера блоков поля) и
     * регистрирует сброс зоны по ESC через EscapeStack — вместо прежнего
     * собственного document-listener'а в обход стека.
     * Идемпотентен: повторная активация не плодит хэндлеры.
     * @param {HTMLElement} container - Контейнер содержимого поля
     */
    _setActiveZone(container) {
        this.currentActiveContainer = container;
        if (!this._escapeZoneUnsub) {
            this._escapeZoneUnsub = EscapeStack.push(() => {
                // §5.9: смысл ESC определяет ФОКУС, а не положение мыши. Каретка
                // в редактируемом поле — событие принадлежит редактору (blur поля
                // или отмена inline-правки капсулы): отказываемся от него
                // сентинелом EscapeStack.PASS, и стек отдаёт ESC слоям ниже, а
                // если отказались все — редактору. Иначе один и тот же ESC
                // означал бы разное в зависимости от того, где висит мышь.
                // Сброс зоны — только когда фокус вне поля, а мышь в зоне.
                if (isEditableTarget(document.activeElement)) return EscapeStack.PASS;
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
        // Зон приёма файлов у карточки десять (по одной на поле) — ключ
        // контроллера составной `<violationId>:<fieldKey>`, снимаем все.
        for (const [key, controller] of [...this._fileDropControllers]) {
            if (key.startsWith(`${violationId}:`)) {
                controller.abort();
                this._fileDropControllers.delete(key);
            }
        }

        // #23: активная зона вставки принадлежала удаляемому нарушению — сбрасываем
        // её (иначе paste/ESC работали бы с зоной уже несуществующего нарушения).
        const owner = this.currentActiveContainer?.querySelector?.('.violation-blocks-items')
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
     * Создаёт элемент нарушения: цикл по полям реестра в текущем порядке
     * (fieldOrder либо стандартный), каждое поле — одинаковая секция блоков
     * (createBlocksField, violation-blocks.js). Двухколоночной вёрстки
     * «Нарушено/Установлено» больше нет — все десять полей идут вертикально.
     *
     * @param {Object} violation - Объект нарушения (10 полей {enabled, blocks})
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

        // Регистрируем violation в хранилище для быстрого доступа (paste по фокусу).
        this.activeViolations.set(violation.id, violation);

        // Лимиты картинок подтягиваются один раз заранее (fire-and-forget):
        // к моменту приёма первого файла валидатор уже знает серверные значения.
        loadImageLimits();

        const section = document.createElement('div');
        section.className = RENDER_CLASSES.VIOLATION_SECTION;
        section.dataset.violationId = violation.id;

        const fieldsContainer = document.createElement('div');
        fieldsContainer.className = 'violation-fields';

        for (const key of getOrderedFieldKeys(violation)) {
            const descriptor = FIELD_BY_KEY.get(key);
            if (!descriptor) continue;
            fieldsContainer.appendChild(
                this.createBlocksField(violation, descriptor, isReadOnly));
        }

        section.appendChild(fieldsContainer);

        // Бар действий над карточкой (не в RO): формализатор + порядок полей.
        if (!isReadOnly) {
            // Номер пункта нарушения — это номер РОДИТЕЛЬСКОГО пункта (у самого
            // violation-узла number вида «Нарушение N», не «5.x»).
            const pointNumber = AppState.findParentNode(node?.id)?.number || '';
            this._addViolationToolbar(section, violation, pointNumber);
        }

        return section;
    }

    /**
     * Бар действий вверху секции нарушения: «Формализовать из текста»
     * (раскладка свободного текста по полям) и «Порядок полей» (модалка
     * перестановки полей карточки).
     *
     * @param {HTMLElement} section - Секция нарушения
     * @param {Object} violation - Объект нарушения
     * @param {string} pointNumber - Номер пункта (для заголовка панели)
     */
    _addViolationToolbar(section, violation, pointNumber) {
        const bar = document.createElement('div');
        bar.className = 'violation-formalize-bar';

        const formalizeBtn = document.createElement('button');
        formalizeBtn.type = 'button';
        formalizeBtn.className = 'violation-formalize-btn';
        formalizeBtn.textContent = '✨ Формализовать из текста';
        formalizeBtn.title = 'Разложить свободный текст нарушения по полям карточки';
        formalizeBtn.addEventListener('click', () => {
            FormalizerPopover.open({
                violation,
                pointNumber,
                apply: (fields) => this._applyFormalized(violation, fields),
            });
        });

        const orderBtn = document.createElement('button');
        orderBtn.type = 'button';
        orderBtn.className = 'violation-formalize-btn violation-field-order-btn';
        orderBtn.textContent = '↕️ Порядок полей';
        orderBtn.title = 'Изменить порядок полей нарушения в акте';
        orderBtn.addEventListener('click', () => {
            openFieldOrderDialog({
                violation,
                manager: this,
                // Порядок полей меняет вёрстку карточки целиком — пересоздаём
                // секцию существующим путём обновления (индекс DOM внутри).
                onApplied: () => rerenderViolationSection(violation.id),
            });
        });

        bar.appendChild(formalizeBtn);
        bar.appendChild(orderBtn);
        section.insertBefore(bar, section.firstChild);
    }

    /**
     * Раскладывает ответ формализатора по полям карточки: каждое непустое
     * значение уходит НОВЫМ текст-блоком в конец своего поля (существующие
     * блоки не перезаписываются), поле при этом включается.
     *
     * Значение может прийти готовым HTML (формализатор отдаёт списки
     * `<ul><li>…</li></ul>`, спека §3.5) — тогда берём как есть; плоскую
     * строку переводим в rich HTML (экранирование + перенос строки в `<br>`).
     *
     * @param {Object} violation - Объект нарушения
     * @param {Object} fields - Ответ формализатора (шесть строковых полей)
     */
    _applyFormalized(violation, fields) {
        let applied = false;

        for (const key of FORMALIZED_FIELD_KEYS) {
            const value = (fields?.[key] || '').trim();
            if (!value) continue;   // не извлечено — поле не трогаем

            // Включаем поле (у mandatory-полей мутатор и так держит enabled).
            this.setFieldEnabled(violation, key, true);

            const html = value.includes('<') ? value : plainToRichHtml(value);
            if (this.addBlock(violation, key, createTextBlock(html))) {
                applied = true;
            }
        }

        if (!applied) return;

        // Секция пересобирается целиком: у полей могли смениться и состав
        // блоков, и состояние чекбокса.
        rerenderViolationSection(violation.id);
        PreviewManager.updateBlock('violation', violation.id);
    }
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.ViolationManager = ViolationManager;
