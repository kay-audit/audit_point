# Audit Workstation

Рабочая станция аудитора — единая среда для проведения проверок. Включает конструктор актов, портал управления, AI-ассистента с function-calling, экспорт документов, интеграции с хранилищами данных (Hive/Greenplum) и плагинную архитектуру доменов для расширения функциональности.

## Требования

- **Python** 3.11+
- **PostgreSQL** 14+ (основная БД) или **Greenplum** 6+ (через Kerberos)
- **Redis** 7+ — **обязателен во всех окружениях** (ОТП-коды, JWT-сессии, кэши ролей и
  уведомлений, блокировки актов, транспорт LLM-моста). Без Redis приложение не стартует
  (fail-fast). На Windows поднимается в WSL — см. [redis-dev-wsl-guide.md](docs/guides/redis-dev-wsl-guide.md).
- **Kerberos** (`kinit`) — только при работе с Greenplum
- **Node.js** 18+ — только для E2E-набора Playwright

## Быстрый старт

### 1. Клонирование и установка зависимостей

```bash
git clone <repository-url>
cd "audit-workstation"
python -m venv .venv
source .venv/bin/activate   # Linux/Mac
# .venv\Scripts\activate    # Windows
pip install -r requirements.txt
```

Для разработки:

```bash
pip install -r requirements-dev.txt
```

### 2. Настройка окружения

Приложение читает единственный файл `.env` (он не коммитится). В репозитории лежат два
шаблона: `.env.dev` — локальная разработка (PostgreSQL, Redis в WSL, SMTP выключен),
`.env.prod` — ПРОМ (Greenplum, Redis на выделенном хосте, SMTP включён). Скопируйте нужный:

```bash
cp .env.dev .env
```

Минимальная конфигурация (PostgreSQL):

```env
DATABASE__TYPE=postgresql
DATABASE__HOST=localhost
DATABASE__PORT=5432
DATABASE__NAME=act_constructor
DATABASE__USER=postgres
DATABASE__PASSWORD=your_password
```

Redis — обязателен независимо от типа БД и от `AUTH__ENABLED`:

```env
REDIS__HOST=127.0.0.1
REDIS__PORT=6379
REDIS__DB=0
```

> `REDIS__HOST` на Windows — строго `127.0.0.1`: `localhost` резолвится в IPv6 `::1`,
> куда redis-py не фолбэкает (`app/core/config.py`, `RedisSettings.host`).

При работе с Greenplum:

```env
DATABASE__TYPE=greenplum
DATABASE__GP__HOST=gp_host
DATABASE__GP__PORT=5432
DATABASE__GP__DATABASE=capgp3
DATABASE__GP__SCHEMA=your_schema
DATABASE__TABLE_PREFIX=t_db_oarb_audit_act_
JUPYTERHUB_USER=22494524_local-dev
```

> При использовании Greenplum необходимо предварительно выполнить `kinit` для Kerberos-аутентификации.
> `JUPYTERHUB_USER` — имя в формате «цифры_суффикс»; из значения берутся только цифры до `_`.
> Они идут пользователем подключения к Greenplum (`app/db/connection.py`) и, при
> `AUTH__ENABLED=false`, задают локального пользователя тест-режима
> (`resolve_env_username` в `app/auth/context.py`). Имя переменной — историческое.

### 3. Запуск

**Режим разработки** (с горячей перезагрузкой):

```bash
python -m app.main
```

