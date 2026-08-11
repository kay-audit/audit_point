/**
 * DOM-рендеринг diff с цветовой подсветкой.
 * Работает на основе результатов DiffEngine.compute().
 */
import { SafeHTML, renderActContent } from '../../shared/sanitize.js';
import { iterateVisibleCells } from '../../constructor/table/grid-merges.js';
import { VIOLATION_LABELS, getOrderedFieldKeys } from '../../constructor/violation/violation-fields.js';
import { BLOCK_TYPES } from '../../constructor/violation/violation-block-types.js';
import { DiffEngine } from './diff-engine.js';
import { INVOICE_FIELD_LABELS } from './invoice-diff-fields.js';
import { renderImageWithFallback, buildImagePlaceholder } from '../../constructor/violation/violation-image-render.js';

// Подписи блоков в дифе нарушения: заголовок секции блока.
const BLOCK_TYPE_LABELS = Object.freeze({
    [BLOCK_TYPES.TEXT]: 'Текст',
    [BLOCK_TYPES.IMAGE]: 'Картинка',
    [BLOCK_TYPES.TABLE]: 'Таблица',
});

// Подписи изменённых атрибутов блоков (картинка и таблица). url в списке нет
// намеренно — смена картинки показывается превью «Было/Стало», а не текстом.
const BLOCK_ATTR_LABELS = Object.freeze({
    caption: 'Подпись',
    filename: 'Файл',
    width: 'Ширина',
    gridResized: 'Размер сетки',
    cells: 'Изменено ячеек',
});

// Обрезка длинных значений в текстовых сводках (ячейки таблиц, атрибуты).
const MAX_INLINE_TEXT = 120;

export class DiffRenderer {
    /**
     * Рендерит полный diff в контейнер.
     * @param {HTMLElement} container
     * @param {Object} diffResult — результат DiffEngine.compute()
     * @param {boolean} onlyChanges — true = скрыть unchanged элементы
     */
    static render(container, diffResult, onlyChanges = false) {
        container.innerHTML = '';
        container.classList.toggle('diff-changes-only', onlyChanges);

        const tree = diffResult.tree?.tree;
        if (!tree) {
            container.innerHTML = '<div class="audit-log-empty">Нет данных дерева</div>';
            return;
        }

        this._renderDiffNode(container, tree, diffResult, 0, onlyChanges);

        // Удалённые узлы
        if (diffResult.tree?.removedNodes?.length) {
            for (const node of diffResult.tree.removedNodes) {
                this._renderDiffNode(container, node, diffResult, 0, onlyChanges);
            }
        }
    }

