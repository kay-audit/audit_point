/**
 * Плавающая панель «Формализация нарушения».
 *
 * Тот же оконный chrome, что у CorrectorPopover (перетаскивание за заголовок,
 * ресайз, Esc, персист позиции/размера), но другой поток: свободный текст →
 * «Формализовать» → превью извлечённых полей → «Применить» раскладывает их по
 * полям карточки нарушения (что LLM не нашла — поле НЕ трогаем, см. violation-core).
 *
 * Под превью — дисплей-онли рекомендации «чего не хватает» (подсказки аналитику от
 * экстрактора D17). Показываются рядом с превью, но «Применить» их НЕ пишет: в
 * карточку и экспорт не идут, это только ориентир, что доописать во входном тексте.
 * После «Применить» поля уходят в карточку, а окно НЕ закрывается: ввод и превью
 * скрываются, остаётся только блок «чего не хватает», чтобы аналитик держал
 * подсказки перед глазами. Если рекомендаций нет — окно закрывается как раньше.
 *
 * Свободный текст при открытии ПРЕДЗАПОЛНЯЕТСЯ содержимым уже заполненных полей
 * карточки (`_gatherSource`) — чтобы формализовать/переформализовать имеющееся, а
 * не набирать заново. Это чтение: ячейки карточки НЕ очищаются, перезапись только
 * по «Применить». Собираем плоским текстом без ярлыков полей: формализатор сам
 * раскладывает норм-документ/суть/причины, а ярлыки «Нарушено/Установлено» сбили
 * бы его (у него своя раскладка norm_doc→«Нарушено», суть→«Установлено»).
 *
 * Открывается кнопкой на панели нарушения; заголовок содержит реальный номер
 * пункта нарушения (`по пункту 5.x`). Применение делает callback `apply(fields)`,
 * который знает, как обновить объект нарушения и его DOM-контролы.
 */
import { Notifications } from '../../shared/notifications.js';
import { EscapeStack } from '../../shared/escape-stack.js';
import { makeResizablePanel } from '../../shared/resizable-panel.js';
import { makeDraggablePanel } from '../../shared/draggable-panel.js';
import { serializeVisibleText } from '../../shared/rich-text.js';
import { SafeHTML } from '../../shared/sanitize.js';
import { formalizeViolation } from './text-actions-client.js';
import { getOrderedFieldKeys } from '../violation/violation-fields.js';
import { BLOCK_TYPES } from '../violation/violation-block-types.js';

/**
 * Сериализует сетку блока-таблицы в компактную markdown-сетку для LLM:
 * `| a | b |` построчно, разделитель после первой строки (шапки). Ячейки —
 * plain-текст (инвариант B8), pipe экранируется, переносы схлопываются в
 * пробел. Пустая/вырожденная сетка → ''. Чистая функция — тест-шов.
 * @param {Object} table - Сетка блока ({grid, colWidths})
 * @returns {string}
 */
export function tableToMarkdown(table) {
    const grid = table?.grid;
    if (!Array.isArray(grid) || grid.length === 0) return '';
    const rows = [];
    for (const row of grid) {
        if (!Array.isArray(row) || row.length === 0) continue;
        const cells = row.map((cell) => String(cell?.content ?? '')
            .replace(/\|/g, '\\|')
            .replace(/\s+/g, ' ')
            .trim());
        rows.push(`| ${cells.join(' | ')} |`);
        if (rows.length === 1) {
            rows.push(`|${' --- |'.repeat(row.length)}`);
        }
    }
    // Таблица без единого непустого символа в ячейках — не шлём LLM рамку.
    const hasContent = rows.some((line) => /[^|\s\\-]/.test(line));
    return hasContent ? rows.join('\n') : '';
}

// Поля превью в порядке карточки (Принятые меры — под Причинами, как в форме).
const _PREVIEW_FIELDS = [
    ['violated', 'Нарушено'],
    ['established', 'Установлено'],
    ['reasons', 'Причины'],
    ['measures', 'Принятые меры'],
    ['consequences', 'Последствия'],
    ['responsible', 'Ответственные'],
];

