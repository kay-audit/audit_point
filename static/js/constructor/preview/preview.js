/**
 * Менеджер предпросмотра документа
 *
 * Отвечает за рендеринг финальной версии акта в панели предпросмотра.
 * Обрабатывает различные типы контента: таблицы, текстовые блоки,
 * нарушения и древовидную структуру с учетом вложенности.
 */
import { decideBlockPatch } from './preview-block-routing.js';
import { PreviewTableRenderer } from './preview-table-renderer.js';
import { PreviewTextBlockRenderer } from './preview-textblock-renderer.js';
import { PreviewViolationRenderer } from './preview-violation-renderer.js';
import { PreviewCoverRenderer } from './preview-cover-renderer.js';
import { PreviewSignatureRenderer } from './preview-signature-renderer.js';
import { AppState, _unwrap } from '../state/state-core.js';
import { AppConfig } from '../../shared/app-config.js';
import { invalidateTableWarningsCache, getCachedTableWarnings } from '../header/notifications-source-tables.js';
import { PreviewFitScaler } from './preview-fit.js';
import { shouldShowTableTitle, tableTitleText, tableTitleUnderlined } from '../table/table-title.js';

export class PreviewManager {
    /**
     * Флаг запланированного RAF-обновления (дедупликация в пределах одного кадра).
     * @private
     */
    static _pendingUpdate = false;

    /**
     * Единый скейлер fit-to-width для inline-панели предпросмотра (#preview).
     * Лениво создаётся в _performUpdate. У модального меню — свой экземпляр.
     * @private
     */
    static _fitScaler = null;

    /**
     * Индекс блоков inline-превью: 'table:id' | 'textblock:id' | 'violation:id'
     * → DOM-элемент блока. Заполняется при полном рендере в #preview
     * (модальное меню индекс не трогает), используется updateBlock для
     * точечной замены одного блока без полной пересборки.
     * @private
     * @type {Map<string, HTMLElement>}
     */
    static _blockIndex = new Map();

    /**
     * Накопитель ключей блоков, ожидающих точечного обновления (RAF-дедуп).
     * @private
     */
    static _pendingBlocks = new Set();
    static _blockRafPending = false;

    /**
     * Обновляет содержимое панели предпросмотра.
     * Дедуплицирует подряд идущие вызовы в пределах одного animation frame:
     * на N вызовов выполнится ровно один _performUpdate.
     */
    static update() {
        if (this._pendingUpdate) {
            // Подряд идущий вызов в том же кадре — выходим, существующий RAF
            // выполнит обновление.
            return;
        }

        this._pendingUpdate = true;

        requestAnimationFrame(() => {
            this._pendingUpdate = false;
            // Сбрасываем кеш замечаний ДО рендера: _applyTableOutlines (рамки) и
            // collectTableItems (колокольчик) пересчитают снимок один раз и
            // переиспользуют его. Инвалидация здесь, а не на content-changed,
            // потому что событие летит ПОСЛЕ outlines — иначе рамки читали бы
            // устаревший кеш.
            invalidateTableWarningsCache();
            this._performUpdate();
            this._emitContentChanged();
        });
    }

    /** @private Уведомляет подписчиков (колокольчик) об изменении содержимого. */
    static _emitContentChanged() {
        if (typeof document !== 'undefined') {
            document.dispatchEvent(new CustomEvent('preview:content-changed'));
        }
    }

    /**
     * Текущий tooltip в предпросмотре
     * @private
     */
    static _previewTooltip = null;
    static _previewTooltipTimeout = null;

    /**
     * Debounce-таймер для typing-flow (textblock/violation input).
     * @private
     */
    static _typingTimer = null;
    static _TYPING_DEBOUNCE_MS = 150;

    /**
     * Планирует обновление предпросмотра с debounce 150 мс.
     * Используется в typing-handler'ах (textblock-editor, violation textarea),
     * чтобы серия input-событий не запускала рендер на каждый кадр.
     *
     * @param {Object|string} options - Настройки отображения
     */
    static scheduleTyping(options = {}) {
        clearTimeout(this._typingTimer);
        this._typingTimer = setTimeout(() => {
            this._typingTimer = null;
            this.update(options);
        }, this._TYPING_DEBOUNCE_MS);
    }

