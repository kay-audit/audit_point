# Manual QA — канал к внешнему ИИ-агенту (chat_agent_messages_bus)

Чек-лист ручной проверки канала к внешнему ИИ-агенту (база знаний ОАРБ) перед merge'ом ветки.

> Bus-таблица `chat_agent_messages_bus` хранится в БД **без app-префикса** — её имя задаётся `CHAT__AGENT_CHANNEL__TABLE_NAME` целиком (дефолт `chat_agent_messages_bus`). Остальные таблицы чата (`chat_messages`, `chat_files`) в тексте упоминаются без префикса для краткости, но в БД хранятся с префиксом `DATABASE__TABLE_PREFIX` (по умолчанию `t_db_oarb_audit_act_`).

## Архитектура (кратко)

- Канал к агенту — единая bus-таблица `chat_agent_messages_bus` (вопрос от AW = строка `role='user'`, ответ агента = строка `role='assistant'`). Подробная семантика колонок и сценарии имитации — `docs/integrations/external-agent-imitation.sql`.
- Транспорта SSE нет. POST сообщения возвращает `{message_id}`; фронт затем поллит `GET /api/v1/chat/conversations/{cid}/messages/{message_id}` до терминального статуса и рендерит ответ целиком с декоративным «эффектом печати» (токен-стриминга нет).
- Режим работы задаётся form-параметром `agent_mode`:
  - `off` / `adaptive` — локальная LLM (или GigaChat) исполняется синхронно в POST через `orchestrator.run(...)`. В `adaptive` оркестратор сам решает форвардить (forward-tool в наборе).
  - `always` — прямой проброс вопроса в агента, минуя LLM.
- Форвард создаёт черновик `chat_messages` (`status='streaming'`) + строку-вопрос в `chat_agent_messages_bus`; фоновый `AgentChannelPoller` поллит шину; `AgentChannelService.poll_once` дозаполняет reasoning инкрементально и финализирует черновик (`complete`/`failed`).
- Тумблер «База знаний ОАРБ» в UI — 3 позиции: Выключен / Адаптивный / Всегда (localStorage-ключ `assistant_oarb_mode`). Две другие БЗ («источников», «инструментов») в UI выключены.

## Подготовка

1. Поднять Redis (`REDIS__HOST`/`REDIS__PORT` из `.env`) — без него приложение не стартует (fail-fast в хуке `auth.redis`, см. `app/auth/lifecycle.py`).

2. Поднять PostgreSQL и применить миграцию (`app/domains/chat/migrations/postgresql/schema.sql`):
   - Должна появиться таблица `chat_agent_messages_bus` (без app-префикса — имя из `CHAT__AGENT_CHANNEL__TABLE_NAME`).
   - В `chat_messages` должна быть колонка `agent_ref VARCHAR(36)`.

3. Заполнить `.env` (за основу — `.env.dev`; маршрут `openai` = прямой HTTP к OpenAI-совместимому бэкенду, детали маршрутов см. §7.1a в [`ai-assistant.md`](../guides/ai-assistant.md)):
   ```
   CHAT__PROFILE=openai
   CHAT__API_BASE=https://foundation-models.api.cloud.ru/v1
   CHAT__API_KEY=<твой ключ>
   CHAT__MODEL=<модель бэкенда>
   CHAT__RETRY__ON_429=true
   CHAT__RETRY__ON_5XX=true
   CHAT__MAX_PARALLEL_STREAMS_PER_USER=3
   CHAT__AGENT_CHANNEL__TABLE_NAME=chat_agent_messages_bus
   CHAT__AGENT_CHANNEL__POLL_MIN_INTERVAL_SEC=2.0
   CHAT__AGENT_CHANNEL__POLL_MAX_INTERVAL_SEC=10.0
   CHAT__AGENT_CHANNEL__POLL_BACKOFF_MULTIPLIER=1.5
   CHAT__AGENT_CHANNEL__ANSWER_TIMEOUT_SEC=1800
   CHAT__AGENT_CHANNEL__CLAIM_TIMEOUT_SEC=1800
   CHAT__AGENT_CHANNEL__MAX_BLOCK_TEXT_SIZE=262144
   ```
   Для проверки канала подходит и маршрут через мост (`CHAT__PROFILE=redis-bridge,openai`, дефолт `.env.dev`) — форвард на агента от маршрута LLM не зависит.

4. Запустить `uvicorn app.main:app --reload`, открыть портал в браузере.

## Чек-лист

### 1. Локальный ответ (тумблер «Выключен»)
- Тумблер «База знаний ОАРБ» — в позиции «Выключен».
- Написать в чат: «Привет, как дела?»
- Ожидаемо: LLM отвечает синхронно (форварда нет, строк в `chat_agent_messages_bus` не появляется).
- Проверить: `SELECT count(*) FROM chat_agent_messages_bus` — не должно увеличиться.

### 2. Прямой форвард на внешнего агента (тумблер «Всегда»)
- Перевести тумблер в позицию «Всегда».
- Написать: «Расскажи про регламент 2024 года».
- Ожидаемо: появилась строка `role='user'`, `status='pending'` в `chat_agent_messages_bus`; в чате — облако-черновик с эффектом печати.
- В DBeaver выполнить сценарий §1 из `external-agent-imitation.sql` (вставить ответ агента с `reply_to=<id вопроса>` и `status='completed'` + закрыть вопрос `status='completed'`).
- Ожидаемо: после ближайшего poll-тика (≤ `POLL_MAX_INTERVAL_SEC`) в чате появился финальный текст ответа; рассуждения из `metadata.reasoning` (или `metadata.thinking` — legacy-fallback) отрисованы reasoning-блоком.

