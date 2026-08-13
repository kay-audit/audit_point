# Frontend архитектура чата

> См. также: `docs/guides/ai-assistant.md` §7.7 — общая роль чата в архитектуре.

## Обзор

Чат AI-ассистента в Audit Workstation — это vanilla-JS приложение (ES6+) на
Native ES Modules без bundler'а. Каждый чат-модуль — отдельный JS-файл
с `import`/`export`. Файлов в `static/js/shared/chat/` — 13; entry-файлы
(`portal-common.js`, `constructor.js`) импортят **12** из них явно, в нужном
порядке, а 13-й (`chat-feedback.js`) подтягивается через граф
`chat-messages.js`. Модули общаются между собой через синхронную шину событий
`ChatEventBus`.

Архитектура — event-driven, тонкий фасад `ChatManager` оркеструет ядерные
модули в `static/js/shared/chat/` и опциональный региональный модуль
`ChatPopupManager` для редактора актов. SSE в чате **нет** — транспорт
построен на паре POST + polling: `ChatStream.sendAndPoll` шлёт сообщение
через `POST /api/v1/chat/conversations/{cid}/messages`, получает `{message_id}`,
затем опрашивает `GET /api/v1/chat/conversations/{cid}/messages/{message_id}`
до терминального статуса (`complete` / `failed`) и отдаёт ответ **целиком**.
Полный ответ рендерится через `ChatRenderer.typeOutBlocks` с декоративным
«эффектом печати» (токен-стриминга нет). Единственный гейт известных типов —
`switch (block.type)` в `ChatRenderer.renderBlock`; он должен быть
синхронизирован с `MessageBlock`-union в `app/core/chat/blocks.py`. Если бэк
прислал блок неизвестного типа — фронт не падает, а показывает
warning-плейсхолдер «⚠ Блок неизвестного типа …» (см. «Unknown-block fallback»).

Чат имеет три режима отображения — inline (встроенный в правую панель портала),
modal (полноэкранный оверлей) и popup (плавающее окно с resize-углом
в конструкторе). Все три используют единый `ChatManager` и единый набор
ядерных модулей; различаются только обёртками-контейнерами.

## Модули

Все модули — синглтоны, публикующиеся в `window`. Файл за файлом:

### Ядерные модули (`static/js/shared/chat/`)

- **`chat-event-bus.js`** — pub/sub-шина событий чата. Объект-литерал
  `ChatEventBus` (`chat-event-bus.js:8`) с методами `on`, `off`, `offAll`,
  `emit`, `reset`. Внутри — `_listeners: Object<eventName, Set<function>>`
  (`chat-event-bus.js:10`): объект-словарь, в котором ключ — имя события,
  а значение — `Set` подписчиков на это событие. Ловит исключения из
  обработчиков и логирует их без останова рассылки (`chat-event-bus.js:60-65`).
  Подключается **первым** — все остальные модули используют его при
  инициализации.

- **`chat-renderer.js`** — рендерер блоков сообщений в DOM. Объект
  `ChatRenderer` (`chat-renderer.js:83`) с `renderBlock(block, opts)`
  (`chat-renderer.js:437-486`), `renderBlocks` (`:319`), `appendBlock` (`:342`),
  `createStreamingBlock(blockType, blockId)` (`chat-renderer.js:520`),
  `typeOutSingleBlock(container, block)` (`:290`), `appendTextAnimated(sb, text)`
  (`:261`).
  Поддерживает типы text, code, reasoning, plan, file, image, buttons,
  client_action, error и default-ветку для неизвестных. Группирует подряд
  идущие reasoning в один сворачиваемый `<details class="chat-reasoning-group">`
  (`chat-renderer.js:331-420`). **Markdown-пайплайн** `_markdownToHtml(text)` (`:1098`):
  vendored `marked` 18 (ESM, `static/vendor/marked/`) → `_closeDanglingFences`
  (незакрытые code-фенсы) → DOMPurify с `CHAT_MD_CONFIG` из `sanitize.js`
  (без img/svg/input, class разрешён) → постобработка ссылок
  (`target=_blank rel=noopener noreferrer`). Троттлинг re-parse адаптивный
  (`makeStreamingClosure`): до ~5 КБ — 80 мс, дальше растёт пропорционально
  накопленной длине (потолок 1000 мс) — re-parse это O(всего текста);
  `finalize` всегда рендерит точное финальное состояние. Чекбоксы task-list → ☑/☐. Подсветка кода —
  vendored highlight.js 11 ES-бандл (`static/vendor/highlightjs/`); тема
  подключается через `@import` в `css/entry/shared.css`. Облако пользователя
  и error-блоки рендерятся как plain-text (md не применяется).

- **`chat-client-actions.js`** — ESM-модуль с реестром `ClientActionsRegistry`
  (`chat-client-actions.js:44`). Регистрирует стандартные команды
  `open_url`, `notify`, `trigger_sdk` (`chat-client-actions.js:152, 160, 177`).
  Обеспечивает идемпотентность через `block_id` и `sessionStorage`
  (`EXECUTED_STORAGE_KEY = 'chat:executedActions'`, `EXECUTED_MAX_SIZE = 500`,
  `chat-client-actions.js:15-42`). Содержит whitelist URL-схем
  `ALLOWED_OPEN_URL_SCHEMES` (`chat-client-actions.js:123`) и `resolveProxyUrl`
  (`chat-client-actions.js:141-150`) — прогон относительного URL через
  `AppConfig.api.getUrl`, единая точка сборки адреса (см. «Единая точка сборки
  URL»).

