/**
 * Рендерер блоков чата
 *
 * Отвечает за отображение структурированных блоков сообщений:
 * текст с markdown, код с подсветкой, reasoning, plan, файлы, изображения, кнопки.
 * Поддерживает стриминг через createStreamingBlock().
 */
import { AppConfig } from '../app-config.js';
import { AuthManager } from '../auth.js';
import { ClientActionsRegistry } from './chat-client-actions.js';
import { EscapeStack } from '../escape-stack.js';
import { formatFileSize } from '../format-units.js';
import { SafeHTML, CHAT_MD_CONFIG } from '../sanitize.js';
import { marked } from '../../../vendor/marked/marked.esm.min.js';
import hljs from '../../../vendor/highlightjs/highlight.min.js';

// Конфигурация marked: GFM целиком, одиночные \n — переносы (LLM-текст).
// Переопределения: код подсвечивается hljs (вывод — спаны class="hljs-*",
// проходит DOMPurify с разрешённым class); чекбоксы task-list — символами,
// чтобы не разрешать <input> в санитайзере.
// ВАЖНО: use() конфигурирует ГЛОБАЛЬНЫЙ инстанс vendored-marked. Если
// понадобится второй контекст рендеринга (не-чат) — использовать
// new marked.Marked() со своими опциями, а не менять эти.
marked.use({
    gfm: true,
    breaks: true,
    renderer: {
        code({ text, lang }) {
            const language = (lang || '').trim().split(/\s+/)[0];
            let highlighted;
            let cls = 'hljs';
            try {
                if (language && hljs.getLanguage(language)) {
                    highlighted = hljs.highlight(text, { language }).value;
                    cls += ' language-' + language;
                } else {
                    highlighted = hljs.highlightAuto(text).value;
                }
            } catch {
                highlighted = SafeHTML.escapeHtml(text);
            }
            return '<pre><code class="' + cls + '">' + highlighted + '</code></pre>\n';
        },
        checkbox({ checked }) {
            return checked ? '☑ ' : '☐ ';
        },
    },
});

/**
 * Замыкание прогрессивного markdown-рендера для streaming-блока:
 * аккумулирует текст и перерисовывает targetEl с троттлингом.
 * finalize всегда рендерит финальное состояние — потерянных хвостов нет.
 *
 * @param {HTMLElement} targetEl — элемент, в который пишется HTML
 * @returns {{ appendText: function(string): void, finalize: function(): void }}
 */
function makeStreamingClosure(targetEl, onFinalize) {
    let accumulated = '';
    let lastRender = 0;
    // Re-parse — O(всего накопленного текста), поэтому интервал перерисовки
    // растёт вместе с ним: до ~5 КБ — 80мс (~12 раз/сек, глазу неотличимо),
    // дальше пропорционально длине с потолком 1000мс — иначе на длинных
    // reasoning каждый тик парсил бы десятки КБ. Визуально безопасно: чем
    // длиннее текст, тем незаметнее дискретность дорисовки, а finalize
    // всегда рендерит точное финальное состояние.
    const renderIntervalMs = () => Math.min(1000, Math.max(80, accumulated.length / 64));

    return {
        appendText(text) {
            accumulated += text;
            const now = performance.now();
            if (now - lastRender < renderIntervalMs()) return;
            lastRender = now;
            ChatRenderer._safeSetHtml(targetEl, ChatRenderer._markdownToHtml(accumulated));
        },
        finalize() {
            ChatRenderer._safeSetHtml(targetEl, ChatRenderer._markdownToHtml(accumulated));
            // Хук для cleanup (например, убрать loader-анимацию у reasoning).
            if (typeof onFinalize === 'function') {
                try { onFinalize(); }
                catch (e) { console.error('makeStreamingClosure onFinalize failed:', e); }
            }
        },
    };
}

