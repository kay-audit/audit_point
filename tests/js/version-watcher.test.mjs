/**
 * Тесты VersionWatcher: открытая вкладка узнаёт, что сервер уехал на другую
 * версию, и предлагает перезагрузиться (см. static/js/shared/version-watcher.js).
 *
 * Ключевые инварианты, которые здесь пинуются:
 *   - совпадение версий — баннера нет, поллинг живёт;
 *   - расхождение (в любую сторону, включая откат) — баннер есть, поллинг стоп;
 *   - нет <meta name="app-version"> — init() тихий no-op;
 *   - 401/403 — поллинг прекращается совсем;
 *   - сеть/5xx/битый ответ — молча игнорируются, поллинг продолжается;
 *   - скрытая вкладка — в сеть не ходим вообще;
 *   - автоматического reload нет ни в одной ветке.
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    VersionWatcher,
    readPageVersion,
    DEFAULT_MIN_RECHECK_INTERVAL_MS,
} from '../../static/js/shared/version-watcher.js';
import { AppConfig } from '../../static/js/shared/app-config.js';

/** Элемент-заглушка: помнит детей, слушателей, класс и текст. */
function makeStubElement(tag) {
    return {
        tagName: String(tag || '').toUpperCase(),
        className: '',
        type: '',
        textContent: '',
        style: {},
        attributes: {},
        children: [],
        listeners: {},
        parentNode: null,
        setAttribute(name, value) { this.attributes[name] = value; },
        getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
        addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); },
        removeEventListener() {},
        appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
        removeChild(child) {
            this.children = this.children.filter((c) => c !== child);
            child.parentNode = null;
        },
        remove() { if (this.parentNode) this.parentNode.removeChild(this); },
        /** Кликает по элементу — прогоняет зарегистрированные click-обработчики. */
        click() { (this.listeners.click || []).forEach((fn) => fn()); },
    };
}

let originalDocument;
let fetchCalls;
let reloadCalls;
/** Ответ, который отдаёт подменённый fetch (или Error — тогда fetch кидает). */
let fetchResponse;

/** Подменяет document на стаб с meta-тегом версии (или без него). */
function installDocument({ metaVersion = '16.0.0', hidden = false } = {}) {
    const body = makeStubElement('body');
    const doc = {
        hidden,
        body,
        listeners: {},
        createElement: (tag) => makeStubElement(tag),
        addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); },
        removeEventListener(name, fn) {
            this.listeners[name] = (this.listeners[name] || []).filter((f) => f !== fn);
        },
        querySelector(selector) {
            if (selector !== 'meta[name="app-version"]') return null;
            if (metaVersion === null) return null;
            const meta = makeStubElement('meta');
            meta.setAttribute('content', metaVersion);
            return meta;
        },
        /** Имитирует событие visibilitychange (браузер бы дёрнул слушателей). */
        fireVisibilityChange() {
            return Promise.all((this.listeners.visibilitychange || []).map((fn) => fn()));
        },
    };
    globalThis.document = doc;
    return doc;
}

/** Находит баннер среди детей body. */
function findBanner(doc) {
    return doc.body.children.find((el) => el.className === 'version-banner') || null;
}

beforeEach(() => {
    originalDocument = globalThis.document;
    fetchCalls = [];
    reloadCalls = 0;
    fetchResponse = { ok: true, status: 200, json: async () => ({ version: '16.0.0' }) };

    // Обходим вычисление base URL через window.location (нет в стабах).
    AppConfig.api._baseUrlCache = 'http://test';
    globalThis.fetch = async (url, opts) => {
        fetchCalls.push({ url: String(url), opts });
        if (fetchResponse instanceof Error) throw fetchResponse;
        return fetchResponse;
    };
    globalThis.window.location = { reload: () => { reloadCalls += 1; } };
});

afterEach(() => {
    globalThis.document = originalDocument;
    delete globalThis.fetch;
    delete globalThis.window.location;
    AppConfig.api._resetCache();
});

test('readPageVersion() читает версию из meta-тега', () => {
    installDocument({ metaVersion: '  16.0.0  ' });
    assert.equal(readPageVersion(), '16.0.0');
});