**Production** (через Uvicorn):

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8484
```

Порт берётся из `SERVER__PORT`: в `.env.dev` — `8000`, в `.env.prod` — `8484`
(E2E-харнесс Playwright поднимает свой uvicorn на `8005`).

Схема базы данных создается автоматически при первом запуске.

## Документация

Доки сгруппированы по папкам в [`docs/`](docs/). Начните с [developer-guide](docs/guides/developer-guide.md) — это хаб гайд-бука: обзор, быстрый старт и карта остальных частей.

### 📘 Guides — справочники и how-to

| Документ | О чём |
|---|---|
| [developer-guide.md](docs/guides/developer-guide.md) | **Хаб гайд-бука**: обзор проекта, быстрый старт, карта частей и смежных доков. |
| [architecture-and-backend.md](docs/guides/architecture-and-backend.md) | §2–§5, §14: слои и жизненный цикл, доменная плагин-система, структура backend-кода, REST-контракты. |
| [database.md](docs/guides/database.md) | §6: схема, адаптеры PG/GP, пул и исполнитель соединений, репозитории, миграции. |
| [ai-assistant.md](docs/guides/ai-assistant.md) | §7, §11: маршруты LLM, agent loop, ChatTool, внешний ИИ-агент, deep-dive по домену chat. |
| [testing.md](docs/guides/testing.md) | §8: стек, структура тестов, фикстуры сброса реестров, паттерны. |
| [deploy-and-configuration.md](docs/guides/deploy-and-configuration.md) | §9: запуск, авторизация, `.env`, полный реестр переменных окружения, observability. |
| [adding-chat-tool.md](docs/guides/adding-chat-tool.md) | Как добавить новый ChatTool (function-calling инструмент ассистента). |
| [agent-integration-iframe.md](docs/guides/agent-integration-iframe.md) | Встраивание стороннего агента в AW через iframe (пункт бокового меню, общая рамка портала); живой пример — домен `sqlagent`. |
| [agent-integration-inprocess.md](docs/guides/agent-integration-inprocess.md) | 🚧 Заглушка: план на полное слияние стороннего агента с AW (in-process, вместо iframe). |
| [chat-observability-and-feedback.md](docs/guides/chat-observability-and-feedback.md) | Наблюдаемость чата: метрики инструментов, аудит-лог, фидбек по сообщениям. |
| [redis-dev-wsl-guide.md](docs/guides/redis-dev-wsl-guide.md) | Redis для DEV на Windows через WSL: запуск, автостарт, диагностика. |

### 🏗️ Architecture — устройство системы

| Документ | О чём |
|---|---|
| [frontend-architecture.md](docs/architecture/frontend-architecture.md) | Фронт-архитектура: 3 зоны (shared/portal/constructor), ES-модули без бандлера, entry-модули, CSS. |
| [chat-frontend-architecture.md](docs/architecture/chat-frontend-architecture.md) | Deep-dive по фронту чата: ядерные модули, шина событий, транспорт POST + polling, режимы inline/modal/popup, client actions. |
| [textblock-editor-architecture.md](docs/architecture/textblock-editor-architecture.md) | Deep-dive по редактору текстблоков: капсулы ссылок/сносок, caret-guard, целостность капсул, поиск/замена, DOCX-экспорт. |
| [cross-domain-contracts.md](docs/architecture/cross-domain-contracts.md) | Межсервисные контракты: factory-registry, ChatTool, канал к внешнему агенту, URL-контракты. |
| [agent-channel-sequence.md](docs/architecture/agent-channel-sequence.md) | Sequence-диаграммы канала к внешнему ИИ-агенту: единая bus-таблица `chat_agent_messages_bus`, режимы `agent_mode`, poll-транспорт. |
| [data-model-acts.md](docs/architecture/data-model-acts.md) | Модель данных домена актов: таблицы, связи, дерево содержимого. |

### ⚙️ Operations — эксплуатация и деплой

| Документ | О чём |
|---|---|
| [deployment-runbook.md](docs/operations/deployment-runbook.md) | Пошаговый деплой на SDP (PostgreSQL / Greenplum), pre-deploy чек-лист, миграции. |
| [troubleshooting.md](docs/operations/troubleshooting.md) | Типовые проблемы и решения (Kerberos, GP-pool, Redis, 413, LLM, тесты, чат). |
| [operations-recovery.md](docs/operations/operations-recovery.md) | Восстановление после сбоев: зависшие forward-запросы, singleton-lock, батчеры. |
| [logging.md](docs/operations/logging.md) | Логирование: логгеры, `request_id`, JSON/text форматы, PII, файловый handler. |
| [agent-channel-production-checklist.md](docs/operations/agent-channel-production-checklist.md) | Прод-чек-лист канала к внешнему агенту: retention, sizing, мониторинг по `chat_agent_messages_bus.status`. |

### ✅ Testing — тестирование и ручной QA

| Документ | О чём |
|---|---|
| [retry-test-scenarios.md](docs/testing/retry-test-scenarios.md) | Retry-сценарии оркестратора LLM (что ретраится, что нет). |
| [manual-qa-agent-channel.md](docs/testing/manual-qa-agent-channel.md) | Ручная QA-проверка канала к внешнему ИИ-агенту (единая bus-таблица, poll-транспорт). |
| [manual-qa-frontend-unknown-block.md](docs/testing/manual-qa-frontend-unknown-block.md) | Ручная QA-проверка fallback для неизвестных типов блоков чата. |
| [manual-qa-risk-table-delete.md](docs/testing/manual-qa-risk-table-delete.md) | Ручная QA-проверка ограничений удаления risk-таблиц. |

### 🔌 Integrations / Migrations — SQL-стенды и миграции

| Документ | О чём |
|---|---|
| [integrations/redis-llm-bridge.md](docs/integrations/redis-llm-bridge.md) | Протокол и эксплуатация LLM-моста через Redis Streams (маршруты `redis-bridge,*`, воркер на DataLab). |
| [integrations/external-agent-imitation.sql](docs/integrations/external-agent-imitation.sql) | SQL-стенд для имитации внешнего ИИ-агента (ответы в bus-таблицу канала). |
| [integrations/agent-channel-cleanup.sql](docs/integrations/agent-channel-cleanup.sql) | Очистка завершённых строк bus-таблицы канала. |
| [integrations/agent-bus-redis-binding.md](docs/integrations/agent-bus-redis-binding.md) | 📝 Проект контракта: перенос шины внешнего агента с таблицы БД на Redis Streams. |
| [migrations/drop-all-tables.md](docs/migrations/drop-all-tables.md) | DROP всех таблиц приложения для пересоздания схемы (только dev). |
| [migrations/drop-reference-tables.md](docs/migrations/drop-reference-tables.md) | DROP справочных/ETL-таблиц (`t_db_oarb_ua_*`, `t_db_oarb_ck_*`), отдельно от таблиц приложения. |

## Конфигурация

Все настройки управляются через `.env` файл. Вложенные параметры используют `__` как разделитель.

| Группа | Переменные | Описание |
|--------|-----------|----------|
| Приложение | `APP_TITLE`, `APP_VERSION` | Метаданные (текущая версия — `14.0.0`) |
| Сервер | `SERVER__HOST`, `SERVER__PORT`, `SERVER__LOG_LEVEL`, `LOG_FORMAT` | Параметры HTTP-сервера и формат логов (`text` / `json`) |
| Авторизация | `AUTH__ENABLED`, `AUTH__JWT_SECRET`, `AUTH__JWT_ACCESS_TTL`, `AUTH__COOKIE_SECURE`, `AUTH__OTP_*` | Вход по ОТП-коду на e-mail + JWT. `AUTH__ENABLED=false` — тест-режим (username из `JUPYTERHUB_USER`) |
| База данных | `DATABASE__TYPE`, `DATABASE__HOST`, `DATABASE__PORT`, `DATABASE__NAME`, `DATABASE__USER`, `DATABASE__PASSWORD` | Подключение к БД |
| Пул соединений | `DATABASE__POOL_MIN_SIZE`, `DATABASE__POOL_MAX_SIZE`, `DATABASE__ACQUIRE_TIMEOUT`, `DATABASE__STRICT_ACQUIRE_GUARD` | Дефолт `1/2` — единый для DEV и ПРОМа (лимит соединений GP-учётки) |
| Префикс таблиц | `DATABASE__TABLE_PREFIX` | Общий префикс таблиц приложения для PG и GP (`t_db_oarb_audit_act_`) |
| Greenplum | `DATABASE__GP__HOST`, `DATABASE__GP__SCHEMA` | Настройки GP (при `DATABASE__TYPE=greenplum`) |
| Redis | `REDIS__HOST`, `REDIS__PORT`, `REDIS__DB`, `REDIS__PASSWORD` | Обязателен всегда: ОТП, сессии, кэши, локи актов, LLM-мост |
| Безопасность | `SECURITY__MAX_REQUEST_SIZE`, `SECURITY__RATE_LIMIT_PER_MINUTE`, `SECURITY__CSP_*`, `SECURITY__HSTS_*` | Лимиты запросов и security-заголовки |
| Наблюдаемость | `OBSERVABILITY__METRICS_BATCH_SIZE`, `OBSERVABILITY__METRICS_FLUSH_INTERVAL_SEC` | Батчинг записи метрик в БД |
| AI-чат: маршрут LLM | `CHAT__PROFILE`, `CHAT__MODEL`, `CHAT__API_BASE`, `CHAT__API_KEY` | Маршрут: `openai`, `gigachat`, `redis-bridge,openai`, `redis-bridge,gigachat`. Для `redis-bridge` `API_BASE`/`API_KEY` не нужны |
| AI-чат: fallback | `CHAT__FALLBACK_PROFILE`, `CHAT__FALLBACK_MODEL`, `CHAT__CIRCUIT_BREAKER_*`, `CHAT__HEALTH_PROBE__*` | Резервный маршрут, circuit breaker и фоновая проба primary |
| AI-чат: прочее | `CHAT__RETRY__*`, `CHAT__MAX_TOOL_ROUNDS`, `CHAT__MAX_FILE_SIZE`, `CHAT__TEXT_ACTIONS__*` | Retry, оркестрация, файлы, «Корректор» текста |
| Канал к внешнему ИИ-агенту | `CHAT__AGENT_CHANNEL__TABLE_NAME`, `CHAT__MAX_PARALLEL_STREAMS_PER_USER` | Имя bus-таблицы (задаётся целиком, без app-префикса) и лимит параллельных запросов к агенту |
| Блокировки | `ACTS__LOCK__DURATION_MINUTES`, `ACTS__LOCK__INACTIVITY_TIMEOUT_MINUTES` | Управление блокировками актов (живут на Redis-TTL) |
| Аудит-лог | `ACTS__AUDIT_LOG__RETENTION_DAYS`, `ACTS__AUDIT_LOG__MAX_DIFF_ELEMENTS` | Хранение логов и лимиты diff |
| Фактуры | `ACTS__INVOICE__HIVE_SCHEMA`, `ACTS__INVOICE__GP_SCHEMA` | Схемы для привязки фактур |
| Администрирование | `ADMIN__USER_DIRECTORY__*`, `ADMIN__DB_POOL_MONITOR__*` | Справочник пользователей, монитор пула БД |
| Уведомления | `NOTIFICATIONS__LIST_LIMIT`, `NOTIFICATIONS__RETENTION_DAYS`, `NOTIFICATIONS__EMAIL__*` | Центр уведомлений и SMTP (через него уходят ОТП-коды) |
| ЦК Фин.Рез. | `CK_FIN_RES__SCHEMA_NAME`, `CK_FIN_RES__*` | Таблицы и VIEW верификации FR |
| ЦК Клиентский опыт | `CK_CLIENT_EXP__SCHEMA_NAME`, `CK_CLIENT_EXP__*` | Таблицы и VIEW верификации CS |
| Справочные данные | `UA_DATA__*` | Словари процессов, ТБ, подразделений |
| SQL-агент | `SQLAGENT__ENABLED`, `SQLAGENT__SIDECAR_PORT`, `SQLAGENT__PUBLIC_URL` | Встраивание внешнего SQL-агента через iframe |

Полный список переменных — в файле [.env.prod](.env.prod) (для локальной разработки — [.env.dev](.env.dev)).

## Архитектура

3-уровневая архитектура с плагинной системой доменов и адаптерами для мультиБД.

```
Browser (vanilla JS)
    |