    /**
     * Накопитель блоков typing-flow: до срабатывания debounce-таймера блоки
     * копятся, флаш обновляет ВСЕ накопленные (иначе быстрый переход между
     * полями разных блоков терял бы обновление первого).
     * @private
     */
    static _typingBlocks = new Set();

    /**
     * Планирует ТОЧЕЧНОЕ обновление одного блока превью с debounce 150 мс —
     * блочный аналог scheduleTyping для контентных правок (ввод в ячейку,
     * текстблок, поля нарушения).
     * @param {string} kind - Тип блока ('table' | 'textblock' | 'violation')
     * @param {string} id - ID блока в словаре состояния
     */
    static scheduleTypingBlock(kind, id) {
        this._typingBlocks.add(`${kind}:${id}`);
        clearTimeout(this._typingTimer);
        this._typingTimer = setTimeout(() => {
            this._typingTimer = null;
            const keys = [...this._typingBlocks];
            this._typingBlocks.clear();
            for (const key of keys) {
                const sep = key.indexOf(':');
                this.updateBlock(key.slice(0, sep), key.slice(sep + 1));
            }
        }, this._TYPING_DEBOUNCE_MS);
    }

    /**
     * Точечное обновление ОДНОГО блока превью (контентная правка): замена
     * элемента блока по индексу без полной пересборки листа. Структурные
     * операции (add/delete/move/rename/каскад) по-прежнему идут через update().
     *
     * RAF-дедуп: подряд идущие вызовы в одном кадре накапливаются и
     * выполняются одним флашем. Промах индекса / появление-исчезновение
     * блока — fallback на полный update().
     *
     * @param {string} kind - Тип блока ('table' | 'textblock' | 'violation')
     * @param {string} id - ID блока в словаре состояния
     */
    static updateBlock(kind, id) {
        if (!kind || id == null) return this.update();

        this._pendingBlocks.add(`${kind}:${id}`);
        if (this._blockRafPending) return;
        this._blockRafPending = true;

        requestAnimationFrame(() => {
            this._blockRafPending = false;
            const keys = [...this._pendingBlocks];
            this._pendingBlocks.clear();

            // Параллельно запланирован полный рендер — он перекроет блочные патчи.
            if (this._pendingUpdate) return;

            // Замечания таблиц зависят ИСКЛЮЧИТЕЛЬНО от AppState.tables, поэтому
            // правки текстблоков/нарушений не могут изменить рамки таблиц и
            // колокольчик — инвалидируем кеш и перекрашиваем рамки только когда
            // в пачке есть правка таблицы (ключи формата `${kind}:${id}`).
            const hasTableEdit = keys.some(k => k.startsWith('table:'));

            // Кеш замечаний инвалидируется ДО патча (state уже изменён):
            // рамки и колокольчик пересчитают свежий снимок.
            if (hasTableEdit) invalidateTableWarningsCache();

            for (const key of keys) {
                if (!this._patchBlock(key)) {
                    // Fallback: сложный случай — полная пересборка (внутри —
                    // своя инвалидация кеша и emit).
                    this.update();
                    return;
                }
            }

            const sheet = document.querySelector('#preview .preview-sheet');
            if (hasTableEdit && sheet) {
                this._applyTableOutlines(sheet);
            }
            // B-10: добавление/удаление сноски в блоке сдвигает сквозную
            // нумерацию — пере-нумеровать весь лист (атрибут рантайм-only).
            if (sheet) window.numberFootnotes?.(sheet);
            this._emitContentChanged();
        });
    }