test('readPageVersion() возвращает null без тега и при пустом content', () => {
    installDocument({ metaVersion: null });
    assert.equal(readPageVersion(), null);
    installDocument({ metaVersion: '   ' });
    assert.equal(readPageVersion(), null);
});

test('совпадение версий — баннера нет, поллинг продолжается', async () => {
    const doc = installDocument({ metaVersion: '16.0.0' });
    const watcher = new VersionWatcher();
    assert.equal(watcher.init(), true);
    try {
        await watcher._check();
        assert.equal(fetchCalls.length, 1);
        assert.ok(fetchCalls[0].url.endsWith('/api/v1/system/version'));
        assert.equal(findBanner(doc), null);
        assert.equal(watcher.stopped, false);
        assert.equal(reloadCalls, 0);
    } finally {
        watcher.destroy();
    }
});

test('расхождение версий — баннер показан и поллинг остановлен', async () => {
    const doc = installDocument({ metaVersion: '16.0.0' });
    fetchResponse = { ok: true, status: 200, json: async () => ({ version: '16.1.0' }) };
    const watcher = new VersionWatcher();
    watcher.init();
    try {
        await watcher._check();
        const banner = findBanner(doc);
        assert.ok(banner, 'баннер должен появиться в body');
        assert.equal(watcher.stopped, true);
        assert.equal(watcher._timer, null);
        // Автоматической перезагрузки быть не должно ни при каких условиях.
        assert.equal(reloadCalls, 0);
    } finally {
        watcher.destroy();
    }
});

test('откат версии назад тоже считается расхождением', async () => {
    const doc = installDocument({ metaVersion: '16.0.0' });
    fetchResponse = { ok: true, status: 200, json: async () => ({ version: '15.9.0' }) };
    const watcher = new VersionWatcher();
    watcher.init();
    try {
        await watcher._check();
        assert.ok(findBanner(doc));
        assert.equal(watcher.stopped, true);
    } finally {
        watcher.destroy();
    }
});

test('кнопка «Обновить» перезагружает страницу, «Позже» убирает баннер', async () => {
    const doc = installDocument({ metaVersion: '16.0.0' });
    fetchResponse = { ok: true, status: 200, json: async () => ({ version: '16.1.0' }) };
    const watcher = new VersionWatcher();
    watcher.init();
    try {
        await watcher._check();
        const banner = findBanner(doc);
        const [, reloadBtn, laterBtn] = banner.children;
        assert.equal(reloadBtn.textContent, 'Обновить');
        assert.equal(laterBtn.textContent, 'Позже');

        laterBtn.click();
        assert.equal(findBanner(doc), null, 'после «Позже» баннера в DOM нет');
        assert.equal(reloadCalls, 0);

        // Повторный показ до перезагрузки страницы запрещён.
        watcher._showBanner();
        assert.equal(findBanner(doc), null);

        reloadBtn.click();
        assert.equal(reloadCalls, 1);
    } finally {
        watcher.destroy();
    }
});

test('без meta-тега init() — тихий no-op, в сеть не ходим', async () => {
    installDocument({ metaVersion: null });
    const watcher = new VersionWatcher();
    assert.equal(watcher.init(), false);
    assert.equal(watcher._timer, null);
    assert.equal(fetchCalls.length, 0);
});

test('401 — поллинг прекращается совсем', async () => {
    const doc = installDocument({ metaVersion: '16.0.0' });
    fetchResponse = { ok: false, status: 401, json: async () => ({}) };
    const watcher = new VersionWatcher();
    watcher.init();
    try {
        await watcher._check();
        assert.equal(watcher.stopped, true);
        assert.equal(watcher._timer, null);
        assert.equal(findBanner(doc), null);
    } finally {
        watcher.destroy();
    }
});

test('403 — поллинг прекращается совсем', async () => {
    installDocument({ metaVersion: '16.0.0' });
    fetchResponse = { ok: false, status: 403, json: async () => ({}) };
    const watcher = new VersionWatcher();
    watcher.init();
    try {
        await watcher._check();
        assert.equal(watcher.stopped, true);
    } finally {
        watcher.destroy();
    }
});