FastAPI Application
    ├── Shared API (auth/ОТП+JWT, system, roles, admin diagnostics)
    ├── Domain Plugin Registry
    │   ├── acts/ — CRUD, блокировки, содержимое, экспорт, фактуры, аудит-лог
    │   ├── admin/ — роли, справочник пользователей
    │   ├── chat/ — AI-ассистент (POST + polling, conversation persistence, function-calling, канал к внешнему агенту)
    │   ├── ck_*/ — верификация метрик (ck_fin_res, ck_client_exp)
    │   ├── notifications/ — центр уведомлений и e-mail (в т.ч. доставка ОТП-кодов)
    │   ├── sqlagent/ — встроенный через iframe внешний SQL-агент (Text-to-SQL)
    │   └── ua_data/ — справочные данные УА (словари процессов, ТБ, подразделений)
    ├── Redis (обязателен) — ОТП, сессии, кэши ролей/уведомлений, локи актов, LLM-мост
    └── Database Layer
        ├── asyncpg Connection Pool (соединение — на операцию, не на запрос)
        └── Adapters (PostgreSQL | Greenplum)
```

### Backend

- **FastAPI** — HTTP-фреймворк с автоматической OpenAPI документацией
- **asyncpg** — асинхронный драйвер PostgreSQL
- **redis** (redis-py, asyncio) — общая инфраструктура: ОТП, сессии, кэши, локи, LLM-мост
- **PyJWT** — access/refresh-токены авторизации
- **openai** — SDK для OpenAI-совместимых LLM-провайдеров
- **Pydantic** — валидация данных и настроек
- **python-docx** — генерация DOCX-документов

### Frontend

- **Vanilla JavaScript** (ES6+) — без фреймворков
- 3-зонная модульная архитектура: `shared/`, `portal/`, `constructor/`
- Jinja2-шаблоны с двумя независимыми базовыми шаблонами
- Чат-система: event-driven архитектура из 13 ядерных модулей в `shared/chat/` (EventBus, UI, Files, Context, Messages, Manager, Stream, Renderer, History, Modal, ClientActions, Feedback, Title) плюс региональный `ChatPopupManager` в `constructor/header/chat-popup.js`

### Структура проекта

```
app/
├── main.py                 — фабрика приложения, lifecycle
├── api/v1/                 — shared API эндпоинты (system, roles, admin diagnostics)
├── auth/                   — ОТП+JWT: роутер, middleware, JWT, сессии, аватары
├── core/                   — конфигурация, middleware, реестры, Redis-адаптер
├── db/                     — пул подключений, адаптеры, executor, базовый репозиторий
├── domains/
│   ├── acts/               — основной домен: акты проверок
│   │   ├── api/            — REST API (CRUD, содержимое, экспорт, фактуры, аудит-лог)
│   │   ├── services/       — бизнес-логика
│   │   ├── repositories/   — доступ к БД
│   │   ├── schemas/        — Pydantic-модели
│   │   ├── formatters/     — экспорт (TXT, MD, DOCX)
│   │   └── migrations/     — SQL-схемы (PostgreSQL, Greenplum)
│   ├── admin/              — администрирование (роли, справочник пользователей)
│   ├── chat/               — AI-ассистент (conversations, messages, files, actions)
│   ├── ck_fin_res/         — ЦК Финансовый результат (верификация метрик FR)
│   ├── ck_client_exp/      — ЦК Клиентский опыт (верификация метрик CS)
│   ├── notifications/      — центр уведомлений, e-mail (SMTP)
│   ├── sqlagent/           — страница со встроенным через iframe SQL-агентом
│   └── ua_data/            — справочники УА (процессы, ТБ, подразделения)
├── routes/                 — HTML-роуты портала и обработчики ошибок
├── schemas/                — общие модели (errors)
└── formatters/             — общие утилиты форматирования
scripts/
└── datalab/                — воркер LLM-моста (llm_redis_worker.ipynb) для Jupyter DataLab
static/
├── css/                    — модульные CSS (entry/ -> base/ + shared/ + zone/)
└── js/                     — модульный JS (shared/ + portal/ + constructor/)
    └── shared/chat/        — 13 ядерных модулей: event-bus, ui, files, context, messages, manager, stream, renderer, history, modal, client-actions, feedback, title
                              (региональный chat-popup.js лежит отдельно — в constructor/header/)