    /**
     * Рекурсивный рендер узла дерева с diff-аннотацией.
     */
    static _renderDiffNode(container, node, diffResult, depth, onlyChanges) {
        if (!node) return;

        const diffStatus = node._diff || 'unchanged';
        const type = node.type || 'item';

        // Определяем, есть ли изменения в содержимом этого узла или его атрибутах
        const hasContentChanges = this._nodeHasContentChanges(node, diffResult);
        const nodeAttrChanged = !!node._fieldChanges || !!node._moved;
        const effectiveStatus = diffStatus === 'unchanged' && (hasContentChanges || nodeAttrChanged)
            ? 'modified' : diffStatus;
        const isUnchanged = effectiveStatus === 'unchanged' && !hasContentChanges && !nodeAttrChanged;

        // Контейнер узла
        const nodeDiv = document.createElement('div');
        nodeDiv.className = `diff-node diff-${effectiveStatus}`;
        if (isUnchanged) nodeDiv.classList.add('diff-unchanged');

        // Заголовок пункта
        if (type === 'item' || !type) {
            const level = Math.min(depth + 1, 5);
            const heading = document.createElement(`h${level}`);
            heading.className = 'version-preview-heading';
            const number = node.number ? `${node.number}. ` : '';
            heading.textContent = `${number}${node.label || ''}`;
            if (effectiveStatus === 'added') heading.textContent += ' (ДОБАВЛЕНО)';
            if (effectiveStatus === 'removed') heading.textContent += ' (УДАЛЕНО)';
            this._appendNodeChangeBadges(heading, node);
            nodeDiv.appendChild(heading);
        }

        // Таблица
        if (type === 'table' && node.tableId) {
            const tableDiff = diffResult.tables[node.tableId];
            if (tableDiff) {
                const label = document.createElement('div');
                label.className = 'version-preview-label';
                label.textContent = node.customLabel || node.label || 'Таблица';
                this._appendNodeChangeBadges(label, node);
                nodeDiv.appendChild(label);

                if (tableDiff.status !== 'unchanged' || !onlyChanges) {
                    this._renderDiffTable(nodeDiv, tableDiff);
                }
            }
        }

        // Текстблок
        if (type === 'textblock' && node.textBlockId) {
            const tbDiff = diffResult.textblocks[node.textBlockId];
            if (tbDiff) {
                const label = document.createElement('div');
                label.className = 'version-preview-label';
                label.textContent = node.customLabel || node.label || 'Текстовый блок';
                this._appendNodeChangeBadges(label, node);
                nodeDiv.appendChild(label);

                if (tbDiff.status !== 'unchanged' || !onlyChanges) {
                    this._renderDiffTextBlock(nodeDiv, tbDiff);
                }
            }
        }

        // Нарушение
        if (type === 'violation' && node.violationId) {
            const violDiff = diffResult.violations[node.violationId];
            if (violDiff) {
                const label = document.createElement('div');
                label.className = 'version-preview-label';
                label.textContent = node.customLabel || node.label || 'Нарушение';
                this._appendNodeChangeBadges(label, node);
                nodeDiv.appendChild(label);

                if (violDiff.status !== 'unchanged' || !onlyChanges) {
                    this._renderDiffViolation(nodeDiv, violDiff);
                }
            }
        }

        // Фактура, привязанная к узлу по node.id (фактуры не отдельный тип узла —
        // крепятся к листовым узлам раздела 5). Каждый удалённый узел приходит
        // отдельной записью removedNodes с тем же node.id, поэтому фактуры
        // удалённых узлов тоже отрисуются здесь.
        const invDiff = diffResult.invoices?.[node.id];
        if (invDiff && (invDiff.status !== 'unchanged' || !onlyChanges)) {
            this._renderDiffInvoice(nodeDiv, invDiff);
        }

        container.appendChild(nodeDiv);

        // Рекурсия
        if (node.children) {
            for (const child of node.children) {
                this._renderDiffNode(container, child, diffResult, depth + 1, onlyChanges);
            }
        }
    }

    static _nodeHasContentChanges(node, diffResult) {
        if (node.tableId && diffResult.tables[node.tableId]?.status !== 'unchanged') return true;
        if (node.textBlockId && diffResult.textblocks[node.textBlockId]?.status !== 'unchanged') return true;
        if (node.violationId && diffResult.violations[node.violationId]?.status !== 'unchanged') return true;
        // Фактура привязана к узлу по node.id; её изменение делает узел changed —
        // иначе в режиме «только изменения» узел с diff-unchanged был бы скрыт
        // CSS'ом вместе с изменённой фактурой внутри.
        if (diffResult.invoices?.[node.id] && diffResult.invoices[node.id].status !== 'unchanged') return true;
        return false;
    }

    /**
     * Добавляет к заголовку/метке узла маркеры изменения его атрибутов
     * (number/label/customLabel/kind old→new) и бейдж «перемещён».
     * Для added/removed узлов атрибуты не детализируем — узел и так помечен
     * цветом целиком.
     */
    static _appendNodeChangeBadges(el, node) {
        const status = node._diff || 'unchanged';
        const changes = node._fieldChanges;
        if (changes && status !== 'added' && status !== 'removed') {
            const labels = { number: 'Номер', label: 'Название', customLabel: 'Метка', kind: 'Подвид', type: 'Тип' };
            for (const field of ['number', 'label', 'customLabel', 'kind', 'type']) {
                const ch = changes[field];
                if (!ch) continue;
                const span = document.createElement('span');
                span.className = 'diff-node-attr-change';
                const strong = document.createElement('strong');
                strong.textContent = `${labels[field] || field}: `;
                span.appendChild(strong);
                this.appendOldNewPair(span, ch.old, ch.new, { placeholder: '∅' });
                el.appendChild(span);
            }
        }
        if (node._moved) {
            const badge = document.createElement('span');
            badge.className = 'diff-node-moved-badge';
            // Направление есть только при перестановке среди сиблингов одного
            // родителя (_moveDirection, см. diff-engine._diffTree); при смене
            // родителя направление не определено — бейдж без стрелки.
            const arrow = node._moveDirection === 'up' ? ' ↑' : node._moveDirection === 'down' ? ' ↓' : '';
            badge.textContent = `перемещён${arrow}`;
            el.appendChild(badge);
        }
    }