export const FormalizerPopover = {
    _el: null,
    _els: null,
    _resizer: null,
    _dragger: null,
    _escUnsub: null,
    _controller: null,
    _apply: null,
    _fields: null,

    /**
     * @param {{violation: Object, apply: (fields: Object) => void,
     *          pointNumber?: string}} opts
     */
    open({ violation, apply, pointNumber }) {
        this._build();
        this._apply = apply;
        this._fields = null;
        // Предзаполняем свободный текст собранными полями карточки (если заполнены).
        this._els.source.value = this._gatherSource(violation);
        this._els.preview.innerHTML = '';
        this._clearRecommendations();
        this._els.accept.disabled = true;
        // Сброс возможного пост-применения из прошлого открытия.
        this._el.classList.remove('formalizer-applied');
        this._els.reject.textContent = 'Отмена';
        const suffix = pointNumber ? ` по пункту ${pointNumber}` : '';
        this._els.title.textContent = `✨ Корректор отклонения/проблемы${suffix}`;
        this._el.classList.remove('hidden');
        if (!this._escUnsub) this._escUnsub = EscapeStack.push(() => this.close());
        this._els.source.focus();
    },

    /**
     * Собирает свободный текст нарушения из уже заполненных полей карточки для
     * (пере)формализации — блочная модель. Порядок — как в карточке
     * (getOrderedFieldKeys: fieldOrder нарушения либо стандартный); поля берём
     * только включённые. Внутри поля: text-блок — видимый текст content;
     * image-блок — видимый текст caption (base64-картинка LLM бесполезна);
     * table-блок — компактная markdown-сетка (tableToMarkdown). Rich HTML
     * проходит через `this._richToPlain` (адаптер чтения rich→plain), иначе в
     * тексте для LLM оказались бы HTML-теги. Плоский текст без ярлыков полей
     * (формализатор раскладывает сам). Чтение: карточку НЕ меняет.
     * @param {Object} violation
     * @returns {string}
     */
    _gatherSource(violation) {
        if (!violation) return '';
        const parts = [];
        const pushText = (html) => { const t = this._richToPlain(html || '').trim(); if (t) parts.push(t); };
        for (const key of getOrderedFieldKeys(violation)) {
            const field = violation[key];
            if (!field || !field.enabled || !Array.isArray(field.blocks)) continue;
            for (const block of field.blocks) {
                if (!block) continue;
                if (block.type === BLOCK_TYPES.TEXT) {
                    pushText(block.content);
                } else if (block.type === BLOCK_TYPES.IMAGE) {
                    pushText(block.caption);
                } else if (block.type === BLOCK_TYPES.TABLE) {
                    const md = tableToMarkdown(block.table);
                    if (md) parts.push(md);
                }
            }
        }
        return parts.join('\n\n');
    },

    /**
     * Адаптер чтения формализатора: переводит rich HTML-строку поля модели в
     * видимый plain-текст. Парсит строку во временный элемент и прогоняет
     * через serializeVisibleText (br/границы блоков → \n, инлайн-капсулы
     * ссылок/сносок — видимым текстом как есть), затем снимает caret-guard'ы
     * (U+FEFF) — они живут в DOM/модели капсул, но в текст для LLM попадать
     * не должны. #14a: строку санитизируем профилем 'acts' (тем же, что рендерит
     * поле) ДО присваивания в innerHTML — иначе в detached-узле Chromium сырой
     * innerHTML фетчит src-ресурсы (img и пр.), а on*-атрибуты дают mXSS-вектор;
     * видимый текст (включая текст капсул) при этом сохраняется.
     * Overridable — тест-шов (`_gatherSource` зовёт через `this._richToPlain`):
     * реальный DOM-парсинг HTML-строки недоступен под node-стабом (innerHTML
     * не парсится), юнит-тесты подменяют метод; разбор настоящих строк — в
     * Playwright (Task 1.6.3).
     * @param {string} html - HTML-значение поля модели
     * @returns {string} Видимый plain-текст без caret-guard'ов
     */
    _richToPlain(html) {
        const tmp = document.createElement('div');
        // SafeHTML.set санитизирует и присваивает одним шагом — сырой html до
        // innerHTML не доходит.
        SafeHTML.set(tmp, html || '', 'acts');
        return serializeVisibleText(tmp).replace(/\uFEFF/g, '');
    },

    close() {
        this._abort();
        if (this._el) this._el.classList.add('hidden');
        if (this._escUnsub) { this._escUnsub(); this._escUnsub = null; }
        this._apply = null;
        this._fields = null;
    },

    _abort() {
        if (this._controller) { this._controller.abort(); this._controller = null; }
    },

    _build() {
        if (this._el) return;
        const el = document.createElement('div');
        el.className = 'corrector-popover formalizer-popover hidden';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'Формализация нарушения');
        el.innerHTML = `
            <div class="corrector-header" data-role="header">
                <span class="corrector-title" data-role="title">✨ Корректор отклонения/проблемы</span>
                <button type="button" class="corrector-close" data-role="close" title="Закрыть">✕</button>
            </div>
            <div class="corrector-body formalizer-body" data-role="body">
                <label class="formalizer-hint">Свободный текст нарушения:</label>
                <textarea class="formalizer-source" data-role="source" rows="5"
                    placeholder="Вставьте или введите описание нарушения…"></textarea>
                <button type="button" class="corrector-btn formalizer-run" data-role="run">Формализовать</button>
                <div class="formalizer-preview" data-role="preview"></div>
                <div class="formalizer-recommendations hidden" data-role="recs"></div>
            </div>
            <div class="corrector-actions">
                <button type="button" class="corrector-btn corrector-reject" data-role="reject">Отмена</button>
                <button type="button" class="corrector-btn corrector-accept" data-role="accept" disabled>Применить</button>
            </div>
            <div class="corrector-resize" data-role="resize" title="Изменить размер"></div>
        `;
        document.body.appendChild(el);
        this._el = el;
        this._els = {
            header: el.querySelector('[data-role="header"]'),
            title: el.querySelector('[data-role="title"]'),
            source: el.querySelector('[data-role="source"]'),
            run: el.querySelector('[data-role="run"]'),
            preview: el.querySelector('[data-role="preview"]'),
            recs: el.querySelector('[data-role="recs"]'),
            accept: el.querySelector('[data-role="accept"]'),
            reject: el.querySelector('[data-role="reject"]'),
            close: el.querySelector('[data-role="close"]'),
            resize: el.querySelector('[data-role="resize"]'),
        };
        this._els.run.addEventListener('click', () => this._run());
        this._els.accept.addEventListener('click', () => this._accept());
        this._els.reject.addEventListener('click', () => this.close());
        this._els.close.addEventListener('click', () => this.close());
        this._resizer = makeResizablePanel({
            panel: el,
            handle: this._els.resize,
            growX: 'right',
            minWidth: 340,
            maxWidthVw: 92,
            minHeight: 200,
            maxHeightVh: 85,
            storageKey: 'formalizer:popover:size',
            cursor: 'nwse-resize',
        });
        this._dragger = makeDraggablePanel({
            panel: el,
            handle: this._els.header,
            storageKey: 'formalizer:popover:pos',
        });
    },

    async _run() {
        const text = this._els.source.value;
        if (!text.trim()) {
            Notifications.info('Введите текст нарушения');
            return;
        }
        this._abort();
        this._controller = new AbortController();
        this._els.run.disabled = true;
        this._els.accept.disabled = true;
        this._els.preview.innerHTML = '<div class="corrector-status">Обрабатываю…</div>';
        this._clearRecommendations();
        try {
            const fields = await formalizeViolation(text, { signal: this._controller.signal });
            this._fields = fields;
            const filled = this._renderPreview(fields);
            this._renderRecommendations(fields.recommendations);
            // Пустой ответ применять нечего — «Применить» остаётся заблокированной,
            // статус в превью объясняет, почему (ревью №3).
            this._els.accept.disabled = filled === 0;
        } catch (e) {
            if (e && e.name === 'AbortError') return;
            this._fields = null;
            this._els.preview.innerHTML = '';
            this._clearRecommendations();
            const msg = document.createElement('div');
            msg.className = 'corrector-status corrector-error';
            msg.textContent = (e && e.message) ? e.message : 'Ошибка формализации';
            this._els.preview.appendChild(msg);
        } finally {
            this._els.run.disabled = false;
        }
    },

    /**
     * Рисует превью извлечённых полей. Значения — готовый HTML (контракт
     * `FormalizeResponse`), поэтому идут в превью санитизированной разметкой
     * профилем 'acts': списки видны списками, а не строкой с тегами `<ul><li>`
     * (ревью №3). Ни одного непустого поля — вместо шести «— не извлечено»
     * один внятный статус.
     * @param {Object} fields - Ответ формализатора
     * @returns {number} Сколько полей ответа непусты
     */
    _renderPreview(fields) {
        this._els.preview.innerHTML = '';
        const values = _PREVIEW_FIELDS.map(
            ([key, label]) => [label, String(fields?.[key] ?? '').trim()],
        );
        const filled = values.filter(([, value]) => value).length;
        if (!filled) {
            const msg = document.createElement('div');
            msg.className = 'corrector-status';
            msg.textContent = 'Модель ничего не извлекла из текста';
            this._els.preview.appendChild(msg);
            return 0;
        }
        for (const [label, value] of values) {
            const row = document.createElement('div');
            row.className = 'formalizer-field' + (value ? '' : ' formalizer-field-empty');
            const lab = document.createElement('span');
            lab.className = 'formalizer-field-label';
            lab.textContent = label;
            const val = document.createElement('div');
            val.className = 'formalizer-field-value';
            if (value) SafeHTML.set(val, value, 'acts');
            else val.textContent = '— не извлечено';
            row.appendChild(lab);
            row.appendChild(val);
            this._els.preview.appendChild(row);
        }
        return filled;
    },

    /**
     * Рендерит дисплей-онли рекомендации «чего не хватает» под превью. Пустой/не-
     * массив список → секция скрыта. Эти подсказки в карточку/экспорт НЕ идут —
     * «Применить» их не трогает (см. violation-core `_applyFormalized`).
     * @param {string[]} recs
     */
    _renderRecommendations(recs) {
        const box = this._els.recs;
        box.innerHTML = '';
        const items = Array.isArray(recs)
            ? recs.map((r) => (r || '').trim()).filter(Boolean)
            : [];
        if (!items.length) { box.classList.add('hidden'); return; }
        const lab = document.createElement('div');
        lab.className = 'formalizer-recs-label';
        lab.textContent = 'Чего не хватает в описании';
        const ul = document.createElement('ul');
        ul.className = 'formalizer-recs-list';
        for (const r of items) {
            const li = document.createElement('li');
            li.textContent = r;
            ul.appendChild(li);
        }
        box.appendChild(lab);
        box.appendChild(ul);
        box.classList.remove('hidden');
    },

    _clearRecommendations() {
        this._els.recs.innerHTML = '';
        this._els.recs.classList.add('hidden');
    },

    /**
     * «Применить»: раскладывает извлечённые поля по карточке. Успех объявляем
     * только по факту записи — `apply` возвращает число заполненных полей, и
     * ноль (карточка в режиме просмотра, писать не дали) больше не показывает
     * success и не закрывает окно: раньше уведомление «Поля карточки заполнены»
     * выдавалось безусловно, даже когда в карточку не уехало ничего.
     */
    _accept() {
        if (!this._fields || typeof this._apply !== 'function') { this.close(); return; }
        const applied = this._apply(this._fields);
        if (!applied) {
            Notifications.info('Поля карточки не заполнены — применять было нечего');
            return;   // окно оставляем открытым: результат ещё перед глазами
        }
        Notifications.success('Поля карточки заполнены');
        // Есть рекомендации → окно остаётся открытым только с этим блоком.
        // Нет — закрываемся, показывать нечего.
        if (this._els.recs.classList.contains('hidden')) {
            this.close();
        } else {
            this._enterRecommendationsView();
        }
    },

    /**
     * Пост-применение: ввод/превью/«Применить» скрыты, в окне остаётся только блок
     * «чего не хватает». Показ этих подсказок — единственная задача окна после того,
     * как поля уже уехали в карточку. Сброс — в `open()` при следующем открытии.
     */
    _enterRecommendationsView() {
        this._fields = null;
        this._els.source.value = '';
        this._els.preview.innerHTML = '';
        this._els.reject.textContent = 'Закрыть';
        this._el.classList.add('formalizer-applied');
    },
};

// Window-global для совместимости с inline-скриптами шаблонов.
window.FormalizerPopover = FormalizerPopover;
