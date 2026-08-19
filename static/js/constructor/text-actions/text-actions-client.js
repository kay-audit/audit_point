/**
 * Клиент text-actions: обёртка над эндпоинтом корректора.
 * Все URL — через AppConfig.api.getUrl (JupyterHub-proxy).
 */
import { AppConfig } from '../../shared/app-config.js';

/**
 * Обработать текст: орфография/пунктуация (`fix`) или улучшение читаемости (`readability`).
 * @param {string} text — исходный текст выделения.
 * @param {{signal?: AbortSignal, mode?: 'fix'|'readability'}} [opts]
 * @returns {Promise<{correctedText: string, readability: Object|null}>} обработанный
 *   текст и диагностика читаемости (анализатор D17). `readability` приходит только
 *   для режима `readability`; для `fix` и при сбое анализатора — null.
 */
export async function correctText(text, { signal, mode = 'fix' } = {}) {
    const res = await fetch(AppConfig.api.getUrl('/api/v1/chat/text-actions/correct'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, mode }),
        signal,
    });
    if (!res.ok) {
        let detail = 'Не удалось обработать текст';
        try {
            const data = await res.json();
            if (data && data.detail) detail = data.detail;
        } catch (_) { /* тело не JSON — оставляем дефолт */ }
        const err = new Error(detail);
        err.status = res.status;
        throw err;
    }
    const data = await res.json();
    return { correctedText: data.corrected_text, readability: data.readability || null };
}

window.correctText = correctText;

/**
 * Формализовать нарушение: разложить свободный текст по полям карточки.
 * @param {string} text — свободный текст нарушения.
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<{violated:string, established:string, description:string,
 *   reasons:string, measures:string, responsible:string, consequences:string,
 *   recommendations:string[]}>} извлечённые поля (пустые — что LLM не нашла;
 *   `description` — метрики нарушения списком, единственное поле с `<ul>`;
 *   `measures` — «Принятые меры», поле карточки под «Причинами»; `recommendations` —
 *   дисплей-онли подсказки «чего не хватает», в карточку/экспорт НЕ идут).
 */
export async function formalizeViolation(text, { signal } = {}) {
    const res = await fetch(
        AppConfig.api.getUrl('/api/v1/chat/text-actions/formalize-violation'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
            signal,
        });
    if (!res.ok) {
        let detail = 'Не удалось формализовать текст';
        try {
            const data = await res.json();
            if (data && data.detail) detail = data.detail;
        } catch (_) { /* тело не JSON — оставляем дефолт */ }
        const err = new Error(detail);
        err.status = res.status;
        throw err;
    }
    return res.json();
}

window.formalizeViolation = formalizeViolation;