    /**
     * Бейдж «Изменено форматирование» — общий для word-diff всех rich-полей
     * (текстблок, text-блок нарушения, подпись под картинкой). Показывается
     * при formattingOnly: видимый текст совпал, word-diff
     * без вставок/удалений выглядел бы «пустым» без явного сигнала.
     * @param {HTMLElement} parent - куда добавить бейдж
     * @param {string} [tag='span'] - тег элемента (текстблок использует div)
     */
    static _appendFormatBadge(parent, tag = 'span') {
        const badge = document.createElement(tag);
        badge.className = 'diff-textblock-format-badge';
        badge.textContent = 'Изменено форматирование';
        parent.appendChild(badge);
    }

    /**
     * Добавляет к parent пару «старое → новое»: <del>old</del> → <ins>new</ins>.
     * Единый сборщик для бейджей атрибутов узла, полей фактуры и атрибутов
     * картинки. Варианты — через opts:
     *  - opts.placeholder — заглушка для пустого значения (например '∅');
     *  - opts.conditionalOld — не выводить <del> и стрелку, если старое пусто.
     */
    static appendOldNewPair(parent, oldVal, newVal, opts = {}) {
        const { placeholder = '', conditionalOld = false } = opts;
        const oldText = oldVal == null ? '' : String(oldVal);
        const newText = newVal == null ? '' : String(newVal);
        if (!conditionalOld || oldText) {
            const del = document.createElement('del');
            del.textContent = oldText || placeholder;
            parent.appendChild(del);
            parent.appendChild(document.createTextNode(' → '));
        }
        const ins = document.createElement('ins');
        ins.textContent = newText || placeholder;
        parent.appendChild(ins);
    }

    /**
     * Рендер таблицы с подсветкой изменённых ячеек.
     */
    static _renderDiffTable(container, tableDiff) {
        const wrapper = document.createElement('div');
        wrapper.className = `diff-table-wrapper diff-${tableDiff.status}`;

        const data = tableDiff.newData || tableDiff.oldData;
        if (!data?.grid) return;

        // Сводка структурных изменений (ширины/размер сетки/объединения/заголовки).
        this._renderTableStructureSummary(wrapper, tableDiff.structure);

        // Строим set изменённых ячеек
        const changedCells = new Map();
        if (tableDiff.cellDiffs) {
            for (const cd of tableDiff.cellDiffs) {
                changedCells.set(`${cd.row}-${cd.col}`, cd);
            }
        }
        // Ячейки с изменёнными структурными атрибутами (объединение/заголовок).
        const attrCells = new Set();
        for (const ca of tableDiff.structure?.cellAttrs || []) {
            attrCells.add(`${ca.row}-${ca.col}`);
        }

        const table = document.createElement('table');
        table.className = 'preview-table';

        for (let r = 0; r < data.grid.length; r++) {
            const tr = document.createElement('tr');
            // Единый обход видимых (не поглощённых) ячеек строки — общий helper.
            iterateVisibleCells([data.grid[r]], (cell, _r, c) => {
                const isHeader = cell.isHeader;
                const td = document.createElement(isHeader ? 'th' : 'td');
                if (cell.colSpan > 1) td.colSpan = cell.colSpan;
                if (cell.rowSpan > 1) td.rowSpan = cell.rowSpan;

                const key = `${r}-${c}`;
                const change = changedCells.get(key);

                if (change) {
                    td.className = 'diff-cell-changed';
                    if (change.old) {
                        const oldSpan = document.createElement('span');
                        oldSpan.className = 'diff-cell-old';
                        oldSpan.textContent = change.old;
                        td.appendChild(oldSpan);
                    }
                    if (change.new) {
                        const newSpan = document.createElement('span');
                        newSpan.className = 'diff-cell-new';
                        newSpan.textContent = change.new;
                        td.appendChild(newSpan);
                    }
                    if (!change.old && !change.new) {
                        td.textContent = '—';
                    }
                } else {
                    td.textContent = cell.content || '';
                }
                // Подсветка ячейки с изменёнными объединением/заголовком.
                if (attrCells.has(key)) td.classList.add('diff-cell-attr-changed');

                tr.appendChild(td);
            });
            table.appendChild(tr);
        }

        wrapper.appendChild(table);
        container.appendChild(wrapper);
    }

