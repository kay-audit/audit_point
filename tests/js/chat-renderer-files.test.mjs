/**
 * Юнит-тесты чистых хелперов ChatRenderer, отвечающих за URL файлов/картинок
 * чата (первый JS-тест на этот модуль).
 *
 * ChatRenderer — плоский объект (не класс), приватные хелперы вызываются как
 * ``ChatRenderer._method(...)`` — так же, как в самом chat-renderer.js
 * (``_openFileViewer`` зовёт ``ChatRenderer._resolveFileUrl(...)`` статически).
 *
 * ``_resolveFileUrl`` для UUID уходит в ``AppConfig.api.getUrl``, который
 * лениво читает базовый URL из ``window.location`` и кеширует его в
 * ``AppConfig.api._baseUrlCache``. Чтобы не мокать ``location``, кеш
 * выставляется напрямую — тот же приём, что в
 * act-navigation-serialization.test.mjs.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ChatRenderer } from '../../static/js/shared/chat/chat-renderer.js';
import { AppConfig } from '../../static/js/shared/app-config.js';
import { AuthManager } from '../../static/js/shared/auth.js';

AppConfig.api._baseUrlCache = 'http://test';

/**
 * Перехватывает <img>, создаваемый _renderImage — стаб document.createElement
 * из _browser-stub.mjs не хранит детей (appendChild — no-op), поэтому
 * единственный способ добраться до итогового src — перехват на уровне
 * createElement (тот же приём, что в violation-image-render.test.mjs).
 *
 * @param {Function} fn — вызывает ChatRenderer._renderImage(...)
 * @returns {Object} — перехваченный элемент <img>
 */
function withCapturedImg(fn) {
    const orig = document.createElement;
    let captured = null;
    document.createElement = (tag) => {
        const el = orig(tag);
        if (tag === 'img') captured = el;
        return el;
    };
    try {
        fn();
        return captured;
    } finally {
        document.createElement = orig;
    }
}

// ---------------------------------------------------------------------
// _resolveFileUrl
// ---------------------------------------------------------------------

test('_resolveFileUrl: data-URL возвращается как есть, isDataUrl: true', () => {
    const dataUrl = 'data:text/plain;base64,QQ==';
    const resolved = ChatRenderer._resolveFileUrl(dataUrl);
    assert.equal(resolved.url, dataUrl);
    assert.equal(resolved.isDataUrl, true);
});

test('_resolveFileUrl: UUID — backend-эндпоинт /api/v1/chat/files/<uuid>, isDataUrl: false', () => {
    const uuid = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    const resolved = ChatRenderer._resolveFileUrl(uuid);
    assert.ok(resolved.url.endsWith(`/api/v1/chat/files/${uuid}`), resolved.url);
    assert.equal(resolved.isDataUrl, false);
});

test('_resolveFileUrl: https-ссылка агента — passthrough как есть (новый кейс)', () => {
    const link = 'https://example.org/f.xlsx';
    const resolved = ChatRenderer._resolveFileUrl(link);
    assert.equal(resolved.url, link);
    assert.equal(resolved.isDataUrl, false);
});

test('_resolveFileUrl: http-ссылка (не https) — тоже passthrough', () => {
    const link = 'http://example.org/f.pdf';
    const resolved = ChatRenderer._resolveFileUrl(link);
    assert.equal(resolved.url, link);
    assert.equal(resolved.isDataUrl, false);
});

// ---------------------------------------------------------------------
// _isPassthroughUrl — общий предикат для _renderImage и _openFileViewer
// ---------------------------------------------------------------------

test('_isPassthroughUrl: http(s)-ссылка агента — true', () => {
    assert.equal(ChatRenderer._isPassthroughUrl('https://example.org/f.pdf'), true);
    assert.equal(ChatRenderer._isPassthroughUrl('http://example.org/f.pdf'), true);
});

test('_isPassthroughUrl: UUID / data-URL / falsy — false', () => {
    assert.equal(ChatRenderer._isPassthroughUrl('3fa85f64-5717-4562-b3fc-2c963f66afa6'), false);
    assert.equal(ChatRenderer._isPassthroughUrl('data:text/plain;base64,QQ=='), false);
    assert.equal(ChatRenderer._isPassthroughUrl(undefined), false);
});

// ---------------------------------------------------------------------
// _renderImage — inline=true только для backend-адреса
// ---------------------------------------------------------------------

test('_renderImage: UUID backend-адрес получает ?inline=true', () => {
    const uuid = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    const img = withCapturedImg(() => ChatRenderer._renderImage({ file_id: uuid }));
    assert.equal(img.src, `http://test/api/v1/chat/files/${uuid}?inline=true`);
});

test('_renderImage: http(s)-ссылка агента остаётся без inline=true (passthrough)', () => {
    const link = 'https://example.org/f.png';
    const img = withCapturedImg(() => ChatRenderer._renderImage({ file_id: link }));
    assert.equal(img.src, link);
});

test('_renderImage: data-URL остаётся без inline=true', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const img = withCapturedImg(() => ChatRenderer._renderImage({ file_id: dataUrl }));
    assert.equal(img.src, dataUrl);
});

test('_renderImage: явный block.url приоритетнее file_id', () => {
    const uuid = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    const img = withCapturedImg(() => ChatRenderer._renderImage({
        url: 'https://cdn.example/x.png',
        file_id: uuid,
    }));
    assert.equal(img.src, 'https://cdn.example/x.png');
});

