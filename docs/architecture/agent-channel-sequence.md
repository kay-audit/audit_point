# Forward к внешнему ИИ-агенту — sequence-диаграмма

Документ описывает полный путь от пользовательского сообщения до ответа
внешнего ИИ-агента через единую bus-таблицу `chat_agent_messages_bus`. Транспорт —
**poll-only, без SSE**: POST на отправку сообщения отдаёт `message_id`, а фронт
затем поллит готовность ответа GET-запросом до терминального статуса и рендерит
ответ целиком с декоративным «эффектом печати» (token-стриминга нет).

См. также:
- [`docs/guides/developer-guide.md §7.8`](../guides/developer-guide.md#78-внешний-ии-агент-через-таблицы-бд) — внешний ИИ-агент через таблицы БД (обзор)
- [`docs/integrations/external-agent-imitation.sql`](../integrations/external-agent-imitation.sql) — SQL-стенд имитации внешнего агента
- [`docs/architecture/chat-frontend-architecture.md`](chat-frontend-architecture.md) — frontend-клиент чата

---

## 0. Модель данных и режимы

**Bus-таблица `chat_agent_messages_bus`** — полная структура описана в
[`cross-domain-contracts.md §10`](cross-domain-contracts.md#10-контракт-шины-chat_agent_messages_bus-приложение--внешний-ии-агент).
Здесь — только diff, специфичный для sequence-контекста:

- `reply_to` UUID — **проставляется агентом на строке-ответе**, ссылается на
  id строки-вопроса. Поллер обнаруживает ответ именно по этому полю.
- `status` — `pending`/`processing`/`completed`/`failed` (подтверждённая спека
  CHECK владельца). **`in_progress` — legacy-синоним `processing`**: репозиторий
  `AgentMessageRepository.count_active_for_user` принимает оба значения
  (`WHERE status IN ('processing', 'in_progress')`). Новые агенты должны
  использовать `processing`.
- `metadata.reasoning` — стримящиеся рассуждения агента (legacy: `metadata.thinking`).
- GP-имитация: без PK, `DISTRIBUTED BY (chat_id)`.

**Связь с чатом**: `chat_messages.agent_ref VARCHAR(36)` — ссылка из
ассистент-сообщения (draft) на `id` строки-вопроса в шине.
`CLAIM_TIMEOUT_SEC=1800` (пока `pending`) / `ANSWER_TIMEOUT_SEC=600` (пока
`processing`) — двухфазный таймаут поллера; см. `AgentChannelSettings`
(`CHAT__AGENT_CHANNEL__`).

**Режимы тумблера «База знаний ОАРБ»** (form-параметр `agent_mode`, localStorage
ключ `assistant_oarb_mode`, 3 позиции):

| Позиция UI | `agent_mode` | Поведение POST /messages |
|---|---|---|
| Выключен | `off` | Локальная LLM/GigaChat синхронно через `orchestrator.run(...)` |
| Адаптивный | `adaptive` | Оркестратор с forward-tool в наборе — сам решает, форвардить ли |
| Всегда | `always` | Прямой проброс вопроса в bus, оркестратор не запускается |

Две другие БЗ («источников», «инструментов») в UI выключены.

---

## 1. Режим «Всегда» (`always`): прямой проброс в агента

```mermaid
sequenceDiagram
    autonumber
    actor U as User (browser)
    participant F as Frontend<br/>(chat-stream.js)
    participant API as POST /messages<br/>(api/messages.py)
    participant CS as AgentChannelService<br/>(agent_channel.py)
    participant DB as БД<br/>(chat_agent_messages_bus + chat_messages)
    participant POLL as AgentChannelPoller<br/>(одна задача на процесс)
    participant EXT as Внешний ИИ-агент<br/>(другой процесс)

    U->>F: «расскажи про X» (agent_mode=always)
    F->>API: POST /messages (FormData)
    API->>CS: submit(conversation_id, user_id,<br/>assistant_message_id, text, mode='always', media)
    CS->>DB: INSERT chat_agent_messages_bus<br/>(role='user', status='pending') → question_uid
    CS->>DB: create_streaming chat_messages<br/>(status='streaming', agent_ref=question_uid)
    CS-->>API: question_uid
    API->>POLL: subscribe(assistant_message_id, question_uid)
    API-->>F: 200 {"message_id": assistant_message_id}

    par фронт поллит готовность
        loop пока status == 'streaming'
            F->>API: GET /messages/{message_id}
            API->>DB: SELECT chat_messages
            DB-->>API: {id, status, content}
            API-->>F: {id, status, content}
        end
        Note over F: при status='complete'/'failed'<br/>рендер ответа целиком + «эффект печати»
    and внешний агент
        EXT->>DB: UPDATE chat_agent_messages_bus вопроса<br/>status='processing' (claim)
        EXT->>DB: INSERT chat_agent_messages_bus ответа<br/>(role='assistant', reply_to=question_uid),<br/>стримит reasoning-дельты в metadata.reasoning,<br/>пишет content и status='completed' + UPDATE вопроса status='completed'
    and поллер шины
        loop adaptive backoff (соединение не удерживается вовсе — исполнитель берёт коннект на операцию)
            POLL->>CS: poll_once(assistant_message_id, question_uid, ...)
            CS->>DB: SELECT вопрос по question_uid
            alt строки-ответа ещё нет
                CS-->>POLL: 'pending'
            else агент ответил
                CS->>DB: SELECT ответ WHERE reply_to=question_uid<br/>AND role='assistant'
                alt answer.status == 'error'
                    CS->>DB: mark_failed (error-блок)
                else
                    CS->>DB: finalize chat_messages<br/>(status='complete', map_answer_to_blocks)
                end
                CS-->>POLL: терминальный статус → unsubscribe
            end
        end
    end
```

**Ключевые контракты:**

- **Поллер — единственный writer** в `chat_messages` для draft'а: `create_streaming`
  на старте, `finalize`/`mark_failed` по результату `poll_once`. Фронт лишь
  опрашивает готовность.
- **Таймаут**: двухфазный — `CLAIM_TIMEOUT_SEC` (1800) пока `pending`, `ANSWER_TIMEOUT_SEC` (600) пока `processing`. Поллер вызывает
  `mark_timeout(reason='claim'|'answer')` → draft → `failed` с error-блоком (`build_timeout_error_block`);
  вопрос в шине best-effort закрывается `status='failed'` (если CHECK владельца
  отклонит — строка останется, слот лимита освобождает двойная отсечка
  возрасту в `count_active_for_user`).
- **Reconcile после рестарта**: поллер при старте поднимает подписки из
  streaming-черновиков `chat_messages` (`get_streaming_drafts`).
- **Аварийное снятие подписки**: ошибка обработки одной подписки в тике
  ретраится (idle-таймер продолжает тикать), но серия из
  `_MAX_CONSECUTIVE_ENTRY_ERRORS` (30) ошибок ПОДРЯД — признак «отравленной»
  подписки (например, сменилась структура bus-таблицы): подписка снимается,
  draft best-effort финализируется error-блоком через `mark_timeout`.
  Полный отказ БД тоже проявляется здесь: `_get_executor()` соединения не
  берёт (просто отдаёт синглтон), поэтому реальный сбой БД падает уже внутри
  `_tick` на первом SQL-вызове каждой подписки и ловится тем же
  per-подписочным `try/except`, наращивая `consecutive_errors`.

---

## 2. Режим «Адаптивный» (`adaptive`): оркестратор решает сам

```mermaid
sequenceDiagram
    autonumber
    actor U as User (browser)
    participant F as Frontend
    participant API as POST /messages<br/>(api/messages.py)
    participant ORCH as Orchestrator<br/>(orchestrator.run)
    participant FT as forward-tool<br/>(forward_tool_factory.py)
    participant CS as AgentChannelService
    participant DB as БД
    participant POLL as AgentChannelPoller

    U->>F: вопрос (agent_mode=adaptive)
    F->>API: POST /messages (FormData)
    API->>ORCH: run(message_id, agent_mode='adaptive', ...)
    Note over ORCH: forward-tool в наборе.<br/>LLM сама решает, форвардить ли.
    alt LLM отвечает локально
        ORCH->>DB: сохранить ответ chat_messages<br/>(status='complete')
    else LLM зовёт forward-tool
        ORCH->>FT: tool_call
        FT->>CS: submit(mode='adaptive', ...)
        CS->>DB: INSERT вопрос (pending)<br/>+ create_streaming draft (status='streaming')
        Note over POLL: поллер подхватит draft и<br/>финализирует через poll_once<br/>(см. диаграмму §1)
    end
    API-->>F: 200 {"message_id": assistant_message_id}
    loop пока status == 'streaming'
        F->>API: GET /messages/{message_id}
        API-->>F: {id, status, content}
    end
```

Режим `off` идентичен `adaptive` по транспорту, но forward-tool в наборе нет:
оркестратор всегда отвечает локально, draft сразу сохраняется со
`status='complete'`.

---

## 3. Маппинг ответа агента в блоки сообщения

`AgentChannelService.map_answer_to_blocks(row)` собирает список блоков из
строки-ответа в порядке:

1. **reasoning** — из `metadata.reasoning`, legacy `metadata.thinking` (если есть);
2. **text** — `content` (обрезается до `MAX_BLOCK_TEXT_SIZE` = 262144);
3. **buttons** — из `buttons` JSONB, `block_id` шаблоном `{id}:btn:0`;
   `button_translator.translate_buttons` переводит `action_id` ChatTool в
   client-action `open_url`;
4. **media** — `image`/`file` из `media` JSONB;
5. **error** — если `answer.status == 'error'`.

---

## 4. Лимит одновременных запросов

`AgentMessageRepository.count_active_for_user` вызывается **до** записи в БД.
Если активных запросов пользователя `>= max_parallel_streams_per_user`
(`CHAT__MAX_PARALLEL_STREAMS_PER_USER`, default 3) — бросается `ChatLimitError`
→ HTTP 422 с дружелюбным сообщением, ни вопрос, ни draft не создаются.
Счёт идёт с двойной отсечкой: `pending`-строки — по `created_at` (окно `CLAIM_TIMEOUT_SEC`),
`processing`-строки — по `updated_at` (окно `ANSWER_TIMEOUT_SEC`): вопрос,
которому не удалось записать терминальный статус (CHECK владельца шины),
не занимает слот навсегда.

---

## 5. Граничные случаи

| Случай | Что произойдёт |
|---|---|
| Поллер ещё не дошёл до финализации, агент уже ответил | GET вернёт `status='streaming'` (draft не финализирован); следующий тик `poll_once` выполнит `finalize`, фронт увидит `complete` на очередном опросе |
| Строка-ответ есть, но статус нетерминальный (`pending`/`processing`) | `poll_once` → `outcome='pending'` — агент ещё стримит ответ; reasoning-блок черновика дозаполняется инкрементально |
| Ответ агента со `status='failed'` | `poll_once` → `mark_failed` с error-блоком из ответа + best-effort закрывает вопрос (`status='failed'`), фронт показывает крестик |
| Агент закрыл вопрос `status='failed'` без строки-ответа | `poll_once` → `mark_failed` со стандартным текстом «Внешний агент вернул ошибку» |
| Агент вставил ответ, но не закрыл вопрос терминальным `status` | `poll_once` сам закрывает вопрос (`status='completed'`, best-effort) после финализации |
| CHECK владельца отклонил наш статус (`CheckViolationError`) | `_set_status_safe` глотает с warning'ом — финализация/таймаут не ломаются, поллер не зацикливается |
| Превышен idle-таймаут (claim или answer) | `mark_timeout(reason)`: draft → `failed` (error-блок `agent_claim_timeout` / `agent_timeout`), вопрос в шине best-effort закрывается `failed` |
| Поллер не инициализирован (lifespan-сбой) | Форвард **не выполняется**: вопрос в шину не пишется, draft не создаётся, сразу финализируется error-сообщение (`agent_unavailable`). Беседа остаётся удаляемой |
| Рестарт uvicorn посреди ожидания | Поллер при старте поднимает подписки из streaming-черновиков `chat_messages` и продолжает опрос; draft остаётся виден в истории как `streaming` |
| Пользователь отправил N форвардов параллельно | Каждый получает свой `message_id`/вопрос; при `>= max_parallel_streams_per_user` активных — `ChatLimitError` (422) до записей |

---

## 6. Где смотреть в коде

- POST/GET messages — `app/domains/chat/api/messages.py` (`send_message`, `get_message`)
- AgentChannelService — `app/domains/chat/services/agent_channel.py`
  (`submit`, `poll_once`, `mark_timeout`, `get_queue_details`, `map_answer_to_blocks`, `build_timeout_error_block`)
- AgentChannelPoller — `app/domains/chat/services/agent_channel_poller.py`
  (`subscribe`/`unsubscribe`/`_tick`/`_run` adaptive-backoff, reconcile из streaming-черновиков, `start`/`stop`/`get_status`)
- button_translator — `app/domains/chat/services/button_translator.py` (`translate_buttons`)
- forward-tool (adaptive) — `app/domains/chat/services/forward_tool_factory.py`
- bus-репозиторий — `app/domains/chat/repositories/agent_message_repository.py` (`count_active_for_user`, `get_by_uid`, `get_answer_for_question`)
- chat_messages streaming-методы — `app/domains/chat/repositories/message_repository.py`
  (`create_streaming`/`finalize`/`mark_failed`/`get_streaming_drafts`)
- настройки — `AgentChannelSettings` (`app/domains/chat/settings.py`),
  env-префикс `CHAT__AGENT_CHANNEL__`: `TABLE_NAME=chat_agent_messages_bus`,
  `POLL_MIN_INTERVAL_SEC=2.0`, `POLL_MAX_INTERVAL_SEC=10.0`,
  `POLL_BACKOFF_MULTIPLIER=1.5`, `CLAIM_TIMEOUT_SEC=1800`, `ANSWER_TIMEOUT_SEC=600`,
  `MAX_BLOCK_TEXT_SIZE=262144`
- фоновый хук — `chat.agent_channel_poller`
- Frontend — `static/js/shared/chat/chat-stream.js`, `chat-messages.js`