    /**
     * Сводка структурных изменений таблицы (флаги, не попиксельное выравнивание):
     * ширины колонок, размер сетки, объединения/заголовки ячеек.
     */
    static _renderTableStructureSummary(container, structure) {
        if (!structure?.changed) return;
        const notes = [];
        if (structure.gridResized) {
            const g = structure.gridResized;
            notes.push(`Размер сетки: ${g.oldRows}×${g.oldCols} → ${g.newRows}×${g.newCols}`);
        }
        if (structure.colWidths) notes.push('Ширины колонок изменены');
        if (structure.cellAttrs?.length) {
            notes.push(`Объединения/заголовки ячеек изменены: ${structure.cellAttrs.length}`);
        }
        if (!notes.length) return;

        const box = document.createElement('div');
        box.className = 'diff-table-structure';
        for (const text of notes) {
            const line = document.createElement('div');
            line.className = 'diff-table-structure-note';
            line.textContent = text;
            box.appendChild(line);
        }
        container.appendChild(box);
    }

    /**
     * Рендер текстблока с word-level diff.
     */
    static _renderDiffTextBlock(container, tbDiff) {
        const div = document.createElement('div');
        div.className = `diff-textblock diff-${tbDiff.status}`;

        if (tbDiff.status === 'added') {
            renderActContent(div, tbDiff.newContent || '');
        } else if (tbDiff.status === 'removed') {
            renderActContent(div, tbDiff.oldContent || '');
        } else if (tbDiff.status === 'modified' && tbDiff.wordDiff) {
            // Правка только форматирования (видимый текст тот же) — word-diff пуст,
            // поэтому показываем бейдж, иначе изменение выглядело бы «пустым».
            // Бейдж уходит в container ДО текстблока, чтобы не тронуть innerHTML
            // корневого div (на нём держится подсветка <ins>/<del>).
            if (tbDiff.formattingOnly) {
                this._appendFormatBadge(container, 'div');
            }
            div.className += ' diff-text';
            // Профиль по умолчанию (НЕ 'acts'): здесь рендерится diff-разметка
            // <ins>/<del> поверх уже pre-stripped plain text (_stripHtml в
            // diff-engine.js), а не исходный HTML текстблока. <ins> вне
            // acts-allowlist (ACTS_TAGS_FALLBACK в sanitize.js) — переключение
            // на renderActContent срезало бы всю подсветку вставок.
            // _escapeHtml уже экранирует payload, но обёртки <ins>/<del> должны
            // проходить через DOMPurify — иначе вектор «текст содержит </ins><script>»
            // мог бы сломать конструкцию. SafeHTML.set sanitize всю итоговую строку.
            const html = tbDiff.wordDiff.map(part => {
                const escaped = this._escapeHtml(part.text);
                if (part.type === 'insert') return `<ins>${escaped}</ins>`;
                if (part.type === 'delete') return `<del>${escaped}</del>`;
                return escaped;
            }).join(' ');
            SafeHTML.set(div, html);
        } else {
            renderActContent(div, tbDiff.content || tbDiff.newContent || '');
        }

        container.appendChild(div);
    }

    /**
     * Рендер диффа нарушения (блочная модель): секции изменившихся полей в
     * порядке отображения новой версии, внутри каждой — изменения блоков.
     * Читается ТОЛЬКО структура диффа: движок уже канонизировал выключенные
     * поля и развернул порядок, разбирать сырые oldData/newData здесь нечего.
     */
    static _renderDiffViolation(container, violDiff) {
        const div = document.createElement('div');
        div.className = `diff-violation diff-${violDiff.status}`;

        // Целиком добавленное/удалённое нарушение помечено цветом полностью —
        // служебные изменения (порядок полей, включение поля) в этом случае не
        // детализируем (зеркало _appendNodeChangeBadges для узлов дерева).
        const detailed = violDiff.status !== 'added' && violDiff.status !== 'removed';

        if (detailed && violDiff.fieldOrder) {
            this._appendFieldOrderChange(div, violDiff.fieldOrder);
        }

        if (violDiff.status === 'unchanged') {
            // diff-engine не кладёт неизменившиеся поля в violDiff.fields (см.
            // DiffEngine._diffViolations) — при status='unchanged' fields пуст.
            // Эта ветка достижима, только когда onlyChanges=false (см. условие
            // вызова в _renderDiffNode), поэтому строим содержимое напрямую из
            // данных нарушения — паритет с неизменёнными текстблоками/таблицами
            // (:381), которые в этом режиме тоже показывают содержимое целиком.
            this._renderUnchangedViolationContent(div, violDiff.newData || violDiff.oldData);
        } else {
            // Ключи уже в порядке отображения — движок вставляет их в `fields`
            // через getOrderedFieldKeys (см. DiffEngine._diffViolations).
            for (const [key, fieldDiff] of Object.entries(violDiff.fields || {})) {
                this._renderViolationField(div, key, fieldDiff, detailed);
            }
        }

        container.appendChild(div);
    }

