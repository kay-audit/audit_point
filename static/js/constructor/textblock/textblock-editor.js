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

/** Блочные CSS-свойства, которые снимает «очистить форматирование» (D2). */
const BLOCK_FORMAT_PROPS = ['text-align', 'margin-left', 'padding-left', 'text-indent'];

/** Быстрый признак «в HTML-строке вообще есть список» (дешёвый гейт). */
const LIST_TAG_RE = /<(ul|ol)[\s>]/i;

/**
 * Потолок проходов нормализации вложенности (_normalizeListNesting): каждый
 * проход строго уменьшает число нарушений, поэтому дело сходится за один-два —
 * лимит здесь только чтобы неучтённая форма разметки не дала бесконечный цикл.
 */
const NORMALIZE_MAX_PASSES = 4;

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

        this.pasteClipboardPayload(
            editor,
            e.clipboardData.getData('text/html'),
            e.clipboardData.getData('text/plain'),
        );
    },

    /**
     * Тот же конвейер вставки, но от СНЯТЫХ строк буфера, а не от события.
     * Нужен отложенному сценарию: зона нарушений на комбинированном буфере
     * (текст + картинка) сначала спрашивает пользователя, что вставлять, а к
     * моменту ответа clipboardData уже недействителен — данные снимаются
     * синхронно в обработчике и приходят сюда строками (violation-paste.js).
     * Каретку/выделение выставляет вызывающий, как и в drop-пути.
     * @param {HTMLElement} editor
     * @param {string} html - Содержимое text/html буфера
     * @param {string} plain - Содержимое text/plain буфера
     */
    pasteClipboardPayload(editor, html, plain) {
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
     * @param {boolean} [fromDrop] Вставка пришла из drop. Включает опознание
     *   own-пути по капсульным маркерам (нативный drag теряет метку data-aw-clip).
     *   На paste не передаётся → капсульный детект не активен, поведение прежнее.
     */
    _insertSanitizedHtml(editor, html, plain, footnotesBlocked, fromDrop) {
        // Нет HTML — прежний путь: только чистый текст.
        if (!html || !html.trim()) {
            document.execCommand('insertText', false, plain);
            this.finalizeEdit(editor);
            return;
        }

        const fragment = this._buildPasteFragment(html, footnotesBlocked, fromDrop);

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
     *
     * DROP (fromDrop=true): нативный drag выделения сериализуется браузером БЕЗ
     * метки data-aw-clip, поэтому капсулы из нашего же поля не опознаются
     * _isOwnClipboardHtml и ушли бы внешним путём (ссылка → текст, сноска —
     * санитайзером мимо гейта). Дополнительно опознаём own-путь по нашим
     * капсульным маркерам (_hasCapsuleMarkers). Детект УЗКИЙ (только drop +
     * только при наличии капсул): paste поведения не меняет; спуф data-link-url
     * безопасен — own-путь пересобирает капсулы заново и валидирует URL
     * (validateLinkUrl в _reconstructPastedCapsules), не-капсульный контент
     * идёт через тот же SafeHTML.sanitize (img/script/on* режутся, см.
     * _buildOwnPasteFragment).
     * @private
     */
    _buildPasteFragment(html, footnotesBlocked, fromDrop) {
        if (this._isOwnClipboardHtml(html) || (fromDrop && this._hasCapsuleMarkers(html))) {
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
     * @private Содержит ли HTML наши капсульные маркеры (ссылка/сноска)? Нужен
     * ТОЛЬКО для DROP: нативный drag выделения сериализуется БЕЗ метки
     * data-aw-clip, поэтому _isOwnClipboardHtml не опознаёт капсулы из нашего же
     * поля. Опознаём по data-link-url / data-footnote-text — атрибутам, что
     * несут реконструируемую нагрузку (URL / тело сноски); именно их выставляют
     * фабрики createLinkMarker/createFootnoteMarker. Точная проверка АТРИБУТА
     * (не подстроки — иначе слово в тексте/чужом атрибуте ложно включило бы
     * own-путь): инертный <template> + querySelector. Дешёвый substring-
     * префильтр отсекает обычный HTML без парса. Спуф маркеров безопасен:
     * own-путь пересобирает капсулы заново и валидирует URL (validateLinkUrl),
     * XSS не даёт.
     */
    _hasCapsuleMarkers(html) {
        if (typeof html !== 'string') return false;
        if (html.indexOf('data-link-url') === -1
            && html.indexOf('data-footnote-text') === -1) return false;
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        return tpl.content.querySelector('[data-link-url], [data-footnote-text]') !== null;
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
            // ul/ol рядом с li: свой буфер обязан пережить round-trip списка,
            // который умеет тулбар (insertUnorderedList/insertOrderedList) —
            // без контейнера Ctrl+C→Ctrl+V своего же списка отдавал бы голые li.
            ALLOWED_TAGS: ['b', 'i', 'u', 's', 'strike', 'span', 'a', 'br', 'p', 'div', 'ul', 'ol', 'li'],
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
     * ссылки-капсулы и списки ul/ol (тулбар их умеет с Task 4.1). Цвет, фон,
     * выравнивание и всё прочее сознательно отбрасываются (симметрия «вставка ⊆
     * возможности UI»). Блоки (p/div/li) расплющиваются в инлайн + <br> —
     * структура абзацев из Word в v1 не переносится (известное ограничение).
     * ОГРАНИЧЕНИЕ списков: переживает только РАЗМЕТКУ ul/ol/li. Десктопный Word
     * отдаёт список абзацами `<p style="mso-list:...">` с маркером в
     * `<![if !supportLists]>`-спане — они идут общим путём абзацев (строки + <br>,
     * видимый маркер остаётся текстом). Конвертация mso-list → ul/ol не сделана.
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
        const WORD = ['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'span', 'a', 'br', 'p', 'div', 'ul', 'ol', 'li'];
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
     * @private Приводит inline font-size у всех элементов поддерева к целым pt в
     * диапазоне [fontSizeMin,fontSizeMax]: pt оставляем, px→pt = round(v*0.75),
     * em/rem/%/прочее — declaration отбрасываем (не-pt единиц не оставляем).
     * Переписываем даже pt-в-диапазоне, чтобы после нормализации не осталось ни
     * одной не-pt величины. Word и так пишет размеры в пунктах, так что для
     * типичной вставки это тождество; px приходит из веб-источников.
     * @param {HTMLElement} root
     */
    _normalizeWordFontSizes(root) {
        if (!root || typeof root.querySelectorAll !== 'function') return;
        const { fontSizeMin, fontSizeMax } = getStructureLimits();
        root.querySelectorAll('*').forEach((el) => {
            if (!el || !el.style) return;
            const raw = el.style.fontSize;
            if (!raw) return;
            const pt = this._wordFontSizeToPt(raw, fontSizeMin, fontSizeMax);
            // null → единица не-pt/не-px: убираем только font-size, прочие
            // allowed-свойства (font-weight/…) не трогаем.
            el.style.fontSize = pt == null ? '' : `${pt}pt`;
        });
    },

    /**
     * @private Чистая конвертация значения font-size из Word в целые pt внутри
     * [min,max]. pt→round(v), px→round(v*0.75), em/rem/%/без единицы/прочее →
     * null (отбросить). Возвращает число pt или null.
     */
    _wordFontSizeToPt(raw, min, max) {
        const m = String(raw).trim().match(/^([0-9]*\.?[0-9]+)\s*(pt|px|em|rem|%)?$/i);
        if (!m) return null;
        const val = parseFloat(m[1]);
        if (!Number.isFinite(val)) return null;
        const unit = m[2] ? m[2].toLowerCase() : '';
        let pt;
        if (unit === 'pt') pt = Math.round(val);
        else if (unit === 'px') pt = Math.round(val * 3 / 4);
        else return null;
        return Math.max(min, Math.min(max, pt));
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
     * ul/ol в BLOCK намеренно НЕ входят: контейнер списка переезжает во фрагмент
     * целиком (ветка инлайн-элемента), вместе со своими li — иначе тулбарный
     * список из Word рассыпался бы в строки с <br>.
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
            // ul/ol держим рядом с li ради единообразия трёх paste-конфигов, но
            // на СТРУКТУРУ они здесь не влияют: _collectPasteNodes расплющивает
            // списки в строки с <br>, как и абзацы (режим «только ссылки»).
            ALLOWED_TAGS: ['a', 'br', 'p', 'div', 'ul', 'ol', 'li'],
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

        // Tab / Shift+Tab меняют уровень пункта списка (B3). Ветка стоит РАНЬШЕ
        // капсульных: Tab — структурная команда, каретную логику капсул ей
        // проходить незачем. Модификаторы Ctrl/Meta/Alt оставляем системе
        // (переключение поверхностей/окон).
        if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey &&
            this._handleListTab(e, editor)) {
            return;
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
     * @private Tab / Shift+Tab внутри пункта списка меняет его уровень.
     * Возвращает true, если клавиша перехвачена (тогда вызывающий обязан
     * остановиться). Каретка ВНЕ списка → false и НИКАКОГО preventDefault:
     * нативный переход фокуса между поверхностями обязан сохраниться.
     * Углубление на потолке глубины клавишу всё равно проглатывает (иначе Tab на
     * дне списка увёл бы фокус из редактора): preventDefault зовётся по факту
     * «каретка в <li>», а сам потолок держит гейт execCommand
     * (_listLevelCeiling — единственное место, где глубина сравнивается).
     * @param {KeyboardEvent} e
     * @param {HTMLElement} editor
     * @returns {boolean}
     */
    _handleListTab(e, editor) {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return false;
        const li = this._caretListItem(sel.getRangeAt(0), editor);
        if (!li) return false;

        e.preventDefault();
        this.execCommand(e.shiftKey ? 'outdent' : 'indent');
        return true;
    },

    /**
     * @private Пункт списка, В КОТОРОМ стоит НАЧАЛО диапазона, ИЛИ null. Обёртка
     * над _listItemAncestor, разбирающая случай «range заякорен на ЭЛЕМЕНТЕ»:
     * Chrome при Ctrl+A ставит startContainer = сам редактор (offset 0), а
     * _listItemAncestor от редактора возвращает null (цикл не стартует) — гейт
     * уровня, Tab-ветка и подсветка пунктов меню разом слепли на выделении,
     * целиком состоящем из пунктов списка. Резолвим вглубь: дочерний узел по
     * startOffset, а если это сам список — его первый <li>.
     * @param {Range} range
     * @param {HTMLElement} editor
     * @returns {Element|null}
     */
    _caretListItem(range, editor) {
        if (!range || !editor) return null;
        let node = range.startContainer;
        if (node && node.nodeType === 1 && (node === editor || this._isListElement(node))) {
            const kids = node.childNodes || [];
            let probe = kids[range.startOffset] || kids[kids.length - 1] || null;
            if (this._isListElement(probe)) {
                probe = Array.from(probe.children || []).find(ch => ch.tagName === 'LI') || probe;
            }
            node = probe || node;
        }
        return this._listItemAncestor(node, editor);
    },

    /**
     * @private Пункты списка, которые задевает диапазон, в порядке документа.
     * Схлопнутая каретка (и стабовый Range без intersectsNode) — ровно один
     * пункт, тот же, что у _caretListItem.
     *
     * При вложенности берётся пункт, ВНУТРИ которого других задетых пунктов
     * нет (углублять надо именно его), либо пункт, накрытый диапазоном
     * ЦЕЛИКОМ — такой едет со всем своим поддеревом, и его потомки из набора
     * выбывают. Иначе выделение внутри подпункта двигало бы весь родительский
     * пункт, а выделение целого пункта — только его дно.
     * @param {Range} range
     * @param {HTMLElement} editor
     * @returns {Element[]}
     */
    _selectedListItems(range, editor) {
        const caretItem = this._caretListItem(range, editor);
        if (!caretItem || typeof range.intersectsNode !== 'function'
                || typeof editor.querySelectorAll !== 'function') {
            return caretItem ? [caretItem] : [];
        }
        const touched = Array.from(editor.querySelectorAll('li'))
            .filter(li => range.intersectsNode(li));
        const kept = touched.filter(li => this._rangeCoversNode(range, li)
            || !touched.some(other => other !== li && li.contains(other)));
        const tops = kept.filter(li => !kept.some(other => other !== li && other.contains(li)));
        return tops.length ? tops : [caretItem];
    },

    /**
     * @private Диапазон накрывает узел целиком? Константы how — литералами
     * (0 = START_TO_START, 2 = END_TO_END) по тем же соображениям, что и
     * литерал 3 вместо Node.TEXT_NODE: без зависимости от глобала Range.
     * @param {Range} range
     * @param {Node} node
     * @returns {boolean}
     */
    _rangeCoversNode(range, node) {
        if (typeof document.createRange !== 'function'
                || typeof range.compareBoundaryPoints !== 'function') return false;
        const nodeRange = document.createRange();
        nodeRange.selectNode(node);
        return range.compareBoundaryPoints(0, nodeRange) <= 0
            && range.compareBoundaryPoints(2, nodeRange) >= 0;
    },

    /**
     * @private Ближайший предок-<li> узла в пределах редактора, ИЛИ null.
     * Параллель _capsuleAncestor (textblock-core.js): та же дисциплина обхода —
     * не выходим за editor. Литерал 3 вместо Node.TEXT_NODE — по тем же
     * соображениям, что и там (без зависимости от глобала Node).
     * @param {Node} node
     * @param {HTMLElement} editor
     * @returns {Element|null}
     */
    _listItemAncestor(node, editor) {
        let el = node && node.nodeType === 3 ? node.parentNode : node;
        while (el && el !== editor && editor && typeof editor.contains === 'function'
                && editor.contains(el)) {
            if (el.tagName === 'LI') return el;
            el = el.parentNode;
        }
        return null;
    },

    /**
     * @private 0-based глубина пункта списка: число списков-предков минус один.
     * Пункт списка верхнего уровня — 0.
     * @param {Element} li
     * @param {HTMLElement} editor
     * @returns {number}
     */
    _listLevel(li, editor) {
        let level = -1;
        let el = li;
        while (el && el !== editor) {
            if (this._isListElement(el)) level++;
            el = el.parentNode;
        }
        return level < 0 ? 0 : level;
    },

    /** @private Узел — <ul>/<ol>? */
    _isListElement(el) {
        return !!(el && el.nodeType === 1 && (el.tagName === 'UL' || el.tagName === 'OL'));
    },

    /**
     * @private Углубляет пункт списка на уровень — СВОЯ реализация вместо
     * нативного execCommand('indent'). Нативная команда на одиночном пункте
     * порождает список-сироту рядом с ним (без предыдущего <li>), из которого
     * каноническую форму `<li>текст<ol>…</ol></li>` без пустого <li>-хоста не
     * собрать: маркеры таких хостов выстраивались в одну строку («a) i. 1.
     * Текст»), а indent соседнего пункта клал в <li> ВТОРОЙ список-сиблинг, и
     * его нумерация стартовала с начала.
     *
     * Правила (как в Word/ProseMirror):
     *  - предыдущего соседнего <li> нет → no-op: первый пункт уровня не
     *    углубляется (иначе понадобился бы тот самый пустой хост);
     *  - иначе пункт ЦЕЛИКОМ (со своими вложенными списками) переезжает в
     *    подсписок предыдущего пункта — существующий того же типа (нумерация
     *    продолжается) либо новый.
     *
     * Нативный undo-стек Chromium своей мутации не видит (Ctrl+Z шаг indent не
     * откатит) — осознанная плата: нормализатор и раньше мутировал DOM после
     * execCommand, т.е. стек и так был неточен.
     * @param {Element} li Пункт списка (из _caretListItem).
     * @returns {boolean} true — уровень изменён (вызывающий обязан сохранить).
     */
    _indentListItem(li) {
        const list = li ? li.parentNode : null;
        if (!this._isListElement(list)) return false;
        const host = li.previousElementSibling;
        if (!host || host.tagName !== 'LI') return false;

        // Каретка стоит в узлах САМОГО пункта: они переезжают вместе с ним и
        // остаются валидными — снимок по ним и пересобирается (живой Range
        // переезда не переживает, см. _captureCaretRange).
        const caret = this._captureCaretRange();
        this._sublistHost(host, list.tagName).appendChild(li);
        this._restoreCaretRange(caret);
        return true;
    },

    /**
     * @private Список-приёмник подпунктов внутри <li>: последний дочерний список
     * ТОГО ЖЕ типа (нумерация продолжается, а не стартует заново) либо новый
     * такой же в конце пункта.
     * @param {Element} li
     * @param {string} tagName 'UL'|'OL' — тип списка, из которого едет пункт.
     * @returns {Element}
     */
    _sublistHost(li, tagName) {
        const kids = Array.from(li.children || []);
        for (let i = kids.length - 1; i >= 0; i--) {
            if (kids[i].tagName === tagName) return kids[i];
        }
        const list = document.createElement(tagName.toLowerCase());
        li.appendChild(list);
        return list;
    },

    /**
     * @private Поднимает пункт списка на уровень — СВОЯ реализация вместо
     * нативного execCommand('outdent') (пара к _indentListItem). Нативная
     * команда роняла пункт РЯДОМ с подсписком или прямо внутрь чужого <li>
     * (форма «li внутри li»), которую не понимают ни DOCX-сегментатор, ни
     * MD/TXT, ни превью, — нормализатор потом чинил её задним числом.
     *
     * Правила (как в Word/ProseMirror):
     *  - хвост пункта (следующие соседи по его списку) обязан остаться на
     *    СВОЁМ уровне, а пункт уезжает выше — значит, хвост становится
     *    подпунктами самого пункта;
     *  - подсписок лежит в <li> (канон) → пункт встаёт СЛЕДУЮЩИМ за этим <li>;
     *  - список верхнего уровня → пункт выходит из списка АБЗАЦЕМ
     *    (_listItemToParagraph): чистый split, список делится на «до» и «после»;
     *  - опустевший список удаляется (остатки не теряем — см. _dropEmptyList).
     *
     * Как и у indent, нативный undo-стек своей мутации не видит.
     * @param {Element} li Пункт списка (из _caretListItem/_selectedListItems).
     * @returns {boolean} true — уровень изменён (вызывающий обязан сохранить).
     */
    _outdentListItem(li) {
        const list = li ? li.parentNode : null;
        if (!this._isListElement(list)) return false;
        const container = list.parentNode;
        if (!container) return false;

        const caret = this._captureCaretRange();
        const tail = [];
        for (let node = li.nextSibling; node; node = node.nextSibling) tail.push(node);
        if (tail.some(node => node.nodeType === 1)) {
            const host = this._sublistHost(li, list.tagName);
            tail.forEach(node => host.appendChild(node));
        }

        if (container.tagName === 'LI') {
            container.parentNode.insertBefore(li, container.nextSibling);
        } else if (this._isListElement(container)) {
            // Невалидная вложенность (список прямо в списке), ещё не прошедшая
            // нормализацию в живом DOM: уровнем выше здесь — сам внешний список.
            container.insertBefore(li, list.nextSibling);
        } else {
            const para = this._listItemToParagraph(li, list, container);
            // Каретка могла стоять на САМОМ <li> (штатное состояние Chromium
            // для пустого пункта `<li><br></li>`), а он уходит из документа —
            // снимок надо перецелить на созданный абзац. Иначе диапазон
            // собирается на отсоединённом узле, addRange его молча глотает, и
            // каретка пропадает: следующий ввод уходит мимо редактора.
            if (caret && caret.sc === li) { caret.sc = para; caret.so = 0; }
            if (caret && caret.ec === li) { caret.ec = para; caret.eo = 0; }
        }
        this._dropEmptyList(list);
        this._restoreCaretRange(caret);
        return true;
    },

    /**
     * @private Пункт списка ВЕРХНЕГО уровня выходит из списка абзацем: свой
     * контент — в <div> сразу за списком, собственные подсписки — списками за
     * абзацем (они поднимаются вместе с пунктом). Хвост списка к этому моменту
     * уже уехал в подсписок пункта (_outdentListItem), поэтому порядок
     * содержимого сохраняется: «до» остаётся в исходном списке, «после» встаёт
     * списком за абзацем. Пустой абзац получает <br> — иначе Chromium рисует
     * его нулевой высоты и в него не встать кареткой.
     * @param {Element} li
     * @param {Element} list Список, из которого уходит пункт.
     * @param {Element} container Родитель списка (редактор или блок).
     * @returns {Element} Созданный абзац (в него перецеливается каретка, если
     *   она стояла на самом <li> — узел уезжает из документа).
     */
    _listItemToParagraph(li, list, container) {
        const anchor = list.nextSibling; // якорь ДО мутаций: место сразу за списком
        const para = document.createElement('div');
        const sublists = [];
        while (li.firstChild) {
            const child = li.firstChild;
            li.removeChild(child);
            if (this._isListElement(child)) sublists.push(child);
            else para.appendChild(child);
        }
        if (!para.firstChild) para.appendChild(document.createElement('br'));
        list.removeChild(li);
        container.insertBefore(para, anchor);
        for (const sub of sublists) container.insertBefore(sub, anchor);
        return para;
    },

    /**
     * @private Удаляет список, в котором не осталось пунктов. Остатки (пробелы
     * между тегами, чужая разметка) переезжают на место списка — контент не
     * теряется даже на кривой разметке.
     * @param {Element} list
     */
    _dropEmptyList(list) {
        if (!list || !list.parentNode) return;
        if (Array.from(list.children || []).some(child => child.tagName === 'LI')) return;
        while (list.firstChild) list.parentNode.insertBefore(list.firstChild, list);
        list.parentNode.removeChild(list);
    },

    /**
     * @private Снимок каретки/выделения ПЛОСКИМИ значениями (узел + смещение).
     * Клон Range не годится: Range живой, и удаление узла из документа (а
     * перенос <li> начинается именно с удаления) по спеке переставляет границы
     * ВСЕХ живых диапазонов, включая клон, на место удалённого узла в СТАРОМ
     * родителе — каретка уезжала бы из пункта в промежуток внешнего списка.
     * Сами узлы переезжают вместе с пунктом и остаются валидными, по ним
     * диапазон и пересобирается.
     * @returns {{sc: Node, so: number, ec: Node, eo: number}|null}
     */
    _captureCaretRange() {
        const sel = (typeof window.getSelection === 'function') ? window.getSelection() : null;
        if (!sel || sel.rangeCount === 0) return null;
        const range = sel.getRangeAt(0);
        if (!range || !range.startContainer) return null;
        return {
            sc: range.startContainer,
            so: range.startOffset || 0,
            ec: range.endContainer || range.startContainer,
            eo: (range.endContainer ? range.endOffset : range.startOffset) || 0,
        };
    },

    /**
     * @private Возвращает каретку/выделение по снимку _captureCaretRange.
     * Стабы node-тестов Range не собирают — тогда восстановление пропускается.
     * @param {{sc: Node, so: number, ec: Node, eo: number}|null} snapshot
     */
    _restoreCaretRange(snapshot) {
        if (!snapshot || !snapshot.sc) return;
        // Отсоединённый узел (удалённый мутацией) в диапазон не годится:
        // selection ушла бы за пределы документа и каретка исчезла бы совсем —
        // лучше оставить её там, куда браузер поставил сам.
        if (snapshot.sc.isConnected === false) return;
        const sel = (typeof window.getSelection === 'function') ? window.getSelection() : null;
        if (!sel || typeof sel.removeAllRanges !== 'function') return;
        if (typeof document.createRange !== 'function') return;
        const range = document.createRange();
        range.setStart(snapshot.sc, snapshot.so);
        range.setEnd(snapshot.ec, snapshot.eo);
        sel.removeAllRanges();
        sel.addRange(range);
    },

    /**
     * @private Приводит вложенность списков к ВАЛИДНОЙ — страховка для правок,
     * пришедших мимо собственного indent (paste, undo, внешний HTML, контент,
     * сохранённый прежней версией). Невалидная форма — ul|ol прямо внутри ul|ol,
     * минуя <li>: её не понимают ни сегментатор DOCX, ни MD/TXT-конвертер, ни
     * CSS превью.
     *
     * Правила:
     *  - <li> прямо внутри <li> (артефакт нативного outdent, вставки внешнего
     *    HTML и старого контента) → пункт всплывает СЛЕДУЮЩИМ за своим бывшим
     *    хозяином: его маркер браузер рисует посреди чужой строки, а
     *    DOCX/MD/TXT считают такой пункт частью хозяина;
     *  - есть предыдущий соседний <li> → список переезжает внутрь него;
     *  - нет (список-сирота) → РАЗВЁРТКА на уровень вверх: на месте списка
     *    остаётся его собственное содержимое. Пустой <li>-хост больше не
     *    выдумывается — его маркер рисовался отдельным пунктом (та самая строка
     *    «a) i. 1. Текст») и давал фантомную строку в MD/TXT;
     *  - внутри <li> соседние подсписки ОДНОГО типа сливаются в первый: два
     *    ol-сиблинга нумеровались бы каждый с начала (и в превью, и в DOCX).
     *    Разные типы (ul рядом с ol) не сливаются — это разные подсписки пункта.
     *
     * Работает и на живом DOM редактора (каретка переезжает вместе с поддеревом),
     * и на DocumentFragment из <template> (строковый путь ниже). Идемпотентно.
     * @param {HTMLElement|DocumentFragment} root
     */
    _normalizeListNesting(root) {
        if (!root || typeof root.querySelectorAll !== 'function') return;
        for (let pass = 0; pass < NORMALIZE_MAX_PASSES; pass++) {
            let changed = false;
            // Пункты — ПЕРЕД списками: всплывший из чужого <li> пункт может сам
            // оказаться хозяином подсписка, и правилам ниже он нужен уже на
            // своём месте. Снимок в порядке документа: вложенный пункт идёт
            // после своего хозяина, поэтому цепочка «li в li в li»
            // распрямляется за один проход.
            for (const owner of Array.from(root.querySelectorAll('li'))) {
                if (!owner.parentNode) continue;
                const strays = Array.from(owner.children || [])
                    .filter(child => child.tagName === 'LI');
                if (!strays.length) continue;
                // Якорь ОДИН на всю группу: вставляя каждого «перед тем, что
                // шло за хозяином», сохраняем их взаимный порядок (по одному
                // «сразу за хозяином» — перевернули бы).
                const anchor = owner.nextSibling;
                for (const stray of strays) owner.parentNode.insertBefore(stray, anchor);
                changed = true;
            }
            // Снимок ДО мутаций: переносы меняют состав childNodes, но не
            // родительские связи ещё не обойдённых списков — порядок обхода
            // (сверху вниз) остаётся корректным.
            for (const list of Array.from(root.querySelectorAll('ul, ol'))) {
                const parent = list.parentNode;
                if (!this._isListElement(parent)) continue;
                const host = list.previousElementSibling;
                if (host && host.tagName === 'LI') {
                    host.appendChild(list);
                } else {
                    while (list.firstChild) parent.insertBefore(list.firstChild, list);
                    parent.removeChild(list);
                }
                changed = true;
            }
            for (const li of Array.from(root.querySelectorAll('li'))) {
                if (this._mergeSublists(li)) changed = true;
            }
            if (!changed) return;
        }
    },

    /**
     * @private Сливает соседние подсписки ОДНОГО типа внутри пункта: дети
     * второго переезжают в конец первого, второй удаляется.
     * @param {Element} li
     * @returns {boolean} true — что-то слито.
     */
    _mergeSublists(li) {
        let merged = false;
        let kids = Array.from(li.children || []);
        let i = 0;
        while (i < kids.length - 1) {
            const first = kids[i];
            const next = kids[i + 1];
            if (this._isListElement(first) && first.tagName === next.tagName) {
                while (next.firstChild) first.appendChild(next.firstChild);
                li.removeChild(next);
                kids = Array.from(li.children || []);
                merged = true;
                continue; // тот же i: за слитым списком мог стоять третий
            }
            i++;
        }
        return merged;
    },

    /**
     * @private Та же нормализация, но строка→строка — для стока saveContent
     * (правка могла прийти мимо execCommand: paste, undo, внешний источник).
     * Парсит в detached <template>, живой DOM не трогает. HTML без списков
     * возвращается тем же значением (дешёвый гейт, ср. _repairCapsulesReport).
     * @param {string} html
     * @returns {string}
     */
    _normalizeListNestingHtml(html) {
        if (typeof html !== 'string' || !LIST_TAG_RE.test(html)) return html;
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        this._normalizeListNesting(tpl.content);
        return tpl.innerHTML;
    },

    /**
     * @private D2: снимает БЛОЧНОЕ форматирование — то, что нативный
     * execCommand('removeFormat') по спецификации не трогает: списки
     * (разворачиваются в строки, разделённые <br>), blockquote (артефакт
     * indent вне списка), выравнивание и отступы.
     *
     * СКОУП — ПО ВЫДЕЛЕНИЮ, как у нативной команды: проход по всему блоку
     * сносил бы ВСЕ списки и выравнивание редактора из-за одного выделенного
     * жирного слова (и тут же персистил это через saveContent).
     *  - невырожденное выделение: только узлы, пересекающие диапазон; стили
     *    самого корня — лишь когда диапазон покрывает всё его содержимое
     *    (иначе Ctrl+A не смог бы снять text-align с редактора);
     *  - схлопнутая каретка: только её собственная цепочка предков (список/
     *    blockquote, в которых она стоит), а не весь редактор;
     *  - диапазона нет вовсе (программный вызов): прежняя семантика — блок целиком.
     *
     * ИНВАРИАНТ: капсулы ссылок/сносок обязаны выжить — их содержимое не
     * разбирается, style не чистится (у капсулы он свой, не блочный).
     * @param {HTMLElement} root Редактор (или любой контейнер).
     * @param {Range} [range] Диапазон-скоуп; по умолчанию — текущее выделение.
     */
    _removeBlockFormat(root, range) {
        if (!root || typeof root.querySelectorAll !== 'function') return;

        const sel = (typeof window !== 'undefined' && typeof window.getSelection === 'function')
            ? window.getSelection() : null;
        const scope = range || ((sel && sel.rangeCount > 0) ? sel.getRangeAt(0) : null);

        let inScope;
        let clearRoot;
        if (!scope) {
            inScope = () => true;
            clearRoot = true;
        } else if (!scope.collapsed && typeof scope.intersectsNode === 'function') {
            inScope = (el) => scope.intersectsNode(el);
            clearRoot = this._rangeCoversContents(scope, root);
        } else {
            const chain = this._caretAncestorChain(scope.startContainer, root);
            inScope = (el) => chain.has(el);
            clearRoot = false;
        }

        // Состав целей считаем ДО первой мутации: развороты списков двигают
        // узлы, и границы диапазона после них проверять уже нельзя.
        // Списки — изнутри наружу: в document order вложенный список идёт ПОСЛЕ
        // своего контейнера, поэтому обратный порядок разворачивает сначала его
        // (иначе внешний унёс бы вложенный вместе с <li>).
        const lists = Array.from(root.querySelectorAll('ul, ol')).reverse().filter(inScope);
        // blockquote — то, во что Chromium заворачивает indent ВНЕ списка.
        const quotes = Array.from(root.querySelectorAll('blockquote')).reverse().filter(inScope);
        // Выравнивание и отступы — плюс сам редактор: justify* в contenteditable
        // без блочных детей пишет text-align прямо на корне.
        const styled = Array.from(root.querySelectorAll('*')).filter(inScope);
        if (clearRoot) styled.push(root);

        lists.forEach(list => this._unwrapListBlock(list));
        quotes.forEach(bq => this._unwrapPlainBlock(bq));
        for (const el of styled) {
            if (this._isCapsule && this._isCapsule(el)) continue;
            if (el.style && typeof el.style.removeProperty === 'function') {
                BLOCK_FORMAT_PROPS.forEach(prop => el.style.removeProperty(prop));
            }
            if (typeof el.removeAttribute === 'function') el.removeAttribute('align');
        }
    },

    /**
     * @private Диапазон покрывает ВСЁ содержимое контейнера? Литералы 0/2 —
     * Range.START_TO_START / Range.END_TO_END (без зависимости от глобала Range,
     * тем же соображением, что литералы Node.* в _listItemAncestor).
     * @param {Range} range
     * @param {HTMLElement} root
     * @returns {boolean}
     */
    _rangeCoversContents(range, root) {
        if (typeof range.compareBoundaryPoints !== 'function'
            || typeof document.createRange !== 'function') return false;
        const whole = document.createRange();
        whole.selectNodeContents(root);
        return range.compareBoundaryPoints(0, whole) <= 0
            && range.compareBoundaryPoints(2, whole) >= 0;
    },

    /**
     * @private Элементы-предки узла в пределах контейнера (сам контейнер НЕ
     * входит) — скоуп блочной очистки для схлопнутой каретки.
     * @param {Node} node
     * @param {HTMLElement} root
     * @returns {Set<Element>}
     */
    _caretAncestorChain(node, root) {
        const chain = new Set();
        let el = node && node.nodeType === 3 ? node.parentNode : node;
        while (el && el !== root && typeof root.contains === 'function' && root.contains(el)) {
            if (el.nodeType === 1) chain.add(el);
            el = el.parentNode;
        }
        return chain;
    },

    /**
     * @private Разворачивает <ul>/<ol> в поток: содержимое каждого <li> уходит
     * на место списка, пункты разделяются <br>. Ведущий <br> ставится, только
     * если перед списком уже есть содержимое (иначе получили бы пустую строку).
     * @param {Element} list
     */
    _unwrapListBlock(list) {
        const parent = list.parentNode;
        if (!parent) return;
        const items = Array.from(list.children || []).filter(ch => ch.tagName === 'LI');
        items.forEach((li, idx) => {
            if (idx > 0 || this._hasContentBefore(list)) {
                parent.insertBefore(document.createElement('br'), list);
            }
            while (li.firstChild) parent.insertBefore(li.firstChild, list);
        });
        // Остаток: опустошённые <li> и пробельные узлы выбрасываем, любое
        // непустое содержимое (чужая разметка внутри списка) выносим наружу.
        while (list.firstChild) {
            const node = list.firstChild;
            const emptyItem = node.nodeType === 1 && node.tagName === 'LI' && !node.firstChild;
            const blankText = node.nodeType === 3 && !/\S/.test(node.data || '');
            if (emptyItem || blankText) list.removeChild(node);
            else parent.insertBefore(node, list);
        }
        parent.removeChild(list);
    },

    /**
     * @private Разворачивает блочный контейнер (blockquote) в поток, сохраняя
     * его содержимое.
     * @param {Element} block
     */
    _unwrapPlainBlock(block) {
        const parent = block.parentNode;
        if (!parent) return;
        if (block.firstChild && this._hasContentBefore(block)) {
            parent.insertBefore(document.createElement('br'), block);
        }
        while (block.firstChild) parent.insertBefore(block.firstChild, block);
        parent.removeChild(block);
    },

    /**
     * @private Перед узлом есть значимое содержимое (элемент или непробельный
     * текст)? Решает, нужен ли разделяющий <br> при разворачивании блока.
     * @param {Node} node
     * @returns {boolean}
     */
    _hasContentBefore(node) {
        let sib = node.previousSibling;
        while (sib) {
            if (sib.nodeType === 1) return true;
            if (sib.nodeType === 3 && /\S/.test(sib.data || '')) return true;
            sib = sib.previousSibling;
        }
        return false;
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
