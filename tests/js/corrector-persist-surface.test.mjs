/**
 * Task 0.5: корректор персистит через активную поверхность EditorRegistry,
 * а не хардкодит textBlockManager.finalizeEdit. Fallback — если активной
 * поверхности нет (EditorRegistry пуст), поведение остаётся прежним.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CorrectorPopover } from '../../static/js/constructor/text-actions/corrector-popover.js';
import { EditorRegistry } from '../../static/js/constructor/textblock/editor-registry.js';
import { textBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';

test('_accept персистит через активную поверхность (persist), не хардкод finalizeEdit', async () => {
  const persisted=[];
  EditorRegistry.setActive({ kind:'textblock', id:'tb1', element:{}, persist(){persisted.push('persist');} });
  Object.assign(CorrectorPopover, { _corrected:'исправлено', _editor:{dataset:{textBlockId:'tb1'}},
    _range:{deleteContents(){},insertNode(){},startContainer:{},endContainer:{}},
    _destructive:false, _sourceText:'исправлено',
    _rangeText(){return 'исправлено';}, _insertCorrected(){}, close(){} });
  await CorrectorPopover._accept();
  assert.deepEqual(persisted, ['persist']); EditorRegistry.clear();
});

test('_accept: нет активной поверхности — fallback на textBlockManager.finalizeEdit(editor)', async () => {
  EditorRegistry.clear();
  const editor = { dataset: { textBlockId: 'tb2' } };
  const calls = [];
  const origFinalize = textBlockManager.finalizeEdit;
  textBlockManager.finalizeEdit = (ed) => calls.push(ed);
  try {
    Object.assign(CorrectorPopover, { _corrected:'исправлено', _editor: editor,
      _range:{deleteContents(){},insertNode(){},startContainer:{},endContainer:{}},
      _destructive:false, _sourceText:'исправлено',
      _rangeText(){return 'исправлено';}, _insertCorrected(){}, close(){} });
    await CorrectorPopover._accept();
    assert.deepEqual(calls, [editor]);
  } finally {
    textBlockManager.finalizeEdit = origFinalize;
  }
});