- **`chat-stream.js`** — poll-клиент (не SSE). Объект `ChatStream`
  (`chat-stream.js:11`) с `sendAndPoll(conversationId, message, files, options)`
  (`chat-stream.js:27`) и `pollMessage(conversationId, messageId, options)`
  (`chat-stream.js:83`). `sendAndPoll` строит `FormData` (`message`, `domains`,
  `agent_mode`, `files[]`), делает `POST .../messages` → читает JSON
  `{message_id}`, затем зовёт `pollMessage`. `pollMessage` опрашивает
  `GET .../messages/{message_id}` с адаптивным интервалом: 4000 мс пока
  `status_details.bus_status === 'pending'`, иначе 1500 мс. Колбэки
  `onReady(msg)` / `onProgress(msg)` (каждый streaming-тик) / `onError(err)`.
  Таймаут — idle-семантика: пока fingerprint payload меняется (статус, очередь,
  длины блоков) — ждём; без изменений дольше фазового лимита (pending: 31 мин,
  иначе 11 мин) — ошибка. Жёсткого потолка нет: источник истины — бэкенд
  (`CLAIM_TIMEOUT_SEC` / `ANSWER_TIMEOUT_SEC`). 5 сетевых ошибок подряд →
  ошибка. Отмена — через внешний `AbortSignal` (`signal`), который `ChatMessages`
  хранит в `_pollController`; `abort()` — no-op для совместимости. `pollMessage`
  переиспользуется при reload/switch посреди ожидания.

- **`chat-history.js`** — панель списка бесед. Объект `ChatHistory`
  (`chat-history.js:11`) с `loadConversations` (`:53`), `createConversation`
  (`:107`), `deleteConversation` (`:145`), `selectConversation` (`:188`),
  `resetToNew` (`:89`). Все fetch'и идут
  через `AppConfig.api.getUrl(endpoint)` (`chat-history.js:61, 110, 149`).
  При смене беседы вызывает callback `onConversationChange`, который
  подключает `ChatContext.init()` (`chat-context.js:37`).

- **`chat-ui.js`** — UI-контроллер. Объект `ChatUI` (`chat-ui.js:13`) реагирует
  на события `ui:processing` и `ui:scroll-bottom` (`chat-ui.js:40-41`).
  Управляет блокировкой input'а и кнопки отправки и авторесайзом textarea.
  Индикатор «печатает» больше не управляется через шину — он ставится прямо
  в bubble через `ChatRenderer.createTypingPlaceholder()` (см. «Жизненный
  цикл сообщения»).

- **`chat-files.js`** — менеджер прикрепляемых файлов. Объект `ChatFiles`
  (`chat-files.js:12`) с очередью `_pendingFiles`, валидацией размера
  и количества, drag-and-drop в `.chat-body`. Дефолтные лимиты `_FILE_LIMITS`
  (`chat-files.js:26`) перетягиваются с сервера через
  `/api/v1/chat/limits` (`_loadLimits`, `chat-files.js:86-105`). Все DOM-listener'ы
  крепятся с `AbortController.signal` для чистого `destroy()` (`:62`).

- **`chat-context.js`** — контекст беседы и domain-фильтр. Объект `ChatContext`
  (`chat-context.js:13`) с `ensureConversation()` (lazy-create с Promise-lock
  `_pendingEnsure` от двойной отправки, `chat-context.js:81-105`), `detectDomains()`
  (читает `<meta name="chat-domains">`, `chat-context.js:190-205`),
  `getEnabledKnowledgeBases()` (`:169`), `getAgentMode()` (`:284`; читает
  `localStorage['assistant_oarb_mode']`, дефолт при отсутствии/мусоре — `always`).
  Также маппинг key→label баз знаний из
  `<meta name="chat-knowledge-bases">` либо из data-атрибутов
  (`_getKnowledgeBaseMap`, `chat-context.js:299-333`).

- **`chat-messages.js`** — оркестратор отправки/опроса и рендер user/assistant
  сообщений. Объект `ChatMessages` (`chat-messages.js:33`) с `_send` (`chat-messages.js:146`),
  `_renderReadyMessage` (`chat-messages.js:208`), `_renderConversationMessages`
  (`chat-messages.js:592`). Хранит `_pollController` (`AbortController`, `:51`)
  текущего опроса и отменяет его (`_abortPoll`, `:131`) при переключении/очистке
  беседы, чтобы typing-bubble не зависал. `_renderProgress(container, msg)` (`:256`)
  обрабатывает
  каждый `onProgress`-тик: обновляет строку статуса `.chat-typing-status`
  («В очереди: впереди N запрос(а/ов)» / «В очереди: вы следующий» /
  «Агент работает над ответом…») по `msg.status_details`, инкрементально
  допечатывает блоки по дельтам (`data-block-id`, WeakMap-реестр, очередь
  promise-анимаций, `appendTextAnimated`). Запоминает welcome-сообщение как
  DOM-узел (`cloneNode`) для безопасного восстановления при `clearChat`
  (`chat-messages.js:73`).

- **`chat-manager.js`** — тонкий фасад. Класс `ChatManager`
  (`chat-manager.js:21`) со статикой `init()` (`:39`), `destroy()` (`:106`),
  `sendMessage()` (`:131`), `clearChat()` (`:154`). Атомарный флаг `_isSending`
  защищает от двойного
  клика/Enter до первого `await` (`chat-manager.js:34, 131-147`). Общий
  `AbortController` снимает все DOM-listener'ы одним `abort()`
  (`chat-manager.js:28, 71, 106-120`).