    /**
     * Полное содержимое неизменённого нарушения: поля в порядке fieldOrder||
     * стандартном, только включённые и непустые. Блоки рендерятся тем же
     * путём, что неизменённые блоки внутри частично изменённого поля
     * (_renderBlockEntry со status='unchanged') — переиспользуем диспетчер по
     * типу блока вместо повторной реализации text/image/table-рендера.
     * Метка поля — навигационная подпись дифа, а не экспортный вывод: в
     * отличие от labeled=false у codeMining/processMining/additionalContent
     * в DOCX/MD/TXT (см. violation-fields.js), здесь метка нужна ВСЕМ полям.
     * Без класса diff-field-changed — амбер-подсветка означала бы «изменено»,
     * а нарушение целиком не изменилось.
     */
    static _renderUnchangedViolationContent(container, violation) {
        if (!violation) return;
        for (const key of getOrderedFieldKeys(violation)) {
            const field = violation[key];
            if (!field || !field.enabled) continue;
            const blocks = Array.isArray(field.blocks) ? field.blocks : [];
            if (!blocks.length) continue;

            const fieldDiv = document.createElement('div');
            fieldDiv.className = 'diff-violation-field';
            const labelEl = document.createElement('strong');
            labelEl.textContent = `${VIOLATION_LABELS[key] || key}: `;
            fieldDiv.appendChild(labelEl);

            for (const block of blocks) {
                this._renderBlockEntry(fieldDiv, {
                    status: 'unchanged', reordered: false,
                    type: block.type, oldBlock: block, newBlock: block,
                });
            }
            container.appendChild(fieldDiv);
        }
    }

    /** Строка «Порядок полей изменён: <старые метки> → <новые метки>». */
    static _appendFieldOrderChange(container, fieldOrder) {
        const line = document.createElement('div');
        line.className = 'diff-violation-field diff-field-changed';
        const strong = document.createElement('strong');
        strong.textContent = 'Порядок полей изменён: ';
        line.appendChild(strong);
        this.appendOldNewPair(line, this._fieldOrderText(fieldOrder.old), this._fieldOrderText(fieldOrder.new));
        container.appendChild(line);
    }

    /** Порядок полей человеческими метками через запятую. */
    static _fieldOrderText(keys) {
        return (keys || []).map(key => VIOLATION_LABELS[key] || key).join(', ');
    }

    /**
     * Секция одного изменившегося поля: метка из реестра, бейджи
     * включения/перестановки блоков, затем изменения блоков.
     * @param {boolean} detailed - детализировать служебные изменения (см. _renderDiffViolation)
     */
    static _renderViolationField(container, key, fieldDiff, detailed) {
        const showEnabled = detailed && !!fieldDiff.enabled;
        const entries = fieldDiff.blocks?.entries || [];
        if (!showEnabled && !entries.length) return;

        const fieldDiv = document.createElement('div');
        fieldDiv.className = 'diff-violation-field diff-field-changed';

        const labelEl = document.createElement('strong');
        labelEl.textContent = `${VIOLATION_LABELS[key] || key}: `;
        fieldDiv.appendChild(labelEl);

        if (showEnabled) {
            const badge = document.createElement('span');
            badge.className = 'diff-node-attr-change';
            badge.textContent = fieldDiff.enabled.new ? 'Поле включено' : 'Поле выключено';
            fieldDiv.appendChild(badge);
        }
        if (detailed && fieldDiff.blocks?.reordered) {
            const badge = document.createElement('span');
            badge.className = 'diff-node-moved-badge';
            badge.textContent = 'порядок блоков изменён';
            fieldDiv.appendChild(badge);
        }

        for (const entry of entries) {
            this._renderBlockEntry(fieldDiv, entry);
        }
        container.appendChild(fieldDiv);
    }

