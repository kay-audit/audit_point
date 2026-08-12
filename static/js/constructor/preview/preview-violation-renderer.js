/**
 * Рендерер нарушений для предпросмотра — блочная модель.
 *
 * Паритет ПОЛНОТЫ данных с DOCX (build_violation): поля в порядке fieldOrder
 * нарушения (или стандартном), у видимого поля метка + блоки по порядку.
 * Первый text-блок инлайнится с меткой («Метка: текст», как в DOCX);
 * mandatory-поля (Нарушено/Установлено) выводят метку даже при пустом
 * контейнере (Q1/#14); поля с labeled=false (CodeMining/ProcessMining/
 * Дополнительный контент) метку не выводят вовсе — контент идёт подряд, как
 * у текстблоков. Политика — РУЧНОЕ зеркало Python-предикатов
 * should_render_field / field_label_for_render (violation_fields.py): фронт не
 * импортирует Python, синхронизация конвенцией проекта.
 * ВСЕ подписи полей — из контракта violation-fields.js
 * (VIOLATION_LABELS, №10): ни одного захардкоженного литерала метки.
 * Блок-таблица — через общий PreviewTableRenderer (та же графика, что у
 * таблиц-узлов); картинка — реальный <img> с подписью (H4/M.3/M.5).
 */
import { renderActContent } from '../../shared/sanitize.js';
import { getImageLimits } from '../violation/violation-image-validator.js';
import { BLOCK_TYPES } from '../violation/violation-block-types.js';
import {
    FIELD_BY_KEY,
    VIOLATION_LABELS,
    getOrderedFieldKeys,
} from '../violation/violation-fields.js';
import { buildImagePlaceholder, renderImageWithFallback } from '../violation/violation-image-render.js';
import { PreviewTableRenderer } from './preview-table-renderer.js';

/** Высота листа A4 в мм (Б-1.6). */
const SHEET_HEIGHT_MM = 297;
/**
 * Поля листа сверху/снизу в мм — как в preview-page.css (.preview-sheet
 * padding: 10mm ...) и в DOCX (styles.Margins.top/bottom = 567 твипов ≈ 10мм).
 */
const PAGE_MARGIN_VERTICAL_MM = 10;
/**
 * Полезная высота листа (без полей) — база для image_max_height_percent (#13).
 * Паритет с DOCX _USABLE_HEIGHT_TWIPS (docx/builders/violation.py): тот же
 * процент должен давать ту же физическую высоту картинки в превью и в Word.
 */
const USABLE_HEIGHT_MM = SHEET_HEIGHT_MM - 2 * PAGE_MARGIN_VERTICAL_MM;

/**
 * Чистая модель строк нарушения — полные тексты, как в DOCX.
 *
 * Флаг `small` помечает поля, которые в Word рендерятся 9pt-курсивом
 * (small в реестре: Нарушено/Установлено); остальные — обычный текст листа
 * (12pt, без курсива).
 *
 * @param {Object} violation - Данные нарушения
 * @returns {Array<Object>} Строки: {type:'line', label, text, small} |
 *          {type:'image', item, small} | {type:'table', table, small}
 */
export function collectViolationLines(violation) {
    const lines = [];

    for (const key of getOrderedFieldKeys(violation)) {
        const field = FIELD_BY_KEY[key];
        const container = violation?.[key] || {};
        const blocks = Array.isArray(container.blocks) ? [...container.blocks] : [];

        if (!field.mandatory && (!container.enabled || blocks.length === 0)) {
            continue;
        }

        // Поле без метки (labeled=false) — только контент, блоки подряд;
        // строка-носитель метки не создаётся вовсе.
        if (field.labeled) {
            const label = VIOLATION_LABELS[key];
            // Первый text-блок инлайнится с меткой (паритет с DOCX); иначе метка
            // отдельной строкой, блоки следом.
            if (blocks.length && blocks[0].type === BLOCK_TYPES.TEXT) {
                const first = blocks.shift();
                lines.push({ type: 'line', label, text: first.content || '', small: field.small });
            } else {
                lines.push({ type: 'line', label, text: '', small: field.small });
            }
        }

        for (const block of blocks) {
            if (!block) continue;
            if (block.type === BLOCK_TYPES.TEXT) {
                lines.push({ type: 'line', label: '', text: block.content || '', small: field.small });
            } else if (block.type === BLOCK_TYPES.IMAGE) {
                lines.push({ type: 'image', item: block, small: field.small });
            } else if (block.type === BLOCK_TYPES.TABLE) {
                lines.push({ type: 'table', table: block.table || { grid: [], colWidths: [] }, small: field.small });
            }
        }
    }

    return lines;
}

