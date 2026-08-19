/**
 * Рендерер текстовых блоков для предпросмотра
 *
 * Создает HTML-представление текстовых блоков с сохранением
 * форматирования и стилей.
 */
import { renderActContent } from '../../shared/sanitize.js';
import { getStructureLimits } from '../violation/violation-image-validator.js';

export class PreviewTextBlockRenderer {
    /**
     * Создает элемент текстового блока
     *
     * @param {Object} textBlock - Данные текстового блока
     * @returns {HTMLElement} Элемент текстового блока
     */
    static create(textBlock) {
        const container = this._createContainer();
        const content = this._createContent(textBlock);

        container.appendChild(content);
        return container;
    }

    /**
     * Создает контейнер текстового блока
     * @private
     */
    static _createContainer() {
        const container = document.createElement('div');
        container.className = 'preview-textblock';
        return container;
    }

    /**
     * Создает элемент содержимого с форматированием
     * @private
     */
    static _createContent(textBlock) {
        const content = document.createElement('div');
        content.className = 'preview-textblock-content';

        this._applyBaseFontSize(content);
        // textBlock.content — пользовательский HTML, см. C-XSS-1.
        // Профиль 'acts' — allowlist, синхронный с бэк-санитайзером (5.2.3).
        renderActContent(content, textBlock.content);

        return content;
    }

    /**
     * Применяет базовый размер шрифта текстблока из /acts/limits (единый
     * источник с редактором и экспортом; дефолт — 12pt тела акта, в ПУНКТАХ:
     * лист превью и так живёт в pt). Выравнивание и начертание живут в
     * inline-HTML content (per-line text-align — TB-1, теги <b>/<i>/<u> — B-1);
     * дефолт «по ширине» — CSS на .preview-textblock-content.
     * @private
     */
    static _applyBaseFontSize(element) {
        element.style.fontSize = `${getStructureLimits().fontSizeDefault}pt`;
    }
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.PreviewTextBlockRenderer = PreviewTextBlockRenderer;
