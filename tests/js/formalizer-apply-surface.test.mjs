/**
 * Раскладка ответа формализатора по блочным полям нарушения
 * (`_applyFormalized`, спека §3.5/§4.х).
 *
 * Контракт (после ревью №2): значения ответа — ВСЕГДА готовый HTML (бэк уже
 * экранировал текст модели, перевёл `\n` в `<br>` и отдал перечисления
 * `<ul><li>`). Фронт эвристику «есть `<` → это разметка» больше не применяет:
 * значение только санитизируется профилем 'acts' и уходит НОВЫМ текст-блоком в
 * конец своего поля (существующие блоки не перезаписываются), поле включается.
 * Пустое извлечение поле не трогает. Метод возвращает число заполненных полей —
 * по нему панель-формализатор решает, объявлять ли успех.
 *
 * Записи идут мутаторами (setFieldEnabled/addBlock), перерисовку секции ведёт
 * ItemsRenderer.updateViolation — оба подменяются шпионами. DOMPurify в node без
 * DOM не поднимается — фейк ниже фиксирует контракт (что долетает до sanitize).
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
import { SAFE_HTML_PROFILES } from '../../static/js/shared/sanitize.js';

let rerenders = [];
let previewCalls = [];
let sanitizeCalls = [];
ItemsRenderer.updateViolation = (id) => rerenders.push(id);
PreviewManager.updateBlock = (kind, id) => previewCalls.push({ kind, id });

/**
 * Фейк DOMPurify.sanitize: журналирует вызовы и режет теги вне ALLOWED_TAGS
 * профиля (текст внутри сохраняется, как у настоящего DOMPurify).
 */
globalThis.window.DOMPurify = {
    sanitize: (html, cfg) => {
        sanitizeCalls.push({ html, cfg });
        return String(html).replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (match, tag) => (
            cfg && Array.isArray(cfg.ALLOWED_TAGS) && cfg.ALLOWED_TAGS.includes(tag.toLowerCase())
                ? match
                : ''
        ));
    },
};

/** Нарушение дефолт-формы (10 полей {enabled, blocks}). */
function makeViolation() {
    rerenders = [];
    previewCalls = [];
    sanitizeCalls = [];
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

    const applied = vm._applyFormalized(violation, { measures: 'Приняты меры' });

    assert.equal(applied, 1, 'вернулось число заполненных полей');
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

test('значение идёт в блок через санитайзер профиля acts', () => {
    const vm = makeVm();
    const violation = makeViolation();

    vm._applyFormalized(violation, { violated: 'П. 3.1 Регламента' });

    assert.equal(sanitizeCalls.length, 1, 'значение прошло через санитайзер ровно раз');
    assert.equal(sanitizeCalls[0].cfg, SAFE_HTML_PROFILES.acts, 'профиль acts');
    assert.equal(sanitizeCalls[0].html, 'П. 3.1 Регламента');
});

test('готовый HTML бэка не перекодируется: сущности и <br> остаются как есть', () => {
    const vm = makeVm();
    const violation = makeViolation();

    // Ровно то, что отдаёт бэк для текста «Ромашка & Ко\nстрока2».
    vm._applyFormalized(violation, { violated: 'Ромашка &amp; Ко<br>строка2' });

    assert.equal(
        violation.violated.blocks[0].content,
        'Ромашка &amp; Ко<br>строка2',
        'повторного экранирования нет — иначе пользователь увидел бы &amp;amp;',
    );
});

test('готовый HTML формализатора (список <ul>) остаётся списком', () => {
    const vm = makeVm();
    const violation = makeViolation();
    const html = '<ul><li>первая причина</li><li>вторая причина</li></ul>';

    vm._applyFormalized(violation, { reasons: html });

    assert.equal(violation.reasons.blocks[0].content, html, 'разрешённые теги уцелели');
    assert.equal(violation.reasons.enabled, true);
});

test('разметка вне профиля acts вырезается санитайзером', () => {
    const vm = makeVm();
    const violation = makeViolation();

    vm._applyFormalized(violation, {
        established: '<img src="http://evil.example/p.gif" onerror="alert(1)">видимый текст',
    });

    const content = violation.established.blocks[0].content;
    assert.ok(!content.includes('<img'), 'img не в allowlist профиля acts');
    assert.ok(!content.includes('onerror'), 'on*-вектор не доехал до модели');
    assert.ok(content.includes('видимый текст'), 'видимый текст сохранён');
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

test('пустое извлечение поле не трогает (ни блока, ни включения), applied = 0', () => {
    const vm = makeVm();
    const violation = makeViolation();

    const applied = vm._applyFormalized(violation, {
        violated: '   ', reasons: '', measures: null,
    });

    assert.equal(applied, 0, 'применять было нечего');
    assert.equal(violation.violated.blocks.length, 0);
    assert.equal(violation.reasons.blocks.length, 0);
    assert.equal(violation.reasons.enabled, false, 'пустое поле не включается');
    assert.deepEqual(rerenders, [], 'перерисовки нет — писать было нечего');
    assert.deepEqual(previewCalls, []);
});

test('все шесть полей ответа раскладываются по своим контейнерам', () => {
    const vm = makeVm();
    const violation = makeViolation();

    const applied = vm._applyFormalized(violation, {
        violated: 'н', established: 'у', reasons: 'п',
        measures: 'м', consequences: 'по', responsible: 'о',
    });

    assert.equal(applied, 6);
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

test('ключи вне реестра полей игнорируются (recommendations и прочее)', () => {
    const vm = makeVm();
    const violation = makeViolation();

    // recommendations — массив; попади он в раскладку, .trim() бросил бы TypeError.
    const applied = vm._applyFormalized(violation, {
        violated: 'н',
        recommendations: ['Уточните дату.', 'Укажите ответственных.'],
        unknownField: 'мусор',
    });

    assert.equal(applied, 1, 'применено только поле реестра');
    assert.equal(violation.violated.blocks.length, 1);
});
