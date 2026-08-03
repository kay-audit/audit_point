/**
 * Показ фото профиля в круглых аватарках портала.
 *
 * Аватарок три — в топбаре, в hover-карточке пользователя и на странице
 * профиля — и разметка у всех одинаковая: контейнер с классом
 * `js-user-avatar`, внутри svg-силуэт и <img>. Есть фото — показываем
 * картинку и прячем силуэт, нет — наоборот.
 */
import { AppConfig } from '../shared/app-config.js';
import { buildAvatarPath } from './user-card-core.js';

/**
 * Заполняет один контейнер-аватарку.
 *
 * @param {HTMLElement|null} container Элемент с классом js-user-avatar.
 * @param {string|null} username
 * @param {number|string|null} version Версия фото из профиля /me (null — фото нет).
 */
export function renderAvatar(container, username, version) {
    if (!container) return;

    const path = buildAvatarPath(username, version);
    const img = container.querySelector('.user-avatar-img');
    const icon = container.querySelector('.user-avatar-icon');

    if (img) {
        if (path) {
            img.src = AppConfig.api.getUrl(path);
        } else {
            // Пустой src браузер трактует как «загрузить текущую страницу» —
            // убираем атрибут целиком.
            img.removeAttribute('src');
        }
        img.classList.toggle('hidden', !path);
    }
    if (icon) icon.classList.toggle('hidden', Boolean(path));
}

/**
 * Обновляет все аватарки на странице разом.
 *
 * Вызывается и при загрузке страницы, и после смены фото в профиле —
 * тогда топбар и карточка обновляются без перезагрузки.
 *
 * @param {string|null} username
 * @param {number|string|null} version
 */
export function renderPortalAvatars(username, version) {
    document
        .querySelectorAll('.js-user-avatar')
        .forEach((el) => renderAvatar(el, username, version));
}

window.renderPortalAvatars = renderPortalAvatars;
