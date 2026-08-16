/**
 * Task 0.4 / Task 5 (A1): editor-agnostic тулбар — attachToolbarTo/detachToolbar/
 * _applyToolbarPolicy. Task 5 схлопнула выравнивание и списки в дропдауны
 * (align/lists из SURFACE_POLICY больше не гасят отдельные .toolbar-btn — этих
 * кнопок у justifyLeft/insertOrderedList и подобных больше нет, они стали
 * пунктами меню. Политика
 * теперь блокирует ЦЕЛИКОМ триггер дропдауна alignTrigger/listsTrigger — это
 * закрывает доступ ко всем пунктам его меню разом).
 * Для textblock/violationField выключение видно только по createFootnote
 * (footnotes:false у violationField) — это доказывает механизм для будущих
 * Фаз 1/2 ('cell' в SURFACE_POLICY пока нет). align:false/lists:false
 * проверяются отдельно синтетической мутацией SURFACE_POLICY.textblock.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';
import '../../static/js/constructor/textblock/textblock-toolbar.js';
import { SURFACE_POLICY } from '../../static/js/constructor/textblock/editor-registry.js';

// Полный набор data-command ВЕРХНЕУРОВНЕВЫХ кнопок реального тулбара
// (initGlobalToolbar) ПОСЛЕ схлопывания Task 5: выравнивание и списки ушли в
// дропдауны align/lists — отдельных .toolbar-btn[data-command] у них больше нет.
const ALL_COMMANDS = [
    'bold', 'italic', 'underline', 'strikeThrough',
    'createLink', 'createFootnote', 'removeFormat', 'findReplace', 'improveText',
];

// Триггеры дропдаунов, которые политика блокирует ЦЕЛИКОМ (id → ключ SURFACE_POLICY).
const DROPDOWN_TRIGGER_IDS = ['alignTrigger', 'listsTrigger'];

function makeButton(command) {
    return { dataset: { command }, disabled: false };
}

function makeTrigger(id) {
    return { id, disabled: false };
}

function makeToolbarStub() {
    const buttons = ALL_COMMANDS.map(makeButton);
    const triggers = Object.fromEntries(DROPDOWN_TRIGGER_IDS.map(id => [id, makeTrigger(id)]));
    return {
        buttons,
        triggers,
        querySelectorAll: () => buttons,
        querySelector: (sel) => triggers[sel.replace('#', '')] || null,
    };
}

function makeManager() {
    const mgr = Object.create(TextBlockManager.prototype);
    mgr.globalToolbar = makeToolbarStub();
    return mgr;
}

function disabledCommands(mgr) {
    return mgr.globalToolbar.buttons.filter(b => b.disabled).map(b => b.dataset.command);
}

function disabledTriggers(mgr) {
    return Object.values(mgr.globalToolbar.triggers).filter(t => t.disabled).map(t => t.id);
}

test('_applyToolbarPolicy: textblock — ни одна кнопка/дропдаун не выключены', () => {
    const mgr = makeManager();
    mgr._applyToolbarPolicy({ kind: 'textblock' });
    assert.deepEqual(disabledCommands(mgr), []);
    assert.deepEqual(disabledTriggers(mgr), []);
});

test('_applyToolbarPolicy: violationField — сноски выключены, остальное включено', () => {
    const mgr = makeManager();
    mgr._applyToolbarPolicy({ kind: 'violationField' });
    assert.deepEqual(disabledCommands(mgr), ['createFootnote']);
    assert.deepEqual(disabledTriggers(mgr), []);
});

test('_applyToolbarPolicy: align:false — блокирует ТОЛЬКО alignTrigger (дропдаун целиком)', () => {
    const mgr = makeManager();
    const orig = SURFACE_POLICY.textblock.align;
    SURFACE_POLICY.textblock.align = false;
    try {
        mgr._applyToolbarPolicy({ kind: 'textblock' });
        assert.deepEqual(disabledTriggers(mgr), ['alignTrigger']);
        assert.deepEqual(disabledCommands(mgr), []);
    } finally {
        SURFACE_POLICY.textblock.align = orig;
    }
});

test('_applyToolbarPolicy: lists:false — блокирует ТОЛЬКО listsTrigger (дропдаун целиком)', () => {
    const mgr = makeManager();
    const orig = SURFACE_POLICY.textblock.lists;
    SURFACE_POLICY.textblock.lists = false;
    try {
        mgr._applyToolbarPolicy({ kind: 'textblock' });
        assert.deepEqual(disabledTriggers(mgr), ['listsTrigger']);
        assert.deepEqual(disabledCommands(mgr), []);
    } finally {
        SURFACE_POLICY.textblock.lists = orig;
    }
});

test('_applyToolbarPolicy: неизвестный surface.kind — политика не применяется, ничего не трогаем', () => {
    const mgr = makeManager();
    mgr._applyToolbarPolicy({ kind: 'unknownKind' });
    assert.deepEqual(disabledCommands(mgr), []);
    assert.deepEqual(disabledTriggers(mgr), []);
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
