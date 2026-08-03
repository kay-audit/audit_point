/**
 * Тест showMessage на странице входа (баг: сообщение после автоскрытия
 * оставалось невидимым навсегда, т.к. inline style.display='none' никогда
 * не сбрасывался обратно, а предыдущий 5-секундный таймер не отменялся).
 *
 * auth.js — standalone classic-скрипт (грузится <script src>, НЕ type="module"):
 * страница входа рендерится до ESM-обвязки. Вся логика замкнута в обработчике
 * DOMContentLoaded и наружу ничего не экспортирует, поэтому обычный ESM-import
 * (как для модулей конструктора через _browser-stub) здесь не даёт доступа к
 * showMessage. Чтобы проверить РЕАЛЬНЫЙ файл, а не его копию, исходник
 * исполняется через node:vm в минимальном DOM-стабе, который перехватывает
 * addEventListener-колбэки (DOMContentLoaded, submit/click).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const authSrc = readFileSync(
  fileURLToPath(new URL('../../static/js/auth.js', import.meta.url)),
  'utf8'
);

/** Минимальный стаб DOM-элемента: style/classList/textContent + перехват addEventListener. */
function makeStubElement() {
  const listeners = {};
  return {
    style: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    className: '',
    textContent: '',
    value: '',
    addEventListener(type, cb) { listeners[type] = cb; },
    _listeners: listeners,
  };
}

/** Исполняет реальный auth.js в изолированном контексте, возвращает стабы элементов формы. */
function loadAuthScript() {
  const elements = {
    loginForm: makeStubElement(),
    otpSection: makeStubElement(),
    email: makeStubElement(),
    otp: makeStubElement(),
    verifyOtp: makeStubElement(),
    resendOtp: makeStubElement(),
    message: makeStubElement(),
  };

  let domContentLoadedCb = null;
  const fakeDocument = {
    addEventListener(type, cb) {
      if (type === 'DOMContentLoaded') domContentLoadedCb = cb;
    },
    getElementById: (id) => elements[id],
  };

  const sandbox = {
    document: fakeDocument,
    window: { location: { search: '' } },
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(authSrc, sandbox);

  // DOMContentLoaded ещё не наступал в этом контексте — вызываем вручную,
  // как это в реальности делает браузер один раз при загрузке страницы.
  domContentLoadedCb();

  return elements;
}

test('второе сообщение после автоскрытия первого остаётся видимым', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const elements = loadAuthScript();

  // Пустой email → первое сообщение (синхронная ветка до какого-либо fetch).
  elements.loginForm._listeners.submit({ preventDefault() {} });
  assert.notEqual(elements.message.style.display, 'none');

  // Пять секунд спустя таймер автоскрытия прячет сообщение — ожидаемо.
  t.mock.timers.tick(5000);
  assert.equal(elements.message.style.display, 'none');

  // Второе сообщение (пустой код) обязано снова стать видимым, а не
  // оставаться скрытым из-за не сброшенного inline display.
  elements.verifyOtp._listeners.click();
  assert.notEqual(elements.message.style.display, 'none');
  assert.equal(elements.message.textContent, 'Пожалуйста, введите код');
});

test('новое сообщение отменяет таймер скрытия предыдущего', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const elements = loadAuthScript();

  elements.loginForm._listeners.submit({ preventDefault() {} }); // t=0, таймер1 → скрыть в t=5000
  t.mock.timers.tick(4000); // t=4000: ещё видимо

  elements.verifyOtp._listeners.click(); // t=4000: новое сообщение, таймер1 должен отмениться

  t.mock.timers.tick(1500); // t=5500: старый таймер (истёк бы в t=5000) не должен был сработать
  assert.notEqual(elements.message.style.display, 'none');

  t.mock.timers.tick(3500); // t=9000: новый таймер (4000+5000) срабатывает штатно
  assert.equal(elements.message.style.display, 'none');
});
