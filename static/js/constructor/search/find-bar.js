/**
 * Панель поиска/замены по текстблокам акта (B2). Немодальная фиксированная
 * панель в правом-верхнем углу пановки редактирования (Step 2). Потребляет
 * движок B1 (ActSearchEngine) и слой подсветки (ActSearchHighlight); UI и
 * проводку replace/replace-all держит здесь.
 *
 * Ключевые инварианты:
 *  - Подсветка — через CSS Custom Highlight API (никаких <mark>-обёрток вокруг
 *    текста → капсулы/сноски целы). Прокрутка к текущему — scrollIntoView.
 *  - Тело сноски (data-footnote-text) — невидимая в DOM поверхность поиска
 *    (FootnoteBodySearchTarget, act-search-engine.js): у её совпадений
 *    range===null, подсветка их не видит (нет Range). Текущее такое совпадение
 *    показывается иначе — скролл к самой капсуле-сноске + форсированный
 *    tooltip с <mark> (textblock-links-footnotes.js::showFootnoteSearchTooltip,
 *    см. _revealCurrentMatch); замена — сплайс строки атрибута
 *    (_spliceFootnoteBodyText), не Range API.
 *  - mousedown/pointerdown→preventDefault на КНОПКАХ панели: клик по ним не
 *    ворует фокус у активного поля ввода и не схлопывает выделение редактора
 *    (по образцу #globalTextBlockToolbar). На ТЕКСТОВЫЕ поля не вешаем — им
 *    нужен нативный фокус/каретка (та же причина, что у font-size-select в
 *    тулбаре).
 *  - Поиск НЕ зовёт editor.focus() — не двигает каретку в редакторе (подсветка
 *    и прокрутка не зависят от выделения).
 *  - Esc — через EscapeStack (LIFO): закрывает панель и снимает подсветку.
 *  - Read-only акт: строка замены скрыта, поиск доступен.
 *  - После ЛЮБОЙ замены совпадения пересобираются заново (buildAllMatches):
 *    смещения B1 сдвигаются; в replace-all внутри одной цели правки идут
 *    С КОНЦА (back-to-front), чтобы более ранние Range оставались валидны.
 *  - Программная замена НЕ покрывается нативным Ctrl+Z → одношаговый custom-undo
 *    «Отменить замену» через снимок content'а блоков.
 */
import { ActSearchEngine } from './act-search-engine.js';
import { ActSearchHighlight } from './act-search-highlight.js';
import {
    pluralRu,
    buildReplaceAllConfirmMessage,
    formatMatchCounter,
    wrapIndex,
    groupMatchesByTarget,
    snapshotTextBlockContents,
    applySnapshotRestore,
    snapshotSurfaceContents,
    restoreSurfaceSnapshot,
} from './act-search-replace.js';
import { EscapeStack } from '../../shared/escape-stack.js';
import { makeDraggablePanel } from '../../shared/draggable-panel.js';
import { DialogManager } from '../../shared/dialog/dialog-confirm.js';
import { Notifications } from '../../shared/notifications.js';
import { AppConfig } from '../../shared/app-config.js';
import { AppState } from '../state/state-core.js';
import { App } from '../app.js';
import { ItemsRenderer } from '../items/items-renderer.js';
import { textBlockManager } from '../textblock/textblock-core.js';

/** Задержка дебаунса поиска по вводу (мс). */
const SEARCH_DEBOUNCE_MS = 150;

