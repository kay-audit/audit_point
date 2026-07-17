/**
 * Task 0.3: связка focus/blur текстблок-редактора с EditorRegistry.
 * Тестируем ИЗОЛИРОВАННЫЕ методы (_activateSurfaceForEditor/_clearSurfaceIfOwned),
 * не весь handleEditorFocus/Blur — у стаба нет реального DOM, а сами обработчики
 * трогают тулбар/tooltip-навеску вне зоны ответственности Task 0.3.
 */
import './_browser-stub.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TextBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';
import '../../static/js/constructor/textblock/textblock-editor.js';
import { EditorRegistry } from '../../static/js/constructor/textblock/editor-registry.js';

beforeEach(() => EditorRegistry.clear());

function makeManager() {
    return Object.create(TextBlockManager.prototype);
}

function fakeEditor(id) {
    return { dataset: { textBlockId: id } };
}

test('_activateSurfaceForEditor регистрирует поверхность редактора в EditorRegistry', () => {
    const mgr = makeManager();
    const editorA = fakeEditor('A');

    mgr._activateSurfaceForEditor(editorA);

    assert.equal(EditorRegistry.getActive().id, 'A');
    assert.equal(EditorRegistry.getActive().element, editorA);
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
