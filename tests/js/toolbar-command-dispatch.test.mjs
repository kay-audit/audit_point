/**
 * Task 5 (A1): _runToolbarCommand — общий диспатч команды тулбара, вынесенный
 * из click-листенера обычных .toolbar-btn (textblock-toolbar.js:196-202), чтобы
 * пункты новых дропдаунов (выравнивание/списки: justifyLeft/…/insertOrderedList/
 * indent/outdent) уходили В ТУ ЖЕ ветку, а не дублировали findReplace/
 * improveText/createLink/createFootnote спецкейсы и общий хвост
 * (focus + applyFormattingToNewNodes + updateToolbarState).
 *
 * Плюс _updateAlignTriggerState/_updateListsTriggerState — триггеры новых
 * дропдаунов отражают состояние через queryCommandState, как раньше это делали
 * отдельные кнопки justifyLeft/insertOrderedList и т.п. (updateToolbarState).
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';
import '../../static/js/constructor/textblock/textblock-toolbar.js';
import { Notifications } from '../../static/js/shared/notifications.js';
import { FindBar } from '../../static/js/constructor/search/find-bar.js';
import { CorrectorPopover } from '../../static/js/constructor/text-actions/corrector-popover.js';

function makeManager() {
    const mgr = Object.create(TextBlockManager.prototype);
    mgr.activeEditor = { focus() {} };
    mgr.applyFormattingToNewNodes = () => {};
    mgr.updateToolbarState = () => {};
    mgr.hideToolbar = () => {};
    return mgr;
}

// ── _runToolbarCommand: ветка execCommand (кнопки формата + пункты дропдаунов) ──

test('_runToolbarCommand("bold"): execCommand + хвост (focus/applyFormattingToNewNodes/updateToolbarState)', () => {
    const mgr = makeManager();
    const calls = [];
    mgr.execCommand = (cmd) => { calls.push(['execCommand', cmd]); return true; };
    mgr.activeEditor.focus = () => calls.push(['focus']);
    mgr.applyFormattingToNewNodes = (ed) => calls.push(['applyFormattingToNewNodes', ed]);
    mgr.updateToolbarState = () => calls.push(['updateToolbarState']);

    mgr._runToolbarCommand('bold');

    assert.deepEqual(calls, [
        ['execCommand', 'bold'],
        ['focus'],
        ['applyFormattingToNewNodes', mgr.activeEditor],
        ['updateToolbarState'],
    ]);
});

test('_runToolbarCommand: пункты дропдаунов (justify*/insert*List/indent/outdent) уходят в ТУ ЖЕ ветку execCommand', () => {
    for (const command of ['justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull',
        'insertUnorderedList', 'insertOrderedList', 'indent', 'outdent', 'removeFormat']) {
        const mgr = makeManager();
        const execCalls = [];
        mgr.execCommand = (cmd) => execCalls.push(cmd);
        mgr._runToolbarCommand(command);
        assert.deepEqual(execCalls, [command], `${command} должен уйти в execCommand`);
    }
});

test('_runToolbarCommand("createLink"): вызывает createOrEditLink, НЕ execCommand', () => {
    const mgr = makeManager();
    const calls = [];
    mgr.createOrEditLink = () => calls.push('createOrEditLink');
    mgr.execCommand = () => calls.push('execCommand');
    mgr._runToolbarCommand('createLink');
    assert.deepEqual(calls, ['createOrEditLink']);
});

test('_runToolbarCommand("createFootnote"): вызывает createOrEditFootnote, НЕ execCommand', () => {
    const mgr = makeManager();
    const calls = [];
    mgr.createOrEditFootnote = () => calls.push('createOrEditFootnote');
    mgr.execCommand = () => calls.push('execCommand');
    mgr._runToolbarCommand('createFootnote');
    assert.deepEqual(calls, ['createOrEditFootnote']);
});

test('_runToolbarCommand("findReplace"): открывает FindBar с префиллом выделения, хвост НЕ выполняется', () => {
    const mgr = makeManager();
    const calls = [];
    mgr.execCommand = () => calls.push('execCommand');
    mgr.updateToolbarState = () => calls.push('updateToolbarState');
    mgr.hideToolbar = () => calls.push('hideToolbar');
    const origPrefill = FindBar._selectionPrefill;
    const origOpen = FindBar.open;
    FindBar._selectionPrefill = () => 'префилл';
    FindBar.open = (prefill) => calls.push(['FindBar.open', prefill]);
    try {
        mgr._runToolbarCommand('findReplace');
    } finally {
        FindBar._selectionPrefill = origPrefill;
        FindBar.open = origOpen;
    }
    assert.deepEqual(calls, ['hideToolbar', ['FindBar.open', 'префилл']]);
});

