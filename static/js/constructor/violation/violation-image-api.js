/**
 * Сетевой доступ к картинкам нарушений (ссылочная модель).
 *
 * Байты картинок живут в таблице `act_images` и адресуются ПАРОЙ
 * `(act_id, image_id)`; блок-картинка нарушения хранит только `image_id`.
 * Здесь — три операции над этой парой: сборка URL для `<img src>`, загрузка
 * файла (multipart) и обратное чтение байтов (нужно копированию узлов между
 * актами: картинка принадлежит акту-источнику, в целевом акте её надо
 * завести заново).
 *
 * URL собираются ТОЛЬКО через `AppConfig.api.getUrl` — правило проекта
 * (единая точка сборки базового пути).
 *
 * Акт-контекст рендера: в конструкторе это `window.currentActId`, но те же
 * рендеры (превью нарушений, дифф версий) переиспользуются на портале, где
 * этого глобала нет. Портальная страница объявляет свой акт явно —
 * `setImageActContext(actId)`.
 */

import { AppConfig } from '../../shared/app-config.js';

/** Явный акт-контекст рендера (портал); null — берём window.currentActId. */
let _actIdOverride = null;

/**
 * Объявляет акт, которому принадлежат отрисовываемые картинки. Нужен там, где
 * `window.currentActId` не выставлен (просмотр версий на портале).
 *
 * @param {string|number|null} actId - ID акта либо null для сброса
 */
export function setImageActContext(actId) {
    _actIdOverride = actId ?? null;
}

/**
 * Текущий акт-контекст рендера картинок: явный override, иначе акт
 * конструктора.
 *
 * @returns {string|number|null}
 */
export function getImageActContext() {
    if (_actIdOverride !== null) return _actIdOverride;
    return (typeof window !== 'undefined' ? window.currentActId : null) ?? null;
}

/**
 * URL байтов картинки акта. Пустая строка, если пара неполная (черновой блок
 * без картинки либо неизвестный акт) — потребители рендерят плейсхолдер.
 *
 * @param {string|number|null} actId - ID акта
 * @param {string} imageId - ID строки act_images
 * @returns {string} URL или '' если адресовать нечего
 */
export function buildActImageUrl(actId, imageId) {
    if (actId === null || actId === undefined || actId === '' || !imageId) return '';
    return AppConfig.api.getUrl(
        `/api/v1/acts/${encodeURIComponent(actId)}/images/${encodeURIComponent(imageId)}`,
    );
}

/**
 * URL картинки блока в текущем акт-контексте (или в явно указанном акте).
 *
 * @param {Object} block - Блок типа 'image'
 * @param {string|number|null} [actId] - Явный акт (по умолчанию — контекст)
 * @returns {string} URL или '' если картинки нет
 */
export function resolveBlockImageSrc(block, actId = undefined) {
    const act = actId === undefined ? getImageActContext() : actId;
    return buildActImageUrl(act, block?.image_id || '');
}

/**
 * Ошибка API картинок с человекочитаемым текстом из envelope
 * `{detail, code, extra}`. `detail` бэка уже на русском — показываем его как
 * есть, своих формулировок поверх не сочиняем.
 *
 * @param {Response} response - Ответ с !ok
 * @returns {Promise<Error>} Ошибка со status/code
 */
async function _buildApiError(response) {
    let detail = '';
    let code = null;
    try {
        const body = await response.json();
        if (typeof body?.detail === 'string') detail = body.detail;
        if (typeof body?.code === 'string') code = body.code;
    } catch (_) {
        // Не-JSON ответ (HTML-страница ошибки прокси) — остаётся fallback ниже.
    }
    const error = new Error(detail || `Ошибка сервера (${response.status})`);
    error.status = response.status;
    error.code = code;
    return error;
}

/**
 * Загружает байты картинки в акт. MIME определяет сервер по самим байтам,
 * заголовок части multipart'а на результат не влияет.
 *
 * @param {string|number} actId - ID акта-получателя
 * @param {Blob|File} blob - Байты картинки (уже сжатые, если пользователь выбрал сжатие)
 * @param {string} filename - Имя файла (справочное, попадает в блок)
 * @returns {Promise<{image_id: string, byte_size: number, mime_type: string,
 *                    width: number, height: number}>} Дескриптор картинки
 * @throws {Error} С полями status/code — 403/409/422 разбираются вызывающей стороной
 */
export async function uploadActImage(actId, blob, filename) {
    const form = new FormData();
    form.append('file', blob, filename || 'image');

    const response = await fetch(
        AppConfig.api.getUrl(`/api/v1/acts/${encodeURIComponent(actId)}/images`),
        { method: 'POST', body: form },
    );
    if (!response.ok) throw await _buildApiError(response);
    return response.json();
}

/**
 * Читает байты картинки акта. Нужно копированию узлов между актами: доступ к
 * картинке даёт только пара `(act_id, image_id)`, поэтому перед вставкой в
 * другой акт байты скачиваются и загружаются туда заново.
 *
 * @param {string|number} actId - ID акта-владельца
 * @param {string} imageId - ID картинки
 * @returns {Promise<Blob>} Байты картинки
 * @throws {Error} С полями status/code (403/404)
 */
export async function fetchActImageBlob(actId, imageId) {
    const response = await fetch(buildActImageUrl(actId, imageId));
    if (!response.ok) throw await _buildApiError(response);
    return response.blob();
}

// Window-global для inline-скриптов шаблонов (guarded — модуль тестируется в node).
if (typeof window !== 'undefined') {
    window.ViolationImageApi = {
        setImageActContext,
        getImageActContext,
        buildActImageUrl,
        resolveBlockImageSrc,
        uploadActImage,
        fetchActImageBlob,
    };
}
