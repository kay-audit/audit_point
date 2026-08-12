# AI-ассистент (домен chat)

> Часть гайд-бука разработчика Audit Workstation. Точка входа и навигация по всем частям — [`developer-guide.md`](developer-guide.md).

Маршруты LLM-провайдера, agent loop, инструменты чата, внешний ИИ-агент и deep-dive по домену chat.
Нумерация разделов (§7, §11) сохранена от единого гайд-бука — ссылки вида «§7.1a» остаются валидными.


## Оглавление

- [7. AI-ассистент](#7-ai-ассистент)
  - [7.1 Архитектура: chat domain](#71-архитектура-chat-domain)
  - [7.2 ChatTool и ChatToolParam](#72-chattool-и-chattoolparam)
  - [7.3 Реестр chat tools](#73-реестр-chat-tools)
  - [7.4 Agent loop](#74-agent-loop)
  - [7.5 Knowledge bases](#75-knowledge-bases)
  - [7.6 Пример: добавление нового chat tool](#76-пример-добавление-нового-chat-tool)
  - [7.7 Фронтенд: event-driven архитектура чата](#77-фронтенд-event-driven-архитектура-чата)
  - [7.8 Внешний ИИ-агент через bus-таблицу chat_agent_messages_bus](#78-внешний-ии-агент-через-bus-таблицу-chat_agent_messages_bus)
  - [7.9 Action-handlers и ClientActionBlock](#79-action-handlers-и-clientactionblock)
  - [7.10 Text actions: «Корректор» и «Формализация нарушения»](#710-text-actions-корректор-и-формализация-нарушения)
- [11. Chat domain deep-dive](#11-chat-domain-deep-dive)
  - [11.1 Слои сервисов и их роли](#111-слои-сервисов-и-их-роли)
  - [11.2 Orchestrator: итерации agent loop](#112-orchestrator-итерации-agent-loop)
  - [11.3 ToolCallAccumulator: наследие streaming-ветки](#113-toolcallaccumulator-наследие-streaming-ветки)
  - [11.4 GigaChat-адаптер: native functions[] под капотом](#114-gigachat-адаптер-native-functions-под-капотом)
  - [11.5 Канал к внешнему ИИ-агенту: bus-таблица chat_agent_messages_bus](#115-канал-к-внешнему-ии-агенту-bus-таблица-chat_agent_messages_bus)
  - [11.6 AgentChannelPoller и AgentChannelService: фоновое сохранение ассистент-сообщений](#116-agentchannelpoller-и-agentchannelservice-фоновое-сохранение-ассистент-сообщений)
  - [11.7 Форвард и статусы chat_messages](#117-форвард-и-статусы-chat_messages)

---

## 7. AI-ассистент

### 7.1 Архитектура: chat domain

**Поток запроса (общая схема):**

```
Browser (13 ядерных модулей в static/js/shared/chat/ + ChatPopupManager в constructor)
   │ HTTP POST /api/v1/chat/conversations/{id}/messages (FormData, agent_mode)
   ▼
FastAPI (api/messages.py)
   │  → save_user_message (с транзакцией)
   │  → возвращает {message_id} (SSE нет)
   ▼
agent_mode == "off" | "adaptive":
   Orchestrator.run(...) — СИНХРОННО в POST (services/orchestrator.py → agent_loop.run_agent_loop)
   ├─→ llm_call.call_llm_with_fallback → LLM-клиент по маршруту CHAT__PROFILE
   │    └─ tool_call → tool_executor.execute_tool_call → handler в domain.integrations.*
   └─→ adaptive + forward-tool вызван → _handle_forward_terminal → AgentChannelService.submit

agent_mode == "always":
   AgentChannelService.submit — прямой проброс в шину chat_agent_messages_bus

forward (always / adaptive-решение):
   submit → INSERT вопрос в chat_agent_messages_bus + черновик chat_messages (status='streaming', agent_ref)
            + subscribe в AgentChannelPoller (фоновый poll → poll_once → status='complete')
   ▼
Browser: GET /messages/{message_id} (polling до терминального статуса) → рендер целиком
```

AI-ассистент реализован как доменный плагин `app/domains/chat/`. Транспорта SSE нет: POST `/messages` отдаёт `{message_id}`, фронт поллит `GET /messages/{message_id}` до терминального статуса и рендерит ответ целиком с декоративным «эффектом печати» (токен-стриминга нет). Локальная LLM (маршрут задаётся `CHAT__PROFILE`: `redis-bridge,gigachat` в `.env.prod`, `redis-bridge,openai` в `.env.dev` — см. `app/domains/chat/services/llm_client.py`) в режимах `off`/`adaptive` исполняется синхронно в POST через `Orchestrator.run(...)`: для **запросов на действие в интерфейсе** вызывает локальный action-tool, возвращающий `ClientActionBlock` (см. [7.9](#79-action-handlers-и-clientactionblock)); в режиме `adaptive` может форвардить **информационный запрос** во внешнего ИИ-агента через ChatTool `chat.forward_to_knowledge_agent` (см. [7.8](#78-внешний-ии-агент-через-bus-таблицу-chat_agent_messages_bus)). В режиме `always` запрос форвардится напрямую, без локального LLM-раунда.

```
Клиент → POST /api/v1/chat/conversations/{id}/messages (FormData, agent_mode)
    ↓
Сохранение user message в БД (chat_messages)
    ↓
off / adaptive: Orchestrator.run() синхронно
    ├── Загрузка истории из БД (max_history_length)
    ├── Построение messages (system + доменные промпты + history + user)
    ├── LLM вызов (OpenAI-compatible API)
    ├── Если tool_calls: выполнить каждый (с timeout), добавить результаты, повторить (до max_tool_rounds)
    └── Сохранение assistant message в БД (status='complete')
    ↓
always / forward: submit вопроса в шину + черновик (status='streaming'), дозаполнит AgentChannelPoller
    ↓
Ответ POST: {message_id}; клиент поллит GET /messages/{message_id}
```

**API эндпоинты** (`app/domains/chat/api/`, все под префиксом `/api/v1/chat`):

| Файл | Эндпоинт | Назначение |
|---|---|---|
| `conversations.py` | `POST /conversations` | создать беседу |
| | `GET /conversations` | список (с фильтром по домену) |
| | `GET /conversations/{id}` | получить беседу |
| | `DELETE /conversations/{id}` | удалить (каскадно: messages, files) |
| `messages.py` | `POST /conversations/{id}/messages` | отправить сообщение (FormData: `message`, `domains`, `agent_mode`, `files`); отдаёт `{message_id}` |
| | `GET /conversations/{id}/messages/{message_id}` | одно сообщение — фронт поллит до терминального статуса |
| | `GET /conversations/{id}/messages` | история сообщений |
| `feedback.py` | `PUT` / `DELETE /conversations/{id}/messages/{message_id}/feedback` | поставить / снять оценку ответа ассистента |
| `files.py` | `GET /limits` | лимиты файлов чата |
| | `GET /files/{file_id}` | скачать файл |
| `admin_analytics.py` | `GET /admin/feedback/stats`, `GET /admin/feedback`, `GET /admin/conversations/{id}/inspect` | аналитика фидбэка и инспектор диалога (`require_admin`) |
| `text_actions.py` | `POST /text-actions/correct`, `POST /text-actions/formalize-violation` | «Корректор» и «Формализация нарушения» (см. [7.10](#710-text-actions-корректор-и-формализация-нарушения)) |

Эндпоинта на смену заголовка беседы (`PATCH /conversations/{id}`) **нет**: title формируется на фронте из первого сообщения (`ChatTitle`) и приходит телом `POST /conversations`. Сервисный метод `ConversationService.update_title` существует, но наружу не выведен.

**Сервисы домена чата** (`app/domains/chat/services/`):

| Сервис | Файл | Назначение |
|--------|------|-----------|
| `ConversationService` | `conversation_service.py` | CRUD разговоров, фильтрация по домену |
| `MessageService` | `message_service.py` | Сохранение и загрузка сообщений |
| `FileService` | `file_service.py` | Загрузка, хранение и отдача файлов |
| `FileExtraction` | `file_extraction.py` | Извлечение текстового содержимого из файлов |
| `Orchestrator` | `orchestrator.py` | Тонкий фасад поверх agent loop: DI, history, system prompt, делегирование в `agent_loop.run_agent_loop` (см. [7.4](#74-agent-loop)). Исполняется синхронно в POST |
| `agent_loop` | `agent_loop.py` | Pure-функция `run_agent_loop` — тело цикла чата (LLM-раунды + tool calls). `_handle_forward_terminal` обрабатывает терминальный tool_call `forward_to_knowledge_agent` (вызов `AgentChannelService.submit`) |
| `llm_call` | `llm_call.py` | `call_llm_with_fallback`: retry + circuit breaker + проход по плану маршрутов |
| `llm_routing` | `llm_routing.py` | `plan_routes`: какие маршруты реально доступны и в каком порядке их пробовать |
| `tool_executor` | `tool_executor.py` | `execute_tool_call`: валидация args, конвертация типов, `asyncio.wait_for(TOOL_EXECUTION_TIMEOUT)`, запись `tool_metric` через `MetricsBatcher`. Враппер `Orchestrator._execute_tool_call` оставлен для совместимости с тестами, патчащими его на инстансе |
| `AgentChannelService` | `agent_channel.py` | Канал к внешнему агенту через bus-таблицу `chat_agent_messages_bus`: `submit`, `poll_once`, `mark_timeout`, `get_queue_details`; `map_answer_to_blocks` (ответ → блоки), `build_timeout_error_block` (см. §11.5–§11.6) |
| `AgentChannelPoller` | `agent_channel_poller.py` | Фоновый poll шины: `subscribe`/`unsubscribe`/`_tick`/`_run` (adaptive-backoff, соединение не удерживает — исполнитель берёт коннект на каждую операцию)/`reconcile`/`start`/`stop`/`get_status` |
| `button_translator` | `button_translator.py` | `translate_buttons`: кнопка с `action_id` зарегистрированного `ChatTool` → client-action `open_url` |
| `forward_tool_factory` | `forward_tool_factory.py` | `build_forward_tool_descriptor()` — статический ChatTool `forward_to_knowledge_agent` для режима `adaptive` |
| `orchestrator_helpers` | `orchestrator_helpers.py` | Чистые хелперы и константы: `safe_args`, `convert_param`, `unpack_pending_tool_call` (три формы элемента очереди GigaChat-ветки: dict, Pydantic `ChatCompletionMessageToolCall` с `.function`, плоский объект с `.name`/`.id`/`.arguments`), `ToolValidationTracker` + `build_tool_loop_exit_answer` (выход из tool-loop'а при 2 одинаковых ChatToolValidationError'ах подряд), `BASE_SYSTEM_PROMPT`, `TOOL_VALIDATION_NEUTRAL_MESSAGE`, `TOOL_VALIDATION_LOOP_THRESHOLD` |
| `BlockIdGenerator` | `app/core/chat/block_id_generator.py` | Per-message детерминированный генератор `block_id`. Формат `{message_id}:{block_type}:{i}` (per-type счётчик). Держит дедуп блоков и идемпотентность рендера во фронте |
| `UserRateLimiter` | `user_rate_limiter.py` | Per-user скользящее окно 60 сек на POST `/messages` (лимит — `CHAT__RATE_LIMIT_MESSAGES_PER_MINUTE_PER_USER`). При превышении — `ChatLimitError(429)` |
| `ChatAuditService` | `chat_audit_service.py` | Audit-лог жизненного цикла чата (создание/удаление бесед, сообщения, файлы, фидбэк). Пишет через `MetricsBatcher` (см. §9.5a в [`deploy-and-configuration.md`](deploy-and-configuration.md)) — не блокирует горячий путь |
| `ChatFeedbackService` | `chat_feedback_service.py` | Бизнес-логика обратной связи: лайк/дизлайк на ответ ассистента, валидация оценки/причин/комментария, идемпотентный upsert через `ChatMessageFeedbackRepository`, audit-событие через `ChatAuditService` |
| `ChatAnalyticsService` | `chat_analytics_service.py` | Аналитика чата для admin-просмотра (только чтение): сводные метрики фидбэка (`get_stats`), список оценок с текстом ответа (`list_feedback`), инспектор диалога с classify_route/outcome (`inspect_conversation`) |
| `LLMHealthProbe` | `llm_health_probe.py` | Process-level фоновый probe primary-LLM при открытом circuit breaker: adaptive-backoff, пингует `client.models.list()` (для redis-маршрута это чтение heartbeat'а воркера с `require_healthy=True`), закрывает breaker через `probe_succeeded()` при восстановлении — перепроверка уходит из пути пользователя в фон |
| `TextCorrectorService` | `text_actions/corrector_service.py` | Фича «Корректор»: один синхронный LLM-вызов над выделенным текстом в режиме `fix` / `readability` (см. [7.10](#710-text-actions-корректор-и-формализация-нарушения)) |
| `ViolationFormalizerService` | `text_actions/formalizer_service.py` | Формализация нарушения: 4 параллельных JSON-экстрактора + этап рекомендаций → поля карточки нарушения |
| `resolve_target` | `text_actions/llm_route.py` | Выбор клиента и модели для text-action по плану доступных маршрутов (тот же план, что у чата) |
| `route_classifier` | `route_classifier.py` | Чистые функции классификации маршрута/исхода ответа ассистента: `classify_route` (`kb_agent`/`non_kb_llm`/`smalltalk`/`unknown`) и `outcome` (`ok`/`error`) — восстанавливаются из сохранённого сообщения без изменения hot-path оркестратора |

**Persistence:** `chat_conversations`, `chat_messages` (+ колонка `agent_ref`), `chat_files`, bus-таблица `chat_agent_messages_bus` (см. §11.5).

**Транспорт.** SSE нигде нет. POST `/messages` возвращает `{message_id}`; фронт поллит `GET /messages/{message_id}` до терминального статуса (`complete`/`failed`) и рендерит сообщение целиком (декоративный «эффект печати», без токен-стриминга).

**Блоки сообщений** (`app/core/chat/blocks.py`) — 9 типов:
`TextBlock` (`text`), `CodeBlock` (`code`), `ReasoningBlock` (`reasoning`), `PlanBlock` (`plan`), `FileBlock` (`file`), `ImageBlock` (`image`), `ButtonGroup` (`buttons`), `ClientActionBlock` (`client_action`), `ErrorBlock` (`error`). Каноническое поле для `TextBlock`/`CodeBlock`/`ReasoningBlock` — `content`.

> **Новый тип блока — три места, но гейт на фронте один.** Бэк: union `MessageBlock` (`blocks.py`) + `_DiscriminatedBlock` (`schemas.py`, `Annotated[..., Tag("...")]`) — иначе `parse_message_blocks` не распознает. Фронт: whitelist `KNOWN_BLOCK_TYPES` (`chat-messages.js`). Сейчас все три списка совпадают по составу, но **`KNOWN_BLOCK_TYPES` рендером не читается**: он экспортируется в `ChatMessages` и в `window`, и на этом всё — фактический гейт рендера — `switch (block.type)` в `ChatRenderer.renderBlock`, где `default` пишет warning и отдаёт fallback-заглушку «неизвестный тип блока». Добавление типа только в `KNOWN_BLOCK_TYPES` без ветки в `switch` ничего не включит.

**Доменные исключения** (`app/domains/chat/exceptions.py`, все — наследники `AppError` с прибитым `status_code`):
`ConversationNotFoundError` (404), `ChatMessageNotFoundError` (404), `ChatFileNotFoundError` (404), `ChatLimitError` (422), `ChatFileValidationError` (422), `ChatFeedbackValidationError` (422), `TextActionValidationError` (422), `ChatToolValidationError` (400), `ConversationLockedError` (409), `OptimisticLockFailed` (409), `ChatRateLimitError` (429), `AgentChannelUnavailableError` (502 — CHECK владельца шины отклонил вопрос, см. [11.5](#115-канал-к-внешнему-ии-агенту-bus-таблица-chat_agent_messages_bus)).

#### 7.1a Маршруты LLM-провайдера

`CHAT__PROFILE` / `CHAT__FALLBACK_PROFILE` (строка, валидируется `parse_route` в `app/domains/chat/settings.py`) задают **маршрут** — ровно одно из четырёх значений: `gigachat`, `openai`, `redis-bridge,gigachat`, `redis-bridge,openai`. `parse_route(route)` разбирает строку в пару `(transport, wire_format)`: `transport` — `"http"` (напрямую) или `"redis"` (через мост); `wire_format` — `"openai"` или `"gigachat"` (проводной формат тела запроса). Имя цели после запятой в `redis-bridge`-маршрутах **совпадает** с проводным форматом — отдельной карты «цель → формат» в приложении нет; какой реальный сервер стоит за целью `openai` на стороне воркера (sglang, vLLM, ...), знает только сам воркер.

До версии 14.0.0 профилей было больше (`sglang`, `openrouter` — обе метки одного и того же OpenAI-совместимого клиента, различий в коде между ними не было) — они упразднены без обратной совместимости, схема маршрутов схлопнула их в `openai`.

| Маршрут | Транспорт | Streaming | Tool-calling | Где |
|---|---|---|---|---|
| `gigachat` | HTTP напрямую в корп. proxy `http://liveaccess/v1/gc` | **Нет** (422 EventException) | Native `functions[]` + singular `function_call` с dict-args | Корпоративный inference (когда есть прямой сетевой доступ) |
| `openai` | HTTP напрямую в OpenAI-совместимый сервер (sglang, vLLM, openrouter и т.п.) | Сервер умеет, приложение **не** использует | OpenAI `tools[]` + `tool_calls[]` | Dev / любая площадка с прямым доступом |
| `redis-bridge,gigachat` | Через Redis-воркер на DataLab к GigaChat ([`redis-llm-bridge.md`](../integrations/redis-llm-bridge.md)) | Нет (мост v1 не стримит) | Native `functions[]`, те же GigaChat-quirks ниже | ПРОМ SDP (прямого доступа к DataLab нет) |
| `redis-bridge,openai` | Через Redis-воркер на DataLab к OpenAI-совместимому серверу | Нет (мост v1 не стримит) | OpenAI `tools[]` + `tool_calls[]` | ПРОМ SDP, fallback-маршрут |

**Фабрика клиента** — `app/domains/chat/services/llm_client.py::build_llm_client(settings)` (принимает `ChatDomainSettings`, маршрут берёт из `settings.profile`). Ветвится по разобранному маршруту: `("http", "gigachat")` → `GigaChatAdapterClient` (duck-typed обёртка над `AsyncOpenAI`); `("http", "openai")` → обычный `AsyncOpenAI`; `transport == "redis"` → `RedisBridgeClient` (`redis_bridge_adapter.py`), с `target = wire_format`. Клиенты **кэшируются** — иначе per-request httpx-пулы копили бы сокеты; закрывает их `close_cached_clients()` из `on_shutdown` домена. Сборка кэш-ключа и конструирование клиента живут в одном приватном хелпере `_cached_client(...)`, куда ходят обе фабрики: ключ начинается с префикса роли (`"primary"` / `"fallback"`), дальше для HTTP-маршрута — профиль, `api_base`, `api_key`, headers, timeout, для redis-маршрута — профиль, `redis_bridge.key_prefix`, timeout (`api_base`/`api_key` мосту не нужны). Fallback-клиент строит парная `build_fallback_client(settings)`: для `redis-bridge,*` ей достаточно `CHAT__FALLBACK_PROFILE`, для HTTP-маршрутов обязательны ещё `FALLBACK_API_BASE` и `FALLBACK_API_KEY` (иначе вернёт `None`). `wire_is_gigachat(route)` — общий хелпер (`True`, если `parse_route(route)[1] == "gigachat"`): GigaChat-режимы (см. ниже) включаются по проводному формату маршрута, а не по транспорту, поэтому `redis-bridge,gigachat` подчиняется тем же quirks, что и прямой `gigachat` — «1 tool_call за раунд», трансляция `messages`/`tools`, `dict`-args и т.д. Используется и в `agent_loop.py`, и в `orchestrator.py` (`_fallback_is_gigachat`) — отдельно для primary и fallback, так что маршруты допустимо комбинировать (например, primary `gigachat`, fallback `redis-bridge,openai`).

**Транспорт `redis-bridge` (`app/domains/chat/services/redis_bridge_adapter.py`).** Прямого сетевого доступа с SDP к площадке с LLM нет, поэтому запрос едет через Redis Streams: приложение кладёт конверт заявки в `<key_prefix>requests` (`XADD`, `maxlen=1000`), ipynb-воркер на Jupyter DataLab (`scripts/llm_redis_worker.ipynb`) исполняет его против целевого бэкенда и пишет ответ в ленту `<key_prefix>resp:<request_id>`; клиент поллит её `XRANGE` каждые 0.3 с до первого куска `kind ∈ {final, error}`. Полный протокол (конверты, TTL, consumer-group, эксплуатация воркера) — [`docs/integrations/redis-llm-bridge.md`](../integrations/redis-llm-bridge.md); здесь только то, что видно из приложения:

- **Heartbeat цели.** Перед каждой заявкой `_ensure_worker_available` читает ключ `<key_prefix>worker:alive`. Ключа нет, Redis недоступен или цель не заявлена в `targets` — `openai.APIConnectionError` (connect-класс retry: быстрый отказ → fallback).
- **Дедлайн.** Ожидание ответа равно полному `CHAT__REQUEST_TIMEOUT`; по его истечении — `BridgeDeadlineError` (подкласс `APITimeoutError`). Fallback на нём срабатывает, а **retry — нет**: повтор клал бы в stream новую заявку, воркер исполнял бы дубли, а пользователь ждал бы кратно дольше (см. `_NEVER_RETRY_EXC` в `retry.py` и [7.4a](#74a-resilience-retry--circuit-breaker--fallback)).
- **Разбор ответа.** Тело `final`-конверта нормализуется до валидации (`_normalize_completion_payload`): дозаполняются `id` (GigaChat его не присылает), `object`/`created`/`model`, `choices[].index`/`finish_reason`/`message.role`. Присланное бэкендом не перетирается. Без этого штатный ответ GigaChat падал бы как «не соответствует схеме» — прямой HTTP-маршрут этого не замечает, потому что openai-SDK разбирает ответ ленивым конструктором. Невалидное тело даёт `BridgeSchemaError` (502), а 429/5xx от бэкенда и `finish_reason="error"` — `BridgeBackendError`: в обоих случаях переход на следующий маршрут — да, **retry — нет** (разбор детерминирован, а 429/5xx воркер уже повторял сам — иначе выходило бы до 15 вызовов LLM на сообщение). См. §6a в [`redis-llm-bridge.md`](../integrations/redis-llm-bridge.md).
- **Сбой Redis: до заявки ≠ после заявки.** `XADD` и цикл поллинга обёрнуты в **разные** `try`. Падение на `XADD` (конверта в стриме нет) — обычный `APIConnectionError`, ретраится как connect-класс, дубля не будет. Падение на `XRANGE` уже после успешного `XADD` — `BridgePollError` (подкласс `APIConnectionError`), и он в `_NEVER_RETRY_EXC`: воркер в этот момент исполняет первый конверт, а повтор положил бы второй с новым `request_id` — то есть второй запрос к LLM. Fallback при этом работает как обычно.
- **Ошибки воркера** приходят конвертом `kind="error"` и превращаются в `APIStatusError` с тем же `status_code`; нечитаемое/несхемное тело `final` — `APIStatusError 502` (ошибка бэкенда, а не транспорта, поэтому не маскируется под сбой Redis).
- **Health probe через мост.** `RedisBridgeClient.models.list()` не ходит в сеть, а перечитывает heartbeat с `require_healthy=True`: воркер сам пингует свои бэкенды и публикует `target_health`, поэтому [`LLMHealthProbe`](#74a-resilience-retry--circuit-breaker--fallback) закрывает circuit breaker только когда жив и воркер, и цель за ним. Пользовательские запросы этот флаг **не** проверяют — ложноотрицательный health-check воркера не должен блокировать реальные вызовы.
- Стриминга в v1 нет: `stream` и `tool_choice` из kwargs выбрасываются, как в GigaChat-адаптере. Тело запроса собирает `_build_wire_body` — для цели `gigachat` через те же `_translate_messages` / `_tools_to_functions` из `gigachat_adapter.py`, чтобы quirks жили в одном месте.

**Имена инструментов: каноническое ≠ проводное (все маршруты).** Имена ChatTool доменные, с точкой (`acts.open_act_page`). Спека OpenAI ограничивает имя function шаблоном `^[a-zA-Z0-9_-]{1,128}$`; серверы за маршрутом `openai` (sglang, vLLM) и GigaChat его не проверяют, а Anthropic-совместимые серверы за тем же маршрутом `openai` (например, openrouter) проверяют строго и отвечают `400 invalid_request_error: tools.0.custom.name: String should match pattern`. Поэтому:

- на провод (схема `tools[]`, эхо `tool_calls` в истории, упоминания инструментов в system-промпте и в `description` тулов) уходит **проводное** имя — точка заменена подчёркиванием (`acts_open_act_page`), см. `to_wire_name` в `app/core/chat/tools.py`;
- внутри приложения имя остаётся **каноническим**: ключ реестра, `tool_name` в метриках/аудите и `action_id` кнопок внешнего агента не меняются. Ответ провайдера переводится обратно через `resolve_wire_name` в `agent_loop` (каноническое имя, если модель списала его из прозы, тоже принимается);
- преобразование безусловное для всех маршрутов — подчёркивание принимают все, развилки по маршруту нет;
- два инструмента, схлопывающихся в одно проводное имя, — `RuntimeError` при регистрации (`register_tools`).

Промпты и описания тулов **не хардкодят** имена: подставляют `to_wire_name(TOOL_*)`, иначе модель зовёт имя из прозы, которого нет в схеме. Регрессия — `tests/domains/chat/test_llm_tool_name_compat.py`.

**GigaChat-нюансы (`app/domains/chat/services/gigachat_adapter.py`):**

- **Streaming не поддерживается** (proxy возвращает 422 EventException). Это не проблема: `run_agent_loop` делает non-streaming LLM-вызов, а клиенту ответ отдаётся через polling `GET /messages/{message_id}`.
- **Tools → functions**: адаптер плющит OpenAI `[{type:"function", function:{name,...}}]` в native `[{name,...}]` и кладёт в `extra_body.functions`.
- **Response: function_call → tool_calls**: GigaChat возвращает singular `function_call` (с args как dict). Адаптер синтезирует tool_call с id `gc_<hex>` и `json.dumps(args, ensure_ascii=False, default=str)`. `default=str` защищает от datetime/Decimal в args — согласовано с orchestrator `json.dumps` в логировании.
- **1 function_call за раунд** — ограничение GigaChat. Оркестратор и так работает по одному tool за итерацию, но если LLM каким-то образом вернёт несколько `tool_calls` в истории — адаптер берёт первый и предупреждает в логах.
- **Roundtrip multi-round**: ассистент-сообщение с синтетическим `tool_calls` возвращается в следующий раунд через `_translate_messages` — собирается обратно в native `function_call`. На request-стороне `arguments` обязан быть **dict** (`_args_to_dict`), а не JSON-string: GigaChat-proxy валидирует request-схему строго и отдаёт 422 на string. На путь ответа конвертация наоборот — `dict → JSON-string` (под OpenAI SDK-схему).
- **content=null + tool_calls недопустим**: GigaChat-proxy отдаёт 422 `RequestInputValidationException` на ассистент-сообщение с `content: null` при наличии `function_call`, хотя OpenAI-spec это разрешает. Оркестратор санитизирует `content = raw_msg.content or ""` в `run_agent_loop` + `_translate_messages` подстраховывает на случай Pydantic-объекта из истории.
- **arguments="" недопустим**: симметрично — для no-args вызовов (`chat.list_pages()`, `*.open_*_page()` и т.п.) SDK отдаёт `arguments=""`. Эхо в следующий LLM-вызов ломает Qwen/SGLang chat-template (`json.loads("")` → 400 "zero-length, empty document") и GigaChat-proxy (422). Хелпер `safe_args(raw)` в `orchestrator_helpers.py` нормализует пустые значения в `"{}"`; применяется в эхо tool_calls и в `json.loads(...)` перед вызовом handler'а.
- **Результат тула матчится по ИМЕНИ, не по `tool_call_id`**: native-формат не знает id — `_translate_messages` строит mapping `tool_call_id → name` из предыдущих assistant-сообщений и отдаёт результат как `{role:"function", name:...}` (не нашлось — `unknown_function` + warning). Отсюда инвариант: одно и то же имя обязано стоять в трёх местах одного диалога — объявление в `extra_body.functions[]`, эхо `function_call.name`, результат `role="function"`. Все три — проводные (см. «Имена инструментов» выше), так что переименование на границе GigaChat не ломает; но любая правка, трогающая имя в одной из трёх точек, обязана трогать и остальные две. Регрессия — `TestGigaChatRoundtrip` в `tests/domains/chat/test_llm_tool_name_compat.py`.

**Отладка GigaChat:**

| Симптом | Причина | Решение |
|---|---|---|
| `422 EventException` в логах | LLM отправили `stream=True` или есть запрещённое поле | Адаптер уже глотает stream; проверить `tool_choice`/прочие незнакомые kwargs |
| `422 RequestInputValidationException` на 2-м LLM-вызове после tool_call | В echo-сообщении `content=null` или `arguments` как JSON-string (а не dict) | Проверить, что код собирает assistant_msg вручную через `safe_args(...)` (из `orchestrator_helpers.py`) и не делает `messages.append(raw_msg)`; в адаптере — что `_translate_messages` использует `_args_to_dict(...)` |
| SGLang/Qwen `400 "Input is a zero-length, empty document"` на 2-м вызове после no-args tool_call | `arguments=""` уходит в эхо, Qwen chat-template падает на `json.loads("")` | Те же `safe_args(...)` в `orchestrator_helpers.py` — нормализует пустые args в `"{}"` |
| Tool вызвался с `arguments={}` | Сломанный JSON / dict с non-serializable | Логи содержат raw args; `default=str` гарантирует, что fall-через сработает |
| Пустой ответ | Маршрут `gigachat` / `redis-bridge,gigachat` (non-streaming) | Это by design: ответ собирается целиком и сохраняется финальным; фронт получает его через polling |
| `unknown_function` в логах адаптера | tool_call_id в истории не имеет mapping (мост-сценарий) | Проверить, что history содержит assistant-сообщение с `tool_calls[]` перед tool-message |
| `400 invalid_request_error: tools.N.custom.name: String should match pattern` (Anthropic/OpenRouter) | В `tools[]` уехало имя с точкой мимо `to_wire_name` | Проверить, что схему строит `ChatTool.to_openai_tool()`, а эхо `tool_calls` — `to_wire_name(...)`; см. «Имена инструментов» выше |

**Как добавить новый маршрут/цель:**

1. Расширить `parse_route()` в `app/domains/chat/settings.py` — новая допустимая строка маршрута (или новая цель `redis-bridge,<цель>`, если добавляется не транспорт, а очередной проводной формат/бэкенд моста).
2. Добавить ветку в `build_llm_client()` (`llm_client.py`). Если проводной формат не OpenAI-совместим — написать адаптер по образцу `gigachat_adapter.py` (для `redis-bridge` — расширить `redis_bridge_adapter.py`, переиспользуя трансляцию из существующего адаптера формата, не копируя её).
3. Если у нового формата есть свои quirks (как у GigaChat) — завести их за хелпером `wire_is_gigachat`-подобного вида, а не проверкой конкретного маршрута строкой: quirks должны включаться по проводному формату, а не по транспорту (иначе `redis-bridge,<формат>` не унаследует поведение прямого HTTP-маршрута того же формата).
4. `run_agent_loop` делает non-streaming LLM-вызов, поэтому отдельный streaming-guard для нового маршрута не нужен.
5. Документировать в `.env.dev` и `.env.prod` (блок с примером URL/маршрута и quirks) и в этой таблице; для нового транспорта — отдельно в [`redis-llm-bridge.md`](../integrations/redis-llm-bridge.md) (или аналогичном протокольном документе).
6. Покрыть тестами: разбор маршрута (`test_settings_profiles.py`), трансляция request/response, retry на 5xx, edge cases (битый JSON args, non-serializable, multi-round roundtrip).

### 7.2 ChatTool и ChatToolParam

Инструменты определяются через dataclass-ы в `app/core/chat/tools.py`:

```python
@dataclass(frozen=True)
class ChatToolParam:
    name: str              # имя параметра
    type: str              # "string", "integer", "boolean", "array", "object", "date"
    description: str       # описание на русском
    required: bool = True
    default: Any = None
    enum: list[str] | None = None
    items_type: str = "string"  # тип элементов для type="array"

@dataclass(frozen=True)
class ChatTool:
    name: str              # "acts.search_acts"
    domain: str            # "acts"
    description: str       # описание на русском
    parameters: list[ChatToolParam] = field(default_factory=list)
    handler: Callable | None = None  # async функция
    # True — handler намеренно None, оркестратор перехватывает вызов по имени
    # (так объявлен forward-tool). Подавляет startup-warning «без handler'а».
    per_request_handler: bool = False
    category: str = ""     # "action", "forward"
    # Хук трансляции серверной кнопки в клиентский action (см. 7.8a)
    button_translator: Callable[[dict], Awaitable[dict | None]] | None = None

    def to_openai_tool(self) -> dict:
        """Конвертация в OpenAI function-calling формат."""
        # → {"type": "function", "function": {"name": to_wire_name(self.name), ...}}
```

`to_openai_tool()` кладёт в схему **проводное** имя (`to_wire_name`) и всегда добавляет `additionalProperties: false`; тип `"date"` уезжает как `{"type": "string", "format": "date"}`.

### 7.3 Реестр chat tools

Глобальный реестр в `app/core/chat/tools.py`:

```python
_tools: dict[str, ChatTool] = {}

def register_tools(tools: list[ChatTool]) -> None:
    for tool in tools:
        if tool.name in _tools:
            raise RuntimeError(f"ChatTool '{tool.name}' уже зарегистрирован")
        # Два имени, схлопывающиеся в одно проводное, — тоже RuntimeError:
        # LLM их не различит (см. to_wire_name в 7.1a).
        _tools[tool.name] = tool

def get_tool(name: str) -> ChatTool | None:
    return _tools.get(name)

def get_all_tools() -> list[ChatTool]:
    return list(_tools.values())

def get_tools_by_domain(domain: str) -> list[ChatTool]:
    return [t for t in _tools.values() if t.domain == domain]

def get_openai_tools() -> list[dict]:
    """Все инструменты в OpenAI function-calling формате."""

def reset() -> None:
    """Для тестов: очистить реестр."""
    _tools.clear()
```

Инструменты регистрируются автоматически при обнаружении домена через `discover_domains()`.

**Фактический состав реестра — 6 статических инструментов + forward-descriptor.** Все статические имеют `category="action"`: это команды интерфейсу, а не источники данных. Информационных (`search`/`extract`) инструментов больше **нет** — 27 таких tools удалены вместе с пакетом `acts/integrations/ai_assistant/` (коммит «Удалить 27 информационных tools…»), ответы про данные и контент даёт внешний ИИ-агент через шину (см. [7.8](#78-внешний-ии-агент-через-bus-таблицу-chat_agent_messages_bus)).

| Имя (каноническое) | Домен | Категория | Файл |
|---|---|---|---|
| `chat.notify` | chat | `action` | `app/domains/chat/integrations/chat_tools.py` |
| `chat.list_pages` | chat | `action` | там же |
| `chat.forward_to_knowledge_agent` | chat | `forward` | `services/forward_tool_factory.py` (`handler=None`, `per_request_handler=True`) |
| `acts.open_act_page` | acts | `action` | `app/domains/acts/integrations/chat_tools.py` |
| `admin.open_admin_panel` | admin | `action` | `app/domains/admin/integrations/chat_tools.py` |
| `ck_fin_res.open_ck_fin_res_page` | ck_fin_res | `action` | `app/domains/ck_fin_res/integrations/chat_tools.py` |
| `ck_client_exp.open_ck_client_exp_page` | ck_client_exp | `action` | `app/domains/ck_client_exp/integrations/chat_tools.py` |

Все имена — константы `TOOL_*` из `app/core/chat/names.py`; forward-tool попадает в набор LLM только в режиме `agent_mode="adaptive"` (в остальных режимах `run_agent_loop` вырезает его из `tools[]`).

### 7.4 Agent loop

> Полная таблица сервисов домена чата — [11.1](#111-слои-сервисов-и-их-роли).

После рефакторинга 3.4 (`backend-hardening`) `orchestrator.py` — тонкий фасад. Цикл вынесен в отдельные модули `app/domains/chat/services/` (модуля `stream_loop.py` в дереве **нет** — вместе со стримингом он не вернулся, см. [11.3](#113-toolcallaccumulator-наследие-streaming-ветки)):

| Модуль | Что внутри |
|---|---|
| `orchestrator.py` | Класс `Orchestrator`: DI, history-load, system-prompt, делегирование в `agent_loop.run_agent_loop`. Wrapper-методы `_execute_tool_call`, `_llm_call_with_fallback` оставлены **только** для совместимости с тестами, которые патчат их через `orch._method = AsyncMock()` |
| `agent_loop.py` | Pure-функция `run_agent_loop(...)` — тело `Orchestrator.run()` (синхронное в POST). `_handle_forward_terminal` обрабатывает терминальный tool_call `forward_to_knowledge_agent` (вызов `AgentChannelService.submit`) |
| `llm_call.py` | `call_llm_with_fallback(...)` — retry + circuit breaker + проход по плану маршрутов |
| `llm_routing.py` | `plan_routes(...)` — план из реально доступных маршрутов в порядке приоритета (см. 7.4a) |
| `tool_executor.py` | `execute_tool_call(...)` — валидация args, конвертация типов, `asyncio.wait_for`, запись `tool_metric` |
| `forward_tool_factory.py` | `build_forward_tool_descriptor()` — статический ChatTool `forward_to_knowledge_agent` для режима `adaptive` |
| `orchestrator_helpers.py` | Чистые хелперы: `safe_args`, `convert_param`, `unpack_pending_tool_call`, `ToolValidationTracker`, `build_tool_loop_exit_answer`, `BASE_SYSTEM_PROMPT`, `TOOL_VALIDATION_NEUTRAL_MESSAGE`, `TOOL_VALIDATION_LOOP_THRESHOLD` |

```python
# Аргументы Orchestrator — keyword-only. settings опционален: без него
# берётся settings_registry.get("chat", ChatDomainSettings).
# file_service не инжектится — файлы читаются через get_db() внутри
# _build_user_content (извлечение текста через extract_text_async).
orchestrator = Orchestrator(msg_service=msg_service, conv_service=conv_service)

# message_id обязателен — генерируется в API-эндпоинте messages.py до вызова,
# чтобы block_id ClientActionBlock'а был детерминированным от него.
assistant_message_id = str(uuid.uuid4())

# run() исполняется СИНХРОННО в POST (SSE нет). Внутри делегирует в agent_loop.run_agent_loop(...).
# В режиме agent_mode='adaptive' доступен forward-tool; терминальный forward уходит в шину chat_agent_messages_bus.
await orchestrator.run(
    conversation_id, message, files, domains,
    message_id=assistant_message_id, agent_mode=agent_mode,
)
# Эндпоинт возвращает {message_id}; фронт поллит GET /messages/{message_id}.
```

**Внутренний цикл (`run_agent_loop`):**
1. Загрузка истории из БД (`_get_history_messages(conversation_id)`)
2. Построение system prompt (`_build_system_messages(domains)`, `BASE_SYSTEM_PROMPT` из `orchestrator_helpers.py`)
3. LLM вызов через `llm_call.call_llm_with_fallback(...)` (`settings.model`, `settings.temperature`)
4. Если `tool_calls` → выполнение через `tool_executor.execute_tool_call(...)` → повторный LLM вызов
5. Повтор до `max_tool_rounds` (по умолчанию 5)
6. Сохранение assistant message в БД с **тем же** `message_id`, что был передан из API (нужно для `block_id`-дедупа `ClientActionBlock`'ов)

**Выполнение tool call** (`tool_executor.execute_tool_call`):
- Проверка required-параметров **до** вызова handler'а: пропуск → метрика со статусом `validation_error` и `ChatToolValidationError` (его ловит `run_agent_loop` и подставляет нейтральный текст вместо сырого сообщения)
- Конвертация типов параметров (`"boolean"` → bool, `"integer"` → int, `"date"` → date) через `convert_param` из `orchestrator_helpers.py`
- Таймаут на каждый инструмент (`CHAT__TOOL_EXECUTION_TIMEOUT`, по умолчанию 30 сек, `asyncio.wait_for`); превышение → в LLM уходит текст «Ошибка: таймаут выполнения инструмента …», метрика со статусом `error`
- Результаты dict → JSON, остальное → str
- Любое другое исключение handler'а наружу **не** просачивается: LLM получает `error_id=<8 hex>` без деталей, полный stack — в лог (защита от утечки SQL/имён БД в ответ)
- Запись метрики использования в `chat_tool_metrics` через общий `MetricsBatcher` (статусы `success` / `error` / `validation_error`)

**Fallback-заглушка:** если у HTTP-маршрута не настроен API (пустой `CHAT__API_BASE` или `CHAT__API_KEY`), `run_agent_loop` возвращает `_fallback_response` — текст с инструкцией настроить `.env`. Для `redis-bridge`-маршрутов эта проверка пропускается: им `api_base`/`api_key` не нужны, транспорт живёт на общем Redis.

#### 7.4a Resilience: retry + circuit breaker + fallback

Локальный LLM-клиент окружён тремя независимыми слоями устойчивости. Цель — деградировать корректно, не вешать UX, не дрочить упавший primary бесконечно.

**1. Retry (`app/domains/chat/services/retry.py`).** Экспоненциальный backoff с джиттером, **два класса ошибок с разными лимитами попыток**:

| Класс | Что в него входит | Лимит попыток |
|---|---|---|
| **transient** (сервер жив, но занят/медленный) | 408 (всегда), 429 (при `CHAT__RETRY__ON_429`), 5xx incl. 503 (при `CHAT__RETRY__ON_5XX`), `httpx.ReadTimeout`/`WriteTimeout`/`RemoteProtocolError`, `openai.APITimeoutError` | `CHAT__RETRY__MAX_ATTEMPTS` (5) |
| **connect** (сервер лёг / обрыв соединения) | `httpx.ConnectError`, `httpx.PoolTimeout`, «чистый» `openai.APIConnectionError` | `CHAT__RETRY__CONNECT_MAX_ATTEMPTS` (2) |

Отдельный урезанный кап для connect-класса нужен, чтобы при лежащем primary быстро упасть на fallback, а не выжидать полный transient-цикл. Тонкость иерархии: `openai.APITimeoutError` — подкласс `APIConnectionError`, но ловится **раньше** него и идёт по transient-классу.

База backoff — `CHAT__RETRY__BACKOFF_BASE_SEC` (2.0 сек); формула `delay_n = min(base * 2^(n−1) + random.uniform(0, 0.5), 60.0)`. Retry оборачивает каждый вызов к LLM (`Orchestrator._completions_create`), прозрачно для оркестратора.

**2. Circuit breaker (`app/domains/chat/services/circuit_breaker.py`).** Конечный автомат на 3 состояния:

| Состояние | Что значит | Переход |
|---|---|---|
| `closed` | Норма, запросы идут в primary | После `failure_threshold` подряд ошибок → `open` |
| `open` | Primary размкнут, все запросы идут в fallback (если настроен) | Таймерный режим: через `recovery_timeout_sec` → `half_open`. Режим `external_recovery`: перехода по таймеру **нет**, закрывает только `LLMHealthProbe.probe_succeeded()` |
| `half_open` | Пробный запрос в primary | Успех → `closed`; ошибка → `open` |

Настройки: `CHAT__CIRCUIT_BREAKER_FAILURE_THRESHOLD` (2 ошибки подряд), `CHAT__CIRCUIT_BREAKER_RECOVERY_TIMEOUT_SEC` (60 сек). Состояние — process-local (нет общей памяти между воркерами; для проекта single-worker этого достаточно).

**`external_recovery` — рабочий режим на ПРОМе.** `Orchestrator._get_circuit_breaker()` включает его, когда одновременно настроен fallback и включён `CHAT__HEALTH_PROBE__ENABLED`. Смысл: пробой primary не должен становиться живой пользовательский запрос — перепроверку делает фоновый `LLMHealthProbe` (см. слой 4), а `is_open()` в этом режиме всегда возвращает True, пока probe не закроет circuit. Счётчик ошибок наращивают только реальные сбои провайдера (`_is_provider_failure`: `APIConnectionError`/`APITimeoutError`/`asyncio.TimeoutError`/5xx); 4xx circuit не трогают и на fallback не уводят.

**3. Fallback-провайдер.** Задаётся `CHAT__FALLBACK_PROFILE`; **пустое значение = fallback выключен** (pydantic-settings передаёт `""`, валидатор превращает его в `None`). Для HTTP-маршрутов дополнительно обязательны `CHAT__FALLBACK_API_BASE` и `CHAT__FALLBACK_API_KEY`, для `redis-bridge,*` — не нужны. Поддерживаются все четыре маршрута в любой комбинации с primary; ПРОМ-конфигурация — primary `redis-bridge,gigachat`, fallback `redis-bridge,openai`. `_adjust_kwargs_for_fallback` подменяет модель на `CHAT__FALLBACK_MODEL` и снимает `stream`, если fallback — GigaChat.

**3a. План маршрутов (`llm_routing.plan_routes`).** Порядок вызова не зашит «primary → fallback»: перед запросом маршруты спрашиваются на доступность, и план строится только из существующих, с сохранением приоритета. HTTP-маршрут доступен, если заданы его `API_BASE`/`API_KEY`; `redis-bridge,<цель>` — если воркер жив и заявил `<цель>` в `targets` heartbeat'а (одно чтение heartbeat'а на весь план). Практические следствия:

- недоступный маршрут не отнимает ни ретраев, ни счётчика circuit breaker'а — поход в цель, которой у воркера нет, не совершается вовсе;
- если доступен только fallback, вызов идёт **сразу** на него: это не «сбой primary», а работа по единственному живому маршруту;
- если не осталось ни одного маршрута, запрос не отправляется — `ChatLLMUnavailableError` (503, `chat-llm-unavailable`), причина по каждому маршруту в логе, пользователю отдельный текст вместо «Временная ошибка AI-сервиса»;
- `target_health` маршрут не исключает, а опускает в конец плана (ложноотрицательный health-check воркера не должен лишать пользователя единственного провайдера); при открытом breaker'е primary из плана **исключается** — но только если есть чем его заменить, единственный маршрут остаётся. Состояние breaker'а спрашивается лишь тогда, когда ответ может изменить план: `is_open()` сам переводит `open → half_open` по таймеру, поэтому лишний вызов испортил бы состояние.

Счётчик circuit breaker ведёт только primary-маршрут: breaker существует, чтобы не ходить в лежащий основной провайдер, и сбои fallback'а размывали бы эту семантику. Детали и таблица доступности — §6b в [`redis-llm-bridge.md`](../integrations/redis-llm-bridge.md).

**4. Health probe (`llm_health_probe.py`).** Один asyncio-task на процесс (hook `chat.llm_health_probe`). В `closed` ничего не пингует; в `open`/`half_open` дёргает `client.models.list()` с коротким таймаутом `CHAT__HEALTH_PROBE__TIMEOUT_SEC` (клиент строится копией настроек с укороченным `request_timeout` — отдельный кэш-ключ, основной клиент не затрагивается). Успех → `probe_succeeded()` закрывает circuit и сбрасывает интервал в `POLL_MIN_INTERVAL_SEC` (2.0 c); провал → `probe_failed()`, интервал растёт × `POLL_BACKOFF_MULTIPLIER` (1.5) до `POLL_MAX_INTERVAL_SEC` (30.0 c). Выключается `CHAT__HEALTH_PROBE__ENABLED=false` — тогда breaker возвращается к таймерному `recovery_timeout_sec`. `get_status()` отдаёт снимок (`breaker_state`, `current_interval_sec`, `last_ping_ok`) в diagnostics-эндпоинт.

```
LLM call
  └─→ Retry (408/429/5xx/timeout, backoff; connect-класс — свой кап)
       └─→ CircuitBreaker (closed → запрос; open → fallback)
            ├─→ Primary (CHAT__PROFILE, CHAT__API_BASE, CHAT__API_KEY, CHAT__MODEL)
            └─→ Fallback (CHAT__FALLBACK_PROFILE, ...FALLBACK_MODEL)
                 ▲
                 └── LLMHealthProbe пингует primary в фоне и закрывает circuit
```

**Когда какой слой работает:**

- Транзиентная ошибка (1 раз 429) → retry с backoff, fallback не задействован.
- 2 сбоя primary подряд (`failure_threshold`) → circuit размыкается, следующий запрос идёт сразу в fallback (минуя retry на primary).
- Возврат к primary — по успешной фоновой пробе `LLMHealthProbe` (в `external_recovery`) либо по `recovery_timeout_sec` + `half_open`-проба (если probe выключен).

Состояние circuit breaker наружу отдаётся не метриками, а через diagnostics: `LLMHealthProbe` регистрируется в `observability_registry` под именем `chat.llm_health_probe` (`register_background_task`), и его `get_status()` показывает `breaker_state` / `last_ping_ok` в админском diagnostics-эндпоинте — удобно для наблюдения за затяжным `open`-состоянием. Про сам эндпоинт — §9.5b в [`deploy-and-configuration.md`](deploy-and-configuration.md).

**Покрытие Retry — что ретраится / что нет** (`app/domains/chat/services/retry.py`):

| Класс ошибки | Ретраится | Класс / условие |
|---|---|---|
| `408 Request Timeout` | Да | transient, всегда |
| `429 Too Many Requests` | Да | transient, если `CHAT__RETRY__ON_429=true` |
| `5xx` (включая 503) | Да | transient, если `CHAT__RETRY__ON_5XX=true` |
| `httpx.ReadTimeout` / `WriteTimeout` / `RemoteProtocolError` | Да | transient, всегда |
| `openai.APITimeoutError` | Да | transient (ловится раньше `APIConnectionError`) |
| `httpx.ConnectError` / `httpx.PoolTimeout` | Да | connect, лимит `CONNECT_MAX_ATTEMPTS` |
| `openai.APIConnectionError` («чистый») | Да | connect, лимит `CONNECT_MAX_ATTEMPTS` |
| `httpx.ConnectTimeout` | Явно **не** перечислен | В списках `retry.py` его нет; до retry он доезжает уже завёрнутым SDK в `openai.APITimeoutError` / `APIConnectionError` |
| `400` / `401` / `403` / `404` / `422` | **Нет** | Это ошибки запроса — повтор не поможет |
| `ChatLimitError` / `ChatFileValidationError` / `ChatRateLimitError` | **Нет** | Доменные ошибки бизнес-логики |
| `BridgeDeadlineError` (redis-мост) | **Нет** | Дедлайн моста = полный `CHAT__REQUEST_TIMEOUT`; повтор клал бы дубль-заявку в stream. Fallback при этом срабатывает (подкласс `APITimeoutError`) |
| `BridgePollError` (redis-мост) | **Нет** | Сбой Redis на поллинге ответа, когда заявка уже в stream: повтор положил бы второй конверт, пока воркер исполняет первый. Fallback срабатывает (подкласс `APIConnectionError`). Сбой на самом `XADD` остаётся ретраибельным `APIConnectionError` |

Полные сценарии и edge-case'ы — [`docs/testing/retry-test-scenarios.md`](../testing/retry-test-scenarios.md).

#### 7.4b Resilience доменных батчеров и фоновых задач

Помимо LLM-слоя, у приложения есть несколько фоновых сервисов, написанных по единому паттерну: batched write через `MetricsBatcher` + lifespan hook + ленивый fallback в репозитории. Цель — не блокировать горячий путь (HTTP-ответ) одиночным INSERT'ом и пережить перезапуски без потери данных.

**1. `ActAuditLogBatcher`** (`app/domains/acts/services/audit_log_batcher.py`). Накапливает `ActAuditLogRecord` и flush'ит пакет в `audit_log` через `executemany`:

| Параметр | Значение | Смысл |
|---|---|---|
| `batch_size` | `50` | Триггер flush по размеру пакета |
| `flush_interval_sec` | `30.0` | Триггер flush по времени |
| `max_buffer_size` | `5000` | Защитный потолок — при переполнении дропаются старые записи |

Управляется hook'ом `acts.audit_log_batcher` (startup/shutdown). **Ленивый fallback в `ActAuditLogRepository.log()`**: если активный батчер из `deps.get_audit_log_batcher()` есть — пишет через него; если нет — одиночный INSERT прямо в БД. Это нужно тестам (нет lifespan'а) и раннему startup (до того, как hook отработал). При падении самого батчера `.add()` репозиторий тоже падает в fallback.

> Блокировки актов больше не нуждаются в отдельном cleanup-таске: с переездом на Redis (см. §10 в [`data-model-acts.md`](../architecture/data-model-acts.md)) лок — ключ с TTL, истекает сам, снимать нечего.

**2. `AgentChannelPoller`** (`app/domains/chat/services/agent_channel_poller.py`). Один asyncio-task на процесс, поллит bus-таблицу `chat_agent_messages_bus` по подписанным `question_uid` (sequence-диаграмма — [`docs/architecture/agent-channel-sequence.md`](../architecture/agent-channel-sequence.md), детали — [11.6](#116-agentchannelpoller-и-agentchannelservice-фоновое-сохранение-ассистент-сообщений)). Adaptive backoff:

```
interval = poll_min_interval_sec  # при наличии ответов или без подписок
interval = min(interval * poll_backoff_multiplier, poll_max_interval_sec)  # при пустом тике
```

Параметры через `CHAT__AGENT_CHANNEL__*`:

| Env-переменная | Дефолт | Смысл |
|---|---|---|
| `POLL_MIN_INTERVAL_SEC` | `2.0` | Минимальный интервал (при активности). Снижение даст более отзывчивый чат ценой роста QPS к GP |
| `POLL_MAX_INTERVAL_SEC` | `10.0` | Максимальный (при тишине от агента) |
| `POLL_BACKOFF_MULTIPLIER` | `1.5` | Шаг роста при пустом тике |

Соединение из пула тик не удерживает вовсе — работа идёт через исполнитель (`DbExecutor`, §6.3a в [`database.md`](database.md)), берущий коннект на каждую SQL-операцию отдельно и сразу возвращающий его. При появлении активности (ответ, рост reasoning, изменение очереди) — interval сбрасывается в `poll_min`. Управляется hook'ом `chat.agent_channel_poller`; `reconcile()` восстанавливает подписки из streaming-черновиков после рестарта uvicorn.

**Общий паттерн lifespan hooks для батчеров:**

```python
async def _start_my_batcher(app: FastAPI) -> None:
    batcher = MyBatcher(...)
    await batcher.start()
    set_my_batcher(batcher)               # положить в deps
    app.state.my_batcher = batcher        # запомнить для shutdown

async def _stop_my_batcher(app: FastAPI) -> None:
    batcher = getattr(app.state, "my_batcher", None)
    set_my_batcher(None)
    if batcher is not None:
        await batcher.stop()
```

Все четыре батчера (`acts.audit_log`, `chat.tool_metrics`, `chat.audit_log`, `admin.http_metrics`) написаны по этому шаблону.

### 7.5 Knowledge bases

`KnowledgeBase` определяется в `DomainDescriptor` и отображается в UI как toggle в настройках:

```python
KnowledgeBase(
    key="knowledge_base_oarb",
    label="База Знаний ОАРБ",
    description="Поиск по базе знаний отдела аудита розничного бизнеса",
)
```

Все три БЗ объявлены в `app/domains/acts/__init__.py`: `knowledge_base_oarb`, `knowledge_base_sources`, `knowledge_base_tools`.

Доступ к внешнему агенту во фронте управляется тумблером «База знаний ОАРБ» (3 позиции: Выключен / Адаптивный / Всегда; `localStorage['assistant_oarb_mode']`), который маппится на form-параметр `agent_mode` (`off`/`adaptive`/`always`). В режиме `adaptive` оркестратор сам решает, форвардить ли запрос через ChatTool `chat.forward_to_knowledge_agent`; в `always` — прямой проброс. Две другие базы знаний («источников», «инструментов») в UI выключены.

### 7.6 Пример: добавление нового chat tool

> Пошаговый рецепт с нюансами — [`docs/guides/adding-chat-tool.md`](adding-chat-tool.md); здесь — скелет. Новые tools заводятся только категории `action` (см. врезку в конце раздела).

**Шаг 1.** Константа имени в `app/core/chat/names.py`:

```python
TOOL_OPEN_REPORT_PAGE: Final[str] = "reports.open_report_page"
```

**Шаг 2.** Handler, возвращающий JSON-сериализованный `ClientActionBlock`:

```python
# app/domains/reports/integrations/action_handlers.py
async def open_report_page_handler(*, report_id: int) -> str:
    """Резолвит отчёт → ClientActionBlock(open_url) или текст с просьбой уточнить."""
    # ... логика (импорты get_db/get_adapter — ВНУТРИ функции, см. §8 в testing.md)
    return json.dumps({
        "type": "client_action",
        "action": ACTION_OPEN_URL,
        "params": {"url": f"/reports?report_id={report_id}"},
        "label": "Открываю отчёт…",
    }, ensure_ascii=False)
```

**Шаг 3.** Определить ChatTool:

```python
# app/domains/reports/integrations/chat_tools.py
def get_chat_tools() -> list[ChatTool]:
    from app.domains.reports.integrations.action_handlers import (
        open_report_page_handler,
    )
    return [
        ChatTool(
            name=TOOL_OPEN_REPORT_PAGE,
            domain="reports",
            description="Открывает страницу отчёта по его ID.",
            parameters=[
                ChatToolParam("report_id", "integer", "ID отчета"),
            ],
            handler=open_report_page_handler,
            category="action",
        ),
    ]
```

**Шаг 4.** Зарегистрировать в DomainDescriptor:

```python
# app/domains/reports/__init__.py
def _build_domain():
    from app.domains.reports.integrations.chat_tools import get_chat_tools
    return DomainDescriptor(
        ...,
        chat_tools=get_chat_tools(),
    )
```

**Шаг 5.** Написать тест (см. §8 в [`testing.md`](testing.md)).

**Фактическая структура интеграции в репозитории — плоская:**

```
app/domains/<your_domain>/integrations/
├── chat_tools.py        — определения ChatTool (get_chat_tools())
└── action_handlers.py   — handler'ы action-tool'ов + button_translator'ы
```

Так устроены все домены с инструментами (`acts`, `admin`, `ck_fin_res`, `ck_client_exp`); у домена `chat` handler'ы вынесены в отдельные модули (`list_pages_handler.py`, `notify_handler.py`). Развитой иерархии `helpers/export_*.py` + `queries/` + `formatters/` больше нет — она обслуживала 27 удалённых информационных tools (см. [7.3](#73-реестр-chat-tools)).

> **Важно:** для **информационных** запросов (про данные/контент актов и БЗ) локальные tools регистрировать НЕ нужно — это работа внешнего ИИ-агента (см. [7.8](#78-внешний-ии-агент-через-bus-таблицу-chat_agent_messages_bus)). Локальные tools оставлять только для **действий в интерфейсе** (открыть/создать/уведомить — см. [7.9](#79-action-handlers-и-clientactionblock)).

**Чек-лист «новый action-tool»:**

1. Константа имени в `app/core/chat/names.py` (`ACTION_*` или `TOOL_*`).
2. Handler в `app/domains/<domain>/integrations/chat_tools.py` (для tool) или в фабрике `client_action` (для action).
3. Регистрация в `app/core/chat/tools.py` registry.
4. **Фронтенд:** добавить имя в whitelist `static/js/shared/chat/chat-client-actions.js` (если это `client_action`), плюс реализовать handler в `ChatClientActionsRegistry`.
5. Если есть UI-кнопка из ассистента — см. **§7.8a button_translator** для маппинга текста кнопки → action.
6. Тест: `tests/domains/chat/` — проверить, что action/tool регистрируется и выполняется без сырых строк.

### 7.7 Фронтенд: event-driven архитектура чата

> Этот раздел — про **доменную интеграцию** чата с бэком (polling сообщений, ClientAction идемпотентность). Архитектура самих модулей чата — в [`docs/architecture/chat-frontend-architecture.md`](../architecture/chat-frontend-architecture.md). Общий каркас фронта (ES-модули и entry-файлы, window-singletons, `AppConfig.chatEndpoints`) — в [`docs/architecture/frontend-architecture.md`](../architecture/frontend-architecture.md) §2 и §3.3.

Фронтенд чата — vanilla ES6 без бандлера, **13 ядерных модулей** в `static/js/shared/chat/` плюс региональный 14-й (`ChatPopupManager` в `static/js/constructor/header/chat-popup.js`), связанных через шину событий `ChatEventBus`. Три режима чата (inline на landing, modal в portal, popup в constructor) используют единый набор ядерных модулей.

**Модули и зоны ответственности:**

```
ChatEventBus           — шина событий (pub/sub, синхронная). Загружается ПЕРВОЙ.
ChatRenderer           — рендеринг блоков и сообщений в DOM
ChatClientActionsRegistry — реестр и исполнитель ClientActionBlock-команд
                          (open_url, notify, trigger_sdk; whitelist на фронте)
ChatStream             — POST /messages + polling GET /messages/{message_id} до терминала
ChatHistory            — список бесед, CRUD, сворачиваемая панель
ChatUI                 — typing-индикатор, блокировка ввода, scroll, авторесайз
ChatFiles              — валидация файлов, drag-drop, превью, лимиты
ChatContext            — управление беседами, режим «База знаний ОАРБ», домены
ChatMessages           — рендеринг user/bot сообщений (целиком, эффект печати)
ChatManager            — тонкий фасад: инициализирует модули, делегирует через EventBus
ChatModalManager       — модальное окно (portal)
ChatFeedback           — панель обратной связи под ответом ассистента: «Копировать» ·
                         👍 · 👎; для дизлайка — опциональная форма с категориями причин
                         и комментарием; оценка переключаемая/отменяемая, идемпотентна
ChatTitle              — формирование title новой беседы по первому сообщению пользователя
                         (word-boundary обрезка до MAX_LENGTH=40 символов; fallback на
                         «Файлы: <имя>» / «Новая беседа»)

# Региональный 14-й модуль (вне shared/chat/):
ChatPopupManager       — popup окно для редактора актов
                         (static/js/constructor/header/chat-popup.js)
```

**Транспорт (от backend к фронту):**

SSE нигде нет. POST `/messages` отдаёт `{message_id}`; `ChatStream` поллит `GET /conversations/{cid}/messages/{message_id}` до терминального статуса (`complete`/`failed`) и рендерит сообщение целиком (декоративный «эффект печати», без токен-стриминга). Сообщение состоит из блоков `app/core/chat/blocks.py` (`text`/`code`/`reasoning`/`plan`/`file`/`image`/`buttons`/`client_action`/`error`); `client_action` исполняется идемпотентно по `block_id`. Статус `streaming` означает «форвард к агенту в полёте» — фронт показывает typing-облако и продолжает polling.

**Порядок импорта** — не в шаблонах, а в entry-модулях `static/js/entries/portal-common.js` и `static/js/entries/constructor.js` (bundler'а нет, граф резолвит браузер):

```
chat-event-bus.js → chat-renderer.js → chat-client-actions.js →
chat-stream.js → chat-history.js → chat-ui.js → chat-files.js →
chat-title.js → chat-context.js → chat-messages.js → chat-manager.js →
chat-modal.js (portal) / chat-popup.js (constructor)
```

`chat-event-bus.js` обязан идти ПЕРВЫМ — остальные модули публикуют `window.X = ...` и подписываются на шину на module-level. `chat-feedback.js` в entry не импортируется явно: он приходит транзитивно через `chat-messages.js`.

**Ключевые паттерны:**

- **Защита от повторной инициализации**: каждый модуль хранит `_initialized` флаг и выходит из `init()` при повторном вызове
- **Ленивая инициализация**: `ChatModalManager`/`ChatPopupManager` вызывают `ChatManager.init()` при первом открытии
- **ClientAction идемпотентен по `block_id`**: каждый `ClientActionBlock` несёт `block_id` — **обязательное поле** (без `default_factory`). Оркестратор переписывает его на детерминированный формат `f"{message_id}:client_action:{i}"` в `_parse_client_action_result` (где `i` — индекс client_action-блока в сообщении). Нумерацию ведёт `BlockIdGenerator` (`app/core/chat/block_id_generator.py`) — один экземпляр на message_id. При перезагрузке вкладки фронт получает **тот же id** → `sessionStorage['chat:executedActions']` (max 500 элементов, FIFO eviction) сматчит → action не выполняется повторно. Без детерминизма (старая семантика `default_factory=uuid4`) после reload каждый раз генерировался новый uuid, что вызывало бесконечный редирект-цикл. Единая точка исполнения — `ClientActionsRegistry.executeBlock(block)`. **Не вызывай `.execute(...)` напрямую** — обойдёшь `block_id`-чек
- **Восстановление состояния через polling**: источник истины — БД. При переключении/возврате в беседу `GET /messages` отдаёт сообщения, включая черновики форварда со `status='streaming'`; для них фронт показывает typing-облако и продолжает поллить `GET /messages/{message_id}` до `complete`/`failed`. Никаких курсоров/Resume SSE — нет состояния, которое можно потерять при разрыве
- **DOM API в `chat-history`**: список бесед рендерится через `document.createElement`/`textContent`/`dataset`, не через `innerHTML` — защита от XSS через title беседы (= первое сообщение пользователя)
- **Whitelist в `chat-client-actions`**: `open_url` принимает только `http:/https:/mailto:/relative`; `trigger_sdk` — только методы из `ALLOWED_SDK_METHODS` (по умолчанию пустой)

### 7.8 Внешний ИИ-агент через bus-таблицу chat_agent_messages_bus

Для запросов про **данные/контент** (БЗ актов, регламенты, нормативы) запрос форвардится внешнему ИИ-агенту коллег через **единую bus-таблицу** `chat_agent_messages_bus` в основной БД. Агент-сервис разрабатывается отдельной командой; AW не делает HTTP-запросов к нему — взаимодействие исключительно через эту таблицу. Полная картина транспорта — §11.5–§11.7.

> Bus-таблица `chat_agent_messages_bus` хранится в БД **без app-префикса** — её имя задаётся `CHAT__AGENT_CHANNEL__TABLE_NAME` целиком (дефолт `chat_agent_messages_bus`, `DATABASE__TABLE_PREFIX` к ней не добавляется). `chat_messages`/`chat_files` далее тоже даны без префикса для краткости, но в БД хранятся **с** префиксом `DATABASE__TABLE_PREFIX` (по умолчанию `t_db_oarb_audit_act_`). Полные SQL-сниппеты для копи-пасты — в [`external-agent-imitation.sql`](../integrations/external-agent-imitation.sql).

**Поток** (SSE нигде нет):

1. Клиент POST `/messages` с form-параметром `agent_mode` (`off`/`adaptive`/`always`). В `off`/`adaptive` оркестратор исполняется синхронно (`orchestrator.run`); в `always` — прямой проброс.
2. Форвард (`always` либо решение оркестратора в `adaptive`): `AgentChannelService.submit` **в одной транзакции** INSERT'ит вопрос в `chat_agent_messages_bus` (`role='user'`, `status='pending'`) + создаёт черновик `chat_messages` (`status='streaming'`, `agent_ref=<uid вопроса>`), затем подписывает его в `AgentChannelPoller`. Транзакция обязательна: вопрос без draft'а (или наоборот) оставил бы осиротевшую строку, вечно занимающую слот лимита. Если поллер не инициализирован — форвард **не выполняется**, сразу пишется error-сообщение (осиротевший streaming-draft не создаётся, иначе беседу нельзя было бы удалить).
3. POST отдаёт `{message_id}`. Фронт поллит `GET /messages/{message_id}` до терминального статуса.
4. Фоновый `AgentChannelPoller` поллит шину; на каждый тик вызывает `AgentChannelService.poll_once(*, assistant_message_id, question_uid, last_reasoning_len, want_queue_position)` → `dict {outcome, question_status, answer_exists, reasoning_len, queue_ahead, answer_updated_at}`. При росте `metadata.reasoning` без финального ответа — `poll_once` делает `upsert_block` (replace-семантика, block_id `{answer_id}:reasoning:0`) для инкрементального дозаполнения черновика. При наличии финального ответа агента — `map_answer_to_blocks`, финализация черновика (`status='complete'`), best-effort закрытие вопроса в шине (`_set_status_safe(..., 'completed'|'failed')` — словарь владельца; CheckViolation глотается с warning'ом). По истечении idle-таймаута (claim или answer) — `mark_timeout(reason='claim'|'answer')` (draft → `failed`; error-блок с кодом `agent_claim_timeout` или `agent_timeout`).

**Bus-таблица `chat_agent_messages_bus`** — структуру задаёт и таблицей владеет сторона внешнего агента. Отдельной колонки `conversation_id` в шине НЕТ; связь: `chat_id = chat_messages.conversation_id`. `role` CHECK: `user`/`assistant`/`system` (не `tool`). `status` CHECK: `pending`/`processing`/`completed`/`failed` (не `in_progress`/`complete`/`error`/`timeout`). Полная структура и детали транспорта — **§11.5–§11.7**.

**Архитектурные ограничения:**

- **Polling-only**, без LISTEN/NOTIFY и постоянных соединений (между AW и агент-сервисом нет прямой сети — оба общаются только через БД).
- **Структура шины — внешний контракт**: типы uuid/text/timestamptz задаёт владелец-агент; наша конвенция VARCHAR(36) к шине не применяется (dev-имитация зеркалит прод, чтобы ловить те же type-ошибки).
- **Poller не держит соединение вовсе**: тик работает через исполнитель (`DbExecutor`), берущий коннект на каждую SQL-операцию отдельно и сразу возвращающий его. `reconcile()` восстанавливает подписки из streaming-черновиков после рестарта uvicorn.
- **Лимит параллельных запросов**: `AgentMessageRepository.count_active_for_user(user_id, *, pending_created_after, processing_updated_after)` ≥ `CHAT__MAX_PARALLEL_STREAMS_PER_USER` (default 3) → `submit` бросает `ChatLimitError` до записей. В режиме `always` исключение долетает до эндпоинта → HTTP 422; в `adaptive` его перехватывает `_handle_forward_terminal` и сохраняет обычное сообщение с error-блоком `code="agent_limit"` (HTTP остаётся 200, ошибку пользователь видит в чате). Проверка — count-then-insert, не атомарна: два конкурентных запроса на границе могут оба пройти, это защита от злоупотребления, а не строгий инвариант. Двойная отсечка: `pending`-строки считаются живыми по `created_at` (окно `CLAIM_TIMEOUT_SEC`), `processing`-строки — по `updated_at` (окно `ANSWER_TIMEOUT_SEC`); зависшая строка с нетерминальным статусом (CHECK владельца не позволил записать `failed`) не съедает слот навсегда.
- **Retention** — задача администратора (в приложении НЕ реализован).

**Ключевые модули:**
- `app/domains/chat/services/agent_channel.py` — `AgentChannelService` (`submit`, `poll_once`, `mark_timeout`, `get_queue_details`); `map_answer_to_blocks` (порядок: reasoning из `metadata.reasoning` (legacy `thinking`) → text → buttons (block_id `{id}:btn:0`) → media image/file), `build_timeout_error_block`.
- `app/domains/chat/services/agent_channel_poller.py` — `AgentChannelPoller` (`subscribe`/`unsubscribe`/`_tick`/`_run` с adaptive-backoff без удержания conn/`reconcile`/`start`/`stop`/`get_status`).
- `app/domains/chat/services/button_translator.py` — `translate_buttons`: кнопка с `action_id` зарегистрированного `ChatTool` → client-action `open_url`.
- `app/domains/chat/services/forward_tool_factory.py` — `build_forward_tool_descriptor()`: статический ChatTool `chat.forward_to_knowledge_agent` для режима `adaptive` (LLM может его вызвать).
- `app/domains/chat/services/{llm_client,retry,gigachat_adapter,redis_bridge_adapter}.py` — провайдер-агностичная LLM-инфра (маршруты, retry, проводные форматы).

**Лимит размера блока.** Текст блока `reasoning`/`text` от агента обрезается до `CHAT__AGENT_CHANNEL__MAX_BLOCK_TEXT_SIZE` UTF-8 байт (default 262144 = 256 KB, срез по границе code-point) с маркером `…[обрезано]` + WARNING-лог.

#### Шпаргалка по имитации агента

Полный SQL — в [`external-agent-imitation.sql`](../integrations/external-agent-imitation.sql) (DBeaver/psql), уже обновлён под фактический протокол владельца шины. Минимум: найти строку-вопрос пользователя в `chat_agent_messages_bus` (`role='user'`, `status='pending'`), вставить ответ агента (`role='assistant'`, новый `id`, **`reply_to=<id вопроса>`**, `status='completed'`, `content`/`metadata.reasoning`/`buttons`/`media` по необходимости), затем на строке-вопросе выставить `status='completed'`. `AgentChannelPoller` найдёт ответ по `reply_to` и финализирует черновик `chat_messages`.

#### Когда «у меня не работает»

- В чате тишина после вопроса → нет вопроса в `chat_agent_messages_bus` ⇒ форвард не произошёл (тумблер «База знаний ОАРБ» = Выключен, либо `adaptive` и LLM не вызвал forward-tool, либо tool не зарегистрирован для домена).
- Ответ не появляется → проверь, что `AgentChannelPoller` стартовал (`chat.agent_channel_poller` hook в логах startup) и подписка прошла. Параметры цикла — `CHAT__AGENT_CHANNEL__POLL_MIN_INTERVAL_SEC` / `POLL_MAX_INTERVAL_SEC` / `POLL_BACKOFF_MULTIPLIER`.
- Сообщение «зависло» в статусе `streaming` — idle-таймауты двухфазные: `CLAIM_TIMEOUT_SEC` (1800 с) пока агент не взял вопрос (`pending`), затем `ANSWER_TIMEOUT_SEC` (600 с) пока не пришёл ответ (`processing`); по истечении `mark_timeout` переведёт в `failed` с error-блоком.
- HTTP 422 при отправке → достигнут `CHAT__MAX_PARALLEL_STREAMS_PER_USER` активных запросов пользователя.

#### 7.8a Button Translator

Внешний агент возвращает кнопки в **семантическом** виде — с `action_id`, равным имени серверного `ChatTool` (например, `acts.open_act_page`). Фронт такой `action_id` не понимает: его реестр (`window.ClientActionsRegistry`) знает только клиентские примитивы — `open_url`, `notify`, `trigger_sdk`. Между ними должен встать **резолвер**, который умеет ходить в БД и превращать «открой акт КМ-23-001» в `open_url` с готовым `/constructor?act_id=42`. Этим занимается `button_translator`.

**Где применяется** (`app/domains/chat/services/button_translator.py`):
- В `AgentChannelService.map_answer_to_blocks` при финализации ответа агента — кнопки из `chat_agent_messages_bus.buttons` транслируются перед записью в `chat_messages.content`.
- На локальном LLM-пути, когда ассистент эмитит `buttons`-блок.

`translate_buttons` резолвит `action_id` через реестр ChatTool (`get_tool`) и зовёт зарегистрированный `button_translator` тула.

Кнопка без зарегистрированного `ChatTool` или без `button_translator` пропускается как есть (с WARN в логи) — пользователь увидит её, но клик не сработает.

**Когда добавлять**: для любого нового `ChatTool` категории `action`, который LLM/агент будет предлагать в виде кнопки (`buttons`-блок). Если tool вызывается **только** через `tool_call` (LLM сама исполняет, не показывая кнопку), translator не нужен.

**Регистрация** — поле `button_translator` в датакласс `ChatTool` (`app/core/chat/tools.py`):

```python
# app/domains/acts/integrations/action_handlers.py
from app.core.chat.names import ACTION_NOTIFY, ACTION_OPEN_URL


async def open_act_page_button_translator(params: dict) -> dict:
    """Транслятор серверной кнопки acts.open_act_page → клиентский action.

    Резолвит КМ/СЗ в URL акта; на успехе — open_url, иначе — notify уровня error.
    Сигнатура фиксирована: принимает params самой кнопки, возвращает
    {"action": <client-action>, "params": {...}} или None.
    """
    km = (params or {}).get("km_number")
    sz = (params or {}).get("sz_number")
    url = await resolve_act_url(km, sz)
    if url:
        return {"action": ACTION_OPEN_URL, "params": {"url": url}}
    identifier = km or sz or "?"
    return {
        "action": ACTION_NOTIFY,
        "params": {"message": f"Акт {identifier} не найден", "level": "error"},
    }


# app/domains/acts/integrations/chat_tools.py
ChatTool(
    name=TOOL_OPEN_ACT_PAGE,
    domain="acts",
    description="Открыть страницу конкретного акта…",
    parameters=[...],
    handler=open_act_page_handler,
    category="action",
    button_translator=open_act_page_button_translator,  # ← вот этот хук
)
```

После трансляции фронт получает уже клиентский формат:

```jsonc
// До translator (что прислал агент):
{"action_id": "acts.open_act_page", "label": "Открыть КМ-23-001",
 "params": {"km_number": "КМ-23-001"}}

// После translator (что получает chat-messages.js):
{"action_id": "open_url", "label": "Открыть КМ-23-001",
 "params": {"url": "/constructor?act_id=42"}}
```

Аналогичные пары handler/translator есть в `app/domains/ck_fin_res/integrations/action_handlers.py`, `app/domains/ck_client_exp/integrations/action_handlers.py`, `app/domains/admin/integrations/action_handlers.py` — они переиспользуют единый шаблон.

#### 7.8b Транспорт: POST + polling

> Транспорт (SSE нет, POST→`{message_id}`, поллинг GET) описан канонически в §7.1. Здесь — контракт эндпоинтов и статусы.

Канонические структуры блоков — в `app/core/chat/blocks.py` (Pydantic-модели `MessageBlock`).

**Контракт:**

| Endpoint | Что возвращает |
|---|---|
| `POST /conversations/{cid}/messages` | `{message_id: str}` — сразу после сохранения user-сообщения и запуска обработки |
| `GET /conversations/{cid}/messages/{message_id}` | `{id, status, content}` — фронт поллит до `status ∈ {complete, failed}` |
| `GET /conversations/{cid}/messages` | вся история беседы (блоки сообщений целиком) |

`content` — массив блоков сообщения (`text`/`code`/`reasoning`/`plan`/`file`/`image`/`buttons`/`client_action`/`error`). Фронт рендерит сообщение **целиком** с декоративным «эффектом печати» — токен-стриминга нет.

**Статусы ассистент-сообщения** (`chat_messages.status`):
- `complete` — синхронный LLM-ответ (`off`/`adaptive` без форварда) сохраняется финальным сразу.
- `streaming` — черновик форварда, агент ещё не ответил; фронт показывает typing-облако и продолжает polling.
- `failed` — форвард завершился ошибкой/таймаутом; в `content` дописан error-блок.

**Кнопки** (`buttons`-блок) — `action_id` уже транслирован сервером (`translate_buttons`, см. §7.8a) в клиентский формат (`open_url`/`notify`/…).

**Client action** — `client_action`-блок исполняется фронтом **идемпотентно по `block_id`** через `sessionStorage['chat:executedActions']` (см. §7.9). Повторный рендер истории и перезагрузка вкладки не приводят к повторному исполнению.

### 7.9 Action-handlers и ClientActionBlock

Action-tools — это ChatTool'ы для **действий в интерфейсе** (открыть страницу, показать уведомление, навигировать, активировать SDK). Их handler возвращает JSON-сериализованный `ClientActionBlock`, оркестратор парсит ответ и добавляет блок в сообщение; фронт при рендере исполняет команду через `ClientActionsRegistry`.

**Поток:**

```
LLM выдал tool_call → tool_executor.execute_tool_call(name, args)
    ↓ handler возвращает str (JSON-encoded ClientActionBlock)
Orchestrator._parse_client_action_result(raw, block_id_gen=BlockIdGenerator(message_id))
    ↓ если type == "client_action" → block_id переписан на f"{message_id}:client_action:{i}" (через BlockIdGenerator) → block сохранён в chat_messages.content
Фронт получает сообщение через polling GET /messages/{message_id}
    ↓ chat-messages.js рендерит блок client_action
ChatRenderer.renderBlock(block, {execute: true})
    ↓ _renderClientAction → ClientActionsRegistry.executeBlock(block) → execute(action, params)
```

**Реестр клиентских команд** (`static/js/shared/chat/chat-client-actions.js`):

| action | params | Что делает |
|---|---|---|
| `open_url` | `{url: string}` | Проверка схемы по whitelist (`http://`/`https://`/`mailto:`/`/`, тот же список, что `ALLOWED_OPEN_URL_SCHEMES` на бэке) → `window.location.href = resolveProxyUrl(url)` |
| `notify` | `{message: string, level?: 'info'\|'success'\|'warning'\|'error'}` | Toast через `window.Notifications.show` |
| `trigger_sdk` | `{method: string, args?: any[]}` | `window[method](...args)` — только для методов из `ALLOWED_SDK_METHODS` (по умолчанию Set пуст, `trigger_sdk` в проекте не используется) |

Регистрация дополнительных команд в JS: `ClientActionsRegistry.register('my_action', ({...params}) => {...})`.

**Критическое правило**: `ClientActionBlock` идемпотентен по `block_id`. Поле `block_id` в `app/core/chat/blocks.py` — **обязательное** (без `default_factory`); оркестратор переписывает его на детерминированный `f"{message_id}:client_action:{i}"` в `_parse_client_action_result` (через `BlockIdGenerator`). Фронт хранит исполненные id в `sessionStorage['chat:executedActions']` (`EXECUTED_STORAGE_KEY` / `EXECUTED_MAX_SIZE` в `static/js/shared/chat/chat-client-actions.js`, max 500 элементов, FIFO eviction). Повторный рендер сообщения с тем же `block_id`, рендер истории и **перезагрузка вкладки** — не приводят к повторному `window.location`/`Notifications.show` (id стабильный между сессиями). Единая точка исполнения — `ClientActionsRegistry.executeBlock(block)`. **Не вызывай `.execute(action, params)` напрямую** — обойдёшь `block_id`-чек и получишь редирект-цикл.

**Пример action-handler'а** (`app/domains/acts/integrations/action_handlers.py`):

```python
async def open_act_page_handler(
    *, km_number: str | None = None, sz_number: str | None = None,
) -> str:
    """Поиск акта по КМ/СЗ → ClientActionBlock(open_url) или текст с просьбой уточнить."""
    if not km_number and not sz_number:
        return "Не указан ни КМ-номер, ни номер служебной записки."

    # ВАЖНО: импорты внутри функции — для тестов через
    # patch.multiple("app.db.connection", get_db=..., get_adapter=...)
    from app.db.connection import get_adapter, get_db

    # ... build SQL query ...
    async with get_db() as conn:
        rows = await conn.fetch(sql, *params)

    if len(rows) == 1:
        return json.dumps({
            "type": "client_action",
            "action": "open_url",
            "params": {"url": f"/constructor?act_id={rows[0]['id']}"},
            "label": f"Открываю акт {rows[0]['km_number']}…",
        }, ensure_ascii=False)
    # ... 0 / multiple branches return plain text ...
```

Регистрация в `chat_tools.py` домена — обычная (с `category="action"`), всё как описано в [7.6](#76-пример-добавление-нового-chat-tool).

### 7.10 Text actions: «Корректор» и «Формализация нарушения»

Две фичи домена чата, живущие **вне** agent loop'а: беседы, истории и tool'ов у них нет — это прямые one-shot вызовы LLM над выделенным текстом. Код — `app/domains/chat/services/text_actions/`, API — `app/domains/chat/api/text_actions.py` (префикс `/api/v1/chat/text-actions`, доступ через `require_domain_access("chat")`). Инфраструктуру берут общую: выбор маршрута через `llm_route.resolve_target` (тот же план доступных провайдеров, что и у чата — см. [7.4a](#74a-resilience-retry--circuit-breaker--fallback)) + `retry_on_transient` с той же `CHAT__RETRY__*`-политикой.

| Эндпоинт | Сервис | Что делает |
|---|---|---|
| `POST /text-actions/correct` | `TextCorrectorService.correct(text, mode)` | `mode="fix"` — орфография/пунктуация (`AUDITOR_SYSTEM_PROMPT`, температура `CORRECTOR_TEMPERATURE` = 0.1); `mode="readability"` — читаемость/структура (`READABILITY_SYSTEM_PROMPT`, `READABILITY_TEMPERATURE` = 0.3). Один вызов, ответ — исправленный текст |
| `POST /text-actions/formalize-violation` | `ViolationFormalizerService.formalize(text)` | 4 JSON-экстрактора параллельно (`asyncio.gather`: суть/нормдок, причины+ответственные, последствия, меры) + 2-й этап «рекомендации, чего не хватает». Сбой отдельного экстрактора → пустое поле, а не 500 |

**Маршрут выбирается, а не берётся из настроек.** `resolve_target` строит тот же план доступных маршрутов, что и чат, и отдаёт клиента с моделью первого живого. Без этого text-actions всегда били бы в `CHAT__PROFILE`: при `redis-bridge,openai` и воркере, поднятом только под gigachat, чат отвечал через fallback, а корректор на том же стенде отдавал 503. Если живых маршрутов нет, запрос не уходит вовсе — сразу `TextActionUnavailableError` (503).

На fallback-маршруте модель берётся из `CHAT__FALLBACK_MODEL`, а `CORRECTOR_MODEL` / `FORMALIZER_MODEL` не переносятся: они названы под основного провайдера, и у другого их обычно нет.

Настройки — группа `CHAT__TEXT_ACTIONS__*` (`ChatDomainSettings.text_actions`): `CORRECTOR_MODEL` / `FORMALIZER_MODEL` (`None` → модель выбранного маршрута), три температуры, `PER_CALL_TIMEOUT_SEC` (60), `MAX_INPUT_CHARS` (20000). Пустой ввод, превышение `MAX_INPUT_CHARS` и неизвестный `mode` → `TextActionValidationError` (422). Поле `recommendations` формализатора — дисплей-онли подсказка аналитику, в карточку нарушения и экспорт не идёт.

---

## 11. Chat domain deep-dive

Симметрично deep-dive по домену acts (см. [`data-model-acts.md`](../architecture/data-model-acts.md)) — этот раздел собирает в одном месте внутреннюю кухню домена `chat`: какие сервисы за что отвечают, как устроен оркестратор, какие подводные камни ловит код.

### 11.1 Слои сервисов и их роли

Файл — `app/domains/chat/services/<name>.py`. Сервисы тонкие, связь — через явное конструирование в `app/domains/chat/deps.py` (нет глобального DI-контейнера).

| Сервис | Роль | Зависимости |
|---|---|---|
| `Orchestrator` | Фасад agent loop'а: DI, history, system prompt, делегирование в `agent_loop.run_agent_loop`. Wrapper-методы `_execute_tool_call`, `_llm_call_with_fallback` оставлены для совместимости с тестами | `MessageService`, `ConversationService`, settings, LLM client |
| `agent_loop` | Pure-функция `run_agent_loop` — тело цикла чата (синхронное в POST). `_handle_forward_terminal` обрабатывает терминальный forward в шину `chat_agent_messages_bus` | `llm_call`, `tool_executor`, `AgentChannelService` |
| `llm_call` | `call_llm_with_fallback`: оборачивает primary-вызов в retry + circuit breaker, при `open` переключает на fallback-провайдера | `retry`, `circuit_breaker`, settings |
| `tool_executor` | `execute_tool_call`: валидация args, конвертация типов через `convert_param`, `asyncio.wait_for(TOOL_EXECUTION_TIMEOUT)`, запись `tool_metric` через `MetricsBatcher` | `orchestrator_helpers`, реестр ChatTool |
| `orchestrator_helpers` | Чистые функции и константы: `safe_args`, `convert_param`, `unpack_pending_tool_call`, `ToolValidationTracker` (счётчик повторяющихся `ChatToolValidationError`'ов, выход из tool-loop'а при `consecutive >= TOOL_VALIDATION_LOOP_THRESHOLD`), `build_tool_loop_exit_answer`, `BASE_SYSTEM_PROMPT`, `TOOL_VALIDATION_NEUTRAL_MESSAGE` | — |
| `LLM client` (`llm_client.build_llm_client` / `build_fallback_client`) | Фабрика клиента по маршруту (`parse_route`) с кэшем по профилю; `close_cached_clients()` в `on_shutdown` | `ChatDomainSettings` |
| `gigachat_adapter` | Duck-typed wrapper над `AsyncOpenAI` для GigaChat-proxy: tools↔functions, function_call↔tool_calls | — |
| `redis_bridge_adapter` | Duck-typed клиент `RedisBridgeClient` поверх Redis Streams: заявка в `<prefix>requests`, поллинг `<prefix>resp:<id>`, `BridgeDeadlineError` по дедлайну; `models.list()` = чтение heartbeat воркера (см. [7.1a](#71a-маршруты-llm-провайдера)) | `app.core.redis`, `gigachat_adapter` (трансляция) |
| `retry` | Экспоненциальный backoff с джиттером; два класса ошибок (transient / connect) с раздельными лимитами попыток | settings |
| `circuit_breaker` | FSM closed/open/half-open для primary↔fallback (см. §7.4a) | settings |
| `AgentChannelService` | Канал к внешнему агенту через `chat_agent_messages_bus`: `submit`, `poll_once`, `mark_timeout`, `get_queue_details`, `map_answer_to_blocks` | `AgentMessageRepository`, `MessageRepository` |
| `AgentChannelPoller` | Один фоновый asyncio-task: поллит шину по подписанным `question_uid`, adaptive-backoff без удержания conn, `reconcile` | `AgentChannelService` |
| `forward_tool_factory` | `build_forward_tool_descriptor()` — статический ChatTool `forward_to_knowledge_agent` для режима `adaptive` | реестр ChatTool |
| `button_translator` | `translate_buttons`: `action_id` (имя ChatTool) → клиентский action для UI-кнопок | реестр ChatTool |
| `tool_call_accumulator` | Сборка tool_calls из delta-чанков. **В рантайме не используется** — наследие streaming-ветки (см. [11.3](#113-toolcallaccumulator-наследие-streaming-ветки)) | — |
| `MessageService` | Сохранение/загрузка сообщений с `asyncio.Lock` per user | `MessageRepository` |
| `ConversationService` | CRUD бесед с `asyncio.Lock` per user | `ConversationRepository` |
| `FileService` | Загрузка/отдача файлов с проверкой владельца через `conversation.user_id` | `ChatFileRepository` |
| `FileExtraction` | Извлечение текста из файлов (pdf/docx/xlsx → str) для контекста LLM | — |
| `UserRateLimiter` | Per-user скользящее окно 60 сек на POST `/messages` | settings |
| `ChatAuditService` | Audit-лог жизненного цикла чата (создание/удаление бесед, сообщения, файлы, фидбэк); пишет через `MetricsBatcher` | `MetricsBatcher` |
| `ChatFeedbackService` | Лайк/дизлайк на ответ ассистента, валидация, idempotent upsert, audit-событие | `ChatMessageFeedbackRepository`, `ChatAuditService` |
| `ChatAnalyticsService` | Аналитика для admin: статистика фидбэка, инспектор диалога с route_type/outcome | `ChatMessageFeedbackRepository`, `MessageRepository` |
| `LLMHealthProbe` | Фоновый probe primary-LLM при открытом circuit breaker, закрывает breaker при восстановлении | `ChatDomainSettings`, circuit_breaker |
| `route_classifier` | Чистые функции `classify_route`/`outcome` по сохранённому сообщению | — |

### 11.2 Orchestrator: итерации agent loop

`Orchestrator.run(...)` делегирует в `agent_loop.run_agent_loop(...)` и исполняется синхронно в POST (транспорт — polling, см. §7.1). Цикл:

```
1. _get_history_messages(conversation_id) — load history, max_history_length
2. _build_system_messages(domains) — system prompt + KB-toggles + tool descriptions
3. llm_call.call_llm_with_fallback(...) с tools[] (или functions[] для gigachat) — retry/circuit/fallback внутри
4. Если ответ — tool_calls:
   a. tool_executor.execute_tool_call(...) для каждого (asyncio.wait_for(TOOL_EXECUTION_TIMEOUT) + tool_metric)
   b. Собрать assistant_msg вручную: dict с content=raw.content or "", tool_calls=[{..., arguments=safe_args(raw)}]
   c. messages.append(assistant_msg), затем tool-result-messages
   d. goto 3 (но не больше CHAT__MAX_TOOL_ROUNDS, default 5)
5. Save assistant message в БД (transaction), message_id — тот же, что пришёл из API
```

**Защиты на каждой итерации:**

- `content=None` + `tool_calls` — недопустимо для Qwen/SGLang (400) и GigaChat (422), хотя OpenAI-spec разрешает. Санитизация в двух местах: `content = raw_msg.content or ""` при сборке эхо-сообщения в `run_agent_loop` (`agent_loop.py:359`) и подстраховка в `_translate_messages` GigaChat-адаптера — на случай Pydantic-объекта, пришедшего из истории. **Не делай** `messages.append(response.choices[0].message)` — Pydantic-объект сериализуется с `content: null`.
- `arguments=""` для no-args tool_call'ов — симметричная проблема. Хелпер `safe_args(raw)` (`orchestrator_helpers.py`) нормализует пустые/нестроковые значения в `"{}"`. Применяется и в эхо tool_calls, и перед `json.loads(...)` для handler'а.
- `max_tool_rounds` — защита от бесконечной рекурсии LLM ↔ tool. При исчерпании эмитится `error` с пояснением.
- Tool timeout — `CHAT__TOOL_EXECUTION_TIMEOUT` (default 30 сек) через `asyncio.wait_for` внутри `tool_executor.execute_tool_call`. Превышение → в `messages` уходит tool-результат с текстом «Ошибка: таймаут выполнения инструмента …», а в `chat_tool_metrics` — запись со `status='error'` и `error_message='timeout <N>s'`; цикл продолжается.

**Terminal-tool контракт (`agent_loop.py`).** Терминальный tool `forward_to_knowledge_agent` (в режиме `adaptive`) обрабатывается через `_handle_forward_terminal`: вместо повторного вызова LLM создаётся вопрос в шине `chat_agent_messages_bus` + черновик `chat_messages` (`status='streaming'`), и `run_agent_loop` возвращается сразу (`return`). Обычные tool'ы append'ят `{"role": "tool", ...}` в `messages` и цикл продолжается до `max_tool_rounds` или пока LLM не перестанет звать tool'ы.

**Сохранение ErrorBlock при сбое (`agent_loop.py`).** Если LLM-вызов упал (`asyncio.TimeoutError` или произвольный `Exception`), `run_agent_loop` сохраняет в БД pseudo-ассистент-message с `ErrorBlock`. Это нужно, чтобы при reload юзер увидел красный блок «Временная ошибка AI-сервиса», а не молчаливо висящий user-message без ответа.

### 11.3 ToolCallAccumulator: наследие streaming-ветки

**Стриминга в приложении нет.** `run_agent_loop` делает non-streaming LLM-вызов, отдельного `stream_loop.py` в `services/` не существует, ни один маршрут (включая `redis-bridge` v1) чанков не отдаёт. Клиенту ответ уходит через polling `GET /messages/{message_id}` целиком (см. [7.1](#71-архитектура-chat-domain)).

Модуль `tool_call_accumulator.py` от streaming-ветки остался и **в рантайме не вызывается** — его импортируют только собственные тесты (`tests/domains/chat/test_tool_call_accumulator.py`) и docstring `unpack_pending_tool_call` в `orchestrator_helpers.py` (упоминает плоский `ToolCall` как один из принимаемых форматов). Фактический API — не `add_fragment`, а:

```python
class ToolCallAccumulator:
    def consume(self, chunk: Any) -> Iterator[StreamEvent]: ...   # yield ("content", str)
    def finalize(self) -> list[ToolCall]: ...                     # ToolCall(id, name, arguments)

    @property
    def reasoning_details(self) -> list[dict]: ...
```

**Quirks провайдеров, зашитые в него** (пригодятся, если стриминг когда-нибудь вернут):

- `index=None` от SGLang — fallback на последний виденный индекс, для самого первого чанка назначается 0.
- `arguments` приходят строкой и накапливаются конкатенацией; на `finalize` не парсятся (это работа вызывающего через `safe_args` из `orchestrator_helpers.py`).
- `id` может появиться в любом чанке, не обязательно в первом — слот хранит его отдельно от имени и аргументов.
- `reasoning_details` от MiniMax M2 — отдельное поле delta, копится в свой список; не путать с `tool_calls`.

### 11.4 GigaChat-адаптер: native functions[] под капотом

`GigaChatAdapterClient` (`gigachat_adapter.py`) — duck-typed wrapper над `AsyncOpenAI`. Снаружи имеет OpenAI-семантику (`chat.completions.create(...)` с `tools=[...]`); внутри транслирует в native GigaChat-proxy формат.

**Транзит request (`_translate_messages`, `_translate_tools`):**

- `tools=[{type:"function", function:{name, parameters}}]` → `extra_body.functions=[{name, parameters, ...}]`.
- Assistant с `tool_calls=[{id, function:{name, arguments}}]` → `function_call={name, arguments: <dict>}`. Хелпер `_args_to_dict(raw)` декодирует JSON-string → dict; битый JSON / пустая строка / None → `{}`. **GigaChat-proxy валидирует request-схему строго**: `arguments` должен быть dict, а не JSON-string, иначе 422 RequestInputValidationException.
- Tool-message → `function`-message (роль другая в GigaChat).
- `content=None` + `function_call` — санитизация на `content=""`, как и в orchestrator.

**Транзит response (`_translate_response`):**

- `function_call={name, arguments: <dict>}` → синтетический `tool_calls=[{id: "gc_<hex>", function:{name, arguments: <JSON-string>}}]`. `json.dumps(args, ensure_ascii=False, default=str)`; `default=str` спасает от datetime/Decimal. Заодно зануляется `function_call` и `finish_reason` переводится в `"tool_calls"`.
- `tool_call_id → name` mapping адаптер **не хранит между вызовами**: `_translate_messages` пересобирает его на каждый запрос одним проходом по переданной истории (все assistant-сообщения с `tool_calls[]`). Поэтому история обязана содержать assistant-сообщение с `tool_calls` перед соответствующим tool-сообщением — иначе `unknown_function` + warning.

**Ограничения:**

- 1 function_call за раунд (вместо OpenAI-произвольного списка). Оркестратор и так работает по одному tool за итерацию, но если LLM каким-то образом вернёт несколько — берётся первый, warning в логи.
- Streaming не поддерживается (`stream=True` → 422 EventException на proxy). Это не проблема: `run_agent_loop` и так делает non-streaming LLM-вызов, а клиенту ответ отдаётся через polling.

Тесты — `tests/domains/chat/test_gigachat_adapter.py`, особо обращай внимание на roundtrip-тест: ответ через `_translate_response` затем прогоняется через `_translate_messages` обратно, должен дать dict args.

### 11.5 Канал к внешнему ИИ-агенту: bus-таблица chat_agent_messages_bus

Канал к внешнему ИИ-агенту («База знаний ОАРБ») построен на **одной bus-таблице** `chat_agent_messages_bus` (заменила прежние три — `agent_requests`/`agent_response_events`/`agent_responses`). Транспорт — polling-only (см. §7.1): приложение пишет вопрос в шину и поллит её до терминального статуса.

**Именование (важно).** Имя bus-таблицы задаётся `CHAT__AGENT_CHANNEL__TABLE_NAME` (дефолт `chat_agent_messages_bus`; на ПРОМе — `agent_conversation_messages`), схема — `CHAT__AGENT_CHANNEL__SCHEMA_NAME` с двухступенчатым fallback'ом (`resolve_bus_schema`: схема шины → `CHAT__SCHEMA_NAME` → основная схема адаптера), что позволяет вынести шину в общую с агентом integration-схему. В отличие от прочих таблиц приложения, к шине **не** клеится `DATABASE__TABLE_PREFIX`: имя задаётся настройкой **целиком**. В миграции шина именуется плейсхолдером `{BUS_TABLE}` (без `{PREFIX}`), а `AgentMessageRepository` квалифицирует имя через `qualify_table_name` (схема без префикса), не `get_table_name`. Причина — шина общая с внешним агентом, её именование вне префикс-схемы AW. Нужен префикс — вписать его прямо в `CHAT__AGENT_CHANNEL__TABLE_NAME` (например, `t_db_oarb_audit_act_chat_agent_messages_bus`, чтобы сохранить старое имя при апгрейде с версии, где префикс клеился).

**Структура `chat_agent_messages_bus`.** Таблицей владеет и её структуру задаёт сторона внешнего агента; блок в `app/domains/chat/migrations/{postgresql,greenplum}/schema.sql` помечен директивой `-- @external-table: {BUS_SCHEMA_Q}{BUS_TABLE}`: если таблица уже создана владельцем, адаптер пропускает её «спутников» (`CREATE INDEX`, `COMMENT ON`) и не пытается доводить чужой объект до своего вида. Сам блок — dev-имитация фактической структуры (типы — как у владельца, наша конвенция VARCHAR(36) сознательно не применяется). DEFAULT'ов у таблицы нет, отдельной колонки `conversation_id` — тоже; на ПРОМ-таблице есть **CHECK по `status`** с неизвестным нам полным списком значений (записи статуса от AW — best-effort, см. `_set_status_safe`):

| Колонка | Тип | Назначение |
|---|---|---|
| `id` | UUID | uid одного сообщения шины (его же хранит `chat_messages.agent_ref`). PK в имитации нет **ни на PG, ни на GP** — только `CREATE INDEX idx_{BUS_TABLE}_id`; на GP дополнительно `DISTRIBUTED BY (chat_id)` |
| `chat_id` | TEXT | uid треда (= `chat_messages.conversation_id`) |
| `user_id` | TEXT | автор |
| `role` | TEXT | `user` / `assistant` / `system` (CHECK владельца). Роль `system` приложением не обрабатывается |
| `content` | TEXT | текст сообщения (NOT NULL) |
| `media` | JSONB | вложения (image/file) |
| `metadata` | JSONB | служебные поля; `metadata.reasoning` → reasoning-блок (агент стримит туда дельты; legacy-ключ `thinking` тоже понимается) |
| `reply_to` | UUID | ссылка на id вопроса; агент проставляет его **на строке-ответе** — наличие ответа с `reply_to=<id вопроса>` и есть сигнал «ответ готов» |
| `buttons` | JSONB | кнопки (`action_id` → client-action) |
| `status` | TEXT | `pending` / `processing` / `completed` / `failed` (CHECK владельца, подтверждённая спека; `timeout`/`error`/`complete` запрещены) |
| `created_at` / `updated_at` | TIMESTAMPTZ | NOT NULL; DEFAULT'ов нет — AW передаёт явно в INSERT/UPDATE |

Связь чат → шина: ассистент-черновик в `chat_messages` хранит колонку `agent_ref VARCHAR(36)` — id вопроса в `chat_agent_messages_bus`. По нему `AgentChannelPoller`/`poll_once` находят ответ (обратный lookup `get_answer_for_question`: `reply_to = <id вопроса> AND role='assistant'`) и финализируют черновик. `AgentMessageRepository._parse_row` нормализует uuid-значения `id`/`reply_to` в `str` — остальной код работает со строками.

**`map_answer_to_blocks`** (`agent_channel.py`) превращает строку-ответ шины в блоки сообщения в фиксированном порядке:

1. `reasoning` — из `metadata.reasoning`, legacy `metadata.thinking` (block_id `f"{id}:reasoning:0"`);
2. `text` — из `content`;
3. `buttons` — из `buttons` (block_id `f"{id}:btn:0"`, у каждой кнопки проставляются дефолты `action_id`/`label`/`params`);
4. `media` — image/file из `media` (одиночный объект оборачивается в список; `mime_type` с `image/` → `image`-блок, остальное → `file`).

Ветки «ошибка» внутри `map_answer_to_blocks` нет: error-блоки дописывает `poll_once` (`code="agent_error"` — агент закрыл вопрос/ответ статусом `failed`) и `mark_timeout` (`agent_claim_timeout` / `agent_timeout`).

Текст блока `reasoning`/`text` обрезается до `CHAT__AGENT_CHANNEL__MAX_BLOCK_TEXT_SIZE` UTF-8 байт (default 262144 = 256 KB, срез по границе code-point) с маркером `…[обрезано]` и WARNING-логом — защита от malicious / broken агента.

**`button_translator.translate_buttons`** проходит по кнопкам: если `action_id` совпадает с зарегистрированным `ChatTool`, кнопка превращается в client-action `open_url`. Иначе оставляется как есть.

### 11.6 AgentChannelPoller и AgentChannelService: фоновое сохранение ассистент-сообщений

`AgentChannelService` (`agent_channel.py`) и `AgentChannelPoller` (`agent_channel_poller.py`) — две стороны канала. Транспорта в реальном времени нет: фронт после POST `/messages` поллит `GET /messages/{message_id}` до терминального статуса и рендерит ответ целиком с декоративным «эффектом печати» (токен-стриминга нет).

**Разделение ответственности:**

| Кто | Что делает |
|---|---|
| `AgentChannelService.submit` | **В одной транзакции** INSERT вопроса (`role='user'`, `status='pending'`) в `chat_agent_messages_bus` + создание черновика `chat_messages` (`status='streaming'`, `agent_ref=<uid вопроса>`) — атомарность исключает осиротевшую строку, занимающую слот лимита |
| `AgentChannelPoller` (один asyncio-task на процесс) | Поллит шину по подписанным `question_uid`, adaptive-backoff, **соединение не удерживает** — тик работает через исполнитель (коннект на каждую SQL-операцию). На каждый тик зовёт `poll_once` |
| `AgentChannelService.poll_once` | `poll_once(*, assistant_message_id, question_uid, last_reasoning_len=0, want_queue_position=False) -> dict` — возвращает `{outcome, question_status, answer_exists, reasoning_len, queue_ahead, answer_updated_at}`. Две ветки: если ответ агента финальный — `map_answer_to_blocks` + финализация черновика + best-effort закрытие вопроса в шине; если reasoning растёт, но ответа нет — `upsert_block` частичного reasoning (replace-семантика, block_id `{answer_id}:reasoning:0`). `finalize` мержит replace-семантикой: финальный reasoning-блок замещает накопленный |
| `AgentChannelService.get_queue_details` | `get_queue_details(question_uid) -> {bus_status, queue_ahead}` — позиция в очереди для GET-ответа на streaming-черновик (best-effort, без исключений) |
| `AgentChannelService.mark_timeout` | `mark_timeout(question_uid, reason='claim'|'answer')` — дописывает error-блок (`build_timeout_error_block(reason)`; код `agent_claim_timeout` / `agent_timeout`) и переводит черновик в `failed`; вопрос в шине best-effort закрывается `failed` |
| `AgentChannelService._emit_answer_notification` | Персистентное уведомление автору вопроса (`question.user_id`) при готовности ответа / ошибке — через ядерный `push_notification` (`source="chat"`, `link=None`: у чата нет собственного URL). Best-effort: отсутствие домена notifications или сбой эмиссии финализацию не ломают. Эмитится ровно один раз — на тике, где `mark_*` реально перевёл сообщение в терминал |
| `AgentChannelPoller.reconcile` (lifespan) | Восстанавливает подписки из streaming-черновиков после рестарта uvicorn |

**Двухфазные idle-таймауты поллера.** Подписка хранит `phase` (монотонно `pending` → `processing`) и `last_activity`:

| Фаза | Признаки жизни (обновляют `last_activity`) | Idle-лимит |
|---|---|---|
| `pending` | переход в `processing`, уменьшение `queue_ahead`, рост `reasoning_len`, изменение `answer_updated_at` | `CLAIM_TIMEOUT_SEC` (1800 сек) |
| `processing` | рост `reasoning_len`, изменение `answer_updated_at` | `ANSWER_TIMEOUT_SEC` (600 сек) |

Первое наблюдение `answer_updated_at` ставится как baseline (без продления активности). Откат строки шины назад (агент сбросил `updated_at`) **не** продлевает таймаут — смена только вперёд.

**Adaptive backoff poллера.** Интервал тика растёт от `POLL_MIN_INTERVAL_SEC` (2.0 c) до `POLL_MAX_INTERVAL_SEC` (10.0 c) с шагом `POLL_BACKOFF_MULTIPLIER` (1.5) при пустых тиках и сбрасывается в минимум при активности. Соединение из пула тик не удерживает: работа идёт через исполнитель (`DbExecutor`), берущий коннект на каждую SQL-операцию отдельно — принципиально, поскольку внутри тика есть await'ы в чужой код (эмиссия уведомлений, трансляция кнопок агента), которые иначе оказались бы повторным захватом пула в том же task'е.

**Подписки.** `subscribe(assistant_message_id, question_uid)` идемпотентен (повторная подписка — no-op с info-логом); `unsubscribe(question_uid)` снимает запись из реестра. `_run()` не падает от одиночных ошибок тика; ошибка обработки одной подписки внутри `_tick` ретраится, но после `_MAX_CONSECUTIVE_ENTRY_ERRORS` (30) ошибок подряд подписка снимается аварийно с best-effort финализацией draft'а через `mark_timeout` (защита от «отравленной» подписки, которая иначе держала бы draft в `streaming` до рестарта; счётчик сбрасывается успешным тиком). `get_status()` отдаёт снимок для diagnostics-эндпоинта.

**GET /messages/{id} для streaming-черновика.** Ответ содержит опциональное поле `status_details: {bus_status: str, queue_ahead: int|null}` — позиция вопроса в очереди шины (best-effort, через `AgentChannelService.get_queue_details`; если сервис недоступен — поле отсутствует). Фронт использует его для строки статуса и для фазового idle-таймаута поллинга.

Управляется hook'ом `chat.agent_channel_poller` (start/stop в `app/domains/chat/__init__.py`).

### 11.7 Форвард и статусы chat_messages

Form-параметр `agent_mode` определяет, как POST `/messages` обрабатывает запрос:

| `agent_mode` | Поведение |
|---|---|
| `off` | Локальная LLM/GigaChat исполняется **синхронно** в POST через `orchestrator.run(...)`. Форварда нет |
| `adaptive` | То же синхронное исполнение, но в наборе tool'ов есть forward-tool — оркестратор сам решает, форвардить ли вопрос в агента |
| `always` | Прямой проброс вопроса в агента (без локального LLM-раунда) |

Форвард (`always`, либо `adaptive` + решение оркестратора) создаёт черновик `chat_messages` (`status='streaming'`) и вопрос в шине `chat_agent_messages_bus`. Дальше его подхватывает `AgentChannelPoller` → `poll_once` (инкрементальный reasoning + финализация, см. §11.6).

**Статусы `chat_messages.status`** (`streaming` | `complete` | `failed`):

- `complete` — дефолт: обычные синхронные LLM-ответы сохраняются финальными сразу одним INSERT'ом.
- `streaming` — черновик форварда, пока агент не ответил. Источник истины — `chat_messages.content` в БД; `GET /messages` отдаёт черновик как обычное сообщение со `status='streaming'`, фронт показывает typing-облако (класс-маркер `chat-message-bot--streaming`).
- `failed` — форвард завершился ошибкой/таймаутом; в `content` дописан error-блок.

**Лимит одновременных запросов.** `AgentMessageRepository.count_active_for_user(user_id, *, pending_created_after, processing_updated_after)` считает активные запросы пользователя в шине (двойная отсечка: `pending` — по `created_at` за окно `CLAIM_TIMEOUT_SEC`; `processing` — по `updated_at` за окно `ANSWER_TIMEOUT_SEC`); при `>= CHAT__MAX_PARALLEL_STREAMS_PER_USER` (default 3) `submit` бросает `ChatLimitError` **до** любых записей → HTTP 422 с дружелюбным сообщением.

**Тумблер «База знаний ОАРБ»** во фронте — 3 позиции: Выключен / Адаптивный / Всегда (маппятся на `off`/`adaptive`/`always`). Позиция хранится в `localStorage['assistant_oarb_mode']`. Две другие базы знаний («источников», «инструментов») в UI выключены.

**Schema/миграции.** Колонка `status` в `chat_messages` обеих СУБД — `VARCHAR(20) NOT NULL DEFAULT 'complete'` + `CONSTRAINT check_chat_messages_status_values CHECK (status IN ('streaming','complete','failed'))`. На PG — partial-индекс `idx_{PREFIX}chat_messages_streaming` (`WHERE status='streaming'`) для быстрого recovery; на GP 6.x (PG 9.4) partial-индексы не поддерживаются — обычный `idx_{PREFIX}chat_messages_status` на `(conversation_id, status)`. Колонка `agent_ref VARCHAR(36)` — там же. Всё создаётся стартовым `create_tables_if_not_exist`; ручных ALTER-инструкций писать не нужно — при изменении схемы БД пересоздаётся ([`drop-all-tables.md`](../migrations/drop-all-tables.md)), а идемпотентные добавления `status`/`agent_ref` уже вшиты в сами файлы `app/domains/chat/migrations/{postgresql,greenplum}/schema.sql`.

---
