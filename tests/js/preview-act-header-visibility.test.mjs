/**
 * Тумблер «Показывать шапку акта» реально управляет рендером шапки в превью.
 *
 * Регрессия: `preview.js::_renderTitle` читает настройку цепочкой
 * `window.SettingsMenuManager?.getSettings?.().showActHeader ?? true`, а
 * публичного `getSettings` в классе не было. Опциональный вызов `?.()`
 * коротко замыкал ВСЮ цепочку (включая `.showActHeader`) в `undefined`,
 * поэтому `?? true` подставлял `true` всегда — шапка не пряталась никогда.
 *
 * Проверяем сквозной путь: сохранённая настройка → `_loadSettings` →
 * `getSettings()` → `_renderTitle`.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SettingsMenuManager } from '../../static/js/constructor/header/settings-menu.js';
import { PreviewManager } from '../../static/js/constructor/preview/preview.js';
import { PreviewCoverRenderer } from '../../static/js/constructor/preview/preview-cover-renderer.js';

/**
 * Прогоняет `_renderTitle` с настройкой, загруженной из localStorage.
 *
 * Подменяет `PreviewCoverRenderer.create` маркером, чтобы отделить «шапка не
 * нарисована из-за выключенной настройки» от «нет window.actMetadata».
 *
 * @param {Object} saved Содержимое ключа `app_settings` в localStorage.
 * @returns {Object[]} Узлы, добавленные в контейнер превью.
 */
function renderTitleWithSettings(saved) {
    const origState = {...SettingsMenuManager._state};
    const origGetItem = localStorage.getItem;
    const origCreate = PreviewCoverRenderer.create;

    localStorage.getItem = (key) => (key === 'app_settings' ? JSON.stringify(saved) : null);
    PreviewCoverRenderer.create = () => ({cover: true});

    const appended = [];
    try {
        SettingsMenuManager._loadSettings();
        PreviewManager._renderTitle({appendChild: (node) => appended.push(node)});
    } finally {
        localStorage.getItem = origGetItem;
        PreviewCoverRenderer.create = origCreate;
        SettingsMenuManager._state = origState;
    }
    return appended;
}

test('getSettings отдаёт актуальное значение showActHeader, а не дефолт', () => {
    const origState = {...SettingsMenuManager._state};
    try {
        SettingsMenuManager._state.showActHeader = false;
        assert.equal(SettingsMenuManager.getSettings().showActHeader, false);

        SettingsMenuManager._state.showActHeader = true;
        assert.equal(SettingsMenuManager.getSettings().showActHeader, true);
    } finally {
        SettingsMenuManager._state = origState;
    }
});

test('getSettings возвращает копию — внешняя мутация не трогает состояние', () => {
    const snapshot = SettingsMenuManager.getSettings();
    snapshot.showActHeader = !snapshot.showActHeader;
    assert.notEqual(
        SettingsMenuManager.getSettings().showActHeader,
        snapshot.showActHeader,
        'мутация копии просочилась в _state'
    );
});

test('настройка выключена — шапка акта в превью не рендерится', () => {
    assert.deepEqual(renderTitleWithSettings({showActHeader: false}), []);
});

test('настройка включена — шапка акта рендерится', () => {
    assert.equal(renderTitleWithSettings({showActHeader: true}).length, 1);
});
