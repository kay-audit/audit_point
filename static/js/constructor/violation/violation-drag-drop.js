/**
 * Drag & Drop блоков ВНУТРИ одного поля нарушения.
 *
 * Полезная нагрузка перетаскивания — {violationId, fieldKey, blockIds}: drop в
 * контейнер другого поля (или другого нарушения) игнорируется, перенос блоков
 * между полями — сознательный non-goal первой итерации (спека §7).
 * Перестановка — мутатором moveBlocks (там read-only-guard и превью).
 *
 * Пачка, а не один блок: за шапку ВЫДЕЛЕННОГО блока тащится всё выделение
 * (violation-block-selection.js), за шапку невыделенного — выделение
 * схлопывается на него, и едет он один. Одиночное перетаскивание — частный
 * случай пачки из одного id, отдельного пути для него нет.
 */

import { ViolationManager } from './violation-core.js';
import { BLOCK_TYPE_META } from './violation-block-types.js';
import { planBlocksReorder } from './violation-mutations.js';
import { pluralizeBlocks } from './violation-block-selection.js';

/** MIME-тип полезной нагрузки внутреннего перетаскивания блока. */
const DRAG_PAYLOAD_TYPE = 'application/x-violation-block';

/**
 * Мёртвая зона вокруг середины блока (px): пока курсор не отошёл от середины
 * дальше DEAD_BAND, позиция вставки не переключается. Без гистерезиса дрожание
 * курсора на один пиксель у середины гоняет индикатор «перед блоком» ⇄ «после
 * блока» и он мигает. 12px — примерно строка текста: заметно больше дрожания
 * руки, но заметно меньше половины самого низкого блока.
 */
const MIDDLE_DEAD_BAND_PX = 12;

/**
 * Читает полезную нагрузку перетаскивания: из dataTransfer (drop), иначе — из
 * снимка на менеджере (dragover: getData во время drag браузер не отдаёт).
 * @param {Event} e - Событие drag&drop
 * @param {ViolationManager} manager
 * @returns {{violationId: string, fieldKey: string, blockIds: string[]}|null}
 */
function readDragPayload(e, manager) {
    try {
        const raw = e.dataTransfer?.getData(DRAG_PAYLOAD_TYPE);
        if (raw) return JSON.parse(raw);
    } catch (_) { /* нечитаемый payload — падаем на снимок ниже */ }
    return manager._dragPayload || null;
}

/**
 * Принадлежит ли перетаскиваемый блок ИМЕННО этому полю этого нарушения.
 * @param {Object|null} payload - Полезная нагрузка перетаскивания
 * @param {Object} violation - Объект нарушения
 * @param {string} fieldKey - Ключ поля реестра
 * @returns {boolean}
 */
function isSameField(payload, violation, fieldKey) {
    return !!payload && payload.violationId === violation.id && payload.fieldKey === fieldKey;
}

/**
 * Перетаскивание файлов (картинок) — зона ответственности
 * violation-file-upload.js: его слушатели висят на том же контейнере, и
 * перестановка блоков в такой drag не вмешивается.
 * @param {Event} e - Событие drag&drop
 * @returns {boolean}
 */
function isFileDrag(e) {
    return !!e.dataTransfer?.types?.includes?.('Files');
}

/**
 * Ближайший к курсору ЗАЗОР между обёртками — позиция вставки для случая,
 * когда под курсором обёртки нет (зазор, отступы контейнера, сама полоска
 * индикатора). Границы: 0 — над первой обёрткой, N — под последней,
 * промежуточные — середина зазора между соседями.
 *
 * @param {HTMLElement[]} wrappers - Обёртки блоков в порядке контейнера
 * @param {number} mouseY - Координата курсора
 * @returns {number|null} Позиция вставки; null — обёрток нет
 */
function nearestGapPosition(wrappers, mouseY) {
    if (wrappers.length === 0) return null;

    const rects = wrappers.map(wrapper => wrapper.getBoundingClientRect());
    let best = 0;
    let bestDistance = Infinity;

    for (let i = 0; i <= rects.length; i++) {
        let gapY;
        if (i === 0) gapY = rects[0].top;
        else if (i === rects.length) gapY = rects[rects.length - 1].bottom;
        else gapY = (rects[i - 1].bottom + rects[i].top) / 2;

        const distance = Math.abs(mouseY - gapY);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = i;
        }
    }

    return best;
}

