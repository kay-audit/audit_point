/**
 * Task 0.3: связка focus/blur текстблок-редактора с EditorRegistry.
 * Два слоя покрытия:
 *  - изолированные методы (_activateSurfaceForEditor/_clearSurfaceIfOwned) —
 *    без реального DOM;
 *  - РЕАЛЬНЫЕ handleEditorFocus/handleEditorBlur (тулбар-методы застаблены
 *    no-op'ами, сама врезка — нет) — регресс-тест на саму задачу: мост
 *    this.activeEditor + отложенный (200мс) ownership-guard при переходе A→B.
 */
import './_browser-stub.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TextBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';
import '../../static/js/constructor/textblock/textblock-editor.js';
import { EditorRegistry } from '../../static/js/constructor/textblock/editor-registry.js';
import { PreviewManager } from '../../static/js/constructor/preview/preview.js';

// handleEditorBlur зовёт PreviewManager.updateBlock — не в фокусе этой задачи,
// стабим no-op'ом (как textblock-blur-preview.test.mjs).
PreviewManager.updateBlock = () => {};

beforeEach(() => EditorRegistry.clear());

function makeManager() {
    return Object.create(TextBlockManager.prototype);
}

function fakeEditor(id) {
    return { dataset: { textBlockId: id } };
}

/**
 * Менеджер для тестов РЕАЛЬНЫХ handleEditorFocus/handleEditorBlur: тулбар/
 * tooltip-методы вне зоны ответственности Task 0.3 застаблены no-op'ами
 * (рецепт — tests/js/textblock-blur-preview.test.mjs:20-26), сама врезка
 * (setActiveEditor/_activateSurfaceForEditor/_clearSurfaceIfOwned) — реальная,
 * с прототипа.
 */
function makeHandlerManager() {
    const mgr = Object.create(TextBlockManager.prototype);
    mgr.globalToolbar = { contains: () => false };
    mgr.hideToolbar = () => {};
    mgr.clearActiveEditor = () => {};
    mgr.showToolbar = () => {};
    mgr.updateToolbarState = () => {};
    mgr.attachLinkFootnoteHandlers = () => {};
    mgr.applyFormattingToNewNodes = () => {};
    return mgr;
}

test('_activateSurfaceForEditor регистрирует поверхность редактора в EditorRegistry', () => {
    const mgr = makeManager();
    const editorA = fakeEditor('A');

    mgr._activateSurfaceForEditor(editorA);

    assert.equal(EditorRegistry.getActive().id, 'A');
    assert.equal(EditorRegistry.getActive().element, editorA);
});

test('_activateSurfaceForEditor: DI-seam — поверхность биндится на ВЫЗВАВШИЙ менеджер, не на singleton', () => {
    const mgr = makeManager();
    let flushed = false;
    mgr.flushActiveEditor = () => { flushed = true; };
    const editorA = fakeEditor('A');

    mgr._activateSurfaceForEditor(editorA);
    EditorRegistry.getActive().commit();

    assert.equal(flushed, true, 'surface.commit() не дошёл до flushActiveEditor вызвавшего менеджера');
});

test('ownership-guard: стейл-деактивация A при активном B не чистит реестр', () => {
    const mgr = makeManager();
    const editorA = fakeEditor('A');
    const editorB = fakeEditor('B');

    mgr._activateSurfaceForEditor(editorA);
    mgr._activateSurfaceForEditor(editorB);
    mgr._clearSurfaceIfOwned(editorA);

    assert.equal(EditorRegistry.getActive().id, 'B', 'стейл-блюр A затёр активную поверхность B');
});

test('ownership-guard: деактивация ТЕКУЩИМ владельцем чистит реестр', () => {
    const mgr = makeManager();
    const editorB = fakeEditor('B');

    mgr._activateSurfaceForEditor(editorB);
    mgr._clearSurfaceIfOwned(editorB);

    assert.equal(EditorRegistry.getActive(), null);
});

test('handleEditorFocus (реальный обработчик): мост this.activeEditor и EditorRegistry выставляются разом', () => {
    const mgr = makeHandlerManager();
    const editorA = fakeEditor('A');

    mgr.handleEditorFocus(editorA, {});

    assert.equal(mgr.activeEditor, editorA, 'мост this.activeEditor не выставлен');
    assert.equal(EditorRegistry.getActive().id, 'A');
});

test('handleEditorBlur (реальный отложенный guard): переход A→B — стейл-блюр A не затирает реестр B', async () => {
    const mgr = makeHandlerManager();
    const editorA = fakeEditor('A');
    const editorB = fakeEditor('B');

    mgr.handleEditorFocus(editorA, {});
    mgr.handleEditorBlur(editorA, { id: 'A' }); // ставит отложенный (200мс) guard-таймер A
    mgr.handleEditorFocus(editorB, {}); // фокус ушёл на B ДО срабатывания таймера A

    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(EditorRegistry.getActive().id, 'B', 'стейл-таймер A затёр активную поверхность B');
});
