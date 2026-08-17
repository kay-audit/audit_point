/**
 * Мини-DOM для node:test: ровно та часть браузерного API, на которую опираются
 * нормализация вложенности списков и блочный removeFormat из textblock-editor.js.
 *
 * ЗАЧЕМ: в проекте нет jsdom/linkedom (devDependencies — только playwright и
 * fast-check), а `_browser-stub.mjs` даёт узлы БЕЗ дерева и без парсинга
 * innerHTML. Проверять «вложенность списка приведена к валидной» на таких
 * стабах нельзя — нужен реальный обход дерева и сериализация обратно в HTML.
 *
 * ГРАНИЦЫ: поддержан узкий подмножество HTML — теги с атрибутами, текстовые
 * узлы, void-теги (br/img/hr). Ни комментариев, ни CDATA, ни автозакрытия
 * тегов по правилам парсера HTML5. Атрибуты сериализуются в порядке
 * объявления, `style` — всегда последним (пиши входной HTML в том же виде,
 * иначе round-trip даст другую строку).
 */

const VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'meta', 'link']);

/** CSS-свойства с camelCase-аксессором (те, что читает/пишет прод-код). */
const STYLE_PROPS = [
    'text-align', 'margin-left', 'padding-left', 'text-indent',
    'font-size', 'margin', 'padding', 'color',
];

/** Мини-CSSStyleDeclaration: kebab-хранилище + camelCase-аксессоры. */
class MiniStyle {
    constructor() {
        this._props = new Map();
    }

    getPropertyValue(name) {
        return this._props.get(name) || '';
    }

    setProperty(name, value) {
        if (value === '' || value === null || value === undefined) this._props.delete(name);
        else this._props.set(name, String(value));
    }

    removeProperty(name) {
        this._props.delete(name);
    }

    get length() {
        return this._props.size;
    }

    get cssText() {
        return [...this._props].map(([k, v]) => `${k}: ${v}`).join('; ');
    }
}

for (const prop of STYLE_PROPS) {
    const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    Object.defineProperty(MiniStyle.prototype, camel, {
        get() { return this.getPropertyValue(prop); },
        set(v) { this.setProperty(prop, v); },
    });
}

/** Текстовый узел. */
export class MiniText {
    constructor(data) {
        this.nodeType = 3;
        this.data = data;
        this.parentNode = null;
    }

    get textContent() { return this.data; }

    get parentElement() { return this.parentNode; }
}

/** Элемент. */
export class MiniElement {
    constructor(tagName) {
        this.nodeType = 1;
        this.tagName = String(tagName).toUpperCase();
        this.childNodes = [];
        this.parentNode = null;
        this.attributes = new Map();
        this.style = new MiniStyle();
        this.dataset = {};
    }

    // ── дерево ───────────────────────────────────────────────────────────────

    get parentElement() {
        return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
    }

    get children() { return this.childNodes.filter((n) => n.nodeType === 1); }

    get firstChild() { return this.childNodes[0] || null; }

    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }

    get previousElementSibling() {
        const sibs = this.parentNode ? this.parentNode.childNodes : [];
        for (let i = sibs.indexOf(this) - 1; i >= 0; i--) {
            if (sibs[i].nodeType === 1) return sibs[i];
        }
        return null;
    }

    get nextSibling() {
        const sibs = this.parentNode ? this.parentNode.childNodes : [];
        return sibs[sibs.indexOf(this) + 1] || null;
    }

    get previousSibling() {
        const sibs = this.parentNode ? this.parentNode.childNodes : [];
        const idx = sibs.indexOf(this);
        return idx > 0 ? sibs[idx - 1] : null;
    }

    appendChild(node) {
        if (node.parentNode) node.parentNode.removeChild(node);
        node.parentNode = this;
        this.childNodes.push(node);
        return node;
    }

    insertBefore(node, ref) {
        if (node.parentNode) node.parentNode.removeChild(node);
        node.parentNode = this;
        const idx = ref ? this.childNodes.indexOf(ref) : -1;
        if (idx < 0) this.childNodes.push(node);
        else this.childNodes.splice(idx, 0, node);
        return node;
    }

    removeChild(node) {
        const idx = this.childNodes.indexOf(node);
        if (idx >= 0) {
            this.childNodes.splice(idx, 1);
            node.parentNode = null;
        }
        return node;
    }

    remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
    }

    /** No-op: прод-код зовёт focus() на activeEditor. */
    focus() {}

    contains(other) {
        let el = other;
        while (el) {
            if (el === this) return true;
            el = el.parentNode;
        }
        return false;
    }

    // ── атрибуты ─────────────────────────────────────────────────────────────

    setAttribute(name, value) {
        if (name === 'style') {
            this.style = new MiniStyle();
            parseStyle(this.style, String(value));
            return;
        }
        this.attributes.set(name, String(value));
        if (name.startsWith('data-')) {
            this.dataset[dataKey(name)] = String(value);
        }
    }

    getAttribute(name) {
        if (name === 'style') return this.style.length ? this.style.cssText : null;
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    hasAttribute(name) {
        return name === 'style' ? this.style.length > 0 : this.attributes.has(name);
    }

    removeAttribute(name) {
        if (name === 'style') this.style = new MiniStyle();
        else this.attributes.delete(name);
    }

    get classList() {
        const el = this;
        const read = () => (el.attributes.get('class') || '').split(/\s+/).filter(Boolean);
        const write = (list) => {
            if (list.length) el.attributes.set('class', list.join(' '));
            else el.attributes.delete('class');
        };
        return {
            contains: (c) => read().includes(c),
            add: (c) => { const l = read(); if (!l.includes(c)) { l.push(c); write(l); } },
            remove: (c) => write(read().filter((x) => x !== c)),
        };
    }

    // ── содержимое ───────────────────────────────────────────────────────────

    get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }

    get innerHTML() { return this.childNodes.map(serialize).join(''); }

    set innerHTML(html) {
        this.childNodes.forEach((n) => { n.parentNode = null; });
        this.childNodes = [];
        parseInto(this, String(html));
    }

    get outerHTML() { return serialize(this); }

    /** `<template>.content` — в мини-DOM сам элемент (фрагмента как типа нет). */
    get content() { return this; }

    // ── селекторы ────────────────────────────────────────────────────────────

    /**
     * Поддержан узкий синтаксис: `*`, имена тегов и `.class`, через запятую.
     * @param {string} selector
     * @returns {MiniElement[]}
     */
    querySelectorAll(selector) {
        const parts = String(selector).split(',').map((s) => s.trim()).filter(Boolean);
        const out = [];
        const walk = (node) => {
            for (const child of node.childNodes) {
                if (child.nodeType !== 1) continue;
                if (parts.some((p) => matches(child, p))) out.push(child);
                walk(child);
            }
        };
        walk(this);
        return out;
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }
}

