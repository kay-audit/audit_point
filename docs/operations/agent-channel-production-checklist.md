# Канал к внешнему ИИ-агенту: production-checklist

Чек-лист для эксплуатации канала к внешнему ИИ-агенту через единую
bus-таблицу `chat_agent_messages_bus` в Greenplum. Покрывает: ручную
retention-чистку, мониторинг, ёмкости, troubleshooting.

Транспорт между фронтом и бэком — **polling по HTTP, без SSE**: POST
`/api/v1/chat/conversations/{cid}/messages` возвращает `{message_id}`,
фронт затем поллит GET
`/api/v1/chat/conversations/{cid}/messages/{message_id}` до терминального
статуса и рендерит ответ целиком (декоративный «эффект печати», без
токен-стриминга). Форвард в агента: оркестратор/прямой проброс создаёт
черновик `chat_messages` (status='streaming') + вопрос в шине
`chat_agent_messages_bus`; фоновый `AgentChannelPoller` поллит шину;
`AgentChannelService.poll_once` дозаполняет reasoning и финализирует
черновик (`chat_messages.status` → `complete`/`failed`; bus-строка → `completed`/`failed`).

См. также `app/domains/chat/services/agent_channel.py`,
`agent_channel_poller.py` и `docs/integrations/external-agent-imitation.sql`
(SQL-стенд имитации внешнего агента под единую таблицу).

> **Имя bus-таблицы — без app-префикса**: задаётся `CHAT__AGENT_CHANNEL__TABLE_NAME`
> целиком (дефолт `chat_agent_messages_bus`, **без** `DATABASE__TABLE_PREFIX`). В SQL
> ниже подставь актуальное имя, если оно переопределено; на GP добавляется схема
> `DATABASE__GP__SCHEMA`.

---

## 1. Retention: ручная чистка (раз в N дней)

`chat_agent_messages_bus` хранит и вопросы (`role='user'`), и ответы агента
(`role='assistant'`). После финализации (`status` в `completed`/`failed`)
строки остаются вечно. На интенсивном использовании таблица растёт и через
несколько месяцев упрётся в диск.

**Решение:** периодический ручной (или scheduled через cron / Datalab job)
DELETE по `created_at`.

> **Retention-окна:** плановая чистка — 30 дней (этот раздел). В `operations-recovery.md` §3 рекомендуется 7 дней — это аварийный сценарий («таблица уже распухла»), не норма. Назначения разные; не путать.

### 1.1. PostgreSQL (dev-инсталляция)

```sql
-- Чистим сообщения шины старше 30 дней.
-- На большой таблице желательно сначала добавить индекс по created_at:
--   CREATE INDEX IF NOT EXISTS idx_chat_agent_messages_bus_created_at
--       ON chat_agent_messages_bus(created_at);
-- (требуется один раз, выполнение DELETE без индекса = полный скан).

BEGIN;
DELETE FROM chat_agent_messages_bus
WHERE created_at < now() - interval '30 days';
COMMIT;
```

### 1.2. Greenplum (прод-инсталляция)

> Значение `DATABASE__GP__SCHEMA` указано в `.env`. Подставь своё значение вместо `<ваша_GP_схема>`.

```sql
-- 1. (один раз) Индекс на created_at — без него DELETE на multi-segment таблице будет долгим.
CREATE INDEX idx_chat_agent_messages_bus_created_at
    ON <ваша_GP_схема>.chat_agent_messages_bus(created_at);

-- 2. DELETE раз в N дней.
DELETE FROM <ваша_GP_схема>.chat_agent_messages_bus
WHERE created_at < now() - interval '30 days';
```

### 1.3. Контрольные запросы (сколько съело места)

```sql
-- PG
SELECT
    pg_size_pretty(pg_total_relation_size('chat_agent_messages_bus')) AS messages_size,
    (SELECT count(*) FROM chat_agent_messages_bus) AS messages_rows;

-- GP — то же, но с указанием схемы (DATABASE__GP__SCHEMA из .env):
SELECT
    pg_size_pretty(pg_total_relation_size('<ваша_GP_схема>.chat_agent_messages_bus')) AS messages_size,
    (SELECT count(*) FROM <ваша_GP_схема>.chat_agent_messages_bus) AS messages_rows;
```

**Ориентир:** при 100 forward'ов в день — вопрос + ответ на каждый,
~200 строк/день в `chat_agent_messages_bus`. За месяц — ~6K строк (с учётом
payload-JSON в `media`/`metadata`). Чистка раз в месяц — комфортно.

---

## 2. Sizing

### 2.1. asyncpg-пул (`DATABASE__POOL_*`)

| Параметр | Дефолт | Объяснение |
|---|---|---|
| `POOL_MIN_SIZE` | 1 | Минимум коннектов в простое |
| `POOL_MAX_SIZE` | 2 | Потолок. У ПРОМ-учётки GP лимит порядка 5 соединений, поэтому пул минимальный: горячие пути (счётчик непрочитанных, роли, user-контекст, локи актов) обслуживает Redis, а батчеры и `AgentChannelPoller` берут коннект короткими порциями |