### 3. Адаптивный форвард (тумблер «Адаптивный»)
- Перевести тумблер в позицию «Адаптивный».
- Написать вопрос, требующий знаний базы: «Что в регламенте 2024 года про КСО?».
- Ожидаемо: оркестратор вызывает forward-tool, появляется строка-вопрос в `chat_agent_messages_bus`.
- Завершить ответ агента (§1 имитации) — ответ отрисуется в чате.
- Контрольный кейс: тривиальный вопрос («2+2?») в «Адаптивном» оркестратор отвечает локально без записи в шину.

### 4. Ответ с кнопками
- Форварднуть вопрос, ответ агента вставить по сценарию §2 из `external-agent-imitation.sql` (с `buttons`).
- Ожидаемо: под текстом ответа отрисованы кнопки. Нажатие на кнопку `acts.open_act_page` переводит на `/constructor?act_id={id}` (где `id` — INTEGER из `acts.id`).
- В сценарии §2 имитации подставь `km_number` **существующего** акта: если акт не найден, транслятор вернёт не `open_url`, а уведомление «Акт `<номер>` не найден» — это тоже валидный подсценарий для проверки.
- Под капотом: `button_translator.translate_buttons` мапит `action_id` ChatTool → client-action `open_url` (кнопка без зарегистрированного ChatTool или без `button_translator` проходит как есть — фронт её не исполнит).

### 5. Ответ с файлом/медиа
- Форварднуть вопрос, ответ агента вставить по сценарию §3 из `external-agent-imitation.sql` (с `media`).
- Ожидаемо: `image/*` рендерится встроенным изображением; прочие mime — иконка + кнопка «Скачать» (через `GET /api/v1/chat/files/{file_id}`).

### 6. Таймауты агента (двухфазные, idle-семантика)
Отсчёт в обеих фазах идёт от последнего **признака жизни** агента (переход `pending`→`processing`, рост `metadata.reasoning`, изменение `updated_at` строки-ответа, уменьшение числа pending-вопросов впереди), а не от создания вопроса.

- **Claim-таймаут** (вопрос так и не взяли в работу): форварднуть вопрос и не трогать строку-вопрос дольше `CLAIM_TIMEOUT_SEC` (по умолчанию 1800с). Ожидаемо: error-блок «Внешний агент не взял вопрос в работу за отведённое время. Попробуйте позже.» (`build_timeout_error_block(reason='claim')`).
- **Answer-таймаут** (взяли, но не ответили): перевести вопрос в `processing` (сценарий §5 или §9 имитации) и дальше ничего не делать дольше `ANSWER_TIMEOUT_SEC` (по умолчанию 1800с). Ожидаемо: error-блок «Внешний агент не ответил вовремя. Попробуйте позже.» (`reason='answer'`).
- В обоих случаях: черновик `chat_messages` финализируется error-блоком, `AgentChannelService.mark_timeout` best-effort ставит строке-вопросу `status='failed'`, подписка снимается.
- Для быстрой проверки таймауты удобно временно уменьшить в `.env` (например, до 60/30 сек) — иначе ждать полчаса.

### 6a. Очередь и статус ожидания
- Выполнить сценарий §8 имитации (вставить «чужой» pending-вопрос с более ранним `created_at`).
- Ожидаемо: под облаком-черновиком строка статуса «В очереди: впереди 1 запрос» (при 0 впереди — «В очереди: вы следующий»); после перевода вопроса в `processing` — «Агент работает над ответом…».
- Очередь глобальная: `AgentMessageRepository.count_pending_before` считает pending-вопросы **всех** пользователей, созданные раньше вашего (фильтра по user_id нет).

### 6b. Порционный reasoning
- Выполнить сценарий §10 имитации (строка-ответ с пустым `content` + 4 UPDATE, дописывающих `metadata.reasoning`).
- Ожидаемо: фронт допечатывает дельты рассуждений по мере роста; уже показанные фрагменты не переанимируются (в т.ч. после reload). Каждый UPDATE — признак жизни, продлевающий answer-таймер.

### 7. Восстановление после reload
- Форварднуть вопрос, во время ожидания перезагрузить страницу.
- Ожидаемо: облако-черновик восстанавливается из истории беседы — `GET /messages` отдаёт streaming-сообщение (`chat_messages.status='streaming'`) как обычную запись. После завершения ответа агента poll финализирует черновик, ответ виден в истории.
- Под капотом: после рестарта uvicorn `AgentChannelPoller` реконсайлит активные форварды из streaming-черновиков (`start`/`subscribe`) — зависших облаков печати не остаётся.

### 8. Лимит одновременных запросов
- Открыть несколько бесед и форварднуть запросы, не завершая их, до достижения `CHAT__MAX_PARALLEL_STREAMS_PER_USER` (по умолчанию 3).
- Следующий форвард: `AgentMessageRepository.count_active_for_user` возвращает `>= max`, бросается `ChatLimitError` ДО записей → HTTP 422 с дружелюбным сообщением.
- Завершить один из активных форвардов — лимит освобождается, новый запрос проходит.

### 9. Смена маршрута LLM-провайдера
- Сменить `.env` на другой маршрут (например `redis-bridge,gigachat` — см. `docs/integrations/redis-llm-bridge.md`; внутренний адрес прямого сервера — маршрут `openai`), перезапустить.
- Повторить сценарии 1–3.
- Ожидаемо: всё работает без правки кода.