templates/
├── shared/                 — общие компоненты (chat, dialog, errors)
├── auth/                   — страница входа по ОТП-коду
├── portal/                 — портал (landing, acts-manager, admin, ЦК, sqlagent, профиль)
└── constructor/            — редактор актов
```

## Основные страницы

| URL | Описание |
|-----|----------|
| `/` | Главная страница (workspace) с AI-чатом |
| `/auth/login` | Вход по одноразовому коду, отправленному на рабочий e-mail |
| `/profile` | Профиль пользователя — ФИО, должность, e-mail, роли, аватар |
| `/acts` | Менеджер актов — карточки, создание (с autocomplete участников), дублирование, удаление |
| `/constructor?act_id=X` | Конструктор актов — двухшаговый редактор (структура + содержимое) |
| `/admin` | Панель администрирования — управление ролями и пользователями |
| `/ck-fin-res` | ЦК Фин.Рез. — верификация метрик финансового результата |
| `/ck-client-experience` | ЦК Клиентский опыт — верификация метрик клиентского опыта |
| `/sqlagent` | SQL-агент (Text-to-SQL) — интерфейс внешнего процесса во встроенном окне |

## API документация

Интерактивная документация доступна после запуска:

- **Swagger UI**: `http://<host>:<SERVER__PORT>/docs`
- **ReDoc**: `http://<host>:<SERVER__PORT>/redoc`

