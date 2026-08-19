/**
 * Расширение TextBlockManager для работы с форматированием
 */
import { TextBlockManager } from './textblock-core.js';
import { getStructureLimits } from '../violation/violation-image-validator.js';

Object.assign(TextBlockManager.prototype, {
    /**
     * Применяет базовый размер шрифта к редактору из /acts/limits (единый
     * источник с превью и экспортом; дефолт — 12pt тела акта). Размер задаётся
     * в ПУНКТАХ: выбранное пользователем число — это кегль Word, экранную
     * читаемость даёт zoom поверхности (CSS). Выравнивание здесь НЕ задаётся:
     * оно живёт per-line в inline-HTML content (TB-1), дефолт по ширине —
     * CSS-правилом на .textblock-editor.
     * @param {HTMLElement} editor - DOM-элемент редактора
     */
    applyBaseFontSize(editor) {
        if (!editor) return;
        editor.style.fontSize = `${getStructureLimits().fontSizeDefault}pt`;
    },

    /**
     * Применяет текущее форматирование к ссылке или сноске
     * на основе окружающего текста
     */
    inheritFormattingToElement(element) {
        if (!element) return;

        const props = ['fontSize', 'fontWeight', 'fontStyle', 'textDecoration', 'color', 'backgroundColor'];

        // Собираем inline-стили предков: БЛИЖАЙШИЙ предок выигрывает (не
        // перезаписываем уже найденное, идём изнутри наружу). BUG-1: прежний
        // цикл без guard'а отдавал победу САМОМУ ВНЕШНЕМУ враппер-размеру.
        const styles = {};
        let parent = element.parentElement;
        while (parent && parent !== this.activeEditor) {
            for (const prop of props) {
                if (!styles[prop] && parent.style[prop]) {
                    styles[prop] = parent.style[prop];
                }
            }
            parent = parent.parentElement;
        }

        // Наследуем ТОЛЬКО недостающее — НЕ затираем собственное явное значение
        // маркера. BUG-1: безусловный Object.assign откатывал заданный
        // пользователем размер ссылки/сноски на размер внешнего враппера при
        // каждом возврате фокуса в блок (и закреплял откат в content на blur).
        for (const prop of props) {
            if (styles[prop] && !element.style[prop]) {
                element.style[prop] = styles[prop];
            }
        }

        // Также наследуем форматирование от соседних элементов
        this.inheritFromNeighbors(element);
    },

    /**
     * @private TB-2: непосредственный узел-донор форматирования для
     * inheritFromNeighbors (обход previousSibling). НЕ переиспользует
     * _caretHomeSibling (textblock-editor.js): та функция для каретко-навигации
     * умышленно прозрачна к span-якорю размера (U+200B из applyFontSize без
     * выделения) — якорь не должен блокировать Home/стрелки. Здесь наоборот:
     * якорь — самый явный сигнал «пользователь выставил размер тут» и обязан
     * быть донором, даже когда всё его содержимое — чистый zero-width.
     * Правило: span с font-size — донор НЕЗАВИСИМО от содержимого (проверяется
     * ДО zero-width-пропуска); голый zero-width БЕЗ font-size (caret-guard,
     * span без style) — прозрачен, обход идёт дальше; любой другой значимый
     * узел (текст, <br>, капсула, span без font-size) — стена.
     * @param {Node} element
     * @returns {Node|null}
     */
    _formatDonorSibling(element) {
        let n = element.previousSibling;
        while (n) {
            const isFontSizeSpan = n.nodeType === 1 && n.tagName === 'SPAN'
                && !this._isCapsule(n) && !!n.style.fontSize;
            if (isFontSizeSpan || !this._isZeroWidthNode(n)) return n;
            n = n.previousSibling;
        }
        return null;
    },

    /**
     * Наследует форматирование от соседних элементов (span'ов с форматированием)
     */
    inheritFromNeighbors(element) {
        if (!element) return;

        let nextNode = element.nextSibling;

        // TB-2: наследуем ТОЛЬКО от НЕПОСРЕДСТВЕННОГО донора (_formatDonorSibling).
        // Капсула физически тоже <span> — исключаем её явно: она не донор формата.
        const prevNode = this._formatDonorSibling(element);
        if (prevNode && prevNode.nodeType === 1 && prevNode.tagName === 'SPAN'
                && !this._isCapsule(prevNode) && prevNode.style.length > 0) {
            // Копируем ТОЛЬКО inline-стили соседа (element.style.*), а не
            // computed: computed резолвит унаследованные/дефолтные значения
            // (например fontWeight '400'), которые иначе жёстко прибились бы
            // к маркеру как inline и раздули разметку.
            const inline = prevNode.style;

            if (inline.fontSize && !element.style.fontSize) {
                element.style.fontSize = inline.fontSize;
            }
            if (inline.fontWeight && !element.style.fontWeight) {
                element.style.fontWeight = inline.fontWeight;
            }
            if (inline.fontStyle && !element.style.fontStyle) {
                element.style.fontStyle = inline.fontStyle;
            }
            if (inline.textDecoration && !element.style.textDecoration) {
                element.style.textDecoration = inline.textDecoration;
            }
        }
    },

    /**
     * Применяет форматирование после ввода текста
     * (когда пользователь печатает обычный текст перед/после ссылки)
     */
    applyFormattingToNewNodes(editor) {
        if (!editor) return;

        // Находим все узлы с форматированием (span, b, i, u, strike и т.д.)
        const formattedElements = editor.querySelectorAll('span[style], b, i, u, strike, font, div[style]');

        // Для каждого элемента с форматированием проверяем соседние ссылки
        formattedElements.forEach(element => {
            const links = element.querySelectorAll('.text-link');
            const footnotes = element.querySelectorAll('.text-footnote');

            [...links, ...footnotes].forEach(item => {
                this.inheritFormattingToElement(item);
            });
        });

        // Также проверяем глобальные ссылки и сноски
        const allLinks = editor.querySelectorAll('.text-link');
        const allFootnotes = editor.querySelectorAll('.text-footnote');

        [...allLinks, ...allFootnotes].forEach(item => {
            this.inheritFormattingToElement(item);
        });
    }
});
