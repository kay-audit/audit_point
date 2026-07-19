/**
 * Рендерер нарушений для предпросмотра
 *
 * Паритет ПОЛНОТЫ данных с DOCX (build_violation): полные тексты всех полей
 * без обрезки, полный список описаний (descriptionList), полные кейсы и
 * свободные тексты, реальные картинки с подписью (H4/M.3/M.5). Подпись
 * responsible и шаблоны кейс/свободный-текст берутся из контракта
 * violation-fields.js (Task 1); остальные подписи-ярлыки — превью-стилем.
 * Q1: пустые поля рендерятся как «метка + пустое тело», без «—» и без
 * фильтрации по trim() (ядро/кейсы/пункты списка — у них есть метка/маркер).
 * Исключение — свободный текст (freeText): у него нет метки, поэтому пустой
 * freeText — буквально нечего рендерить; паритет с DOCX/MD/TXT, которые его
 * пропускают (см. collectViolationLines).
 */
import { renderActContent } from '../../shared/sanitize.js';
import { getImageLimits } from '../violation/violation-image-validator.js';
import {
    CONTENT_TYPE_CASE,
    CONTENT_TYPE_FREE_TEXT,
    CONTENT_TYPE_IMAGE,
} from '../violation/violation-content-item.js';
import { VIOLATION_LABELS, CASE_LABEL_TEMPLATE, FREE_TEXT_LABEL } from '../violation/violation-fields.js';
import { computeAdditionalContentNumbers } from '../violation/violation-numbering.js';
import { buildImagePlaceholder, renderImageWithFallback } from '../violation/violation-image-render.js';

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
 * Нумерация кейсов и сброс счётчика — через computeAdditionalContentNumbers
 * (Task 2, violation-numbering.js): нумеруются ВСЕ кейсы, включая пустые.
 *
 * Флаг `small` помечает поля, которые в Word рендерятся 9pt-курсивом
 * (Нарушено/Установлено/descriptionList/additionalContent — см. styles.Sizes.
 * violation_pt). Поля «Причины/Последствия/Ответственный» — обычный
 * текст листа (12pt, без курсива), поэтому `small: false`.
 *
 * @param {Object} violation - Данные нарушения
 * @returns {Array<Object>} Строки: {type:'line', label, text, small} |
 *          {type:'list', label, items, small} | {type:'image', item}
 */
export function collectViolationLines(violation) {
    const lines = [];

    lines.push({ type: 'line', label: 'Нарушено', text: violation.violated || '', small: true });
    lines.push({ type: 'line', label: 'Установлено', text: violation.established || '', small: true });

    if (violation.descriptionList?.enabled) {
        const items = violation.descriptionList.items || [];
        if (items.length > 0) {
            lines.push({ type: 'list', label: '', items, small: true });
        }
    }

    if (violation.additionalContent?.enabled) {
        const items = violation.additionalContent.items || [];
        const numbering = computeAdditionalContentNumbers(items);
        items.forEach((item, i) => {
            if (item.type === CONTENT_TYPE_CASE) {
                const label = CASE_LABEL_TEMPLATE.replace('{n}', numbering[i].number);
                lines.push({ type: 'line', label, text: item.content || '', small: true });
            } else if (item.type === CONTENT_TYPE_IMAGE) {
                lines.push({ type: 'image', item });
            } else if (item.type === CONTENT_TYPE_FREE_TEXT) {
                // Пустой freeText не имеет метки — у него нет что рендерить
                // (паритет с DOCX/MD/TXT, которые пустой freeText пропускают).
                if (item.content?.trim()) {
                    lines.push({ type: 'line', label: FREE_TEXT_LABEL, text: item.content, small: true });
                }
            }
        });
    }

    const optionalFields = [
        ['reasons', 'Причины'],
        ['measures', 'Принятые меры'],
        ['consequences', 'Последствия'],
        ['responsible', VIOLATION_LABELS.responsible],
    ];
    for (const [key, label] of optionalFields) {
        const field = violation[key];
        if (field?.enabled && field?.content) {
            lines.push({ type: 'line', label, text: field.content, small: false });
        }
    }

    return lines;
}

/**
 * Чистый маппинг item.width / лимита высоты → inline-стиль картинки превью.
 *
 * @param {Object} item - Элемент типа image (поле width: 0 — авто)
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
            } else if (line.type === 'list') {
                this._addList(container, line.label, line.items, line.small);
            } else if (line.type === 'image') {
                this._addImage(container, line.item);
            }
        }

        return container;
    }

    /**
     * Добавляет абзац «Метка_подчёркнута полный текст» (паритет с DOCX:
     * label-run подчёркнут, body-run обычный). `small` → 9pt-курсив-группа.
     * @private
     */
    static _addLine(container, label, text, small) {
        const line = document.createElement('div');
        line.className = small ? 'preview-violation-line preview-violation-line--small'
                               : 'preview-violation-line';
        if (label) {
            const labelEl = document.createElement('span');
            labelEl.className = 'preview-violation-label';
            labelEl.textContent = `${label}: `;
            line.appendChild(labelEl);
        }
        // text — rich-HTML поле нарушения (Task 1.1); рендерим через
        // renderActContent (профиль 'acts', паритет с DOCX/MD/TXT), не
        // текст-нодой — иначе сырой HTML показался бы буквально.
        const bodyEl = document.createElement('span');
        renderActContent(bodyEl, text);
        line.appendChild(bodyEl);
        container.appendChild(line);
    }

    /**
     * Добавляет полный список описаний (паритет с буллетами DOCX)
     * @private
     */
    static _addList(container, label, items, small) {
        const line = document.createElement('div');
        line.className = small ? 'preview-violation-line preview-violation-line--small'
                               : 'preview-violation-line';
        if (label) {
            const labelEl = document.createElement('span');
            labelEl.className = 'preview-violation-label';
            labelEl.textContent = `${label}:`;
            line.appendChild(labelEl);
        }
        container.appendChild(line);

        const list = document.createElement('ul');
        list.className = small ? 'preview-violation-desclist preview-violation-desclist--small'
                               : 'preview-violation-desclist';
        for (const item of items) {
            const li = document.createElement('li');
            // Task 7: пункт — rich-HTML поле нарушения; рендерим через
            // renderActContent (профиль 'acts', паритет с DOCX/MD/TXT и
            // _addLine выше), не текст-нодой — иначе сырой HTML показался бы
            // буквально.
            renderActContent(li, item);
            list.appendChild(li);
        }
        container.appendChild(list);
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
        // Task 6: подпись — rich-HTML (rich-редактор), рендерим через
        // renderActContent (профиль 'acts'), а не textContent — иначе
        // форматирование показалось бы буквальными тегами.
        renderActContent(caption, item.caption);
        container.appendChild(caption);
    }
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.PreviewViolationRenderer = PreviewViolationRenderer;
