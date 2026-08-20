/**
 * Плавающая панель «Корректор» текста.
 *
 * Перетаскиваемая (за заголовок) и ресайзабельная панель по образцу строки поиска:
 * базовое положение — слева вверху (поиск — справа), позиция/размер персистятся.
 * Два режима обработки (кнопки в шапке): «Исправить ошибки» (орфография/пунктуация)
 * и «Улучшить читаемость» (улучшайзер «Пиши, сокращай» D17) — оба возвращают диф.
 * Для режима читаемости над дифом показывается светофор диагностики D17 —
 * индекс тяжести и уровень до и после правки. При открытии
 * обращения к модели НЕТ: обработка стартует по клику на нужный режим — кнопка режима
 * и есть кнопка запуска (экономит лишний вызов LLM, когда нужен не дефолтный режим).
 * Показывает диф исправленного текста в одном из трёх режимов (в строку / 2 окна /
 * 3 окна — из настроек конструктора). «Принять» заменяет выделение с сохранением
 * переносов строк (`\n`→`<br>`); при наличии в выделении ссылок/сносок — предупреждает,
 * что они будут удалены.
 */
import {
    diffTokens, renderInline, renderBefore, renderAfter, renderPlain,
} from './corrector-diff.js';
import { SafeHTML } from '../../shared/sanitize.js';
import { Notifications } from '../../shared/notifications.js';
import { EscapeStack } from '../../shared/escape-stack.js';
import { makeResizablePanel } from '../../shared/resizable-panel.js';
import { makeDraggablePanel } from '../../shared/draggable-panel.js';
import { serializeVisibleText } from '../../shared/rich-text.js';
import { ActSearchEngine } from '../search/act-search-engine.js';
import { textBlockManager } from '../textblock/textblock-core.js';
import { EditorRegistry } from '../textblock/editor-registry.js';
import { correctText } from './text-actions-client.js';
import { DialogManager } from '../../shared/dialog/dialog-confirm.js';

