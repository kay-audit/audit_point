# Manual QA — fallback на неизвестные типы блоков чата

Чек-лист ручной проверки graceful degradation фронт-чата, когда бэк добавляет
новый тип блока (например `chart`, `table_advanced`), которого фронт ещё
не знает.

Фактический гейт рендера — `switch (block.type)` в
`ChatRenderer.renderBlock` (`static/js/shared/chat/chat-renderer.js`):
незнакомый `type` уходит в `default` → `_renderUnknown`. Набор
`KNOWN_BLOCK_TYPES` в `static/js/shared/chat/chat-messages.js` — декларативное
зеркало `MessageBlock`-union бэка для сверки и отладки; путь рендера его НЕ
опрашивает, поэтому добавление типа только в этот Set новый блок не отрисует —
нужна ветка в `switch`.

Транспорт чата — POST + polling (SSE нигде нет): фронт шлёт сообщение через
`POST /api/v1/chat/conversations/{cid}/messages` (FormData, в т.ч.
`agent_mode`), получает `{message_id}` и поллит
`GET /api/v1/chat/conversations/{cid}/messages/{message_id}` до
терминального статуса, после чего рендерит ответ **целиком** с декоративным
эффектом печати (потокового стриминга токенов нет). Тот же путь рендера
работает и при загрузке истории.

Ожидание: вместо падения или пропажи блока пользователь видит плашку
«⚠ Блок неизвестного типа: <type>. Обновите страницу.» и полный payload
блока в `<pre>` для отладки. Сообщение чата остаётся читаемым.

## Подготовка

1. Запустить приложение (`uvicorn app.main:app --reload`), открыть портал
   в браузере, открыть любой чат (inline, modal или popup).
2. Открыть DevTools → Console.
3. Удостовериться, что глобальные синглтоны подцеплены:
   ```js
   typeof ChatEventBus    // 'object'
   typeof ChatMessages    // 'object'
   typeof ChatRenderer    // 'object'
   ChatMessages.KNOWN_BLOCK_TYPES  // Set из 9 типов
   ```

## Сценарий 1 — одиночный блок через `renderBlock`

Имитируем приход одного блока с неизвестным `type`. Простейший способ —
вручную дёрнуть `ChatRenderer.renderBlock` и вставить результат в DOM:

```js
const block = {
  type: 'chart_v2',
  block_id: 'qa-unknown-1',
  payload: { series: [1, 2, 3], title: 'demo' },
};
const el = ChatRenderer.renderBlock(block);
document.querySelector('.chat-message-content:last-of-type').appendChild(el);
```

**Ожидание:**
- В DOM появляется блок с классом `chat-block-unknown`.
- Текст: `⚠ Блок неизвестного типа: chart_v2. Обновите страницу.`
- Ниже — `<pre>` с pretty-printed JSON всего блока.
- В консоли: `ChatRenderer: неизвестный тип блока chart_v2 {...}`.
- Стилизация: жёлтый warning-фон (`--warning-subtle`), `border-left`
  толщиной `--border-width-thick` цвета `--warning`, текст плашки курсивом.

## Сценарий 2 — целое сообщение через `renderBlocks` (имитация ответа после poll)

Бэк отдаёт ответ ассистента целиком после завершения polling'а; фронт
рендерит его через `ChatRenderer.renderBlocks` / `typeOutBlocks`. Имитируем
несколько блоков подряд, среди которых один неизвестного типа.

```js
// Нужен живой контейнер бот-сообщения; самый простой способ —
// отправить «привет» в чат и дождаться появления нового message,
// либо взять последний контейнер.
const container = document.querySelector(
  '.chat-message-bot:last-of-type .chat-message-content'
);

ChatRenderer.renderBlocks(
  container,
  [
    { type: 'text', content: 'Текст до неизвестного блока.', block_id: 'qa-t1' },
    { type: 'table_advanced', block_id: 'qa-unknown-2', payload: { rows: [1, 2, 3] } },
    { type: 'text', content: 'И ещё текст после.', block_id: 'qa-t2' },
  ],
  { execute: false },
);
```

**Ожидание:**
- В консоли: `ChatRenderer: неизвестный тип блока table_advanced {...}`.
- В DOM — текстовые блоки `chat-block-text`, а между ними блок
  `.chat-block-unknown` с плашкой
  `⚠ Блок неизвестного типа: table_advanced. Обновите страницу.`
- В `<pre>` неизвестного блока — pretty-printed JSON всего блока,
  включая `payload`.
- Известные text-блоки рендерятся штатно, не уходят в fallback.

## Сценарий 3 — рендер истории с неизвестным типом

Имитируем загрузку беседы, в которой одно из сохранённых сообщений
ассистента содержит блок неизвестного типа (типичный регресс: пользователь
переключил браузерную вкладку на старую версию фронта после деплоя
нового бэка).

```js
ChatEventBus.emit('context:conversation-switched', {
  conversationId: 'qa-fake-conv',
  messages: [
    {
      role: 'assistant',
      content: [
        { type: 'text', content: 'Обычный текст до неизвестного блока.' },
        { type: 'future_block', block_id: 'qa-2', some_field: 42 },
        { type: 'text', content: 'И ещё текст после.' },
      ],
    },
  ],
});
```

**Ожидание:**
- Сообщение ассистента рендерится целиком: два текстовых блока + между ними
  fallback-плашка для `future_block`.
- В консоли: `ChatRenderer: неизвестный тип блока future_block {...}`.
- Старые типы блоков (`text`, `code`, `reasoning`, …) продолжают
  рендериться штатно.

## Регресс — известные типы не сломаны

Отправить обычное сообщение в чат, убедиться, что:
- Ответ бота приходит целиком после polling'а и рендерится с эффектом
  печати; text-блоки попадают в `chat-block-text` (НЕ в `chat-block-unknown`).
- `file`/`image`/`plan`/`error` рендерятся в свои классы.
- `buttons` и `client_action` отображаются как раньше.
- В консоли НЕТ warning'ов про unknown block type.
