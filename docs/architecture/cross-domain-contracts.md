# Cross-domain контракты

Документ описывает **скрытые контракты между доменами**: какие имена,
поля и форматы захардкожены так, что переименование в одном месте
ломает другой домен. Полезно перед рефакторингом — пробежать по
таблице и понять, что переименование `X` потребует синхронной правки
`Y`, `Z` и фронта.

См. также:
- `app/core/domain_registry.py` — реестр доменов и фабрик
- `app/core/chat/names.py` — централизованные имена ChatTool и client-actions
- [`docs/guides/developer-guide.md`](../guides/developer-guide.md) — детальное описание архитектуры и паттернов

---

## 1. Принципы изоляции

Между доменами **нет прямых импортов реализаций**:

```bash
$ grep -rn "from app.domains.\(acts\|admin\|ck_\|ua_data\)" app/domains/chat
# пусто

$ grep -rn "from app.domains.acts" app/domains/admin
# пусто
```

**Единственное легальное исключение — импорт Protocol-интерфейса.**
ЦК-домены импортируют `IDictionaryRepository` из
`app/domains/ua_data/interfaces.py` (`ck_fin_res/deps.py:17`,
`ck_fin_res/services/fr_validation_service.py:19`, и зеркально в
`ck_client_exp`) — это тип, а не реализация: сам объект приходит через
фабрику `ua_data.dictionary_repository` (§2.5). Модуль `interfaces.py`
сознательно не тянет за собой репозитории/сервисы ua_data.

Связь идёт через **2 механизма**:

1. **`domain_registry.register_factory(key, factory)`** — DI-реестр
   фабрик. Домен X регистрирует «как мне получить компонент Y», другой
   домен берёт фабрику по ключу `f"{producer_domain}.{component}"`.
2. **`ChatTool`-реестр** — каждый домен регистрирует свои tools через
   `DomainDescriptor.chat_tools`. Чат не знает о них в compile-time;
   `register_tools(...)` собирает всё в один реестр при старте.

---

## 2. Контракты factory-registry

### 2.1. `admin.user_directory` — справочник пользователей

