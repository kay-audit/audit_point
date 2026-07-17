/**
 * Капсула-интегритет: предохранитель целостности ссылок/сносок на записи в БД.
 * Часть prevent-then-heal-механизма (слои beforeinput/observer — в этом же
 * файле, добавляются отдельными задачами). Здесь — чистый валидатор-починка.
 */
import { TextBlockManager } from './textblock-core.js';

Object.assign(TextBlockManager.prototype, {
    /**
     * Чинит инварианты капсул в HTML-строке ПЕРЕД сохранением/при загрузке.
     * Чистая по сигнатуре (строка→строка), идемпотентна, парсит в detached
     * <template> (живой DOM не трогает). Чинит:
     *  - дубль data-*-id у независимых капсул → клону свежий id;
     *  - расщеплённый клон (тот же id, соседи, то же значение) → склейка;
     *  - пустой data-link-url/data-footnote-text → разворот в plain-text;
     *  - страховочный стрип guard-символов (U+FEFF) и contenteditable.
     * @param {string} html
     * @returns {string}
     */
    validateAndRepairCapsules(html) {
        return this._repairCapsulesReport(html).html;
    },

    /**
     * @private CORE-2b: как validateAndRepairCapsules, но возвращает ещё и
     * признак РЕАЛЬНОЙ структурной починки (дубль-id / расщеплённый клон /
     * пустая капсула), НЕ считая косметику — снятие contenteditable, стрип
     * guard'ов, ре-сериализацию <template> (они меняют строку всегда, поэтому
     * сравнение repaired!==input ненадёжно). Нужен write-back'у на blur: живой
     * DOM синхронизируем с починенным content ТОЛЬКО когда валидатор реально
     * чинил капсулу, иначе — DOM-шторм на каждом blur.
     * @param {string} html
     * @returns {{html: string, changed: boolean}}
     */
    _repairCapsulesReport(html) {
        if (typeof html !== 'string') return { html, changed: false };
        if (html.indexOf('text-link') === -1 && html.indexOf('text-footnote') === -1) {
            const stripped = this._stripGuards ? this._stripGuards(html) : html;
            return { html: stripped, changed: false };
        }
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        const changed = this._repairCapsulesInRoot(tpl.content);
        // §6.8: валидатор реально чинил капсулу (пустая развёрнута / клон склеен /
        // дубль-id переназначен) — фиксируем в телеметрии.
        if (changed) window.EditorTelemetry?.track?.('capsule_repair');
        return { html: tpl.innerHTML, changed };
    },

    /**
     * @private Починка капсул внутри root-узла (DocumentFragment ИЛИ живой
     * editor). Общая логика для валидатора и слоя-observer (DRY).
     * @param {DocumentFragment|HTMLElement} root
     * @returns {boolean} была ли СТРУКТУРНАЯ починка (пустая капсула развёрнута,
     *   расщеплённый клон склеен, дубль-id переназначен). Косметика (снятие
     *   contenteditable, стрип guard'ов) сюда НЕ входит — нужно write-back'у.
     */
    _repairCapsulesInRoot(root) {
        const guardChar = this.CAP_GUARD_CHAR;
        // id → первая встреченная капсула с этим id (в document order)
        const seen = new Map();
        // #11: множество ВСЕХ id капсул документа, включая ещё не обойдённые.
        // Дериватив дубля ('<id>_d<n>') не должен совпасть с литеральным id,
        // стоящим ПОЗЖЕ по порядку: иначе тот при обходе счёлся бы дублем и был
        // переименован зря (+ ложный dup_id_fix). Собираем один раз до цикла.
        const allIds = new Set();
        root.querySelectorAll('.text-link, .text-footnote').forEach(span => {
            const idAttr = span.classList.contains('text-link') ? 'data-link-id' : 'data-footnote-id';
            const id = span.getAttribute(idAttr);
            if (id) allIds.add(id);
        });
        let changed = false;
        root.querySelectorAll('.text-link, .text-footnote').forEach(span => {
            const isLink = span.classList.contains('text-link');
            const idAttr = isLink ? 'data-link-id' : 'data-footnote-id';
            const valAttr = isLink ? 'data-link-url' : 'data-footnote-text';

            // Тело капсулы — без contenteditable и guard-символов.
            span.removeAttribute('contenteditable');
            // .node-selected — рантайм-only визуальная отметка «вся капсула как
            // юнит»; в хранимый content/превью/DOCX не попадает (косметика, как
            // contenteditable — changed не взводим). contains-гейт: на фейк-узлах
            // node-тестов (classList без .remove) .remove не зовётся.
            if (span.classList && span.classList.contains('node-selected')) {
                span.classList.remove('node-selected');
            }
            if (span.textContent && span.textContent.indexOf(guardChar) !== -1) {
                span.textContent = span.textContent.split(guardChar).join('');
            }

            // Пустое значение → развернуть капсулу в её текст.
            const val = span.getAttribute(valAttr);
            if (!val || !val.trim()) {
                const text = document.createTextNode(span.textContent || '');
                if (span.parentNode) span.parentNode.replaceChild(text, span);
                changed = true;
                return;
            }

            // Дубль id: смотрим — расщеплённый клон (склеить) или независимый (новый id).
            const id = span.getAttribute(idAttr);
            if (id && seen.has(id)) {
                const first = seen.get(id);
                if (this._areAdjacentSplit(first, span, valAttr)) {
                    first.textContent = (first.textContent || '') + (span.textContent || '');
                    if (span.parentNode) span.parentNode.removeChild(span);
                    changed = true;
                    return;
                }
                const fresh = this._derivedDuplicateId(id, seen, allIds);
                span.setAttribute(idAttr, fresh);
                seen.set(fresh, span);
                changed = true;
                // §6.8: детерминированная починка дубль-id — отдельный счётчик
                // (подмножество capsule_repair, детализация в телеметрии).
                window.EditorTelemetry?.track?.('dup_id_fix');
                return;
            }
            if (id) seen.set(id, span);
        });
        if (this._cleanCapGuards) this._cleanCapGuards(root);
        return changed;
    },

    /**
     * @private Две капсулы — расщеплённый клон одного маркера? (один родитель,
     * между ними только незначимые узлы, равные значения). extractContents с
     * границей внутри маркера делает именно такой клон.
     * @param {Element} a
     * @param {Element} b
     * @param {string} valAttr
     * @returns {boolean}
     */
    _areAdjacentSplit(a, b, valAttr) {
        if (a.parentNode !== b.parentNode) return false;
        if (a.getAttribute(valAttr) !== b.getAttribute(valAttr)) return false;
        let n = a.nextSibling;
        while (n && n !== b) {
            if (!this._isInsignificantText(n)) return false;
            n = n.nextSibling;
        }
        return n === b;
    },

    /**
     * @private CORE-2: ДЕТЕРМИНИРОВАННЫЙ id для дубля капсулы. Прежний
     * _freshMarkerId (Date.now()+Math.random()) давал на каждом save РАЗНЫЙ id —
     * если необработанный ввод оставлял в DOM дубль-id, каждое сохранение писало
     * иной content («вечно грязный» акт), а живой DOM расходился с сохранённым до
     * ре-рендера. Дериватив от исходного id + порядкового номера дубля: тот же
     * вход → побайтно тот же выход; после первой починки дубля уже нет, повторный
     * прогон валидатора ничего не трогает (идемпотентность). Суффикс '_d<n>'
     * держит id opaque (нигде не парсится) и проходит DOMPurify (значение data-*
     * не ограничено). Коллизию с уже назначенным (seen) ИЛИ существующим где-либо
     * в документе (allIds, #11) id обходим инкрементом n, сохраняя детерминизм
     * (порядок обхода — document order).
     * @param {string} baseId дублирующийся id
     * @param {Map} seen уже назначенные id (в т.ч. деривативы)
     * @param {Set} [allIds] все исходные id документа, включая ещё не обойдённые
     * @returns {string}
     */
    _derivedDuplicateId(baseId, seen, allIds = null) {
        let n = 1;
        const taken = (cand) => seen.has(cand) || (allIds !== null && allIds.has(cand));
        while (taken(baseId + '_d' + n)) n += 1;
        return baseId + '_d' + n;
    },

    /**
     * @private Капсула в режиме inline-правки (двойной клик — enableInlineEditing):
     * временно contenteditable='true' + класс 'editing-mode'. В этом режиме её тело —
     * обычный редактируемый текст, поэтому слои целостности (beforeinput, expand,
     * observer) НЕ трактуют её как атомарный contenteditable=false-атом: не расширяют
     * за неё диапазон, не перенаправляют ввод, не удаляют целиком, не откатывают
     * contenteditable. Единый предикат «капсула в правке» для ВСЕХ слоёв (CARET-1) —
     * тот же критерий, что использует observer.
     * @param {Node} node
     * @returns {boolean}
     */
    _isEditingCapsule(node) {
        return this._isCapsule(node) && node.classList.contains('editing-mode');
    },

    /**
     * Слой 1 (prevent): перехват нативных правок ДО мутации DOM. Останавливает
     * порчу капсул — атомарное удаление, ввод снаружи, неклипающее удаление.
     * @param {InputEvent} e
     * @param {HTMLElement} editor
     * @param {object} textBlock
     */
    handleEditorBeforeInput(e, editor, textBlock) {
        // Re-entrancy: наш собственный execCommand('delete') в _execDeleteRange
        // («вся капсула») синхронно диспатчит вложенный beforeinput. Под взведённым
        // __suppressBeforeInput он — no-op: иначе whole-capsule-ветка ниже
        // перехватила бы его и отменила команду. ОТДЕЛЬНЫЙ флаг, а не __healing
        // (тот — приватный гард MutationObserver'а): один флаг — один контракт,
        // чтобы будущий observer-only healer, взводящий __healing, случайно не
        // отключил защиты beforeinput (перехват delete/insert/whole-capsule).
        if (editor.__suppressBeforeInput) return;
        const ranges = typeof e.getTargetRanges === 'function' ? e.getTargetRanges() : [];
        const type = e.inputType;

        const DELETE_TYPES = ['deleteContentBackward', 'deleteContentForward',
            'deleteWordBackward', 'deleteWordForward', 'deleteByCut',
            'deleteByDrag', 'deleteSoftLineBackward'];
        const INSERT_TEXT_TYPES = ['insertText', 'insertReplacementText'];

        if (DELETE_TYPES.includes(type)) {
            if (!ranges.length) return;
            const r = ranges[0];
            // (а) схлопнутое удаление, примыкающее к капсуле → удалить целиком.
            if (r.collapsed) {
                const hit = this._staticRangeTouchesCapsule(r, editor);
                if (hit && (hit.side === 'before' || hit.side === 'after')) {
                    const forward = (type === 'deleteContentForward' || type === 'deleteWordForward');
                    // Backspace удаляет капсулу СЛЕВА от каретки, Delete — СПРАВА.
                    const target = forward
                        ? (hit.side === 'before' ? hit.capsule : null)
                        : (hit.side === 'after' ? hit.capsule : null);
                    if (target) {
                        e.preventDefault();
                        this._deleteCapsuleWhole(target, editor);
                        // Единый сток: удаление капсулы могло убрать сноску —
                        // finalizeEdit перенумеровывает по изменению их числа
                        // (CARET-7) и пере-расставляет guard'ы у оставшихся капсул.
                        this.finalizeEdit(editor);
                    }
                }
                return;
            }
            // (б) непустое удаление, клипающее тело капсулы → расширить и удалить.
            const hit = this._staticRangeTouchesCapsule(r, editor);
            if (hit && hit.side === 'inside') {
                e.preventDefault();
                const range = this._expandStaticRangeOutOfMarkers(r, editor);
                range.deleteContents();
                // Единый сток ДО восстановления каретки: normalize двигает
                // guard'ы, перенумерация — по изменению числа сносок (удаление
                // клипнутой капсулы; CARET-7).
                this.finalizeEdit(editor);
                const sel = window.getSelection();
                if (sel) { sel.removeAllRanges(); sel.addRange(range); }
                return;
            }
            // (в) «Вся капсула как юнит»: выделена РОВНО одна капсула целиком →
            // атомарное удаление ОДНОЙ undo-записью. Делегируем в
            // _deleteCapsuleWhole (тот же надёжный путь, что и примыкающее
            // Backspace/Delete): он строит диапазон setStartBefore/setEndAfter
            // ЗА капсулу и её guard'ы. Расширять r напрямую нельзя — его границы
            // лежат ВНЕ капсулы, поэтому _expandStaticRangeOutOfMarkers был бы
            // no-op и execCommand('delete') мог не удалить голый ce=false-атом.
            const whole = this._rangeIsWholeCapsule(r, editor);
            if (whole) {
                e.preventDefault();
                this._deleteCapsuleWhole(whole, editor);
                this.finalizeEdit(editor);
            }
            return;
        }

        if (INSERT_TEXT_TYPES.includes(type)) {
            if (!ranges.length) return;
            const hit = this._staticRangeTouchesCapsule(ranges[0], editor);
            if (hit && hit.side === 'inside') {
                // Ввод пришёлся в тело капсулы → перенаправляем наружу.
                e.preventDefault();
                this._placeCaretBesideMarker(hit.capsule, true); // каретка справа от капсулы
                const sel = window.getSelection();
                if (sel && sel.rangeCount && e.data) {
                    const range = sel.getRangeAt(0);
                    range.insertNode(document.createTextNode(e.data));
                    range.collapse(false);
                    sel.removeAllRanges(); sel.addRange(range);
                }
                // Единый сток вместо прямых saveContent+_toggleEmptyClass (Task
                // 1.3.4-B2): finalizeEdit покрывает те же шаги и ДОПОЛНИТЕЛЬНО мост
                // персистентности (Task 1.3.4-A) — без него поле нарушения (не
                // textblock) не попадало бы в модель через этот редирект-путь.
                this.finalizeEdit(editor);
            }
        }
        // insertCompositionText (IME), historyUndo/Redo, insertFromDrop —
        // не вмешиваемся, страхует слой 3.
    },

    /**
     * @private Классифицирует StaticRange относительно капсул редактора.
     * @returns {{capsule: Element, side: 'before'|'after'|'inside'}|null}
     */
    _staticRangeTouchesCapsule(range, editor) {
        const sc = range.startContainer, so = range.startOffset;
        const ec = range.endContainer, eo = range.endOffset;

        // Конец/начало ВНУТРИ тела капсулы (граница клипает атом). Единый обход
        // границ _capsuleAncestor (textblock-core.js) — тот же, что у expand-
        // хелперов; сам возвращает null для капсулы в inline-правке (editing-mode
        // → её тело сейчас обычный текст, CARET-1).
        const insStart = this._capsuleAncestor(sc, editor);
        const insEnd = this._capsuleAncestor(ec, editor);
        if (insStart || insEnd) return { capsule: insStart || insEnd, side: 'inside' };

        // Схлопнутая каретка примыкает к капсуле (через guard или напрямую).
        // Защитная ветка: реальный Chromium при нажатии Backspace/Delete у капсулы
        // возвращает НЕсхлопнутый getTargetRanges(), покрывающий всю capsule целиком,
        // — этот блок срабатывает для не-Chromium браузеров и программного ввода.
        if (sc === ec && so === eo) {
            let before = null, after = null;
            if (sc.nodeType === 3) {
                if (so === 0) before = this._significantSibling(sc, 'previousSibling');
                if (so === sc.length) after = this._significantSibling(sc, 'nextSibling');
                // каретка внутри текста (0<so<len) — к капсуле не примыкает
            } else {
                const rawBefore = sc.childNodes[so - 1] || null;
                const rawAfter = sc.childNodes[so] || null;
                before = this._isInsignificantText(rawBefore)
                    ? this._significantSibling(rawBefore, 'previousSibling') : rawBefore;
                after = this._isInsignificantText(rawAfter)
                    ? this._significantSibling(rawAfter, 'nextSibling') : rawAfter;
            }
            // Капсула в inline-правке к атомарному удалению не относится (CARET-1).
            if (this._isCapsule(before) && !this._isEditingCapsule(before)) {
                return { capsule: before, side: 'after' };  // капсула слева
            }
            if (this._isCapsule(after) && !this._isEditingCapsule(after)) {
                return { capsule: after, side: 'before' };   // капсула справа
            }
        }
        return null;
    },

    /**
     * @private Удаляет живой диапазон (охватывающий капсулу целиком + её guard'ы)
     * нативной командой delete — удаление ОСТАЁТСЯ в undo-стеке (Ctrl+Z вернёт
     * капсулу), в отличие от raw .remove()/deleteContents. Взводит ДВА флага +
     * takeRecords: (1) __healing — observer не запускает heal-шторм на удалении
     * guard'ов; (2) __suppressBeforeInput — вложенный beforeinput, который
     * execCommand('delete') диспатчит синхронно, гасится ранним return в
     * handleEditorBeforeInput (иначе рекурсия/отмена команды). Флаги раздельны:
     * у каждого свой единственный контракт. Финализацию (normalizeMarkers/
     * перенумерация/сохранение) делает ВЫЗЫВАЮЩИЙ через finalizeEdit после возврата.
     * @param {HTMLElement} editor
     * @param {Range} range
     */
    _execDeleteRange(editor, range) {
        const sel = window.getSelection();
        if (!sel) return;
        const wasHealing = editor && editor.__healing;
        const wasSuppress = editor && editor.__suppressBeforeInput;
        if (editor) { editor.__healing = true; editor.__suppressBeforeInput = true; }
        try {
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand('delete');
        } finally {
            if (editor && editor.__capsuleObserver && editor.__capsuleObserver.takeRecords) {
                editor.__capsuleObserver.takeRecords();
            }
            if (editor && !wasHealing) editor.__healing = false;
            if (editor && !wasSuppress) editor.__suppressBeforeInput = false;
        }
    },

    /**
     * @private Удаляет капсулу целиком вместе с её caret-guard'ами по бокам.
     * Единообразие undo: как и удаление ВЫДЕЛЕННОЙ целиком капсулы (ветка (в)
     * handleEditorBeforeInput), примыкающее Backspace/Delete идёт нативной
     * командой delete — остаётся в undo-стеке (раньше был raw .remove() ВНЕ него).
     * Диапазон строим за целую капсулу + её guard'ы. Фолбэк на .remove() — только
     * без editor/execCommand (не-браузерная среда).
     * @param {Element} capsule
     * @param {HTMLElement} [editor]
     */
    _deleteCapsuleWhole(capsule, editor) {
        const prev = capsule.previousSibling, next = capsule.nextSibling;
        if (editor && typeof document !== 'undefined' &&
                typeof document.execCommand === 'function' &&
                typeof document.createRange === 'function') {
            const range = document.createRange();
            if (this._isGuardNode(prev)) range.setStartBefore(prev);
            else range.setStartBefore(capsule);
            if (this._isGuardNode(next)) range.setEndAfter(next);
            else range.setEndAfter(capsule);
            this._execDeleteRange(editor, range);
            return;
        }
        // Фолбэк без редактора/execCommand: прямое удаление (вне undo-стека).
        if (this._isGuardNode(prev)) prev.remove();
        if (this._isGuardNode(next)) next.remove();
        capsule.remove();
    },

    // -------------------------------------------------------------------------
    // Слой 3 (heal): MutationObserver-страховка целостности капсул.
    // Чинит guard-узлы и contenteditable, если их убрало что-то вне наших слоёв
    // (IME, браузерное расширение, script, paste не через наш обработчик).
    // -------------------------------------------------------------------------

    /**
     * Устанавливает MutationObserver на editable-редактор. Идемпотентен:
     * при повторном вызове на тот же элемент сначала отключает старый observer.
     * Вызывается только из editable-ветки createEditor.
     * @param {HTMLElement} editor
     */
    installCapsuleObserver(editor) {
        if (editor.__capsuleObserver) editor.__capsuleObserver.disconnect();
        const observer = new MutationObserver((records) => this._onCapsuleMutations(records, editor));
        observer.observe(editor, {
            childList: true,
            subtree: true,
            characterData: true,
            characterDataOldValue: true,
            attributes: true,
            attributeFilter: ['contenteditable'],
        });
        editor.__capsuleObserver = observer;

        // CARET-8: на время IME-композиции observer буферизует mutation-records и
        // НЕ обрабатывает — heal под активной композицией (мутация узла-цели
        // insertCompositionText) сорвал бы ввод. По compositionend накопленное
        // прогоняется обычным pipeline. Слушатели вешаем один раз на элемент
        // (флаг), в тон idempotent-disconnect выше; editor берётся замыканием.
        if (!editor.__compositionBound) {
            editor.__compositionBound = true;
            editor.addEventListener('compositionstart', () => this._onCompositionStart(editor));
            editor.addEventListener('compositionend', () => this._flushComposition(editor));
        }
    },

    /**
     * @private Обработчик батча мутаций. Использует узкий триггер: реагирует
     * только на реальные нарушения инвариантов (guard удалён, contenteditable
     * сброшен, текст напечатан в guard), а НЕ на каждую структурную мутацию.
     * Широкий запуск normalizeMarkers на каждый childList нарушал бы
     * каретку при обычном вводе (normalizeMarkers пересоздаёт guard-узлы).
     *
     * Re-entrancy: флаг _healing (ранний return) + takeRecords() (сбрасываем
     * очередь записей, порождённых нашими собственными правками) — паттерн CKEditor.
     * @param {MutationRecord[]} records
     * @param {HTMLElement} editor
     */
    _onCapsuleMutations(records, editor) {
        if (editor.__healing) return;
        // CARET-8: во время IME-композиции копим records без обработки (мутация
        // узла под активной композицией сорвала бы ввод); прогон — по
        // compositionend через _flushComposition.
        if (editor.__composing) {
            if (!editor.__composingRecords) editor.__composingRecords = [];
            records.forEach(rec => editor.__composingRecords.push(rec));
            return;
        }
        const guardChar = this.CAP_GUARD_CHAR;
        let needGuardRestore = false;
        const capsulesToFix = [];
        let guardNodeToRestore = null;

        for (const rec of records) {
            if (rec.type === 'characterData') {
                // Текст напечатан в guard-узел (oldValue — чистый U+FEFF, стал длиннее).
                const node = rec.target;
                if (node.nodeType === 3 && rec.oldValue === guardChar && node.data !== guardChar) {
                    guardNodeToRestore = node;
                }
            } else if (rec.type === 'childList') {
                // Guard-узел удалён (имитация «пользователь стёр невидимый символ»).
                rec.removedNodes.forEach(n => {
                    if (n.nodeType === 3 && n.data === guardChar) needGuardRestore = true;
                });
            } else if (rec.type === 'attributes') {
                // contenteditable сброшен с капсулы → чиним. НО пропускаем
                // капсулу в режиме inline-правки (#1/CARET-1): enableInlineEditing по
                // двойному клику НАМЕРЕННО ставит contenteditable='true' + класс
                // 'editing-mode'; откат на 'false' убил бы правку текста
                // ссылки/сноски (focus попадал бы в уже не редактируемый span).
                // Единый предикат _isEditingCapsule — тот же, что и в слоях 1/2.
                if (this._isCapsule(rec.target) &&
                        !this._isEditingCapsule(rec.target) &&
                        rec.target.getAttribute('contenteditable') !== 'false') {
                    capsulesToFix.push(rec.target);
                }
            }
        }

        if (!guardNodeToRestore && !needGuardRestore && !capsulesToFix.length) return;

        // §6.8: observer реально чинит целостность капсул — фиксируем в телеметрии
        // (self-heal молчит, иначе о поломках узнаём только от пользователей).
        window.EditorTelemetry?.track?.('observer_heal');

        editor.__healing = true;
        try {
            // Текст в guard → вынести наружу, guard вернуть в U+FEFF.
            if (guardNodeToRestore && guardNodeToRestore.parentNode) {
                this._restoreGuard(guardNodeToRestore, editor);
            } else if (guardNodeToRestore) {
                // Guard опустошён И удалён в одном батче (реальный Backspace по
                // zero-width узлу: characterData U+FEFF→'' затем childList-remove
                // уже пустого узла; removedNode.data==='' — childList-ветка его не
                // распознаёт, а здесь узел уже отвязан). Точечно чинить нечего —
                // восстанавливаем расстановкой guard'ов. Без этого вертикальная
                // навигация ломается до перезахода на вкладку.
                needGuardRestore = true;
            }
            // Хирургически вернуть contenteditable на капсулы.
            capsulesToFix.forEach(cap => {
                if (this._isCapsule(cap)) cap.setAttribute('contenteditable', 'false');
            });
            // Восстановить guard'ы через нормализацию.
            if (needGuardRestore) {
                this.normalizeMarkers(editor);
            }
        } finally {
            // Сбрасываем очередь мутаций, порождённых нашими правками, чтобы
            // не вызвать повторный обход после снятия __healing.
            if (editor.__capsuleObserver) editor.__capsuleObserver.takeRecords();
            editor.__healing = false;
        }
    },

    /**
     * @private CARET-8: начало IME-композиции — переводим observer в режим
     * буферизации (_onCapsuleMutations копит records без обработки). Буфер
     * лениво инициализируем: повторный compositionstart поверх недослитого
     * буфера просто продолжает накопление (слив — на следующем compositionend).
     * @param {HTMLElement} editor
     */
    _onCompositionStart(editor) {
        editor.__composing = true;
        if (!editor.__composingRecords) editor.__composingRecords = [];
    },

    /**
     * @private CARET-8: конец IME-композиции — снимаем режим буферизации и
     * прогоняем накопленные records (плюс ещё не доставленные observer'ом —
     * takeRecords) обычным pipeline. Реальный IME в node/UT недоступен: путь
     * покрыт имитацией через прямой вызов _onCompositionStart/_flushComposition +
     * синтетические records.
     * @param {HTMLElement} editor
     */
    _flushComposition(editor) {
        editor.__composing = false;
        const observer = editor.__capsuleObserver;
        const pending = observer ? observer.takeRecords() : [];
        const buffered = editor.__composingRecords || [];
        editor.__composingRecords = null;
        const all = buffered.length ? buffered.concat(pending) : pending;
        if (all.length) this._onCapsuleMutations(all, editor);
    },

    /**
     * @private Текст напечатан в guard-узел → выносим символы наружу (после
     * guard), возвращаем guard к чистому U+FEFF, ставим каретку за вынесенным
     * текстом. Вызывается только внутри _onCapsuleMutations (_healing уже взведён).
     * @param {Text} node — guard-текстовый-узел с «загрязнённым» содержимым
     * @param {HTMLElement} editor
     */
    _restoreGuard(node, editor) {
        const guardChar = this.CAP_GUARD_CHAR;
        const typed = node.data.split(guardChar).join('');
        node.data = guardChar;
        if (typed) {
            const textNode = document.createTextNode(typed);
            node.parentNode.insertBefore(textNode, node.nextSibling);
            const sel = window.getSelection();
            if (sel) {
                const range = document.createRange();
                range.setStart(textNode, textNode.length);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
            }
        }
        // Единый сток: вынесенный из guard текст — реальная правка content
        // (changelog, TB-5). finalizeEdit зовётся под взведённым __healing;
        // повторный проход observer'а гасится ранним return + takeRecords.
        this.finalizeEdit(editor);
    },

    /** @private StaticRange → живой Range, расширенный за целые капсулы и их guard'ы. */
    _expandStaticRangeOutOfMarkers(staticRange, editor) {
        const range = document.createRange();
        range.setStart(staticRange.startContainer, staticRange.startOffset);
        range.setEnd(staticRange.endContainer, staticRange.endOffset);
        const sm = this._capsuleAncestor(range.startContainer, editor);
        if (sm) {
            // Если перед капсулой стоит guard-узел — включаем и его.
            const guardBefore = sm.previousSibling;
            if (this._isGuardNode(guardBefore)) range.setStartBefore(guardBefore);
            else range.setStartBefore(sm);
        }
        const em = this._capsuleAncestor(range.endContainer, editor);
        if (em) {
            // Если после капсулы стоит guard-узел — включаем и его.
            const guardAfter = em.nextSibling;
            if (this._isGuardNode(guardAfter)) range.setEndAfter(guardAfter);
            else range.setEndAfter(em);
        }
        return range;
    },

    /**
     * @private Узел, непосредственно СЛЕДУЮЩИЙ за границей (container, offset) —
     * первый узел, попадающий в диапазон с этой границы. null — граница в конце
     * контейнера. Для текстового контейнера: offset в конце → следующий сосед,
     * иначе сам текст. Чистая (для _rangeIsWholeCapsule и node-тестов).
     */
    _boundaryNodeAfter(container, offset) {
        if (!container) return null;
        if (container.nodeType === Node.TEXT_NODE) {
            const len = container.data ? container.data.length : 0;
            return offset >= len ? container.nextSibling : container;
        }
        return container.childNodes ? (container.childNodes[offset] || null) : null;
    },

    /**
     * @private Узел, непосредственно ПРЕДшествующий границе (container, offset) —
     * последний узел, попадающий в диапазон до этой границы. null — граница в
     * начале контейнера. Зеркало _boundaryNodeAfter.
     */
    _boundaryNodeBefore(container, offset) {
        if (!container) return null;
        if (container.nodeType === Node.TEXT_NODE) {
            return offset <= 0 ? container.previousSibling : container;
        }
        return container.childNodes ? (container.childNodes[offset - 1] || null) : null;
    },

    /**
     * @private «Вся капсула как юнит»: диапазон охватывает РОВНО одну капсулу
     * целиком (её границы — на/сразу-до начала капсулы, включая ведущий guard, и
     * на/сразу-после её конца, включая хвостовой guard), не клипая тело и ничего
     * сверх неё. Возвращает эту капсулу либо null. Капсула в inline-правке
     * (editing-mode) — обычный редактируемый текст, не атом → null (CARET-1).
     * READ-only: DOM не мутирует (безопасно звать на selectionchange). Работает и
     * на StaticRange (beforeinput), и на живом Range (Selection).
     * @param {Range|StaticRange} range
     * @param {HTMLElement} editor
     * @returns {Element|null}
     */
    _rangeIsWholeCapsule(range, editor) {
        if (!range || range.collapsed) return null;
        // Любая граница ВНУТРИ тела капсулы (клип атома) → выделение не целое.
        if (this._capsuleAncestor(range.startContainer, editor)) return null;
        if (this._capsuleAncestor(range.endContainer, editor)) return null;
        let first = this._boundaryNodeAfter(range.startContainer, range.startOffset);
        let last = this._boundaryNodeBefore(range.endContainer, range.endOffset);
        if (!first || !last) return null;
        // Ведущий/хвостовой guard'ы, попавшие в выделение, пропускаем — они часть
        // юнита капсулы (расстановка _placeCapGuards), а не отдельные узлы.
        if (this._isGuardNode(first)) first = first.nextSibling;
        if (this._isGuardNode(last)) last = last.previousSibling;
        if (!first || first !== last) return null;   // между границами не один узел
        if (!this._isCapsule(first)) return null;      // единственный узел — не капсула
        if (this._isEditingCapsule(first)) return null; // капсула в правке — не атом
        return first;
    },
});