### Основные группы API

| Префикс | Описание |
|---------|----------|
| `/api/v1/auth/` | Авторизация: запрос и проверка ОТП-кода, refresh, logout, `/me`, аватар |
| `/api/v1/chat/` | AI-ассистент с function-calling, обратная связь, админ-аналитика |
| `/api/v1/system/` | Health check, версия |
| `/api/v1/roles/` | Роли текущего пользователя |
| `/api/v1/acts/` | CRUD актов, блокировки, метаданные |
| `/api/v1/acts/{id}/content` | Содержимое акта (дерево, таблицы, текстблоки, нарушения) |
| `/api/v1/acts/export/` | Экспорт и скачивание документов |
| `/api/v1/acts/invoice/` | Управление фактурами |
| `/api/v1/acts/{id}/audit-log` | Журнал операций и версии содержимого |
| `/api/v1/acts/users/` | Поиск пользователей для аудиторской группы |
| `/api/v1/admin/` | Управление ролями и пользователями |
| `/api/v1/admin/diagnostics/` | Диагностика рантайма (только для админа) |
| `/api/v1/notifications/` | Центр уведомлений |
| `/api/v1/ck-fin-res/` | ЦК Фин.Рез. — CRUD записей FR-валидации, справочники |
| `/api/v1/ck-client-exp/` | ЦК Клиентский опыт — CRUD записей CS-валидации, справочники |

