/**
 * Масштабирование листа предпросмотра под ширину панели (fit-to-width).
 *
 * Лист A4 имеет фиксированную ширину 210mm. Лист масштабируется через CSS
 * transform:scale так, чтобы ЗАПОЛНИТЬ ширину панели (может быть >100% на
 * широкой панели шага 1), сохраняя точные пропорции A4 (главная WYSIWYG-фича).
 *
 * Паттерн: sizer-обёртка занимает МАСШТАБИРОВАННЫЙ footprint (иначе transform,
 * будучи paint-only, оставил бы пустоту под масштабированным листом и сломал бы
 * вертикальную прокрутку). Пересчёт — на ResizeObserver панели + RAF-коалесинг.
 */

/**
 * Чистый расчёт масштаба: доля ширины панели к натуральной ширине листа.
 * По умолчанию лист заполняет ширину панели (масштаб может быть >1). Опциональный
 * maxScale ограничивает рост сверху. Безопасен к нулю/NaN.
 * @param {number} innerWidth Внутренняя (content-box) ширина панели, px.
 * @param {number} naturalWidth Натуральная ширина листа, px.
 * @param {number} [maxScale=Infinity] Верхний предел масштаба (необязательный кап).
 * @returns {number} Коэффициент масштаба (>0).
 */
export function computeFitScale(innerWidth, naturalWidth, maxScale = Infinity) {
    if (!naturalWidth || naturalWidth <= 0) return 1;
    if (!Number.isFinite(innerWidth) || innerWidth <= 0) return 1;
    return Math.min(innerWidth / naturalWidth, maxScale);
}

/**
 * Гейт переприменения: true, если новый расчёт эффективно совпадает с уже
 * применённым — натуральные размеры листа те же, а сдвиг масштабированной
 * ширины меньше полпикселя (субпиксельный дребезг целочисленного clientWidth
 * при дробном browser zoom). Изменение размеров листа (контент дорендерился,
 * картинка декодировалась) — всегда переприменение.
 * @param {{natW: number, natH: number, k: number}|null} applied Последний применённый расчёт.
 * @param {number} natW Натуральная ширина листа, px.
 * @param {number} natH Натуральная высота листа, px.
 * @param {number} k Новый коэффициент масштаба.
 * @returns {boolean}
 */
export function isNegligibleRefit(applied, natW, natH, k) {
    return !!applied
        && applied.natW === natW
        && applied.natH === natH
        && Math.abs(k - applied.k) * natW < 0.5;
}

export class PreviewFitScaler {
    constructor() {
        this._pane = null;
        this._sheet = null;
        this._applied = null;
        this._ro = null;
        this._rafScheduled = false;
        this._rafHandle = 0;
        this._apply = this._apply.bind(this);
        this._schedule = this._schedule.bind(this);
    }

    /**
     * Привязывает скейлер к панели-холсту. Идемпотентно: повторный attach к той
     * же панели не плодит observer'ы. Сразу выполняет первый расчёт.
     * @param {HTMLElement} pane Панель-холст (#preview или #previewMenuBody).
     */
    attach(pane) {
        if (!pane) return;
        if (this._pane === pane && this._ro) { this._schedule(); return; }
        this.detach();
        this._pane = pane;
        this._ro = new ResizeObserver(this._schedule);
        this._ro.observe(pane);
        this._schedule();
    }

    /** Принудительный пересчёт (после перерисовки контента — меняется высота). */
    refresh() { this._schedule(); }

    /**
     * Немедленный пересчёт в ТЕКУЩЕМ кадре, без ожидания RAF.
     *
     * Нужен сразу после пересборки листа: до применения масштаба sizer не имеет
     * размеров, а лист (position:absolute) выпадает из потока — панель схлопнута
     * в нулевую высоту, лист не отмасштабирован. Отложенный на кадр расчёт даёт
     * этому состоянию попасть в отрисовку: превью моргает пустотой, а замер
     * ширины в схлопнутом состоянии ещё и даёт промежуточный неверный масштаб.
     */
    applyNow() {
        if (this._rafScheduled) {
            cancelAnimationFrame(this._rafHandle);
            this._rafScheduled = false;
        }
        this._apply();
    }