export const FindBar = {
    /** @private @type {boolean} */
    _hotkeyInstalled: false,
    /** @private @type {HTMLElement|null} Корень панели. */
    _bar: null,
    /** @private @type {Object} Ссылки на элементы управления. */
    _els: {},
    /** @private @type {Array} Текущий плоский список совпадений (buildAllMatches). */
    _matches: [],
    /** @private @type {boolean} Достигнут ли лимит совпадений. */
    _capped: false,
    /** @private @type {number} Индекс текущего совпадения. */
    _currentIdx: -1,
    /** @private @type {{caseSensitive:boolean, wholeWord:boolean, regex:boolean}} */
    _opts: { caseSensitive: false, wholeWord: false, regex: false },
    /** @private @type {number} Хэндл дебаунса. */
    _debounceTimer: 0,
    /** @private @type {(()=>void)|null} Unsubscribe из EscapeStack. */
    _escUnsub: null,
    /**
     * @private @type {HTMLElement|null} span.text-footnote, для которого сейчас
     * форсированно открыт tooltip (текущее совпадение — footnoteBody, тело
     * сноски). Отслеживаем сами (не через textBlockManager.currentTooltip —
     * тот общий с обычным hover-tooltip'ом) — чтобы закрыть форс-tooltip именно
     * при уходе С ЭТОГО совпадения, а не полагаться на побочные hover-события.
     */
    _activeFootnoteTooltipEl: null,
    /**
     * @private
     * @type {Map<string,{before:string,after:string}>|null}
     * Снимок content'а затронутых текстблоков для одношагового undo: `before` —
     * до пакета, `after` — сразу после (divergence-guard в `_undoReplaceAll`).
     */
    _lastUndo: null,
    /**
     * @private
     * @type {Map<string,{before:string,after:string}>|null}
     * ПАРАЛЛЕЛЬНЫЙ снимок rich-полей нарушений (A-full undo): их модель НЕ в
     * AppState.textBlocks, снимается через поверхность (target.getContent).
     * Восстановление — target.setContent с тем же divergence-guard.
     */
    _lastUndoSurfaces: null,

    /**
     * Устанавливает горячую клавишу Ctrl+F / Cmd+F (capture-фаза): перехватывает
     * браузерный поиск, при необходимости переключает на Step 2 и открывает
     * панель, префилля запрос текущим выделением.
     */
    installHotkey() {
        if (this._hotkeyInstalled) return;
        this._hotkeyInstalled = true;

        document.addEventListener('keydown', (e) => {
            const isFind = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey
                && (e.key === 'f' || e.key === 'F' || e.code === 'KeyF');
            if (!isFind) return;
            e.preventDefault();
            e.stopPropagation();

            // Step 1 (превью) → редакторы не «живы» для подсветки: переключаемся.
            if (AppState.currentStep !== 2 && typeof App.goToStep === 'function') {
                App.goToStep(2);
            }

            // Префилл из выделения (снимаем ДО фокуса на поле поиска).
            this.open(this._selectionPrefill());
        }, true);
    },

    /**
     * @private Начальный запрос из ТЕКУЩЕГО выделения редактора: однострочное
     * непустое → сам текст, иначе ''. Общий для Ctrl+F (installHotkey) и кнопки
     * 🔍 всплывающего тулбара (textblock-toolbar.js) — обе точки открытия панели
     * должны вести себя одинаково (подсказка кнопки обещает «(Ctrl+F)»). Снимать
     * ДО фокуса на поле поиска: фокус схлопнул бы выделение редактора.
     * @returns {string}
     */
    _selectionPrefill() {
        const sel = (typeof window.getSelection === 'function') ? window.getSelection() : null;
        if (sel && !sel.isCollapsed) {
            const t = sel.toString();
            if (t && !t.includes('\n')) return t;   // многострочное игнорируем
        }
        return '';
    },

    /**
     * Открывает панель. Строит DOM при первом вызове, показывает, фокусирует
     * поле поиска и (при наличии запроса) запускает поиск.
     * @param {string} [prefill] Начальный запрос.
     */
    open(prefill) {
        if (!this._bar) this._build();
        this._applyReadOnly();
        // Открытие панели — новый контекст: прежний снимок undo протух
        // (акт мог правиться между close и повторным open).
        this._clearUndo();
        this._bar.classList.remove('hidden');

        if (!this._escUnsub) {
            this._escUnsub = EscapeStack.push(() => this.close());
        }

        if (typeof prefill === 'string' && prefill !== '') {
            this._els.findInput.value = prefill;
        }
        // Фокус/выделение в поле поиска — редактор при этом теряет фокус, это ок
        // (подсветка от выделения не зависит).
        this._els.findInput.focus();
        this._els.findInput.select();

        if (this._els.findInput.value) {
            this._runSearch();
        } else {
            this._matches = [];
            this._capped = false;
            this._currentIdx = -1;
            this._render();
        }
    },

    /** Закрывает панель: снимает подсветку, форс-tooltip сноски и Esc-обработчик. */
    close() {
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = 0;
        }
        ActSearchHighlight.clear();
        this._clearFootnoteTooltip();
        // Снимок undo живёт только пока панель открыта: после закрытия акт
        // могут править вне поиска, а старый снимок затёр бы эти правки.
        this._clearUndo();
        if (this._bar) this._bar.classList.add('hidden');
        if (this._escUnsub) {
            this._escUnsub();
            this._escUnsub = null;
        }
    },

    // ── Построение DOM ──────────────────────────────────────────────────────

    /** @private Создаёт панель и навешивает обработчики. */
    _build() {
        const bar = document.createElement('div');
        bar.id = 'actFindBar';
        bar.className = 'act-find-bar hidden';
        bar.setAttribute('role', 'search');
        bar.setAttribute('aria-label', 'Поиск и замена по тексту акта');
        bar.innerHTML = `
            <div class="act-find-row act-find-row-search">
                <input type="text" class="act-find-input" data-role="find"
                       placeholder="Найти" aria-label="Найти" spellcheck="false" />
                <span class="act-find-counter" data-role="counter" aria-live="polite">0 / 0</span>
                <div class="act-find-nav" role="group" aria-label="Навигация по совпадениям">
                    <button type="button" class="act-find-btn" data-role="prev"
                            title="Предыдущее совпадение" aria-label="Предыдущее совпадение">‹</button>
                    <button type="button" class="act-find-btn" data-role="next"
                            title="Следующее совпадение" aria-label="Следующее совпадение">›</button>
                </div>
                <button type="button" class="act-find-btn act-find-close" data-role="close"
                        title="Закрыть (Esc)" aria-label="Закрыть">✕</button>
            </div>
            <div class="act-find-row act-find-row-options">
                <div class="act-find-toggles" role="group" aria-label="Параметры поиска">
                    <button type="button" class="act-find-toggle" data-toggle="caseSensitive"
                            aria-pressed="false" title="Учитывать регистр">Aa</button>
                    <button type="button" class="act-find-toggle" data-toggle="wholeWord"
                            aria-pressed="false" title="Слово целиком">Слово</button>
                    <button type="button" class="act-find-toggle" data-toggle="regex"
                            aria-pressed="false"
                            title="Регулярное выражение. \w, \d, \s — ASCII-only (не матчат кириллицу); для букв любого языка используйте \p{L}, для цифр \p{N}">.*</button>
                </div>
            </div>
            <div class="act-find-replace-group" data-role="replaceRow">
                <div class="act-find-row act-find-row-replace">
                    <input type="text" class="act-find-input" data-role="replace"
                           placeholder="Заменить на" aria-label="Заменить на" spellcheck="false" />
                </div>
                <div class="act-find-row act-find-row-actions">
                    <button type="button" class="act-find-action" data-role="replaceOne">Заменить</button>
                    <button type="button" class="act-find-action" data-role="replaceAll">Заменить всё</button>
                    <button type="button" class="act-find-action act-find-undo hidden" data-role="undo"
                            title="Отменить последнюю замену">Отменить замену</button>
                </div>
            </div>
        `;
        document.body.appendChild(bar);

        this._bar = bar;
        this._els = {
            findInput: bar.querySelector('[data-role="find"]'),
            replaceInput: bar.querySelector('[data-role="replace"]'),
            counter: bar.querySelector('[data-role="counter"]'),
            replaceRow: bar.querySelector('[data-role="replaceRow"]'),
            undoBtn: bar.querySelector('[data-role="undo"]'),
            toggles: bar.querySelectorAll('[data-toggle]'),
        };

        this._bindEvents();
        // Перетаскивание — за «раму» самой панели (по образцу заголовка корректора):
        // навёлся на свободную зону/паддинг → курсор move → тянешь. Инпуты и кнопки
        // исключены noDragSelector'ом, поэтому фокус/клики по ним работают штатно.
        // Отдельный грип убран — он «съедал» и без того дефицитную ширину панели.
        this._dragger = makeDraggablePanel({
            panel: bar,
            handle: bar,
            storageKey: 'act-find-bar:pos',
        });
    },

    /** @private Навешивает обработчики ввода/кнопок. */
    _bindEvents() {
        const bar = this._bar;

        // Кнопки (toggle/nav/close/action) — mousedown→preventDefault, чтобы клик
        // не уводил фокус из поля поиска. На текстовые input'ы НЕ вешаем.
        bar.querySelectorAll('button').forEach((btn) => {
            btn.addEventListener('mousedown', (e) => e.preventDefault());
            btn.addEventListener('pointerdown', (e) => e.preventDefault());
        });

        // Поиск по вводу — дебаунс.
        this._els.findInput.addEventListener('input', () => this._scheduleSearch());
        // Enter — следующее (Shift+Enter — предыдущее); Esc снимет EscapeStack.
        this._els.findInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this._go(e.shiftKey ? -1 : 1);
            }
        });

        // Тумблеры параметров.
        this._els.toggles.forEach((btn) => {
            btn.addEventListener('click', () => this._toggleOpt(btn.dataset.toggle, btn));
        });

        // Навигация / закрытие.
        bar.querySelector('[data-role="prev"]').addEventListener('click', () => this._go(-1));
        bar.querySelector('[data-role="next"]').addEventListener('click', () => this._go(1));
        bar.querySelector('[data-role="close"]').addEventListener('click', () => this.close());

        // Замена.
        bar.querySelector('[data-role="replaceOne"]').addEventListener('click', () => this._replaceCurrent());
        bar.querySelector('[data-role="replaceAll"]').addEventListener('click', () => this._replaceAll());
        this._els.undoBtn.addEventListener('click', () => this._undoReplaceAll());
        // Enter в поле замены → заменить текущее.
        this._els.replaceInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this._replaceCurrent();
            }
        });
    },

    /** @private Скрывает строку замены в read-only акте. */
    _applyReadOnly() {
        const ro = !!(AppConfig.readOnlyMode && AppConfig.readOnlyMode.isReadOnly);
        if (this._els.replaceRow) {
            this._els.replaceRow.classList.toggle('hidden', ro);
        }
    },

    // ── Поиск ───────────────────────────────────────────────────────────────

    /** @private Планирует дебаунс-поиск по вводу. */
    _scheduleSearch() {
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => {
            this._debounceTimer = 0;
            this._runSearch();
        }, SEARCH_DEBOUNCE_MS);
    },

    /**
     * @private Немедленно исполняет отложенный дебаунс-поиск, если таймер висит.
     * Навигация/замена должны работать по СВЕЖИМ совпадениям текущего запроса,
     * а не по устаревшим (150-мс дебаунс мог ещё не сработать). Опции — те же,
     * что у отложенного вызова (`_runSearch()` без keepIdx).
     */
    _flushSearch() {
        if (!this._debounceTimer) return;
        clearTimeout(this._debounceTimer);
        this._debounceTimer = 0;
        this._runSearch();
    },

    /**
     * @private Запускает поиск немедленно и перерисовывает результат.
     * @param {{keepIdx?:boolean}} [o] keepIdx — сохранить текущий индекс (после
     *   замены: пересобранный список сдвинулся, тот же индекс = «следующее»).
     */
    _runSearch(o = {}) {
        const query = this._els.findInput.value;
        if (!query) {
            this._clearError();
            this._matches = [];
            this._capped = false;
            this._currentIdx = -1;
            this._render();
            return;
        }
        const res = ActSearchEngine.buildAllMatches(query, this._opts);
        if (res.error) {
            // Невалидный regex — inline-ошибка, без совпадений, без падения.
            this._showError(res.error);
            this._matches = [];
            this._capped = false;
            this._currentIdx = -1;
            this._render();
            return;
        }
        this._clearError();
        this._matches = res.matches;
        this._capped = res.capped;
        if (this._matches.length === 0) {
            this._currentIdx = -1;
        } else if (!o.keepIdx || this._currentIdx < 0) {
            this._currentIdx = 0;
        } else {
            this._currentIdx = wrapIndex(this._currentIdx, this._matches.length);
        }
        this._render(true);
    },

    /**
     * @private Перерисовывает подсветку, счётчик и (опц.) прокрутку/tooltip.
     * @param {boolean} [scroll] Прокрутить к текущему совпадению (и, для
     *   footnoteBody-совпадения, открыть форс-tooltip тела сноски) — гейтит
     *   ТЕ ЖЕ вызовы, что раньше вызывались (initial landing, prev/next; см.
     *   _runSearch/_go — ровно те же места, где раньше звался scrollToCurrent).
     * @param {boolean} [currentOnly] Обновить только подсветку ТЕКУЩЕГО совпадения
     *   ('act-find-current'), не пересобирая весь 'act-find' (для prev/next: набор
     *   совпадений тот же, сменился лишь индекс — экономит перестройку до 5000
     *   диапазонов на каждый шаг навигации).
     */
    _render(scroll, currentOnly) {
        const cur = (this._currentIdx >= 0 && this._matches[this._currentIdx])
            ? this._matches[this._currentIdx] : null;
        if (currentOnly) {
            ActSearchHighlight.renderCurrent(cur ? cur.range : null);
        } else {
            ActSearchHighlight.render(this._matches, this._currentIdx);
        }
        if (this._els.counter) {
            this._els.counter.textContent = formatMatchCounter(
                this._currentIdx, this._matches.length, this._capped, ActSearchEngine.MAX_MATCHES);
        }
        if (scroll) {
            this._revealCurrentMatch(cur);
        }
    },

    /**
     * @private Показывает ТЕКУЩЕЕ совпадение пользователю. Обычное (с DOM-Range) —
     * штатный scrollToCurrent (подсветка уже нарисована выше). footnoteBody
     * (тело сноски — Range физически нет, act-search-engine.js) — своя пара:
     * скролл к самому маркеру-капсуле + форсированный tooltip с подсветкой
     * найденной подстроки (CSS Custom Highlight её не увидит — ожидаемо, у
     * невидимого атрибута нет Range). Уход с footnoteBody-совпадения (переход
     * на обычное/отсутствие совпадений) закрывает форс-tooltip.
     * @param {object|null} match Текущий матч (buildAllMatches) либо null.
     */
    _revealCurrentMatch(match) {
        if (match && match.footnoteBody && match.footnoteEl) {
            if (typeof match.footnoteEl.scrollIntoView === 'function') {
                match.footnoteEl.scrollIntoView({ block: 'center' });
            }
            if (typeof textBlockManager.showFootnoteSearchTooltip === 'function') {
                textBlockManager.showFootnoteSearchTooltip(match.footnoteEl, match.start, match.end);
            }
            this._activeFootnoteTooltipEl = match.footnoteEl;
            return;
        }
        this._clearFootnoteTooltip();
        if (match && match.range) {
            ActSearchHighlight.scrollToCurrent(match.range);
        }
    },

    /** @private Закрывает форсированный tooltip тела сноски, если он открыт. */
    _clearFootnoteTooltip() {
        if (!this._activeFootnoteTooltipEl) return;
        this._activeFootnoteTooltipEl = null;
        // Закрываем ТОЛЬКО собственный форс-tooltip поиска. Если общий currentTooltip
        // сейчас — обычный hover-tooltip (пользователь навёлся на другую капсулу и
        // читает его), не трогаем его: hideFootnoteSearchTooltip проверяет владельца
        // (textblock-links-footnotes.js), а слепой hideTooltip закрыл бы чужой (#3).
        if (typeof textBlockManager.hideFootnoteSearchTooltip === 'function') {
            textBlockManager.hideFootnoteSearchTooltip();
        }
    },

    /**
     * @private Переход к предыдущему/следующему совпадению с заворачиванием.
     * @param {number} delta +1 (next) или −1 (prev).
     */
    _go(delta) {
        // Свежие совпадения до навигации (Enter/prev/next могли опередить дебаунс).
        this._flushSearch();
        if (this._matches.length === 0) return;
        this._currentIdx = wrapIndex(this._currentIdx + delta, this._matches.length);
        this._render(true, true); // только текущее — набор совпадений не менялся
    },

    /**
     * @private Переключает параметр поиска и перезапускает поиск.
     * @param {string} name caseSensitive|wholeWord|regex
     * @param {HTMLElement} btn Кнопка-тумблер (для aria-pressed/класса).
     */
    _toggleOpt(name, btn) {
        this._opts[name] = !this._opts[name];
        btn.setAttribute('aria-pressed', String(this._opts[name]));
        btn.classList.toggle('active', this._opts[name]);
        this._runSearch();
    },

    /** @private Показывает inline-ошибку на поле поиска. */
    _showError(msg) {
        this._els.findInput.classList.add('act-find-input-error');
        this._els.findInput.title = `Ошибка регулярного выражения: ${msg}`;
    },

    /** @private Снимает inline-ошибку. */
    _clearError() {
        this._els.findInput.classList.remove('act-find-input-error');
        this._els.findInput.title = '';
    },

    // ── Замена ──────────────────────────────────────────────────────────────

    /** @private Карта targetId → TextBlockSearchTarget (свежие цели). */
    _targetsById() {
        const map = new Map();
        for (const t of ActSearchEngine.buildTargets()) map.set(t.id, t);
        return map;
    },

    /**
     * @private Сплайсит подстроку [start,end) АТРИБУТА data-footnote-text (тело
     * сноски — footnoteBody-совпадение, у него физически нет DOM Range, см.
     * act-search-engine.js). Аналог replaceData на живом текстовом узле, но для
     * строки-атрибута: вызывающий обязан сам вызвать target.persist() после.
     *  - Смещения КЛАМПИМ в границы текущего значения: тело сноски могли
     *    поменять другим путём (двойной клик по маркеру) между поиском и заменой,
     *    и «протухшие» start/end иначе вырезали бы не тот кусок (та же защита, что
     *    в textblock-links-footnotes.js::showFootnoteSearchTooltip).
     *  - Пустое (в т.ч. пробельное) тело НЕ пишем: validateAndRepairCapsules
     *    развернул бы сноску в plain-text по пустому АТРИБУТУ и рассинхронил живой
     *    DOM с сохранённым content'ом — замену ПРОПУСКАЕМ (возвращаем false).
     * @param {HTMLElement} footnoteEl span.text-footnote
     * @param {number} start
     * @param {number} end
     * @param {string} replacement
     * @returns {boolean} применена ли замена (false — пропущена как опустошающая)
     */
    _spliceFootnoteBodyText(footnoteEl, start, end, replacement) {
        const before = footnoteEl.getAttribute('data-footnote-text') || '';
        const s = Math.max(0, Math.min(start, before.length));
        const e = Math.max(s, Math.min(end, before.length));
        const after = before.slice(0, s) + replacement + before.slice(e);
        if (!after.trim()) return false;
        footnoteEl.setAttribute('data-footnote-text', after);
        return true;
    },

    /**
     * @private Применяет замену к ОДНОМУ совпадению, диспетчеризуя по его виду
     * (единая точка — раньше проверка footnoteBody/range дублировалась в
     * _replaceCurrent и _replaceAll):
     *  - тело сноски (footnoteBody, range===null) — сплайс строки-атрибута;
     *  - обычное/капсульное (DOM Range) — ActSearchEngine.replaceRange, который
     *    сам мутирует текст-узлы (в т.ч. ВНУТРИ подписи ссылки/якоря сноски).
     * Мутирует DOM/атрибут; persist()/finalizeEdit — на вызывающем.
     * @param {object} match совпадение из buildAllMatches
     * @param {string} replacement
     * @returns {'replaced'|'skipped'} skipped — замена опустошила бы тело/подпись
     *   сноски/ссылки либо диапазон пересёк границу капсулы (движок такого не
     *   порождает) → не применяется.
     */
    _applyReplacementTo(match, replacement) {
        if (match.footnoteBody && match.footnoteEl) {
            return this._spliceFootnoteBodyText(match.footnoteEl, match.start, match.end, replacement)
                ? 'replaced' : 'skipped';
        }
        try {
            ActSearchEngine.replaceRange(match.range, replacement);
            return 'replaced';
        } catch (err) {
            // Диапазон опустошил бы/пересёк капсулу — пропуск (не падение).
            return 'skipped';
        }
    },

    /**
     * @private Множество blockId (владеющих текстблоков) для набора совпадений.
     * У FootnoteBodySearchTarget id составной (blockId:footnote:fnId), а content
     * персистится в AppState.textBlocks[blockId] — ОДИН блок с N сносками не
     * должен считаться N «блоками» в тексте диалога/снимке undo.
     * @param {Array} matches
     * @returns {Set<string>}
     */
    _blockIdsFor(matches) {
        const groups = groupMatchesByTarget(matches);
        const targets = this._targetsById();
        const ids = new Set();
        for (const targetId of groups.keys()) {
            const t = targets.get(targetId);
            ids.add((t && t.blockId) ? t.blockId : targetId);
        }
        return ids;
    },

    /** @private Заменяет текущее совпадение и переходит к следующему. */
    _replaceCurrent() {
        if (AppConfig.readOnlyMode && AppConfig.readOnlyMode.isReadOnly) return;
        // Свежие совпадения до замены (дебаунс мог ещё не сработать).
        this._flushSearch();
        const cur = this._matches[this._currentIdx];
        if (!cur) return;
        const replacement = this._els.replaceInput.value;

        const target = this._targetsById().get(cur.targetId);
        if (!target) return;

        if (this._applyReplacementTo(cur, replacement) === 'skipped') {
            // Замена опустошила бы подпись/тело ссылки/сноски — пропущена, DOM не
            // тронут. keepIdx: НЕ сбрасываем курсор на первое совпадение (набор не
            // изменился) — пользователь остаётся на текущей позиции (#6).
            Notifications.warning('Замена пропущена: она опустошила бы ссылку/сноску');
            this._runSearch({ keepIdx: true });
            return;
        }
        target.persist();
        // Контент изменён другим путём — снимок «Заменить всё» протух.
        this._clearUndo();

        // Смещения B1 сдвинулись — пересобираем; keepIdx оставляет курсор на
        // позиции (пересобранный список = «следующее» совпадение).
        this._runSearch({ keepIdx: true });
    },

    /** @private Заменяет ВСЕ совпадения (с подтверждением) + custom-undo. */
    async _replaceAll() {
        if (AppConfig.readOnlyMode && AppConfig.readOnlyMode.isReadOnly) return;
        // Свежие совпадения до замены (дебаунс 150мс мог ещё не сработать) — иначе
        // быстрый ввод-затем-«Заменить всё» заменил бы совпадения ПРЕДЫДУЩЕГО
        // запроса (пересбор во время диалога-подтверждения не трогает DOM, старые
        // Range остаются валидны → детерминированное затирание не того текста).
        // Тот же гард, что в _replaceCurrent и _go.
        this._flushSearch();
        if (this._matches.length === 0) return;
        // Новый пакет вытесняет прежний одношаговый undo.
        this._clearUndo();
        const replacement = this._els.replaceInput.value;

        // Число затронутых блоков — для ТЕКСТА диалога (read-only, до подтверждения).
        const blocksForMessage = this._blockIdsFor(this._matches);
        const confirmed = await DialogManager.show({
            title: 'Замена',
            message: buildReplaceAllConfirmMessage(this._matches.length, blocksForMessage.size),
            confirmText: 'Заменить всё',
            cancelText: 'Отмена',
            type: 'warning',
        });
        if (!confirmed) return;

        // Цели/группы для РЕАЛЬНОЙ мутации собираем ПОСЛЕ подтверждения: показ
        // диалога асинхронен, между ним и «Заменить» состояние могло измениться —
        // резолвим цели на свежем DOM (раньше здесь была регрессия: цели строились
        // ДО диалога). blockId — по ВЛАДЕЮЩЕМУ текстблоку, не по составному
        // targetId сноски (см. _blockIdsFor).
        const groups = groupMatchesByTarget(this._matches);
        const targets = this._targetsById();
        const blockIdsTouched = new Set();
        for (const targetId of groups.keys()) {
            const t = targets.get(targetId);
            blockIdsTouched.add((t && t.blockId) ? t.blockId : targetId);
        }

        // Снимок ДО пакета — «before» для одношагового undo.
        const before = snapshotTextBlockContents(blockIdsTouched, AppState.textBlocks);
        // Violation-цели (rich-поля нарушений) — ПАРАЛЛЕЛЬНЫЙ снимок через
        // поверхности: их модель не в AppState.textBlocks (см. snapshotSurfaceContents).
        const surfaceTargets = [];
        for (const targetId of groups.keys()) {
            const t = targets.get(targetId);
            if (t && t.isViolationField) surfaceTargets.push(t);
        }
        const beforeSurfaces = snapshotSurfaceContents(surfaceTargets);

        let replaced = 0;
        let skipped = 0;
        // persist() = finalizeEdit(editor) владеющего блока — у TextBlockSearchTarget
        // и у КАЖДОЙ FootnoteBodySearchTarget одного блока это ОДИН и тот же editor.
        // Сначала применяем ВСЕ мутации (текст + все сноски блока), и только ПОТОМ
        // зовём persist() один раз на blockId — иначе ранний persist() (finalizeEdit
        // читает editor.innerHTML) зафиксировал бы блок ДО того, как в него попали
        // более поздние по циклу правки его же сносок/текста (потерянная запись).
        const blockTargets = new Map(); // blockId → любая цель этого блока (для persist())
        for (const [targetId, group] of groups) {
            const target = targets.get(targetId);
            if (!target) continue;
            // Внутри цели — С КОНЦА: более ранние offset'ы/Range остаются валидны,
            // т.к. правка позже по тексту не сдвигает предшествующие. Диспетчеризация
            // «тело сноски / DOM Range» — в _applyReplacementTo (единая точка).
            for (let i = group.length - 1; i >= 0; i--) {
                if (this._applyReplacementTo(group[i], replacement) === 'replaced') replaced++;
                else skipped++;
            }
            const blockId = target.blockId || targetId;
            blockTargets.set(blockId, target);
        }
        for (const target of blockTargets.values()) target.persist();

        // Единый глобальный проход по сноскам после всего пакета.
        if (typeof textBlockManager.renumberAllFootnotes === 'function') {
            textBlockManager.renumberAllFootnotes();
        }

        // Снимок ПОСЛЕ пакета — «after» для divergence-guard: undo вернёт блок
        // только если его content не менялся с момента замены (иначе «отмена»
        // затёрла бы более поздние правки юзера). Сноски нумеруются рантайм-
        // атрибутом, не в content, поэтому renumber выше «after» не смещает.
        const after = snapshotTextBlockContents(before.keys(), AppState.textBlocks);
        this._lastUndo = new Map();
        for (const [id, beforeContent] of before) {
            this._lastUndo.set(id, { before: beforeContent, after: after.get(id) });
        }
        // «after» violation-полей: те же цели — persist=commit пишет модель
        // синхронно, хост НЕ пере-рендерится, поэтому getContent видит результат
        // замены. Divergence-guard undo сверяет текущий getContent с этим «after».
        const afterSurfaces = snapshotSurfaceContents(surfaceTargets);
        this._lastUndoSurfaces = new Map();
        for (const [id, beforeContent] of beforeSurfaces) {
            this._lastUndoSurfaces.set(id, { before: beforeContent, after: afterSurfaces.get(id) });
        }
        if ((this._lastUndo.size > 0 || this._lastUndoSurfaces.size > 0) && this._els.undoBtn) {
            this._els.undoBtn.classList.remove('hidden');
        }

        if (skipped > 0) {
            const matchWord = pluralRu(skipped, ['совпадение', 'совпадения', 'совпадений']);
            Notifications.warning(
                `Заменено ${replaced}, пропущено ${skipped} (${matchWord} опустошило бы ссылку/сноску)`);
        } else {
            Notifications.success(`Заменено ${replaced}`);
        }
        this._runSearch();
    },

    /**
     * @private Одношаговая отмена последней «Заменить всё» с divergence-guard:
     * цель возвращается к снимку «before» ТОЛЬКО если её текущий content всё ещё
     * равен снимку «after» (т.е. не редактировалась с момента замены). Изменённые/
     * исчезнувшие цели пропускаются, чтобы не затереть правки. Две поверхности
     * снимка: текстблоки/сноски — по AppState.textBlocks; rich-поля нарушений —
     * через сами цели (getContent/setContent, снимок _lastUndoSurfaces).
     */
    _undoReplaceAll() {
        if (!this._lastUndo && !this._lastUndoSurfaces) return;
        let reverted = 0;
        let skipped = 0;

        // 1) Текстблоки/сноски — снимок по AppState.textBlocks.
        if (this._lastUndo) {
            const toRestore = new Map();
            for (const [id, snap] of this._lastUndo) {
                const tb = AppState.textBlocks ? AppState.textBlocks[id] : null;
                if (!tb || tb.content !== snap.after) {
                    skipped++;   // изменён или удалён с момента замены — не трогаем
                    continue;
                }
                toRestore.set(id, snap.before);
            }
            reverted += applySnapshotRestore(toRestore, AppState.textBlocks, (id) => {
                ItemsRenderer.updateTextBlock(id);
                // Откат — тот же сток, что прямая замена: changelog + точечный патч
                // превью (шаг 1). Без него превью оставалось бы с текстом ПОСЛЕ замены,
                // а откат не попадал в аудит-историю. saveContent читает уже
                // восстановленный tb.content (applySnapshotRestore записал его выше).
                const tb = AppState.textBlocks ? AppState.textBlocks[id] : null;
                if (tb && typeof textBlockManager.saveContent === 'function') {
                    textBlockManager.saveContent(id, tb.content);
                }
            });
        }

        // 2) Rich-поля нарушений — снимок через поверхности; цели пере-резолвим
        // по СВЕЖЕМУ DOM (targetsById), divergence-guard по getContent()===after,
        // restore через target.setContent(before) (ре-рендер + синк --empty внутри).
        if (this._lastUndoSurfaces) {
            const res = restoreSurfaceSnapshot(this._lastUndoSurfaces, this._targetsById());
            reverted += res.restored;
            skipped += res.skipped;
        }

        // #7: паритет с «Заменить всё» (та тоже перенумеровывает после пакета).
        // Прямой триггер — опустевшая сноска, менявшая сквозной счёт — снят
        // защитой от опустошения (#1), но откат обязан быть точным инверсом:
        // если число «действующих» сносок как-то изменилось, номера в НЕтронутых
        // блоках без сквозного прохода останутся сбитыми (нумерация — сквозная
        // по всему акту, не по одному блоку).
        if (typeof textBlockManager.renumberAllFootnotes === 'function') {
            textBlockManager.renumberAllFootnotes();
        }
        this._clearUndo();

        const blockWord = pluralRu(reverted, ['блок', 'блока', 'блоков']);
        if (skipped > 0) {
            Notifications.warning(
                `Возвращено ${reverted} ${blockWord}; ${skipped} пропущено (изменены после замены)`);
        } else {
            Notifications.success(`Возвращено ${reverted} ${blockWord}`);
        }
        this._runSearch();
    },

    /** @private Инвалидирует снимок одношагового undo (обе поверхности) и прячет его кнопку. */
    _clearUndo() {
        this._lastUndo = null;
        this._lastUndoSurfaces = null;
        if (this._els.undoBtn) this._els.undoBtn.classList.add('hidden');
    },
};

// Window-global для совместимости с inline-скриптами в шаблонах.
window.FindBar = FindBar;
