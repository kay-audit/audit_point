/**
 * Диалог выбора при вставке КОМБИНИРОВАННОГО буфера в rich-поле зоны
 * дополнительных материалов (№5 код-ревью).
 *
 * Копирование диапазона Excel или фрагмента Word кладёт в буфер и текст
 * (text/html + text/plain), и растровое представление. Оба конвейера —
 * редактора (текст в поле) и зоны (картинка отдельным элементом) — считали
 * такой буфер своим, и один Ctrl+V давал два результата сразу. Что вставлять,
 * решает пользователь; отмена (Escape / клик вне диалога) не вставляет ничего.
 *
 * Верстка и поведение — как у диалога качества картинок
 * (promptImageQualityMode, violation-blocks.js): DialogManager без
 * штатных кнопок, свой ряд .dialog-buttons в onMount. Escape приходит через
 * EscapeStack базового диалога — своей обработки клавиш здесь нет.
 */
import { DialogManager } from '../../shared/dialog/dialog-confirm.js';

/**
 * Варианты вставки. Порядок = порядок кнопок; первая получает автофокус
 * DialogBase (Enter = «Только текст») и потому подсвечена как основная.
 */
const PASTE_CHOICES = [
    { value: 'text', label: 'Только текст' },
    { value: 'image', label: 'Только изображение' },
    { value: 'both', label: 'Текст и изображение' },
];

/**
 * Спрашивает, что вставить из буфера, где есть и текст, и изображение.
 *
 * @returns {Promise<'text'|'image'|'both'|null>} Выбор пользователя или null
 *   при отмене (Escape / клик вне диалога) — вставлять нечего.
 */
export async function promptPasteChoice() {
    const result = await DialogManager.show({
        title: 'В буфере обмена текст и изображение',
        message: 'Выберите, что вставить. Текст попадёт в поле, где стоит курсор; '
            + 'изображение добавится отдельным элементом дополнительных материалов.',
        icon: '📋',
        type: 'info',
        hideConfirm: true,
        hideCancel: true,
        onMount: ({ overlay, close }) => {
            const dialog = overlay.querySelector('.custom-dialog');
            if (!dialog) return;
            const row = document.createElement('div');
            row.className = 'dialog-buttons';
            for (const choice of PASTE_CHOICES) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `btn ${choice === PASTE_CHOICES[0] ? 'btn-primary' : 'btn-secondary'}`;
                btn.textContent = choice.label;
                btn.addEventListener('click', () => close(choice.value));
                row.appendChild(btn);
            }
            dialog.appendChild(row);
        },
    });

    // Закрытие без кнопки резолвит служебным true (hideCancel) — не выбор.
    return PASTE_CHOICES.some(choice => choice.value === result) ? result : null;
}
