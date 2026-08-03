/**
 * Менеджер авторизации
 *
 * Проверяет авторизацию пользователя при открытии страницы.
 * Использует localStorage для кеширования username на 24 часа.
 * Обрабатывает ошибки Kerberos токена.
 */
import { AppConfig } from './app-config.js';

export class AuthManager {
    /**
     * Ключ для хранения username в localStorage
     * @private
     */
    static _storageKey = 'auth_username';

    /**
     * Ключ для хранения timestamp последней проверки
     * @private
     */
    static _timestampKey = 'auth_timestamp';

    /**
     * Ключ профиля в sessionStorage.
     *
     * Профиль хранится не только в памяти класса, потому что браузер грузит
     * этот модуль ДВАЖДЫ, как два разных ES-модуля: inline-скрипты шаблонов
     * импортируют его с `?v=<версия>` (фильтр versioned), а импорты внутри
     * модулей (portal-sidebar.js → ../shared/auth.js) разрешаются
     * относительно версионного URL и уходят без параметра. Разные URL —
     * разные экземпляры класса, поэтому профиль, полученный checkAuth() в
     * одном графе, второму не виден: топбар оставался с логином вместо ФИО,
     * а аватарка не появлялась вовсе. Хранилище общее для обоих графов.
     *
     * Именно sessionStorage, а не localStorage: профиль не должен переживать
     * вкладку — username там лежит осознанно (сессия на 24 часа), профиль же
     * восстанавливается ближайшим checkAuth().
     * @private
     */
    static _profileKey = 'auth_profile';

    /**
     * Текущий пользователь (кеш в памяти)
     * @private
     */
    static _currentUser = null;

    /**
     * Полный профиль текущего пользователя (весь ответ /api/v1/auth/me).
     * Кеш в памяти поверх sessionStorage (см. _profileKey).
     * @private
     */
    static _profile = null;

    /**
     * Флаг авторизации
     * @private
     */
    static _isAuthenticated = false;

    /**
     * Время жизни сессии в localStorage (24 часа)
     * @private
     */
    static _sessionExpiry = 24 * 60 * 60 * 1000;

    /**
     * Инициализирует AuthManager
     * Проверяет наличие сохраненного username в localStorage
     */
    static init() {
        // Пытаемся загрузить из localStorage
        const savedUser = this._loadFromStorage();
        if (savedUser && this._isSessionActive()) {
            this._currentUser = savedUser;
            this._isAuthenticated = true;
        } else {
            // Сессия истекла или username отсутствует
            this._clearStorage();
        }
    }

    /**
     * Проверяет, активна ли сессия (не истекла ли)
     * @private
     * @returns {boolean}
     */
    static _isSessionActive() {
        try {
            const timestamp = localStorage.getItem(this._timestampKey);
            if (!timestamp) return false;

            const now = Date.now();
            const savedTime = parseInt(timestamp, 10);

            return (now - savedTime) < this._sessionExpiry;
        } catch (error) {
            console.error('Ошибка проверки timestamp:', error);
            return false;
        }
    }

    /**
     * Загружает username из localStorage
     * @private
     * @returns {string|null}
     */
    static _loadFromStorage() {
        try {
            return localStorage.getItem(this._storageKey);
        } catch (error) {
            console.error('Ошибка чтения username из localStorage:', error);
            return null;
        }
    }

    /**
     * Сохраняет username и timestamp в localStorage
     * @private
     * @param {string} username
     */
    static _saveToStorage(username) {
        try {
            localStorage.setItem(this._storageKey, username);
            localStorage.setItem(this._timestampKey, Date.now().toString());
        } catch (error) {
            console.error('Ошибка сохранения username в localStorage:', error);
        }
    }

    /**
     * Сохраняет профиль в sessionStorage — чтобы его увидел и второй
     * ES-граф модуля (см. _profileKey)
     * @private
     * @param {Object} profile
     */
    static _saveProfileToStorage(profile) {
        try {
            sessionStorage.setItem(this._profileKey, JSON.stringify(profile));
        } catch (error) {
            console.error('Ошибка сохранения профиля в sessionStorage:', error);
        }
    }