- **`chat-modal.js`** — overlay-режим. Класс `ChatModalManager`
  (`chat-modal.js:11`) с `open` (`:20`), `close` (`:45`), ленивой инициализацией
  `ChatManager.init()` при первом открытии и Escape через общий `EscapeStack`:
  `EscapeStack.push(...)` в `open` (`:34-36`), unsubscribe-хэндл `_escapeUnsub`
  снимается в `close` (`:52-55`) — ESC не срабатывает, пока модалка скрыта.

- **`chat-feedback.js`** — панель обратной связи по сообщениям ассистента
  (лайк/дизлайк/копировать). Объект-литерал `ChatFeedback` (`chat-feedback.js:36`)
  с публичным
  методом `ChatFeedback.attach(contentEl, {conversationId, messageId, initial})`
  (`:50`) — прикрепляет ряд действий под завершённым ответом ассистента. Лайк —
  мгновенно; дизлайк — мгновенно + раскрывает форму причин с чекбоксами
  (`REASONS`, `:22`; синхронизированы с бэком `FEEDBACK_REASON_CODES`) и полем
  комментария. Оценка переключаемая/отменяемая. Запросы идут через
  `AppConfig.api.getUrl` + `AppConfig.chatEndpoints.feedback(cid, mid)`, метод
  `PUT/DELETE /api/v1/chat/conversations/{cid}/messages/{mid}/feedback`.
  Эмитит в шину `feedback:submitted` / `feedback:cleared`. Вызывается из
  `ChatMessages._renderReadyMessage` после завершения анимации ответа —
  панель всегда последней под финальным облаком. **Не импортируется в
  entry напрямую**: подтягивается через граф `chat-messages.js`
  (`import { ChatFeedback } from './chat-feedback.js'`).

- **`chat-title.js`** — генерация title новой беседы по первому пользовательскому
  сообщению. Объект-литерал `ChatTitle` (`chat-title.js:8`) с методом
  `ChatTitle.derive(text, files)` (`:27`):
  обрезает текст до `MAX_LENGTH=40` символов по word boundary + `…`; при
  пустом тексте и наличии файлов — `«Файлы: <имя первого>»`; при отсутствии
  обоих — `«Новая беседа»`. Используется в `ChatContext._createConversation`
  через `ChatHistory.createConversation`. **Импортируется в entry напрямую**
  (`chat-title.js` в явном `import`-списке `portal-common.js` и `constructor.js`).

### Региональный модуль (`static/js/constructor/header/`)

- **`chat-popup.js`** — popup-режим для редактора актов. Класс
  `ChatPopupManager` (`chat-popup.js:11`) с `setup` (`:24`), `open` (`:82`),
  `close` (`:109`), `toggle` (`:130`). Делает **полный re-init** `ChatManager`
  при каждом открытии и `destroy()` при закрытии (`chat-popup.js:88-90, 122-124`)
  — чтобы не накапливались подписки на шину. Свободный resize за угол и
  сохранение размера в `localStorage['chat_popup_size']` делегированы общей
  утилите `makeResizablePanel` (`static/js/shared/resizable-panel.js`;
  вызов — `chat-popup.js:63-73`). Escape — через `EscapeStack` (`:95-97` / `:115-118`).

## Шина событий (ChatEventBus)

Шина — синхронный pub/sub: `emit` пробегает по `Set` обработчиков с try/catch
вокруг каждого вызова (`chat-event-bus.js:56-66`). События не сериализуются
и не буферизуются — модули должны быть инициализированы и подписаны до
первой эмиссии.

### Каталог событий

| Событие | Эмитит | Слушает | Payload |
|---|---|---|---|
| `chat:send-request` | `ChatManager.sendMessage` (`chat-manager.js:145`) | `ChatMessages._onSendRequest` (`chat-messages.js:94`) | `{text, files}` |
| `chat:clear` | `ChatManager.clearChat` (`chat-manager.js:158`) | `ChatMessages` (`chat-messages.js:97`), `ChatContext` (`chat-context.js:52`) | — |
| `context:conversation-switched` | `ChatContext._onConversationSwitch` (`chat-context.js:233`) | `ChatMessages` (`chat-messages.js:95`), `ChatFiles` (`chat-files.js:49`) | `{conversationId, messages}` |
| `context:conversation-cleared` | `ChatContext._onConversationSwitch` (`chat-context.js:211`) | `ChatMessages` (`chat-messages.js:96`), `ChatFiles` (`chat-files.js:48`) | — |
| `ui:processing` | `ChatMessages._send` (`chat-messages.js:147, 197`) | `ChatUI._setProcessing` (`chat-ui.js:40`) | `{state: boolean}` |
| `ui:scroll-bottom` | `ChatMessages` (множество мест) | `ChatUI._scrollToBottom` (`chat-ui.js:41`) | — |
| `files:changed` | `ChatFiles` (drag-drop, picker, удаление чипа: `chat-files.js:141, 204, 296`) | — (внешние слушатели) | `{files: File[]}` |
| `files:cleared` | `ChatFiles.clear` (`chat-files.js:121`) | — (внешние слушатели) | — |
| `feedback:submitted` | `ChatFeedback` (`chat-feedback.js:210, 237`) | — (внешние слушатели) | `{messageId, rating, …}` |
| `feedback:cleared` | `ChatFeedback` (`chat-feedback.js:201`) | — (внешние слушатели) | `{messageId}` |

