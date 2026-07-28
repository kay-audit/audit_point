/**
 * Пункт 2 (#7 + S4): `_applyFormalized` пишет извлечённые поля через
 * поверхность (setContent) — это делает setContent продовым путём (был S4) и
 * после записи снимает placeholder-класс `textblock-editor--empty` (#7: иначе
 * CSS-плейсхолдер «Опишите нарушение…» оставался серым префиксом перед реальным
 * текстом). Пустой результат формализатора («не извлечено») поле НЕ трогает.
 *
 * renderActContent под node-стабом (без DOMPurify) пишет в element.textContent
 * (fallback), поэтому проверяем DOM через textContent — как в
 * violation-rich-surface.test.mjs.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../static/js/constructor/violation/violation-init.js';
import { ViolationManager } from '../../static/js/constructor/violation/violation-core.js';

// Фейковое rich-поле с трекингом класса и textContent (renderActContent-фолбэк
// пишет в textContent). classList поверх Set — чтобы проверять наличие класса.
function makeFieldDiv(initialClasses = []) {
    const classes = new Set(initialClasses);
    return {
        textContent: '',
        querySelector: () => null,
        querySelectorAll: () => [],
        classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            toggle: (c, force) => {
                const on = force === undefined ? !classes.has(c) : !!force;
                if (on) classes.add(c); else classes.delete(c);
                return on;
            },
            contains: (c) => classes.has(c),
        },
    };
}

// Контейнер опционального поля: querySelector отдаёт чекбокс/контент/fieldDiv
// по селекторам, которые читает setOptional.
function makeOptionalContainer(fieldDiv) {
    const cb = { checked: false };
    const content = { style: { display: 'none' } };
    return {
        _cb: cb,
        _content: content,
        querySelector: (sel) => {
            if (sel.includes('checkbox')) return cb;
            if (sel === '.violation-field-content') return content;
            if (sel.includes('.violation-field')) return fieldDiv;
            return null;
        },
    };
}

test('пункт2: формализатор на пустом поле — после Применить класс --empty снят, контент в DOM', () => {
    const vm = new ViolationManager();
    vm.setViolationField = () => true;
    const fieldDiv = makeFieldDiv(['textblock-editor--empty']);

    vm._applyFormalized({ id: 'v1' }, { violated: fieldDiv }, { violated: 'Текст нарушения' });

    assert.equal(fieldDiv.classList.contains('textblock-editor--empty'), false,
        'placeholder-класс снят — плейсхолдер не перекрывает реальный текст');
    assert.equal(fieldDiv.textContent, 'Текст нарушения', 'контент отрисован в поле');
});

test('пункт2: заполненное поле — контент обновлён (модель + DOM), спецсимволы экранированы', () => {
    const vm = new ViolationManager();
    const model = [];
    vm.setViolationField = (v, p, val) => { model.push([p, val]); return true; };
    const fieldDiv = makeFieldDiv([]);
    fieldDiv.textContent = 'старое';

    vm._applyFormalized({ id: 'v1' }, { violated: fieldDiv }, { violated: 'новое & <b>' });

    assert.equal(fieldDiv.textContent, 'новое &amp; &lt;b&gt;', 'DOM обновлён экранированным html');
    assert.deepEqual(model, [['violated', 'новое &amp; &lt;b&gt;']], 'модель получила экранированный html через setContent');
});

test('пункт2: опциональное поле — enable выставлен, контент записан, класс --empty снят', () => {
    const vm = new ViolationManager();
    const model = [];
    vm.setViolationField = (v, p, val) => { model.push([p, val]); return true; };
    const fieldDiv = makeFieldDiv(['textblock-editor--empty']);
    const container = makeOptionalContainer(fieldDiv);

    vm._applyFormalized({ id: 'v1' }, { measures: container }, { measures: 'Приняты меры' });

    assert.equal(container._cb.checked, true, 'чекбокс поля включён');
    assert.equal(container._content.style.display, 'block', 'контейнер поля раскрыт');
    assert.equal(fieldDiv.classList.contains('textblock-editor--empty'), false, 'placeholder-класс снят');
    assert.equal(fieldDiv.textContent, 'Приняты меры', 'контент отрисован');
    assert.deepEqual(model, [['measures.enabled', true], ['measures.content', 'Приняты меры']],
        'модель получила enable и content');
});

test('пункт2: пустой результат формализатора — поле НЕ тронуто (не затираем существующее)', () => {
    const vm = new ViolationManager();
    const model = [];
    vm.setViolationField = (v, p, val) => { model.push([p, val]); return true; };
    const fieldDiv = makeFieldDiv([]);
    fieldDiv.textContent = 'существующий текст';

    vm._applyFormalized({ id: 'v1' }, { violated: fieldDiv }, { violated: '   ' });

    assert.equal(fieldDiv.textContent, 'существующий текст', 'DOM не тронут');
    assert.deepEqual(model, [], 'модель не тронута');
});
