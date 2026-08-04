# Audit Workstation

Рабочая станция аудитора — единая среда для проведения проверок. Включает конструктор актов, портал управления, AI-ассистента с function-calling, экспорт документов, интеграции с хранилищами данных (Hive/Greenplum) и плагинную архитектуру доменов для расширения функциональности.

## Требования

- **Python** 3.11+
- **PostgreSQL** 14+ (основная БД) или **Greenplum** 6+ (через Kerberos)
- **Kerberos** (`kinit`) — только при работе с Greenplum

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

Скопируйте файл конфигурации и заполните значения:

```bash
cp .env.example .env
```

Минимальная конфигурация (PostgreSQL):

```env
DATABASE__TYPE=postgresql
DATABASE__HOST=localhost
DATABASE__PORT=5432
DATABASE__NAME=audit_workstation
DATABASE__USER=postgres
DATABASE__PASSWORD=your_password
```

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
> `JUPYTERHUB_USER` — имя пользователя в формате «цифры_суффикс»; из значения извлекаются только цифры — они идут как PostgreSQL user под Greenplum.

### 3. Запуск

**Режим разработки** (с горячей перезагрузкой):

```bash
python -m app.main
```

**Production** (через Uvicorn):

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8005
```

Приложение будет доступно по адресу `http://localhost:8005` (порт берётся из `SERVER__PORT` в `.env`; в `.env.example` задан `8005`).

Схема базы данных создается автоматически при первом запуске.

## Документация

Доки сгруппированы по папкам в [`docs/`](docs/). Начните с [developer-guide](docs/guides/developer-guide.md) — это основной справочник.

### 📘 Guides — справочники и how-to

| Документ | О чём |
|---|---|
| [developer-guide.md](docs/guides/developer-guide.md) | Основной справочник: архитектура, домены, плагинная система, БД, миграции, тестирование, deploy, env-vars, deep-dive по чату. |
| [adding-chat-tool.md](docs/guides/adding-chat-tool.md) | Как добавить новый ChatTool (function-calling инструмент ассистента). |
| [agent-integration-iframe.md](docs/guides/agent-integration-iframe.md) | Встраивание стороннего агента в AW через iframe (пункт бокового меню, общая рамка портала); живой пример — домен `sqlagent`. |
| [agent-integration-inprocess.md](docs/guides/agent-integration-inprocess.md) | 🚧 Заглушка: план на полное слияние стороннего агента с AW (in-process, вместо iframe). |
| [chat-observability-and-feedback.md](docs/guides/chat-observability-and-feedback.md) | Наблюдаемость чата: метрики инструментов, аудит-лог, фидбек по сообщениям. |

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
| [deployment-runbook.md](docs/operations/deployment-runbook.md) | Пошаговый деплой (PostgreSQL / Greenplum / JupyterHub), pre-deploy чек-лист, миграции. |
| [troubleshooting.md](docs/operations/troubleshooting.md) | Типовые проблемы и решения (Kerberos, GP-pool, JupyterHub-proxy, 413, LLM, тесты, чат). |
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
| [integrations/external-agent-imitation.sql](docs/integrations/external-agent-imitation.sql) | SQL-стенд для имитации внешнего ИИ-агента (ответы в bus-таблицу `chat_agent_messages_bus`). |
| [integrations/agent-channel-cleanup.sql](docs/integrations/agent-channel-cleanup.sql) | Очистка завершённых строк bus-таблицы канала. |
| [migrations/drop-all-tables.md](docs/migrations/drop-all-tables.md) | DROP всех таблиц приложения для пересоздания схемы (только dev). |
| [migrations/drop-reference-tables.md](docs/migrations/drop-reference-tables.md) | DROP справочных/ETL-таблиц (`t_db_oarb_ua_*`, `t_db_oarb_ck_*`), отдельно от таблиц приложения. |

## Конфигурация

Все настройки управляются через `.env` файл. Вложенные параметры используют `__` как разделитель.

