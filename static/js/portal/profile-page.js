/**
 * Страница профиля (/profile): загрузка и удаление фото пользователя.
 *
 * Своё фото — единственное, что пользователь может здесь изменить; остальное
 * приходит из справочника и правится ETL. После смены фото обновляются и
 * превью на странице, и аватарка в шапке — без перезагрузки.
 */
import { AppConfig } from '../shared/app-config.js';
import { AuthManager } from '../shared/auth.js';
import { formatValidationDetail } from '../shared/api-errors.js';
import { Notifications } from '../shared/notifications.js';
import { renderPortalAvatars } from './user-avatar.js';

export class ProfilePage {
    static _input = null;
    static _removeBtn = null;

    /**
     * Инициализирует блок фото. Тихо выходит, если разметки нет.
     */
    static init() {
        const input = document.getElementById('avatarFileInput');
        const pickBtn = document.getElementById('avatarPickBtn');
        const removeBtn = document.getElementById('avatarRemoveBtn');
        if (!input || !pickBtn || !removeBtn) return;

        this._input = input;
        this._removeBtn = removeBtn;

        pickBtn.addEventListener('click', () => input.click());
        input.addEventListener('change', () => this._onFilePicked());
        removeBtn.addEventListener('click', () => this._remove());

        this._syncRemoveButton();
    }

    /**
     * Кнопка «Убрать фото» видна, только когда фото есть.
     * @private
     */
    static _syncRemoveButton() {
        const profile = AuthManager.getCurrentUserProfile();
        const hasAvatar = Boolean(profile && profile.avatar_version);
        this._removeBtn.classList.toggle('hidden', !hasAvatar);
    }

    /** @private */
    static async _onFilePicked() {
        const file = this._input.files && this._input.files[0];
        // Сброс value обязателен: без него повторный выбор того же файла
        // не породит событие change.
        this._input.value = '';
        if (!file) return;

        const body = new FormData();
        body.append('file', file);
        try {
            const version = await this._send('POST', body, 'Не удалось загрузить фото');
            this._applyVersion(version);
            Notifications.success('Фото профиля обновлено');
        } catch (error) {
            Notifications.error(error.message);
        }
    }

    /** @private */
    static async _remove() {
        try {
            await this._send('DELETE', undefined, 'Не удалось убрать фото');
            this._applyVersion(null);
            Notifications.success('Фото профиля удалено');
        } catch (error) {
            Notifications.error(error.message);
        }
    }

    /**
     * Шлёт запрос к /api/v1/auth/avatar и возвращает новую версию фото.
     *
     * Сообщение об ошибке берём из detail ответа — сервер пишет его
     * по-русски и по делу («Файл больше 5 МБ», «Файл не является
     * изображением»); fallback нужен на случай не-JSON тела (502 от прокси).
     * @private
     */
    static async _send(method, body, fallbackError) {
        const response = await fetch(
            AppConfig.api.getUrl('/api/v1/auth/avatar'),
            { method, body },
        );

        if (!response.ok) {
            let detail = null;
            try {
                detail = formatValidationDetail((await response.json()).detail);
            } catch {
                detail = null;
            }
            throw new Error(detail || fallbackError);
        }

        const data = await response.json();
        return data.avatar_version ?? null;
    }

    /**
     * Разносит новую версию фото: кеш профиля в памяти и все аватарки
     * страницы, включая топбар и hover-карточку.
     * @private
     */
    static _applyVersion(version) {
        AuthManager.updateAvatarVersion(version);
        renderPortalAvatars(AuthManager.getCurrentUser(), version);
        this._syncRemoveButton();
    }
}

window.ProfilePage = ProfilePage;