    /**
     * Выполняет точечную замену элемента блока по ключу индекса.
     * @private
     * @param {string} key - Ключ вида 'kind:id'
     * @returns {boolean} true — патч выполнен (или DOM не требует правки),
     *   false — нужен полный рендер
     */
    static _patchBlock(key) {
        const sep = key.indexOf(':');
        const kind = key.slice(0, sep);
        const id = key.slice(sep + 1);
        const el = this._blockIndex.get(key);
        const hasElement = !!el && el.isConnected;

        if (kind === 'table') {
            const table = _unwrap(AppState.tables)[id];
            if (decideBlockPatch(kind, {hasElement, hasData: !!table}) !== 'patch') return false;
            const fresh = PreviewTableRenderer.create(table, { tableId: id });
            el.replaceWith(fresh);
            this._blockIndex.set(key, fresh);
            return true;
        }

        if (kind === 'textblock') {
            const block = _unwrap(AppState.textBlocks)[id];
            const decision = decideBlockPatch(kind, {
                hasElement,
                hasData: !!block,
                hasContent: !!this._hasContent(block),
            });
            if (decision === 'skip') return true;
            if (decision !== 'patch') return false;
            const fresh = PreviewTextBlockRenderer.create(block);
            el.replaceWith(fresh);
            this._blockIndex.set(key, fresh);
            this._attachPreviewTooltips(fresh);
            return true;
        }

        if (kind === 'violation') {
            const violation = _unwrap(AppState.violations)[id];
            if (decideBlockPatch(kind, {hasElement, hasData: !!violation}) !== 'patch') return false;
            const fresh = PreviewViolationRenderer.create(violation);
            el.replaceWith(fresh);
            this._blockIndex.set(key, fresh);
            this._attachPreviewTooltips(fresh);
            return true;
        }

        return false;
    }

    /**
     * Выполняет обновление предпросмотра
     * @private
     */
    static _performUpdate() {
        const preview = document.getElementById('preview');
        if (!preview) return;

        this._hidePreviewTooltip();
        preview.innerHTML = '';

        // Единая сборка документа (лист + sizer + индикатор зума) — общая для
        // inline-панели и модального меню, исключает расхождение их рендера.
        // Индекс блоков ведётся ТОЛЬКО для inline-панели (#preview) — точечный
        // updateBlock работает по ней; модальное меню индекс не трогает.
        this._blockIndex.clear();
        this._indexBlocks = true;
        try {
            this.renderDocumentInto(preview);
        } finally {
            this._indexBlocks = false;
        }

        // Fit-to-width: масштабирует лист под ширину панели. attach идемпотентен —
        // на перерендере наблюдаем ту же #preview и просто перепланируем расчёт.
        if (!this._fitScaler) this._fitScaler = new PreviewFitScaler();
        this._fitScaler.attach(preview);
        // Масштаб применяем синхронно, в этом же кадре: лист только что пересобран
        // и до применения не имеет ни transform'а, ни размеров sizer'а. Отложенный
        // на кадр расчёт отрисовал бы промежуточное состояние — пустую панель.
        this._fitScaler.applyNow();
    }

    /**
     * Собирает единую структуру документа предпросмотра в указанный контейнер.
     *
     * ЕДИНЫЙ источник рендера и для inline-панели (#preview), и для модального
     * меню (#previewMenuBody) — благодаря этому оба предпросмотра выглядят
     * идентично (устраняет прежнее расхождение, когда меню строило документ
     * вручную). Структура: sizer-обёртка → лист A4 (.preview-sheet) с заголовком,
     * деревом и tooltip'ами, плюс индикатор зума поверх холста.
     *
     * @param {HTMLElement} container - Холст (#preview или #previewMenuBody).
     * @returns {{sheet: HTMLElement, sizer: HTMLElement, indicator: HTMLElement}}
     */
    static renderDocumentInto(container) {
        // Sizer занимает масштабированный footprint листа (см. preview-fit.js).
        const sizer = document.createElement('div');
        sizer.className = 'preview-sheet-sizer';

        // Белый лист A4 с полями и типографикой Word; масштабируется fit-скейлером.
        const sheet = document.createElement('div');
        sheet.className = 'preview-sheet';

        sizer.appendChild(sheet);
        container.appendChild(sizer);

        this._renderTitle(sheet);
        this._renderTree(sheet);
        this._renderSignature(sheet);
        this._attachPreviewTooltips(sheet);

        // B-10: сквозная нумерация сносок по всему листу (как в Word). Атрибут
        // data-footnote-number — рантайм-only (санитайзер 'acts' его вырезает),
        // поэтому проставляем после каждой полной сборки. window-глобал —
        // во избежание цикла импортов preview ↔ textblock.
        window.numberFootnotes?.(sheet);

        // Цветные рамки проблемных таблиц на листе (источник — те же замечания,
        // что и колокольчик). Внутри renderDocumentInto, поэтому работает и для
        // inline-панели, и для модального меню.
        this._applyTableOutlines(sheet);

        // Индикатор текущего масштаба (обновляется скейлером).
        const indicator = document.createElement('div');
        indicator.className = 'preview-zoom-indicator';
        indicator.textContent = '100%';
        container.appendChild(indicator);

        return { sheet, sizer, indicator };
    }

