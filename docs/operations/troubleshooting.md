# Troubleshooting — типовые проблемы

Сборник симптомов и решений для частых ошибок. Если не нашёл свою проблему — начни с хаба гайд-бука [`docs/guides/developer-guide.md`](../guides/developer-guide.md) и логов uvicorn.

## Оглавление

1. [Kerberos билет протух (`kinit` expired)](#1-kerberos-билет-протух-kinit-expired)
2. [Greenplum: connection refused / pool init failure](#2-greenplum-connection-refused--pool-init-failure)
3. [File upload в чат: 413 Payload Too Large](#3-file-upload-в-чат-413-payload-too-large)
4. [Канал к внешнему агенту: ответ не приходит / таймаут](#4-канал-к-внешнему-агенту-ответ-не-приходит--таймаут)
4a. [Форвард в «Базу знаний ОАРБ» не срабатывает](#4a-форвард-в-базу-знаний-оарб-не-срабатывает)
5. [LLM возвращает 4xx (включая GigaChat 422)](#5-llm-возвращает-4xx-включая-gigachat-422)
6. [HTTP-метрики не пишутся в БД](#6-http-метрики-не-пишутся-в-бд)
7. [LLM-мост `redis-bridge`: воркер недоступен / дедлайн заявки](#7-llm-мост-redis-bridge-воркер-недоступен--дедлайн-заявки)
8. [Валидация КМ-номера падает](#8-валидация-км-номера-падает)
9. [`RuntimeError: Database pool не инициализирован`](#9-runtimeerror-database-pool-не-инициализирован)
10. [Greenplum: `InvalidTableDefinitionError` при `CREATE TABLE`](#10-greenplum-invalidtabledefinitionerror-при-create-table)
11. [Тесты падают из-за состояния между тестами](#11-тесты-падают-из-за-состояния-между-тестами)
12. [На фронте появился «⚠ Блок неизвестного типа»](#12-на-фронте-появился--блок-неизвестного-типа)
13. [`pytest` падает на `test_settings_*`](#13-pytest-падает-на-test_settings_)
14. [GigaChat: 422 `RequestInputValidationException` на втором tool-вызове](#14-gigachat-422-requestinputvalidationexception-на-втором-tool-вызове)
15. [Акт не сохраняется (yellow → white не происходит)](#15-акт-не-сохраняется-yellow--white-не-происходит)
16. [Тесты падают на pytest-asyncio: «Task attached to a different loop» / «There is no current event loop»](#16-тесты-падают-на-pytest-asyncio-task-attached-to-a-different-loop--there-is-no-current-event-loop)
17. [`asyncpg.exceptions.TooManyConnectionsError` при долгих запросах](#17-asyncpgexceptionstoomanyconnectionserror-при-долгих-запросах)
18. [Greenplum: `syntax error` в `CREATE INDEX IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`](#18-greenplum-syntax-error-в-create-index-if-not-exists--add-column-if-not-exists)
19. [Settings залипают между тестами (один тест видит env другого)](#19-settings-залипают-между-тестами-один-тест-видит-env-другого)
20. [Singleton-lock — приложение не стартует / зависший процесс](#20-singleton-lock--приложение-не-стартует--зависший-процесс)
21. [Записи в audit_log / metrics пропадают — что проверить](#21-записи-в-audit_log--metrics-пропадают--что-проверить)
22. [Старт падает: `must be owner of relation <bus-таблица>`](#22-старт-падает-must-be-owner-of-relation-bus-таблица)
23. [Redis недоступен: приложение не стартует / ошибки блокировок](#23-redis-недоступен-приложение-не-стартует--ошибки-блокировок)

---

### 1. Kerberos билет протух (`kinit` expired)

**Симптом:** при работе с Greenplum в логе появляется сообщение `Kerberos токен протух. Выполните 'kinit' для обновления.`, запросы к БД падают с ошибкой инициализации пула либо при первом обращении к connection.

**Причина:** Kerberos билет имеет ограниченный TTL (обычно 8–24 часа). Pre-flight проверка `_is_kerberos_ticket_valid()` (`app/db/connection.py:96`) дёргает `klist -s` и при ненулевом exit-коде логирует инструкции через `_log_kerberos_instructions()` (`app/db/connection.py:126`).

**Решение:**
1. В терминале выполни `kinit` (введи пароль доменной учётки).
2. Проверь билет: `klist` — должен быть валидный TGT.
3. Перезапусти приложение (`uvicorn ...`) либо повтори запрос; пул переинициализируется при следующей попытке.

> Текст ошибки в самом приложении местами ещё говорит про «терминал JupyterHub» (`app/main.py:207` — CRITICAL при старте, `app/main.py:388-392` — 401-ответ обработчика `KerberosTokenExpiredError`). Это историческая формулировка кода; на SDP `kinit` выполняется в обычном терминале хоста. Лог `_log_kerberos_instructions` JupyterHub не упоминает.

**См. также:** `app/db/connection.py::_is_kerberos_ticket_valid` / `::_log_kerberos_instructions`, pre-flight и перехват в `init_db` (`app/db/connection.py:261-290`).

---

### 2. Greenplum: connection refused / pool init failure

**Симптом:** При старте uvicorn падает с `Kerberos билет отсутствует или истёк` или `asyncpg.exceptions.*ConnectionError` ещё до `Database pool ready:`.

**Причина:** одно из:
- Нет валидного Kerberos билета (см. п.1).
- Нет сетевой видимости до `DATABASE__GP__HOST`.
- Неверная схема в `DATABASE__GP__SCHEMA`.

**Решение:**
1. Проверь `klist`.
2. Проверь доступность хоста (`Test-NetConnection <gp_host> -Port 5432` в PowerShell).
3. Для локальной разработки переключись на PostgreSQL: в `.env` поставь `DATABASE__TYPE=postgresql` и заполни локальные креды (готовый набор — `.env.dev`).

**См. также:** `app/db/connection.py::_is_kerberos_ticket_valid`, §6.3 в [`database.md`](../guides/database.md).

---

### 3. File upload в чат: 413 Payload Too Large

**Симптом:** Фронт показывает уведомление «файл слишком большой» или сервер возвращает 413/422 при загрузке вложения.

**Причина:** превышен один из лимитов:
- `CHAT__MAX_FILE_SIZE` (дефолт 10 МБ = 10485760 байт) — размер одного файла.
- `CHAT__MAX_TOTAL_FILE_SIZE` (дефолт 30 МБ = 31457280 байт) — суммарный размер файлов в сообщении.
- `CHAT__MAX_FILES_PER_MESSAGE` (дефолт 5) — количество файлов.
- MIME-тип не в whitelist `CHAT__ALLOWED_MIME_TYPES`.

**Решение:**
1. Уменьшить файл / разбить на несколько сообщений.
2. Если требование легитимное — увеличить лимит в `.env` и рестарт сервера. Помнить про `SECURITY__MAX_REQUEST_SIZE` (10 МБ дефолт) — он независимо ограничивает body запроса.

**См. также:** `.env.prod` секция `# --- Файлы ---`, `app/domains/chat/exceptions.py::ChatFileValidationError`.

---

### 4. Канал к внешнему агенту: ответ не приходит / таймаут

**Симптом:** После форварда в «Базу знаний ОАРБ» сообщение ассистента остаётся в статусе «печатает…» и через ~10 минут сменяется блоком ошибки о таймауте.

**Причина:** канал к внешнему ИИ-агенту — это единая bus-таблица `chat_agent_messages_bus`. При форварде создаётся черновик `chat_messages` (status='streaming') и вопрос в шине; фоновый `AgentChannelPoller` поллит шину до появления строки-ответа агента (`reply_to = <id вопроса>`) с терминальным статусом (`completed`/`failed`). Таймаут двухфазный:
- **Claim-фаза** (`status='pending'`): агент ещё не взял вопрос в работу. Лимит `CHAT__AGENT_CHANNEL__CLAIM_TIMEOUT_SEC` (дефолт 1800 = 30 мин). По истечении — `mark_timeout(reason='claim')`.
- **Answer-фаза** (`status='processing'`): агент пишет ответ. Лимит `CHAT__AGENT_CHANNEL__ANSWER_TIMEOUT_SEC` (дефолт 600 = 10 мин). По истечении — `mark_timeout(reason='answer')`, черновик финализируется error-блоком (`build_timeout_error_block`).

**Решение:**
1. Проверь таблицу `chat_agent_messages_bus`: есть ли запись-вопрос (`role='user'`) и появился ли ответ (`role='assistant'` с `reply_to` = id вопроса). Статус ответа должен дойти до `completed`. Если ответа нет — внешний агент не подхватил вопрос.
2. Если агент действительно отвечает медленнее — поднять `CHAT__AGENT_CHANNEL__ANSWER_TIMEOUT_SEC` в `.env`.
3. **Параметры polling** — `CHAT__AGENT_CHANNEL__POLL_MIN_INTERVAL_SEC` (2.0), `POLL_MAX_INTERVAL_SEC` (10.0), `POLL_BACKOFF_MULTIPLIER` (1.5). Интервал растёт от min к max при пустых тиках и сбрасывается при появлении ответа.
4. Имя bus-таблицы настраивается через `CHAT__AGENT_CHANNEL__TABLE_NAME` — целиком, без app-префикса (дефолт кода `chat_agent_messages_bus`, в `.env.prod` — `agent_conversation_messages`); схема — `CHAT__AGENT_CHANNEL__SCHEMA_NAME`.
5. Промежуточный статус виден и без SQL: пока черновик в `streaming`, GET `/messages/{message_id}` отдаёт `status_details: {bus_status, queue_ahead}` — `pending` с ненулевым `queue_ahead` означает очередь на стороне внешнего агента.

**См. также:** `app/domains/chat/services/agent_channel.py`, `agent_channel_poller.py`, `docs/integrations/external-agent-imitation.sql`.

---

### 4a. Форвард в «Базу знаний ОАРБ» не срабатывает

**Симптом:** Тумблер «База знаний ОАРБ» включён, но вопрос не уходит во внешний агент — ответ генерирует локальная LLM, либо в шине `chat_agent_messages_bus` не появляется запись-вопрос.

**Причина:** режим тумблера передаётся form-параметром `agent_mode` (`off` | `adaptive` | `always`; фронт хранит позицию в localStorage `assistant_oarb_mode`):
- `off` / `adaptive` — локальная LLM/GigaChat исполняется синхронно в POST через `orchestrator.run(...)`. В режиме `adaptive` форвард-tool есть в наборе, и оркестратор сам решает, форвардить ли вопрос.
- `always` — прямой проброс в агента без локального оркестратора.

Форвард создаёт черновик `chat_messages` (status='streaming') + вопрос в шине, после чего `AgentChannelPoller` поллит шину, а `AgentChannelService.poll_once` дозаполняет reasoning и финализирует черновик. Ссылка из ассистент-сообщения на вопрос в шине — колонка `chat_messages.agent_ref`.

**Решение:**
1. Проверь, что фронт реально шлёт `agent_mode` (DevTools → Network → form-data POST `/messages`). Позиция тумблера — в localStorage `assistant_oarb_mode`.
2. В режиме `adaptive` форвард — на усмотрение оркестратора; если нужен гарантированный проброс — переключи тумблер в «Всегда».
3. Проверь, что фоновый хук `chat.agent_channel_poller` отработал на старте (текущие фоновые хуки чата: `chat.tool_metrics_batcher`, `chat.audit_log_batcher`, `chat.agent_channel_poller`).
4. Poller переподхватывает зависшие после рестарта uvicorn черновики — reconcile из `chat_messages` со status='streaming'.

**См. также:** `app/domains/chat/services/agent_channel_poller.py`, `forward_tool_factory.py`, `button_translator.py`.

---

### 5. LLM возвращает 4xx (включая GigaChat 422)

**Симптом:** Чат падает на втором tool-вызове. В логе LLM-провайдер: `400 Input is a zero-length, empty document` (OpenAI-совместимый бэкенд с Qwen) или `422 RequestInputValidationException` (GigaChat). Отдельный случай — падение на **первом же** запросе с `400 invalid_request_error: tools.0.custom.name: String should match pattern '^[a-zA-Z0-9_-]{1,128}'` (Anthropic-модели за маршрутом `openai`).

**Причина:** одна из трёх известных проблем:
- assistant-сообщение в history содержит `content=null` + `tool_calls`.
- `arguments=""` для no-args tool_call'ов (`chat.list_pages` и т.п.) попало в эхо.
- в `tools[]` уехало доменное имя с точкой. Anthropic валидирует имя по спеке OpenAI строго, локальные inference-серверы и GigaChat — нет, поэтому проблема видна только после смены бэкенда.

> Маршрут LLM задаётся `CHAT__PROFILE`: `openai` | `gigachat` | `redis-bridge,openai` | `redis-bridge,gigachat` (`parse_route` — `app/domains/chat/settings.py:84`). Проводной формат тела (`openai`/`gigachat`) от транспорта не зависит — эти 4xx одинаково воспроизводятся и при прямом HTTP, и через мост.

**Решение:**
1. Обнови ветку до актуального master — все три бага закрыты (`safe_args` в `orchestrator_helpers.py`, явная сборка dict с `content=raw_msg.content or ""`, `to_wire_name` в `app/core/chat/tools.py`).
2. Если фикс уже есть, а ошибка повторяется — проверь, не делает ли твой новый код `messages.append(response.choices[0].message)` напрямую (Pydantic `ChatCompletionMessage` сериализует `content` как `null`).
3. Для `tools.N.custom.name` — проверь, что схему строит `ChatTool.to_openai_tool()`, а не собранный руками dict с `tool.name`; см. dev-guide §7.1a «Имена инструментов: каноническое ≠ проводное».

**См. также:** правила «assistant с `content=null` + tool_calls недопустим для Qwen на OpenAI-совместимом бэкенде (400) и GigaChat-proxy (422)» и «`arguments=""` для no-args tool_call'ов даёт тот же класс падений — оба эха собираются вручную через `safe_args()` (хелпер в `app/domains/chat/services/orchestrator_helpers.py`) и применяются в обеих ветках agent loop'а (основной `run_agent_loop` non-streaming и ветка GigaChat-fallback)».

---

### 6. HTTP-метрики не пишутся в БД

**Симптом:** Таблица HTTP-метрик пустая, хотя запросы идут.

**Причина:** `ADMIN__HTTP_METRICS_ENABLED=false` (дефолт). Кроме того, поток батчится — запись в БД происходит каждые `OBSERVABILITY__METRICS_FLUSH_INTERVAL_SEC` секунд (дефолт 5.0) или при накоплении `OBSERVABILITY__METRICS_BATCH_SIZE` записей (дефолт 100).

**Решение:**
1. В `.env` поставь `ADMIN__HTTP_METRICS_ENABLED=true`.
2. Перезапусти сервер.
3. После запроса подожди ~5 секунд (один flush) — записи появятся.

**См. также:** `.env.prod` секция Observability, `app/domains/admin/`.

---

### 7. LLM-мост `redis-bridge`: воркер недоступен / дедлайн заявки

**Симптом:** при маршруте `CHAT__PROFILE=redis-bridge,gigachat` (или `redis-bridge,openai`) чат либо **мгновенно** отдаёт штатный error-блок недоступности LLM, либо не отвечает до конца `CHAT__REQUEST_TIMEOUT` и падает по таймауту. При прямых маршрутах (`gigachat` / `openai`) тот же запрос работает.

**Причина:** локальная LLM исполняется не из приложения, а воркером в Jupyter DataLab: заявка уходит в Redis Stream `llm:bridge:requests`, ответ читается из `llm:bridge:resp:{id}` (префикс — `CHAT__REDIS_BRIDGE__KEY_PREFIX`, дефолт `llm:bridge:`). Перед `XADD` клиент читает heartbeat `llm:bridge:worker:alive` (воркер обновляет каждые 15 сек, TTL 45 сек) и проверяет, что цель маршрута есть в его `targets`; если нет — мгновенный `APIConnectionError` без ожидания. Дедлайн ожидания ответа равен `CHAT__REQUEST_TIMEOUT`; по нему поднимается `BridgeDeadlineError` (подкласс `APITimeoutError`), который **сознательно не ретраится**, но включает circuit breaker и fallback-маршрут.

**Решение:**
1. Проверить heartbeat: `redis-cli -h <REDIS__HOST> -p <REDIS__PORT> GET llm:bridge:worker:alive`. Ключа нет → воркер не запущен либо heartbeat протух: открыть `scripts/llm_redis_worker.ipynb` в DataLab и сделать Run All.
2. Ключ есть, но в `targets` нет нужной цели (`gigachat` / `openai`) — у цели не задан URL в окружении ноутбука (`GIGACHAT_API_URL` / `OPENAI_API_URL`); токен для локального бэкенда опционален.
3. `XLEN llm:bridge:requests` устойчиво растёт — воркер не вычитывает stream (упал, завис на rate limit цели, нет сети до бэкенда).
4. Поле `target_health` в heartbeat — карта живости бэкендов по `GET /models`. Её читает только фоновая задача `chat.llm_health_probe`; пользовательский путь на неё не смотрит, поэтому «воркер жив, а LLM за ним лежит» выглядит как обычные 5xx от провайдера.
5. Проверить fallback: `CHAT__FALLBACK_PROFILE` (пустое значение = fallback выключен). Типовая прод-конфигурация — primary `redis-bridge,gigachat`, fallback `redis-bridge,openai` на том же воркере.

**См. также:** [`docs/integrations/redis-llm-bridge.md`](../integrations/redis-llm-bridge.md) (протокол, конверты, smoke-чеклист), `app/domains/chat/services/redis_bridge_adapter.py`, `scripts/llm_redis_worker.ipynb`.

---

### 8. Валидация КМ-номера падает

**Симптом:** `ValueError: КМ номер должен содержать ровно 7 цифр, получено: N (...)`.

**Причина:** `KMUtils.extract_km_digits` (см. `app/domains/acts/utils/km_utils.py:13–36`) вырезает всё кроме цифр и проверяет, что осталось ровно 7 (2 для года/типа + 5 для порядкового номера). Формат, ожидаемый пользователем: `КМ-XX-XXXXX` (русские буквы К и М). Если вставлены латинские KM, дефис в неправильном месте или один лишний/недостающий разряд — не пройдёт.

**Решение:**
1. Проверь, что строка содержит ровно 7 цифр (всё остальное игнорируется при экстракции, но количество цифр должно совпасть).
2. Если вход — пользовательский, валидируй на фронте перед отправкой.

**См. также:** `app/domains/acts/utils/km_utils.py`.

---

### 9. `RuntimeError: Database pool не инициализирован`

**Симптом:** Любой запрос к API возвращает 500 с этим сообщением.

**Причина:** Lifespan приложения ещё не отработал (uvicorn недавно стартовал и пул в процессе прогрева) либо инициализация упала (Kerberos, сеть, неверные креды) — поищи в логах строку `Database pool ready: ...` (`app/db/connection.py:294`). Если её нет — пул не поднялся.

**Решение:**
1. Дождись `Database pool ready:` в логах перед первыми запросами.
2. Если не появляется — проверь предыдущие строки лога: там будет конкретная причина (Kerberos, ConnectionRefused, неверный пароль).

**См. также:** `app/db/connection.py::init_db`, §6.3 в [`database.md`](../guides/database.md).

---

### 10. Greenplum: `InvalidTableDefinitionError` при `CREATE TABLE`

**Симптом:** При создании новой таблицы в GP-окружении схема не накатывается, в логе `InvalidTableDefinitionError: DISTRIBUTED BY columns must be subset of PRIMARY KEY / UNIQUE`.

**Причина:** GP требует, чтобы `DISTRIBUTED BY` был подмножеством каждого `PRIMARY KEY` и `UNIQUE` констрейнта. Иначе уникальность нельзя обеспечить без распределённой блокировки.

**Решение:**
1. Если данные нужно co-locate'ить по `foreign_id` (например `conversation_id`) — использовать составной PK `(id, foreign_id)`, `id` ведущий, `DISTRIBUTED BY (foreign_id)`.
2. Lookups `WHERE id = $1` по-прежнему идут через PK-индекс (`id` стоит первым).
3. Проверь регрессию: `tests/test_gp_compatibility.py::test_distributed_by_subset_of_primary_key`.

**См. также:** §6.2 и §6.5 в [`database.md`](../guides/database.md).

---

### 11. Тесты падают из-за состояния между тестами

**Симптом:** Отдельные тесты проходят, но при запуске всего набора падают с непонятными ассертами (например про `_user_locks`, `domain_registry`, `settings_registry`).

**Причина:** Доменная система использует глобальные реестры. Без autouse-фикстуры сброса состояние течёт между тестами.

**Решение:**
1. В файле теста добавь autouse-фикстуру, сбрасывающую нужный реестр:
   - `domain_registry.reset_registry()` — для тестов доменов/навигации.
   - `settings_registry.reset()` — для тестов настроек.
   - `reset()` из `app.core.chat.tools` — для chat tools.
   - `get_settings.cache_clear()` — если используется `@lru_cache()` декорированный геттер.
2. In-process `asyncio.Lock` (например `_user_locks`) — сбрасывай через autouse-фикстуру, инициализируй lazily (НЕ `defaultdict(asyncio.Lock)`).

**См. также:** `tests/conftest.py`, §8.2 в [`testing.md`](../guides/testing.md).

---

### 12. На фронте появился «⚠ Блок неизвестного типа»

**Симптом:** В сообщении ассистента вместо контента видно warning-fallback вида «⚠ Блок неизвестного типа …».

**Причина:** Бэк прислал тип блока, которого нет в `switch (block.type)` метода `ChatRenderer.renderBlock` (`static/js/shared/chat/chat-renderer.js:437-465`). Неизвестный тип уходит в ветку `default` → `console.warn('ChatRenderer: неизвестный тип блока', …)` и `_renderUnknown` (`:488`), который и рисует плашку «⚠ Блок неизвестного типа: `<type>`. Обновите страницу.».

> Гейт рендера — именно `switch`, а **не** `KNOWN_BLOCK_TYPES`. Этот Set (`static/js/shared/chat/chat-messages.js:21`) в рендер-пути не участвует: во всём фронте у него три вхождения — объявление (`:21`), реэкспорт (`:36`) и `window.*` (`:678`). Добавление типа в Set не чинит проблему.

**Решение:**
1. Добавить `case '<тип>':` в `switch` в `ChatRenderer.renderBlock` и метод рендера рядом с `_renderText`/`_renderButtons`.
2. Параллельно на бэке тип должен быть зарегистрирован И в `MessageBlock` union (`app/core/chat/blocks.py`), И в `_DiscriminatedBlock` (`app/core/chat/schemas.py`) — иначе `parse_message_blocks` не распознает.
3. Если тип уже поддержан в актуальной версии — у пользователя закешированная старая статика: hard-reload (плашка так и советует).

**См. также:** `docs/testing/manual-qa-frontend-unknown-block.md`.

---

### 13. `pytest` падает на `test_settings_*`

**Симптом:** Тесты доменных Settings падают c неожиданными значениями полей. Локально у одного разработчика проходят, у другого — нет.

**Причина:** pydantic-settings при инстанцировании через `_load_from_env` подсасывает реальный `.env` пользователя. Тест ловит твой локальный конфиг вместо дефолтов.

**Решение:**
1. Для проверки дефолтов инстанцируй модель напрямую с минимально нужными required-полями: `ChatDomainSettings(api_base="...", api_key="...", model="...")`.
2. `_load_from_env` используй ТОЛЬКО для проверки nested env-override (типа `CHAT__RETRY__ON_429`) с явным `monkeypatch.setenv(...)`.

**См. также:** §8.4 в [`testing.md`](../guides/testing.md).

---

### 14. GigaChat: 422 `RequestInputValidationException` на втором tool-вызове

**Симптом:** Маршрут с проводным форматом GigaChat (`gigachat` или `redis-bridge,gigachat`), первый вызов с function_call успешен, второй валится с 422.

**Причина:** Нативная схема GigaChat-proxy валидирует request строго: `function_call.arguments` в assistant-сообщении должно быть **dict**, не JSON-string. На пути ответа `_translate_response` делает `dict → JSON-string` (для OpenAI SDK-схемы), а на обратном пути (эхо history) `_translate_messages` через `_args_to_dict(raw)` должен делать `JSON-string → dict`.

**Решение:**
1. Обнови ветку до master — фикс есть в `gigachat_adapter.py::_args_to_dict`.
2. Если ошибка повторяется — проверь, что в твоём коде `arguments` для GigaChat-request не сериализуется в строку повторно.
3. Регрессия: `tests/test_gigachat_adapter.py` — должен быть roundtrip-тест.

**См. также:** GigaChat валидирует request-тело строго: `arguments` в assistant с `function_call` ДОЛЖНЫ быть dict, не JSON-string (даже если строка — валидный JSON). Конвертация — `_args_to_dict(raw)` в `app/domains/chat/services/gigachat_adapter.py`: битый JSON / пустая строка / None → `{}`.

---

### 15. Акт не сохраняется (yellow → white не происходит)

**Симптом:** В UI редактора индикатор сохранения завис в жёлтом цвете (локально сохранено, в БД не записано). Никаких 4xx/5xx в Network tab.

**Причина:** `StorageManager` (`static/js/constructor/storage-manager.js`) использует dual-tracking save: red (несохранено) → yellow (в localStorage) → white (в БД). Снимок в localStorage пишется по debounce `AppConfig.localStorage.autoSaveDebounce` (3 сек) и периодически раз в `periodicSaveInterval` (2 мин). Если индикатор завис в yellow дольше 2 минут — либо есть JS-ошибка в момент DB-save, либо сервер вернул не 200/204.

**Решение:**
1. Открой DevTools Console — поищи ошибки от `StorageManager`.
2. Открой Network — найди PUT/PATCH на эндпоинт сохранения акта, проверь status и response.
3. Если запрос не уходит вообще — проверь, что `AppState.markAsUnsaved()` действительно дёргается (proxy-based tracking).
4. В крайнем случае — снимок черновика лежит в `localStorage` под ключом `audit_workstation_state:<act_id>` (`StorageManager._snapshotKey`, префикс — `AppConfig.localStorage.stateKeyPrefix`); там последняя валидная версия, её можно восстановить.

**См. также:** `docs/guides/developer-guide.md` §4.6 (Dual-tracking save).

---

### 16. Тесты падают на pytest-asyncio: «Task attached to a different loop» / «There is no current event loop»

**Симптом:** При запуске async-тестов (особенно затрагивающих сервисы с `_user_locks`, `_running` и подобными in-process реестрами) — `RuntimeError: Task <...> attached to a different loop` или `RuntimeError: There is no current event loop in thread 'MainThread'`.

**Причина:** `defaultdict(asyncio.Lock)` инициализирует первый lock в момент первого обращения — а это происходит до старта event loop в pytest-asyncio. Lock привязывается к несуществующему/чужому loop и при следующем тесте, у которого свой loop, падает.

**Решение:**
1. Заменить `defaultdict(asyncio.Lock)` на обычный dict с lazy-init:
   ```python
   _locks: dict[str, asyncio.Lock] = {}

   def _get_lock(user_id: str) -> asyncio.Lock:
       if user_id not in _locks:
           _locks[user_id] = asyncio.Lock()
       return _locks[user_id]
   ```
2. В тестах сбрасывать реестр через autouse-фикстуру: `_locks.clear()` в setup.

**См. также:** `app/domains/chat/services/conversation_service.py`, `message_service.py` — образцы корректной lazy-init.

---

### 17. `asyncpg.exceptions.TooManyConnectionsError` при долгих запросах

**Симптом:** Под нагрузкой или при большом числе одновременных пользователей — `asyncpg.exceptions.TooManyConnectionsError` или таймауты получения connection из пула.

**Причина:** Пул `asyncpg` исчерпан — все connection'ы заняты долгими транзакциями или зависшими запросами. Дефолты намеренно маленькие: `DATABASE__POOL_MIN_SIZE=1`, `POOL_MAX_SIZE=2` — у ПРОМ-учётки Greenplum лимит порядка 5 соединений, а горячие пути (счётчик непрочитанных, роли, user-контекст, блокировки актов) в БД больше не ходят, их обслуживает Redis. DEV настроен так же, чтобы дефицит коннектов вскрывался на разработке, а не на проде.

**Решение:**
1. Искать причину, а не поднимать потолок: пул рассчитан на то, что соединение берут коротко. Симптом обычно означает удерживаемое соединение (см. п.3) или новый горячий путь, который стоило унести в Redis.
2. Найти долгоиграющие транзакции на сервере. Запрос работает на PostgreSQL ≥ 9.5 и Greenplum 6.x. На более старых версиях GP набор полей в `pg_stat_activity` отличается.
   ```sql
   SELECT pid, now() - query_start AS duration, state, query
   FROM pg_stat_activity
   WHERE state != 'idle' AND now() - query_start > interval '30 seconds'
   ORDER BY duration DESC;
   ```
3. Проверить, не забыт ли `async with conn.transaction():` без выхода (например при необработанном исключении внутри).
4. Поднять `DATABASE__POOL_MAX_SIZE` — осознанное отклонение от дефолта, а не рутина. На ПРОМ-GP оно всё равно упрётся в лимит соединений учётки, поэтому годится разве что для локального PostgreSQL и только как временная мера на время поиска настоящей причины.

**См. также:** `app/db/connection.py::init_db`, `DatabaseSettings` в `app/core/config.py`.

---

### 18. Greenplum: `syntax error` в `CREATE INDEX IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`

**Симптом:** При накатывании схемы на GP — `psycopg2.errors.SyntaxError: syntax error at or near "NOT"` или аналогичная ошибка от asyncpg. Локально на PostgreSQL 13+ всё проходит.

**Причина:** Greenplum 6.x базируется на PostgreSQL 9.4. `IF NOT EXISTS` для индексов появился в PG 9.5, для колонок (`ADD COLUMN IF NOT EXISTS`) — в PG 9.6. В GP-схеме их использовать нельзя.

**Решение:**
1. В `app/domains/<domain>/migrations/greenplum/schema.sql` использовать обычный `CREATE INDEX ...` без `IF NOT EXISTS`. GP-адаптер исполняет SQL по одному statement и ловит `DuplicateTableError`/`DuplicateObjectError` — повторный накат безопасен.
2. Для колонок — добавлять только в новые таблицы или через отдельный bootstrap, проверяющий `information_schema.columns`.
3. Тот же запрет распространяется на `CREATE SEQUENCE IF NOT EXISTS`, `ON CONFLICT`, `jsonb_set()`, `gen_random_uuid()` — см. «Greenplum Compatibility» в [`database.md`](../guides/database.md).

**См. также:** `tests/test_gp_compatibility.py`, `app/db/adapters/greenplum.py`.

---

### 19. Settings залипают между тестами (один тест видит env другого)

**Симптом:** Тест устанавливает `monkeypatch.setenv("CHAT__API_BASE", "...")`, видит ожидаемое значение. Следующий тест в том же файле получает то же значение, хотя monkeypatch уже снят.

**Причина:** `get_settings()` в `app/core/config.py` декорирован `@lru_cache()` — первый вызов кеширует Settings со значениями env на момент вызова. Последующие вызовы возвращают тот же объект, игнорируя обновлённый env.

**Решение:**
1. В autouse-фикстуре теста очищать кеш:
   ```python
   @pytest.fixture(autouse=True)
   def reset_settings():
       from app.core.config import get_settings
       get_settings.cache_clear()
       yield
       get_settings.cache_clear()
   ```
2. Для доменных Settings — дополнительно `settings_registry.reset()` (см. п.11).
3. Если тест проверяет дефолты доменной модели — инстанцируй её напрямую, минуя `_load_from_env` (см. п.13).

**См. также:** `app/core/config.py::get_settings`, `app/core/settings_registry.py`.

---

### 20. Singleton-lock — приложение не стартует / зависший процесс

**Симптом:** при старте процесс падает с критичным логом `Не удалось захватить singleton-lock: ...` и `RuntimeError` в lifespan. Тело сообщения обычно `lock уже держит другой воркер pid=N host=...`.

**Причина:** `acquire_singleton_lock()` (`app/core/singleton_lock.py:38`) пишет строку в таблицу `{PREFIX}app_singleton_lock` с PK по `service_name`. Деплой допускает **ровно один** процесс приложения — это защищает in-process реестры (батчеры, `asyncio.Lock`'и сервисов, поллер шины) от двойной активации. При мягком shutdown lifespan делает DELETE строки (`release_singleton_lock`, `app/main.py:249-259`). При жёстком kill -9 / OOM-killer'е строка остаётся; следующий старт через `stale_ttl_sec` (`SECURITY__SINGLETON_LOCK_STALE_TTL_SEC`, default 60 сек) перезапишет её. Внутри окна TTL — старт упадёт.

**Что делать:**

1. Проверить, действительно ли есть второй живой процесс:
   ```bash
   ps -u <user> -f | grep "uvicorn\|app.main"
   ```

2. Если процесса нет — посмотреть в таблице singleton:
   ```sql
   SELECT service_name, pid, host, started_at,
          now() - started_at AS age
   FROM {SCHEMA}.{PREFIX}app_singleton_lock
   WHERE service_name = 'audit_workstation';
   ```

3. Если запись «зависла» (`age > 60 sec`) и реального процесса нет — можно дождаться авто-перезаписи (повторный старт через минуту пройдёт) либо ускорить очисткой вручную:
   ```sql
   DELETE FROM {SCHEMA}.{PREFIX}app_singleton_lock
   WHERE service_name = 'audit_workstation';
   ```

4. Если процесс действительно жив — найти его и остановить (`kill <pid>`); при корректном SIGTERM lifespan сам удалит строку.

**См. также:** `app/main.py:134-149` (захват), `app/main.py:249-259` (release), `app/core/singleton_lock.py` (`acquire_singleton_lock` — строка 38, `release_singleton_lock` — 124), [`operations-recovery.md`](operations-recovery.md) (полный playbook).

---

### 21. Записи в audit_log / metrics пропадают — что проверить

**Симптом:** ожидаемых записей нет в одной из таблиц: `audit_log` (acts), `chat_audit_log`, `http_metrics`, `chat_tool_metrics`, `access_denied_audit`.

**Причина:** все эти потоки идут через общий `MetricsBatcher` (`app/core/metrics_batcher.py`). При переполнении `max_buffer_size` (default 10000, либо переопределённое значение — например 5000 у `acts.audit_log_batcher`) батчер дропает старые записи с WARNING-логом (`Батчер ...: буфер переполнен, дропнуто N старых записей`). Также возможна более редкая причина — `flush_callback` стабильно падает (БД недоступна, нарушен CHECK), запись зависает в буфере и потом отбрасывается.

**Что делать:**

1. Получить состояние батчеров через diagnostics-endpoint (нужна роль `Админ`):
   ```bash
   curl -X GET "http://<host>:<port>/api/v1/admin/diagnostics" | jq
   ```

2. В ответе — два ключа: `batchers` и `background_tasks` (`app/core/observability_registry.py::get_all_statuses`). Смотреть `batchers.<имя>.dropped_count`. Если ≠ 0 — записи теряются. Также интересны `last_error` (текст последнего исключения flush'а) и `last_flush_ago_sec` (когда был последний успешный flush).

3. В логах найти строки `Батчер ...: буфер переполнен` (overflow) и `Батчер ...: flush_callback упал` (ошибка записи в БД). В overflow-логе `extra` содержит `batcher_name`, `dropped_now`, `dropped_count_total`.

4. Митигация:
   - При overflow — поднять `OBSERVABILITY__METRICS_MAX_BUFFER_SIZE` или `OBSERVABILITY__METRICS_BATCH_SIZE` (быстрее опустошение), либо уменьшить нагрузку, генерирующую события (имя видно в `batcher.name`).
   - При `last_error` — устранить корневую причину (например, CHECK constraint без mapping в `CHECK_CONSTRAINT_MESSAGES`).

**См. также:** `app/core/metrics_batcher.py::get_status`, `app/core/observability_registry.py`, `app/api/v1/endpoints/admin_diagnostics.py`, §9.5a / §9.5b в [`deploy-and-configuration.md`](../guides/deploy-and-configuration.md).

---

### 22. Старт падает: `must be owner of relation <bus-таблица>`

**Симптом:** при запуске приложения `RuntimeError: Не удалось инициализировать БД при старте: must be owner of relation <имя bus-таблицы>`. Воспроизводится, когда bus-таблица канала агента (`CHAT__AGENT_CHANNEL__TABLE_NAME`, схема `CHAT__AGENT_CHANNEL__SCHEMA_NAME`) уже создана внешней стороной (командой агента), а владелец — не учётка приложения.

**Причина:** `create_tables_if_not_exist` при наличии хотя бы одной отсутствующей таблицы домена исполнял **весь** schema.sql, включая `CREATE INDEX` (и `COMMENT ON`) на уже существующей чужой таблице. Эти операторы требуют владения таблицей — даже `CREATE INDEX IF NOT EXISTS` падает, если индекса ещё нет.

**Решение:** исправлено в адаптерах (`app/db/adapters/{base,greenplum,postgresql}.py`): операторы-«спутники» (`CREATE INDEX`, `COMMENT ON`) уже существующей таблицы пропускаются, если таблица объявлена в schema.sql **внешней** директивой `-- @external-table: <имя как в DDL>` (bus-таблица канала агента объявлена так в обеих схемах chat-домена). Спутники собственных существующих таблиц исполняются как раньше — иначе новый индекс из релиза молча не доезжал бы до развёрнутых стендов (дубликаты идемпотентны: `IF NOT EXISTS` на PG, перехват `DuplicateObjectError` на GP). `ALTER TABLE` исполняется всегда (путь эволюции собственных таблиц). При появлении новой внешней таблицы — добавь директиву рядом с её dev-имитацией. На старых версиях — митигация: попросить владельца создать индексы из schema.sql либо выдать ownership учётке приложения.

**См. также:** `DatabaseAdapter._external_tables_from_sql`, `DatabaseAdapter._companion_target_table`, `tests/db/test_adapters.py::TestSkipCompanionsForExistingTables`.

---

### 23. Redis недоступен: приложение не стартует / ошибки блокировок

**Симптом:** старт падает с `RuntimeError: Redis недоступен (<host>:<port>/<db>): ... Redis обязателен во всех окружениях — проверьте настройки REDIS__* в .env и что сервер запущен`. Либо приложение уже работает, но в логе идут WARNING'и вида «Redis недоступен при чтении кеша …», а захват/продление блокировки акта отдаёт 5xx.

**Причина:** Redis — обязательная инфраструктурная зависимость во всех окружениях (DEV = ПРОМ = тесты), подключается startup-хуком `auth.redis` (`app/auth/lifecycle.py:69`) по принципу fail-fast: без Redis приложение не стартует, `AUTH__ENABLED` на это не влияет. На Redis живут ОТП-коды и сессии авторизации, кэши (роли, user-контекст, счётчик непрочитанных уведомлений), блокировки актов (`lock:act:{id}`, `app/domains/acts/repositories/act_lock_backends.py:28`) и заявки LLM-моста (`llm:bridge:*`, п. 7).

**Поведение при сбое Redis уже после старта** — не режим работы, а авария; деградация разная по подсистемам:
- кэши — WARNING в лог + сквозной поход в SQL (запрос отрабатывает);
- мутации блокировок актов (захват / продление / снятие) — fail-closed, 5xx;
- чтение `is_locked` в списке актов — fail-open (`false` + WARNING);
- LLM через `redis-bridge` — `APIConnectionError`, дальше circuit breaker и fallback.

**Решение:**
1. `redis-cli -h <REDIS__HOST> -p <REDIS__PORT> PING` → `PONG`. На ПРОМе Redis — `10.110.10.38:7474`, db `0`.
2. На Windows/DEV `REDIS__HOST` должен быть **`127.0.0.1`**, а не `localhost`: resolve уходит в IPv6 `::1`, и redis-py не фолбэкает на IPv4.
3. Проверить блок `REDIS__*` в `.env` (`HOST`, `PORT`, `DB`, `PASSWORD`, `MAX_CONNECTIONS`, `SOCKET_TIMEOUT`) — сверить с `.env.prod` / `.env.dev`.
4. Требование к версии — Redis ≥ 7.0 (LLM-мост использует `XAUTOCLAIM` с 3-элементным ответом). ПРОМ и DEV — 7.0.15.

**См. также:** `app/core/redis.py`, `app/auth/lifecycle.py`, `docs/integrations/redis-llm-bridge.md`.
