/**
 * Чистое ядро карточки пользователя (без DOM/window) — выбор полей,
 * отображаемых в hover-карточке топбара и на странице профиля.
 */

/**
 * Выбирает поля карточки пользователя из профиля /api/v1/auth/me.
 *
 * Профиль может быть ещё не загружен (карточка открыта раньше ответа
 * AuthManager.checkAuth()) — тогда имя падает на username. Пустые
 * должность/email возвращаются пустой строкой без плейсхолдера — решение,
 * скрывать ли строку карточки, остаётся за вызывающим кодом.
 *
 * @param {{fullname?: string, job?: string, email?: string}|null} profile
 * @param {string|null} [fallbackUsername] Username на случай отсутствия профиля.
 * @returns {{name: string, job: string, email: string}}
 */
export function resolveUserCardFields(profile, fallbackUsername) {
    return {
        name: (profile && profile.fullname) || fallbackUsername || '',
        job: (profile && profile.job) || '',
        email: (profile && profile.email) || '',
    };
}

/**
 * Выбирает две строки блока пользователя в топбаре: имя и логин под ним.
 *
 * Когда ФИО не подтянулось, первая строка сама показывает логин — вторую
 * тогда возвращаем пустой, чтобы логин не дублировался.
 *
 * @param {{fullname?: string, login?: string}|null} profile
 * @param {string|null} [fallbackUsername] Username на случай отсутствия профиля.
 * @returns {{name: string, login: string}} Пустой login — строку скрыть.
 */
export function resolveTopbarUserLines(profile, fallbackUsername) {
    const { name } = resolveUserCardFields(profile, fallbackUsername);
    const login = (profile && profile.login) || fallbackUsername || '';
    return { name, login: login === name ? '' : login };
}

/**
 * Строит путь к фото профиля пользователя.
 *
 * Версия (unix-время загрузки из /api/v1/auth/me) уходит в ?v= — сервер её
 * игнорирует, она нужна только чтобы браузер не показывал прежнее фото из
 * своего кеша после замены. Нет версии — нет и фото.
 *
 * Возвращает путь без proxy-префикса: вызывающий оборачивает его в
 * AppConfig.api.getUrl(...).
 *
 * @param {string|null} username
 * @param {number|string|null} version
 * @returns {string|null} Путь либо null, если фото нет.
 */
export function buildAvatarPath(username, version) {
    if (!username || version === null || version === undefined || version === '') {
        return null;
    }
    return `/api/v1/auth/avatar/${encodeURIComponent(username)}`
        + `?v=${encodeURIComponent(version)}`;
}

// Дублируем в window ради inline-скриптов; guard — модуль импортируется в node:test.
if (typeof window !== 'undefined') {
    window.UserCardCore = {
        resolveUserCardFields,
        resolveTopbarUserLines,
        buildAvatarPath,
    };
}