// ---------------------------------------------------------------------
// _openFileViewer — та же развилка inline=true, симметрично _renderImage
// (регрессия: ревью нашло, что _openFileViewer строил inlineUrl только по
// resolved.isDataUrl и приклеивал ?inline=true к http(s)-ссылке агента)
// ---------------------------------------------------------------------

test('_openFileViewer: UUID backend-адрес (image) получает ?inline=true', () => {
    const uuid = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    const img = withCapturedImg(() => ChatRenderer._openFileViewer({
        file_id: uuid,
        mime_type: 'image/png',
        filename: 'f.png',
    }));
    assert.equal(img.src, `http://test/api/v1/chat/files/${uuid}?inline=true`);
});

test('_openFileViewer: http(s)-ссылка агента (image) остаётся без inline=true (passthrough)', () => {
    const link = 'https://example.org/f.png';
    const img = withCapturedImg(() => ChatRenderer._openFileViewer({
        file_id: link,
        mime_type: 'image/png',
        filename: 'f.png',
    }));
    assert.equal(img.src, link);
});

// ---------------------------------------------------------------------
// _openFileViewer — текстовая ветка: fetch с/без ?inline=true и auth-заголовков
// (пин фикса утечки auth-заголовков на внешний http(s)-хост агента)
// ---------------------------------------------------------------------

/**
 * Перехватывает вызов fetch внутри ChatRenderer._openFileViewer и подменяет
 * AuthManager.getAuthHeaders на непустой маркер, чтобы отличить «заголовки
 * присланы» от «заголовки не присланы».
 *
 * @param {Object} block — блок файла, передаётся в _openFileViewer
 * @returns {{url: string, opts: Object}} — аргументы вызова fetch
 */
function withCapturedTextFetch(block) {
    const origGetAuthHeaders = AuthManager.getAuthHeaders;
    const origFetch = globalThis.fetch;
    AuthManager.getAuthHeaders = () => ({ Authorization: 'Bearer test-token' });
    let call = null;
    globalThis.fetch = (url, opts) => {
        call = { url, opts };
        return Promise.resolve({ text: () => Promise.resolve('') });
    };
    try {
        ChatRenderer._openFileViewer(block);
        return call;
    } finally {
        globalThis.fetch = origFetch;
        AuthManager.getAuthHeaders = origGetAuthHeaders;
    }
}

test('_openFileViewer: текстовый файл (UUID) — fetch с ?inline=true и auth-заголовками', () => {
    const uuid = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    const call = withCapturedTextFetch({ file_id: uuid, mime_type: 'text/plain', filename: 'f.txt' });
    assert.ok(call.url.endsWith('?inline=true'), call.url);
    assert.deepEqual(call.opts.headers, { Authorization: 'Bearer test-token' });
});

test('_openFileViewer: текстовый файл (http(s)-passthrough) — fetch БЕЗ ?inline=true и БЕЗ auth-заголовков', () => {
    const link = 'https://example.org/notes.txt';
    const call = withCapturedTextFetch({ file_id: link, mime_type: 'text/plain', filename: 'notes.txt' });
    assert.equal(call.url, link);
    assert.equal(call.opts.headers, undefined);
});

// ---------------------------------------------------------------------
// _decodeTextDataUrl
// ---------------------------------------------------------------------

test('_decodeTextDataUrl: base64 UTF-8 с кириллицей декодируется корректно', () => {
    const text = 'Привет, мир';
    const b64 = Buffer.from(text, 'utf-8').toString('base64');
    const dataUrl = `data:text/plain;base64,${b64}`;
    assert.equal(ChatRenderer._decodeTextDataUrl(dataUrl), text);
});

test('_decodeTextDataUrl: битый base64 → null', () => {
    const dataUrl = 'data:text/plain;base64,%%%not-base64%%%';
    assert.equal(ChatRenderer._decodeTextDataUrl(dataUrl), null);
});

test('_decodeTextDataUrl: не data-URL → null', () => {
    assert.equal(ChatRenderer._decodeTextDataUrl('https://example.org/f.txt'), null);
});

// ---------------------------------------------------------------------
// _defaultFilenameForMime
// ---------------------------------------------------------------------

test('_defaultFilenameForMime: application/x-zip-compressed → file.zip (IANA/MS-варианты обе смаплены)', () => {
    assert.equal(ChatRenderer._defaultFilenameForMime('application/x-zip-compressed'), 'file.zip');
});

test('_defaultFilenameForMime: незнакомый image/* → generic-фолбэк file.png', () => {
    assert.equal(ChatRenderer._defaultFilenameForMime('image/tiff'), 'file.png');
});

test('_defaultFilenameForMime: пустой/отсутствующий mime → пустая строка', () => {
    assert.equal(ChatRenderer._defaultFilenameForMime(''), '');
    assert.equal(ChatRenderer._defaultFilenameForMime(undefined), '');
});

// ---------------------------------------------------------------------
// _extractExt
// ---------------------------------------------------------------------

test('_extractExt: расширение приводится к нижнему регистру', () => {
    assert.equal(ChatRenderer._extractExt('report.XLSX'), '.xlsx');
});

test('_extractExt: имя без расширения → пустая строка', () => {
    assert.equal(ChatRenderer._extractExt('README'), '');
});

test('_extractExt: falsy имя → пустая строка', () => {
    assert.equal(ChatRenderer._extractExt(''), '');
    assert.equal(ChatRenderer._extractExt(null), '');
});

// ---------------------------------------------------------------------
// Снятая эвристика имён из текста
// ---------------------------------------------------------------------

test('_extractFileNamesFromText больше не существует — эвристика имён из текста снята', () => {
    assert.equal(typeof ChatRenderer._extractFileNamesFromText, 'undefined');
});