    /**
     * Рендер диффа фактуры узла: реквизиты списком, изменённые — old→new
     * (del/ins). Элементы строятся напрямую (textContent), без SafeHTML — как
     * поля нарушения; значения фактур plain-text (без HTML). added/removed —
     * весь блок помечен цветом через diff-<status>.
     */
    static _renderDiffInvoice(container, invDiff) {
        const div = document.createElement('div');
        div.className = `diff-invoice diff-${invDiff.status}`;

        const label = document.createElement('div');
        label.className = 'diff-invoice-label';
        let marker = '';
        if (invDiff.status === 'added') marker = ' (ДОБАВЛЕНО)';
        else if (invDiff.status === 'removed') marker = ' (УДАЛЕНО)';
        label.textContent = `Фактура${marker}`;
        div.appendChild(label);

        const data = invDiff.newData || invDiff.oldData;
        if (data) {
            for (const field of Object.keys(INVOICE_FIELD_LABELS)) {
                const changed = invDiff.fieldDiffs?.[field];
                const text = this._invoiceFieldText(data, field);
                if (!text && !changed) continue;

                const fieldDiv = document.createElement('div');
                fieldDiv.className = 'diff-invoice-field diff-violation-field';
                const strong = document.createElement('strong');
                strong.textContent = `${INVOICE_FIELD_LABELS[field]}: `;
                fieldDiv.appendChild(strong);

                const oldText = changed ? this._invoiceFieldText(invDiff.oldData, field) : '';
                const newText = changed ? this._invoiceFieldText(invDiff.newData, field) : '';
                // Фантом: движок пометил поле изменённым по служебному атрибуту,
                // а видимый текст (коды) не изменился → показываем как обычное
                // значение, без del/ins-бейджа.
                if (changed && oldText !== newText) {
                    fieldDiv.classList.add('diff-field-changed');
                    this.appendOldNewPair(fieldDiv, oldText, newText, {
                        placeholder: '∅', conditionalOld: true,
                    });
                } else {
                    fieldDiv.appendChild(document.createTextNode(text));
                }
                div.appendChild(fieldDiv);
            }
        }

        container.appendChild(div);
    }

    /**
     * Читаемое значение реквизита фактуры. metrics/process — массивы объектов,
     * сворачиваем в коды через запятую; прочее — как есть.
     */
    static _invoiceFieldText(inv, field) {
        if (!inv) return '';
        const val = inv[field];
        if (val === null || val === undefined) return '';
        if (field === 'metrics' && Array.isArray(val)) {
            return val.map(m => (m && (m.metric_code || m.code || m.metric_name)) || '')
                .filter(Boolean).join(', ');
        }
        if (field === 'process' && Array.isArray(val)) {
            return val.map(m => (m && (m.process_code || m.process_name)) || '')
                .filter(Boolean).join(', ');
        }
        if (typeof val === 'object') return JSON.stringify(val);
        return String(val);
    }

    /**
     * Строка diff-разметки из word-diff (ДЕФОЛТНЫЙ профиль SafeHTML.set):
     * _escapeHtml + обёртки <ins>/<del>, как в word-diff-ветке текстблока.
     * Профиль acts срезал бы <ins>/<del> (вне acts-allowlist) — см. тех-долг
     * diff-renderer-textblock-profile.test.mjs.
     */
    static _wordDiffToHtml(wordDiff) {
        return (wordDiff || []).map((part) => {
            const escaped = this._escapeHtml(part.text);
            if (part.type === 'insert') return `<ins>${escaped}</ins>`;
            if (part.type === 'delete') return `<del>${escaped}</del>`;
            return escaped;
        }).join(' ');
    }