test('_runToolbarCommand("improveText") без выделения: тост, CorrectorPopover НЕ открывается', () => {
    const mgr = makeManager();
    const calls = [];
    const origInfo = Notifications.info;
    const origOpen = CorrectorPopover.open;
    Notifications.info = (m) => calls.push(['info', m]);
    CorrectorPopover.open = () => calls.push('open');
    globalThis.getSelection = () => ({ isCollapsed: true });
    try {
        mgr._runToolbarCommand('improveText');
    } finally {
        Notifications.info = origInfo;
        CorrectorPopover.open = origOpen;
        delete globalThis.getSelection;
    }
    assert.deepEqual(calls, [['info', 'Выделите текст для корректуры']]);
});

test('_runToolbarCommand("improveText") с выделением: открывает CorrectorPopover с editor/range/text', () => {
    const mgr = makeManager();
    const calls = [];
    const origOpen = CorrectorPopover.open;
    CorrectorPopover.open = (args) => calls.push(args);
    const range = { cloned: true };
    globalThis.getSelection = () => ({
        isCollapsed: false,
        toString: () => 'выделенный текст',
        getRangeAt: () => ({ cloneRange: () => range }),
    });
    try {
        mgr._runToolbarCommand('improveText');
    } finally {
        CorrectorPopover.open = origOpen;
        delete globalThis.getSelection;
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].editor, mgr.activeEditor);
    assert.equal(calls[0].range, range);
    assert.equal(calls[0].text, 'выделенный текст');
});

// ── _updateAlignTriggerState / _updateListsTriggerState ──────────────────────

function makeClassList() {
    const set = new Set();
    return {
        add: (c) => set.add(c),
        remove: (c) => set.delete(c),
        toggle: (c, on) => { if (on) set.add(c); else set.delete(c); },
        contains: (c) => set.has(c),
    };
}

/** Пункт меню дропдауна: dataset + classList + setAttribute/getAttribute (aria-disabled). */
function makeOption(command) {
    const attrs = {};
    return {
        dataset: { command },
        classList: makeClassList(),
        setAttribute(k, v) { attrs[k] = String(v); },
        getAttribute(k) { return attrs[k] ?? null; },
    };
}

test('_updateAlignTriggerState: иконка триггера и активный пункт меню отражают текущее выравнивание', () => {
    const mgr = makeManager();
    const icon = { textContent: '' };
    const trigger = { querySelector: (s) => (s === '.toolbar-dropdown-icon' ? icon : null) };
    const options = ['justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull']
        .map(command => ({ dataset: { command }, classList: makeClassList() }));
    const menu = { querySelectorAll: () => options };
    mgr.globalToolbar = {
        querySelector: (sel) => (sel === '#alignTrigger' ? trigger : sel === '#alignMenu' ? menu : null),
    };
    mgr.queryCommandState = (cmd) => cmd === 'justifyCenter';

    mgr._updateAlignTriggerState();

    assert.equal(icon.textContent, '▥');
    assert.deepEqual(options.map(o => o.classList.contains('active')), [false, true, false, false]);
});

test('_updateAlignTriggerState: ни один justify* не активен → дефолт "по левому краю"', () => {
    const mgr = makeManager();
    const icon = { textContent: '' };
    const trigger = { querySelector: () => icon };
    const options = ['justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull']
        .map(command => ({ dataset: { command }, classList: makeClassList() }));
    const menu = { querySelectorAll: () => options };
    mgr.globalToolbar = {
        querySelector: (sel) => (sel === '#alignTrigger' ? trigger : sel === '#alignMenu' ? menu : null),
    };
    mgr.queryCommandState = () => false;

    mgr._updateAlignTriggerState();

    assert.equal(icon.textContent, '◧');
});

test('_updateListsTriggerState: insertOrderedList активен — триггер и пункт подсвечены', () => {
    const mgr = makeManager();
    const trigger = { classList: makeClassList() };
    const options = ['insertUnorderedList', 'insertOrderedList', 'indent', 'outdent'].map(makeOption);
    const menu = { querySelectorAll: () => options };
    mgr.globalToolbar = {
        querySelector: (sel) => (sel === '#listsTrigger' ? trigger : sel === '#listsMenu' ? menu : null),
    };
    mgr.queryCommandState = (cmd) => cmd === 'insertOrderedList';

    mgr._updateListsTriggerState();

    assert.equal(trigger.classList.contains('active'), true);
    assert.deepEqual(options.map(o => o.classList.contains('active')), [false, true, false, false]);
});

