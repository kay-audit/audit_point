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
 * Сокращает ФИО до фамилии и имени: «Фамилия Имя Отчество» → «Фамилия Имя».
 *
 * Справочник хранит ФИО одной строкой (колонка fullname), на части оно не
 * разобрано — режем по словам и берём первые два. Одно-два слова возвращаются
 * как есть: это либо уже сокращённая форма («Иванов И.И.»), либо логин-фолбэк.
 * Порядок слов «Фамилия Имя Отчество» — формат справочника.
 *
 * @param {string|null} fullname
 * @returns {string}
 */
export function formatShortFio(fullname) {
    const parts = String(fullname || '').trim().split(/\s+/).filter(Boolean);
    return parts.slice(0, 2).join(' ');
}

/**
 * Выбирает строки блока пользователя в топбаре: имя, полное ФИО и логин.
 *
 * В топбаре имя сокращено до фамилии и имени — полное ФИО там не помещается и
 * упиралось в многоточие. Полное отдаётся отдельным полем: вызывающий вешает
 * его в title, а целиком оно и так показано в hover-карточке и в профиле.
 *
 * Когда ФИО не подтянулось, первая строка сама показывает логин — вторую
 * тогда возвращаем пустой, чтобы логин не дублировался.
 *
 * @param {{fullname?: string, login?: string}|null} profile
 * @param {string|null} [fallbackUsername] Username на случай отсутствия профиля.
 * @returns {{name: string, fullName: string, login: string}} Пустой login — строку скрыть.
 */
export function resolveTopbarUserLines(profile, fallbackUsername) {
    const { name: fullName } = resolveUserCardFields(profile, fallbackUsername);
    const login = (profile && profile.login) || fallbackUsername || '';
    return {
        name: formatShortFio(fullName),
        fullName,
        login: login === fullName ? '' : login,
    };
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
        formatShortFio,
        buildAvatarPath,
    };
}
