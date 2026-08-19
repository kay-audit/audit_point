/**
 * Идемпотентность DialogBase._hideDialog (баг: кнопка «Помощь» переставала
 * открывать модалку после закрытия крестиком или кликом по фону).
 *
 * Корневая причина: HelpManager.init() вызывался дважды (module-level
 * DOMContentLoaded в dialog-help.js + App._initializeManagers()), поэтому
 * на крестике/оверлее висело по два одинаковых click-листенера. Один клик →
 * hide() дважды синхронно → _hideDialog ставит ДВА setTimeout на один и тот
 * же overlay. Первый читает overlay._preserveInDom (true у #helpModal, узел
 * статический в шаблоне) и снимает флаг; второй видит уже undefined и уходит
 * в ветку overlay.remove() — узел физически исчезает из DOM, дальше show()
 * не находит #helpModal по id и молча выходит.
 *
 * Двойная инициализация убрана отдельно, но обычный двойной клик по
 * крестику воспроизводит ту же гонку без неё — тест бьёт по _hideDialog
 * напрямую, а не через HelpManager.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MiniElement } from './_mini-dom.mjs';
import { DialogBase } from '../../static/js/shared/dialog/dialog-base.js';

/** Overlay с _preserveInDom=true (как #helpModal — статическая нода шаблона), уже в DOM. */
function makePreservedOverlay() {
    const parent = new MiniElement('div');
    const overlay = new MiniElement('div');
    parent.appendChild(overlay);
    overlay._preserveInDom = true;
    return { parent, overlay };
}

test('одиночный _hideDialog у preserveInDom-узла скрывает его, не удаляя из DOM', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { parent, overlay } = makePreservedOverlay();

    DialogBase._hideDialog(overlay);
    t.mock.timers.tick(200);

    assert.equal(overlay.parentNode, parent, 'узел должен остаться в DOM');
    assert.ok(overlay.classList.contains('hidden'), 'узел должен получить класс hidden');
});

test('двойной синхронный _hideDialog у preserveInDom-узла не удаляет узел из DOM', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { parent, overlay } = makePreservedOverlay();

    // Двойной клик по крестику/оверлею — hide() срабатывает дважды подряд.
    DialogBase._hideDialog(overlay);
    DialogBase._hideDialog(overlay);
    t.mock.timers.tick(200);

    assert.equal(overlay.parentNode, parent, 'узел не должен быть удалён из DOM повторным hide()');
    assert.ok(overlay.classList.contains('hidden'), 'узел должен получить класс hidden');
});

/**
 * Overlay, пригодный для реального _showDialog: мини-DOM не знает про
 * addEventListener (focus-trap), а `document.activeElement instanceof
 * HTMLElement` требует самого HTMLElement в глобалах.
 */
globalThis.HTMLElement = MiniElement;

function makeShowableOverlay() {
    const { parent, overlay } = makePreservedOverlay();
    overlay.addEventListener = () => {};
    overlay.removeEventListener = () => {};
    DialogBase._activeDialogs.length = 0;
    return { parent, overlay };
}

test('повторный show() внутри задержки закрытия не гасится отменённым таймером', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { overlay } = makeShowableOverlay();

    DialogBase._hideDialog(overlay);
    t.mock.timers.tick(100);          // ещё внутри closeDelay
    overlay.classList.remove('hidden');
    DialogBase._showDialog(overlay, {appendToBody: false, animate: false});
    t.mock.timers.tick(500);          // старый таймер закрытия сработал бы здесь

    assert.ok(!overlay.classList.contains('hidden'), 'заново открытый диалог не должен скрыться сам');
    assert.ok(!overlay.classList.contains('closing'), 'класс закрытия должен быть снят при show()');
    assert.ok(overlay.classList.contains('visible'), 'диалог должен остаться видимым');
});

test('close → show → close внутри задержки не удаляет preserveInDom-узел из DOM', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { parent, overlay } = makeShowableOverlay();

    DialogBase._hideDialog(overlay);
    t.mock.timers.tick(100);
    DialogBase._showDialog(overlay, {appendToBody: false, animate: false});
    t.mock.timers.tick(100);
    DialogBase._hideDialog(overlay);
    t.mock.timers.tick(500);

    assert.equal(overlay.parentNode, parent, 'узел должен остаться в DOM');
    assert.ok(overlay.classList.contains('hidden'), 'узел должен быть скрыт классом hidden');
});
