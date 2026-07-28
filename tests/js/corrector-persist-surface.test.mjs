/**
 * Пункт 1 (#1 HIGH): корректор коммитит принятую правку в поверхность-владельца
 * редактируемого поля, ЗАХВАЧЕННУЮ при открытии, а не в EditorRegistry.getActive()
 * на момент клика «Принять».
 *
 * Два сценария молчаливой потери правки поля A (были дефектом):
 *  (а) во время LLM-запроса пользователь кликнул в поле B → getActive()=B;
 *  (б) поле A потеряло фокус без нового активного → Registry пуст.
 * В обоих правка поля A обязана уйти в его модель (persist поверхности-владельца),
 * поле B — нетронуто, а тост «Текст исправлен» показывается ТОЛЬКО при реальном
 * коммите. Текстблок (dataset.textBlockId) коммитится прежним путём finalizeEdit.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CorrectorPopover } from '../../static/js/constructor/text-actions/corrector-popover.js';
import { EditorRegistry } from '../../static/js/constructor/textblock/editor-registry.js';
import { textBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';
import { Notifications } from '../../static/js/shared/notifications.js';

// Поверхность-владелец поля нарушения (без dataset.textBlockId): persist()
// фиксирует факт коммита в модель.
function makeViolationSurface(id) {
    const editor = { dataset: {} };            // violation-поле: НЕТ textBlockId
    const surface = {
        kind: 'violationField', id, element: editor,
        persisted: false, persist() { this.persisted = true; },
    };
    return { surface, editor };
}

// Готовит внутреннее состояние корректора как после успешного запроса, минуя
// DOM-heavy open()/_build() (node-стаб не парсит innerHTML). _rangeText отдаёт
// _sourceText → гейт «текст изменён» не срабатывает; _insertCorrected — no-op.
function primeAccept(editor, ownerSurface) {
    Object.assign(CorrectorPopover, {
        _corrected: 'исправлено', _editor: editor, _ownerSurface: ownerSurface,
        _range: { deleteContents() {}, insertNode() {}, startContainer: {}, endContainer: {} },
        _destructive: false, _sourceText: 'исходно',
        _rangeText() { return 'исходно'; }, _insertCorrected() {}, close() {},
    });
}

// Считает вызовы тостов на время одного _accept (Notifications — синглтон).
async function acceptWithToastSpy() {
    const calls = { success: 0, error: 0 };
    const s = Notifications.success;
    const e = Notifications.error;
    Notifications.success = () => { calls.success++; };
    Notifications.error = () => { calls.error++; };
    try {
        await CorrectorPopover._accept();
    } finally {
        Notifications.success = s;
        Notifications.error = e;
    }
    return calls;
}

test('пункт1(а): активна ДРУГАЯ поверхность — коммит в поле-владельца A, B нетронуто', async () => {
    const { surface: sA, editor: eA } = makeViolationSurface('viol:vA:violated');
    const { surface: sB } = makeViolationSurface('viol:vB:violated');
    EditorRegistry.setActive(sB);              // пользователь кликнул в поле B
    primeAccept(eA, sA);                        // владелец, захваченный при открытии — A
    try {
        const calls = await acceptWithToastSpy();
        assert.equal(sA.persisted, true, 'модель поля A обновлена');
        assert.equal(sB.persisted, false, 'поле B не тронуто');
        assert.equal(calls.success, 1, 'тост успеха — при реальном коммите');
        assert.equal(calls.error, 0);
    } finally {
        EditorRegistry.clear();
    }
});

test('пункт1(б): Registry пуст (поле потеряло фокус) — коммит в поле-владельца A', async () => {
    const { surface: sA, editor: eA } = makeViolationSurface('viol:vA:violated');
    EditorRegistry.clear();
    primeAccept(eA, sA);
    const calls = await acceptWithToastSpy();
    assert.equal(sA.persisted, true, 'модель поля A обновлена, а не потеряна');
    assert.equal(calls.success, 1);
    assert.equal(calls.error, 0);
});

test('пункт1(в): владелец не захвачен/отвязан — честная ошибка, тост успеха НЕ показан', async () => {
    const { editor: eA } = makeViolationSurface('viol:vA:violated');
    EditorRegistry.clear();
    primeAccept(eA, null);                      // поверхность-владелец недоступна
    const calls = await acceptWithToastSpy();
    assert.equal(calls.success, 0, 'успех не выдаётся за неуспешный коммит');
    assert.equal(calls.error, 1, 'показана честная ошибка');
});

test('пункт1: текстблок (dataset.textBlockId) — коммит прежним путём finalizeEdit(editor)', async () => {
    const editor = { dataset: { textBlockId: 'tb1' } };
    const calls = [];
    const orig = textBlockManager.finalizeEdit;
    textBlockManager.finalizeEdit = (ed) => calls.push(ed);
    try {
        primeAccept(editor, null);
        await CorrectorPopover._accept();
        assert.deepEqual(calls, [editor], 'текстблок идёт через finalizeEdit, не через поверхность');
    } finally {
        textBlockManager.finalizeEdit = orig;
    }
});

test('пункт1: _resolveOwnerSurface захватывает getActive() только при element===editor', () => {
    const editor = { dataset: {} };
    const owner = { element: editor, persist() {} };
    EditorRegistry.setActive(owner);
    assert.equal(CorrectorPopover._resolveOwnerSurface(editor), owner);
    EditorRegistry.setActive({ element: { dataset: {} }, persist() {} });
    assert.equal(CorrectorPopover._resolveOwnerSurface(editor), null, 'чужая активная поверхность не захватывается');
    EditorRegistry.clear();
    assert.equal(CorrectorPopover._resolveOwnerSurface(editor), null, 'пустой Registry → null');
});
