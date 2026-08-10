/**
 * Раскладка ответа формализатора по блочным полям нарушения
 * (`_applyFormalized`, спека §3.5/§4.х).
 *
 * Контракт: каждое непустое из шести полей ответа уходит НОВЫМ текст-блоком в
 * конец своего поля (существующие блоки не перезаписываются), поле при этом
 * включается. Пустое извлечение поле не трогает. Плоская строка LLM
 * переводится в rich HTML (экранирование + \n → <br>), а готовый HTML
 * (списки `<ul>` от формализатора) пишется как есть.
 *
 * Записи идут мутаторами (setFieldEnabled/addBlock), перерисовку секции ведёт
 * ItemsRenderer.updateViolation — оба подменяются шпионами.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PreviewManager } from '../../static/js/constructor/preview/preview.js';
import { ItemsRenderer } from '../../static/js/constructor/items/items-renderer.js';
import '../../static/js/constructor/violation/violation-init.js';
import { ViolationManager } from '../../static/js/constructor/violation/violation-core.js';
import { BLOCK_TYPES } from '../../static/js/constructor/violation/violation-block-types.js';
import { createDefaultViolationShape } from '../../static/js/constructor/violation/violation-normalize.js';

let rerenders = [];
let previewCalls = [];
ItemsRenderer.updateViolation = (id) => rerenders.push(id);
PreviewManager.updateBlock = (kind, id) => previewCalls.push({ kind, id });

/** Нарушение дефолт-формы (10 полей {enabled, blocks}). */
function makeViolation() {
    rerenders = [];
    previewCalls = [];
    return { id: 'v1', nodeId: 'n1', ...createDefaultViolationShape() };
}

/** VM без read-only-гейта: реальные мутаторы, стаб перерисовки контейнера. */
function makeVm() {
    const vm = new ViolationManager();
    vm.renderBlocks = () => {};
    return vm;
}

test('непустое поле ответа → текст-блок в конце своего поля, поле включено', () => {
    const vm = makeVm();
    const violation = makeViolation();

    vm._applyFormalized(violation, { measures: 'Приняты меры' });

    assert.equal(violation.measures.enabled, true, 'опциональное поле включено');
    assert.equal(violation.measures.blocks.length, 1);
    assert.equal(violation.measures.blocks[0].type, BLOCK_TYPES.TEXT);
    assert.equal(violation.measures.blocks[0].content, 'Приняты меры');
    assert.deepEqual(rerenders, ['v1'], 'секция перерисована один раз');
    // Превью планируют и мутаторы, и явный вызов в конце; подряд идущие
    // updateBlock схлопывает RAF-дедуп PreviewManager — важно, что все они
    // адресуют именно это нарушение.
    assert.ok(previewCalls.length >= 1, 'превью запланировано');
    assert.ok(previewCalls.every((c) => c.kind === 'violation' && c.id === 'v1'));
});

test('плоская строка переводится в rich HTML: спецсимволы экранированы, \\n → <br>', () => {
    const vm = makeVm();
    const violation = makeViolation();

    vm._applyFormalized(violation, { violated: 'Ромашка & Ко\nстрока2' });

    assert.equal(violation.violated.blocks[0].content, 'Ромашка &amp; Ко<br>строка2');
});

test('готовый HTML формализатора (список <ul>) пишется как есть', () => {
    const vm = makeVm();
    const violation = makeViolation();
    const html = '<ul><li>первая причина</li><li>вторая причина</li></ul>';

    vm._applyFormalized(violation, { reasons: html });

    assert.equal(violation.reasons.blocks[0].content, html, 'HTML не экранируется повторно');
    assert.equal(violation.reasons.enabled, true);
});

test('непустое поле НЕ перезаписывается — новый блок добавляется в конец', () => {
    const vm = makeVm();
    const violation = makeViolation();
    violation.violated.blocks.push({ id: 'b0', type: BLOCK_TYPES.TEXT, content: 'старое' });

    vm._applyFormalized(violation, { violated: 'новое' });

    assert.deepEqual(
        violation.violated.blocks.map((b) => b.content),
        ['старое', 'новое'],
        'существующий блок сохранён, извлечённый добавлен следом',
    );
});

test('пустое извлечение поле не трогает (ни блока, ни включения)', () => {
    const vm = makeVm();
    const violation = makeViolation();

    vm._applyFormalized(violation, { violated: '   ', reasons: '', measures: null });

    assert.equal(violation.violated.blocks.length, 0);
    assert.equal(violation.reasons.blocks.length, 0);
    assert.equal(violation.reasons.enabled, false, 'пустое поле не включается');
    assert.deepEqual(rerenders, [], 'перерисовки нет — писать было нечего');
    assert.deepEqual(previewCalls, []);
});

test('все шесть полей ответа раскладываются по своим контейнерам', () => {
    const vm = makeVm();
    const violation = makeViolation();

    vm._applyFormalized(violation, {
        violated: 'н', established: 'у', reasons: 'п',
        measures: 'м', consequences: 'по', responsible: 'о',
    });

    for (const [key, expected] of Object.entries({
        violated: 'н', established: 'у', reasons: 'п',
        measures: 'м', consequences: 'по', responsible: 'о',
    })) {
        assert.equal(violation[key].blocks.length, 1, `${key}: ровно один блок`);
        assert.equal(violation[key].blocks[0].content, expected, `${key}: своё значение`);
        assert.equal(violation[key].enabled, true, `${key}: включено`);
    }
    assert.deepEqual(rerenders, ['v1'], 'одна перерисовка на весь ответ');
});

test('CodeMining/ProcessMining формализатор не заполняет', () => {
    const vm = makeVm();
    const violation = makeViolation();

    vm._applyFormalized(violation, { codeMining: 'CM', processMining: 'PM', violated: 'н' });

    assert.equal(violation.codeMining.blocks.length, 0);
    assert.equal(violation.processMining.blocks.length, 0);
    assert.equal(violation.codeMining.enabled, false);
});