export const ChatRenderer = {

    /**
     * Безопасная установка innerHTML — делегируется в SafeHTML.set,
     * см. static/js/shared/sanitize.js. Fallback при отсутствии DOMPurify
     * пишет textContent (НЕ raw HTML — закрывает регрессию I-DOM-FB).
     *
     * @param {HTMLElement} el — DOM-элемент, в который ставим html
     * @param {string} html — HTML-строка (после _markdownToHtml)
     * @private
     */
    _safeSetHtml(el, html) {
        SafeHTML.set(el, html, CHAT_MD_CONFIG);
        // Внешние ссылки — в новую вкладку без opener (постобработка контейнера,
        // а не глобальный DOMPurify-hook: хук задел бы другие зоны приложения).
        el.querySelectorAll('a[href]').forEach((a) => {
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener noreferrer');
        });
    },

    /**
     * Создаёт DOM-плейсхолдер с тремя анимированными точками.
     * Используется внутри bot-bubble как индикатор «бот думает».
     * Удаляется при первом блоке ответа через `removeTypingPlaceholder()`.
     *
     * @returns {HTMLElement}
     */
    createTypingPlaceholder() {
        const placeholder = document.createElement('div');
        placeholder.className = 'chat-typing-placeholder';
        for (let i = 0; i < 3; i++) {
            const dot = document.createElement('span');
            dot.className = 'chat-typing-dot';
            placeholder.appendChild(dot);
        }
        return placeholder;
    },

    /**
     * Удаляет typing-плейсхолдер из контейнера, если он там есть.
     * Идемпотентен — повторный вызов безопасен.
     *
     * @param {HTMLElement} container — контейнер bot-сообщения
     */
    removeTypingPlaceholder(container) {
        if (!container) return;
        const placeholder = container.querySelector(':scope > .chat-typing-placeholder');
        if (placeholder) placeholder.remove();
    },

    /**
     * Создаёт DOM-индикатор активного рассуждения: сетка 4×4 точек
     * без рамки, gray → blue, opacity 0.4 ↔ 1.0. Живёт весь стрим,
     * снимается в `makeStreamingClosure.finalize()`.
     *
     * @returns {HTMLElement} <span class="chat-reasoning-loader">
     */
    _createReasoningLoader() {
        const loader = document.createElement('span');
        loader.className = 'chat-reasoning-loader';
        loader.setAttribute('aria-hidden', 'true');
        for (let row = 0; row < 4; row++) {
            for (let col = 0; col < 4; col++) {
                const i = row * 4 + col;
                const dot = document.createElement('span');
                dot.className = 'chat-reasoning-loader-dot';
                dot.style.setProperty('--col', String(col));
                dot.style.setProperty('--row', String(row));
                // Псевдослучайная задержка, scatter в окне 1.5с
                const delay = ((i * 89) % 1500) / 1000;
                dot.style.animationDelay = delay.toFixed(2) + 's';
                loader.appendChild(dot);
            }
        }
        return loader;
    },

    /**
     * Добавляет typing-индикатор в конец контейнера, если его там ещё нет.
     * Используется при рендере streaming-assistant-сообщения из истории
     * (`msg.status === 'streaming'`).
     *
     * @param {HTMLElement} container — контейнер bot-сообщения
     */
    appendTypingIndicator(container) {
        if (!container) return;
        const existing = container.querySelector(':scope > .chat-typing-placeholder');
        if (existing) return;
        container.appendChild(this.createTypingPlaceholder());
    },

    /**
     * Алиас для `removeTypingPlaceholder` — публичный API для финализации
     * streaming-сообщения.
     *
     * @param {HTMLElement} container
     */
    removeTypingIndicator(container) {
        this.removeTypingPlaceholder(container);
    },

    /**
     * Последовательно проявляет блоки с декоративным эффектом печати.
     *
     * Для блоков text/reasoning — посимвольная анимация через createStreamingBlock.
     * Для остальных типов (code, file, image, plan, buttons, client_action, error) —
     * мгновенный рендер через renderBlock.
     *
     * При (prefers-reduced-motion: reduce) или отсутствии блоков — рендерит мгновенно.
     *
     * @param {HTMLElement} container — контейнер бот-сообщения
     * @param {Array<Object>} blocks — массив блоков из {content}
     * @param {Object} [options]
     * @param {number} [options.speed=8] — символов за кадр (16 мс)
     * @param {AbortSignal} [options.signal] — сигнал досрочного завершения
     * @returns {Promise<void>|undefined} — promise завершения анимации
     *          (мгновенные ветки возвращают undefined; await безопасен)
     */
    typeOutBlocks(container, blocks, options = {}) {
        const { speed = 8, signal } = options;

        if (!Array.isArray(blocks) || blocks.length === 0) return;

        // Respect prefers-reduced-motion
        if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) {
            this.renderBlocks(container, blocks, { execute: true });
            return;
        }

        // Запускаем асинхронную очередь
        return this._typeOutQueue(container, blocks, speed, signal);
    },

    /**
     * Асинхронная очередь анимации блоков.
     * @private
     */
    async _typeOutQueue(container, blocks, speed, signal) {
        for (const block of blocks) {
            if (signal && signal.aborted) {
                // Дорисовываем оставшиеся блоки мгновенно
                const idx = blocks.indexOf(block);
                const remaining = blocks.slice(idx);
                this.renderBlocks(container, remaining, { execute: true });
                return;
            }

            // typeOutSingleBlock сам дописывает остаток текущего блока при abort
            // (через _animateText), поэтому после него проверяем abort и
            // дорисовываем ТОЛЬКО хвост очереди (index + 1).
            await this.typeOutSingleBlock(container, block, { speed, signal });

            if (signal && signal.aborted) {
                const idx = blocks.indexOf(block);
                const remaining = blocks.slice(idx + 1);
                this.renderBlocks(container, remaining, { execute: true });
                return;
            }
        }
    },

    /**
     * Анимирует текст по speed символов каждые 16 мс.
     * Возвращает Promise, который резолвится по завершении или при abort.
     * @private
     */
    _animateText(sb, text, speed, signal) {
        return new Promise((resolve) => {
            let pos = 0;

            const step = () => {
                if (signal && signal.aborted) {
                    sb.appendText(text.slice(pos));
                    resolve();
                    return;
                }

                if (pos >= text.length) {
                    resolve();
                    return;
                }

                const chunk = text.slice(pos, pos + speed);
                sb.appendText(chunk);
                pos += speed;

                requestAnimationFrame(step);
            };

            requestAnimationFrame(step);
        });
    },

    /**
     * Допечатывает текст в существующий streaming-блок с анимацией и финализирует.
     * Используется инкрементальным рендером рассуждений агента (chat-messages.js).
     * При прерывании сигналом текст допечатывается мгновенно; finalize вызывается в любом случае.
     *
     * @param {{appendText: function, finalize: function}} sb — streaming-блок
     * @param {string} text — допечатываемый фрагмент
     * @param {Object} [options]
     * @param {number} [options.speed=8] — символов за кадр
     * @param {AbortSignal} [options.signal] — сигнал досрочного завершения
     */
    async appendTextAnimated(sb, text, { speed = 8, signal } = {}) {
        await this._animateText(sb, text, speed, signal);
        sb.finalize();
    },

    /**
     * Стримящийся ли тип блока: text/reasoning печатаются посимвольно и
     * допечатываются дельтами (инкрементальный рендер, посев при resume).
     * Единая точка истины для chat-renderer и chat-messages — новый
     * стримящийся тип добавляется только здесь.
     *
     * @param {string} type — block.type
     * @returns {boolean}
     */
    isStreamingBlockType(type) {
        return type === 'text' || type === 'reasoning';
    },

    /**
     * Печатает ОДИН блок: text/reasoning — посимвольно через streaming-блок,
     * прочие типы — мгновенный рендер. Вынесен из _typeOutQueue, чтобы
     * финальный рендер после инкрементального мог допечатывать выборочно.
     *
     * @param {HTMLElement} container — контейнер бот-сообщения
     * @param {Object} block — блок {type, ...data}
     * @param {Object} [options]
     * @param {number} [options.speed=8] — символов за кадр
     * @param {AbortSignal} [options.signal] — сигнал досрочного завершения
     */
    async typeOutSingleBlock(container, block, { speed = 8, signal } = {}) {
        const type = block && block.type;
        if (this.isStreamingBlockType(type)) {
            const text = block.content || '';
            if (!text) {
                const el = this.renderBlock(block, { execute: false });
                if (el) this.appendBlock(container, el);
                return;
            }
            const sb = this.createStreamingBlock(
                type,
                typeof block.block_id === 'string' ? block.block_id : undefined,
            );
            this.appendBlock(container, sb.element);
            await this._animateText(sb, text, speed, signal);
            sb.finalize();
        } else {
            const el = this.renderBlock(block, { execute: true });
            if (el) this.appendBlock(container, el);
        }
    },

    /**
     * Рендерит массив блоков в DOM-контейнер
     *
     * @param {HTMLElement} container — контейнер для отрисовки
     * @param {Array<Object>} blocks — массив блоков {type, ...data}
     * @param {Object} [opts] — опции рендера (например, opts.execute для client_action)
     */
    renderBlocks(container, blocks, opts) {
        if (!container || !Array.isArray(blocks)) return;

        for (const block of blocks) {
            const el = this.renderBlock(block, opts);
            if (el) this.appendBlock(container, el);
        }
    },

    /**
     * Добавляет DOM-элемент блока в контейнер.
     *
     * Reasoning-блоки группируются во внешний <details class="chat-reasoning-group">,
     * чтобы всю цепочку рассуждений можно было свернуть одним кликом.
     * Каждый непрерывный run reasoning-блоков образует одну группу;
     * как только появляется блок другого типа — группа финализируется,
     * и следующий reasoning создаёт новую группу.
     *
     * Используется и live-стримом, и историей.
     *
     * @param {HTMLElement} container
     * @param {HTMLElement} el
     */
    appendBlock(container, el) {
        if (!container || !el) return;

        // Идемпотентный merge по data-block-id: если блок с тем же id
        // уже есть в контейнере, заменяем его. Защищает от дублей при
        // повторном рендере того же ответа (например, после reload).
        if (el.dataset && el.dataset.blockId) {
            const existing = container.querySelector(
                `[data-block-id="${CSS.escape(el.dataset.blockId)}"]`,
            );
            if (existing) {
                existing.replaceWith(el);
                return;
            }
        }

        const isReasoning = el.classList
            && el.classList.contains('chat-block-reasoning');

        // Если в контейнере живёт typing-плейсхолдер (бот ещё «думает»),
        // удерживаем его ВНИЗУ bot-bubble — все вновь добавленные блоки
        // уходят ВЫШЕ него. Сам плейсхолдер не трогаем — его удаление
        // управляется из ChatMessages при получении готового ответа.
        const placeholder = container.querySelector(
            ':scope > .chat-typing-placeholder',
        );

        // Для логики reasoning-группы placeholder в конце — невидимый
        // «хвост»; реальным последним блоком считаем предыдущий элемент.
        const lastBlock = (placeholder && container.lastElementChild === placeholder)
            ? placeholder.previousElementSibling
            : container.lastElementChild;

        if (isReasoning) {
            // Ищем активную (не финализированную) группу среди потомков container'а.
            // Группа считается активной только если она — последний дочерний элемент
            // (placeholder не учитывается).
            const isActiveGroup = lastBlock
                && lastBlock.classList
                && lastBlock.classList.contains('chat-reasoning-group')
                && !lastBlock.dataset.finalized;

            if (isActiveGroup) {
                // Добавляем разделитель, если в группе уже есть reasoning-блоки
                const groupContent = lastBlock.querySelector('.chat-reasoning-group-content');
                if (groupContent.lastElementChild) {
                    const sep = document.createElement('hr');
                    sep.className = 'chat-reasoning-separator';
                    groupContent.appendChild(sep);
                }
                groupContent.appendChild(el);
            } else {
                // Создаём новую группу
                const group = document.createElement('details');
                group.className = 'chat-reasoning-group';
                group.open = true;

                const summary = document.createElement('summary');
                summary.textContent = 'Рассуждение агента';
                group.appendChild(summary);

                const groupContent = document.createElement('div');
                groupContent.className = 'chat-reasoning-group-content';
                groupContent.appendChild(el);
                group.appendChild(groupContent);

                container.appendChild(group);
            }
        } else {
            // Финализируем активную группу, чтобы следующий reasoning начал новую
            if (lastBlock
                && lastBlock.classList
                && lastBlock.classList.contains('chat-reasoning-group')
                && !lastBlock.dataset.finalized) {
                lastBlock.dataset.finalized = 'true';
            }

            container.appendChild(el);
        }

        // Если плейсхолдер остался — переносим его в конец, чтобы три точки
        // оказались под только что добавленным блоком (типичный кейс — поток
        // reasoning-чанков от внешнего агента).
        if (placeholder && container.lastElementChild !== placeholder) {
            container.appendChild(placeholder);
        }
    },

    /**
     * Рендерит один блок в DOM-элемент
     *
     * @param {Object} block — блок {type, ...data}
     * @param {Object} [opts] — опции рендера (например, opts.execute для client_action)
     * @returns {HTMLElement|null}
     */
    renderBlock(block, opts) {
        if (!block || !block.type) return null;
        const options = opts || {};

        let el;
        switch (block.type) {
            case 'text':
                el = this._renderText(block); break;
            case 'code':
                el = this._renderCode(block); break;
            case 'reasoning':
                el = this._renderReasoning(block); break;
            case 'plan':
                el = this._renderPlan(block); break;
            case 'file':
                el = this._renderFile(block); break;
            case 'image':
                el = this._renderImage(block); break;
            case 'buttons':
                el = this._renderButtons(block); break;
            case 'client_action':
                el = this._renderClientAction(block, options); break;
            case 'error':
                el = this._renderError(block); break;
            default:
                console.warn('ChatRenderer: неизвестный тип блока', block.type, block);
                el = this._renderUnknown(block);
        }

        // Прокидываем block_id в dataset для идемпотентного merge в `appendBlock`.
        // Перетирает только если у конкретного renderer'а ещё не выставлен
        // (reasoning делает это сам).
        if (el && typeof block.block_id === 'string' && block.block_id
            && !el.dataset.blockId) {
            el.dataset.blockId = block.block_id;
        }
        return el;
    },

    /**
     * Fallback-рендер для блоков неизвестного типа.
     *
     * История из БД могла прийти со старого бэка, у которого появились новые
     * типы блоков, ещё не поддержанные фронтом. Вместо `return null`
     * (блок молча пропадает) показываем плашку «обновите страницу» и
     * полный payload в `<pre>` для отладки.
     *
     * @param {Object} block — блок с неизвестным `type`
     * @returns {HTMLElement}
     * @private
     */
    _renderUnknown(block) {
        const wrapper = document.createElement('div');
        wrapper.className = 'chat-block chat-block-unknown';

        const notice = document.createElement('div');
        notice.className = 'chat-block-unknown-notice';
        notice.textContent = `⚠ Блок неизвестного типа: ${block && block.type}. Обновите страницу.`;
        wrapper.appendChild(notice);

        const pre = document.createElement('pre');
        pre.className = 'chat-block-unknown-payload';
        try {
            pre.textContent = JSON.stringify(block, null, 2);
        } catch {
            pre.textContent = String(block);
        }
        wrapper.appendChild(pre);

        return wrapper;
    },

    /**
     * Создаёт блок для посимвольного проявления (декоративный эффект печати)
     *
     * Для reasoning-блока создаёт НОВЫЙ <details>, свёрнутый по умолчанию.
     *
     * @param {string} blockType — тип блока ('text' или 'reasoning')
     * @param {string} [blockId] — идентификатор блока (для reasoning тегируется в data-block-id)
     * @returns {{ element: HTMLElement, appendText: function(string): void, finalize: function(): void }}
     */
    createStreamingBlock(blockType, blockId) {
        if (blockType === 'reasoning') {
            const details = document.createElement('details');
            details.className = 'chat-block chat-block-reasoning';
            // Свёрнут по умолчанию; loader показывает активность стрима.
            details.open = false;
            if (typeof blockId === 'string' && blockId) {
                details.dataset.blockId = blockId;
            }

            if (this._getReasoningDisplayMode() === 'hidden') {
                details.style.display = 'none';
            }

            const summary = document.createElement('summary');
            const loader = this._createReasoningLoader();
            const summaryText = document.createElement('span');
            summaryText.className = 'chat-block-reasoning-summary-text';
            summaryText.textContent = 'Рассуждение';
            summary.appendChild(loader);
            summary.appendChild(summaryText);
            details.appendChild(summary);

            const content = document.createElement('div');
            content.className = 'chat-block-reasoning-content chat-md';
            details.appendChild(content);

            // Loader снимается в finalize() — когда ассистент переходит
            // к генерации итогового text-блока.
            return {
                element: details,
                ...makeStreamingClosure(content, () => {
                    if (loader.parentNode) loader.remove();
                }),
            };
        }

        // По умолчанию — текстовый блок
        const div = document.createElement('div');
        div.className = 'chat-block chat-block-text chat-md';

        return { element: div, ...makeStreamingClosure(div) };
    },

    /**
     * Обновляет существующий блок плана или создаёт новый
     *
     * @param {HTMLElement} container — контейнер, в котором ищем/создаём plan
     * @param {Array<{title: string, status: string}>} steps — шаги плана
     */
    updatePlan(container, steps) {
        let planEl = container.querySelector('.chat-block-plan');

        if (!planEl) {
            planEl = this._renderPlan({ steps });
            container.appendChild(planEl);
            return;
        }

        // Обновляем содержимое существующего блока
        const list = planEl.querySelector('.chat-block-plan-steps');
        if (list) {
            list.innerHTML = '';
            for (const step of steps) {
                const li = document.createElement('li');
                li.className = `chat-block-plan-step chat-block-plan-step--${step.status || 'pending'}`;

                const icon = document.createElement('span');
                icon.className = 'chat-block-plan-step-icon';
                icon.textContent = this._getPlanStatusIcon(step.status);

                const title = document.createElement('span');
                title.textContent = step.title || '';

                li.appendChild(icon);
                li.appendChild(title);
                list.appendChild(li);
            }
        }
    },

    // ========================================================
    //  Рендереры отдельных типов блоков
    // ========================================================

    /**
     * Текстовый блок с базовым markdown
     * @private
     */
    _renderText(block) {
        const div = document.createElement('div');
        div.className = 'chat-block chat-block-text chat-md';
        this._safeSetHtml(div, this._markdownToHtml(block.content || ''));
        return div;
    },

    /**
     * Блок кода с заголовком (язык + кнопка копирования)
     * @private
     */
    _renderCode(block) {
        const wrapper = document.createElement('div');
        wrapper.className = 'chat-block chat-block-code';

        // Заголовок: язык + копировать
        const header = document.createElement('div');
        header.className = 'chat-block-code-header';

        const lang = document.createElement('span');
        lang.className = 'chat-block-code-lang';
        lang.textContent = block.language || 'code';

        const copyBtn = document.createElement('button');
        copyBtn.className = 'chat-block-code-copy';
        copyBtn.textContent = 'Копировать';
        copyBtn.addEventListener('click', () => this._copyCode(copyBtn));

        header.appendChild(lang);
        header.appendChild(copyBtn);

        // Код
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = block.content || '';
        pre.appendChild(code);

        // Подсветка hljs: вход уже экранирован (textContent), highlightElement
        // безопасно заменит содержимое на размеченные спаны.
        try {
            if (block.language && hljs.getLanguage(block.language)) {
                code.classList.add('language-' + block.language);
            }
            hljs.highlightElement(code);
        } catch { /* подсветка — некритичное украшение */ }

        wrapper.appendChild(header);
        wrapper.appendChild(pre);

        return wrapper;
    },

    /**
     * Блок рассуждений (сворачиваемый details/summary).
     * По умолчанию раскрыт; пользователь сворачивает руками.
     * @private
     */
    _renderReasoning(block) {
        const details = document.createElement('details');
        details.className = 'chat-block chat-block-reasoning';
        // Свернут по умолчанию (и для стрима, и для истории) — пользователь
        // кликает чтобы раскрыть и посмотреть. Для стрима loader появляется
        // на время печати и исчезает в finalize.
        details.open = false;
        if (typeof block.block_id === 'string' && block.block_id) {
            details.dataset.blockId = block.block_id;
        }

        if (this._getReasoningDisplayMode() === 'hidden') {
            details.style.display = 'none';
        }

        const summary = document.createElement('summary');
        summary.textContent = 'Рассуждение';
        details.appendChild(summary);

        const content = document.createElement('div');
        content.className = 'chat-block-reasoning-content chat-md';
        this._safeSetHtml(content, this._markdownToHtml(block.content || ''));
        details.appendChild(content);

        return details;
    },

    /**
     * Блок плана с шагами и статусами
     * @private
     */
    _renderPlan(block) {
        const div = document.createElement('div');
        div.className = 'chat-block chat-block-plan';

        if (block.title) {
            const title = document.createElement('div');
            title.className = 'chat-block-plan-title';
            title.textContent = block.title;
            div.appendChild(title);
        }

        const list = document.createElement('ul');
        list.className = 'chat-block-plan-steps';

        const steps = block.steps || [];
        for (const step of steps) {
            const li = document.createElement('li');
            li.className = `chat-block-plan-step chat-block-plan-step--${step.status || 'pending'}`;

            const icon = document.createElement('span');
            icon.className = 'chat-block-plan-step-icon';
            icon.textContent = this._getPlanStatusIcon(step.status);

            const title = document.createElement('span');
            title.textContent = step.title || '';

            li.appendChild(icon);
            li.appendChild(title);
            list.appendChild(li);
        }

        div.appendChild(list);
        return div;
    },