Конструктор использует ту же шину как общий cross-module event bus
(`node:tb-changed`, `node:invoice-changed`) — см.
[`frontend-architecture.md`](frontend-architecture.md) §7.6.

`ChatEventBus.reset()` (`chat-event-bus.js:71-75`) сбрасывает все подписки —
используется только в тестах.

## Жизненный цикл сообщения

Последовательность от ввода пользователя до отображения ответа:

1. **Инициализация.** Шаблон портала или конструктора грузит скрипты
   в правильном порядке (см. ниже). Каждый модуль публикуется в `window`.
   Конкретный режим (inline / modal / popup) вызывает `ChatManager.init()`
   (`chat-manager.js:39-99`).

2. **Ввод.** Пользователь набирает текст в `.chat-input`, при необходимости
   прикрепляет файлы через `ChatFiles` (picker или drag-drop в `.chat-body`).
   Авторесайз textarea и валидация файлов — onChange.

3. **Отправка.** Enter (без shift) или клик по `.chat-send-btn` →
   `ChatManager.sendMessage()` (`chat-manager.js:131`). Атомарный флаг
   `_isSending` ставится до первого `await`, защищая от двойного клика,
   и эмиттится `chat:send-request` с `{text, files}`.

4. **Подписчик `ChatMessages._send`** (`chat-messages.js:146-199`):
   - эмиттит `ui:processing {state: true}` → `ChatUI` блокирует input/send;
   - вызывает `ChatContext.ensureConversation()` — ленивое создание беседы
     через `POST /api/v1/chat/conversations` (с Promise-lock от дублей);
   - рендерит user-сообщение в DOM;
   - очищает очередь файлов;
   - создаёт bubble бот-сообщения с typing-плейсхолдером
     (`_addBotMessageStreaming`, маркер-класс `chat-message-bot--streaming`);
   - читает режим агента из `ChatContext.getAgentMode()` (off / adaptive /
     always, ключ `localStorage['assistant_oarb_mode']`);
   - создаёт `AbortController` (`_pollController`) и вызывает
     `ChatStream.sendAndPoll(...)`.

5. **`ChatStream.sendAndPoll`** (`chat-stream.js:27-64`):
   - строит `FormData` (`message`, `domains` JSON-string, `files[]`;
     `_buildFormData`, `:212`) и добавляет `agent_mode` (`:31`);
   - делает `POST /api/v1/chat/conversations/{id}/messages` через
     `AppConfig.api.getUrl`, читает JSON `{message_id}`;
   - передаёт управление `pollMessage`, который опрашивает
     `GET .../messages/{message_id}` с адаптивным интервалом до статуса
     `complete`/`failed`; каждый streaming-тик вызывает `onProgress(msg)`.

5а. **`onProgress`-тики.** `ChatMessages._renderProgress(container, msg)`
   (`chat-messages.js:256-265`):
   - обновляет строку `.chat-typing-status` по `msg.status_details`;
   - инкрементально допечатывает блоки по дельтам: реестр WeakMap(el→text),
     очередь promise-анимаций, `appendTextAnimated`.

6. **`ChatMessages._renderReadyMessage`** (`chat-messages.js:208-254`) —
   по терминальному ответу убирает typing-плейсхолдер и снимает маркер-класс,
   затем допечатывает оставшиеся хвосты: для `complete` — через
   `ChatRenderer.typeOutBlocks` (анимирует только то, что ещё не отрисовано),
   для `failed` — через `ChatRenderer.renderBlocks` без анимации + класс
   `chat-message--failed`. Метод `async` и **дожидается конца анимации**,
   прежде чем прикрепить панель обратной связи (`ChatFeedback.attach`) —
   панель реакций всегда оказывается последним элементом облака, ПОД
   финальным ответом, и появляется только при терминальном статусе.

7. **Завершение.** Колбэк `onReady`/`onError` отрабатывает один раз; затем
   `_send` в `finally` эмиттит `ui:processing {state: false}` — `ChatUI`
   снова разрешает ввод. Ошибки (включая штатные 4xx, напр. лимит
   одновременных запросов) показываются в bubble через `_renderError`.

8. **Resume при разрыве/switch'е.** Если вкладку перезагрузили или
   переключили беседу пока ассистент ждёт ответа (сообщение сохранено со
   `status='streaming'`), `_renderConversationMessages`
   (`chat-messages.js:592-665`) рендерит накопленные text/reasoning-блоки
   черновика **мгновенно** и seed'ит реестр инкрементального рендера
   (`_seedIncrementalBlocks`, `:363`: `renderedLen` = текущая длина) — уже показанное
   не переанимируется, ставит typing-bubble и возобновляет опрос тем же
   `ChatStream.pollMessage(conversationId, msg.id, ...)`; последующие
   progress-тики допечатывают только новые дельты. Источник истины — БД:
   фоновый `AgentChannelPoller` независимо от фронта поллит
   bus-таблицу `chat_agent_messages_bus` и финализирует черновик `chat_messages`
   (`AgentChannelService.poll_once` → `complete`/`failed`). Фронт лишь
   дочитывает финальный статус через GET.

## Транспорт: POST + polling (без SSE)

SSE в чате **нет**. Обмен с бэком — две HTTP-операции:

1. **Отправка.** `POST /api/v1/chat/conversations/{cid}/messages` с `FormData`
   (`message`, `domains`, `agent_mode`, `files[]`). Ответ — JSON
   `{message_id}`. Если лимит одновременных запросов превышен
   (`AgentMessageRepository.count_active_for_user >= max_parallel_streams_per_user`),
   бэк возвращает **HTTP 422** с дружелюбным сообщением (`ChatLimitError`)
   ещё до записи в БД.
2. **Опрос.** `GET /api/v1/chat/conversations/{cid}/messages/{message_id}`
   с адаптивным интервалом (4000 мс в фазе `pending`, иначе 1500 мс) до
   терминального статуса. Поля ответа: `id`, `role`, `status`, `content`
   (массив блоков), и — для streaming-черновика — опциональное поле
   `status_details: {bus_status: str, queue_ahead: int|null}` (позиция в очереди
   шины, best-effort). Статусы: `streaming` (ответ ещё готовится),
   `complete`, `failed`.

Ответ приходит **целиком** после финализации — токен-стриминга нет. Пока
черновик в статусе `streaming`, каждый `onProgress`-тик несёт накопленные
блоки: `ChatMessages._renderProgress` инкрементально допечатывает их по
дельтам (`data-block-id`, WeakMap-реестр, очередь promise-анимаций). После
терминального статуса `_renderReadyMessage` допечатывает только оставшиеся
хвосты. Для `failed`-сообщений блоки рисуются мгновенно через `renderBlocks`.

**Строка статуса очереди** (`.chat-typing-status`): обновляется `_renderProgress`
по `status_details`: «В очереди: впереди N запрос(а/ов)» / «В очереди: вы
следующий» / «Агент работает над ответом…».

**Серверная обработка по режиму `agent_mode`:**

| `agent_mode` | Поведение бэка | Статус первого ответа |
|---|---|---|
| `off` | Локальный LLM-провайдер (маршрут `CHAT__PROFILE`) исполняется синхронно в POST через `orchestrator.run(...)`; forward-tool скрыт от LLM | `complete` сразу |
| `adaptive` | Тот же синхронный путь, но в наборе tools есть forward-tool — оркестратор сам решает форвардить вопрос в агента | `complete`, либо `streaming` если ушёл форвард |
| `always` | Прямой проброс вопроса во внешнего агента, LLM-оркестратор не запускается | `streaming`, финализируется поллером |

Значение приходит form-параметром `agent_mode` (`app/domains/chat/api/messages.py:49`,
дефолт на бэке — `off`); фронт всегда шлёт его явно из
`ChatContext.getAgentMode()`.

При форварде бэк создаёт черновик `chat_messages` (`status='streaming'`) и
кладёт вопрос в bus-таблицу `chat_agent_messages_bus`; фоновый `AgentChannelPoller`
поллит шину и через `AgentChannelService.poll_once` дозаполняет reasoning-блок
черновика инкрементально (upsert по block_id `{answer_id}:reasoning:0`) и
финализирует черновик (`complete`/`failed`). Фронт допечатывает reasoning
по дельтам, получаемым через `onProgress`.

### Декоративный «эффект печати» и инкрементальное допечатывание

`ChatRenderer.typeOutBlocks(container, blocks)` (`chat-renderer.js:175-221`):
блоки типов `text`/`reasoning` анимируются посимвольно через
`createStreamingBlock(type)` + `_animateText` (`:223`); остальные типы (`code`, `file`,
`image`, `plan`, `buttons`, `client_action`, `error`) рисуются мгновенно через
`renderBlock`. При `prefers-reduced-motion: reduce` или отсутствии блоков —
весь ответ рендерится мгновенно.

**Инкрементальное допечатывание во время streaming.** `typeOutSingleBlock` и
`appendTextAnimated` — публичные методы рендерера для дозаписи уже существующего
блока. `_renderProgress` использует WeakMap-реестр активных анимаций и очередь
promise'ов: новая порция текста добавляется в очередь поверх текущей анимации,
финальный `typeOutBlocks` допечатывает только хвосты.

### Маппинг типов на рендереры

Все типы блоков обрабатываются в `switch (block.type)` внутри
`ChatRenderer.renderBlock` (`chat-renderer.js:437-465`) — это **единственный**
реестр типов на фронте:

| `block.type` | Метод | DOM-класс |
|---|---|---|
| `text` | `_renderText` | `.chat-block-text` |
| `code` | `_renderCode` (с заголовком: язык + «Копировать») | `.chat-block-code` |
| `reasoning` | `_renderReasoning` (свёрнутый `<details>`) | `.chat-block-reasoning` |
| `plan` | `_renderPlan` (список шагов со статусами) | `.chat-block-plan` |
| `file` | `_renderFile` (карточка + предпросмотр + скачать) | `.chat-block-file` |
| `image` | `_renderImage` (lazy + клик → viewer) | `.chat-block-image` |
| `buttons` | `_renderButtons` (группа кнопок → замена на бейдж после клика) | `.chat-block-buttons` |
| `client_action` | `_renderClientAction` (label-чип + опц. исполнение) | `.chat-block-client-action` |
| `error` | `_renderError` | `.chat-block-error` |
| (`default`-ветка switch) | `_renderUnknown` | `.chat-block-unknown` |

