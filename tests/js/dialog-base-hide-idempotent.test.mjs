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
