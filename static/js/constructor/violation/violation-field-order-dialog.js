/**
 * Модалка «Порядок полей» нарушения.
 *
 * Десять строк-полей в текущем порядке (метки из реестра), сортировка мышью
 * (HTML5 draggable, живая перестановка на dragover + FLIP-анимация),
 * выключенные поля показаны приглушённо, но перетаскиваются. «Применить»
 * пишет перестановку в violation.fieldOrder через мутатор, «Вернуть
 * стандартный порядок» — null (содержимое полей не трогается ни в одном
 * из случаев).
 *
 * Стрелок вверх/вниз в самой форме нет — сценарий закрывает эта модалка
 * целиком (спека §4.3).
 */

import { DialogManager } from '../../shared/dialog/dialog-confirm.js';
import { VIOLATION_LABELS, getOrderedFieldKeys } from './violation-fields.js';

const FLIP_DURATION_MS = 150;

/**
 * Перестановка ключа в списке: чистая функция (тестируется без DOM).
 *
 * toIndex — позиция вставки В ИСХОДНОМ списке, как её считает dragover;
 * при движении вниз она уменьшается на 1, потому что удаление элемента с
 * fromIndex сдвигает всё, что правее, влево (тот же счёт, что у одиночного
 * блока в planBlocksReorder, violation-mutations.js).
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
 * Позиция вставки перетаскиваемой строки относительно строки-цели по
 * Y-координате курсора: верхняя половина строки-цели — вставка перед ней
 * (targetIndex), нижняя половина — после (targetIndex + 1). Чистая функция
 * без DOM — принимает уже снятые числа, поэтому тестируется без jsdom.
 *
 * @param {number} targetTop - top строки-цели (getBoundingClientRect().top)
 * @param {number} targetHeight - height строки-цели
 * @param {number} clientY - Y-координата курсора (dragover event)
 * @param {number} targetIndex - индекс строки-цели в текущем order
 * @returns {number} Позиция вставки — второй аргумент для reorderKeys
 */