> **`KNOWN_BLOCK_TYPES` рендером НЕ читается.** Set объявлен в
> `chat-messages.js:21`, реэкспортируется свойством `ChatMessages` (`:36`) и
> публикуется как `window.KNOWN_BLOCK_TYPES` (`:678`) — и на этом всё:
> `grep -rn "KNOWN_BLOCK_TYPES" static/ tests/ templates/` даёт ровно эти три
> строки, ни одного чтения. Добавление типа в Set **ни на что не влияет**;
> поведение определяет только `switch`. Константа — кандидат на удаление из
> кода.
>
> Второй, независимый hardcoded-список типов — `isStreamingBlockType(type)`
> (`chat-renderer.js:275`, возвращает `true` для `text`/`reasoning`): он решает,
> анимировать блок посимвольно или отрисовать мгновенно. Новый «стримящийся»
> тип добавляется туда отдельно.

## Unknown-block fallback

Бэк может ввести новый тип блока (например `chart`, `table_advanced`)
до того, как соответствующий фронт раскатится на всех пользователей. Чтобы
старая версия не падала — все блоки рендерятся через единый
`ChatRenderer.renderBlock`, у которого есть fallback-ветка для неизвестных
типов:

- **Любой блок, для типа которого нет `case` в `switch`** (`chat-renderer.js:461`),
  попадает в `default`-ветку: `console.warn` + `_renderUnknown(block)`
  (`chat-renderer.js:488`). Полный payload
  показывается в `<pre>` через `JSON.stringify(block, null, 2)`. Так как
  ответ приходит целиком (POST+poll, без стриминга по чанкам), отдельной
  ветки «стримящийся неизвестный блок» больше нет — и live-ответ, и история
  из БД проходят через один и тот же `renderBlock` → `_renderUnknown`.

В DOM получается:

```html
<div class="chat-block chat-block-unknown">
  <div class="chat-block-unknown-notice">⚠ Блок неизвестного типа: chart. Обновите страницу.</div>
  <pre class="chat-block-unknown-payload">{...}</pre>
</div>
```

Стили — `static/css/shared/chat/chat-blocks.css:422-449` (жёлто-оранжевый
warning-бордер слева, моноширинный шрифт для payload, перенос длинных слов).

Console.warn пишется для каждого неизвестного блока — без падения
с trace'ом. Сценарий ручной проверки описан в
`docs/testing/manual-qa-frontend-unknown-block.md`.

> **Синхронизация — три места.** При добавлении нового типа блока:
> 1. `MessageBlock` union в `app/core/chat/blocks.py`;
> 2. `_DiscriminatedBlock` в `app/core/chat/schemas.py` (через `Annotated[..., Tag("...")]`);
> 3. новый `case` в `switch` `ChatRenderer.renderBlock` (`chat-renderer.js:437`)
>    **плюс** сам метод `_renderX`.
>
> Пункт 3 — единственный, что влияет на рендер: `KNOWN_BLOCK_TYPES` трогать
> не нужно (см. врез выше). Если тип должен печататься посимвольно —
> дополнительно `isStreamingBlockType` (`chat-renderer.js:275`).

## Режимы: inline / modal / popup

Все три режима используют **один и тот же** `ChatManager` и одни и те же
ядерные модули. Различаются только DOM-обёрткой и стратегией
инициализации:

### Inline

Используется на лендинге и в портале. Контейнер `.chat-messages`,
input `.chat-input` и кнопка `.chat-send-btn` уже присутствуют в DOM при
загрузке страницы. Инициализация вызывается из page-script'а явно
(`ChatManager.init()`). `destroy()` обычно не вызывается — чат живёт
вместе со страницей.

### Modal (`ChatModalManager`)

Используется на страницах, где нет встроенной чат-панели (acts-manager,
admin). DOM модального оверлея (`#chatModalOverlay`) присутствует в
шаблоне портала, но скрыт. `open()` (`chat-modal.js:20-40`):

1. показывает оверлей (убирает `.hidden`, ставит `body.chat-modal-open`);
2. при первом открытии — `ChatManager.init()` + `_setupCloseHandlers()`,
   флаг `_chatInitialized = true`;
3. регистрирует close-callback в общем `EscapeStack` **только на время
   открытия**; unsubscribe-хэндл лежит в `_escapeUnsub`, что заодно защищает
   от двойной подписки (`chat-modal.js:34-36`).

`close()` (`:45-56`) вызывает `_escapeUnsub()` (снятие из `EscapeStack` —
защита от утечки слушателя), но не вызывает `ChatManager.destroy()` —
состояние переживает повторные open/close.

### Popup (`ChatPopupManager`, конструктор)

Только на странице конструктора актов (`/constructor`). Подключается
из `templates/constructor/header/header_chat_panel.html` через
`#chatPopupPanel`. Региональный модуль `chat-popup.js` (не в shared) —
потому что popup имеет специфичную для редактора фичу: свободное
изменение размера за угол и сохранение размера в
`localStorage['chat_popup_size']` (реализация — общая утилита
`makeResizablePanel`, `shared/resizable-panel.js`).

Ключевое отличие от modal: `ChatPopupManager.open` / `close` делают
**полный re-init** ChatManager при каждом открытии — `ChatManager.init()`
в `open`, `ChatManager.destroy()` в `close` (`chat-popup.js:88-90,
122-124`). Это нужно, чтобы каждое открытие давало свежий
`AbortController` и не накапливались подписки на шину после многократных
toggle'ов.

## Client actions