**Не увеличивай `POOL_MAX_SIZE` без необходимости** — на ПРОМ-GP это всё равно
упрётся в лимит соединений учётки. Сначала retention для `chat_agent_messages_bus`
(п. 1), потом профилирование под нагрузкой (см. troubleshooting №17: симптом
обычно означает удерживаемое соединение, а не тесный пул).

`AgentChannelPoller` **не держит коннект** во время `sleep`/backoff — conn
берётся только на время SELECT'а шины и финализирующей транзакции.

### 2.2. Таймауты и polling канала (`CHAT__AGENT_CHANNEL__*`)

| Параметр | Дефолт | Что значит |
|---|---|---|
| `TABLE_NAME` | `chat_agent_messages_bus` | Имя bus-таблицы |
| `CLAIM_TIMEOUT_SEC` | 1800 (30 мин) | Сколько ждать, пока агент возьмёт вопрос в работу (фаза `pending` → `processing`). После — `mark_timeout(reason='claim')` |
| `ANSWER_TIMEOUT_SEC` | 600 (10 мин) | Сколько ждать ответ агента (фаза `processing`). После — `mark_timeout(reason='answer')`, черновик финализируется error-блоком |
| `POLL_MIN_INTERVAL_SEC` | 2.0 | Минимум между SELECT'ами поллера (старт adaptive backoff) |
| `POLL_MAX_INTERVAL_SEC` | 10.0 | Максимум после backoff'а на пустых тиках |
| `POLL_BACKOFF_MULTIPLIER` | 1.5 | Множитель backoff'а |
| `MAX_BLOCK_TEXT_SIZE` | 262144 | Потолок размера текста блока при маппинге ответа |

Worst case: 10 минут от форварда до timeout. На практике — секунды для
коротких ответов, до нескольких минут для длинных reasoning-chain'ов
вроде RAG-агента.

### 2.3. Per-user лимиты

- `CHAT__MAX_PARALLEL_STREAMS_PER_USER` (default 3) — одновременных активных
  запросов на пользователя. `AgentMessageRepository.count_active_for_user`
  при `>= max_parallel_streams_per_user` бросает `ChatLimitError` **до**
  записей → HTTP 422 с дружелюбным сообщением.
- `UserRateLimiter` — скользящее окно 60с на POST `/messages`.

---

## 3. Мониторинг

### 3.1. Метрики, которые уже пишутся в БД

| Таблица | Что мониторить |
|---|---|
| `chat_tool_metrics` | Latency / status / username вызовов ChatTool — медленные tools, спайки validation_error |
| `admin_http_metrics` | Latency / status HTTP-запросов — медленные эндпоинты, спайки 5xx |
| `chat_audit_log` | Жизненный цикл бесед: created / deleted / message_sent и т.п. |
| `chat_agent_messages_bus.status` | Распределение `pending`/`processing`/`completed`/`failed` — алёрт на залипшие |

### 3.2. Алерты (рекомендации)

| Сигнал | Запрос | Когда дёргать |
|---|---|---|
| Зависшие запросы | `SELECT count(*) FROM chat_agent_messages_bus WHERE role='user' AND status IN ('pending','processing') AND updated_at < now() - interval '15 minutes'` | > 0 |
| Спайки ошибок агента | `SELECT count(*) FROM chat_agent_messages_bus WHERE status='failed' AND created_at > now() - interval '1 hour'` | > 5/час |
| Рост шины | `SELECT count(*) FROM chat_agent_messages_bus` | резкий рост без retention (п. 1) |
| Orphan файлов | `SELECT count(*) FROM chat_files WHERE conversation_id NOT IN (SELECT id FROM chat_conversations)` | > 0 |
| Зависшие черновики | `SELECT count(*) FROM chat_messages WHERE status='streaming' AND created_at < now() - interval '15 minutes'` | > 0 |

### 3.3. WARNING'и по приближению к лимиту пула

`DbPoolMonitor` (admin-домен, lifespan-hook `admin.db_pool_monitor`) раз
в 30 секунд проверяет `pool.get_size()` / `pool.get_idle_size()`.
Когда `acquired/max_size >= warn_ratio` (default 0.9) — WARNING в лог:

```
db_pool_monitor: пул близок к лимиту — acquired=18/20 (size=20, idle=2, ratio=0.90)
```

Throttle: один WARNING на серию подряд идущих high-usage замеров; при
возврате к норме — INFO «нагрузка на пул нормализована». Логи доступны
для агрегатора (Loki/syslog), там и строится алёрт.

Конфиг (`.env`):