## Тестирование

### Backend (pytest)

```bash
pytest
```

Тесты используют `pytest` + `pytest-asyncio` + `httpx` (для тестирования FastAPI).
Реального Redis для pytest не нужно: глобальная autouse-фикстура в
`tests/conftest.py` подставляет `fakeredis` в модульный синглтон адаптера.

### Frontend-юниты (node:test)

```bash
npm run test:js
```

### E2E (Playwright)

Браузерный smoke-набор для фронта (vanilla JS без бандлера). Поднимает
локальный uvicorn на `127.0.0.1:8005`, применяет seed-данные через
`tests/playwright/seed.py` и гоняет сценарии в headless Chromium.

```bash
# Однократная установка
npm install
npx playwright install chromium

# Прогон
npm run e2e

# С UI-режимом / отладкой
npm run e2e:ui
npm run e2e:debug

# HTML-отчёт после прогона
npx playwright test --reporter=html && npm run e2e:report
```

Требования:

- Локальный PostgreSQL с параметрами из `.env` (`DATABASE__HOST`, `__PORT`,
  `__USER`, `__PASSWORD`, `__NAME`, `__TABLE_PREFIX`). Перед каждым прогоном
  seed-скрипт удаляет акты с ID `999001`/`999002`/`999003` и пересоздаёт их.