    /**
     * Читает профиль из sessionStorage.
     * Битое значение — null без шума: профиль восстановит ближайший checkAuth().
     * @private
     * @returns {Object|null}
     */
    static _loadProfileFromStorage() {
        try {
            const raw = sessionStorage.getItem(this._profileKey);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }

    /**
     * Очищает сохраненный username из localStorage
     * @private
     */
    static _clearStorage() {
        try {
            localStorage.removeItem(this._storageKey);
            localStorage.removeItem(this._timestampKey);
            sessionStorage.removeItem(this._profileKey);
        } catch (error) {
            console.error('Ошибка очистки username из localStorage:', error);
        }
    }

    /**
     * Показывает ошибку Kerberos с инструкциями
     * @private
     * @param {Object} errorData - данные об ошибке от API
     */
    static _showKerberosError(errorData) {
        const baseUrl = AppConfig.api.getBaseUrl();
        window.location.href = `${baseUrl}/error/401?reason=kerberos`;
    }

    /**
     * Проверяет авторизацию через API (берёт из переменной окружения)
     * Используется при открытии любой страницы
     * @returns {Promise<{authenticated: boolean, username: string|null}>}
     */
    static async checkAuth() {
        try {
            const response = await fetch(AppConfig.api.getUrl('/api/v1/auth/me'));

            // Проверяем на ошибку Kerberos токена
            if (response.status === 401) {
                let errorData;
                try {
                    errorData = await response.json();
                } catch {
                    errorData = {};
                }

                if (errorData.error === 'kerberos_token_expired') {
                    console.error('Kerberos токен истек');
                    this._showKerberosError(errorData);
                    return {authenticated: false, username: null};
                }
            }

            if (!response.ok) {
                throw new Error('Ошибка проверки авторизации');
            }

            const data = await response.json();

            this._isAuthenticated = data.authenticated;
            this._currentUser = data.username;
            this._profile = data.authenticated ? data : null;

            // Сохраняем в localStorage для последующих операций
            if (data.authenticated && data.username) {
                this._saveToStorage(data.username);
                this._saveProfileToStorage(data);
            } else {
                this._clearStorage();
            }

            // Устанавливаем в глобальный объект для совместимости
            window.env = window.env || {};
            window.env.JUPYTERHUB_USER = data.username;

            return data;

        } catch (error) {
            console.error('Ошибка проверки авторизации:', error);
            this._isAuthenticated = false;
            this._currentUser = null;
            this._profile = null;
            this._clearStorage();
            return {authenticated: false, username: null};
        }
    }

    /**
     * Требует авторизации для открытия страницы
     * Показывает сообщение об ошибке если не авторизован
     * @returns {Promise<boolean>}
     */
    static async requireAuth() {
        const authData = await this.checkAuth();

        if (!authData.authenticated) {
            this._showAuthError();
            return false;
        }

        return true;
    }

    /**
     * Уводит на страницу входа (с пометкой «сессия истекла», если пользователь был)
     * @private
     */
    static _showAuthError() {
        const baseUrl = AppConfig.api.getBaseUrl();
        const hadUser = this._loadFromStorage();
        this._clearStorage();
        window.location.href = `${baseUrl}/auth/login${hadUser ? '?expired=1' : ''}`;
    }

    /**
     * Возвращает текущего пользователя
     * Сначала проверяет кеш в памяти, затем localStorage
     * @returns {string|null}
     */
    static getCurrentUser() {
        // Если есть в памяти — возвращаем
        if (this._currentUser) {
            return this._currentUser;
        }

        // Иначе пытаемся загрузить из localStorage
        if (this._isSessionActive()) {
            const savedUser = this._loadFromStorage();
            if (savedUser) {
                this._currentUser = savedUser;
                this._isAuthenticated = true;
                return savedUser;
            }
        }

        console.warn('Username не найден или сессия истекла');
        return null;
    }

    /**
     * Возвращает полный профиль текущего пользователя (ФИО, должность, email,
     * роли и т.п. — весь ответ /api/v1/auth/me).
     *
     * Промах кеша в памяти добирается из sessionStorage: checkAuth() мог
     * отработать в соседнем ES-графе этого же модуля (см. _profileKey).
     * null — пока checkAuth() не отработал успешно в этой вкладке.
     * @returns {Object|null}
     */
    static getCurrentUserProfile() {
        if (!this._profile) {
            this._profile = this._loadProfileFromStorage();
        }
        return this._profile;
    }

    /**
     * Обновляет версию фото в закешированном профиле.
     *
     * Вызывается со страницы профиля после загрузки/удаления фото: сервер уже
     * вернул новую версию, повторный /me ради одного поля не нужен. Пишем и в
     * sessionStorage — иначе второй ES-граф (топбар) остался бы со старой
     * версией и показывал прежнее фото из кеша браузера.
     * @param {number|null} version
     */
    static updateAvatarVersion(version) {
        const profile = this.getCurrentUserProfile();
        if (!profile) return;

        profile.avatar_version = version;
        this._saveProfileToStorage(profile);
    }

    /**
     * Проверяет, авторизован ли пользователь (в памяти или localStorage)
     * @returns {boolean}
     */
    static isAuthenticated() {
        // Проверяем кеш в памяти
        if (this._isAuthenticated) {
            return true;
        }

        // Проверяем localStorage и активность сессии
        if (this._isSessionActive()) {
            const savedUser = this._loadFromStorage();
            if (savedUser) {
                this._currentUser = savedUser;
                this._isAuthenticated = true;
                return true;
            }
        }

        return false;
    }

    /**
     * Возвращает заголовки для API-запросов.
     * Auth — server-side через env-var JUPYTERHUB_USER; фронт не шлёт заголовков.
     * Метод оставлен ради API-совместимости с чат-модулями (Object.assign).
     * @returns {Object}
     */
    static getAuthHeaders() {
        return {};
    }

    /**
     * Очищает авторизацию (для logout)
     */
    static logout() {
        this._currentUser = null;
        this._isAuthenticated = false;
        this._profile = null;
        this._clearStorage();

        if (window.env) {
            window.env.JUPYTERHUB_USER = null;
        }

        console.log('Пользователь вышел из системы');
    }

    /**
     * Проверяет актуальность авторизации
     * @returns {boolean}
     */
    static isSessionValid() {
        return this._isSessionActive() && this._loadFromStorage() !== null;
    }

    /**
     * Обновляет timestamp сессии (продлевает жизнь)
     */
    static refreshSession() {
        if (this._currentUser) {
            this._saveToStorage(this._currentUser);
            console.log('Сессия обновлена');
        }
    }
}

// Инициализируем при загрузке скрипта
AuthManager.init();

window.AuthManager = AuthManager;