// Расширение ViolationManager
Object.assign(ViolationManager.prototype, {
    /**
     * Вешает приём перестановки блоков на КОНТЕЙНЕР поля, а не на каждую
     * обёртку: над зазором между карточками обёртки нет, и без контейнерного
     * `preventDefault` браузер запрещал там drop — блок отскакивал назад.
     * Вызывается один раз на контейнер (createBlocksField), перерисовка блоков
     * его не пересоздаёт.
     *
     * @param {HTMLElement} container - Контейнер блоков поля (.violation-blocks-items)
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     */
    setupBlockDragAndDrop(container, violation, fieldKey) {
        container.addEventListener('dragover',
            (e) => this.handleDragOver(e, violation, fieldKey, container));
        container.addEventListener('drop',
            (e) => this.handleDrop(e, violation, fieldKey, container));
    },

    /**
     * Вооружает обёртку блока перетаскиванием — но ТОЛЬКО если нажатие пришлось
     * на шапку `.content-item-label`.
     *
     * По умолчанию у обёртки `draggable = false` (renderBlocks), иначе любое
     * протягивание мышью в теле блока — выделение текста, ресайз колонки
     * таблицы, выделение ячеек — начинало бы drag блока. Chromium читает
     * `draggable` в момент старта перетаскивания, поэтому включать флаг на
     * mousedown достаточно; снимается он в disarmBlockDrag (mouseup/dragend).
     *
     * @param {MouseEvent} e - Событие mousedown на обёртке блока
     * @param {HTMLElement} wrapper - Обёртка блока (.content-item-wrapper)
     */
    armBlockDrag(e, wrapper) {
        wrapper.draggable = !!e.target?.closest?.('.content-item-label');
        if (!wrapper.draggable) return;
        // Кнопку могли отпустить МИМО обёртки, так и не начав перетаскивание
        // (курсор ушёл до порога drag): тогда не будет ни mouseup на обёртке,
        // ни dragend — флаг остался бы взведённым, и следующее протягивание
        // в теле блока утащило бы весь блок. Слушатель одноразовый, поэтому
        // между перерисовками не накапливается.
        document.addEventListener('mouseup', () => this.disarmBlockDrag(wrapper), { once: true });
    },

    /**
     * Снимает разрешение на перетаскивание (mouseup / конец drag).
     * @param {HTMLElement} wrapper - Обёртка блока (.content-item-wrapper)
     */
    disarmBlockDrag(wrapper) {
        if (wrapper) wrapper.draggable = false;
    },

    /**
     * Начало перетаскивания: полезная нагрузка (пачка id) + миниатюра.
     *
     * Взялись за шапку блока ВНЕ выделения — выделение схлопывается на него
     * (тот же приём, что у таблиц с ПКМ по невыделенной ячейке): тащить пачку,
     * в которую пользователь не целился, было бы сюрпризом.
     *
     * @param {Event} e - Событие dragstart
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {number} index - Индекс перетаскиваемого блока
     * @param {Object} block - Блок, за шапку которого взялись
     */
    handleDragStart(e, violation, fieldKey, index, block) {
        const wrapper = e.currentTarget;
        wrapper.classList.add('dragging');

        const orderedIds = (violation?.[fieldKey]?.blocks || []).map(b => b.id);
        if (!this.blockSelection.isSelected(violation.id, fieldKey, block.id)) {
            this.blockSelection.applyClick(violation.id, fieldKey, block.id, {}, orderedIds);
            this._syncSelectionEscapeLayer();
            this._syncBlockSelectionClasses(
                violation, fieldKey, wrapper?.closest?.('.violation-blocks-items'));
        }
        const blockIds = this.blockSelection.idsInOrder(violation.id, fieldKey, orderedIds);

        const payload = { violationId: violation.id, fieldKey, blockIds };
        this._dragPayload = payload;

        e.dataTransfer.effectAllowed = 'move';
        // text/plain — маркер ВНУТРЕННЕГО drag для приёма файлов
        // (violation-file-upload.js различает drag по составу types).
        e.dataTransfer.setData('text/plain', block.id);
        e.dataTransfer.setData(DRAG_PAYLOAD_TYPE, JSON.stringify(payload));

        // Создаем миниатюру
        const miniature = this.createDragMiniature(block, blockIds.length);
        miniature.style.position = 'absolute';
        miniature.style.top = '-1000px';
        miniature.id = 'drag-miniature-temp';
        document.body.appendChild(miniature);

        e.dataTransfer.setDragImage(miniature, 20, 20);

        // Удаляем миниатюру после начала перетаскивания
        setTimeout(() => {
            const temp = document.getElementById('drag-miniature-temp');
            if (temp) temp.remove();
        }, 0);

        // Сбрасываем последний индекс и флаг коммита при начале перетаскивания.
        this.lastDragOverIndex = null;
        this._lastDragOverElement = null;
        this._pendingDragOver = null;
        this._dropCommitted = false;
    },

    /**
     * Создает миниатюру перетаскивания: тип блока — для одиночного, счётный
     * бейдж — для пачки (в ней блоки разных типов, иконка одного соврала бы).
     * @param {Object} block - Блок, за шапку которого взялись
     * @param {number} [count] - Сколько блоков едет
     * @returns {HTMLElement} Миниатюра
     */
    createDragMiniature(block, count = 1) {
        const miniature = document.createElement('div');
        miniature.className = 'drag-miniature';

        if (count > 1) {
            miniature.innerHTML = `⋮⋮ ${count} ${pluralizeBlocks(count)}`;
            return miniature;
        }

        const meta = BLOCK_TYPE_META[block.type];
        miniature.innerHTML = meta ? `${meta.dragIcon} ${meta.label}` : ' ';
        return miniature;
    },

    /**
     * Обработчик входа в зону блока
     * @param {Event} e - Событие dragenter
     */
    handleDragEnter(e) {
        e.preventDefault();
    },

    /**
     * Перемещение над контейнером поля: индикатор позиции вставки.
     * @param {Event} e - Событие dragover
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {HTMLElement} container - Контейнер блоков поля
     */
    handleDragOver(e, violation, fieldKey, container) {
        // Файлы — не наш drag (их принимает violation-file-upload.js).
        if (isFileDrag(e)) return;
        // Блок из другого поля/нарушения — зону не подсвечиваем и drop не примем.
        if (!isSameField(this._dragPayload, violation, fieldKey)) return;

        // preventDefault по ВСЕЙ площади контейнера, а не только над обёртками:
        // иначе drop в зазор между карточками браузер не разрешит.
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        // dragover летит десятками событий в секунду, а его полезная работа —
        // getBoundingClientRect + перестановка индикатора в DOM (layout на
        // каждое событие). Поэтому синхронно снимаем только курсор и блок под
        // ним, а расчёт позиции откладываем до кадра. preventDefault выше —
        // всегда синхронно, иначе браузер не разрешит drop.
        this._pendingDragOver = {
            hoveredElement: e.target?.closest?.('.content-item-wrapper') || null,
            mouseY: e.clientY,
            container,
        };

        if (this._dragOverFrameScheduled) return;
        this._dragOverFrameScheduled = true;
        requestAnimationFrame(() => {
            this._dragOverFrameScheduled = false;
            const pending = this._pendingDragOver;
            this._pendingDragOver = null;
            // Кадр мог прийти уже после drop/dragend — тогда делать нечего.
            if (pending) this._applyDragOverPosition(pending);
        });
    },

    /**
     * Пересчитывает позицию вставки и двигает индикатор — тело dragover,
     * вызывается не чаще раза в кадр.
     *
     * @param {{hoveredElement: HTMLElement|null, mouseY: number, container: HTMLElement}} pending
     *        Снимок последнего dragover.
     */
    _applyDragOverPosition({ hoveredElement, mouseY, container }) {
        const draggingElement = document.querySelector('.dragging');
        if (!draggingElement) return;

        // Курсор над самим перетаскиваемым блоком: показанную позицию держим —
        // блок закрывает собой ровно то место, откуда его взяли.
        if (hoveredElement === draggingElement) return;

        // Обёртки контейнера в порядке поля — по ним считаются и позиция
        // вставки, и индексы перетаскиваемой пачки (адресация по data-block-id).
        const allWrappers = [...container.querySelectorAll('.content-item-wrapper')];

        let targetPosition;

        if (hoveredElement) {
            const currentIndex = allWrappers.indexOf(hoveredElement);
            if (currentIndex === -1) return;

            const rect = hoveredElement.getBoundingClientRect();
            const elementMiddle = rect.top + rect.height / 2;

            // В какую половину элемента попал курсор
            targetPosition = mouseY < elementMiddle ? currentIndex : currentIndex + 1;

            // Гистерезис у середины: пока курсор не отошёл от неё дальше мёртвой
            // зоны, держим уже показанную позицию. Действует только в пределах
            // одного блока — переход на другой блок всегда пересчитывает позицию.
            if (this.lastDragOverIndex !== null
                && this._lastDragOverElement === hoveredElement
                && Math.abs(mouseY - elementMiddle) <= MIDDLE_DEAD_BAND_PX) {
                targetPosition = this.lastDragOverIndex;
            }
            this._lastDragOverElement = hoveredElement;
        } else {
            // Обёртки под курсором нет — это зазор между карточками или отступы
            // контейнера: берём ближайший зазор по вертикали. Гистерезис здесь
            // не нужен, он привязан к середине конкретного блока.
            targetPosition = nearestGapPosition(allWrappers, mouseY);
            if (targetPosition === null) return;
            this._lastDragOverElement = null;
        }

        if (this.lastDragOverIndex === targetPosition) {
            return; // Позиция не изменилась, не делаем ничего
        }

        this.lastDragOverIndex = targetPosition;

        // Честный no-op: позиция, при которой итоговый порядок не меняется,
        // ничего не обещает — индикатор в ней не рисуем. Для одиночного блока
        // это классические «прямо над собой» и «прямо под собой», для пачки —
        // любой зазор внутри уже смежного прогона. Считает тот же планировщик,
        // что и мутатор, чтобы подсветка и модель не разошлись.
        // Сам индекс при этом сохраняем (а не сбрасываем в null): handleDrop по
        // нему сделает честный no-op, тогда как fallback при null уехал бы на
        // блок под курсором и порядок всё-таки поменялся бы.
        const moving = new Set(this._dragPayload?.blockIds || []);
        const movedIndices = [];
        allWrappers.forEach((wrapper, index) => {
            if (moving.has(wrapper.dataset?.blockId)) movedIndices.push(index);
        });
        if (!planBlocksReorder(allWrappers.length, movedIndices, targetPosition)) {
            this.removeInsertIndicators(container);
            return;
        }

        // Рисуем индикатор позиции вместо физического сдвига элемента (#6):
        // DOM больше не переставляется оптимистично, порядок вычисляется в
        // handleDrop index-based'ом. При Esc/промахе нечего откатывать.
        this.updateInsertIndicator(container, targetPosition);
    },

    /**
     * Обработчик выхода курсора из зоны элемента
     * @param {Event} e - Событие dragleave
     */
    handleDragLeave(e) {
        // Оставляем пустым, визуальное перемещение происходит в handleDragOver
    },

    /**
     * Сброс блока — фиксирует новый порядок в данных.
     * @param {Event} e - Событие drop
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {HTMLElement} container - Контейнер блоков поля
     */
    handleDrop(e, violation, fieldKey, container) {
        if (isFileDrag(e)) return;

        const payload = readDragPayload(e, this);
        // Чужое поле/нарушение — молча игнорируем (перенос между полями не поддержан).
        if (!isSameField(payload, violation, fieldKey)) return;

        e.preventDefault();
        e.stopPropagation();

        // Последний dragover мог не получить свой кадр (кнопку отпустили раньше
        // ближайшего repaint) — позиция вставки осталась бы от предыдущего
        // события, и блок лёг бы не туда, куда указывал курсор. Досчитываем
        // синхронно, после чего отложенный кадр не нужен: он дорисовал бы
        // индикатор уже в перерисованный контейнер. Снимка может не быть вовсе
        // (drop без единого dragover) — тогда считаем по самому drop'у.
        const pendingDragOver = this._pendingDragOver || {
            hoveredElement: e.target?.closest?.('.content-item-wrapper') || null,
            mouseY: e.clientY,
            container,
        };
        this._pendingDragOver = null;
        this._applyDragOverPosition(pendingDragOver);

        // Позиция вставки — из dragover (учитывает половину блока, зазор и
        // гистерезис). Без неё считать нечего: контейнер молча ничего не двигает.
        const toIndex = this.lastDragOverIndex;
        if (toIndex === null) return;

        // Index-based перестановка (#6): DOM больше НЕ сдвинут оптимистично,
        // порядок считаем из данных. Сам splice — в мутаторе (§5.10a), там же
        // read-only-guard, честный no-op и превью; отказ мутатора не коммитим.
        if (!this.moveBlocks(violation, fieldKey, payload.blockIds, toIndex)) return;

        // Коммит состоялся — handleDragEnd не должен перерисовывать повторно.
        this._dropCommitted = true;

        // Перерисовываем с обновленными индексами
        this.renderBlocks(violation, fieldKey, container);
    },

    /**
     * Окончание перетаскивания.
     * @param {Event} e - Событие dragend
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {HTMLElement} container - Контейнер блоков поля
     */
    handleDragEnd(e, violation, fieldKey, container) {
        e.target.classList.remove('dragging');

        // Снимаем разрешение на drag: следующее перетаскивание снова обязано
        // начаться с шапки (armBlockDrag).
        this.disarmBlockDrag(e.currentTarget || e.target);

        // Снимаем индикатор позиции.
        this.removeInsertIndicators(container);

        // Если drop не зафиксировал новый порядок (Esc/промах мимо зоны) —
        // восстанавливаем DOM из данных: фантома от прежнего оптимистичного
        // сдвига больше нет, но re-render идемпотентно гарантирует чистоту
        // (в т.ч. после внутреннего drop через контейнер файлов).
        if (!this._dropCommitted) {
            this.renderBlocks(violation, fieldKey, container);
        }

        // Сбрасываем состояние для следующего drag.
        this._dropCommitted = false;
        this.lastDragOverIndex = null;
        this._lastDragOverElement = null;
        this._pendingDragOver = null;
        this._dragPayload = null;
    }
});
