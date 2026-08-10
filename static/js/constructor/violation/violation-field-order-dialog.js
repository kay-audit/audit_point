/**
 * Модалка «Порядок полей» нарушения.
 *
 * Десять строк-полей в текущем порядке (метки из реестра), сортировка мышью
 * (HTML5 draggable — простая перестановка строки), выключенные поля показаны
 * приглушённо, но перетаскиваются. «Применить» пишет перестановку в
 * violation.fieldOrder через мутатор, «Вернуть стандартный порядок» — null
 * (содержимое полей не трогается ни в одном из случаев).
 *
 * Стрелок вверх/вниз в самой форме нет — сценарий закрывает эта модалка
 * целиком (спека §4.3).
 */

import { DialogManager } from '../../shared/dialog/dialog-confirm.js';
import { VIOLATION_LABELS, getOrderedFieldKeys } from './violation-fields.js';

/**
 * Перестановка ключа в списке: чистая функция (тестируется без DOM).
 *
 * toIndex — позиция вставки В ИСХОДНОМ списке, как её считает dragover;
 * при движении вниз она уменьшается на 1, потому что удаление элемента с
 * fromIndex сдвигает всё, что правее, влево (зеркало moveBlock,
 * violation-mutations.js).
 *
 * @param {string[]} order - Исходный порядок ключей
 * @param {number} fromIndex - Индекс перетаскиваемой строки
 * @param {number} toIndex - Позиция вставки в исходном списке
 * @returns {string[]} Новый порядок (исходный массив не мутируется)
 */
export function reorderKeys(order, fromIndex, toIndex) {
    if (!Array.isArray(order)) return [];
    if (fromIndex < 0 || fromIndex >= order.length) return [...order];

    const next = [...order];
    const [moved] = next.splice(fromIndex, 1);
    let at = fromIndex < toIndex ? toIndex - 1 : toIndex;
    at = Math.max(0, Math.min(at, next.length));
    next.splice(at, 0, moved);
    return next;
}

/**
 * Открывает модалку порядка полей.
 *
 * @param {Object} params
 * @param {Object} params.violation - Объект нарушения
 * @param {Object} params.manager - ViolationManager (мутатор setFieldOrder)
 * @param {Function} [params.onApplied] - Колбэк после записи порядка (перерисовка формы)
 * @returns {Promise<boolean>} true, если порядок был изменён
 */
export async function openFieldOrderDialog({ violation, manager, onApplied }) {
    // Стартовый порядок — текущий отображаемый (fieldOrder либо стандартный).
    let order = [...getOrderedFieldKeys(violation)];

    const result = await DialogManager.show({
        title: 'Порядок полей',
        message: 'Перетащите строки, чтобы изменить порядок полей в акте.',
        icon: '↕️',
        type: 'info',
        hideConfirm: true,
        hideCancel: true,
        onMount: ({ overlay, close }) => {
            const dialog = overlay.querySelector('.custom-dialog');
            if (!dialog) return;

            const list = document.createElement('div');
            list.className = 'violation-field-order-list';

            let dragFrom = null;

            const renderRows = () => {
                list.innerHTML = '';
                order.forEach((key, index) => {
                    const row = document.createElement('div');
                    row.className = 'violation-field-order-row';
                    if (!violation?.[key]?.enabled) {
                        row.classList.add('violation-field-order-row--disabled');
                    }
                    row.draggable = true;
                    row.dataset.fieldKey = key;
                    row.dataset.index = String(index);

                    const handle = document.createElement('span');
                    handle.className = 'violation-field-order-handle';
                    handle.textContent = '⋮⋮';

                    const label = document.createElement('span');
                    label.className = 'violation-field-order-label';
                    label.textContent = VIOLATION_LABELS[key] || key;

                    row.appendChild(handle);
                    row.appendChild(label);

                    row.addEventListener('dragstart', (e) => {
                        dragFrom = index;
                        row.classList.add('dragging');
                        if (e.dataTransfer) {
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', key);
                        }
                    });
                    row.addEventListener('dragend', () => {
                        dragFrom = null;
                        row.classList.remove('dragging');
                    });
                    row.addEventListener('dragover', (e) => {
                        e.preventDefault();
                        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                    });
                    row.addEventListener('drop', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (dragFrom === null || dragFrom === index) return;
                        // Верхняя половина строки — вставка перед ней, нижняя — после.
                        const rect = row.getBoundingClientRect();
                        const after = e.clientY > rect.top + rect.height / 2;
                        order = reorderKeys(order, dragFrom, after ? index + 1 : index);
                        dragFrom = null;
                        renderRows();
                    });

                    list.appendChild(row);
                });
            };

            renderRows();
            dialog.appendChild(list);

            const row = document.createElement('div');
            row.className = 'dialog-buttons';

            const applyBtn = document.createElement('button');
            applyBtn.type = 'button';
            applyBtn.className = 'btn btn-primary';
            applyBtn.textContent = 'Применить';
            applyBtn.addEventListener('click', () => close('apply'));

            const resetBtn = document.createElement('button');
            resetBtn.type = 'button';
            resetBtn.className = 'btn btn-secondary';
            resetBtn.textContent = 'Вернуть стандартный порядок';
            resetBtn.addEventListener('click', () => close('reset'));

            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'btn btn-secondary';
            cancelBtn.textContent = 'Отмена';
            cancelBtn.addEventListener('click', () => close('cancel'));

            row.appendChild(applyBtn);
            row.appendChild(resetBtn);
            row.appendChild(cancelBtn);
            dialog.appendChild(row);
        },
    });

    if (result !== 'apply' && result !== 'reset') return false;

    // «Вернуть стандартный порядок» = записать null (спека §2.4).
    const written = manager.setFieldOrder(violation, result === 'reset' ? null : order);
    if (!written) return false;

    if (typeof onApplied === 'function') onApplied();
    return true;
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
if (typeof window !== 'undefined') {
    window.openViolationFieldOrderDialog = openFieldOrderDialog;
}