test('сетевая ошибка — молча игнорируется, поллинг продолжается', async () => {
    const doc = installDocument({ metaVersion: '16.0.0' });
    fetchResponse = new Error('network down');
    const watcher = new VersionWatcher();
    watcher.init();
    try {
        await watcher._check();
        assert.equal(watcher.stopped, false);
        assert.notEqual(watcher._timer, null);
        assert.equal(findBanner(doc), null);
    } finally {
        watcher.destroy();
    }
});

test('5xx и 429 — молча игнорируются, поллинг продолжается', async () => {
    installDocument({ metaVersion: '16.0.0' });
    const watcher = new VersionWatcher();
    watcher.init();
    try {
        for (const status of [500, 502, 503, 429]) {
            fetchResponse = { ok: false, status, json: async () => ({}) };
            await watcher._check();
            assert.equal(watcher.stopped, false, `status=${status} не должен останавливать поллинг`);
        }
    } finally {
        watcher.destroy();
    }
});

test('ответ без версии / с пустой версией / битый JSON — игнорируется', async () => {
    const doc = installDocument({ metaVersion: '16.0.0' });
    const watcher = new VersionWatcher();
    watcher.init();
    try {
        const bad = [
            { ok: true, status: 200, json: async () => ({}) },
            { ok: true, status: 200, json: async () => ({ version: '   ' }) },
            { ok: true, status: 200, json: async () => ({ version: 42 }) },
            { ok: true, status: 200, json: async () => { throw new Error('bad json'); } },
        ];
        for (const resp of bad) {
            fetchResponse = resp;
            await watcher._check();
            assert.equal(watcher.stopped, false);
            assert.equal(findBanner(doc), null);
        }
    } finally {
        watcher.destroy();
    }
});

test('скрытая вкладка: тик таймера в сеть не ходит', async () => {
    const doc = installDocument({ metaVersion: '16.0.0', hidden: true });
    const watcher = new VersionWatcher();
    watcher.init();
    try {
        await watcher._tick();
        assert.equal(fetchCalls.length, 0);

        // Вкладку показали — тик снова ходит в сеть.
        doc.hidden = false;
        await watcher._tick();
        assert.equal(fetchCalls.length, 1);
    } finally {
        watcher.destroy();
    }
});

test('visibilitychange на скрытие в сеть не ходит', async () => {
    const doc = installDocument({ metaVersion: '16.0.0', hidden: true });
    const watcher = new VersionWatcher();
    watcher.init();
    try {
        await doc.fireVisibilityChange();
        assert.equal(fetchCalls.length, 0);
    } finally {
        watcher.destroy();
    }
});

test('возврат на вкладку проверяет сразу, но не чаще минимального зазора', async () => {
    const doc = installDocument({ metaVersion: '16.0.0' });
    const watcher = new VersionWatcher();
    watcher.init();
    try {
        // Первый возврат — проверок ещё не было, идём в сеть сразу.
        await doc.fireVisibilityChange();
        assert.equal(fetchCalls.length, 1);

        // Щёлканье вкладками подряд лишних запросов не даёт.
        await doc.fireVisibilityChange();
        await doc.fireVisibilityChange();
        assert.equal(fetchCalls.length, 1);

        // Зазор прошёл — проверяем снова.
        watcher._lastCheckAt = Date.now() - DEFAULT_MIN_RECHECK_INTERVAL_MS - 1;
        await doc.fireVisibilityChange();
        assert.equal(fetchCalls.length, 2);
    } finally {
        watcher.destroy();
    }
});

test('после остановки поллинга _check() в сеть не ходит', async () => {
    installDocument({ metaVersion: '16.0.0' });
    const watcher = new VersionWatcher();
    watcher.init();
    try {
        watcher.stop();
        await watcher._check();
        assert.equal(fetchCalls.length, 0);
    } finally {
        watcher.destroy();
    }
});

test('stop() снимает подписку на visibilitychange', async () => {
    const doc = installDocument({ metaVersion: '16.0.0' });
    const watcher = new VersionWatcher();
    watcher.init();
    try {
        assert.equal((doc.listeners.visibilitychange || []).length, 1);
        watcher.stop();
        assert.equal((doc.listeners.visibilitychange || []).length, 0);
    } finally {
        watcher.destroy();
    }
});