export function insertionIndexByPointer(targetTop, targetHeight, clientY, targetIndex) {
    const after = clientY > targetTop + targetHeight / 2;
    return after ? targetIndex + 1 : targetIndex;
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
            // Модификатор ширины — три кнопки (в т.ч. «Вернуть стандартный
            // порядок») не помещаются в стандартные --dialog-max-width.
            dialog.classList.add('custom-dialog--field-order');

            const list = document.createElement('div');
            list.className = 'violation-field-order-list';

            const reduceMotion = typeof window.matchMedia === 'function'
                && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

            // Строки создаются ОДИН раз и далее только переставляются в DOM
            // (layout) — пересоздание строки, на которой идёт нативный HTML5
            // drag, обрывает сессию перетаскивания.
            const rowsByKey = new Map();
            let dragFromKey = null;
            let dragSnapshotOrder = null;

            /**
             * Переставляет DOM-узлы строк под текущий `order`. Без
             * reduce-motion — проигрывает FLIP-переход (снятие позиций до,
             * transform из старой позиции в новую после).
             */
            const layout = () => {
                const prevTops = reduceMotion ? null : new Map();
                if (prevTops) {
                    for (const [key, el] of rowsByKey) {
                        prevTops.set(key, el.getBoundingClientRect().top);
                    }
                }

                order.forEach((key) => list.appendChild(rowsByKey.get(key)));

                if (!prevTops) return;
                for (const [key, el] of rowsByKey) {
                    const dy = prevTops.get(key) - el.getBoundingClientRect().top;
                    if (!dy) continue;
                    el.style.transition = 'none';
                    el.style.transform = `translateY(${dy}px)`;
                    void el.offsetHeight; // форсируем reflow, чтобы transition сыграл из выставленной позиции
                    el.style.transition = `transform ${FLIP_DURATION_MS}ms ease`;
                    el.style.transform = '';
                }
            };

            const createRow = (key) => {
                const row = document.createElement('div');
                row.className = 'violation-field-order-row';
                if (!violation?.[key]?.enabled) {
                    row.classList.add('violation-field-order-row--disabled');
                }
                row.draggable = true;
                row.dataset.fieldKey = key;

                const handle = document.createElement('span');
                handle.className = 'violation-field-order-handle';
                handle.textContent = '⋮⋮';

                const label = document.createElement('span');
                label.className = 'violation-field-order-label';
                label.textContent = VIOLATION_LABELS[key] || key;

                row.appendChild(handle);
                row.appendChild(label);

                row.addEventListener('dragstart', (e) => {
                    dragFromKey = key;
                    dragSnapshotOrder = [...order];
                    row.classList.add('dragging');
                    if (e.dataTransfer) {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', key);
                    }
                });

                row.addEventListener('dragend', (e) => {
                    // Отмена нативным drag'ом (Esc, drop вне зоны) — браузер
                    // оставляет dropEffect='none': откатываем к снапшоту.
                    if (dragSnapshotOrder && e.dataTransfer && e.dataTransfer.dropEffect === 'none') {
                        order = dragSnapshotOrder;
                        layout();
                    }
                    row.classList.remove('dragging');
                    dragFromKey = null;
                    dragSnapshotOrder = null;
                });

                row.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                    if (dragFromKey === null || dragFromKey === key) return;

                    const rect = row.getBoundingClientRect();
                    const targetIndex = order.indexOf(key);
                    const toIndex = insertionIndexByPointer(rect.top, rect.height, e.clientY, targetIndex);
                    const fromIndex = order.indexOf(dragFromKey);
                    const next = reorderKeys(order, fromIndex, toIndex);
                    // Защита от дребезга: перерисовываем только при реальной смене порядка.
                    if (next.join(' ') === order.join(' ')) return;
                    order = next;
                    layout();
                });

                row.addEventListener('drop', (e) => {
                    // Перестановка уже применена по ходу dragover — drop только фиксирует событие.
                    e.preventDefault();
                    e.stopPropagation();
                });

                return row;
            };

            order.forEach((key) => rowsByKey.set(key, createRow(key)));
            order.forEach((key) => list.appendChild(rowsByKey.get(key)));

            // Подстраховка для зазоров между строками и хвоста списка: без
            // preventDefault здесь drop в тонком gap отменил бы перетаскивание.
            list.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = dragFromKey ? 'move' : 'none';
            });

            dialog.appendChild(list);

            // «Вернуть стандартный порядок» — отдельной строкой на всю
            // ширину: текст не должен резаться рядом с «Применить»/«Отмена».
            const resetBtn = document.createElement('button');
            resetBtn.type = 'button';
            resetBtn.className = 'btn btn-ghost btn-block violation-field-order-reset-btn';
            resetBtn.textContent = 'Вернуть стандартный порядок';
            resetBtn.addEventListener('click', () => close('reset'));
            dialog.appendChild(resetBtn);

            const buttonsRow = document.createElement('div');
            buttonsRow.className = 'dialog-buttons';

            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'btn btn-secondary';
            cancelBtn.textContent = 'Отмена';
            cancelBtn.addEventListener('click', () => close('cancel'));

            const applyBtn = document.createElement('button');
            applyBtn.type = 'button';
            applyBtn.className = 'btn btn-primary';
            applyBtn.textContent = 'Применить';
            applyBtn.addEventListener('click', () => close('apply'));

            buttonsRow.appendChild(cancelBtn);
            buttonsRow.appendChild(applyBtn);
            dialog.appendChild(buttonsRow);
        },
    });

    if (result !== 'apply' && result !== 'reset') return false;

    // «Вернуть стандартный порядок» = записать null (спека §2.4).
    const written = manager.setFieldOrder(violation, result === 'reset' ? null : order);
    if (!written) return false;

    if (typeof onApplied === 'function') onApplied();
    return true;
}