```
ADMIN__DB_POOL_MONITOR__ENABLED=true
ADMIN__DB_POOL_MONITOR__CHECK_INTERVAL_SEC=30.0
ADMIN__DB_POOL_MONITOR__WARN_RATIO=0.9
```

### 3.4. Логи, на которые смотреть

```
# Канал к агенту:
audit_workstation.domains.chat.services.agent_channel_poller   # цикл polling шины
audit_workstation.domains.chat.services.agent_channel          # submit / poll_once / mark_timeout

# Ошибки LLM (локальная LLM/GigaChat в синхронном POST):
audit_workstation.domains.chat.agent_loop          # exception в петле оркестратора
```

---

## 4. Фоновые задачи (хуки в lifespan)

При старте `uvicorn` поднимаются (в порядке регистрации). Канонический список — dev-guide §11.

1. `acts.audit_log_batcher` — батч-INSERT в `audit_log` (50 шт / 30 сек)
2. `admin.http_metrics_batcher` — батч-INSERT в `admin_http_metrics`
3. `admin.access_denied_audit_batcher` — батч-INSERT в `access_denied_audit`
4. `admin.db_pool_monitor` — мониторинг asyncpg-пула (каждые 30 сек, WARNING при ≥0.9 утилизации)
5. `chat.tool_metrics_batcher` — батч-INSERT в `chat_tool_metrics`
6. `chat.audit_log_batcher` — батч-INSERT в `chat_audit_log`
7. `chat.agent_channel_poller` — `AgentChannelPoller`: поллит шину
   `chat_agent_messages_bus` по активным запросам с adaptive backoff (без удержания
   conn в sleep), при старте reconcile подхватывает зависшие
   streaming-черновики `chat_messages`
8. `chat.llm_health_probe` — периодическая проверка доступности LLM-провайдера

**Shutdown** — в обратном порядке. Если что-то не остановилось за 5с —
warning в лог.

---

## 5. Troubleshooting

### 5.1. «Чат завис, никто не отвечает» (форвард в агента)

1. Проверь `app_singleton_lock` — есть ли активный воркер:
   ```sql
   SELECT * FROM t_db_oarb_audit_act_app_singleton_lock;
   ```
2. Проверь поллер в логах: ищи старт
   `audit_workstation.domains.chat.services.agent_channel_poller` и его
   `get_status`. Зависание тиков — симптом сетевой проблемы к GP.
3. Проверь статус вопроса в шине:
   ```sql
   SELECT id, status, updated_at FROM chat_agent_messages_bus
   WHERE role='user' ORDER BY created_at DESC LIMIT 5;
   ```
   Если `pending`/`processing` дольше `ANSWER_TIMEOUT_SEC` — агент не
   отвечает, дальше сработает `mark_timeout`.
4. Проверь пул: количество `acquire`-таймаутов в логах asyncpg.

### 5.2. «Юзер видит ошибку при любом сообщении» (локальная LLM)

1. Логи: `audit_workstation.domains.chat.agent_loop` уровня
   `exception` — там реальная причина (timeout LLM, 5xx от провайдера, etc).
2. Проверь circuit breaker (`CHAT__CIRCUIT_BREAKER_*`). Если он в `open`
   — fallback-провайдер тоже недоступен.

### 5.3. «Черновик ответа агента завис в status='streaming'»

1. Проверь, что поллер жив (п. 5.1) и есть соответствующий вопрос в
   `chat_agent_messages_bus` (связь через `chat_messages.agent_ref` → uid вопроса
   в шине).
2. Если вопрос в шине финализирован (`completed`/`failed`), а
   черновик всё ещё `streaming` — `poll_once`/`mark_timeout` не
   отработал; смотри exception в логах `agent_channel`. Reconcile при
   рестарте `uvicorn` подхватывает такие черновики.

### 5.4. «Чат тормозит при N+ пользователях»

1. Pool exhausted: смотри в логах `asyncpg.pool` warning'и.
2. Если pool в порядке, проверь `chat_tool_metrics` — нет ли tool'а с
   аномально большим `latency_ms`.

---

## 6. Контракты, которые НЕ ломать

- **Транспорт — polling, не SSE.** POST `/messages` отдаёт `{message_id}`;
  ответ забирается GET-поллингом по терминальному статусу. Не добавляй SSE.
- **`AgentChannelService` — единственный writer финализации черновика**
  ассистент-сообщения (`poll_once` / `mark_timeout`). Не добавляй
  save/финализацию в другие места.
- **Поллер не держит conn в sleep/backoff.** Conn берётся только на SELECT
  шины и финализирующую транзакцию — не объединять обратно «для простоты».
- **`CHAT__MAX_PARALLEL_STREAMS_PER_USER`** проверяется через
  `count_active_for_user` ДО записей в шину → 422 при превышении.
- **`chat_messages.agent_ref`** связывает ассистент-черновик с uid вопроса
  в `chat_agent_messages_bus` — не убирать, на нём держится финализация.