- Живой Redis: global-setup делает `PING`, переключается на **db 15** и чистит её
  (`FLUSHDB`). Без Redis прогон падает с подсказкой на
  [redis-dev-wsl-guide.md](docs/guides/redis-dev-wsl-guide.md).
- Чистый порт 8005 — uvicorn запускается на нём.
- Setup переопределяет окружение: `AUTH__ENABLED=false` (тест-режим),
  `JUPYTERHUB_USER=22494524_e2e-test` (из digits извлекается `22494524` — admin
  из дефолтного `.env`), `REDIS__DB=15`, `SECURITY__RATE_LIMIT_PER_MINUTE=100000`.

Структура:

- `playwright.config.ts` — конфиг, baseURL=`http://127.0.0.1:8005`; два проекта:
  `chromium` и `chromium-scrollbars`. Второй нужен спеке `27-preview-fit-stability`
  (`ignoreDefaultArgs: ['--hide-scrollbars']`): ей нужен нативный скроллбар,
  занимающий место в layout, иначе воспроизводимая ею петля «скроллбар ↔ масштаб»
  не возникает. `npm run e2e` гоняет оба; `--project=chromium` молча пропустит спеку 27.
- `tests/playwright/global-setup.ts` / `global-teardown.ts` — старт/стоп uvicorn,
  PID хранится в `tests/playwright/.uvicorn.pid`, лог в `.uvicorn.log` (gitignored).
- `tests/playwright/seed.py` — создаёт 3 акта (`SEED_ACTS` в `fixtures.ts`).
- `tests/playwright/fixtures.ts` — общие helpers (`openAct`, `waitForSaveComplete`).
- `tests/playwright/specs/*.spec.ts` — 35 spec-файлов (`@smoke`-теги).

Скип-семантика: 6 spec-файлов несут условный `test.skip`, гейтящийся
переменной окружения (`RUN_<NAME>_E2E=1`) — по умолчанию пропускаются, т.к.
требуют явно поднятого харнесса (uvicorn + засиженная БД) сверх обычного
global-setup. Не TODO/недоделанность — включаются вручную для точечного
прогона. Остальные сценарии активны без условий.

## Деплой

Приложение разворачивается standalone — `uvicorn app.main:app`, доступ по `IP:порту`
(прод — SDP-кластер, обычный HTTP без TLS-терминирующего прокси; поэтому
`AUTH__COOKIE_SECURE=false`). Один Python-процесс: параллельный запуск защищён
singleton-lock'ом в БД. Пошаговый чек-лист — в
[deployment-runbook.md](docs/operations/deployment-runbook.md).

Для варианта «за reverse proxy» есть `HTTPSRedirectMiddleware`: он поднимает схему
запроса до `https`, если прокси прислал `X-Forwarded-Proto: https` — иначе HSTS не
выставился бы.

### Middleware

Порядок «луковицы» снаружи внутрь (`app/main.py`):

1. **HTTPSRedirect** — правит `scope.scheme` по `X-Forwarded-Proto`
2. **RequestId** — `X-Request-ID` на каждом ответе, включая отбитые лимитами
3. **SecurityHeaders** — CSP с per-request nonce, HSTS, X-Frame-Options, Permissions-Policy
4. **RequestSizeLimit** — ограничение размера запроса (по умолчанию 10 МБ)
5. **RateLimit** — по умолчанию 1024 запросов/мин на IP
6. **HttpMetrics** — запись HTTP-метрик в БД (включается `ADMIN__HTTP_METRICS_ENABLED`)
7. **Auth** — самый внутренний: ОТП/JWT-сессии, редирект анонима на `/auth/login`