    /** Отвязывает observer. */
    detach() {
        if (this._ro) { this._ro.disconnect(); this._ro = null; }
        if (this._rafScheduled) cancelAnimationFrame(this._rafHandle);
        this._pane = null;
        this._sheet = null;
        this._applied = null;
        this._rafScheduled = false;
    }

    /** @private Коалесинг пересчётов в один кадр. */
    _schedule() {
        if (this._rafScheduled) return;
        this._rafScheduled = true;
        this._rafHandle = requestAnimationFrame(this._apply);
    }

    /** @private Пересчёт и применение масштаба. */
    _apply() {
        this._rafScheduled = false;
        const pane = this._pane;
        // Пропускаем скрытую/несвёрстанную панель (clientWidth === 0): на шаге 2
        // #preview лежит в display:none-контейнере. Измерять её бессмысленно
        // (даст 0×0 footprint); при возврате на шаг 1 перерендер заново привяжет
        // и пересчитает масштаб уже на видимой панели.
        if (!pane || !pane.isConnected || pane.clientWidth === 0) return;

        const sheet = pane.querySelector('.preview-sheet');
        const sizer = pane.querySelector('.preview-sheet-sizer');
        const indicator = pane.querySelector('.preview-zoom-indicator');
        if (!sheet || !sizer) {
            if (indicator) indicator.style.display = 'none';
            return;
        }

        // Перерендер пересоздаёт лист — наблюдаем актуальный. Поздняя смена
        // ВЫСОТЫ контента (декодирование картинки, точечный патч блока) не
        // меняет бокс панели, и без наблюдения листа sizer оставался бы с
        // устаревшим footprint'ом (лишняя/обрезанная прокрутка).
        if (this._sheet !== sheet) {
            if (this._sheet && this._ro) this._ro.unobserve(this._sheet);
            if (this._ro) this._ro.observe(sheet);
            this._sheet = sheet;
            // Память о применённом расчёте относится к ПРЕЖНЕМУ листу. Перерендер
            // пересоздаёт sizer и лист с нуля, без inline-стилей: без сброса гейт
            // isNegligibleRefit счёл бы совпадающий расчёт лишним и оставил лист
            // немасштабированным, а панель — схлопнутой в нулевую высоту.
            this._applied = null;
        }

        // Натуральные размеры — layout-метрики offsetWidth/offsetHeight: они не
        // зависят ни от собственного transform листа, ни от transform-анимаций
        // предков (scaleIn модалки). Прежний замер getBoundingClientRect со
        // сбросом transform во время такой анимации давал искажённый масштаб,
        // который застревал после её конца (transform не дёргает ResizeObserver).
        const natW = sheet.offsetWidth;
        const natH = sheet.offsetHeight;

        const cs = getComputedStyle(pane);
        const padX = parseFloat(cs.paddingLeft || '0') + parseFloat(cs.paddingRight || '0');
        const innerW = pane.clientWidth - padX;

        const k = computeFitScale(innerW, natW);

        // Субпиксельный дребезг (целочисленный clientWidth при дробном browser
        // zoom) не переприменяем — гасит микропетли пересчёта.
        if (isNegligibleRefit(this._applied, natW, natH, k)) return;
        this._applied = { natW, natH, k };

        sheet.style.transform = `scale(${k})`;
        sizer.style.width = `${natW * k}px`;
        sizer.style.height = `${natH * k}px`;

        if (indicator) {
            indicator.style.display = '';
            indicator.textContent = `${Math.round(k * 100)}%`;
        }
    }
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
// Guard: модуль также импортируется в node:test, где window отсутствует.
if (typeof window !== 'undefined') {
    window.computeFitScale = computeFitScale;
    window.PreviewFitScaler = PreviewFitScaler;
}