    /**
     * Навешивает на проблемные таблицы листа цветную рамку по критичности
     * (error→красная, warning→оранжевая). Источник — те же замечания, что и
     * колокольчик. Для одной таблицы error важнее warning.
     * @param {HTMLElement} sheet Контейнер с .preview-table-wrapper[data-table-id].
     */
    static _applyTableOutlines(sheet) {
        // Закешированный снимок замечаний (тот же, что и у колокольчика). Геттер
        // сам глотает исключения сборки и отдаёт [] — отдельный try/catch не нужен.
        const warnings = getCachedTableWarnings();
        const sev = new Map();
        for (const w of warnings) {
            if (w.tableId == null) continue;
            const key = String(w.tableId);
            if (sev.get(key) === 'error') continue;
            sev.set(key, w.severity === 'error' ? 'error' : (sev.get(key) || 'warning'));
        }
        sheet.querySelectorAll('.preview-table-wrapper[data-table-id]').forEach((el) => {
            el.classList.remove('preview-table-wrapper--error', 'preview-table-wrapper--warning');
            const s = sev.get(el.dataset.tableId);
            if (s === 'error') el.classList.add('preview-table-wrapper--error');
            else if (s === 'warning') el.classList.add('preview-table-wrapper--warning');
        });
    }

    /**
     * Рендерит шапку акта (cover-блок) вместо слова «АКТ».
     *
     * Управляется тумблером настроек showActHeader (по умолчанию true). Настройку
     * читаем защищённо: SettingsMenuManager может ещё не подхватить опцию (её
     * добавляет другой модуль) — отсутствие трактуем как «включено».
     *   - настройка включена + есть window.actMetadata → рендерим шапку;
     *   - метаданных нет → мягкая деградация, ничего не выводим (не падаем);
     *   - настройка выключена → не выводим ничего (ни шапки, ни «АКТ»).
     * @private
     * @param {HTMLElement} container - Контейнер для шапки
     */
    static _renderTitle(container) {
        const showHeader = window.SettingsMenuManager?.getSettings?.().showActHeader ?? true;
        if (!showHeader) return;

        const cover = PreviewCoverRenderer.create(window.actMetadata);
        if (cover) container.appendChild(cover);
    }

    /**
     * Рендерит блок подписи в конце листа.
     *
     * В DOCX он печатается всегда (build_signature вызывается из
     * DocxFormatter.format безусловно), поэтому тумблером шапки не
     * управляется. Метаданных нет → мягкая деградация, ничего не выводим.
     * @private
     * @param {HTMLElement} container - Лист, в конец которого встаёт подпись
     */
    static _renderSignature(container) {
        const signature = PreviewSignatureRenderer.create(window.actMetadata);
        if (signature) container.appendChild(signature);
    }

    /**
     * Рендерит дерево структуры документа
     * @private
     * @param {HTMLElement} container - Контейнер для дерева
     */
    static _renderTree(container) {
        // Read-only обход — по raw-дереву (без Proxy get-трапов).
        this.renderNode(_unwrap(AppState.treeData), container, 1);
    }

    /**
     * Рекурсивно рендерит узел дерева и его дочерние элементы
     *
     * @param {Object} node - Узел дерева для рендеринга
     * @param {HTMLElement} container - Контейнер для вставки элементов
     * @param {number} level - Уровень вложенности для размера заголовков
     * @param {string|null} [rootSectionId=null] - ID раздела верхнего уровня,
     *   в поддереве которого идёт рендер (null на корне — раздел открывает
     *   сам ребёнок). Нужен правилу оформления подписи таблиц.
     */
    static renderNode(node, container, level, rootSectionId = null) {
        if (!node.children) return;

        node.children.forEach(child => {
            const renderer = this._getRenderer(child.type);
            // Дети корня — разделы верхнего уровня: каждый открывает свой
            // раздел, который наследует всё его поддерево.
            renderer.call(this, child, container, level, rootSectionId ?? child.id);
        });
    }