`ClientActionsRegistry` (`chat-client-actions.js:44-115`) — реестр
исполнителей чисто-клиентских команд. Бэк генерирует блок типа
`client_action`, фронт показывает label-чип в чате и опционально
выполняет действие.

### Стандартные handler'ы

Регистрируются в самом модуле (`chat-client-actions.js:152-187`):

- `open_url({url})` — навигация. Проверяет URL через `isAllowedUrl` (`:125`)
  (whitelist схем `ALLOWED_OPEN_URL_SCHEMES = ['http://', 'https://',
  'mailto:', '/']` (`chat-client-actions.js:123`)) — это **defense in
  depth** относительно `ALLOWED_OPEN_URL_SCHEMES` в
  `app/core/chat/blocks.py`. Запрещены `javascript:`, `data:`,
  `vbscript:`, `file:`. Перед `window.location.href` относительный путь
  прогоняется через `resolveProxyUrl` (см. ниже).

- `notify({message, level})` — показ уведомления через
  `window.Notifications.show`, с консольным fallback если модуль не
  подключён.

- `trigger_sdk({method, args})` — вызов произвольной `window`-функции.
  Защищён whitelist'ом `ALLOWED_SDK_METHODS = new Set([])`
  (`chat-client-actions.js:172-176`) — **пустой по умолчанию**. Метод
  добавляется в whitelist явно перед использованием. Без этого LLM мог
  бы вызвать `alert`, `fetch`, eval-аналоги — критично для безопасности.

Домен может зарегистрировать собственный handler через
`ClientActionsRegistry.register('my_action', fn)`.

### Идемпотентность через `block_id`

Бэк проставляет `block_id` на каждый `ClientActionBlock` — это **обязательное** поле
без `default_factory`. Оркестратор переписывает его на детерминированный формат
`f"{message_id}:client_action:{i}"` в `_parse_client_action_result` (где `i` — индекс
client_action-блока в сообщении; нумерацию ведёт `BlockIdGenerator`,
`app/core/chat/block_id_generator.py`).

> **Гарантия идемпотентности при reload.** При перезагрузке вкладки фронт получает
> **тот же id** (он стабильно выводится из `message_id`), `sessionStorage`-чек
> сматчит → action не выполняется повторно. До рефакторинга `block_id` генерился
> через `default_factory=uuid4`, и при каждом reload получался новый uuid — это
> вызывало бесконечный редирект-цикл для `open_url` actions из истории.

Фронт ведёт `Set<string>` исполненных id, сериализуется в
`sessionStorage['chat:executedActions']` (`chat-client-actions.js:15-42`). Soft
cap — `EXECUTED_MAX_SIZE = 500` элементов (`:17`), при переполнении выкидываются
самые старые. Фронт-логика
не меняется — id хранится так же, изменилось только то, как он генерируется
на бэке.

`ClientActionsRegistry.executeBlock(block)` (`chat-client-actions.js:82-99`)
— **единая точка** для исполнения с идемпотентностью:

```js
if (executed.has(blockId)) return;  // молча выходим, уже сделано
executed.add(blockId);
_persistExecuted();
this.execute(block.action, block.params || {});
```

Это закрывает три сценария: повторный рендер ответа (например при ре-опросе),
рендер истории с уже исполненными блоками, перезагрузка вкладки
с открытым чатом (sessionStorage переживает reload).

**Старая семантика `{execute: true/false}`** через `_renderClientAction(opts)`
(`chat-renderer.js:889-926`) сохранена для совместимости. Новый код
должен вызывать `ClientActionsRegistry.executeBlock(block)` напрямую —
NOT `execute(action, params)`, иначе обойдётся `block_id`-проверка
и получится redirect-цикл.

### Sync с backend `names.py`

Имена действий — это магические строки. На бэке они вынесены в
`app/core/chat/names.py` (`ACTION_OPEN_URL`, `ACTION_NOTIFY`, …). На фронте
имена прибиты в `ClientActionsRegistry.register('open_url', ...)`
(`chat-client-actions.js:152, 160, 177`). Импорт из Python невозможен —
при переименовании action'а в `names.py` **обязательно** обновить строку
в `chat-client-actions.js` вручную. Иначе `client_action`-блок
с новым именем молча перестанет исполняться (console.warn без падения).

## Единая точка сборки URL: `AppConfig.api.getUrl`

Все обращения чата к API строятся из двух реестров, а не из литералов
в callsite'ах:

- `AppConfig.chatEndpoints` (`shared/app-config.js:120`) — относительные
  пути чат-эндпоинтов (`conversations`, `conversation(cid)`, `messages(cid)`,
  `feedback(cid, mid)`, `activeForward(cid)`, `limits`, `file(fileId)`, …).
  Параметризованные — функции, статические — строки.
- `AppConfig.api.getUrl(endpoint)` (`shared/app-config.js:94`) — сборка
  итогового адреса от базового URL приложения (`getBaseUrl()`, `:59`).

Смысл конвенции — **одна точка**, где относительный путь превращается в
абсолютный: сменится схема размещения приложения — правится один метод, а не
десятки `fetch`. Магические строки `/api/v1/chat/...` в модулях чата —
рефакторинг-запах.

### Обязательные точки

**Все fetch к API** должны идти через `getUrl`:

| Модуль | Места вызова |
|---|---|
| `ChatFiles._loadLimits` | `chat-files.js:88` |
| `ChatContext._createConversation` (fallback ветка) | `chat-context.js:131` |
| `ChatContext._onConversationSwitch` | `chat-context.js:219` |
| `ChatContext.checkActiveForward` | `chat-context.js:259` |
| `ChatStream.sendAndPoll` (POST) | `chat-stream.js:36` |
| `ChatStream.pollMessage` (GET) | `chat-stream.js:85` |
| `ChatHistory.loadConversations` | `chat-history.js:61` |
| `ChatHistory.createConversation` | `chat-history.js:110` |
| `ChatHistory.deleteConversation` | `chat-history.js:149` |
| `ChatFeedback._request` | `chat-feedback.js:310` |
| `ChatRenderer._getFileUrl` | `chat-renderer.js:953` |
| `ChatRenderer._resolveFileUrl` | `chat-renderer.js:1064` |
| `ChatRenderer._decodeTextDataUrl` | `chat-renderer.js:1085` |

**Все `open_url` client-actions** с относительным URL — через
`resolveProxyUrl` (`chat-client-actions.js:141-150, 157`), который делегирует
в тот же `AppConfig.api.getUrl`. Это нужно потому, что бэк-handler'ы
(`admin.open_admin_panel`, `acts.open_act_page`, …) отдают URL вида `/admin`,
`/constructor?act_id=...` — относительными, без знания о размещении приложения.

### Регрессионная проверка

```bash
grep -rn "fetch(\s*['\"\`]/api" static/js/shared/chat/
```

Совпадений быть не должно: каждый `fetch` в модулях чата обязан идти через
`AppConfig.api.getUrl`.

## ES-модули и публикация в window

### export + window.X = X

Все ядерные модули объявляют свой объект, помечают `export`, и публикуют его в `window`:

```js
export const ChatEventBus = { ... };
window.ChatEventBus = ChatEventBus;
```

Дублирование намеренное. `export` нужен для ESM-импортов в других модулях (`import { ChatEventBus } from '../chat-event-bus.js';`). `window.X = X` нужен для inline-скриптов в шаблонах, которые ссылаются на bare-names — без window-публикации `AuthManager.requireAuth()` в inline `<script>` упадёт `ReferenceError`.

При добавлении нового чат-модуля **оба** требования обязательны: `export` И `window.X = X`.

### Порядок импортов в entry-модуле

Порядок `<script>`-тегов больше не load-bearing — entry-модули (`portal-common.js` и `constructor.js`) импортят чат в нужной последовательности через `import`-граф. Хотя ESM сам резолвит зависимости, для предсказуемости side-effect'ов (например, `ChatEventBus` на module-level вешает listeners) entry-файл импортит чат явно в порядке:

```js
import '../shared/chat/chat-event-bus.js';
import '../shared/chat/chat-renderer.js';
import '../shared/chat/chat-client-actions.js';
import '../shared/chat/chat-stream.js';
import '../shared/chat/chat-history.js';
import '../shared/chat/chat-ui.js';
import '../shared/chat/chat-files.js';
import '../shared/chat/chat-title.js';
import '../shared/chat/chat-context.js';
import '../shared/chat/chat-messages.js';  // неявно тянет chat-feedback.js
import '../shared/chat/chat-manager.js';
import '../shared/chat/chat-modal.js';        // portal
// или
import '../constructor/header/chat-popup.js'; // constructor
```

Логика порядка:

1. `chat-event-bus.js` — первым (его использует каждый, шина создаётся на module-level).
2. `chat-renderer.js` — раньше модулей, которые рендерят (`ChatMessages`, `ChatHistory`).
3. `chat-client-actions.js` — раньше `ChatRenderer._renderClientAction`.
4. `chat-stream.js` — независим, по соседству с renderer.
5. `chat-history.js` — используется `ChatContext.init`.
6. `chat-ui.js`, `chat-files.js` — слушают шину, любой порядок между event-bus и manager'ом.
7. `chat-title.js` — используется `ChatContext._createConversation`; импортируется в entry явно.
8. `chat-context.js` — использует `ChatHistory`.
9. `chat-messages.js` — использует все предыдущие через `init`; неявно подтягивает `chat-feedback.js` через static `import` — последний из ядра.
10. `chat-manager.js` — фасад, инициализирует остальные.
11. `chat-modal.js` (portal) / `chat-popup.js` (constructor) — используют `ChatManager`.

**`chat-feedback.js` в entry не импортируется** — он подтягивается автоматически через граф
`chat-messages.js` (`import { ChatFeedback } from './chat-feedback.js'`). Явно добавлять его
в entry избыточно.

### Точки риска при добавлении модуля

- Забыть `export` → импорты из других файлов упадут с `Named export 'X' not found`.
- Забыть `window.X = X` → inline-скрипты в шаблонах падают с `ReferenceError`.
- Использовать reserved-word под strict mode (`protected`, `private`, `public`, `implements`, `interface`, `package`) как имя параметра/переменной → `SyntaxError` при загрузке модуля.
- Добавить новый тип блока на бэк, забыть `case` в switch `ChatRenderer.renderBlock` — пользователь увидит unknown-block fallback. (`KNOWN_BLOCK_TYPES` здесь ни при чём — Set рендером не читается.)
- Добавить новый client-action на бэк (`names.py`), забыть `ClientActionsRegistry.register(...)` — действие молча перестанет работать.
- Захардкодить URL в callsite вместо `AppConfig.chatEndpoints` + `AppConfig.api.getUrl` — единая точка сборки адреса перестаёт быть единой.