export const CorrectorPopover = {
    _el: null,
    _els: null,
    _resizer: null,
    _dragger: null,
    _escUnsub: null,
    _controller: null,
    _editor: null,
    _ownerSurface: null,
    _range: null,
    _sourceText: '',
    _corrected: '',
    _readability: null,
    _destructive: false,
    _mode: null,
    _hasRequested: false,
    _lastError: false,

    /**
     * @param {{editor: HTMLElement, range: Range, text: string}} opts
     */
    open({ editor, range, text }) {
        this._build();
        this._editor = editor;
        // #1 (HIGH): захватываем поверхность-владельца редактируемого поля СЕЙЧАС.
        // Пока поле в фокусе, EditorRegistry.getActive() гарантированно указывает
        // на него (EditorController смонтирован на фокусе). К моменту «Принять»
        // пользователь мог кликнуть в другое поле (getActive() уедет на него) или
        // увести фокус (Registry опустеет) — оба случая молча коммитили правку не
        // туда/никуда. Владелец — тот, чья поверхность держит именно этот editor.
        this._ownerSurface = this._resolveOwnerSurface(editor);
        this._range = range;
        this._sourceText = text;
        this._corrected = '';
        this._readability = null;
        // Ни один режим не выбран заранее — иначе кнопка «Исправить ошибки»
        // горела бы активной ещё до запроса (обработки-то нет). Подсветка
        // появляется по клику на нужный режим.
        this._mode = null;
        this._hasRequested = false;
        this._lastError = false;
        this._syncModeButtons();
        this._destructive = this._detectDestructiveCapsules(range);
        this._el.classList.remove('hidden');
        if (!this._escUnsub) this._escUnsub = EscapeStack.push(() => this.close());
        // Не запрашиваем модель на открытии — ждём выбор режима пользователем.
        this._renderIdle();
    },

    close() {
        this._abort();
        if (this._el) this._el.classList.add('hidden');
        if (this._escUnsub) { this._escUnsub(); this._escUnsub = null; }
        this._editor = null;
        this._ownerSurface = null;
        this._range = null;
        this._corrected = '';
        this._readability = null;
        this._destructive = false;
    },

    _build() {
        if (this._el) return;
        const el = document.createElement('div');
        el.className = 'corrector-popover hidden';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'Корректор текста');
        el.innerHTML = `
            <div class="corrector-header" data-role="header">
                <span class="corrector-title">✨ Корректор</span>
                <button type="button" class="corrector-close" data-role="close" title="Закрыть">✕</button>
            </div>
            <div class="corrector-modes" data-role="modes">
                <button type="button" class="corrector-mode" data-mode="fix">Исправить ошибки</button>
                <button type="button" class="corrector-mode" data-mode="readability">Улучшить читаемость</button>
            </div>
            <div class="corrector-readability hidden" data-role="readability"></div>
            <div class="corrector-body" data-role="body"></div>
            <div class="corrector-actions">
                <button type="button" class="corrector-btn corrector-regen" data-role="regen" title="Перегенерировать">↻</button>
                <button type="button" class="corrector-btn corrector-reject" data-role="reject">Отклонить</button>
                <button type="button" class="corrector-btn corrector-accept" data-role="accept">Принять</button>
            </div>
            <div class="corrector-resize" data-role="resize" title="Изменить размер"></div>
        `;
        document.body.appendChild(el);
        this._el = el;
        this._els = {
            header: el.querySelector('[data-role="header"]'),
            modes: el.querySelector('[data-role="modes"]'),
            readability: el.querySelector('[data-role="readability"]'),
            body: el.querySelector('[data-role="body"]'),
            accept: el.querySelector('[data-role="accept"]'),
            reject: el.querySelector('[data-role="reject"]'),
            regen: el.querySelector('[data-role="regen"]'),
            close: el.querySelector('[data-role="close"]'),
            resize: el.querySelector('[data-role="resize"]'),
        };
        // B-40: кнопки не воруют фокус/выделение у редактора. Заголовок НЕ гасим —
        // за него тянет makeDraggablePanel.
        [this._els.accept, this._els.reject, this._els.regen, this._els.close].forEach((b) => {
            b.addEventListener('mousedown', (e) => e.preventDefault());
            b.addEventListener('pointerdown', (e) => e.preventDefault());
        });
        // Тумблер режимов: не воруем выделение (как кнопки выше), клик → смена режима.
        this._els.modes.querySelectorAll('[data-mode]').forEach((b) => {
            b.addEventListener('mousedown', (e) => e.preventDefault());
            b.addEventListener('pointerdown', (e) => e.preventDefault());
            b.addEventListener('click', () => this._setMode(b.dataset.mode));
        });
        this._els.accept.addEventListener('click', () => this._accept());
        this._els.reject.addEventListener('click', () => this.close());
        this._els.close.addEventListener('click', () => this.close());
        this._els.regen.addEventListener('click', () => this._request());
        this._resizer = makeResizablePanel({
            panel: el,
            handle: this._els.resize,
            growX: 'right',
            minWidth: 320,
            maxWidthVw: 92,
            minHeight: 140,
            maxHeightVh: 80,
            storageKey: 'corrector:popover:size',
            cursor: 'nwse-resize',
        });
        this._dragger = makeDraggablePanel({
            panel: el,
            handle: this._els.header,
            storageKey: 'corrector:popover:pos',
        });
    },

    _setBusy(busy) {
        this._els.accept.disabled = busy;
        this._els.regen.disabled = busy;
    },

    // Клик по кнопке режима = запуск варианта: меняет активную кнопку и запрашивает
    // результат. Запрос идёт при смене режима, при первом клике из стартового
    // состояния (когда обращения к модели ещё не было) ЛИБО после ошибки —
    // повторный клик по тому же режиму должен повторить неудавшийся запрос.
    // Повторный клик по УСПЕШНО отработавшему режиму не дёргает модель зря —
    // для этого есть кнопка ↻.
    _setMode(mode) {
        if (mode !== 'fix' && mode !== 'readability') return;
        const changed = mode !== this._mode;
        this._mode = mode;
        this._syncModeButtons();
        if (changed || !this._hasRequested || this._lastError) this._request();
    },

    // Стартовое состояние до первого запроса: подсказка «выберите режим», кнопки
    // «Принять»/↻ выключены (принимать/перегенерировать пока нечего).
    _renderIdle() {
        this._corrected = '';
        this._readability = null;
        this._renderReadability();
        this._els.accept.disabled = true;
        this._els.regen.disabled = true;
        this._els.body.innerHTML =
            '<div class="corrector-status">Выберите режим выше, чтобы запустить обработку.</div>';
    },

    _syncModeButtons() {
        if (!this._els || !this._els.modes) return;
        this._els.modes.querySelectorAll('[data-mode]').forEach((b) => {
            b.classList.toggle('active', b.dataset.mode === this._mode);
        });
    },

    async _request() {
        this._abort();
        this._hasRequested = true;
        this._lastError = false;
        this._controller = new AbortController();
        this._setBusy(true);
        this._els.body.innerHTML = '<div class="corrector-status">Обрабатываю…</div>';
        try {
            const { correctedText, readability } = await correctText(
                this._sourceText, { signal: this._controller.signal, mode: this._mode });
            this._corrected = correctedText;
            this._readability = readability;
            this._render();
            this._setBusy(false);
            this._lastError = false;
        } catch (e) {
            if (e && e.name === 'AbortError') return;
            this._lastError = true;
            this._corrected = '';
            this._readability = null;
            this._renderReadability();
            this._els.body.innerHTML = '';
            const msg = document.createElement('div');
            msg.className = 'corrector-status corrector-error';
            msg.textContent = (e && e.message) ? e.message : 'Ошибка обработки текста';
            this._els.body.appendChild(msg);
            this._els.accept.disabled = true;
            this._els.regen.disabled = false;
        }
    },

    // Класс уровня светофора анализатора D17 — по первому слову уровня
    // («Зелёный (хорошо)» / «Жёлтый (средне)» / «Красный (тяжело)»).
    _levelClass(level) {
        if (!level) return '';
        if (level.startsWith('Зелёный')) return 'corrector-level-green';
        if (level.startsWith('Жёлтый')) return 'corrector-level-yellow';
        return 'corrector-level-red';
    },

    // Диагностика читаемости «до → после» (анализатор D17). Показывается только
    // в режиме readability и только когда бэк её прислал: в режиме fix и при
    // сбое анализатора поле приходит null — тогда блок прячем, а корректура
    // работает как ни в чём не бывало.
    _renderReadability() {
        const box = this._els && this._els.readability;
        if (!box) return;
        const r = this._readability;
        if (this._mode !== 'readability' || !r || !r.before || !r.after) {
            box.classList.add('hidden');
            box.textContent = '';
            return;
        }

        const deltas = [];
        const push = (label, from, to) => {
            if (from === null || from === undefined) return;
            if (to === null || to === undefined) return;
            if (from === to) return;
            deltas.push(`${label} ${from}→${to}`);
        };
        push('сущ./глаг.', r.before.noun_verb_ratio, r.after.noun_verb_ratio);
        push('род. падеж', r.before.longest_genitive_chain.length,
            r.after.longest_genitive_chain.length);
        push('слов в предл.', r.before.avg_word_count, r.after.avg_word_count);
        push('канцеляризмы', r.before.bureaucratic_markers_total,
            r.after.bureaucratic_markers_total);

        box.textContent = '';
        const head = document.createElement('div');
        head.className = 'corrector-readability-head';
        const from = document.createElement('span');
        from.className = `corrector-level ${this._levelClass(r.before.level)}`;
        from.textContent = `${r.before.level} ${r.before.average_penalty}`;
        const arrow = document.createElement('span');
        arrow.className = 'corrector-readability-arrow';
        arrow.textContent = '→';
        const to = document.createElement('span');
        to.className = `corrector-level ${this._levelClass(r.after.level)}`;
        to.textContent = `${r.after.level} ${r.after.average_penalty}`;
        head.append(from, arrow, to);
        box.appendChild(head);

        if (deltas.length) {
            const sub = document.createElement('div');
            sub.className = 'corrector-readability-deltas';
            sub.textContent = deltas.join(' · ');
            box.appendChild(sub);
        }
        box.classList.remove('hidden');
    },

    _render() {
        this._renderReadability();
        const before = this._sourceText;
        const after = this._corrected;
        const ops = diffTokens(before, after);
        const mode = this._diffMode();
        const body = this._els.body;
        body.innerHTML = '';

        if (this._destructive) {
            const warn = document.createElement('div');
            warn.className = 'corrector-warning';
            warn.textContent = '⚠ В выделении есть ссылки или сноски — при замене они будут удалены.';
            body.appendChild(warn);
        }

        if (mode === 'panes2') {
            body.appendChild(this._panesRow([
                ['Было', renderBefore(ops)],
                ['Стало', renderAfter(ops)],
            ]));
        } else if (mode === 'panes3') {
            body.appendChild(this._panesRow([
                ['Было', renderPlain(before)],
                ['Изменения', renderInline(ops)],
                ['Стало', renderPlain(after)],
            ]));
        } else {
            const div = document.createElement('div');
            div.className = 'corrector-diff';
            body.appendChild(div);
            SafeHTML.set(div, renderInline(ops));
        }
    },

    _panesRow(panes) {
        const row = document.createElement('div');
        row.className = 'corrector-panes';
        for (const [label, html] of panes) {
            const pane = document.createElement('div');
            pane.className = 'corrector-pane';
            const lab = document.createElement('div');
            lab.className = 'corrector-pane-label';
            lab.textContent = label;
            const content = document.createElement('div');
            content.className = 'corrector-diff';
            SafeHTML.set(content, html);
            pane.appendChild(lab);
            pane.appendChild(content);
            row.appendChild(pane);
        }
        return row;
    },

    // Режим сравнения из настроек конструктора (сегмент-контрол в меню шестерёнки).
    _diffMode() {
        const sm = (typeof window !== 'undefined') ? window.SettingsMenuManager : null;
        const m = (sm && typeof sm.getCorrectorDiffMode === 'function')
            ? sm.getCorrectorDiffMode() : 'panes2';
        return (m === 'panes2' || m === 'panes3') ? m : 'inline';
    },

    // Разрушит ли замена капсулы: капсула ВНУТРИ выделения либо пересечение границы.
    // Выделение целиком внутри одной капсулы (правка подписи ссылки) — не разрушает.
    _detectDestructiveCapsules(range) {
        const start = ActSearchEngine._capsuleAncestorOf(range.startContainer);
        const end = ActSearchEngine._capsuleAncestorOf(range.endContainer);
        if (start && start === end) return false;
        let interior = false;
        try {
            interior = !!range.cloneContents().querySelector('.text-link, .text-footnote');
        } catch (e) {
            interior = false;
        }
        return interior || (start !== end);
    },

    // Вставка plain-текста с сохранением переносов: `\n` → <br> (как paste-путь редактора).
    _insertCorrected(range, text) {
        range.deleteContents();
        const frag = document.createDocumentFragment();
        const lines = String(text).split('\n');
        lines.forEach((line, i) => {
            if (i > 0) frag.appendChild(document.createElement('br'));
            if (line) frag.appendChild(document.createTextNode(line));
        });
        range.insertNode(frag);
    },

    // Текущий текст сохранённого диапазона, реконструированный СИММЕТРИЧНО
    // _sourceText (Selection.toString). Ключевой нюанс web-платформы:
    // Selection.toString ставит перевод строки и на <br>, И на границах
    // блочных элементов (<div>/<p>/<li>/…), а textContent границы блоков
    // склеивает. Поэтому для выделения через две Enter-строки (нативный <div>)
    // наивный textContent давал 'ab' против исходного 'a\nb' и ложно
    // срабатывал гейт «Текст изменён». Здесь обходим фрагмент вручную,
    // добавляя \n и на <br>, и на закрытии блочных элементов.
    // null — если диапазон недоступен (узлы удалены при правке).
    _rangeText(range) {
        try {
            const holder = document.createElement('div');
            holder.appendChild(range.cloneContents());
            return this._serializeWithBreaks(holder);
        } catch (e) {
            return null;
        }
    },

    // Сериализация DOM-фрагмента в plain-текст, зеркалящая Selection.toString.
    // Логика вынесена в shared/rich-text.js (переиспользуется формализатором
    // и сводом ячеек); метод оставлен обёрткой ради обратной совместимости
    // вызовов внутри класса и теста-стража.
    _serializeWithBreaks(root) {
        return serializeVisibleText(root);
    },

    // Изменился ли исходный фрагмент с момента отправки на обработку.
    // Обе стороны реконструируются симметрично (Selection.toString для _sourceText,
    // _serializeWithBreaks для _rangeText), но остаточные различия платформы
    // нормализуем: прогоны пробелов схлопываем (white-space:normal), прогоны
    // переводов строк тоже (Selection.toString между блоками-параграфами может
    // дать '\n\n', реконструкция — один '\n'), хвостовые пробелы/переносы
    // отбрасываем. Реальные правки (иные слова, добавленный/убранный перенос)
    // при этом остаются различимыми.
    _textChanged(sent, current) {
        if (current === null) return true;
        const norm = (s) => String(s)
            .replace(/\r\n/g, '\n')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{2,}/g, '\n')
            .replace(/\s+$/, '');
        return norm(sent) !== norm(current);
    },

    async _accept() {
        if (!this._corrected || !this._range || !this._editor) { this.close(); return; }
        const range = this._range;

        // Гейт: если исходный фрагмент изменился с момента отправки на обработку —
        // предупреждаем, что ручные правки будут перезаписаны. До вставки документ не трогаем.
        if (this._textChanged(this._sourceText, this._rangeText(range))) {
            const ok = await DialogManager.show({
                type: 'warning',
                title: 'Текст изменён',
                message: 'Исправляемый текст был изменён. При принятии эти изменения будут потеряны. Вставить исправленный вариант?',
                confirmText: 'Да',
                cancelText: 'Нет',
            });
            if (!ok) { this.close(); return; }
        }

        try {
            // Разрушительные капсулы: выносим границы наружу капсул, чтобы не оставить
            // «половину» капсулы, затем плоско заменяем (капсулы внутри удаляются — о чём
            // предупредили баннером).
            if (this._destructive
                && typeof textBlockManager._expandRangeOutOfMarkers === 'function') {
                textBlockManager._expandRangeOutOfMarkers(range, this._editor);
            }
            this._insertCorrected(range, this._corrected);
        } catch (e) {
            Notifications.error('Не удалось заменить текст');
            return;
        }
        if (ActSearchEngine && typeof ActSearchEngine.invalidateRunsCache === 'function') {
            ActSearchEngine.invalidateRunsCache();
        }
        // Персист исправления в модель. Тост «Текст исправлен» — ТОЛЬКО при
        // фактическом коммите: молчаливая потеря правки (getActive() уехал в другое
        // поле / Registry пуст / поле отвязано) больше не выдаётся за успех.
        if (this._persistCorrection()) {
            Notifications.success('Текст исправлен');
        } else {
            Notifications.error('Не удалось сохранить исправление: поле недоступно');
        }
        this.close();
    },

    // Поверхность-владелец редактируемого поля НА МОМЕНТ запуска корректора:
    // getActive() сейчас указывает на редактируемое поле, но захватываем ссылку
    // с гардом element===editor (отсекает чужую активную поверхность и пустой
    // Registry) — источником истины для коммита служит именно она, а не
    // getActive() на момент клика «Принять».
    _resolveOwnerSurface(editor) {
        const active = EditorRegistry.getActive();
        return (active && active.element === editor) ? active : null;
    },

    // Коммитит принятую правку в модель. Возвращает true при реальной записи.
    // Текстблок (dataset.textBlockId) — прежним путём finalizeEdit (saveContent
    // по textBlockId, EditorRegistry ему не нужен). Поле нарушения (textBlockId
    // не несёт, см. _createRichFieldEditor) — через ЗАХВАЧЕННУЮ при открытии
    // поверхность-владельца; повторный гард element===editor страхует от
    // ре-рендера/отвязки поля между открытием и «Принять».
    _persistCorrection() {
        const editor = this._editor;
        if (!editor) return false;
        if (editor.dataset && editor.dataset.textBlockId) {
            textBlockManager.finalizeEdit(editor);
            return true;
        }
        const surface = this._ownerSurface;
        if (surface && surface.element === editor && typeof surface.persist === 'function') {
            surface.persist();
            return true;
        }
        return false;
    },

    _abort() {
        if (this._controller) {
            try { this._controller.abort(); } catch (e) { /* no-op */ }
            this._controller = null;
        }
    },
};

window.CorrectorPopover = CorrectorPopover;