| Аспект | Значение |
|---|---|
| **Регистрирует** | `app/domains/admin/_lifecycle.py` (или `__init__.py::_build_domain`) |
| **Использует** | `app/domains/acts/deps.py::get_users_repository` (`get_factory("admin.user_directory")()`) |
| **Контракт** | Обычный callable без аргументов, возвращает `UserDirectoryRepository` на исполнителе БД (`get_executor()`, см. [`database.md §6.3a`](../guides/database.md#63a-исполнитель-бд-connection-per-operation)) с методом `get_user(username: str) -> UserInfo` |
| **Что сломается** | Удаление/переименование ключа → `acts` потеряет атрибуцию авторов актов. `RuntimeError: factory 'admin.user_directory' not registered` на старте. Чат **не затронут** (не использует) |

### 2.2. `ua_data.invoice_table_names` — реестр Hive-таблиц

| Аспект | Значение |
|---|---|
| **Регистрирует** | `app/domains/ua_data/_lifecycle.py` |
| **Использует** | `app/domains/acts/deps.py::get_invoice_service` (`get_factory("ua_data.invoice_table_names")()`) |
| **Контракт** | Фабрика возвращает callable, который при вызове отдаёт список имён таблиц для проверки фактур |
| **Что сломается** | `acts` не сможет валидировать фактуры. Workflow создания/обновления фактур упадёт |

### 2.3. `admin.user_avatars` — фото профиля

| Аспект | Значение |
|---|---|
| **Регистрирует** | `app/domains/admin/_lifecycle.py::register_factories` (`_user_avatars_factory`) |
| **Использует** | `app/auth/router.py::get_avatar_repository` (эндпоинты `POST`/`DELETE /avatar`, `GET /avatar/{username}`) и `_read_avatar_version` (`GET /me`) |
| **Контракт** | Обычный callable без аргументов, возвращает `UserAvatarRepository` на исполнителе БД — соединение берётся из пула на время каждой операции, не на время фабрики |
| **Что сломается** | `RuntimeError: factory 'admin.user_avatars' not registered` при загрузке/чтении/удалении фото. Исключение — `/me`: `_read_avatar_version` мягко проверяет `has_factory` и при его отсутствии просто отдаёт «фото нет», не падает (нужно для минимального приложения в тестах и для отключённого admin-домена) |

### 2.4. `notifications.push` — эмиссия персистентных уведомлений

| Аспект | Значение |
|---|---|
| **Регистрирует** | `app/domains/notifications/_lifecycle.py::register_factories` (`_push_factory`) |
| **Использует** | `app/core/notifications_emit.py::push_notification` — общая точка входа для продьюсеров (домены `acts`, `chat`) |
| **Контракт** | Обычный callable без аргументов, возвращает `NotificationService` на исполнителе БД. Продьюсеры зовут фабрику и `await svc.push(...)` напрямую, без `async for`/`aclosing` |
| **Что сломается** | `has_factory`-guard в `push_notification` — отсутствие домена `notifications` не ломает продьюсеров: уведомление молча не отправится, в лог уйдёт warning |

### 2.5. `ua_data.dictionary_repository` — справочники ua_data для ЦК-доменов

| Аспект | Значение |
|---|---|
| **Регистрирует** | `app/domains/ua_data/_lifecycle.py:43` (`_dictionary_repository_factory`) |
| **Использует** | `app/domains/ck_fin_res/deps.py:30` и `app/domains/ck_client_exp/deps.py:30` — `get_factory("ua_data.dictionary_repository")(ex)` |
| **Контракт** | **Единственная фабрика реестра, принимающая аргумент**: callable `(conn) -> DictionaryRepository`, где `conn` — исполнитель БД (`get_executor()`). Потребители типизируют результат Protocol'ом `IDictionaryRepository` |
| **Что сломается** | Оба ЦК-домена (`ck_fin_res`, `ck_client_exp`) не соберут свои сервисы верификации — `RuntimeError` на построении зависимости запроса |

### 2.6. `admin.http_metrics_service` — HTTP-метрики для core

| Аспект | Значение |
|---|---|
| **Регистрирует** | `app/domains/admin/_lifecycle.py:60` (`_http_metrics_service_factory`) |
| **Использует** | `app/main.py:315` (middleware HTTP-метрик) |
| **Контракт** | Callable без аргументов; возвращает `HttpMetricsService` **либо `None`**, если `ADMIN__HTTP_METRICS_ENABLED=false`. Проверка флага инкапсулирована в фабрике — core не импортирует `AdminSettings` |
| **Что сломается** | Core начнёт зависеть от `admin.settings`/`admin.deps` напрямую; при удалении ключа — метрики HTTP не собираются |

### 2.7. `admin.access_denied_audit` — запись отказов доступа

| Аспект | Значение |
|---|---|
| **Регистрирует** | `app/domains/admin/_lifecycle.py:101` (`_access_denied_audit_factory`) |
| **Использует** | `app/api/v1/deps/role_deps.py:207` (`require_domain_access` при 403) |
| **Контракт** | Callable без аргументов, возвращает **async-функцию** `(*, username, domain, path, method, reason) -> bool`: `True` — запись передана батчеру, `False` — батчер ещё не поднят (core логирует warning). Исключения батчера поглощаются внутри — 403-ответ не должен зависеть от аудита |
| **Что сломается** | `role_deps` (core) пришлось бы импортировать `AccessDeniedRecord` из admin напрямую — прямая зависимость core → домен |

Сосед по реестру того же домена, `notifications.email`
(`_email_factory` в `notifications/_lifecycle.py`, потребитель —
`app/auth/router.py::request_otp`), — **исключение из этого паттерна**: фабрика
остаётся async-генератором (`async for svc in factory():`), потому что
email-сервису соединение БД не нужно, а отправка письма занимает до
30 секунд — держать это время объект исполнителя не должен. Не путать
форму двух соседних фабрик одного домена.

---

## 3. Контракты `ChatTool` (через `app/core/chat/names.py`)

Все имена централизованы в `names.py`. **Переименование константы =
синхронное изменение во всех потребителях**, иначе runtime-warning
«ChatTool не зарегистрирован» (силент failure: LLM просто не получит tool).

**Имя, которое видит LLM, — не то же самое, что имя в контрактах ниже.**
В таблицах этого раздела и в `action_id` кнопок внешнего агента имя
**каноническое**, с точкой (`acts.open_act_page`). Провайдеру же уходит
**проводное** имя — точка заменена подчёркиванием (`acts_open_act_page`),
потому что Anthropic-модели валидируют имя tool'а по спеке OpenAI строго.
Перевод в обе стороны — `to_wire_name` / `resolve_wire_name` в
`app/core/chat/tools.py`; контракт с внешним агентом от этого не меняется.
Детали — dev-guide §7.1a.

### 3.1. `chat.forward_to_knowledge_agent` — tool форварда в адаптивном режиме

| Аспект | Значение |
|---|---|
| **Константа** | `TOOL_FORWARD_TO_KNOWLEDGE_AGENT` (`names.py:17`, значение `"chat.forward_to_knowledge_agent"`) |
| **Создаётся в** | `app/domains/chat/services/forward_tool_factory.py::build_forward_tool_descriptor()` — **только СХЕМА** тула (`handler=None`, `per_request_handler=True`, `category="forward"`); параметры `question` (обяз.) и `kb_hint` (опц.). Регистрируется статически при `discover_domains()` |
| **Кто исполняет** | Не handler, а `agent_loop` — **по имени тула**: перехватывает вызов, пишет вопрос в шину `chat_agent_messages_bus` и отдаёт дозаполнение поллеру |
| **Когда доступен LLM** | Только в `agent_mode='adaptive'` — оркестратор сам решает форвардить вопрос внешнему агенту. В `agent_mode='always'` LLM минуется: вопрос пишется в шину напрямую (`AgentChannelService.submit`). В `agent_mode='off'` tool скрыт |
| **Контракт** | Имя tool'а должно совпадать с константой во всех потребителях. Если переименовать — `agent_loop` перестанет распознавать вызов по имени, адаптивный форвард молча не сработает |

### 3.2. `acts.open_act_page` (и аналогичные `open_*_page` tools)

| Аспект | Значение |
|---|---|
| **Константа** | `TOOL_OPEN_ACT_PAGE` (`names.py:20`) и аналогичные `TOOL_OPEN_ADMIN_PANEL`, `TOOL_OPEN_CK_FIN_RES_PAGE`, `TOOL_OPEN_CK_CLIENT_EXP_PAGE` |
| **Handler** | `app/domains/acts/integrations/action_handlers.py:81::open_act_page_handler` |
| **Параметры** | Оба опциональны, но нужен хотя бы один: `km_number` (формат `КМ-XX-XXXXX`) и `sz_number` (номер служебной записки). Нераспознанный формат КМ **не** ошибка: `KMUtils.extract_km_digits` кидает — handler логирует warning и ищет по точному совпадению строки `km_number` |
| **Возвращает** | Ровно один акт → JSON ClientActionBlock `{action: "open_url", params: {url: "/constructor?act_id=<int>"}, ...}`. Несколько → **текст** со списком кандидатов и просьбой уточнить. Ноль либо ни одного параметра → **текст** с пояснением. ErrorBlock этот handler не возвращает |
| **Что сломается** | Переименование `km_number`/`sz_number` → LLM перестанет вызывать tool правильно (названия параметров — часть LLM-описания). Изменение URL-формата → фронтовый `resolveProxyUrl` соберёт неверный адрес |

### 3.3. `admin.open_admin_panel` и тулы доменов ЦК

Тот же шаблон что и `acts.open_act_page`: action-tool с client_action.
Имена в `names.py`, handler'ы в `<domain>/integrations/action_handlers.py`,
бутон-транслейтор для кнопок от внешнего агента.

---

## 4. Контракты client-actions (Python ↔ JavaScript)

| Action | Python whitelist | JS handler |
|---|---|---|
| `open_url` | `app/core/chat/blocks.py:ALLOWED_CLIENT_ACTIONS` | `static/js/shared/chat/chat-client-actions.js` |
| `notify` | то же | то же |
| `trigger_sdk` | то же | то же |

**Синхронизация ручная** — фронт не импортирует Python.

| Что сломается | Симптом |
|---|---|
| Action добавлен в Python whitelist, но забыт во фронте | блок придёт в ответе сообщения, но handler'а нет → `console.warn('ClientActionsRegistry: неизвестная команда X')` |
| Action добавлен во фронт, но забыт в Python whitelist | Pydantic-валидация `ClientActionBlock` отвергнет блок на парсинге → exception в orchestrator |

---

## 5. Контракт `block_id` для `ClientActionBlock`

| Аспект | Значение |
|---|---|
| **Формат** | `f"{message_id}:client_action:{i}"` (детерминированный, нумерация через `BlockIdGenerator`) |
| **Генерируется в** | `Orchestrator._parse_client_action_result` (`orchestrator.py:511`; вызывается из `agent_loop.py`). Per-message экземпляр `BlockIdGenerator` (`app/core/chat/block_id_generator.py`) — единый per-type счётчик (`gen.next("client_action")` → `…:client_action:0`, `…:1`), общий для всех источников эмиссии внутри одного сообщения |
| **Используется на фронте** | `chat-client-actions.js::executeBlock` — Set исполненных id в `sessionStorage` под ключом `chat:executedActions` |
| **Что сломается, если изменить формат** | Фронт перестанет распознавать «уже исполненный» при reload вкладки → бесконечный redirect-цикл (action `open_url` будет каждый раз заново переходить по URL). Подробнее — [`ai-assistant.md §7.9`](../guides/ai-assistant.md#79-action-handlers-и-clientactionblock) |

**`block_id` блоков из ответа внешнего агента** (форвард через шину `chat_agent_messages_bus`):
- Формат задаётся в `map_answer_to_blocks` (модульная функция в `agent_channel.py`, не метод сервиса): кнопки — `f"{row['id']}:btn:0"`, reasoning — `f"{row['id']}:reasoning:0"`, где `row['id']` — uid строки-ответа в шине.
- `map_answer_to_blocks` мапит ответ агента в блоки в порядке: reasoning (из `metadata.reasoning`, legacy `thinking`) → text → buttons → media (image/file; готовые блоки от `materialize_media_entries`, собранные `poll_once` на финализации — см. `chat-files-data-requirements.md §6.3.1`). Error-блока эта функция **не** производит: ошибочные исходы закрывает `poll_once` через `MessageRepository.mark_failed` с отдельно собранным error-блоком.
- Клиентские действия в этом пути не эмитятся напрямую: `action_id` кнопок транслируются в `open_url` через `button_translator.translate_buttons` (вызов — в `AgentChannelService.poll_once`, до маппинга в блоки).
- Используется: `ClientActionsRegistry.executeBlock` дедупит исполнённые client-action по `block_id` (см. §5 выше). Стабильность формата важна, чтобы повторный поллинг GET /messages не создавал дублей кнопок.

---

## 6. Транспортный контракт (POST + poll, без SSE)

SSE в чате нет. Транспорт единый для всех режимов:

1. **POST** `/api/v1/chat/conversations/{cid}/messages` (FormData: `message`,
   `domains`, `agent_mode`, `files`) — всегда отдаёт JSON `{"message_id": ...}`.
2. Фронт **поллит** **GET** `/api/v1/chat/conversations/{cid}/messages/{message_id}`
   до терминального статуса сообщения и рендерит ответ **целиком** с
   декоративным «эффектом печати» (токен-стриминга нет).

| `agent_mode` | Поведение бэка |
|---|---|
| `off` | Локальный LLM-провайдер (маршрут `CHAT__PROFILE`) исполняется синхронно в POST через `orchestrator.run(...)`; forward-tool скрыт от LLM |
| `adaptive` | `orchestrator.run(...)` синхронно; forward-tool доступен LLM, оркестратор сам решает форвардить через шину `chat_agent_messages_bus` |
| `always` | Прямой проброс в агента: `AgentChannelService.submit` пишет вопрос в шину + черновик `chat_messages` (status='streaming'), LLM минуется |

**Форвард-путь (adaptive/always)**: `AgentChannelService.submit` создаёт
черновик ассистент-сообщения (`status='streaming'`, `agent_ref` = uid вопроса
в шине) и запись вопроса в `chat_agent_messages_bus`; фоновый `AgentChannelPoller`
(`agent_channel_poller.py`) поллит шину adaptive-backoff'ом без удержания
коннекта в sleep; `AgentChannelService.poll_once` дозаполняет reasoning-блок
инкрементально и финализирует черновик (`complete`/`failed`),
`mark_timeout` закрывает зависший запрос (`build_timeout_error_block`).

| Контракт | Где |
|---|---|
| Шина агента | таблица `chat_agent_messages_bus` (см. §10) |
| Лимит параллельных запросов | `AgentMessageRepository.count_active_for_user` ≥ `CHAT__MAX_PARALLEL_STREAMS_PER_USER` (default 3) → `ChatLimitError` (HTTP 422) до записей в БД |
| Фоновый хук поллера | `chat.agent_channel_poller` (наряду с `chat.tool_metrics_batcher`, `chat.audit_log_batcher`) |
| Настройки канала | `AgentChannelSettings` (`app/domains/chat/settings.py:22`), env-префикс `CHAT__AGENT_CHANNEL__` (`TABLE_NAME=chat_agent_messages_bus`, `SCHEMA_NAME=""` — пусто → схема домена чата, затем основная схема адаптера, `POLL_MIN_INTERVAL_SEC=2.0`, `POLL_MAX_INTERVAL_SEC=10.0`, `POLL_BACKOFF_MULTIPLIER=1.5`, `CLAIM_TIMEOUT_SEC=1800`, `ANSWER_TIMEOUT_SEC=1800`, `MAX_BLOCK_TEXT_SIZE=262144`) |

---

## 7. URL-контракты бэк ↔ фронт

Бэк отдаёт **относительные** пути; абсолютный адрес собирает фронт — единой
точкой `AppConfig.api.getUrl(endpoint)` (для client-action `open_url` — через
`resolveProxyUrl`, который делегирует туда же).

| Что | Где захардкожено | Что нельзя |
|---|---|---|
| Открытие страницы акта | `acts.open_act_page` handler возвращает `/constructor?act_id=<int>` | НЕ возвращать абсолютный URL `http://...` — он пройдёт мимо сборки адреса на фронте |
| Открытие админ-панели | `admin.open_admin_panel` → `/admin` | то же |
| API fetch от фронта | `chat-stream.js`, любые `fetch(...)` | Обязательно через `AppConfig.api.getUrl(endpoint)` + реестр `AppConfig.chatEndpoints`; литеральный `/api/v1/...` в callsite — рефакторинг-запах |

Подробнее — [`ai-assistant.md §7.9`](../guides/ai-assistant.md#79-action-handlers-и-clientactionblock)
(client-action `open_url`) и
[`chat-frontend-architecture.md`](chat-frontend-architecture.md) («Единая точка
сборки URL: `AppConfig.api.getUrl`»).

---

## 8. Регрессионные тесты (где проверяется)

| Контракт | Тест |
|---|---|
| `block_id` детерминизм для ClientAction | `tests/domains/chat/test_block_id_determinism.py` |
| Мапинг ответа агента в блоки, finalize/timeout | `tests/domains/chat/test_agent_channel.py` |
| Поллер шины (subscribe/tick/reconcile) | `tests/domains/chat/test_agent_channel_poller.py` |
| Лимит параллельных запросов в шину | `tests/domains/chat/test_agent_message_repository.py` |
| GP UNIQUE / PK правило | `tests/test_gp_compatibility.py::test_distributed_by_subset_of_primary_key` |
| Whitelist client-actions | `tests/core/test_chat_blocks.py` |

---

## 9. Checklist для рефакторинга «переименовать X»

Прежде чем переименовать имя tool'а / action / поле в `*Handler` / FK:

1. **`grep -r "<old_name>" app/ tests/ static/`** — увидеть всех потребителей.
2. Если есть совпадения в `static/` — синхронно править frontend.
3. Если совпадение в `app/domains/<other>/` — перепроверить, что
   используется через `register_factory` или `ChatTool`-реестр, а не
   прямым импортом. Прямой импорт между доменами — баг.
4. Запустить полный тест-сет: `pytest tests/ -q`.
5. Поднять локально, проверить:
   - LLM может вызвать переименованный tool (если description совместимо)
   - Кнопки от внешнего агента не сломались (`button_translator`)
   - Client-action откликается на новом имени

---

## 10. Контракт шины `chat_agent_messages_bus` (приложение ↔ внешний ИИ-агент)

Единая bus-таблица — единственный канал к внешнему агенту. **Структуру задаёт
и таблицей владеет сторона агента**; наша миграция — dev-имитация её фактической
структуры. Polling-only, постоянных соединений нет. SQL-стенд имитации агента —
[`docs/integrations/external-agent-imitation.sql`](../integrations/external-agent-imitation.sql).

| Колонка | Тип | Назначение |
|---|---|---|
| `id` | UUID | uid одного сообщения шины (его же хранит `chat_messages.agent_ref`) |
| `chat_id` | TEXT | uid треда (= `chat_messages.conversation_id`); отдельной `conversation_id` в шине НЕТ |
| `user_id` | TEXT | автор |
| `role` | TEXT | `user`/`assistant`/`system`/`tool` (CHECK владельца); `system`/`tool` приложением не обрабатываются (`tool` — служебные сообщения цикла агента) |
| `content` | TEXT | текст (NOT NULL) |
| `media`, `metadata`, `buttons` | JSONB | вложения, служебные данные (`metadata.reasoning` → reasoning, legacy `thinking`), кнопки |
| `reply_to` | UUID | ссылка на id вопроса; агент проставляет его **на строке-ответе** — сигнал «ответ готов» |
| `status` | TEXT | `pending`/`processing`/`completed`/`failed`/`error` (CHECK владельца, NanoBot 2.3) — записи статуса от AW best-effort. `error` — повторяемая ошибка (агент переобрабатывает вопрос, удалив строку-ответ); терминален только `failed` |
| `created_at`, `updated_at` | TIMESTAMPTZ | NOT NULL; у владельца есть DEFAULT'ы, но AW не полагается и передаёт явно |

**GP**: без PK (у владельца `id` nullable), `WITH (appendonly=false) DISTRIBUTED BY (chat_id)`
плюс отдельный `CREATE INDEX idx_{BUS_TABLE}_id ON …(id)`
(`app/domains/chat/migrations/greenplum/schema.sql:120-142`).

**Имя и схема в миграции — плейсхолдеры `{BUS_SCHEMA_Q}{BUS_TABLE}`**, без
`{PREFIX}`: app-префикс к шине не клеится, имя задаётся
`CHAT__AGENT_CHANNEL__TABLE_NAME` целиком, схема — `…__SCHEMA_NAME`.
DDL помечен директивой адаптеру `-- @external-table: {BUS_SCHEMA_Q}{BUS_TABLE}`:
если таблицу уже создал владелец, её «спутники» (`CREATE INDEX`, `COMMENT ON`)
пропускаются.

**Связь с `chat_messages`**: `chat_messages.agent_ref` VARCHAR(36) — ссылка из
черновика ассистент-сообщения на uid вопроса в шине. Поток submit → poller →
`poll_once` описан в §6.

| Что сломается | Симптом |
|---|---|
| Переименование таблицы без правки `CHAT__AGENT_CHANNEL__TABLE_NAME` | поллер и `AgentChannelService` не найдут шину |
| Владелец сменил словарь `status` CHECK | запись статуса от AW отклонится — `_set_status_safe` залогирует warning и пропустит; финализация не пострадает |