// ── Доделка: indent/outdent неактивны вне <li> (execCommand их тихо гасит —
// кликабельный, но безответный пункт меню читается как баг) ─────────────────

test('_updateListsTriggerState: каретка ВНЕ <li> — indent/outdent получают aria-disabled="true"', () => {
    const mgr = makeManager();
    const trigger = { classList: makeClassList() };
    const options = ['insertUnorderedList', 'insertOrderedList', 'indent', 'outdent'].map(makeOption);
    const menu = { querySelectorAll: () => options };
    mgr.globalToolbar = {
        querySelector: (sel) => (sel === '#listsTrigger' ? trigger : sel === '#listsMenu' ? menu : null),
    };
    mgr.queryCommandState = () => false;
    mgr._listItemAncestor = () => null; // каретка вне списка
    globalThis.getSelection = () => ({ rangeCount: 1, getRangeAt: () => ({ startContainer: {} }) });

    try {
        mgr._updateListsTriggerState();
    } finally {
        delete globalThis.getSelection;
    }

    const byCommand = Object.fromEntries(options.map(o => [o.dataset.command, o]));
    assert.equal(byCommand.indent.getAttribute('aria-disabled'), 'true');
    assert.equal(byCommand.outdent.getAttribute('aria-disabled'), 'true');
    // insertUnorderedList/insertOrderedList — не пункты уровня, aria-disabled их не касается.
    assert.equal(byCommand.insertUnorderedList.getAttribute('aria-disabled'), null);
    assert.equal(byCommand.insertOrderedList.getAttribute('aria-disabled'), null);
});

test('_updateListsTriggerState: каретка ВНУТРИ <li> — indent/outdent получают aria-disabled="false"', () => {
    const mgr = makeManager();
    const trigger = { classList: makeClassList() };
    const options = ['insertUnorderedList', 'insertOrderedList', 'indent', 'outdent'].map(makeOption);
    const menu = { querySelectorAll: () => options };
    mgr.globalToolbar = {
        querySelector: (sel) => (sel === '#listsTrigger' ? trigger : sel === '#listsMenu' ? menu : null),
    };
    mgr.queryCommandState = () => false;
    mgr._listItemAncestor = () => ({ tagName: 'LI' }); // каретка в списке
    globalThis.getSelection = () => ({ rangeCount: 1, getRangeAt: () => ({ startContainer: {} }) });

    try {
        mgr._updateListsTriggerState();
    } finally {
        delete globalThis.getSelection;
    }

    const byCommand = Object.fromEntries(options.map(o => [o.dataset.command, o]));
    assert.equal(byCommand.indent.getAttribute('aria-disabled'), 'false');
    assert.equal(byCommand.outdent.getAttribute('aria-disabled'), 'false');
});

test('_updateListsTriggerState: без _listItemAncestor (миксин editor-levels не загружен) — indent/outdent НЕ падают, aria-disabled="true"', () => {
    const mgr = makeManager();
    const trigger = { classList: makeClassList() };
    const options = ['indent', 'outdent'].map(makeOption);
    const menu = { querySelectorAll: () => options };
    mgr.globalToolbar = {
        querySelector: (sel) => (sel === '#listsTrigger' ? trigger : sel === '#listsMenu' ? menu : null),
    };
    mgr.queryCommandState = () => false;
    // mgr._listItemAncestor намеренно НЕ определён

    assert.doesNotThrow(() => mgr._updateListsTriggerState());

    const byCommand = Object.fromEntries(options.map(o => [o.dataset.command, o]));
    assert.equal(byCommand.indent.getAttribute('aria-disabled'), 'true');
    assert.equal(byCommand.outdent.getAttribute('aria-disabled'), 'true');
});

test('_updateListsTriggerState: каретка вне списка — триггер и пункты неактивны', () => {
    const mgr = makeManager();
    const trigger = { classList: makeClassList() };
    trigger.classList.add('active'); // предзаполнено — должно сняться
    const options = ['insertUnorderedList', 'insertOrderedList']
        .map(command => ({ dataset: { command }, classList: makeClassList() }));
    const menu = { querySelectorAll: () => options };
    mgr.globalToolbar = {
        querySelector: (sel) => (sel === '#listsTrigger' ? trigger : sel === '#listsMenu' ? menu : null),
    };
    mgr.queryCommandState = () => false;

    mgr._updateListsTriggerState();

    assert.equal(trigger.classList.contains('active'), false);
    assert.deepEqual(options.map(o => o.classList.contains('active')), [false, false]);
});