// text-align верхнеуровневого <div>/<p> — зеркало _TEXT_ALIGN_RE
// (app/domains/acts/formatters/docx/builders/inline.py): нераспознанные
// значения (start/end/-webkit-*) сознательно игнорируются, align = null.
const TEXT_ALIGN_RE = /text-align\s*:\s*(left|center|right|justify)\b/i;
// Значение атрибута style (обе кавычки) — скоуп поиска align ОГРАНИЧЕН им же,
// зеркало бэкового _extract_text_align (ищет только в attrs['style'], не по
// всему тегу): иначе `class="text-align:center"` (class — разрешённый атрибут
// без ограничений на содержимое) подделал бы align, которого нет в DOCX
// (ревью F2/Minor).
const STYLE_ATTR_RE = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/**
 * text-align атрибута style открывающего тега сегмента (F2/Пункт 1) — паритет
 * с DOCX BlockSegment.alignment: без него превью теряло пользовательское
 * выравнивание строки, которое DOCX (render_block_segments) сохраняет.
 * Скоуп поиска — ТОЛЬКО значение style, не весь текст тега (см. STYLE_ATTR_RE).
 * @param {string} openTagText - Сырой текст открывающего тега (с атрибутами)
 * @returns {string|null}
 */
function extractTextAlign(openTagText) {
    const styleMatch = STYLE_ATTR_RE.exec(openTagText);
    if (!styleMatch) return null;
    const styleValue = styleMatch[1] ?? styleMatch[2] ?? '';
    const alignMatch = TEXT_ALIGN_RE.exec(styleValue);
    return alignMatch ? alignMatch[1].toLowerCase() : null;
}

/**
 * Режет rich-HTML поля на верхнеуровневые блочные абзацы (упрощённый JS-аналог
 * split_block_segments, app/domains/acts/formatters/docx/builders/inline.py) —
 * #13: `_addLine` кладёт тело поля в инлайновый `<span>` рядом с меткой;
 * блочные `<div>` многострочного rich-значения (Enter в rich-редакторе →
 * новый параграф) внутри `<span>` рвут инлайн-контекст (anonymous block boxes,
 * CSS 2.1 §9.2.1.1) — метка остаётся одна на строке, первая строка уезжает
 * вниз. Верхнеуровневый `<div>`/`<p>` → отдельный сегмент (его ВНУТРЕННИЙ
 * html, обёртка отбрасывается; text-align обёртки сохраняется в align
 * сегмента — F2/Пункт 1). Смежный контент вне блочных тегов (голый
 * текст/инлайн-форматирование/`<br>`) уходит в отдельный анонимный сегмент
 * без align. Вложенные блочные теги остаются внутри html родительского
 * сегмента (рендерятся как есть). Нет верхнеуровневых блочных тегов (частый
 * случай — однострочные поля) → один сегмент с исходным html без align.
 * @param {string} html
 * @returns {{html: string, align: (string|null)}[]} Сегменты в порядке появления
 */
export function splitTopLevelBlocks(html) {
    if (!html) return [];
    const segments = [];
    const tagRe = /<(div|p)\b[^>]*>|<\/(div|p)>/gi;
    let depth = 0;
    let segStart = 0;
    let blockStart = -1;
    let blockAlign = null;
    let match;
    while ((match = tagRe.exec(html)) !== null) {
        if (match[1]) {
            if (depth === 0) {
                const anon = html.slice(segStart, match.index);
                if (anon.trim()) segments.push({ html: anon, align: null });
                blockStart = match.index + match[0].length;
                blockAlign = extractTextAlign(match[0]);
            }
            depth++;
        } else if (depth > 0) {
            depth--;
            if (depth === 0) {
                segments.push({ html: html.slice(blockStart, match.index), align: blockAlign });
                segStart = match.index + match[0].length;
            }
        }
    }
    const tail = html.slice(segStart);
    if (tail.trim()) segments.push({ html: tail, align: null });
    return segments;
}

/**
 * Чистый маппинг item.width / лимита высоты → inline-стиль картинки превью.
 *
 * @param {Object} item - Блок типа image (поле width: 0 — авто)
 * @param {number} imageMaxHeightPercent - Лимит высоты, % высоты листа
 * @returns {{width: string, maxHeight: string}} Значения CSS-свойств
 */
export function imagePresentationStyle(item, imageMaxHeightPercent) {
    const width = item && item.width > 0 ? `${item.width}%` : '';
    const heightMm = USABLE_HEIGHT_MM * (imageMaxHeightPercent || 40) / 100;
    // Округление до 0.1 мм, без хвоста «.0».
    const maxHeight = `${parseFloat(heightMm.toFixed(1))}mm`;
    return { width, maxHeight };
}

export class PreviewViolationRenderer {
    /**
     * Создает элемент нарушения (полные данные, без обрезки)
     *
     * @param {Object} violation - Данные нарушения
     * @returns {HTMLElement} Элемент нарушения
     */
    static create(violation) {
        const container = document.createElement('div');
        container.className = 'preview-violation';

        for (const line of collectViolationLines(violation)) {
            if (line.type === 'line') {
                this._addLine(container, line.label, line.text, line.small);
            } else if (line.type === 'image') {
                this._addImage(container, line.item);
            } else if (line.type === 'table') {
                this._addTable(container, line.table);
            }
        }

        return container;
    }

