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

// Дублируем в window ради inline-скриптов; guard — модуль импортируется в node:test.
if (typeof window !== 'undefined') {
    window.UserCardCore = { resolveUserCardFields };
}