    /**
     * Получает функцию-рендерер для типа узла
     * @private
     * @param {string} type - Тип узла
     * @returns {Function} Функция рендеринга
     */
    static _getRenderer(type) {
        const renderers = {
            'table': this._renderTableNode,
            'textblock': this._renderTextBlockNode,
            'violation': this._renderViolationNode
        };

        return renderers[type] || this._renderItemNode;
    }

    /**
     * Рендерит узел таблицы
     * @private
     */
    static _renderTableNode(child, container, level, rootSectionId = null) {
        // Единый с DOM-рендерером и DOCX предикат показа заголовка (render-8).
        if (shouldShowTableTitle(child)) {
            const tableTitle = document.createElement('h4');
            tableTitle.textContent = tableTitleText(child);
            // Оформление — единое правило проекта (table-title.js), само
            // оформление в CSS: модификатор включает подчёркивание.
            tableTitle.className = tableTitleUnderlined(child, rootSectionId)
                ? 'preview-table-title preview-table-title--underline'
                : 'preview-table-title';
            container.appendChild(tableTitle);
        }

        // Read-only: raw-таблица (рендерер ячеек только читает grid).
        const tableData = _unwrap(AppState.tables)[child.tableId];
        if (tableData) {
            const table = PreviewTableRenderer.create(tableData, { tableId: child.tableId });
            container.appendChild(table);
            if (this._indexBlocks) this._blockIndex.set(`table:${child.tableId}`, table);
        }
    }

    /**
     * Рендерит узел текстового блока
     * @private
     */
    static _renderTextBlockNode(child, container, level) {
        const textBlock = _unwrap(AppState.textBlocks)[child.textBlockId];

        if (this._hasContent(textBlock)) {
            const element = PreviewTextBlockRenderer.create(textBlock);
            container.appendChild(element);
            if (this._indexBlocks) this._blockIndex.set(`textblock:${child.textBlockId}`, element);
        }
    }

    /**
     * Рендерит узел нарушения
     * @private
     */
    static _renderViolationNode(child, container, level) {
        const violation = _unwrap(AppState.violations)[child.violationId];

        if (violation) {
            const element = PreviewViolationRenderer.create(violation);
            container.appendChild(element);
            if (this._indexBlocks) this._blockIndex.set(`violation:${child.violationId}`, element);
        }
    }

    /**
     * Рендерит обычный узел-пункт
     * @private
     */
    static _renderItemNode(child, container, level, rootSectionId = null) {
        this._renderHeading(child, container, level);
        this._renderContent(child, container);

        // Рекурсивная обработка дочерних элементов
        if (child.children?.length > 0) {
            this.renderNode(child, container, level + 1, rootSectionId);
        }
    }

    /**
     * Рендерит заголовок пункта
     *
     * Уровень тега (h2…h4) несёт СТРУКТУРУ документа, а не оформление: кегль и
     * начертание у всех уровней одни (12pt bold, как Sizes.body_pt + run.bold в
     * DOCX::_render_item), их задаёт класс `preview-heading`. Класс обязателен:
     * allowlist санитайзера пропускает h1–h6 внутрь контента текстблока
     * (shared/sanitize.js), а такие «чужие» заголовки Word печатает обычным
     * текстом (_BLOCK_TAGS в docx/builders/inline.py — bold не выставляется).
     * Правило по голому тегу задело бы и их.
     *
     * Раздел верхнего уровня — исключение по СТРУКТУРЕ, а не по оформлению:
     * в Word он печатается плашкой-рубрикатором (таблица 1×2 с заливкой,
     * docx/builders/rubricator.py), поэтому номер и название разъезжаются по
     * двум ячейкам и рендерятся отдельными узлами.
     * @private
     */
    static _renderHeading(child, container, level) {
        if (level === 1) return this._renderRubricatorPlate(child, container);

        const headingLevel = Math.min(level + 1, AppConfig.preview.maxHeadingLevel);
        const heading = document.createElement(`h${headingLevel}`);
        heading.className = 'preview-heading';
        heading.textContent = child.number ? child.number + '. ' + child.label : child.label;
        container.appendChild(heading);
    }

