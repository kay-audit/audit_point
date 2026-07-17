import './_browser-stub.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EditorRegistry, SURFACE_POLICY } from '../../static/js/constructor/textblock/editor-registry.js';
beforeEach(() => EditorRegistry.clear());
function fakeSurface(){ const c=[]; return { kind:'textblock', id:'s1', element:{}, commit(){c.push('commit');}, c }; }
test('setActive/getActive/clear', () => {
  const s=fakeSurface(); EditorRegistry.setActive(s);
  assert.equal(EditorRegistry.getActive(), s);
  EditorRegistry.clear(); assert.equal(EditorRegistry.getActive(), null);
});
test('flushActive коммитит активную через commit()', () => {
  const s=fakeSurface(); EditorRegistry.setActive(s);
  EditorRegistry.flushActive(); assert.deepEqual(s.c, ['commit']);
});
test('flushActive без активной — no-op без throw', () => {
  EditorRegistry.clear(); assert.doesNotThrow(() => EditorRegistry.flushActive());
});
test('SURFACE_POLICY: textblock всё включено; violationField — footnotes off', () => {
  assert.equal(SURFACE_POLICY.textblock.footnotes, true);
  assert.equal(SURFACE_POLICY.violationField.footnotes, false);
  assert.equal(SURFACE_POLICY.violationField.improveText, true);
});