    /**
     * Рендер изменения одного блока поля. Общая рамка (метка типа + маркер
     * added/removed/порядка) и диспетчер по типу блока.
     */
    static _renderBlockEntry(container, entry) {
        const itemDiv = document.createElement('div');
        itemDiv.className = `diff-violation-item diff-${entry.status}`;
        this._appendBlockHeader(itemDiv, BLOCK_TYPE_LABELS[entry.type] || BLOCK_TYPE_LABELS[BLOCK_TYPES.TEXT], entry);

        if (entry.type === BLOCK_TYPES.IMAGE) {
            this._renderImageEntry(itemDiv, entry);
        } else if (entry.type === BLOCK_TYPES.TABLE) {
            this._renderTableBlockEntry(itemDiv, entry);
        } else {
            this._renderTextBlockEntry(itemDiv, entry);
        }
        container.appendChild(itemDiv);
    }

    /** Метка блока + маркер добавления/удаления/перестановки. */
    static _appendBlockHeader(itemDiv, baseLabel, entry) {
        let marker = '';
        if (entry.status === 'added') marker = ' (ДОБАВЛЕНО)';
        else if (entry.status === 'removed') marker = ' (УДАЛЕНО)';
        else if (entry.reordered) marker = ' (порядок изменён)';
        if (!baseLabel && !marker) return;
        const el = document.createElement('strong');
        el.className = 'diff-violation-item-label';
        el.textContent = baseLabel ? `${baseLabel}${marker}: ` : `${marker.trim()} `;
        itemDiv.appendChild(el);
    }

    /**
     * Text-блок: added/removed/unchanged показывают ВИДИМЫЙ текст (_stripHtml)
     * — контент rich-HTML, сырой показал бы теги буквально. modified —
     * word-diff-разметка + бейдж «Изменено форматирование» при formattingOnly
     * (бейдж — сосед body ДО неё: SafeHTML.set заменяет innerHTML и стёр бы
     * его, будь он внутри). oversized — крупный блок мимо пословного сравнения
     * (перф-гвард движка), показываем только факт изменения.
     */
    static _renderTextBlockEntry(itemDiv, entry) {
        const body = document.createElement('div');
        body.className = 'diff-violation-item-body';

        if (entry.status === 'added') {
            const ins = document.createElement('ins');
            ins.textContent = DiffEngine._stripHtml(entry.newBlock?.content || '');
            body.appendChild(ins);
        } else if (entry.status === 'removed') {
            const del = document.createElement('del');
            del.textContent = DiffEngine._stripHtml(entry.oldBlock?.content || '');
            body.appendChild(del);
        } else if (entry.status === 'modified' && entry.oversized) {
            body.textContent = 'Текст изменён (крупный блок — пословное сравнение не выполнялось)';
        } else if (entry.status === 'modified' && entry.wordDiff) {
            if (entry.formattingOnly) {
                this._appendFormatBadge(itemDiv);
            }
            SafeHTML.set(body, this._wordDiffToHtml(entry.wordDiff));
        } else {
            body.textContent = DiffEngine._stripHtml((entry.newBlock || entry.oldBlock)?.content || '');
        }
        itemDiv.appendChild(body);
    }

    /**
     * Table-блок — компактная текстовая сводка, а не отрисовка сетки: движок
     * сравнивает ячейки плоско (без LCS), показывать целую таблицу в дифе
     * нарушения избыточно. Значения ячеек обрезаются до MAX_INLINE_TEXT.
     */
    static _renderTableBlockEntry(itemDiv, entry) {
        const body = document.createElement('div');
        body.className = 'diff-violation-item-body';
        const cells = entry.cells || [];

        if (entry.gridResized) {
            const g = entry.gridResized;
            this._appendSummaryLine(
                body,
                `${BLOCK_ATTR_LABELS.gridResized}: ${g.oldRows}×${g.oldCols} → ${g.newRows}×${g.newCols}`,
            );
        } else if (!cells.length) {
            // Добавленный/удалённый/неизменившийся блок — только размер сетки.
            const grid = ((entry.newBlock || entry.oldBlock) || {}).table?.grid || [];
            const cols = grid.length ? Math.max(...grid.map(r => (r ? r.length : 0))) : 0;
            this._appendSummaryLine(body, `Сетка: ${grid.length}×${cols}`);
        }

        if (cells.length) {
            this._appendSummaryLine(body, `${BLOCK_ATTR_LABELS.cells}: ${cells.length}`);
            for (const cell of cells) {
                const line = document.createElement('div');
                line.className = 'diff-violation-field diff-field-changed';
                const strong = document.createElement('strong');
                // Индексы человеческие (с единицы) — движок хранит их с нуля.
                strong.textContent = `Строка ${cell.row + 1}, колонка ${cell.col + 1}: `;
                line.appendChild(strong);
                this.appendOldNewPair(line, this._truncate(cell.old), this._truncate(cell.new), { placeholder: '∅' });
                body.appendChild(line);
            }
        }
        itemDiv.appendChild(body);
    }