    /**
     * Рендерит плашку-рубрикатор раздела верхнего уровня.
     *
     * Эталон — build_rubricator_plate: таблица 1×2 во всю ширину текста,
     * заливка, рамки, номер в узкой ячейке прижат ВПРАВО и печатается обычным
     * начертанием (жирность метки абзаца там не выставляется, в отличие от
     * пункта в _render_item), название — жирным. Тег остаётся h2: плашка —
     * это по-прежнему заголовок раздела, а `.preview-heading` даёт ей
     * документные кегль, начертание и ритм.
     * @private
     */
    static _renderRubricatorPlate(child, container) {
        const plate = document.createElement('h2');
        plate.className = 'preview-heading preview-rubricator';

        const number = document.createElement('span');
        number.className = 'preview-rubricator-number';
        number.textContent = child.number ? child.number + '.' : '';

        const title = document.createElement('span');
        title.className = 'preview-rubricator-title';
        title.textContent = child.label;

        plate.appendChild(number);
        plate.appendChild(title);
        container.appendChild(plate);
    }

    /**
     * Рендерит содержимое пункта
     * @private
     */
    static _renderContent(child, container) {
        if (!child.content?.trim()) return;

        const contentDiv = document.createElement('div');
        contentDiv.className = 'preview-content';
        // M.5: content пункта выводится полностью (DOCX не обрезает).
        contentDiv.textContent = child.content;
        container.appendChild(contentDiv);
    }

    /**
     * Проверяет наличие содержимого в текстовом блоке
     * @private
     */
    static _hasContent(textBlock) {
        return textBlock?.content?.trim();
    }

    /**
     * Принудительное обновление предпросмотра
     * Используется после загрузки акта или изменения структуры
     */
    static forceUpdate() {
        // Та же инвалидация кеша замечаний перед рендером, что и в update().
        invalidateTableWarningsCache();
        this._performUpdate();
        this._emitContentChanged();
    }

    /**
     * Привязывает обработчики tooltip к ссылкам и сноскам в предпросмотре
     * @private
     * @param {HTMLElement} preview - Контейнер предпросмотра
     */
    static _attachPreviewTooltips(preview) {
        const elements = preview.querySelectorAll('.text-link, .text-footnote');

        elements.forEach(element => {
            element.addEventListener('mouseenter', () => {
                this._previewTooltipTimeout = setTimeout(() => {
                    this._showPreviewTooltip(element);
                }, 700);
            });

            element.addEventListener('mouseleave', () => {
                this._hidePreviewTooltip();
            });
        });
    }

    /**
     * Показывает tooltip для ссылки/сноски в предпросмотре
     * @private
     * @param {HTMLElement} element - Элемент ссылки или сноски
     */
    static _showPreviewTooltip(element) {
        // Guard: элемент мог быть удалён из DOM пока ждали debounce/hover-timeout
        // (например, перерендер preview). Без проверки getBoundingClientRect
        // вернёт нули, tooltip окажется в углу с position:fixed.
        if (!element || !document.body.contains(element)) return;

        this._hidePreviewTooltip();

        const isLink = element.classList.contains('text-link');
        const content = isLink
            ? element.getAttribute('data-link-url')
            : element.getAttribute('data-footnote-text');

        if (!content) return;

        const tooltip = document.createElement('div');
        tooltip.className = 'link-footnote-tooltip';
        tooltip.textContent = content;

        document.body.appendChild(tooltip);

        const rect = element.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();

        let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
        let top = rect.bottom + 8;

        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        if (left + tooltipRect.width > viewportWidth) {
            left = viewportWidth - tooltipRect.width - 10;
        }
        if (left < 10) {
            left = 10;
        }

        if (top + tooltipRect.height > viewportHeight) {
            top = rect.top - tooltipRect.height - 8;
        }

        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;

        this._previewTooltip = tooltip;
    }

    /**
     * Скрывает tooltip в предпросмотре
     * @private
     */
    static _hidePreviewTooltip() {
        if (this._previewTooltip) {
            this._previewTooltip.remove();
            this._previewTooltip = null;
        }
        if (this._previewTooltipTimeout) {
            clearTimeout(this._previewTooltipTimeout);
            this._previewTooltipTimeout = null;
        }
    }
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.PreviewManager = PreviewManager;