| Группа | Переменные | Описание |
|--------|-----------|----------|
| Приложение | `APP_TITLE`, `APP_VERSION` | Метаданные |
| Сервер | `SERVER__HOST`, `SERVER__PORT`, `SERVER__LOG_LEVEL` | Параметры HTTP-сервера |
| База данных | `DATABASE__TYPE`, `DATABASE__HOST`, `DATABASE__PORT`, `DATABASE__NAME`, `DATABASE__USER`, `DATABASE__PASSWORD` | Подключение к БД |
| Префикс таблиц | `DATABASE__TABLE_PREFIX` | Общий префикс таблиц приложения для PG и GP (`t_db_oarb_audit_act_`) |
| Greenplum | `DATABASE__GP__HOST`, `DATABASE__GP__SCHEMA` | Настройки GP (при `DATABASE__TYPE=greenplum`) |
| Безопасность | `SECURITY__MAX_REQUEST_SIZE`, `SECURITY__RATE_LIMIT_PER_MINUTE` | Лимиты запросов |
| AI-чат | `CHAT__API_BASE`, `CHAT__API_KEY`, `CHAT__MODEL` | OpenAI-совместимый LLM API (опционально) |
| Блокировки | `ACTS__LOCK__DURATION_MINUTES`, `ACTS__LOCK__INACTIVITY_TIMEOUT_MINUTES` | Управление блокировками актов |
| Аудит-лог | `ACTS__AUDIT_LOG__RETENTION_DAYS`, `ACTS__AUDIT_LOG__MAX_DIFF_ELEMENTS` | Хранение логов и лимиты diff |
| Фактуры | `ACTS__INVOICE__HIVE_SCHEMA`, `ACTS__INVOICE__GP_SCHEMA` | Схемы для привязки фактур |
| Администрирование | `ADMIN__USER_DIRECTORY__*` | Справочник пользователей |
| Канал к внешнему ИИ-агенту | `CHAT__AGENT_CHANNEL__TABLE_NAME`, `CHAT__MAX_PARALLEL_STREAMS_PER_USER` | Имя bus-таблицы (без app-префикса) и лимит параллельных запросов к агенту. Полный список — в `.env.example`. |
| ЦК Фин.Рез. | `CK_FIN_RES__SCHEMA_NAME`, `CK_FIN_RES__*` | Таблицы и VIEW верификации FR |
| ЦК Клиентский опыт | `CK_CLIENT_EXP__SCHEMA_NAME`, `CK_CLIENT_EXP__*` | Таблицы и VIEW верификации CS |
| Справочные данные | `UA_DATA__*` | Словари процессов, ТБ, подразделений |

Полный список переменных — в файле [.env.example](.env.example).

## Архитектура

3-уровневая архитектура с плагинной системой доменов и адаптерами для мультиБД.

```
Browser (vanilla JS)
    |
FastAPI Application
    ├── Shared API (auth, system, roles)
    ├── Domain Plugin Registry
    │   ├── acts/ — CRUD, блокировки, содержимое, экспорт, фактуры, аудит-лог
    │   ├── admin/ — роли, справочник пользователей
    │   ├── chat/ — AI-ассистент (POST + polling, conversation persistence, function-calling, канал к внешнему агенту)
    │   ├── ck_*/ — верификация метрик (ck_fin_res, ck_client_exp)
    │   └── ua_data/ — справочные данные УА (словари процессов, ТБ, подразделений)
    └── Database Layer
        ├── asyncpg Connection Pool
        └── Adapters (PostgreSQL | Greenplum)
```

### Backend

- **FastAPI** — HTTP-фреймворк с автоматической OpenAPI документацией
- **asyncpg** — асинхронный драйвер PostgreSQL
- **Pydantic** — валидация данных и настроек
- **python-docx** — генерация DOCX-документов

### Frontend

- **Vanilla JavaScript** (ES6+) — без фреймворков
- 3-зонная модульная архитектура: `shared/`, `portal/`, `constructor/`
- Jinja2-шаблоны с двумя независимыми базовыми шаблонами
- Чат-система: event-driven архитектура из 13 ядерных модулей в `shared/chat/` (EventBus, UI, Files, Context, Messages, Manager, Stream, Renderer, History, Modal, ClientActions, Feedback, Title) + региональный `ChatPopupManager` в `constructor/header/`

### Структура проекта