    /**
     * Добавляет абзац «Метка_подчёркнута полный текст» (паритет с DOCX:
     * label-run подчёркнут, body-run обычный). `small` → 9pt-курсив-группа.
     *
     * #13: многострочное rich-значение (несколько верхнеуровневых `<div>`-
     * абзацев) режется на сегменты (splitTopLevelBlocks) — паритет с DOCX
     * `_labeled_paragraph`/render_block_segments(first_paragraph=para): первый
     * абзац инлайнится рядом с меткой в ТОМ ЖЕ `<span>` (без него блочный
     * `<div>` внутри `<span>` рвёт инлайн-контекст, метка уезжает на свою
     * строку), последующие абзацы — отдельными блочными строками ниже, без
     * метки (как продолжающие w:p в DOCX).
     *
     * F2/Пункт 1: text-align сегмента (splitTopLevelBlocks) переносится на
     * строку превью — паритет с DOCX render_block_segments, где align
     * сегмента задаётся на весь w:p, включая label-run. Сегмент без align
     * (default) не получает инлайн-style — прежняя раскладка через CSS
     * (.preview-violation-line { text-align: justify }).
     * @private
     */
    static _addLine(container, label, text, small) {
        const className = small ? 'preview-violation-line preview-violation-line--small'
                                : 'preview-violation-line';
        const segments = splitTopLevelBlocks(text);
        const [first, ...rest] = segments.length ? segments : [{ html: text || '', align: null }];

        const line = document.createElement('div');
        line.className = className;
        if (first.align) {
            line.style.textAlign = first.align;
        }
        if (label) {
            const labelEl = document.createElement('span');
            labelEl.className = 'preview-violation-label';
            labelEl.textContent = `${label}: `;
            line.appendChild(labelEl);
        }
        // first.html — rich-HTML первого абзаца поля; рендерим через
        // renderActContent (профиль 'acts', паритет с DOCX/MD/TXT), не
        // текст-нодой — иначе сырой HTML показался бы буквально.
        const bodyEl = document.createElement('span');
        renderActContent(bodyEl, first.html);
        line.appendChild(bodyEl);
        container.appendChild(line);

        // Последующие абзацы — отдельные блочные строки той же типографики,
        // без метки (продолжение, не новое поле), каждая — со своим align.
        for (const segment of rest) {
            const contLine = document.createElement('div');
            contLine.className = className;
            if (segment.align) {
                contLine.style.textAlign = segment.align;
            }
            renderActContent(contLine, segment.html);
            container.appendChild(contLine);
        }
    }

    /**
     * Добавляет блок-таблицу через общий PreviewTableRenderer (та же графика,
     * что у таблиц-узлов дерева; ширины колонок — из colWidths сетки).
     * @private
     */
    static _addTable(container, table) {
        const wrap = document.createElement('div');
        wrap.className = 'preview-violation-table-wrap';
        wrap.appendChild(PreviewTableRenderer.create(table || { grid: [], colWidths: [] }));
        container.appendChild(wrap);
    }

    /**
     * Добавляет картинку: по центру, подпись курсивом снизу (как DOCX, Б-1.5).
     * Сломанная картинка (onerror) заменяется текстовым плейсхолдером.
     * @private
     */
    static _addImage(container, item) {
        const wrap = document.createElement('div');
        wrap.className = 'preview-violation-image-wrap';
        const placeholderText = `Изображение: ${item.filename || ''}`;
        const placeholderClassName = 'preview-violation-line preview-violation-line--small';

        if (!item.url) {
            // Пустой url (черновик) → плейсхолдер, как в DOCX/MD/TXT.
            wrap.appendChild(buildImagePlaceholder(placeholderText, placeholderClassName));
            container.appendChild(wrap);
            this._appendCaption(container, item);
            return;
        }

        const style = imagePresentationStyle(item, getImageLimits().imageMaxHeightPercent);
        // #27: onerror ДО src + текст-плейсхолдер при битой картинке — общее
        // ядро с редактором (violation-rendering.js).
        renderImageWithFallback(wrap, {
            src: item.url,
            alt: item.caption || item.filename || '',
            imgClassName: 'preview-violation-image',
            placeholderText,
            placeholderClassName,
            configureImg: (img) => {
                // Явная ширина задаёт width; потолок высоты
                // (image_max_height_percent) применяется ВСЕГДА — и при явной
                // ширине, и при авторазмере (#13). Паритет с DOCX
                // _scale_picture, который досжимает по высоте в обеих ветках.
                if (style.width) {
                    img.style.width = style.width;
                }
                img.style.maxHeight = style.maxHeight;
            },
        });
        container.appendChild(wrap);
        this._appendCaption(container, item);
    }

    /**
     * Подпись картинки курсивом по центру (если задана)
     * @private
     */
    static _appendCaption(container, item) {
        if (!item.caption) return;
        const caption = document.createElement('div');
        caption.className = 'preview-violation-caption';
        // Подпись — rich-HTML (rich-редактор), рендерим через
        // renderActContent (профиль 'acts'), а не textContent — иначе
        // форматирование показалось бы буквальными тегами.
        renderActContent(caption, item.caption);
        container.appendChild(caption);
    }
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.PreviewViolationRenderer = PreviewViolationRenderer;
