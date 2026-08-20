/**
 * Рендерер блока подписи в конце акта — для предпросмотра.
 *
 * Воспроизводит Word-экспорт (эталон — app/domains/acts/formatters/docx/
 * builders/signature.py, build_signature) по данным window.actMetadata:
 * «Руководитель аудиторской проверки» слева, ФИО справа у правого поля
 * (в DOCX — правый tab-stop на всю рабочую ширину текста).
 *
 * ФИО берётся из audit_team по роли «Руководитель» и сокращается до
 * «Фамилия И.О.» — инициалы без пробелов между ними. Руководителя нет →
 * прочерк-заглушка, ровно как в билдере.
 *
 * Настройкой «показывать шапку акта» блок НЕ управляется: это не шапка, а
 * подпись, и в DOCX она печатается всегда. Метаданных нет вовсе → мягкая
 * деградация, не рисуем ничего (как PreviewCoverRenderer).
 */

/** Заглушка ФИО, когда руководителя в составе группы нет (_LEADER_FALLBACK). */
const LEADER_FALLBACK = '_______________';

export class PreviewSignatureRenderer {
    /**
     * Создаёт DOM-элемент блока подписи.
     *
     * @param {Object} metadata - window.actMetadata (snake_case)
     * @returns {HTMLElement|null} Корневой элемент или null, если нет данных
     */
    static create(metadata) {
        if (!metadata) return null;

        const root = document.createElement('div');
        root.className = 'preview-signature';

        const label = document.createElement('span');
        label.className = 'preview-signature-label';
        label.textContent = 'Руководитель аудиторской проверки';

        const fio = document.createElement('span');
        fio.className = 'preview-signature-fio';
        fio.textContent = this._resolveLeaderFio(metadata);

        root.appendChild(label);
        root.appendChild(fio);
        return root;
    }

    /** @private ФИО руководителя из состава группы либо заглушка. */
    static _resolveLeaderFio(metadata) {
        const team = metadata.audit_team || [];
        const leader = team.find(member => member && member.role === 'Руководитель');
        return leader ? this._shortFio(leader.full_name) : LEADER_FALLBACK;
    }

    /**
     * «Фамилия Имя Отчество» → «Фамилия И.О.» (зеркало _short_fio).
     * Два слова → «Фамилия И.»; одно слово возвращается как есть.
     * @private
     */
    static _shortFio(fullName) {
        const parts = String(fullName || '').split(/\s+/).filter(Boolean);
        if (parts.length <= 1) return fullName || '';
        const initials = parts.slice(1).map(word => `${word[0]}.`).join('');
        return `${parts[0]} ${initials}`;
    }
}

// Window-global для совместимости с inline-скриптами в шаблонах.
window.PreviewSignatureRenderer = PreviewSignatureRenderer;