    /** Строка-сводка внутри тела блока (размер сетки, число изменённых ячеек). */
    static _appendSummaryLine(container, text) {
        const line = document.createElement('div');
        line.className = 'diff-violation-sublabel';
        line.textContent = text;
        container.appendChild(line);
    }

    /** Обрезка длинного значения для текстовой сводки. */
    static _truncate(value, max = MAX_INLINE_TEXT) {
        const text = value == null ? '' : String(value);
        return text.length > max ? `${text.slice(0, max)}…` : text;
    }

    /** Image-блок: превью старой/новой картинки + текст изменённых атрибутов. */
    static _renderImageEntry(itemDiv, entry) {
        if (entry.status === 'added') {
            this._appendImagePreview(itemDiv, entry.newBlock);
            return;
        }
        if (entry.status === 'removed') {
            this._appendImagePreview(itemDiv, entry.oldBlock);
            return;
        }

        const fields = entry.fields || {};
        if (fields.url) {
            // url — многомегабайтный data-URL: показываем факт смены двумя
            // превью, а не текстом «было → стало».
            this._appendSublabel(itemDiv, 'Было:');
            this._appendImagePreview(itemDiv, entry.oldBlock);
            this._appendSublabel(itemDiv, 'Стало:');
            this._appendImagePreview(itemDiv, entry.newBlock);
        } else {
            this._appendImagePreview(itemDiv, entry.newBlock || entry.oldBlock);
        }

        for (const key of ['caption', 'filename', 'width']) {
            if (!fields[key]) continue;
            const line = document.createElement('div');
            line.className = 'diff-violation-field diff-field-changed';
            const strong = document.createElement('strong');
            strong.textContent = `${BLOCK_ATTR_LABELS[key]}: `;
            line.appendChild(strong);
            if (key === 'caption' && fields[key].wordDiff) {
                // Подпись — rich-поле: word-diff по видимому тексту вместо
                // сырых HTML-строк (appendOldNewPair показал бы <b> буквально).
                if (fields[key].formattingOnly) {
                    this._appendFormatBadge(line);
                }
                const wordDiffEl = document.createElement('span');
                SafeHTML.set(wordDiffEl, this._wordDiffToHtml(fields[key].wordDiff));
                line.appendChild(wordDiffEl);
            } else {
                this.appendOldNewPair(line, this._truncate(fields[key].old), this._truncate(fields[key].new));
            }
            itemDiv.appendChild(line);
        }
    }

    static _appendSublabel(container, text) {
        const el = document.createElement('div');
        el.className = 'diff-violation-sublabel';
        el.textContent = text;
        container.appendChild(el);
    }

    /**
     * Превью картинки нарушения с fallback на текстовый плейсхолдер (общее ядро
     * с превью/редактором — violation-image-render.js). Пустой url → плейсхолдер.
     */
    static _appendImagePreview(container, block) {
        const wrap = document.createElement('div');
        wrap.className = 'diff-violation-image';
        const placeholderText = `Изображение: ${(block && block.filename) || ''}`;
        const placeholderClassName = 'diff-violation-image-placeholder';
        if (!block || !block.url) {
            wrap.appendChild(buildImagePlaceholder(placeholderText, placeholderClassName));
        } else {
            renderImageWithFallback(wrap, {
                src: block.url,
                alt: block.caption || block.filename || '',
                imgClassName: 'diff-violation-image-img',
                placeholderText,
                placeholderClassName,
            });
        }
        container.appendChild(wrap);
        if (block && block.caption) {
            const cap = document.createElement('div');
            cap.className = 'diff-violation-caption';
            // Подпись — rich-поле: показываем ВИДИМЫЙ текст (_stripHtml), не
            // сырой HTML буквально (паритет с text-блоком, _renderTextBlockEntry).
            cap.textContent = DiffEngine._stripHtml(block.caption);
            container.appendChild(cap);
        }
    }

    static _escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}

window.DiffRenderer = DiffRenderer;
