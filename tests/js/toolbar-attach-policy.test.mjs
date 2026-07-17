/**
 * Task 0.4: editor-agnostic тулбар — attachToolbarTo/detachToolbar/_applyToolbarPolicy.
 * Механизм «политика по типу поверхности»: для textblock ни одна кнопка не
 * выключается (инвариант «0 видимого эффекта» в Фазе 0), для violationField
 * (footnotes:false в SURFACE_POLICY) кнопка createFootnote выключается —
 * это доказывает механизм для будущих Фаз 1/2 ('cell' в SURFACE_POLICY пока
 * нет, поэтому синтетика здесь — violationField).
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';
import '../../static/js/constructor/textblock/textblock-toolbar.js';

// Полный набор data-command кнопок реального тулбара (initGlobalToolbar).
const ALL_COMMANDS = [
    'bold', 'italic', 'underline', 'strikeThrough',
    'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull',
    'createLink', 'createFootnote', 'removeFormat', 'findReplace', 'improveText',
];

function makeButton(command) {
    return { dataset: { command }, disabled: false };
}

function makeToolbarStub() {
    const buttons = ALL_COMMANDS.map(makeButton);
    return { buttons, querySelectorAll: () => buttons };
}

function makeManager() {
    const mgr = Object.create(TextBlockManager.prototype);
    mgr.globalToolbar = makeToolbarStub();
    return mgr;
}

function disabledCommands(mgr) {
    return mgr.globalToolbar.buttons.filter(b => b.disabled).map(b => b.dataset.command);
}

test('_applyToolbarPolicy: textblock — ни одна кнопка не выключена', () => {
    const mgr = makeManager();
    mgr._applyToolbarPolicy({ kind: 'textblock' });
    assert.deepEqual(disabledCommands(mgr), []);
});

test('_applyToolbarPolicy: violationField — сноски выключены, остальное включено', () => {
    const mgr = makeManager();
    mgr._applyToolbarPolicy({ kind: 'violationField' });
    assert.deepEqual(disabledCommands(mgr), ['createFootnote']);
});

test('attachToolbarTo: setActiveEditor + showToolbar + _applyToolbarPolicy + updateToolbarState', () => {
    const mgr = makeManager();
    const calls = [];
    mgr.setActiveEditor = (el) => calls.push(['setActiveEditor', el]);
    mgr.showToolbar = () => calls.push(['showToolbar']);
    mgr._applyToolbarPolicy = (s) => calls.push(['_applyToolbarPolicy', s]);
    mgr.updateToolbarState = () => calls.push(['updateToolbarState']);

    const surface = { kind: 'textblock', element: { id: 'editorEl' } };
    mgr.attachToolbarTo(surface);

    assert.deepEqual(calls.map(c => c[0]),
        ['setActiveEditor', 'showToolbar', '_applyToolbarPolicy', 'updateToolbarState']);
    assert.equal(calls[0][1], surface.element, 'setActiveEditor должен получить surface.element');
    assert.equal(calls[2][1], surface, '_applyToolbarPolicy должен получить весь surface');
});

test('detachToolbar: hideToolbar + clearActiveEditor', () => {
    const mgr = makeManager();
    const calls = [];
    mgr.hideToolbar = () => calls.push('hideToolbar');
    mgr.clearActiveEditor = () => calls.push('clearActiveEditor');

    mgr.detachToolbar();

    assert.deepEqual(calls, ['hideToolbar', 'clearActiveEditor']);
});