function matches(el, part) {
    if (part === '*') return true;
    if (part.startsWith('.')) return el.classList.contains(part.slice(1));
    return el.tagName === part.toUpperCase();
}

function dataKey(name) {
    return name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function parseStyle(style, css) {
    for (const decl of css.split(';')) {
        const idx = decl.indexOf(':');
        if (idx < 0) continue;
        const prop = decl.slice(0, idx).trim();
        const value = decl.slice(idx + 1).trim();
        if (prop && value) style.setProperty(prop, value);
    }
}

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^>]*?)?)(\/?)>/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function applyAttrs(el, raw) {
    if (!raw) return;
    ATTR_RE.lastIndex = 0;
    let m;
    while ((m = ATTR_RE.exec(raw))) {
        const value = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] || ''));
        el.setAttribute(m[1], value);
    }
}

function parseInto(root, html) {
    const stack = [root];
    const top = () => stack[stack.length - 1];
    const addText = (text) => { if (text) top().appendChild(new MiniText(text)); };
    TAG_RE.lastIndex = 0;
    let last = 0;
    let m;
    while ((m = TAG_RE.exec(html))) {
        addText(html.slice(last, m.index));
        last = TAG_RE.lastIndex;
        const [, closing, name, attrsRaw, selfClose] = m;
        if (closing) {
            for (let i = stack.length - 1; i > 0; i--) {
                if (stack[i].tagName === name.toUpperCase()) { stack.length = i; break; }
            }
            continue;
        }
        const el = new MiniElement(name);
        applyAttrs(el, attrsRaw);
        top().appendChild(el);
        if (!selfClose && !VOID_TAGS.has(name.toLowerCase())) stack.push(el);
    }
    addText(html.slice(last));
}

function serialize(node) {
    if (node.nodeType === 3) return node.data;
    const tag = node.tagName.toLowerCase();
    let attrs = '';
    for (const [k, v] of node.attributes) attrs += ` ${k}="${v}"`;
    if (node.style.length) attrs += ` style="${node.style.cssText}"`;
    const open = `<${tag}${attrs}>`;
    if (VOID_TAGS.has(tag)) return open;
    return `${open}${node.childNodes.map(serialize).join('')}</${tag}>`;
}

/**
 * Парсит HTML в дерево мини-DOM.
 * @param {string} html
 * @param {string} [rootTag='div'] Тег корневого контейнера.
 * @returns {MiniElement} Корень (его innerHTML — сериализация обратно).
 */
export function parseHtml(html, rootTag = 'div') {
    const root = new MiniElement(rootTag);
    parseInto(root, String(html));
    return root;
}

/**
 * Подменяет `document.createElement` на фабрику мини-DOM (нужен прод-коду,
 * который создаёт `<li>`, `<br>` и `<template>`).
 * @returns {() => void} Функция восстановления прежней фабрики.
 */
export function installMiniDom() {
    const orig = globalThis.document.createElement;
    globalThis.document.createElement = (tag) => new MiniElement(tag);
    return () => { globalThis.document.createElement = orig; };
}
