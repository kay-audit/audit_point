import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextBlockSurface } from '../../static/js/constructor/textblock/editable-surface.js';

function makeFakeManager() {
  const calls = [];
  return { calls,
    _tb: { tb1: { id: 'tb1', content: '<p>модель</p>' } },
    getTextBlock(id) { return this._tb[id] || null; },
    saveContent(id, html) { calls.push(['save', id, html]); },
    finalizeEdit(editor) { calls.push(['finalize', editor.dataset.textBlockId]); },
    flushActiveEditor() { calls.push(['flush']); return true; } };
}
const makeEditor = (id, innerHTML) => ({ dataset: { textBlockId: id }, innerHTML });

test('поля контракта id/kind/rich/element', () => {
  const editor = makeEditor('tb1', '<p>hi</p>');
  const s = new TextBlockSurface(editor, makeFakeManager());
  assert.equal(s.id, 'tb1'); assert.equal(s.kind, 'textblock');
  assert.equal(s.rich, true); assert.equal(s.element, editor);
});
test('setContent → manager.saveContent(id, html)', () => {
  const mgr = makeFakeManager();
  new TextBlockSurface(makeEditor('tb1','x'), mgr).setContent('<p>новое</p>');
  assert.deepEqual(mgr.calls, [['save','tb1','<p>новое</p>']]);
});
test('getContent читает контент МОДЕЛИ (не live-DOM)', () => {
  const s = new TextBlockSurface(makeEditor('tb1','<p>живой</p>'), makeFakeManager());
  assert.equal(s.getContent(), '<p>модель</p>');
});
test('commit → flushActiveEditor; persist → finalizeEdit(element)', () => {
  const mgr = makeFakeManager();
  const s = new TextBlockSurface(makeEditor('tb1','x'), mgr);
  s.commit(); s.persist();
  assert.deepEqual(mgr.calls, [['flush'],['finalize','tb1']]);
});
