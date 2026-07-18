/**
 * Тест адаптера записи формализатора (Task 1.4.2): `_applyFormalized`
 * переводит ПЛОСКИЕ строки LLM в rich HTML перед записью в модель —
 * экранирует спецсимволы и переносы `\n` → `<br>` (зеркало `_insertCorrected`
 * в corrector-popover.js). Без адаптера `\n` не отрисовался бы, а `&`/`<` в
 * тексте LLM стали бы невалидным содержимым rich-поля.
 *
 * Единственная точка записи в модель — setViolationField (подменяется
 * шпионом); DOM-контролы карточки здесь не нужны (пустой `controls`),
 * поэтому проверяется именно запись в модель, без побочных DOM-эффектов.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Входная точка графа нарушений — как в entries/constructor.js: violation-init
// мешает rich-хелперы в прототип ViolationManager (см. violation-rich-fields.test.mjs).
import '../../static/js/constructor/violation/violation-init.js';
import { ViolationManager } from '../../static/js/constructor/violation/violation-core.js';

test('_applyFormalized: escaped HTML с <br>, пустое не пишется', () => {
    const vm = new ViolationManager();
    const calls = [];
    vm.setViolationField = (v, p, val) => { calls.push([p, val]); return true; };
    vm._applyFormalized({ id: 'v1', reasons: { enabled: false, content: '' } }, {}, {
        violated: 'Ромашка & Ко\nстрока2', established: '', reasons: 'причина',
    });
    const m = Object.fromEntries(calls);
    assert.equal(m['violated'], 'Ромашка &amp; Ко<br>строка2');
    assert.ok(!('established' in m));
    assert.equal(m['reasons.enabled'], true);
    assert.equal(m['reasons.content'], 'причина');
});
