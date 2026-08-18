/**
 * Выбор плашки о завершении сессии конструктора на странице списка актов.
 *
 * При уходе из конструктора в sessionStorage ставится один из флагов:
 *  - `sessionLockLost`     — блокировка снята (неактивность), но последний save
 *                            вернул 409 → изменения НЕ в БД (честное сообщение,
 *                            БЕЗ ложного «сохранено»);
 *  - `sessionExitSaveFailed`— выходной save упал НЕ по 409 (сеть/5xx/422):
 *                            изменения НЕ в БД, но остаются в локальном
 *                            черновике (тоже без ложного «сохранено»);
 *  - `sessionAutoExited`   — автовыход по неактивности, акт успешно сохранён;
 *  - `sessionExitedWithSave`— обычный выход с сохранением.
 *
 * Приоритет: lockLost > saveFailed > autoExited > exitedWithSave (случаи
 * «изменения НЕ в БД» важнее всего — плашки об успехе лгали бы).
 *
 * Чистая функция без DOM/sessionStorage — тестируется в node:test.
 */

/**
 * @typedef {Object} SessionExitFlags
 * @property {boolean} lockLost       Блокировка снята, save вернул 409.
 * @property {boolean} saveFailed     Выходной save упал не по 409 — не сохранено.
 * @property {boolean} autoExited     Автовыход по неактивности (сохранено).
 * @property {boolean} exitedWithSave Обычный выход с сохранением.
 */

/**
 * @typedef {Object} SessionExitNotice
 * @property {string} flag    sessionStorage-ключ, который нужно снять.
 * @property {string} title   Заголовок плашки.
 * @property {string} message Текст плашки.
 * @property {string} icon    Иконка.
 * @property {'info'|'success'|'warning'} type Тип плашки.
 * @property {string} confirmText Текст кнопки подтверждения.
 */

/**
 * Возвращает конфиг плашки для показа, либо null если ни один флаг не выставлен.
 * @param {SessionExitFlags} flags
 * @returns {SessionExitNotice|null}
 */
export function pickSessionExitNotice(flags) {
    if (flags?.lockLost) {
        return {
            flag: 'sessionLockLost',
            title: 'Блокировка акта снята',
            message: 'Блокировка акта была снята из-за длительного бездействия. '
                + 'Последние изменения НЕ сохранены в базе данных, но остаются '
                + 'в локальном черновике этого браузера.',
            icon: '⚠️',
            type: 'warning',
            confirmText: 'Понятно',
        };
    }
    if (flags?.saveFailed) {
        return {
            flag: 'sessionExitSaveFailed',
            title: 'Изменения не сохранены',
            message: 'Редактирование завершено, но сохранить изменения в базу '
                + 'данных не удалось. Последние правки остаются в локальном '
                + 'черновике этого браузера — откройте акт, чтобы восстановить их.',
            icon: '⚠️',
            type: 'warning',
            confirmText: 'Понятно',
        };
    }
    if (flags?.autoExited) {
        return {
            flag: 'sessionAutoExited',
            title: 'Сессия завершена',
            message: 'Редактирование было автоматически прекращено из-за длительного бездействия. Изменения сохранены.',
            icon: '⏱️',
            type: 'info',
            confirmText: 'Понятно',
        };
    }
    if (flags?.exitedWithSave) {
        return {
            flag: 'sessionExitedWithSave',
            title: 'Данные сохранены',
            message: 'Редактирование завершено. Все изменения сохранены.',
            icon: '✅',
            type: 'success',
            confirmText: 'OK',
        };
    }
    return null;
}