```
app/
├── main.py                 — фабрика приложения, lifecycle
├── api/v1/                 — shared API эндпоинты (auth, system, roles)
├── core/                   — конфигурация, middleware, реестры
├── db/                     — пул подключений, адаптеры, базовый репозиторий
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
│   └── ua_data/            — справочники УА (процессы, ТБ, подразделения)
├── schemas/                — общие модели (errors)
└── formatters/             — общие утилиты форматирования
static/
├── css/                    — модульные CSS (entry/ -> base/ + shared/ + zone/)
└── js/                     — модульный JS (shared/ + portal/ + constructor/)
    └── shared/chat/        — 13 ядерных модулей: event-bus, ui, files, context, messages, manager, stream, renderer, history, modal, client-actions, feedback, title
                              (12-й — constructor/header/chat-popup.js, региональный)
templates/
├── shared/                 — общие компоненты (chat, dialog, errors)
├── portal/                 — портал (landing, acts-manager)
└── constructor/            — редактор актов
```

## Основные страницы

| URL | Описание |
|-----|----------|
| `/` | Главная страница (workspace) с AI-чатом |
| `/acts` | Менеджер актов — карточки, создание (с autocomplete участников), дублирование, удаление |
| `/constructor?act_id=X` | Конструктор актов — двухшаговый редактор (структура + содержимое) |
| `/admin` | Панель администрирования — управление ролями и пользователями |
| `/ck-fin-res` | ЦК Фин.Рез. — верификация метрик финансового результата |
| `/ck-client-experience` | ЦК Клиентский опыт — верификация метрик клиентского опыта |

## API документация

Интерактивная документация доступна после запуска:

- **Swagger UI**: `http://localhost:8005/docs`
- **ReDoc**: `http://localhost:8005/redoc`

### Основные группы API

| Префикс | Описание |
|---------|----------|
| `/api/v1/auth/` | Авторизация (JupyterHub/Kerberos) |
| `/api/v1/chat/` | AI-ассистент с function-calling |
| `/api/v1/system/` | Health check, версия |
| `/api/v1/acts/` | CRUD актов, блокировки, метаданные |
| `/api/v1/acts/{id}/content` | Содержимое акта (дерево, таблицы, текстблоки, нарушения) |
| `/api/v1/acts/export/` | Экспорт и скачивание документов |
| `/api/v1/acts/invoice/` | Управление фактурами |
| `/api/v1/acts/{id}/audit-log` | Журнал операций и версии содержимого |
| `/api/v1/acts/users/` | Поиск пользователей для аудиторской группы |
| `/api/v1/admin/` | Управление ролями и пользователями |
| `/api/v1/ck-fin-res/` | ЦК Фин.Рез. — CRUD записей FR-валидации, справочники |
| `/api/v1/ck-client-exp/` | ЦК Клиентский опыт — CRUD записей CS-валидации, справочники |

## Тестирование

### Backend (pytest)

```bash
pytest
```

Тесты используют `pytest` + `pytest-asyncio` + `httpx` (для тестирования FastAPI).

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
- Чистый порт 8005 — uvicorn запускается на нём.
- `JUPYTERHUB_USER` в setup переопределяется на `22494524_e2e-test`
  (из digits извлекается `22494524` — admin из дефолтного `.env`).

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
- `tests/playwright/specs/*.spec.ts` — 34 spec-файла (`@smoke`-теги).

Скип-семантика: 6 spec-файлов несут условный `test.skip`, гейтящийся
переменной окружения (`RUN_<NAME>_E2E=1`) — по умолчанию пропускаются, т.к.
требуют явно поднятого харнесса (uvicorn + засиженная БД) сверх обычного
global-setup. Не TODO/недоделанность — включаются вручную для точечного
прогона. Остальные сценарии активны без условий.

## Деплой

Приложение поддерживает деплой:

- **Standalone** — `uvicorn app.main:app`
- **За JupyterHub proxy** — автоматическая настройка `root_path` для путей вида `/user/{user}/proxy/{port}`
- **За reverse proxy** — встроенный HTTPS-redirect middleware

### Middleware

1. RequestId — генерация уникального ID для каждого запроса
2. Rate limiting (по умолчанию 1024 запросов/мин на IP)
3. Ограничение размера запросов (по умолчанию 10 МБ)
4. HTTPS Redirect (для reverse proxy)
