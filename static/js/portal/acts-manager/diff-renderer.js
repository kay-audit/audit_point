/**
 * DOM-рендеринг diff с цветовой подсветкой.
 * Работает на основе результатов DiffEngine.compute().
 */
import { SafeHTML, renderActContent } from '../../shared/sanitize.js';
import { iterateVisibleCells } from '../../constructor/table/grid-merges.js';
import { VIOLATION_LABELS, CASE_LABEL_TEMPLATE, FREE_TEXT_LABEL } from '../../constructor/violation/violation-fields.js';
import { DiffEngine } from './diff-engine.js';
import { INVOICE_FIELD_LABELS } from './invoice-diff-fields.js';
import { computeAdditionalContentNumbers } from '../../constructor/violation/violation-numbering.js';
import { CONTENT_TYPE_CASE, CONTENT_TYPE_IMAGE } from '../../constructor/violation/violation-content-item.js';
import { renderImageWithFallback, buildImagePlaceholder } from '../../constructor/violation/violation-image-render.js';

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
            badge.textContent = 'перемещён';
            el.appendChild(badge);
        }
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
                const badge = document.createElement('div');
                badge.className = 'diff-textblock-format-badge';
                badge.textContent = 'Изменено форматирование';
                container.appendChild(badge);
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
     * Рендер нарушения с подсветкой изменённых полей. Изменённое rich-поле —
     * word-diff-разметка по видимому тексту (зеркало _renderDiffTextBlock),
     * бейдж «Изменено форматирование» при formattingOnly.
     */
    static _renderDiffViolation(container, violDiff) {
        const div = document.createElement('div');
        div.className = `diff-violation diff-${violDiff.status}`;

        const data = violDiff.newData || violDiff.oldData;
        if (!data) return;

        const fields = ['violated', 'established', 'reasons', 'measures', 'consequences', 'responsible'];

        for (const field of fields) {
            const val = this._getViolFieldValue(data, field);
            if (!val && !violDiff.fieldDiffs?.[field]) continue;

            const fieldDiv = document.createElement('div');
            fieldDiv.className = 'diff-violation-field';

            const labelEl = document.createElement('strong');
            labelEl.textContent = `${VIOLATION_LABELS[field] || field}: `;
            fieldDiv.appendChild(labelEl);

            const fieldDiff = violDiff.fieldDiffs?.[field];
            if (fieldDiff?.changed) {
                fieldDiv.classList.add('diff-field-changed');
                // Правка только форматирования (видимый текст совпал) —
                // бейдж, иначе word-diff без вставок/удалений выглядел бы
                // «пустым» (зеркало _renderDiffTextBlock).
                if (fieldDiff.formattingOnly) {
                    const badge = document.createElement('span');
                    badge.className = 'diff-textblock-format-badge';
                    badge.textContent = 'Изменено форматирование';
                    fieldDiv.appendChild(badge);
                }
                const wordDiffEl = document.createElement('span');
                SafeHTML.set(wordDiffEl, this._wordDiffToHtml(fieldDiff.wordDiff));
                fieldDiv.appendChild(wordDiffEl);
            } else {
                fieldDiv.appendChild(document.createTextNode(val));
            }

            div.appendChild(fieldDiv);
        }

        // Список описаний (descriptionList) — структурный под-дифф движка.
        const dlDiff = violDiff.fieldDiffs?.descriptionList;
        if (dlDiff?.changed) {
            this._renderDescriptionListDiff(div, dlDiff);
        }

        // Доп.контент (additionalContent) — структурный под-дифф движка.
        const acDiff = violDiff.fieldDiffs?.additionalContent;
        if (acDiff?.changed) {
            this._renderAdditionalContentDiff(
                div, acDiff,
                violDiff.oldData?.additionalContent?.items || [],
                violDiff.newData?.additionalContent?.items || [],
            );
        }

        container.appendChild(div);
    }

    static _getViolFieldValue(viol, field) {
        const val = viol[field];
        if (!val) return '';
        if (typeof val === 'string') return val;
        if (typeof val === 'object' && 'content' in val) {
            // Мируем движок: выключенное опц.поле не показываем (пропало из акта).
            if ('enabled' in val && !val.enabled) return '';
            return val.content || '';
        }
        return '';
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
     * Рендер диффа списка описаний: <ul> с пер-элементной подсветкой
     * added/removed/modified. Заголовка нет (паритет с collectViolationLines —
     * descriptionList без метки, решение #12).
     */
    static _renderDescriptionListDiff(container, dlDiff) {
        const ul = document.createElement('ul');
        ul.className = 'diff-desclist';
        for (const item of dlDiff.items || []) {
            const li = document.createElement('li');
            li.className = `diff-desclist-item diff-${item.status}`;
            if (item.status === 'added') {
                const ins = document.createElement('ins');
                ins.textContent = item.new || '';
                li.appendChild(ins);
            } else if (item.status === 'removed') {
                const del = document.createElement('del');
                del.textContent = item.old || '';
                li.appendChild(del);
            } else if (item.status === 'modified') {
                SafeHTML.set(li, this._wordDiffToHtml(item.wordDiff));
            } else {
                li.textContent = item.new ?? item.old ?? '';
            }
            ul.appendChild(li);
        }
        container.appendChild(ul);
    }

    /**
     * Рендер диффа доп.контента. Метки/нумерация — зеркало collectViolationLines:
     * «Кейс N» через computeAdditionalContentNumbers, свободный текст без метки,
     * картинки — превью с подписью. Номер кейса берётся из новой версии (для
     * удалённых — из старой).
     */
    static _renderAdditionalContentDiff(container, acDiff, oldItems, newItems) {
        const newNums = computeAdditionalContentNumbers(newItems);
        const oldNums = computeAdditionalContentNumbers(oldItems);
        const newNumById = new Map();
        newItems.forEach((it, i) => { if (it && it.id != null) newNumById.set(it.id, newNums[i]?.number); });
        const oldNumById = new Map();
        oldItems.forEach((it, i) => { if (it && it.id != null) oldNumById.set(it.id, oldNums[i]?.number); });

        for (const entry of acDiff.entries || []) {
            const caseNumber = entry.newItem
                ? newNumById.get(entry.newItem.id)
                : oldNumById.get(entry.oldItem?.id);
            this._renderContentEntry(container, entry, caseNumber);
        }
    }

    /**
     * Рендер одного элемента доп.контента (кейс / свободный текст / картинка).
     * unchanged/added/removed показывают ВИДИМЫЙ текст (_stripHtml) — контент
     * планируется rich-HTML, raw-текст показал бы теги буквально.
     */
    static _renderContentEntry(container, entry, caseNumber) {
        const item = entry.newItem || entry.oldItem;
        if (!item) return;

        const itemDiv = document.createElement('div');
        itemDiv.className = `diff-violation-item diff-${entry.status}`;

        if (item.type === CONTENT_TYPE_IMAGE) {
            this._appendContentHeader(itemDiv, '', entry);
            this._renderImageEntry(itemDiv, entry);
            container.appendChild(itemDiv);
            return;
        }

        const baseLabel = item.type === CONTENT_TYPE_CASE
            ? CASE_LABEL_TEMPLATE.replace('{n}', caseNumber != null ? caseNumber : '')
            : FREE_TEXT_LABEL;
        this._appendContentHeader(itemDiv, baseLabel, entry);

        const body = document.createElement('div');
        body.className = 'diff-violation-item-body';
        if (entry.status === 'added') {
            const ins = document.createElement('ins');
            ins.textContent = DiffEngine._stripHtml(entry.newItem?.content || '');
            body.appendChild(ins);
        } else if (entry.status === 'removed') {
            const del = document.createElement('del');
            del.textContent = DiffEngine._stripHtml(entry.oldItem?.content || '');
            body.appendChild(del);
        } else if (entry.status === 'modified' && entry.wordDiff) {
            SafeHTML.set(body, this._wordDiffToHtml(entry.wordDiff));
        } else {
            body.textContent = DiffEngine._stripHtml((entry.newItem || entry.oldItem)?.content || '');
        }
        itemDiv.appendChild(body);
        container.appendChild(itemDiv);
    }

    /** Метка элемента доп.контента + маркер добавления/удаления/перестановки. */
    static _appendContentHeader(itemDiv, baseLabel, entry) {
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

    /** Рендер картинки-элемента: превью старой/новой + текст изменённых атрибутов. */
    static _renderImageEntry(itemDiv, entry) {
        if (entry.status === 'added') {
            this._appendImagePreview(itemDiv, entry.newItem);
            return;
        }
        if (entry.status === 'removed') {
            this._appendImagePreview(itemDiv, entry.oldItem);
            return;
        }

        const fields = entry.fields || {};
        if (fields.url) {
            this._appendSublabel(itemDiv, 'Было:');
            this._appendImagePreview(itemDiv, entry.oldItem);
            this._appendSublabel(itemDiv, 'Стало:');
            this._appendImagePreview(itemDiv, entry.newItem);
        } else {
            this._appendImagePreview(itemDiv, entry.newItem || entry.oldItem);
        }

        const attrLabels = { caption: 'Подпись', filename: 'Файл', width: 'Ширина' };
        for (const key of ['caption', 'filename', 'width']) {
            if (!fields[key]) continue;
            const line = document.createElement('div');
            line.className = 'diff-violation-field diff-field-changed';
            const strong = document.createElement('strong');
            strong.textContent = `${attrLabels[key]}: `;
            line.appendChild(strong);
            this.appendOldNewPair(line, fields[key].old, fields[key].new);
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
    static _appendImagePreview(container, item) {
        const wrap = document.createElement('div');
        wrap.className = 'diff-violation-image';
        const placeholderText = `Изображение: ${(item && item.filename) || ''}`;
        const placeholderClassName = 'diff-violation-image-placeholder';
        if (!item || !item.url) {
            wrap.appendChild(buildImagePlaceholder(placeholderText, placeholderClassName));
        } else {
            renderImageWithFallback(wrap, {
                src: item.url,
                alt: item.caption || item.filename || '',
                imgClassName: 'diff-violation-image-img',
                placeholderText,
                placeholderClassName,
            });
        }
        container.appendChild(wrap);
        if (item && item.caption) {
            const cap = document.createElement('div');
            cap.className = 'diff-violation-caption';
            cap.textContent = item.caption;
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