/**
     * Блок файла — карточка с иконкой, именем, размером и кнопками действий
     * @private
     */
    _renderFile(block) {
        const div = document.createElement('div');
        div.className = 'chat-block chat-block-file';

        // Имя: backend-имя → дефолт по mime → 'Файл'. Backend теперь всегда
        // присылает filename для материализованных файлов (UUID из chat_files);
        // фолбэк по mime остаётся на случай data-URL от бота без имени.
        // Резервный канал: если и по mime ничего не нашлось, а бот прислал
        // data-URL с ``data:application/x-zip-compressed;base64,...`` —
        // пробуем извлечь подстроку mime из file_id (между ``data:`` и ``;``)
        // и смаппить через _defaultFilenameForMime. Это закрывает кейс «у zip
        // нету» при application/octet-stream или ``application/x-*-compressed``,
        // для которых нет готового расширения в file_id.
        let baseName = block.filename || block.name;
        if (!baseName) {
            const fallback = this._defaultFilenameForMime(block.mime_type);
            if (fallback) {
                baseName = fallback;
            } else if (typeof block.file_id === 'string' && block.file_id.startsWith('data:')) {
                const headEnd = block.file_id.indexOf(';');
                if (headEnd > 5) {
                    const dataMime = block.file_id.slice(5, headEnd);
                    const fromData = this._defaultFilenameForMime(dataMime);
                    if (fromData) baseName = fromData;
                }
            }
        }
        const displayName = baseName || 'Файл';

        const icon = document.createElement('span');
        icon.className = 'chat-block-file-icon';
        // Иконка по расширению: PNG/PDF/DOCX/XLSX/etc — уникальные SVG,
        // неизвестные — нейтральный листочек (как раньше).
        const ext = this._extractExt(baseName);
        icon.classList.add('chat-block-file-icon--' + this._iconClassForExt(ext));
        icon.innerHTML = this._getFileIconSvg(ext);

        const nameEl = document.createElement('span');
        nameEl.className = 'chat-block-file-name';
        nameEl.textContent = displayName;

        if (block.file_id) {
            nameEl.classList.add('chat-block-file-name--clickable');
            nameEl.addEventListener('click', () => ChatRenderer._openFileViewer(block));
        }

        const size = document.createElement('span');
        size.className = 'chat-block-file-size';
        size.textContent = this._formatSize(block.file_size || block.size || 0);

        div.appendChild(icon);
        div.appendChild(nameEl);
        div.appendChild(size);

        // Кнопки действий — только при наличии file_id
        if (block.file_id) {
            const actions = document.createElement('div');
            actions.className = 'chat-block-file-actions';

            // Предпросмотр
            const previewBtn = document.createElement('button');
            previewBtn.className = 'chat-block-file-btn';
            previewBtn.title = 'Предпросмотр';
            previewBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/></svg>';
            previewBtn.addEventListener('click', () => ChatRenderer._openFileViewer(block));

            // Скачать
            const downloadBtn = document.createElement('a');
            downloadBtn.className = 'chat-block-file-btn';
            // Для data-URL используем сам data-URL (валидный href для <a download>);
            // для UUID-загруженных файлов — backend-эндпоинт.
            downloadBtn.href = this._resolveFileUrl(block.file_id).url;
            downloadBtn.download = displayName;
            downloadBtn.title = 'Скачать';
            downloadBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

            actions.appendChild(previewBtn);
            actions.appendChild(downloadBtn);
            div.appendChild(actions);
        }

        return div;
    },

    /**
     * Блок изображения с ленивой загрузкой и предпросмотром по клику.
     *
     * ``?inline=true`` (Content-Disposition: inline) добавляется только к
     * backend-адресу (UUID из chat_files) — та же логика, что в
     * ``_openFileViewer``. Для data-URL и http(s)-ссылки агента (passthrough,
     * см. ``_resolveFileUrl``) query добавлять нельзя: для data-URL это часть
     * base64-payload'а, для внешней ссылки — риск сломать её (например,
     * подписанный URL).
     * @private
     */
    _renderImage(block) {
        const div = document.createElement('div');
        div.className = 'chat-block chat-block-image';

        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = block.alt || 'Изображение';

        let imgUrl = block.url || '';
        if (!imgUrl && block.file_id) {
            const resolved = this._resolveFileUrl(block.file_id);
            const isPassthrough = typeof block.file_id === 'string'
                && (block.file_id.startsWith('http://') || block.file_id.startsWith('https://'));
            imgUrl = (resolved.isDataUrl || isPassthrough)
                ? resolved.url
                : resolved.url + (resolved.url.includes('?') ? '&' : '?') + 'inline=true';
        }

        img.src = imgUrl;

        if (block.file_id) {
            img.style.cursor = 'pointer';
            img.addEventListener('click', () => ChatRenderer._openFileViewer({
                ...block,
                mime_type: block.mime_type || 'image/png',
            }));
        }

        div.appendChild(img);

        return div;
    },

    /**
     * Блок кнопок: каждая кнопка — клиентское действие через
     * ClientActionsRegistry. Никаких сообщений в чат не отправляется,
     * никаких HTTP-запросов на сервер не делается.
     *
     * После клика вся группа кнопок заменяется на статический бейдж
     * "Выбрано: <label>", чтобы пользователь не мог нажать повторно
     * и видел подтверждение выбора.
     *
     * @private
     */
    _renderButtons(block) {
        const wrapper = document.createElement('div');
        wrapper.className = 'chat-block chat-block-buttons';

        const buttons = Array.isArray(block.buttons) ? block.buttons : [];
        for (const btn of buttons) {
            const button = document.createElement('button');
            button.className = 'chat-btn';
            button.type = 'button';
            button.textContent = btn.label || btn.action_id || '';

            button.addEventListener('click', () => {
                this._handleButtonClick(wrapper, btn);
            });

            wrapper.appendChild(button);
        }

        return wrapper;
    },

    /**
     * Обработчик клика по кнопке группы.
     * Исполняет client-action через реестр и заменяет группу на бейдж.
     *
     * @param {HTMLElement} wrapper — DOM-элемент группы кнопок
     * @param {Object} btn — описание кнопки {action_id, label, params}
     * @private
     */
    _handleButtonClick(wrapper, btn) {
        const actionId = btn.action_id;
        const label = btn.label || actionId || '';
        const registry = window.ClientActionsRegistry;

        const isRegistered = !!actionId
            && !!registry
            && typeof registry.isRegistered === 'function'
            && registry.isRegistered(actionId);

        if (!isRegistered) {
            const errDiv = document.createElement('div');
            errDiv.className = 'chat-block chat-error';
            errDiv.textContent = `Действие "${actionId || '(без id)'}" не поддерживается`;
            wrapper.replaceWith(errDiv);
            return;
        }

        try {
            registry.execute(actionId, btn.params || {});
        } catch (err) {
            console.error('ClientActionsRegistry: ошибка исполнения кнопки', err);
            const errDiv = document.createElement('div');
            errDiv.className = 'chat-block chat-error';
            errDiv.textContent = `Ошибка выполнения действия "${actionId}": ${(err && err.message) || err}`;
            wrapper.replaceWith(errDiv);
            return;
        }

        const selected = document.createElement('div');
        selected.className = 'chat-block chat-button-selected';
        selected.textContent = `Выбрано: ${label}`;
        wrapper.replaceWith(selected);
    },

    /**
     * Рендерит блок client_action: показывает label-чип в чате.
     * Выполняет команду через ClientActionsRegistry только если opts.execute=true
     * (по умолчанию false — чтобы при загрузке истории команды не реэкзекьютились).
     *
     * @param {Object} block — {action, params, label}
     * @param {Object} [opts] — {execute: boolean}
     * @returns {HTMLElement}
     */
    _renderClientAction(block, opts) {
        const el = document.createElement('div');
        el.className = 'chat-block chat-block-client-action';
        el.textContent = block.label || 'Выполняю команду…';

        const shouldExecute = !!(opts && opts.execute);
        if (shouldExecute) {
            const registry = window.ClientActionsRegistry;
            if (!registry) {
                console.warn('ChatRenderer: ClientActionsRegistry не подключён;'
                    + ' проверь подключение chat-client-actions.js');
            } else if (typeof registry.executeBlock === 'function') {
                // Идемпотентный путь: registry сам сверится с sessionStorage
                // по block.block_id и не выполнит команду повторно.
                try {
                    registry.executeBlock(block);
                } catch (err) {
                    console.error('ChatRenderer: ошибка исполнения client_action:', err);
                }
            } else if (typeof registry.execute === 'function') {
                // Совместимость со старыми сборками реестра без executeBlock.
                try {
                    registry.execute(block.action, block.params);
                } catch (err) {
                    console.error('ChatRenderer: ошибка исполнения client_action:', err);
                }
            }
        }

        return el;
    },

    /**
     * Блок ошибки — сообщение об ошибке от внешнего агента или внутреннее.
     *
     * @param {Object} block — { type: 'error', message, code? }
     * @returns {HTMLElement}
     * @private
     */
    _renderError(block) {
        const el = document.createElement('div');
        el.className = 'chat-block chat-block-error';
        el.textContent = block.message || 'Произошла ошибка';
        if (block.code) {
            el.dataset.code = block.code;
        }
        return el;
    },

    // ========================================================
    //  Хелперы
    // ========================================================

    /**
     * Распознаёт data-URL в ``file_id`` и возвращает подходящий URL.
     *
     * Внешний бот (nanobot / nanobot-ai) может передавать вложения в шину
     * ассистент-канала не как UUID загруженного файла, а как data-URL
     * (``data:<mime>;base64,<...>``) — это формат, который ``message`` tool
     * возвращает напрямую. data-URL валиден для нативного использования в
     * ``<a href>`` / ``<img src>`` / ``<iframe src>`` и не требует похода на
     * сервер; бэкенд-эндпоинт ``/api/v1/chat/files/<id>`` ищет файл в таблице
     * ``t_db_oarb_audit_act_chat_files`` по UUID и для data-URL возвращает 404.
     *
     * Возвращает ``{ url, isDataUrl }``: для data-URL — сам data-URL (как
     * есть, без каких-либо query-параметров), для UUID — backend-эндпоинт.
     *
     * @param {string} fileId — ``file_id`` блока чата
     * @returns {{ url: string, isDataUrl: boolean }}
     * @private
     */
    _resolveFileUrl(fileId) {
        if (typeof fileId === 'string' && fileId.startsWith('data:')) {
            return { url: fileId, isDataUrl: true };
        }
        if (typeof fileId === 'string' && (fileId.startsWith('http://') || fileId.startsWith('https://'))) {
            // Ссылка от агента (NanoBot кладёт http(s)-URL в file_id как есть) —
            // отдаём напрямую, backend-эндпоинт для неё вернул бы 404.
            return { url: fileId, isDataUrl: false };
        }
        const url = (typeof AppConfig === 'undefined')
            ? `/api/v1/chat/files/${fileId}`
            : AppConfig.api.getUrl(AppConfig.chatEndpoints.file(fileId));
        return { url, isDataUrl: false };
    },

    /**
     * Декодирует text/plain data-URL в строку.
     *
     * Используется в просмотрщике для текстовых файлов вместо ``fetch()``,
     * который для ``data:``-URL работает только без query-параметров и в любом
     * случае лишний (данные уже в браузере).
     *
     * @param {string} dataUrl — ``data:<mime>;base64,<payload>`` или ``data:,...``
     * @returns {string|null} — декодированный текст или ``null`` для не-text / битых
     * @private
     */
    _decodeTextDataUrl(dataUrl) {
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
            return null;
        }
        const commaIdx = dataUrl.indexOf(',');
        if (commaIdx < 0) {
            return null;
        }
        const head = dataUrl.slice(5, commaIdx); // после "data:"
        const payload = dataUrl.slice(commaIdx + 1);
        const isBase64 = /;\s*base64\s*$/i.test(head) || head.endsWith(';base64');
        try {
            if (isBase64) {
                // atob() корректно декодирует стандартный base64; русский текст в
                // UTF-8 → Uint8Array → TextDecoder (atob трактует байты как latin1).
                const binary = atob(payload);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) {
                    bytes[i] = binary.charCodeAt(i);
                }
                return new TextDecoder('utf-8').decode(bytes);
            }
            return decodeURIComponent(payload);
        } catch (err) {
            console.warn('ChatRenderer: не удалось декодировать data-URL', err);
            return null;
        }
    },

    /**
     *  Возвращает расширение файла (lowercase, с ведущей точкой) или пустую строку.
     *
     *  @param {string} name — имя файла (или пустое)
     *  @returns {string}
     *  @private
     */
    _extractExt(name) {
        if (!name) return '';
        const m = String(name).toLowerCase().match(/\.([a-z0-9]{1,5})$/);
        return m ? '.' + m[1] : '';
    },

    /**
     *  Генерирует имя файла по умолчанию на основе mime-типа.
     *
     *  Используется когда ни ``block.filename``/``block.name``, ни подсказка из
     *  text-блока не дали имени (типично для data-URL бот-генерации без
     *  человекочитаемого перечисления).
     *
     *  Покрывает ВСЕ варианты mime для распространённых форматов, которые бот
     *  может прислать в data-URL. Несколько вариантов на один тип:
     *  - ``application/zip`` (Microsoft) + ``application/x-zip-compressed`` (IANA) — обе.
     *  - ``image/jpeg`` + ``image/jpg`` — обе.
     *  Это нужно потому, что ``map[mime.toLowerCase()]`` иначе возвращает '' для
     *  неизвестного варианта, и fallback на "Файл" — пользователь не увидит
     *  расширения. Бот присылал ``application/x-zip-compressed`` → displayName
     *  был просто "Файл" (баг, который привёл к жалобе "у zip нету").
     *
     *  @param {string} mime — mime-тип
     *  @returns {string} — имя вида ``file.<ext>`` или пустая строка
     *  @private
     */
    _defaultFilenameForMime(mime) {
        if (!mime) return '';
        const m = mime.toLowerCase();
        const map = {
            // Текстовые
            'text/plain': 'file.txt',
            'text/markdown': 'file.md',
            'text/html': 'file.html',
            'text/css': 'file.css',
            'text/csv': 'file.csv',
            'text/xml': 'file.xml',
            // Данные / структуры
            'application/json': 'file.json',
            'application/xml': 'file.xml',
            'application/yaml': 'file.yaml',
            'application/x-yaml': 'file.yaml',
            // Документы Microsoft
            'application/pdf': 'file.pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'file.docx',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'file.xlsx',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'file.pptx',
            'application/vnd.ms-excel': 'file.xls',
            'application/vnd.ms-powerpoint': 'file.ppt',
            'application/msword': 'file.doc',
            // OpenDocument
            'application/vnd.oasis.opendocument.text': 'file.odt',
            'application/vnd.oasis.opendocument.spreadsheet': 'file.ods',
            'application/vnd.oasis.opendocument.presentation': 'file.odp',
            // Архивы — оба варианта mime (IANA + Microsoft)
            'application/zip': 'file.zip',
            'application/x-zip-compressed': 'file.zip',
            'application/x-7z-compressed': 'file.7z',
            'application/x-rar-compressed': 'file.rar',
            'application/vnd.rar': 'file.rar',
            'application/x-tar': 'file.tar',
            'application/tar': 'file.tar',
            'application/gzip': 'file.gz',
            'application/x-gzip': 'file.gz',
            'application/x-bzip2': 'file.bz2',
            'application/x-bzip': 'file.bz2',
            // Изображения
            'image/png': 'file.png',
            'image/jpeg': 'file.jpg',
            'image/jpg': 'file.jpg',
            'image/gif': 'file.gif',
            'image/svg+xml': 'file.svg',
            'image/webp': 'file.webp',
            'image/bmp': 'file.bmp',
            'image/x-icon': 'file.ico',
            'image/heic': 'file.heic',
        };
        if (map[m]) return map[m];
        // Generic fallback для подсемейств
        if (m.startsWith('image/')) return 'file.png';
        if (m.startsWith('text/')) return 'file.txt';
        if (m.startsWith('audio/')) return 'file.mp3';
        if (m.startsWith('video/')) return 'file.mp4';
        return '';
    },

    /**
     *  Класс иконки по расширению — для возможной стилизации CSS (цвет, фон).
     *  Все варианты приведены к lowercase с ведущей точкой.
     *
     *  @param {string} ext — расширение вида ``.pdf`` или пустая строка
     *  @returns {string} — slug для CSS-класса (``pdf``, ``docx``, ``unknown`` и пр.)
     *  @private
     */
    _iconClassForExt(ext) {
        if (!ext) return 'unknown';
        return ext.replace(/^\./, '').replace(/[^a-z0-9]/g, '') || 'unknown';
    },

    /**
     * Базовый URL каталога иконок. Каждая иконка — отдельный .svg
     * (см. ``static/icons/chat/<name>-<size>.svg``): редактируется
     * и перерисовывается без рестарта, hard refresh достаточно.
     * @private
     */
    _ICONS_BASE_URL: '/static/icons/chat/',

    /**
     * Логическое имя иконки → имя файла .svg.
     * @private
     */
    _ICON_URLS: {
        'file-generic-24':      'file-generic-24.svg',
        'file-image-24':        'file-image-24.svg',
        'file-code-24':         'file-code-24.svg',
        // Индивидуальные иконки с текстовым ярлыком формата внутри:
        'file-docx-24':         'file-docx-24.svg',
        'file-xlsx-24':         'file-xlsx-24.svg',
        'file-pptx-24':         'file-pptx-24.svg',
        'file-md-24':           'file-md-24.svg',
        'file-txt-24':          'file-txt-24.svg',
        'file-pdf-24':          'file-pdf-24.svg',
        // Индивидуальные тематические иконки (узкий формат):
        'csv':                  'csv.svg',
        'ipynb':                'ipynb.svg',
        'py':                   'py.svg',
        'zip':                  'zip.svg',
    },

    /**
     * Расширение → логическое имя иконки.
     *
     * Форматы с ярлыком (pdf/docx/xlsx/pptx/md/txt) получают индивидуальные иконки,
     * цвета определяются CSS-классом ``chat-block-file-icon--<ext>``.
     * Старый формат ``.doc`` и редкие (json/xml/yaml) идут в общую группу
     * ``generic`` — отдельные иконки под них не нужны, чтобы не раздувать набор.
     *
     * Legacy Excel (``xls``) и legacy PowerPoint (``ppt``) временно
     * идут на ``csv.svg``: штатные ``file-spreadsheet-24.svg`` и
     * ``file-presentation-24.svg`` визуально корявые, исключены из
     * ``_ICON_URLS`` и удалены с диска. Возврат на индивидуальные
     * иконки под эти форматы — когда появятся нормальные SVG.
     *
     * Все архивы (``.zip``/``.rar``/``.7z``/``.gz``/``.tar``) идут на
     * ``zip.svg`` (WinRAR-стиль: стопка книг с ремнём). Штатная
     * ``file-archive-24.svg`` признана визуально корявой, исключена из
     * ``_ICON_URLS`` и удалена с диска. ``zip.svg`` рисуется
     * фирменными цветами и ``currentColor`` игнорирует — аналогично
     * ``py.svg``.
     *
     * Тематические иконки для узких форматов (``csv``/``ipynb``/``py``/``zip``):
     * ключ без суффикса ``-24``, потому что иконка одна в своём роде и
     * размер ни о чём не говорит. ``py.svg`` и ``zip.svg`` используют
     * фирменные цвета и игнорируют CSS-цвет — узнаваемость логотипа
     * важнее, чем общая палитра карточки.
     *
     * @private
     */
    _ICON_FORM: {
        '.pdf':  'file-pdf-24',
        // Документы Microsoft: новые форматы — индивидуально,
        // старые — общая универсальная группа.
        '.docx': 'file-docx-24',
        '.doc':  'file-generic-24',
        // Таблицы: xlsx — индивидуально, xls — на csv.svg
        // (file-spreadsheet-24.svg визуально корявая и удалена, csv.svg
        // временно идёт и на .xls, пока не подобрана нормальная иконка
        // для legacy-Excel).
        '.xlsx': 'file-xlsx-24',
        '.xls':  'csv',
        '.csv':  'csv',
        // Презентации: pptx — индивидуально, ppt — табличная csv.svg
        // (file-presentation-24.svg визуально корявая и удалена, csv.svg
        // временно идёт и на .ppt, пока не подобрана нормальная иконка
        // для legacy-PowerPoint).
        '.pptx': 'file-pptx-24',
        '.ppt':  'csv',
        // Текстовые / документация: каждый со своим ярлыком.
        '.md':   'file-md-24',
        '.txt':  'file-txt-24',
        '.log':  'file-generic-24',
        '.json': 'file-generic-24',
        '.xml':  'file-generic-24',
        '.yaml': 'file-generic-24',
        '.yml':  'file-generic-24',
        // Изображения — единая file-image-24.svg.
        '.png':  'file-image-24',
        '.jpg':  'file-image-24',
        '.jpeg': 'file-image-24',
        '.gif':  'file-image-24',
        '.bmp':  'file-image-24',
        '.webp': 'file-image-24',
        '.svg':  'file-image-24',
        // Код: общая code-иконка для «просто кода» (sql/js/ts),
        // ipynb и py — свои тематические (логотип Python, ярлык «ipynb»).
        '.sql':  'file-code-24',
        '.ipynb':'ipynb',
        '.py':   'py',
        '.js':   'file-code-24',
        '.ts':   'file-code-24',
        // Архивы — все форматы на zip.svg (WinRAR-стиль).
        '.zip':  'zip',
        '.rar':  'zip',
        '.7z':   'zip',
        '.gz':   'zip',
        '.tar':  'zip',
    },

    /**
     * Кеш SVG-строк. ``null`` = fetch не успел или упал.
     * @private
     */
    _ICONS_CACHE: {},

    /**
     * Параллельно fetch'ит все .svg из ``_ICON_URLS`` в кеш.
     * Идемпотентен: повторный вызов не делает fetch если кеш заполнен.
     * @returns {Promise<void>}
     */
    async _loadIcons() {
        const base = this._ICONS_BASE_URL;
        const tasks = Object.entries(this._ICON_URLS).map(async ([key, filename]) => {
            if (this._ICONS_CACHE[key] != null) return;
            try {
                const r = await fetch(base + filename, { credentials: 'same-origin' });
                if (!r.ok) throw new Error('HTTP ' + r.status);
                this._ICONS_CACHE[key] = await r.text();
            } catch (e) {
                console.error('[ChatRenderer] failed to load icon', filename, e);
                this._ICONS_CACHE[key] = null;
            }
        });
        await Promise.all(tasks);
    },

    /**
     * Возвращает SVG-разметку иконки для расширения файла.
     *
     * Три вида иконок по принципу выбора:
     *   • офисные и текстовые форматы (docx, xlsx, pptx, md, txt, pdf) —
     *     своя иконка с коротким текстовым ярлыком внутри (формат видно
     *     даже в мелком масштабе);
     *   • общие по форме (doc, картинки, sql/js/ts) — иконки из набора
     *     Heroicons, цвет берётся из CSS-класса ``chat-block-file-icon--<ext>``;
     *   • тематические логотипы (csv/xls, ipynb, py, zip и другие архивы) —
     *     иконка-логотип для конкретного формата; ``py.svg`` и ``zip.svg``
     *     рисуются фирменными цветами и CSS-класс на них не влияет.
     *
     * У большинства иконок цвет приходит из ``chat-block-file-icon--<ext>``,
     * внутри SVG — только обводка через ``currentColor``. Имя файла в чате
     * уже выводится текстом рядом, дублировать его внутри иконки не нужно
     * (за исключением коротких ярлыков формата).
     *
     * @param {string} ext — расширение вида ``.pdf`` или пустая строка
     * @returns {string} — inline SVG markup
     * @private
     */
    _getFileIconSvg(ext) {
        const key = this._ICON_FORM[(ext || '').toLowerCase()] || 'file-generic-24';
        return this._ICONS_CACHE[key] || '';
    },

    /**
     *  Открывает полноэкранный модальный просмотрщик файла
     *
     *  Поддерживает изображения, PDF, текстовые файлы и JSON/XML.
     *  Для неподдерживаемых типов предлагает скачать.
     *
     *  @param {Object} block — блок файла {file_id, filename, name, mime_type, ...}
     *  @private
     */
    _openFileViewer(block) {
        // Удаляем предыдущий просмотрщик, если он есть
        ChatRenderer._closeFileViewer();

const resolved = ChatRenderer._resolveFileUrl(block.file_id);
        const fileUrl = resolved.url;
        // ``inline=true`` валиден только для backend-эндпоинта — для data-URL
        // добавлять query нельзя (это часть base64-payload'а, она не парсится).
        const inlineUrl = resolved.isDataUrl
            ? fileUrl
            : fileUrl + (fileUrl.includes('?') ? '&' : '?') + 'inline=true';
        const mime = (block.mime_type || '').toLowerCase();
        const filename = block.filename || block.name || 'Файл';

        // Оверлей
        const overlay = document.createElement('div');
        overlay.className = 'chat-file-viewer-overlay';

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) ChatRenderer._closeFileViewer();
        });

        ChatRenderer._fileViewerEscUnsub = EscapeStack.push(() => {
            ChatRenderer._closeFileViewer();
        });

        // Модальный контейнер
        const modal = document.createElement('div');
        modal.className = 'chat-file-viewer';

        // Шапка
        const header = document.createElement('div');
        header.className = 'chat-file-viewer-header';

        const title = document.createElement('span');
        title.className = 'chat-file-viewer-title';
        title.textContent = filename;

        const actions = document.createElement('div');
        actions.className = 'chat-file-viewer-actions';

        // Кнопка «Скачать» в шапке
        const downloadBtn = document.createElement('a');
        downloadBtn.className = 'chat-file-viewer-btn';
        downloadBtn.href = fileUrl;
        downloadBtn.download = filename;
        downloadBtn.title = 'Скачать';
        downloadBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

        // Кнопка «Закрыть»
        const closeBtn = document.createElement('button');
        closeBtn.className = 'chat-file-viewer-btn';
        closeBtn.title = 'Закрыть';
        closeBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
        closeBtn.addEventListener('click', () => ChatRenderer._closeFileViewer());

        actions.appendChild(downloadBtn);
        actions.appendChild(closeBtn);
        header.appendChild(title);
        header.appendChild(actions);

        // Тело — содержимое зависит от MIME-типа
        const body = document.createElement('div');
        body.className = 'chat-file-viewer-body';

        if (mime.startsWith('image/')) {
            const img = document.createElement('img');
            img.src = inlineUrl;
            img.alt = filename;
            img.className = 'chat-file-viewer-image';
            body.appendChild(img);
        } else if (mime === 'application/pdf') {
            const iframe = document.createElement('iframe');
            iframe.src = inlineUrl;
            iframe.className = 'chat-file-viewer-iframe';
            body.appendChild(iframe);
        } else if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
            const pre = document.createElement('pre');
            pre.className = 'chat-file-viewer-text';
            // Для data-URL декодируем на лету — fetch на data: лишний, плюс
            // у нас нет надёжного способа передать сюда isDataUrl из resolved.
            // Резолвим заново: для UUID — fetch, для data — decode.
            const resolvedForText = ChatRenderer._resolveFileUrl(block.file_id);
            if (resolvedForText.isDataUrl) {
                const text = ChatRenderer._decodeTextDataUrl(resolvedForText.url);
                pre.textContent = (text === null)
                    ? 'Не удалось декодировать содержимое файла'
                    : text;
                body.appendChild(pre);
            } else {
                pre.textContent = 'Загрузка...';
                body.appendChild(pre);

                const fetchOpts = {};
                if (typeof AuthManager !== 'undefined' && AuthManager.getAuthHeaders) {
                    fetchOpts.headers = AuthManager.getAuthHeaders();
                }
                fetch(resolvedForText.url + '?inline=true', fetchOpts)
                    .then(r => r.text())
                    .then(text => { pre.textContent = text; })
                    .catch(() => { pre.textContent = 'Ошибка загрузки файла'; });
            }
        } else {
            // Неподдерживаемый тип — сообщение + ссылка на скачивание
            const unsupported = document.createElement('div');
            unsupported.className = 'chat-file-viewer-unsupported';
            unsupported.innerHTML = `
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <polyline points="14,2 14,8 20,8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <p>Предпросмотр недоступен для данного типа файла</p>
            `;
            const dlLink = document.createElement('a');
            dlLink.href = fileUrl;
            dlLink.download = filename;
            dlLink.className = 'chat-file-viewer-download-link';
            dlLink.textContent = 'Скачать файл';
            unsupported.appendChild(dlLink);
            body.appendChild(unsupported);
        }

        modal.appendChild(header);
        modal.appendChild(body);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
    },

    /**
     * Закрывает модальный просмотрщик файла
     * @private
     */
    _closeFileViewer() {
        const existing = document.querySelector('.chat-file-viewer-overlay');
        if (existing) existing.remove();
        if (ChatRenderer._fileViewerEscUnsub) {
            ChatRenderer._fileViewerEscUnsub();
            ChatRenderer._fileViewerEscUnsub = null;
        }
    },

    /**
     * Markdown → HTML через marked (GFM). Экранирование выполняют marked и
     * DOMPurify (см. _safeSetHtml + CHAT_MD_CONFIG). При ошибке парсера —
     * fallback на экранированный текст с переносами.
     *
     * @param {string} text
     * @returns {string}
     * @private
     */
    _markdownToHtml(text) {
        if (!text) return '';
        try {
            return marked.parse(this._closeDanglingFences(String(text)));
        } catch (e) {
            console.warn('ChatRenderer: ошибка markdown-парсинга, fallback на plain', e);
            return SafeHTML.escapeHtml(String(text)).replace(/\n/g, '<br>');
        }
    },

    /**
     * Дозакрывает незакрытый код-фенс у ЧАСТИЧНОГО текста (эффект печати,
     * инкрементальный reasoning): без этого хвост сообщения мигает код-блоком.
     * На полном корректном тексте — no-op (чётное число фенсов).
     *
     * @param {string} text
     * @returns {string}
     * @private
     */
    _closeDanglingFences(text) {
        // Отступ ≤ 3 пробелов — по CommonMark; фенс с большим отступом блок не
        // открывает, и для частичного текста ложное «закрытие» даёт лишь
        // безвредный пустой код-блок в самом хвосте.
        const fences = (text.match(/^\s{0,3}(`{3,}|~{3,})/gm) || []).length;
        return (fences % 2 === 1) ? text + '\n```' : text;
    },

    /**
     * Форматирует размер файла в человекочитаемый вид
     *
     * @param {number} bytes
     * @returns {string}
     * @private
     */
    _formatSize(bytes) {
        // Делегирует в общий хелпер (shared/format-units.js).
        return formatFileSize(bytes);
    },

    /**
     * Копирует код в буфер обмена, показывает подтверждение
     *
     * @param {HTMLButtonElement} button — кнопка «Копировать»
     * @private
     */
    _copyCode(button) {
        const wrapper = button.closest('.chat-block-code');
        if (!wrapper) return;

        const code = wrapper.querySelector('code');
        if (!code) return;

        navigator.clipboard.writeText(code.textContent).then(() => {
            const originalText = button.textContent;
            button.textContent = 'Скопировано';
            setTimeout(() => {
                button.textContent = originalText;
            }, 2000);
        }).catch(() => {
            console.warn('ChatRenderer: не удалось скопировать в буфер обмена');
        });
    },

    /**
     * Возвращает иконку статуса шага плана
     *
     * @param {string} status — 'done', 'in_progress' или 'pending'
     * @returns {string}
     * @private
     */
    _getPlanStatusIcon(status) {
        switch (status) {
            case 'done': return '\u2713'; // ✓
            case 'in_progress': return '\u27F3'; // ⟳
            default: return '\u25CB'; // ○
        }
    },

    /**
     * Читает режим отображения reasoning из localStorage
     *
     * @returns {'hidden'|'collapsed'|'expanded'}
     * @private
     */
    _getReasoningDisplayMode() {
        try {
            const mode = localStorage.getItem('chat_reasoning_display');
            if (mode === 'hidden' || mode === 'collapsed' || mode === 'expanded') {
                return mode;
            }
        } catch { /* localStorage недоступен */ }
        return 'collapsed';
    },
};

window.ChatRenderer = ChatRenderer;
