/**
 * Рендерер шапки акта (cover-блок) для предпросмотра.
 *
 * Воспроизводит Word-экспорт (эталон — app/domains/acts/formatters/docx/builders/cover.py,
 * build_cover_block / _add_preamble / _build_rows) по данным window.actMetadata
 * (snake_case, даты — ISO-строки "YYYY-MM-DD").
 *
 * Структура: «Приложение 1» (справа, жирным) → строка «город слева + дата начала
 * справа» → центрированный заголовок «Акт аудиторской проверки по {inspection_name}»
 * → безрамочная таблица 4×2 (жирные метки слева, значения справа, состав группы —
 * построчно). Строку «Акт … составлен на N листах» НЕ выводим: NUMPAGES в превью
 * невычислим (осознанно опущено).
 */
const MONTHS_GENITIVE = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

export class PreviewCoverRenderer {
    /**
     * Создаёт DOM-элемент шапки акта по метаданным.
     *
     * @param {Object} metadata - window.actMetadata (snake_case)
     * @returns {HTMLElement|null} Корневой элемент шапки или null, если нет данных
     */
    static create(metadata) {
        if (!metadata) return null;

        const root = document.createElement('div');
        root.className = 'preview-cover';

        root.appendChild(this._createAppendixLabel());
        root.appendChild(this._createCityDateRow(metadata));
        root.appendChild(this._createTitle(metadata));
        root.appendChild(this._createTable(metadata));

        return root;
    }

    /** @private «Приложение 1» — справа, жирным. */
    static _createAppendixLabel() {
        const el = document.createElement('div');
        el.className = 'preview-cover-appendix';
        el.textContent = 'Приложение 1';
        return el;
    }

    /** @private Город слева, дата начала справа в одной строке. */
    static _createCityDateRow(m) {
        const row = document.createElement('div');
        row.className = 'preview-cover-city-date';

        const city = document.createElement('span');
        city.className = 'preview-cover-city';
        city.textContent = `г. ${m.city || ''}`;

        const date = document.createElement('span');
        date.className = 'preview-cover-date';
        date.textContent = this._formatStartDate(m.inspection_start_date);

        row.appendChild(city);
        row.appendChild(date);
        return row;
    }

    /** @private Заголовок по центру, жирным. */
    static _createTitle(m) {
        const el = document.createElement('div');
        el.className = 'preview-cover-title';
        el.textContent = `Акт аудиторской проверки по ${m.inspection_name || ''}`;
        return el;
    }

    /** @private Безрамочная сетка 4×2 (метка / значение). */
    static _createTable(m) {
        const table = document.createElement('div');
        table.className = 'preview-cover-table';

        for (const [label, value] of this._buildRows(m)) {
            table.appendChild(this._createCell('preview-cover-label', label));
            // Значения могут быть многострочными (состав группы) — строка на строку.
            table.appendChild(this._createValueCell(value));
        }

        return table;
    }

    /** @private Ячейка-метка (жирная). */
    static _createCell(className, text) {
        const cell = document.createElement('div');
        cell.className = className;
        cell.textContent = text;
        return cell;
    }

    /**
     * @private Ячейка-значение: каждая строка — свой узел.
     *
     * В эталоне (_fill_value_cell) многострочное значение раскладывается по
     * ОТДЕЛЬНЫМ абзацам ячейки, а не по мягким переносам, поэтому между
     * строками состава группы стоит обычный Normal-интервал. Прежний `<br>`
     * склеивал их вплотную — состав на экране шёл плотнее, чем в файле.
     */
    static _createValueCell(value) {
        const cell = document.createElement('div');
        cell.className = 'preview-cover-value';
        for (const line of String(value).split('\n')) {
            const paragraph = document.createElement('div');
            paragraph.className = 'preview-cover-line';
            paragraph.textContent = line;
            cell.appendChild(paragraph);
        }
        return cell;
    }

    /**
     * Строит 4 пары (метка, значение). Логика 1:1 с _build_rows эталона.
     * @private
     */
    static _buildRows(m) {
        const team = Array.isArray(m.audit_team) ? m.audit_team : [];
        const orderDateStr = this._formatDmy(m.order_date);
        const startStr = this._formatDmy(m.inspection_start_date);
        const endStr = this._formatDmy(m.inspection_end_date);

        const orderYear = this._year(m.order_date)
            || this._year(m.inspection_start_date)
            || '';
        const basis = `План работы СВА на ${orderYear} год. `
            + `Распоряжение от ${orderDateStr} №${m.order_number || ''}.`;

        const teamLines = [];
        for (const t of team) {
            if (t.role === 'Куратор') {
                teamLines.push(`Куратор – ${t.full_name} (${t.position})`);
            }
        }
        for (const t of team) {
            if (t.role === 'Руководитель') {
                teamLines.push(`Руководитель – ${t.full_name} (${t.position})`);
            }
        }

        // AppendixRef — служебная запись с готовым текстом; если есть,
        // участников построчно не перечисляем.
        const appendixRef = team.find(t => t.role === 'AppendixRef');
        if (appendixRef) {
            teamLines.push(`Участники – ${appendixRef.full_name}`);
        } else {
            for (const t of team) {
                if (t.role === 'Участник' || t.role === 'Редактор') {
                    teamLines.push(`Участник – ${t.full_name} (${t.position})`);
                }
            }
        }

        const teamValue = teamLines.join('\n');
        const datesValue = `Начата ${startStr} и завершена ${endStr}`;

        return [
            ['Основание аудиторской проверки:', basis],
            ['Состав аудиторской группы:', teamValue],
            ['Сроки проведения аудиторской проверки:', datesValue],
            ['Номер АП в АС СУП СВА:', m.km_number || ''],
        ];
    }

    /**
     * Дата начала проверки: «D» месяц_родительный YYYY г.
     * @private
     */
    static _formatStartDate(iso) {
        const parts = this._parseIso(iso);
        if (!parts) return '';
        const [year, month, day] = parts;
        return `«${day}» ${MONTHS_GENITIVE[month - 1]} ${year} г.`;
    }

    /**
     * Дата в формате DD.MM.YYYY.
     * @private
     */
    static _formatDmy(iso) {
        const parts = this._parseIso(iso);
        if (!parts) return '';
        const [year, month, day] = parts;
        return `${this._pad(day)}.${this._pad(month)}.${year}`;
    }

    /** @private Год из ISO-даты (число) или null. */
    static _year(iso) {
        const parts = this._parseIso(iso);
        return parts ? parts[0] : null;
    }

    /**
     * Парсит ISO-дату "YYYY-MM-DD" в [year, month, day] (числа).
     * Парсим вручную, без new Date(), чтобы исключить сдвиг из-за таймзоны.
     * @private
     */
    static _parseIso(iso) {
        if (!iso || typeof iso !== 'string') return null;
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
        if (!m) return null;
        return [Number(m[1]), Number(m[2]), Number(m[3])];
    }

    /** @private Дополняет число до 2 цифр. */
    static _pad(n) {
        return String(n).padStart(2, '0');
    }
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.PreviewCoverRenderer = PreviewCoverRenderer;
