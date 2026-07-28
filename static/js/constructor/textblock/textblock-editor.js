/**
 * Расширение для работы с редактором
 */
import { PreviewManager } from '../preview/preview.js';
import { TextBlockManager, isCapsuleNode, isZeroWidthNode } from './textblock-core.js';
import { RENDER_CLASSES } from '../render-classes.js';
import { AppConfig } from '../../shared/app-config.js';
import { SafeHTML, SAFE_HTML_PROFILES, renderActContent } from '../../shared/sanitize.js';
import { getStructureLimits } from '../violation/violation-image-validator.js';
import { TextBlockSurface } from './editable-surface.js';
import { EditorRegistry, SURFACE_POLICY } from './editor-registry.js';

Object.assign(TextBlockManager.prototype, {
    /**
     * Создаёт DOM-элемент текстового блока с редактором.
     * Перед созданием отключает observer старого редактора (если он ещё в DOM),
     * чтобы при replaceChild (ItemsRenderer.updateTextBlock) не осталось зависших
     * observer'ов на detached-узлах — предотвращает утечки памяти.
     */
    createTextBlockElement(textBlock, node) {
        // Teardown: если в DOM уже есть редактор с тем же id — отключаем его observer.
        const oldEditor = document.querySelector(
            `.textblock-editor[data-text-block-id="${textBlock.id}"]`,
        );
        if (oldEditor && oldEditor.__capsuleObserver) {
            oldEditor.__capsuleObserver.disconnect();
            oldEditor.__capsuleObserver = null;
        }

        const section = document.createElement('div');
        section.className = RENDER_CLASSES.TEXTBLOCK_SECTION;
        section.dataset.textBlockId = textBlock.id;

        const editor = this.createEditor(textBlock);
        section.appendChild(editor);

        return section;
    },

    /**
     * Создаёт элемент редактора
     */
    createEditor(textBlock) {
        const editor = document.createElement('div');
        editor.className = RENDER_CLASSES.TEXTBLOCK_EDITOR;
        editor.dataset.textBlockId = textBlock.id;
        editor.dataset.placeholder = 'Введите текст...';
        // Sanitize: textBlock.content приходит из БД, мог быть сохранён до того,
        // как backend начнёт чистить через bleach. DOMPurify обрабатывает любой
        // вектор stored-XSS на клиенте. CORE-1: профиль 'acts' (не дефолтный
        // blocklist) — редактируемая поверхность должна совпадать с тем, что
        // реально допускает бэк-санитайзер и что отрисует превью.
        renderActContent(editor, textBlock.content || '');

        // O1: чиним уже-битые капсулы старых актов при открытии (дубль-id и т.п.).
        if (this.validateAndRepairCapsules) {
            renderActContent(editor, this.validateAndRepairCapsules(editor.innerHTML));
        }

        // BUG-2.2: бэк-санитайзер (bleach, html_sanitizer.py) срезает с маркеров
        // contenteditable — его НЕТ в allowlist'е span-атрибутов (рантайм-only,
        // как data-footnote-number). Возвращаем его при каждом рендере из
        // сохранённого контента, иначе после reload капсула редактируема:
        // каретка заходит внутрь, а Enter у её границы клонирует маркер.
        this.normalizeMarkers(editor);

        // B-26: начальное состояние пустоты — JS-класс, не CSS :empty
        // (:empty ненадёжен в contenteditable: после ввода/удаления остаётся <br>/<div>).
        this._toggleEmptyClass(editor);

        // Привязываем tooltip к ссылкам/сноскам сразу при создании
        this._attachInitialTooltipHandlers(editor);

        // Отключаем редактирование в режиме только чтения
        if (AppConfig.readOnlyMode?.isReadOnly) {
            editor.contentEditable = 'false';
            editor.classList.add('read-only');
            // CARET-2 (перенос между актами): редактировать в RO нельзя, но
            // КОПИРОВАТЬ можно — навешиваем copy (не cut) со strip guard'ов
            // (U+FEFF в RO-DOM есть: normalizeMarkers выше отрабатывает до RO-ветки)
            // и меткой data-aw-clip. editor берётся замыканием (activeEditor RO не
            // ставит) — handleEditorCopy передаёт его в _expandRangeOutOfMarkers.
            editor.addEventListener('copy', (e) => this.handleEditorCopy(e, editor, false));
        } else {
            editor.contentEditable = 'true';
            this.attachEditorEvents(editor, textBlock);
            // Слой 3: MutationObserver-страховка целостности капсул.
            this.installCapsuleObserver(editor);
        }

        this.applyBaseFontSize(editor);

        return editor;
    },

    /**
     * BUG-2.2 + каретка (гибрид Варианта 2): рантайм-нормализация маркеров при
     * каждом рендере/структурной правке. Делает две вещи:
     *  1. Ре-применяет contenteditable="false" ко всем .text-link/.text-footnote.
     *     Атрибут НЕ хранится в БД (бэк-санитайзер его срезает, он рантайм-only,
     *     как data-footnote-number); без ре-применения после reload капсула
     *     редактируема.
     *  2. Расставляет невидимые caret-guard'ы (U+FEFF) у проблемных границ
     *     капсул (ведущая/хвостовая/смежные), где браузер не даёт поставить
     *     каретку рядом с contenteditable=false-атомом. Идемпотентно: сначала
     *     снимаем все старые guard'ы, потом расставляем заново. Guard'ы живут
     *     ТОЛЬКО в живом DOM — стрипаются при сохранении (_stripGuards) и на
     *     DOCX-экспорте, в БД/превью/Word не попадают. guard=U+FEFF, НЕ U+200B
     *     (последний занят якорем размера в applyFontSize).
     * @param {HTMLElement} editor
     */
    normalizeMarkers(editor) {
        if (!editor || typeof editor.querySelectorAll !== 'function') return;
        editor.querySelectorAll('.text-link, .text-footnote').forEach(marker => {
            if (marker.getAttribute('contenteditable') !== 'false') {
                marker.setAttribute('contenteditable', 'false');
            }
        });
        this._cleanCapGuards(editor);
        this._placeCapGuards(editor);
    },

    /** Символ-«пустышка» caret-guard'а (U+FEFF, BOM/zero-width-no-break-space). */
    CAP_GUARD_CHAR: '\uFEFF',

    /** @private Узел — это inline-капсула (ссылка/сноска)? Делегат единого
     *  предиката isCapsuleNode (textblock-core.js) — тот же, что использует движок
     *  поиска, чтобы «граница капсулы» не дрейфовала между слоями. */
    _isCapsule(node) {
        return isCapsuleNode(node);
    },

    /** @private Текстовый узел — чистый caret-guard (один U+FEFF)? */
    _isGuardNode(node) {
        return !!(node && node.nodeType === Node.TEXT_NODE && node.data === this.CAP_GUARD_CHAR);
    },

    /** @private Узел — элемент переноса строки <br>? */
    _isBreak(node) {
        return !!(node && node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR');
    },

    /**
     * @private Узел НЕ даёт каретке видимой точки опоры рядом с капсулой:
     * пустой/zero-width текст (включая U+FEFF-guard и U+200B-якорь размера) ЛИБО
     * инлайн-элемент, состоящий ТОЛЬКО из zero-width-символов (например
     * span-якорь размера со вставленным U+200B из applyFontSize). Капсулы, <br>,
     * <img> и пустые элементы — НЕ zero-width (значимые границы/атомы).
     */
    _isZeroWidthNode(n) {
        return isZeroWidthNode(n); // делегат единого предиката (textblock-core.js)
    },

    /**
     * @private Ближайший сосед, дающий каретке видимую точку опоры: пропускает
     * zero-width-узлы (_isZeroWidthNode) — иначе якорь размера (U+200B-span),
     * прилёгший к капсуле, маскировал бы границу строки и блокировал расстановку
     * guard'а (ломая вертикальную навигацию после смены размера). Возвращает
     * null / <br> / капсулу / значимый узел.
     */
    _caretHomeSibling(node, dir) {
        let n = node[dir];
        while (this._isZeroWidthNode(n)) n = n[dir];
        return n;
    },

    /** @private Текстовый узел незначим (пустой ИЛИ caret-guard U+FEFF). */
    _isInsignificantText(n) {
        return n && n.nodeType === Node.TEXT_NODE &&
            (n.data === '' || n.data === this.CAP_GUARD_CHAR);
    },

    /** @private Соседний значимый узел (пропускает пустые тексты и guard'ы). */
    _significantSibling(node, dir) {
        let n = node ? node[dir] : null;
        while (this._isInsignificantText(n)) n = n[dir];
        return n;
    },

    /** @private Первый значимый ребёнок (пропускает пустые/guard'ы). */
    _firstSignificantChild(editor) {
        let n = editor.firstChild;
        while (this._isInsignificantText(n)) n = n.nextSibling;
        return n;
    },

    /**
     * @private Первый значимый узел ТЕКУЩЕЙ визуальной строки каретки. Строки
     * блока разделены <br> (Enter). В отличие от _firstSignificantChild (первый
     * ребёнок всего блока) уважает строку, на которой стоит каретка — иначе Home
     * на 3-й строке телепортировал бы к капсуле 1-й строки (#12).
     * @param {Range} range collapsed-каретка
     * @param {HTMLElement} editor
     * @returns {Node|null}
     */
    _currentLineFirstNode(range, editor) {
        // Поднимаемся к прямому ребёнку editor, в котором стоит каретка.
        let node = range.startContainer;
        if (node === editor) {
            node = editor.childNodes[range.startOffset] || editor.lastChild;
        } else {
            while (node && node.parentNode && node.parentNode !== editor) {
                node = node.parentNode;
            }
        }
        if (!node) return null;
        // Назад до <br> (конец предыдущей строки) или до начала блока.
        while (node.previousSibling && node.previousSibling.nodeName !== 'BR') {
            node = node.previousSibling;
        }
        // Пропускаем пустые/guard-узлы в начале строки → первый значимый.
        while (this._isInsignificantText(node)) node = node.nextSibling;
        return node;
    },

    /**
     * @private CARET-3: DOM-строка (между <br>) может визуально ПЕРЕНОСИТЬСЯ на
     * несколько экранных рядов в узком блоке. Капсула — первый узел строки —
     * физически лежит только на ПЕРВОМ ряду; на wrap-продолжении Home должен
     * вести к началу ТЕКУЩЕГО экранного ряда (нативное поведение), а не
     * телепортировать к капсуле. Сравниваем нижнюю границу ряда капсулы с
     * верхней точкой каретки: каретка ниже — она на другом (wrap) ряду. Если
     * измерить не удалось — не блокируем штатное поведение #12.
     * @param {Range} range схлопнутая каретка
     * @param {Element} first капсула — первый узел DOM-строки
     * @returns {boolean}
     */
    _isCaretOnCapsuleRow(range, first) {
        const capRect = first.getClientRects()[0];
        if (!capRect) return true;
        const caretRect = range.getClientRects()[0] || range.getBoundingClientRect();
        if (!caretRect) return true;
        return caretRect.top < capRect.bottom - 1;
    },

    /**
     * @private Снимает caret-guard'ы: чистые U+FEFF-узлы удаляет, а U+FEFF
     * ВНУТРИ текста с реальными символами (guard, в который успели напечатать)
     * срезает, сохраняя текст. Идемпотентно. U+200B (якорь размера) не трогает.
     */
    _cleanCapGuards(editor) {
        const guardChar = this.CAP_GUARD_CHAR;
        const toRemove = [];
        const walk = (node) => {
            let child = node.firstChild;
            while (child) {
                const next = child.nextSibling;
                if (child.nodeType === 3) {              // TEXT_NODE
                    if (child.data === guardChar) {
                        toRemove.push(child);
                    } else if (child.data && child.data.indexOf(guardChar) !== -1) {
                        child.data = child.data.split(guardChar).join('');
                    }
                } else if (child.nodeType === 1 && child.firstChild) {  // ELEMENT_NODE
                    walk(child);
                }
                child = next;
            }
        };
        if (editor && editor.firstChild) walk(editor);
        toRemove.forEach(t => { if (t.parentNode) t.parentNode.removeChild(t); });
    },

    /**
     * @private Ставит caret-guard'ы у проблемных границ капсул — там, где каретке
     * иначе негде приземлиться вплотную к contenteditable=false-атому: нет
     * обычного текста, а есть КРАЙ блока (начало/конец родителя), ПЕРЕНОС <br>
     * или другая капсула. Где сбоку обычный текст — guard НЕ ставим (каретка
     * встаёт штатно; guard'ы вокруг каждой капсулы ломали бы обычный ввод).
     * Зовётся ПОСЛЕ _cleanCapGuards (в DOM нет старых guard'ов).
     *
     * Ведущий guard важен и для капсулы в начале ВИЗУАЛЬНОЙ строки (первый
     * значимый ребёнок блока ИЛИ сразу после <br>): без него нативная Up/Down-
     * навигация Chromium проскакивает строку-капсулу, а после переноса перед
     * капсулой нельзя встать с клавиатуры (раньше покрывались только капсулы у
     * краёв самого редактора и пары смежных капсул).
     */
    _placeCapGuards(editor) {
        const g = () => document.createTextNode(this.CAP_GUARD_CHAR);
        editor.querySelectorAll('.text-link, .text-footnote').forEach(m => {
            // Ведущий guard: слева нет видимой точки опоры — край блока (null),
            // перенос (<br>) или капсула. _caretHomeSibling пропускает и
            // zero-width-якоря размера (U+200B-span), иначе они блокировали бы
            // guard и ломали вертикальную навигацию после смены размера.
            const prev = this._caretHomeSibling(m, 'previousSibling');
            if (prev === null || this._isBreak(prev) || this._isCapsule(prev)) {
                m.parentNode.insertBefore(g(), m);
            }
            // Хвостовой guard — только у края блока (null) или переноса (<br>):
            // между двумя смежными капсулами guard уже поставлен как ВЕДУЩИЙ у
            // правой, второй там не нужен.
            const next = this._caretHomeSibling(m, 'nextSibling');
            if (next === null || this._isBreak(next)) {
                m.parentNode.insertBefore(g(), m.nextSibling);
            }
        });
    },

    /**
     * @private Убирает caret-guard'ы (U+FEFF) из HTML-строки перед сохранением в
     * content/БД. Guard'ы — рантайм-only, в хранимый контент/превью/DOCX не
     * попадают. U+200B (якорь размера) сознательно НЕ трогаем.
     */
    _stripGuards(html) {
        return typeof html === 'string' ? html.split(this.CAP_GUARD_CHAR).join('') : html;
    },

    /**
     * @private TB-4: снимает ОСИРОТЕВШИЕ якоря размера из ЖИВОГО DOM перед
     * сериализацией — span'ы с inline font-size, чьё содержимое ТОЛЬКО U+200B
     * (материализация «размера на каретке» из applyFontSize), ПОД КАРЕТКОЙ
     * которых уже никого нет (пользователь ушёл, не напечатав). Без этого якоря
     * копятся в content годами: дают ложный смешанный размер и раздувают разметку.
     * Заодно чистит ГОЛЫЕ текстовые узлы из одного U+200B без span-обёртки —
     * removeFormat разворачивает якорь именно в такой узел (селектор
     * span[style] его уже не находит).
     *
     * B-2 (регрессия ЗАПРЕЩЕНА): якорь, ВНУТРИ которого стоит текущая каретка, —
     * это «живая» материализация размера, обязанная пережить сохранение; его НЕ
     * трогаем. Каретку читаем из живого Selection; её ZWSP-узел переживает
     * normalizeMarkers (та чистит только U+FEFF), поэтому проверка надёжна и
     * после нормализации капсул. Идемпотентно.
     *
     * ignoreCaret=true — режим blur: каретка ПОКИДАЕТ редактор, поэтому B-2 не
     * применяем (Selection на blur ещё может указывать внутрь якоря, но
     * пользователь уже ушёл, не напечатав → якорь осиротел). Иначе такие якоря
     * утекали бы в сохранённый content: обычный blur-путь finalizeEdit —
     * единственный их чистильщик — не вызывал.
     * @param {HTMLElement} editor
     * @param {{ignoreCaret?: boolean}} [opts={}]
     */
    _cleanOrphanSizeAnchors(editor, { ignoreCaret = false } = {}) {
        if (!editor || typeof editor.querySelectorAll !== 'function') return;
        if (typeof this._isZeroWidthNode !== 'function'
            || typeof this._isCapsule !== 'function') return;
        const sel = (!ignoreCaret && typeof window !== 'undefined' && typeof window.getSelection === 'function')
            ? window.getSelection() : null;
        const caretNode = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0).startContainer : null;
        editor.querySelectorAll('span[style]').forEach(span => {
            if (this._isCapsule(span) || !span.style || !span.style.fontSize) return;
            // Якорь = span, содержимое которого — только zero-width (U+200B).
            if (!this._isZeroWidthNode(span)) return;
            // B-2: каретка внутри якоря → это живая материализация размера, не трогаем.
            if (caretNode && typeof span.contains === 'function' && span.contains(caretNode)) return;
            span.remove();
        });

        // removeFormat-unwrap: тот же якорь, но БЕЗ span-обёртки — голый
        // текстовый узел из одного U+200B. U+FEFF (caret-guard) сюда НЕ входит,
        // его чистит _cleanCapGuards отдельно. Каретка внутри текстового узла —
        // это сам узел (startContainer), поэтому сравниваем по ссылке (B-2).
        const bareAnchors = [];
        const walk = (node) => {
            let child = node.firstChild;
            while (child) {
                if (child.nodeType === Node.TEXT_NODE && /^[\u200B]+$/.test(child.data)) {
                    bareAnchors.push(child);
                } else if (child.nodeType === Node.ELEMENT_NODE && child.firstChild) {
                    walk(child);
                }
                child = child.nextSibling;
            }
        };
        walk(editor);
        bareAnchors.forEach(t => {
            if (t === caretNode) return;
            if (t.parentNode) t.parentNode.removeChild(t);
        });
    },

    /**
     * Привязывает tooltip-обработчики к ссылкам/сноскам при начальном рендере
     * Обработчики будут заменены полным набором при фокусе редактора
     * @private
     */
    _attachInitialTooltipHandlers(editor) {
        const elements = editor.querySelectorAll('.text-link, .text-footnote');

        elements.forEach(element => {
            // Слушатели через per-element AbortController _lfAbort: при фокусе
            // редактора attachLinkFootnoteHandlers вызовет abort() и навесит
            // полный набор — initial tooltip-обработчики не задвоятся.
            if (element._lfAbort) element._lfAbort.abort();
            const controller = new AbortController();
            element._lfAbort = controller;
            const { signal } = controller;

            element.addEventListener('mouseenter', () => {
                this.tooltipTimeout = setTimeout(() => {
                    this.showTooltip(element);
                }, 700);
            }, { signal });

            element.addEventListener('mouseleave', () => {
                this.hideTooltip();
            }, { signal });
        });
    },

    /**
     * B-26: тоггл класса .textblock-editor--empty по реальной пустоте.
     * Пусто = нет видимого текста И нет значимых элементов (картинок/маркеров).
     * @private
     */
    _toggleEmptyClass(editor) {
        // U+FEFF (caret-guard) и U+200B (якорь размера) невидимы, но переживают
        // String.trim() — вычищаем их перед проверкой, иначе блок из одних
        // невидимок считался бы непустым и placeholder не показывался.
        const hasText = editor.textContent.replace(/[\uFEFF\u200B]/g, '').trim().length > 0;
        const hasInlineEl = editor.querySelector('.text-link, .text-footnote, img') !== null;
        editor.classList.toggle('textblock-editor--empty', !hasText && !hasInlineEl);
    },

    /**
     * Привязывает обработчики событий к редактору
     */
    attachEditorEvents(editor, textBlock) {
        editor.addEventListener('focus', () => this.handleEditorFocus(editor, textBlock));
        editor.addEventListener('blur', () => this.handleEditorBlur(editor, textBlock));
        editor.addEventListener('beforeinput', (e) => this.handleEditorBeforeInput(e, editor, textBlock));
        editor.addEventListener('input', () => this.handleEditorInput(editor, textBlock));
        editor.addEventListener('keydown', (e) => this.handleEditorKeydown(e, editor, textBlock));
        editor.addEventListener('paste', (e) => this.handleEditorPaste(e, editor, textBlock));
        editor.addEventListener('copy', (e) => this.handleEditorCopy(e, editor, false));
        editor.addEventListener('cut', (e) => this.handleEditorCopy(e, editor, true));
        editor.addEventListener('mouseup', () => this.handleSelectionChange());
        editor.addEventListener('keyup', () => this.handleSelectionChange());
    },

    /**
     * Создаёт EditableSurface-обёртку (TextBlockSurface) для DOM-редактора.
     * @private
     */
    _makeTextBlockSurface(editor) {
        return new TextBlockSurface(editor, this);
    },

    /**
     * Единая точка активации поверхности текстблок-редактора. Источник истины
     * «кто сейчас активен» — surface в EditorRegistry; this.activeEditor держим
     * как его ЭЛЕМЕНТ-проекцию (мост для легаси-читателей тулбара/форматирования).
     * V17: раньше this.activeEditor выставлялся ОТДЕЛЬНЫМ вызовом setActiveEditor
     * в handleEditorFocus — параллельно реестру, из-за чего это были два
     * независимых источника истины (могли разъехаться). Теперь activeEditor
     * пишется ТОЛЬКО здесь как surface.element, в лок-степе с реестром.
     * @private
     */
    _activateSurfaceForEditor(editor) {
        const surface = this._makeTextBlockSurface(editor);
        EditorRegistry.setActive(surface);
        this.setActiveEditor(surface.element);
        return surface;
    },

    /**
     * Ownership-guard: снимает активную поверхность в EditorRegistry и её
     * элемент-проекцию this.activeEditor, только если ими всё ещё владеет ИМЕННО
     * этот editor. Без проверки стейл-блюр A при быстром переходе фокуса A→B
     * затирал бы поверхность, которой уже владеет B. V17: реестр и мост
     * this.activeEditor снимаются здесь в лок-степе (симметрия
     * _activateSurfaceForEditor) — единый источник истины не расходится.
     * @private
     */
    _clearSurfaceIfOwned(editor) {
        if (EditorRegistry.getActive()?.element === editor) {
            EditorRegistry.clear();
            this.clearActiveEditor();
        }
    },

    /**
     * Обработчик фокуса редактора
     */
    handleEditorFocus(editor, textBlock) {
        // V17: _activateSurfaceForEditor выставляет и surface в реестре, и мост
        // this.activeEditor (surface.element) разом — отдельный setActiveEditor
        // здесь больше не нужен (был вторым источником истины).
        this._activateSurfaceForEditor(editor);
        this.showToolbar();
        this.updateToolbarState();
        this.attachLinkFootnoteHandlers();

        // Применяем форматирование к ссылкам и сноскам при фокусе
        this.applyFormattingToNewNodes(editor);
    },

    /**
     * Обработчик потери фокуса
     */
    handleEditorBlur(editor, textBlock) {
        // «Вся капсула как юнит»: снимаем визуальную .node-selected отметку —
        // выделение покидает редактор (handleSelectionChange его уже не чистит).
        // Данные и так чисты (strip в _repairCapsulesInRoot), это только косметика.
        // Единый сток снятия: O(1) по кэшу + editor-скоуп sweep (blur нечаст).
        this._clearNodeSelected(editor);

        // Если фокус ушёл ДО compositionend (IME прервана внешне) — буфер
        // __composingRecords иначе провисит до следующего ввода в этот
        // редактор. Идемпотентно: при штатном compositionend __composing уже
        // false и буфер уже слит — повторный вызов ничего не находит.
        if (typeof this._flushComposition === 'function') this._flushComposition(editor);

        // Blur = каретка покидает редактор: осиротевшие якоря размера (span, чьё
        // содержимое — только U+200B, пользователь выбрал размер и ушёл, не
        // напечатав) чистим из живого DOM ДО сериализации, игнорируя B-2. Иначе
        // они утекали бы в сохранённый content — обычный blur-путь ниже пишет
        // textBlock.content напрямую, минуя finalizeEdit (единственный чистильщик).
        if (typeof this._cleanOrphanSizeAnchors === 'function') {
            this._cleanOrphanSizeAnchors(editor, { ignoreCaret: true });
        }

        const s = this._stripGuards(editor.innerHTML);
        // CORE-2b: сериализуем с признаком РЕАЛЬНОЙ починки капсул. Косметика
        // (снятие contenteditable, ре-сериализация) меняет строку всегда, поэтому
        // сравнивать repaired!==s нельзя — берём changed из отчёта валидатора.
        const report = (typeof this._repairCapsulesReport === 'function')
            ? this._repairCapsulesReport(s)
            : { html: s, changed: false };
        textBlock.content = report.html;

        // Валидатор реально чинил капсулу (дубль-id, расщеплённый клон, пустая
        // капсула) → живой DOM разошёлся с сохранённым content: возвращаем
        // починенный HTML в редактор (renderActContent, Task 8), иначе до
        // ре-рендера пользователь видит битую капсулу. Только на blur (не во
        // время печати). Гард __healing глушит observer, чтобы write-back не
        // вызвал heal-шторм; finalizeEdit (Task 1) нормализует guard'ы/нумерацию
        // по починенному DOM и запишет content. Каретку не восстанавливаем —
        // фокуса на blur уже нет.
        if (report.changed) {
            editor.__healing = true;
            try {
                renderActContent(editor, report.html);
                this.finalizeEdit(editor);
            } finally {
                if (editor.__capsuleObserver) editor.__capsuleObserver.takeRecords();
                editor.__healing = false;
            }
        }

        // Точечный апдейт превью сразу при blur: input-debounce (500мс) мог не
        // успеть сработать, и превью оставалось бы с устаревшим текстом до
        // следующего ввода. Сбрасываем висящий save-таймер — он бы повторил
        // ту же работу. Тот же узкий патч, что у saveContent (updateBlock).
        if (editor.saveTimeout) {
            clearTimeout(editor.saveTimeout);
            editor.saveTimeout = null;
        }
        PreviewManager.updateBlock('textblock', textBlock.id);

        setTimeout(() => {
            // Ownership-guard: если фокус ушёл на ДРУГОЙ текстблок, его
            // handleEditorFocus уже выполнил _activateSurfaceForEditor(B) →
            // this.activeEditor указывает на B, не на этот editor(A). Стейл-таймер
            // A не должен гасить тулбар, которым теперь владеет B (иначе тулбар
            // мигает и пропадает при каждом переходе между блоками). Прячем только
            // когда ЭТОТ редактор всё ещё активный владелец, а фокус ушёл наружу
            // (не в редактор и не в тулбар).
            if (this.activeEditor === editor &&
                document.activeElement !== editor &&
                !this.globalToolbar?.contains(document.activeElement)) {
                this.hideToolbar();
                // V17: _clearSurfaceIfOwned снимает и реестр, и мост
                // this.activeEditor разом (в лок-степе) — отдельный
                // clearActiveEditor больше не нужен.
                this._clearSurfaceIfOwned(editor);
            }
        }, 200);
    },

    /**
     * Обработчик ввода с debounce
     */
    handleEditorInput(editor, textBlock) {
        // CARET-1: пока капсула редактируется inline (двойной клик, класс
        // editing-mode), автосток редактора на паузе — его finalizeEdit сбросил
        // бы contenteditable редактируемой капсулы (normalizeMarkers) и сохранил
        // бы служебный класс editing-mode в content. Событие input долетает сюда
        // всплытием из капсулы; финальное сохранение делает finishEditing на
        // выходе из режима (→ finalizeEdit).
        if (editor.querySelector('.editing-mode')) return;

        // B-26: пустоту определяем синхронно при каждом вводе — мгновенный
        // показ/скрытие placeholder, без зависимости от save-debounce.
        this._toggleEmptyClass(editor);

        if (editor.saveTimeout) {
            clearTimeout(editor.saveTimeout);
        }

        editor.saveTimeout = setTimeout(() => {
            // Наследуем форматирование на новые ссылки/сноски ДО стока, чтобы
            // применённые стили попали в сериализованный content (см. #14).
            this.applyFormattingToNewNodes(editor);
            // Единый сток: normalize-if-капсулы + перенумерация-по-изменению +
            // empty-class + saveContent (changelog внутри, TB-5). Нативное
            // удаление/paste могли изменить число сносок — finalizeEdit ловит это
            // и перенумеровывает (CARET-7).
            this.finalizeEdit(editor);
        }, 500);
    },

    /**
     * Обработчик вставки. Два режима по метке происхождения data-aw-clip:
     *  - свой буфер (data-aw-clip) — round-trip капсул: реконструкция ссылок/
     *    сносок фабриками со свежими id + сохранение инлайн-формата (CARET-2);
     *  - внешний HTML — прежняя строгая политика «только ссылки» (4г).
     * Вставка идёт через execCommand('insertHTML') — остаётся в нативном undo
     * (§6.9). Гейт пустоты (CARET-6): пустой после санитизации фрагмент НЕ съедает
     * выделение (никакого deleteContents до проверки), а откатывается в insertText.
     */
    handleEditorPaste(e, editor, textBlock) {
        e.preventDefault();

        const html = e.clipboardData.getData('text/html');
        const plain = e.clipboardData.getData('text/plain');

        // CARET-1: вставка во время inline-правки капсулы (двойной клик) идёт
        // ПЛЕЙН-текстом в её тело — HTML/капсулам внутри капсулы места нет. Наши
        // слои её не клоббят (editing-mode), нативный insertText остаётся в undo;
        // финальное сохранение делает finishEditing на выходе из режима.
        if (editor.querySelector('.editing-mode')) {
            if (plain) document.execCommand('insertText', false, plain);
            return;
        }

        // Выделение — текущее (paste вставляет в каретку); сток общий с drop.
        this._insertSanitizedHtml(editor, html, plain);
    },

    /**
     * Общий сток санитизированной HTML-вставки для paste и drop: строит фрагмент
     * ТЕМ ЖЕ путём (_buildPasteFragment → санитизация DOMPurify + реконструкция
     * капсул + гейт сносок), вставляет в ТЕКУЩЕЕ выделение через insertHTML
     * (атомарно за целые капсулы, остаётся в undo) и финализирует. Пустой/
     * санитизированный-в-ноль HTML деградирует до plain-текста. Выделение/каретку
     * выставляет ВЫЗЫВАЮЩИЙ (paste — текущее, drop — точку сброса) — сюда приходит
     * готовым.
     * @param {HTMLElement} editor
     * @param {string} html
     * @param {string} plain
     * @param {boolean} [footnotesBlocked] Явный гейт сносок (drop — из захваченной
     *   поверхности). undefined → берётся из активной поверхности EditorRegistry
     *   (paste, у которого фокус на поле).
     */
    _insertSanitizedHtml(editor, html, plain, footnotesBlocked) {
        // Нет HTML — прежний путь: только чистый текст.
        if (!html || !html.trim()) {
            document.execCommand('insertText', false, plain);
            this.finalizeEdit(editor);
            return;
        }

        const fragment = this._buildPasteFragment(html, footnotesBlocked);

        // Гейт пустоты (CARET-6): DOMPurify мог вырезать весь фрагмент (например
        // «Копировать изображение» кладёт только <img> при пустом plain). Проверку
        // делаем ДО любой правки выделения — никакого deleteContents, иначе
        // выделение исчезало бы без вставки и без undo. Пусто → откат в insertText
        // (вернёт и undo); при пустом plain — no-op, выделение не трогаем.
        if (!fragment.childNodes.length) {
            if (plain) {
                document.execCommand('insertText', false, plain);
                this.finalizeEdit(editor);
            } else {
                // §6.8: и HTML санитизирован в ноль, и plain пуст — вставка
                // ничего не даёт (частый кейс «Копировать изображение» в текст).
                window.EditorTelemetry?.track?.('empty_paste');
            }
            return;
        }

        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            // Атомарность: выделение, клипающее тело капсулы, расширяем за целые
            // капсулы — иначе insertHTML (как deleteContents) надкусит атом.
            // editor передаём явно (не полагаемся на activeEditor).
            if (typeof this._expandRangeOutOfMarkers === 'function') {
                this._expandRangeOutOfMarkers(range, editor);
                selection.removeAllRanges();
                selection.addRange(range);
            }
            // insertHTML (не insertNode) — вставка остаётся в нативном undo-стеке.
            // Фрагмент уже безопасен: капсулы реконструированы (свежие id,
            // contenteditable=false, URL прогнан через validateLinkUrl).
            const holder = document.createElement('div');
            holder.appendChild(fragment);
            document.execCommand('insertHTML', false, holder.innerHTML);
        } else {
            // Нет каретки — деградируем до plain-text.
            document.execCommand('insertText', false, plain);
        }

        // Наследуем форматирование на новые маркеры (как при ручном создании).
        // #14: ДО стока — иначе унаследованный размер вставленной ссылки
        // мутируется только в живом DOM и не попадает в сериализованный content
        // до blur (paste не ставит saveTimeout → flushActiveEditor — no-op).
        this.applyFormattingToNewNodes(editor);
        // Единый сток: normalize (guard'ы у вставленных маркеров) + перенумерация
        // (paste поверх сноски мог её удалить — CARET-7) + empty-class +
        // saveContent (+ changelog).
        this.finalizeEdit(editor);
        // BUG-4: навешиваем ПОЛНЫЙ набор обработчиков (tooltip/contextmenu/
        // dblclick/клик-каретка) на вставленные маркеры сразу. Иначе ссылка из
        // Word оживала (наведение/редактирование) только при следующем фокусе —
        // перезаход на шаг, перезагрузка или клик в другое поле и обратно.
        this.attachLinkFootnoteHandlers();
    },

    /**
     * @private Range в точке сброса drag'а (курсор мыши). caretRangeFromPoint —
     * Chromium (десктоп-онли, см. CLAUDE.md a11y). null, если API недоступно или
     * точка вне редактора — тогда _insertSanitizedHtml вставит в текущее выделение.
     * @param {DragEvent} e
     * @param {HTMLElement} editor
     * @returns {Range|null}
     */
    _dropCaretRange(e, editor) {
        if (typeof document.caretRangeFromPoint !== 'function') return null;
        const r = document.caretRangeFromPoint(e.clientX, e.clientY);
        if (!r) return null;
        if (editor && typeof editor.contains === 'function' && !editor.contains(r.startContainer)) {
            return null;
        }
        return r;
    },

    /**
     * CORE-4 + CARET-2: копирование/вырезание выделения в буфер СВОИМ форматом.
     * Кладёт в clipboardData text/html (капсулы — как есть, span с data-атрибутами,
     * под меткой происхождения data-aw-clip) и text/plain, предварительно стрипнув
     * caret-guard'ы (U+FEFF) — иначе невидимка утекает во внешние приложения
     * (CORE-4) и ломает обратную вставку. Выделение клонируется расширенным за
     * целые капсулы (атомарность). cut дополнительно удаляет выделение через
     * execCommand('delete') — остаётся в нативном undo (§6.9).
     * @param {ClipboardEvent} e
     * @param {HTMLElement} editor
     * @param {boolean} isCut true для cut, false для copy
     */
    handleEditorCopy(e, editor, isCut) {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        // Только выделение внутри ЭТОГО редактора — иначе не вмешиваемся.
        if (!editor.contains(range.commonAncestorContainer)) return;
        if (!e.clipboardData) return;

        e.preventDefault();

        // Клон выделения, расширенный за целые капсулы (не надкусываем атом).
        // editor передаём явно — RO-редактор не ставит activeEditor.
        const work = range.cloneRange();
        if (typeof this._expandRangeOutOfMarkers === 'function') {
            this._expandRangeOutOfMarkers(work, editor);
        }
        const wrapper = document.createElement('div');
        wrapper.setAttribute('data-aw-clip', '1');
        wrapper.appendChild(work.cloneContents());
        // Стрип caret-guard'ов (U+FEFF) из всего клона — рантайм-only, во внешние
        // приложения не отдаём. U+200B (якорь размера) в html оставляем: переживает
        // round-trip и сохраняет размер; из plain — вычищаем (в тексте он мусор).
        if (typeof this._cleanCapGuards === 'function') this._cleanCapGuards(wrapper);

        e.clipboardData.setData('text/html', wrapper.outerHTML);
        // text/plain: \u0441\u0435\u0440\u0438\u0430\u043B\u0438\u0437\u0443\u0435\u043C \u043A\u043B\u043E\u043D \u0441 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u0438\u0435\u043C \u043F\u0435\u0440\u0435\u043D\u043E\u0441\u043E\u0432 \u2014 <br> \u0438 \u0433\u0440\u0430\u043D\u0438\u0446\u044B
        // \u0431\u043B\u043E\u0447\u043D\u044B\u0445 \u044D\u043B\u0435\u043C\u0435\u043D\u0442\u043E\u0432 \u2192 \n. wrapper.textContent \u0438\u0445 \u0442\u0435\u0440\u044F\u043B (\u0441\u043A\u043B\u0435\u0438\u0432\u0430\u043B \u0432\u0441\u0451 \u0432 \u043E\u0434\u043D\u0443
        // \u0441\u0442\u0440\u043E\u043A\u0443), \u0438\u0437-\u0437\u0430 \u0447\u0435\u0433\u043E \u0432\u0441\u0442\u0430\u0432\u043A\u0430 \u0432\u043E \u0432\u043D\u0435\u0448\u043D\u0438\u0435 \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u044F \u0441\u0445\u043B\u043E\u043F\u044B\u0432\u0430\u043B\u0430\u0441\u044C. \u0421\u0440. \u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043E\u0440:
        // textContent/Range.toString() \u0442\u0435\u0440\u044F\u044E\u0442 <br>, \u0430 \u043E\u0431\u0445\u043E\u0434 \u0441 \u044F\u0432\u043D\u044B\u043C <br>\u2192\n \u2014 \u043D\u0435\u0442.
        const plainFromClip = (root) => {
            let out = '';
            const BLOCK = /^(DIV|P|LI|TR|H[1-6]|BLOCKQUOTE|PRE)$/;
            const walk = (node) => {
                for (let n = node.firstChild; n; n = n.nextSibling) {
                    if (n.nodeType === Node.TEXT_NODE) {
                        out += n.data;
                    } else if (n.nodeType === Node.ELEMENT_NODE) {
                        if (n.tagName === 'BR') { out += '\n'; continue; }
                        walk(n);
                        if (BLOCK.test(n.tagName) && !out.endsWith('\n')) out += '\n';
                    }
                }
            };
            walk(root);
            return out;
        };
        e.clipboardData.setData('text/plain',
            plainFromClip(wrapper).replace(/\u200B/g, ''));

        if (isCut) {
            // Удаляем расширенное выделение нативно — остаётся в undo-стеке.
            // Через _execDeleteRange (взводит __healing): иначе, если вырезается
            // РОВНО одна капсула целиком, вложенный beforeinput от execCommand
            // перехватила бы whole-capsule-ветка handleEditorBeforeInput. Клон/
            // strip/setData выше не затрагиваются (CARET-2).
            this._execDeleteRange(editor, work);
            this.finalizeEdit(editor);
        }
    },

    /**
     * Строит DocumentFragment из вставленного HTML, выбирая режим по источнику:
     *  - свой буфер (data-aw-clip) → реконструкция капсул + полный инлайн-формат;
     *  - Word (mso-сигнатуры) → формат ПОДМНОЖЕСТВОМ тулбара (b/i/u/s + размер),
     *    ссылки-капсулы; цвет/фон/выравнивание/списки отбрасываются;
     *  - прочий внешний HTML → строгая политика «только ссылки».
     * Порядок веток: свой → Word → внешний (Word проверяем ДО внешнего, иначе
     * его разметка ушла бы в «только ссылки» и формат бы потерялся).
     * @private
     */
    _buildPasteFragment(html, footnotesBlocked) {
        if (this._isOwnClipboardHtml(html)) {
            return this._buildOwnPasteFragment(html, footnotesBlocked);
        }
        if (this._isWordHtml(html)) {
            window.EditorTelemetry?.track?.('word_paste');
            return this._buildWordPasteFragment(html);
        }
        return this._buildExternalPasteFragment(html);
    },

    /**
     * @private Похож ли СЫРОЙ HTML буфера на экспорт Microsoft Word? Проверяем
     * до санитизации — DOMPurify выпилит mso-разметку, и после неё сигнатур не
     * останется. Любой из признаков достаточен (регистронезависимо): класс
     * `MsoNormal`/атрибут `class=Mso*`, CSS-декларация `mso-*:`, мета-генератор
     * «Microsoft Word», office-namespace (`xmlns:o=`/`urn:schemas-microsoft-com:
     * office`), пустой абзац `<o:p>` или условный комментарий `<!--[if ...mso...`.
     */
    _isWordHtml(rawHtml) {
        if (typeof rawHtml !== 'string' || !rawHtml) return false;
        return (
            /class=["']?[^"'>]*Mso/i.test(rawHtml)
            // Только CSS-ДЕКЛАРАЦИЯ `mso-*:` (Word всегда пишет mso- как свойство
            // стиля, напр. `mso-fareast-language:`), НЕ голая подстрока «mso-» —
            // иначе безобидный внешний HTML с «mso-» в тексте/URL уходил бы на
            // Word-путь. Реальный Word ловится и этим, и class=Mso/Generator.
            || /mso-[a-z][a-z-]*\s*:/i.test(rawHtml)
            || /<meta[^>]+name=["']?Generator["']?[^>]+Microsoft\s+Word/i.test(rawHtml)
            || /xmlns:o=/i.test(rawHtml)
            || /urn:schemas-microsoft-com:office/i.test(rawHtml)
            || /<o:p/i.test(rawHtml)
            || /<!--\[if[\s\S]*?mso/i.test(rawHtml)
        );
    },

    /**
     * @private Фрагмент помечен как наш буфер обмена (copy/cut редактора)?
     * Точная проверка АТРИБУТА (а не подстроки — иначе слово «data-aw-clip» в
     * тексте/чужом атрибуте ложно включило бы щедрый режим): парсим инертно в
     * <template> и ищем ЭЛЕМЕНТ с data-aw-clip. querySelector по всему фрагменту,
     * не только по корню: на реальном round-trip браузер оборачивает наш <div> в
     * <html>/<body>/StartFragment-комментарии (CF_HTML), и корнем стал бы <html>.
     * Дешёвый substring-префильтр отсекает обычный внешний HTML без парса.
     */
    _isOwnClipboardHtml(html) {
        if (typeof html !== 'string' || html.indexOf('data-aw-clip') === -1) return false;
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        return tpl.content.querySelector('[data-aw-clip]') !== null;
    },

    /**
     * CARET-2: свой буфер (data-aw-clip) — round-trip капсул. Щедрый allowlist
     * (инлайн-формат b/i/u/s/span[style] + разметка капсул), затем реконструкция
     * капсул фабриками со СВЕЖИМИ id. Метку data-aw-clip может подделать и внешний
     * источник — это безопасно: DOMPurify режет script, on*-обработчики и js-схему,
     * а data-link-url прогоняется через validateLinkUrl (ниже), поэтому спуф даёт
     * лишь обычную ссылку/сноску, не XSS.
     * @private
     */
    _buildOwnPasteFragment(html, footnotesBlocked) {
        // §7: DOMPurify НЕ валидирует URL в data-атрибутах (только href/src),
        // поэтому data-link-url проверяем сами (validateLinkUrl в
        // _reconstructPastedCapsules). Хуки allowlist не мутируем.
        const clean = SafeHTML.sanitize(html, {
            USE_PROFILES: false,
            ALLOWED_TAGS: ['b', 'i', 'u', 's', 'strike', 'span', 'a', 'br', 'p', 'div', 'li'],
            ALLOWED_ATTR: ['style', 'class', 'href',
                'data-link-id', 'data-link-url', 'data-footnote-id', 'data-footnote-text'],
            // Round-trip живёт в том же контракте словаря форматирования, что
            // превью/PUT: style фильтруется до CSS-allowlist профиля 'acts' (хук
            // afterSanitizeAttributes читает __cssAllowlist), а не «любое
            // DOMPurify-безопасное свойство». Берём активный набор профиля
            // (отражает серверный applyActsAllowlist).
            __cssAllowlist: [...(SAFE_HTML_PROFILES.acts.__cssAllowlist || [])],
        });
        const tmp = document.createElement('div');
        tmp.innerHTML = clean; // clean уже прошёл DOMPurify — безопасно для парсинга
        this._reconstructPastedCapsules(tmp, footnotesBlocked);
        const fragment = document.createDocumentFragment();
        while (tmp.firstChild) fragment.appendChild(tmp.firstChild);
        return fragment;
    },

    /**
     * @private Реконструирует капсулы во вставленном фрагменте своими фабриками
     * (createLinkMarker/createFootnoteMarker) со СВЕЖИМИ id — чтобы вставленная
     * копия не делила id с оригиналом. URL ссылки прогоняется через validateLinkUrl
     * (DOMPurify data-атрибуты не проверяет). Невалидная/пустая капсула (нет
     * текста, пустой/битый URL, пустое тело сноски) разворачивается в plain-text.
     * validateLinkUrl лежит в window (избегаем циклического импорта с
     * links-footnotes.js). Гейт сносок (I-1, паттерн — KeyK/KeyF в
     * handleEditorKeydown): под запретом политики (SURFACE_POLICY...
     * footnotes===false, напр. violationField) капсула-сноска выпадает из
     * фрагмента ЦЕЛИКОМ, без текстового fallback — ссылки гейт не касается.
     * @param {HTMLElement} root
     * @param {boolean} [footnotesBlocked] Явный гейт сносок (drop — из захваченной
     *   поверхности). undefined → берётся из активной поверхности EditorRegistry
     *   (paste). Явная передача нужна потому, что drop может прийти в
     *   НЕсфокусированное поле, когда активна другая поверхность или никакой нет.
     */
    _reconstructPastedCapsules(root, footnotesBlocked) {
        if (footnotesBlocked === undefined) {
            footnotesBlocked = SURFACE_POLICY[EditorRegistry.getActive()?.kind]?.footnotes === false;
        }
        const caps = root.querySelectorAll(
            '.text-link, .text-footnote, [data-link-url], [data-footnote-text]');
        caps.forEach(el => {
            if (!el.parentNode) return; // уже заменён (вложенный случай)
            const text = el.textContent || '';
            const isLink = el.classList.contains('text-link') || el.hasAttribute('data-link-url');
            if (!isLink && footnotesBlocked) {
                el.parentNode.removeChild(el); // целиком, без текста-фолбэка
                return;
            }
            let replacement = null;
            if (isLink) {
                const verdict = window.validateLinkUrl
                    ? window.validateLinkUrl(el.getAttribute('data-link-url') || '')
                    : { ok: false };
                if (text.trim() && verdict.ok) {
                    replacement = this.createLinkMarker(text, verdict.url);
                }
            } else {
                const body = (el.getAttribute('data-footnote-text') || '').trim();
                if (text.trim() && body) {
                    replacement = this.createFootnoteMarker(text, body);
                }
            }
            // Невалидная/пустая капсула → её видимый текст.
            if (!replacement) replacement = document.createTextNode(text);
            el.parentNode.replaceChild(replacement, el);
        });
    },

    /**
     * Вставка из Microsoft Word: сохраняем РОВНО тот формат, что умеет выставить
     * тулбар редактора — bold/italic/underline/strikethrough + font-size (инлайн),
     * плюс ссылки-капсулы. Цвет, фон, выравнивание, списки и всё прочее сознательно
     * отбрасываются (симметрия «вставка ⊆ возможности UI»). Блоки (p/div/li)
     * расплющиваются в инлайн + <br> — структура абзацев из Word в v1 не
     * переносится (известное ограничение).
     * @private
     */
    _buildWordPasteFragment(html) {
        const pre = this._wordPreClean(html);
        // Санитизация тем же контрактом словаря форматирования, что превью/PUT:
        // теги — подмножество инлайн-формата + блоки под расплющивание; style
        // фильтруется CSS-allowlist'ом (хук afterSanitizeAttributes читает
        // __cssAllowlist), из которого выкинуты color/фон/выравнивание. Схему href
        // допускаем как во внешнем пути; финальный гейт — validateLinkUrl ниже.
        const clean = SafeHTML.sanitize(pre, {
            USE_PROFILES: false,
            ALLOWED_TAGS: this._wordAllowedTags(),
            ALLOWED_ATTR: this._wordAllowedAttrs(),
            ALLOWED_URI_REGEXP: /^(?:(?:https?|ftp|file|mailto|tel):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
            __cssAllowlist: this._wordCssAllowlist(),
        });
        const tmp = document.createElement('div');
        tmp.innerHTML = clean; // clean уже прошёл DOMPurify — безопасно для парсинга
        // Word пишет размер в pt (и как «11.0pt»); фронтовый CSS-хук единицы не
        // валидирует, а бэк на save срезает не-px → без нормализации был бы шов
        // превью↔сохранённое. Приводим к целым px в допустимом диапазоне.
        this._normalizeWordFontSizes(tmp);
        // <a href> → капсулы ссылок со свежими id (невалидная схема → разворот в
        // инлайн-детей, чтобы окружающий формат не потерялся).
        this._reconstructWordLinks(tmp);
        // Расплющиваем блоки в инлайн + <br>, сохраняя вложенный формат.
        const fragment = document.createDocumentFragment();
        this._flattenWordBlocks(tmp, fragment);
        // Хвостовой перенос после последнего абзаца не нужен.
        while (fragment.lastChild
            && fragment.lastChild.nodeType === Node.ELEMENT_NODE
            && fragment.lastChild.tagName === 'BR') {
            fragment.removeChild(fragment.lastChild);
        }
        return fragment;
    },

    /**
     * @private Тонкая regex-пред-очистка Word-разметки, которую allowlist
     * DOMPurify не убирает начисто: условные комментарии `<!--[if]...<![endif]-->`
     * (несут mso-CSS и <xml>), блоки-острова `<xml>…</xml>` (office-метаданные,
     * не видимый текст) и пустые абзацы `<o:p>`. Теги `<w:*>` (content-control'ы
     * `w:sdt`/`w:smartTag`) РАЗворачиваются, а не удаляются с содержимым — иначе
     * терялся бы видимый текст рана внутри них. mso-* CSS-свойства чистить не
     * нужно — их срежет CSS-allowlist. Работает по строке ДО парсинга.
     */
    _wordPreClean(html) {
        return String(html)
            .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '')
            .replace(/<xml\b[^>]*>[\s\S]*?<\/xml>/gi, '')
            .replace(/<o:p\b[^>]*>[\s\S]*?<\/o:p>/gi, '')
            .replace(/<o:p\b[^>]*\/?>/gi, '')
            .replace(/<\/?w:[^>]*>/gi, '');
    },

    /**
     * @private Теги для Word-вставки: инлайн-формат + блоки под расплющивание,
     * ПЕРЕСЕЧЁННЫЕ с живым профилем 'acts' (SAFE_HTML_PROFILES.acts.ALLOWED_TAGS,
     * трекает серверный applyActsAllowlist). Уберёт бэк тег из allowlist — Word-путь
     * уронит его тоже (не «замороженный снимок»); шире набора Word'а не расширяет.
     */
    _wordAllowedTags() {
        const WORD = ['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'span', 'a', 'br', 'p', 'div', 'li'];
        const profile = (SAFE_HTML_PROFILES.acts && SAFE_HTML_PROFILES.acts.ALLOWED_TAGS) || [];
        return WORD.filter(t => profile.includes(t));
    },

    /**
     * @private Атрибуты для Word-вставки (style + href) ∩ живой профиль 'acts'
     * (ALLOWED_ATTR). Дериват — не дрейфует от рантайм-обновляемого набора, как
     * _wordAllowedTags/_wordCssAllowlist.
     */
    _wordAllowedAttrs() {
        const WORD = ['style', 'href'];
        const profile = (SAFE_HTML_PROFILES.acts && SAFE_HTML_PROFILES.acts.ALLOWED_ATTR) || [];
        return WORD.filter(a => profile.includes(a));
    },

    /**
     * @private CSS-allowlist для Word-вставки: набор профиля 'acts' МИНУС
     * color/background-color/text-align. Оставляет ровно то, что умеет тулбар
     * (font-size + жирный/курсив/подчёркивание/зачёркивание через *-weight/
     * -style/-decoration), не давая просочиться цвету/фону/выравниванию. Дериват
     * из активного профиля — остаётся синхронным с бэком (applyActsAllowlist).
     */
    _wordCssAllowlist() {
        const base = SAFE_HTML_PROFILES.acts.__cssAllowlist || [];
        const drop = ['color', 'background-color', 'text-align'];
        return base.filter(p => !drop.includes(p));
    },

    /**
     * @private Приводит inline font-size у всех элементов поддерева к целым px в
     * диапазоне [fontSizeMin,fontSizeMax]: pt→px = round(v*4/3), px оставляем,
     * em/rem/%/прочее — declaration отбрасываем (не-px единиц не оставляем).
     * Переписываем даже px-в-диапазоне, чтобы после нормализации не осталось ни
     * одной не-px величины.
     * @param {HTMLElement} root
     */
    _normalizeWordFontSizes(root) {
        if (!root || typeof root.querySelectorAll !== 'function') return;
        const { fontSizeMin, fontSizeMax } = getStructureLimits();
        root.querySelectorAll('*').forEach((el) => {
            if (!el || !el.style) return;
            const raw = el.style.fontSize;
            if (!raw) return;
            const px = this._wordFontSizeToPx(raw, fontSizeMin, fontSizeMax);
            // null → единица не-px: убираем только font-size, прочие allowed-свойства
            // (font-weight/…) не трогаем.
            el.style.fontSize = px == null ? '' : `${px}px`;
        });
    },

    /**
     * @private Чистая конвертация значения font-size из Word в целые px внутри
     * [min,max]. pt→round(v*4/3), px→round(v), em/rem/%/без единицы/прочее → null
     * (отбросить). Возвращает число px или null.
     */
    _wordFontSizeToPx(raw, min, max) {
        const m = String(raw).trim().match(/^([0-9]*\.?[0-9]+)\s*(pt|px|em|rem|%)?$/i);
        if (!m) return null;
        const val = parseFloat(m[1]);
        if (!Number.isFinite(val)) return null;
        const unit = m[2] ? m[2].toLowerCase() : '';
        let px;
        if (unit === 'pt') px = Math.round(val * 4 / 3);
        else if (unit === 'px') px = Math.round(val);
        else return null;
        return Math.max(min, Math.min(max, px));
    },

    /**
     * @private <a href> из Word → капсулы ссылок (createLinkMarker, свежие id),
     * схема прогоняется через validateLinkUrl. Невалидная/пустая ссылка не
     * выкидывается, а разворачивается в свои инлайн-дети — окружающий и вложенный
     * формат сохраняется. validateLinkUrl лежит в window (как в остальных путях).
     * @param {HTMLElement} root
     */
    _reconstructWordLinks(root) {
        root.querySelectorAll('a').forEach((a) => {
            if (!a.parentNode) return;
            const href = (a.getAttribute('href') || '').trim();
            const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
            const verdict = href && window.validateLinkUrl
                ? window.validateLinkUrl(href) : { ok: false };
            if (text && verdict.ok) {
                a.parentNode.replaceChild(this.createLinkMarker(text, verdict.url), a);
            } else {
                // Разворот в инлайн-детей (сохраняем формат), а не удаление.
                while (a.firstChild) a.parentNode.insertBefore(a.firstChild, a);
                a.parentNode.removeChild(a);
            }
        });
    },

    /**
     * @private Расплющивает блочные элементы (p/div/li) поддерева в инлайн-поток +
     * <br>-разделители, ПЕРЕНОСЯ инлайн-детей целиком (в отличие от external-пути,
     * который берёт только textContent — тут формат сохраняем). Соседство блоков
     * считаем по снапшоту детей (узлы переезжают во фрагмент по ходу обхода).
     * @param {HTMLElement} root
     * @param {DocumentFragment} fragment
     */
    _flattenWordBlocks(root, fragment) {
        const BLOCK = new Set(['P', 'DIV', 'LI']);
        const isBlockNode = (n) => n && n.nodeType === Node.ELEMENT_NODE && BLOCK.has(n.tagName);
        const nodes = Array.from(root.childNodes);
        nodes.forEach((node, i) => {
            if (isBlockNode(node)) {
                this._flattenWordBlocks(node, fragment);
                this._appendPasteBreak(fragment);
            } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
                this._appendPasteBreak(fragment);
            } else if (node.nodeType === Node.TEXT_NODE) {
                // Чисто-пробельный whitespace МЕЖДУ блоками (перевод строки между
                // </p> и <p>) пропускаем — иначе лишний пробел; внутри-абзацные
                // пробелы сохраняем.
                const blank = !node.textContent.trim();
                if (blank && (isBlockNode(nodes[i - 1]) || isBlockNode(nodes[i + 1]))) return;
                if (node.textContent) fragment.appendChild(node);
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                // Инлайн-элемент (b/i/u/s/span-формат или капсула) — целиком,
                // сохраняя вложенное форматирование.
                fragment.appendChild(node);
            }
        });
    },

    /**
     * 4г: строит DocumentFragment из ВНЕШНЕГО вставленного HTML. <a href> на ЛЮБОЙ
     * глубине → span.text-link (фабрика createLinkMarker, C5); прочий текст →
     * textContent. Структура (абзацы/списки) теряется сознательно — режим «только
     * ссылки». Word оборачивает <a> в mso-разметку, поэтому обходим всё дерево
     * рекурсивно (а не только top-level), иначе вложенная ссылка терялась бы
     * (BUG-4). Схему href валидирует validateLinkUrl (http/https/mailto/tel/ftp/
     * file/#), как и при ручном вводе.
     * @private
     */
    _buildExternalPasteFragment(html) {
        // DOMPurify сводит вход к <a href> + блочной разметке + тексту; прочее
        // вырезается (KEEP_CONTENT=true по умолчанию сохраняет текст внутри
        // удалённых тегов). BUG-4: дефолтный ALLOWED_URI_REGEXP вырезает href со
        // схемой file: (ссылка на локальный файл терялась). Расширяем allowlist
        // схем до http/https/ftp/file/mailto/tel + относительные/якоря;
        // javascript:/data:/vbscript: regex по-прежнему отбивает. Финальный гейт
        // схемы — validateLinkUrl в _collectPasteNodes. BUG-5: разрешаем
        // блочные теги br/p/div/li, чтобы _collectPasteNodes восстановил
        // переносы абзацев (Word размечает их <p class=MsoNormal>); теги инертны
        // и без атрибутов (ALLOWED_ATTR=['href']) — XSS-вектора не несут.
        const clean = SafeHTML.sanitize(html, {
            USE_PROFILES: false,
            ALLOWED_TAGS: ['a', 'br', 'p', 'div', 'li'],
            ALLOWED_ATTR: ['href'],
            ALLOWED_URI_REGEXP: /^(?:(?:https?|ftp|file|mailto|tel):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
        });

        const tmp = document.createElement('div');
        tmp.innerHTML = clean; // clean уже прошёл DOMPurify — безопасно для парсинга
        const fragment = document.createDocumentFragment();
        this._collectPasteNodes(tmp, fragment);
        // BUG-5: хвостовой перенос после последнего абзаца не нужен.
        while (fragment.lastChild
            && fragment.lastChild.nodeType === Node.ELEMENT_NODE
            && fragment.lastChild.tagName === 'BR') {
            fragment.removeChild(fragment.lastChild);
        }
        return fragment;
    },

    /**
     * BUG-4: рекурсивный DFS-обход вставленного фрагмента с сохранением порядка.
     * <a> превращается в маркер ссылки (внутрь не спускаемся — текст уже взят);
     * прочие элементы рекурсируем (ищем вложенные <a>); текстовые узлы — как есть.
     * validateLinkUrl лежит в window (избегаем циклического импорта с
     * links-footnotes.js, который держит порядок инициализации handleEditorFocus).
     * @private
     */
    _collectPasteNodes(root, fragment) {
        const BLOCK = new Set(['P', 'DIV', 'LI']);
        const isBlockEl = (n) => n && n.nodeType === Node.ELEMENT_NODE && BLOCK.has(n.tagName);
        root.childNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'A') {
                const href = (node.getAttribute('href') || '').trim();
                const text = node.textContent.replace(/\s+/g, ' ').trim();
                const verdict = href && window.validateLinkUrl
                    ? window.validateLinkUrl(href) : { ok: false };
                if (text && verdict.ok) {
                    fragment.appendChild(this.createLinkMarker(text, verdict.url));
                } else if (node.textContent) {
                    fragment.appendChild(document.createTextNode(node.textContent));
                }
            } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
                // BUG-5: явный перенос строки внутри абзаца.
                this._appendPasteBreak(fragment);
            } else if (isBlockEl(node)) {
                // BUG-5: содержимое блока + перенос-разделитель абзаца после него.
                this._collectPasteNodes(node, fragment);
                this._appendPasteBreak(fragment);
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                this._collectPasteNodes(node, fragment);
            } else if (node.nodeType === Node.TEXT_NODE && node.textContent) {
                // BUG-5: пропускаем чисто-пробельный форматирующий whitespace
                // МЕЖДУ блоками (перевод строки между </p> и <p>) — иначе
                // появился бы лишний пробел; внутри-абзацные пробелы сохраняем.
                const blank = !node.textContent.trim();
                if (blank && (isBlockEl(node.previousElementSibling) || isBlockEl(node.nextElementSibling))) {
                    return;
                }
                fragment.appendChild(document.createTextNode(node.textContent));
            }
        });
    },

    /**
     * BUG-5: добавляет перенос строки <br> во фрагмент вставки без ведущих и
     * двойных переносов (не ставит первым узлом и не задваивает подряд).
     * @private
     */
    _appendPasteBreak(fragment) {
        const last = fragment.lastChild;
        if (!last) return;
        if (last.nodeType === Node.ELEMENT_NODE && last.tagName === 'BR') return;
        fragment.appendChild(document.createElement('br'));
    },

    /**
     * Обработчик клавиш
     */
    handleEditorKeydown(e, editor, textBlock) {
        // Все горячие клавиши: Ctrl+Shift+* (e.code — независимо от раскладки)
        if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
            // Политика активной поверхности (SURFACE_POLICY): кнопки тулбара уже
            // гасятся по kind (_applyToolbarPolicy, textblock-toolbar.js) —
            // клавиатурные шорткаты сносок/ссылок должны подчиняться той же
            // политике, иначе Ctrl+Shift+F в поле нарушения создаёт сноску в
            // обход запрета (footnotes:false у violationField). Блокируем
            // ТОЛЬКО когда ключ политики ЯВНО false; нет активной поверхности/
            // kind или ключа в политике — старое поведение (default-allow).
            // preventDefault для KeyK/KeyF зовём безусловно (см. кейсы ниже) —
            // шорткат проглатывается целиком даже под запретом, иначе сработает
            // браузерный дефолт.
            const surfacePolicy = SURFACE_POLICY[EditorRegistry.getActive()?.kind];
            switch (e.code) {
                case 'KeyB':
                    e.preventDefault();
                    this.execCommand('bold');
                    this.updateToolbarState();
                    break;
                case 'KeyI':
                    e.preventDefault();
                    this.execCommand('italic');
                    this.updateToolbarState();
                    break;
                case 'KeyU':
                    e.preventDefault();
                    this.execCommand('underline');
                    this.updateToolbarState();
                    break;
                case 'KeyX':
                    e.preventDefault();
                    this.execCommand('strikeThrough');
                    this.updateToolbarState();
                    break;
                case 'KeyK':
                    e.preventDefault();
                    if (surfacePolicy?.links !== false) this.createOrEditLink();
                    break;
                case 'KeyF':
                    e.preventDefault();
                    if (surfacePolicy?.footnotes !== false) this.createOrEditFootnote();
                    break;
                case 'KeyA':
                    e.preventDefault();
                    this.cycleAlignment();
                    this.updateToolbarState();
                    break;
                case 'Period':
                    e.preventDefault();
                    this.stepFontSize(1);
                    this.updateToolbarState();
                    break;
                case 'Comma':
                    e.preventDefault();
                    this.stepFontSize(-1);
                    this.updateToolbarState();
                    break;
            }
        }

        // «Вся капсула как юнит»: Shift+←/→ у границы капсулы расширяет выделение
        // за ВСЮ капсулу одним шагом (атом при выделении, как node-selection).
        // Только Shift, без Ctrl/Meta/Alt.
        if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey &&
            (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
            this._handleCapsuleShiftArrow(e, editor)) {
            return;
        }

        // Каретка у границы капсулы с КЛАВИАТУРЫ (Home/←/→) — приземляется в
        // caret-guard у ведущей/хвостовой капсулы (мышь делает то же через
        // click-обработчик). Только «голые» стрелки/Home, без модификаторов.
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey &&
            this._handleCapsuleCaretKey(e, editor)) {
            return;
        }

        // CARET-4: guard прозрачен для голого Backspace/Delete (без модификаторов —
        // Ctrl+Backspace словом наружу этой задачей не покрыт).
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
            this._skipGuardOnDelete(e);
        }

        // BUG-6: Enter у границы inline-маркера (contenteditable=false). Нативный
        // SplitBlock расщепляет/клонирует маркер — фантомные пустые капсулы и
        // задвоение нумерации сносок. Перехватываем и вставляем перенос вручную,
        // не расщепляя маркер: контент до каретки остаётся на строке, маркер
        // уходит на новую (либо появляется пустая строка над ведущим маркером).
        if (e.key === 'Enter' && !e.shiftKey) {
            const sel = window.getSelection();
            if (sel && sel.isCollapsed && sel.rangeCount > 0) {
                const range = sel.getRangeAt(0);
                const { before, after } = this._caretAdjacentMarkers(range);
                if (before || after) {
                    e.preventDefault();
                    const br = document.createElement('br');
                    range.insertNode(br);
                    // Единый сток ДО установки каретки: normalizeMarkers внутри
                    // пере-расставляет caret-guard'ы у новой границы строки
                    // (CARET-5). Каретку ставим ПОСЛЕ — иначе normalize сдвинул бы
                    // guard, в который она встала.
                    this.finalizeEdit(editor);
                    if (after) {
                        // Капсула уходит в начало новой строки — ставим каретку в
                        // её ведущий caret-guard (его только что пере-расставил
                        // finalizeEdit), той же ленивой установкой, что делает
                        // клик мышью; иначе перед капсулой-в-начале-строки
                        // клавиатурой не встать.
                        this._placeCaretBesideMarker(after, false);
                    } else {
                        const caret = document.createRange();
                        caret.setStartAfter(br);
                        caret.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(caret);
                    }
                    return;
                }
            }
        }

        // Shift+Enter - двойной перенос
        if (e.key === 'Enter' && e.shiftKey) {
            e.preventDefault();
            // insertHTML напрямую (не через this.execCommand) — вставка остаётся
            // в нативном undo-стеке, а сток берёт на себя finalizeEdit, без
            // двойного saveContent.
            document.execCommand('insertHTML', false, '<br><br>');
            this.finalizeEdit(editor);
        }
        // Escape - выход
        else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            editor.blur();
        }
    },

    /**
     * Обработчик изменения выделения
     */
    handleSelectionChange() {
        if (this.activeEditor) {
            this.updateToolbarState();
            this._updateNodeSelectedState(this.activeEditor);
        }
    },

    /**
     * @private Снимает визуальную отметку «вся капсула как юнит» (.node-selected).
     * Быстрый путь O(1): снять с закэшированной ссылки _nodeSelectedEl (отметку
     * носит максимум одна капсула — выделение в документе одно). Единый сток снятия
     * для _updateNodeSelectedState (на каждый keyup/mouseup — только O(1)) и blur.
     * scope (опц.) — дополнительный editor-скоуп sweep для НЕЧАСТЫХ путей (blur):
     * подчищает возможные «висящие» отметки, если кэш разошёлся с DOM.
     * @param {HTMLElement} [scope]
     */
    _clearNodeSelected(scope) {
        if (this._nodeSelectedEl) {
            if (this._nodeSelectedEl.classList) this._nodeSelectedEl.classList.remove('node-selected');
            this._nodeSelectedEl = null;
        }
        if (scope && typeof scope.querySelectorAll === 'function') {
            scope.querySelectorAll('.text-link.node-selected, .text-footnote.node-selected')
                .forEach(el => el.classList.remove('node-selected'));
        }
    },

    /**
     * «Вся капсула как юнит» (визуальная часть): помечает классом .node-selected
     * капсулу, ЦЕЛИКОМ охваченную текущим выделением (_rangeIsWholeCapsule), и
     * снимает отметку с прежней. READ-only: диапазон НЕ мутируем (правка range на
     * selectionchange/перетаскивании воевала бы с браузером). Класс рантайм-only,
     * из сохранённого content вычищается в _repairCapsulesInRoot (как
     * contenteditable). Прежнюю отметку снимаем за O(1) по _nodeSelectedEl — метод
     * висит на keyup/mouseup (каждая клавиша), documentwide-querySelectorAll тут
     * недопустим.
     * @param {HTMLElement} editor
     * @private
     */
    _updateNodeSelectedState(editor) {
        this._clearNodeSelected();
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        if (!editor.contains(range.commonAncestorContainer)) return;
        const capsule = this._rangeIsWholeCapsule(range, editor);
        if (capsule && capsule.classList) {
            capsule.classList.add('node-selected');
            this._nodeSelectedEl = capsule;
        }
    },

    /**
     * Каретка у границы капсулы с КЛАВИАТУРЫ (гибрид Варианта 2): Home / ←/→ у
     * ведущей/хвостовой капсулы ставит каретку в её caret-guard через
     * _placeCaretBesideMarker — ту же точку приземления, что и клик мышью.
     * Возвращает true, если перехватил клавишу.
     * @private
     */
    _handleCapsuleCaretKey(e, editor) {
        const sel = window.getSelection();
        if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false;
        const range = sel.getRangeAt(0);

        if (e.key === 'Home') {
            // ТЕКУЩАЯ визуальная строка начинается капсулой → каретка перед ней
            // (в guard). Берём первый узел строки каретки, а не всего блока (#12):
            // иначе Home на строке-N прыгал бы к капсуле строки 1. CARET-3: строка
            // может быть длиннее блока и переноситься на несколько экранных рядов —
            // первый узел DOM-строки всё равно капсула, хотя каретка физически на
            // wrap-продолжении; _isCaretOnCapsuleRow не даёт телепортировать мимо
            // native Home для этого случая.
            const first = this._currentLineFirstNode(range, editor);
            // CARET-1 (симметрия Task 2): капсула в inline-правке (dblclick,
            // editing-mode) — обычный редактируемый контент; Home внутри её тела
            // должен работать нативно, а не выдёргивать каретку в ведущий guard.
            // Тот же предикат _isEditingCapsule, что и в слоях целостности.
            if (this._isCapsule(first) && !this._isEditingCapsule(first) &&
                    this._isCaretOnCapsuleRow(range, first)) {
                e.preventDefault();
                this._placeCaretBesideMarker(first, false);
                return true;
            }
            return false;
        }
        if (e.key === 'ArrowLeft') {
            // Капсула слева, и слева от НЕЁ нет реального контента (ведущая) →
            // встаём ПЕРЕД ней (в guard), а не «проскакиваем» в пустоту.
            const { before } = this._caretAdjacentMarkers(range);
            if (before && !this._significantSibling(before, 'previousSibling')) {
                e.preventDefault();
                this._placeCaretBesideMarker(before, false);
                return true;
            }
            return false;
        }
        if (e.key === 'ArrowRight') {
            const { after } = this._caretAdjacentMarkers(range);
            if (after && !this._significantSibling(after, 'nextSibling')) {
                e.preventDefault();
                this._placeCaretBesideMarker(after, true);
                return true;
            }
            return false;
        }
        return false;
    },

    /**
     * «Вся капсула как юнит»: Shift+←/→, когда ФОКУС выделения примыкает к
     * капсуле по направлению движения, перепрыгивает фокус на ДАЛЬНЮЮ сторону
     * всей капсулы (за её guard) одним шагом — параллель _handleCapsuleCaretKey,
     * но для расширяющегося (не схлопнутого) выделения. Симметрично работает и
     * на сжатие (Shift+← когда фокус справа от капсулы). Капсулу в inline-правке
     * (editing-mode) пропускаем (обычный текст, CARET-1). Возвращает true, если
     * перехватил клавишу.
     * @private
     */
    _handleCapsuleShiftArrow(e, editor) {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || typeof sel.extend !== 'function') return false;
        if (!sel.focusNode || !editor.contains(sel.focusNode)) return false;
        const forward = e.key === 'ArrowRight';
        // Точку ФОКУСА оборачиваем в схлопнутый range, чтобы переиспользовать
        // _caretAdjacentMarkers (маркеры непосредственно у фокуса). Если фокус стоит
        // В caret-guard'е (после расширения над КРАЕВОЙ капсулой sel.extend оставил
        // фокус на (guard, guard.length)) — переносим точку в РОДИТЕЛЯ по краю
        // guard'а: _caretAdjacentMarkers по элемент-контейнеру пропускает guard
        // (skipEmpty) и находит капсулу с ПЕРВОГО нажатия. Без этого первое сжатие
        // Shift+← у краевой капсулы уходило вхолостую внутрь невидимого guard'а
        // (beforeNode=null при непустом контейнере), перехватывалось лишь второе.
        let fNode = sel.focusNode, fOff = sel.focusOffset;
        if (this._isGuardNode(fNode) && fNode.parentNode) {
            const p = fNode.parentNode;
            const gi = Array.prototype.indexOf.call(p.childNodes, fNode);
            fOff = (fOff >= fNode.data.length) ? gi + 1 : gi;
            fNode = p;
        }
        const focusRange = document.createRange();
        focusRange.setStart(fNode, fOff);
        focusRange.collapse(true);
        const { before, after } = this._caretAdjacentMarkers(focusRange);
        // Вправо — капсула справа от фокуса; влево — слева.
        const capsule = forward ? after : before;
        if (!capsule || this._isEditingCapsule(capsule)) return false;
        e.preventDefault();
        // Дальняя сторона: за хвостовым guard'ом (вправо) / перед ведущим (влево);
        // при отсутствии guard'а — по краю самой капсулы через offset родителя.
        const guard = forward ? capsule.nextSibling : capsule.previousSibling;
        if (this._isGuardNode(guard)) {
            sel.extend(guard, forward ? guard.data.length : 0);
        } else {
            const parent = capsule.parentNode;
            const idx = Array.prototype.indexOf.call(parent.childNodes, capsule);
            sel.extend(parent, forward ? idx + 1 : idx);
        }
        return true;
    },

    /**
     * BUG-6: возвращает inline-маркеры (.text-link/.text-footnote), непосредственно
     * примыкающие к схлопнутой каретке слева (before) и справа (after). Пустые
     * текстовые узлы пропускаются. Используется для перехвата Enter у границы
     * маркера, где нативный SplitBlock клонировал бы contenteditable=false узел.
     * @private
     */
    _caretAdjacentMarkers(range) {
        const c = range.startContainer;
        const o = range.startOffset;
        let beforeNode = null;
        let afterNode = null;
        if (c.nodeType === Node.TEXT_NODE) {
            if (o > 0 && o < c.length) return { before: null, after: null }; // внутри текста — границы нет
            if (o === 0) {
                beforeNode = c.previousSibling;
                afterNode = c.length === 0 ? c.nextSibling : null;
            } else { // o === c.length
                beforeNode = c.length === 0 ? c.previousSibling : null;
                afterNode = c.nextSibling;
            }
        } else {
            beforeNode = c.childNodes[o - 1] || null;
            afterNode = c.childNodes[o] || null;
        }
        // Пропускаем пустые текстовые узлы И caret-guard'ы (U+FEFF) — иначе
        // guard между кареткой и капсулой «спрятал» бы маркер от перехвата Enter.
        const skipEmpty = (n, dir) => {
            while (n && n.nodeType === Node.TEXT_NODE &&
                (n.data === '' || n.data === this.CAP_GUARD_CHAR)) n = n[dir];
            return n;
        };
        beforeNode = skipEmpty(beforeNode, 'previousSibling');
        afterNode = skipEmpty(afterNode, 'nextSibling');
        const isMarker = (n) => n && n.nodeType === Node.ELEMENT_NODE && n.classList &&
            (n.classList.contains('text-link') || n.classList.contains('text-footnote'));
        return { before: isMarker(beforeNode) ? beforeNode : null, after: isMarker(afterNode) ? afterNode : null };
    },

    /**
     * @private CARET-4: guard-узел (U+FEFF) в направлении удаления с данной
     * схлопнутой каретки — если Backspace/Delete упёрся бы именно в него.
     * Guard всегда длиной 1, поэтому граница — либо каретка ВНУТРИ самого
     * guard'а (offset 0 или 1), либо guard — непосредственный сосед контейнера
     * каретки с нужной стороны.
     * @param {Range} range схлопнутая каретка
     * @param {boolean} forward true — Delete (вперёд), false — Backspace (назад)
     * @returns {Text|null}
     */
    _guardInDeleteDirection(range, forward) {
        const c = range.startContainer, o = range.startOffset;
        if (this._isGuardNode(c)) {
            return (forward ? o === 0 : o === c.data.length) ? c : null;
        }
        if (c.nodeType === Node.TEXT_NODE) {
            if (forward ? o !== c.data.length : o !== 0) return null;
            const sib = forward ? c.nextSibling : c.previousSibling;
            return this._isGuardNode(sib) ? sib : null;
        }
        const sib = c.childNodes[forward ? o : o - 1] || null;
        return this._isGuardNode(sib) ? sib : null;
    },

    /**
     * CARET-4: guard прозрачен для Backspace/Delete. Реальный Backspace/Delete
     * ПО guard-символу опустошает его text-node и тут же роняет узел (браузер,
     * один батч мутаций) — MutationObserver (_onCapsuleMutations) молча
     * восстанавливает guard, а слияние строк/удаление настоящего содержимого
     * требует ВТОРОГО нажатия. keydown срабатывает раньше нативного удаления —
     * сдвигаем каретку ЗА guard (сам guard не трогаем, DOM не мутируем) и НЕ
     * вызываем preventDefault: нативная команда получает цель уже без guard'а
     * между ней и кареткой (перенос, край блока или соседняя капсула — её
     * атомарное удаление отрабатывает существующий слой beforeinput).
     * @param {KeyboardEvent} e
     * @private
     */
    _skipGuardOnDelete(e) {
        if (e.key !== 'Backspace' && e.key !== 'Delete') return;
        const sel = window.getSelection();
        if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return;
        const forward = e.key === 'Delete';
        const guard = this._guardInDeleteDirection(sel.getRangeAt(0), forward);
        if (!guard) return;
        const range = document.createRange();
        range.setStart(guard, forward ? guard.data.length : 0);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
    },
});
