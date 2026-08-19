# Гайд-бук разработчика — Audit Workstation

Точка входа в документацию проекта. Здесь — обзор, быстрый старт и карта: куда идти за конкретным знанием.
Гайд-бук разбит на части; нумерация разделов (§2…§14) сквозная и сохранена от единого документа, поэтому
ссылки вида «§7.1a» остаются валидными — меняется только файл, в котором раздел живёт.

## Части гайд-бука

| Часть | Разделы | О чём |
|---|---|---|
| [`architecture-and-backend.md`](architecture-and-backend.md) | §2–§5, §14 | Слои и жизненный цикл приложения, adapter pattern, доменная плагин-система, структура backend-кода, обработка ошибок, REST-контракты (пагинация, лимиты, error envelope) |
| [`database.md`](database.md) | §6 | Схема, адаптеры PostgreSQL/Greenplum, пул и исполнитель соединений (connection-per-operation), `BaseRepository`, миграции, CHECK-констрейнты |
| [`ai-assistant.md`](ai-assistant.md) | §7, §11 | Маршруты LLM-провайдера, agent loop, resilience, ChatTool, внешний ИИ-агент через шину, deep-dive по домену chat |
| [`testing.md`](testing.md) | §8 | Стек, структура тестов, фикстуры сброса реестров, паттерны тестирования сервисов и эндпоинтов |
| [`deploy-and-configuration.md`](deploy-and-configuration.md) | §9 | Запуск, авторизация (ОТП/JWT), `.env` и Pydantic Settings, полный реестр переменных окружения, observability и retention |

## Смежная документация

**Архитектура**

- [`architecture/frontend-architecture.md`](../architecture/frontend-architecture.md) — единый deep-dive по фронту (constructor + portal + shared): ES-модули и entry-файлы, `AppState`/`StorageManager`/`LockManager`, per-node render API, диалоги, безопасность, CSS.
- [`architecture/chat-frontend-architecture.md`](../architecture/chat-frontend-architecture.md) — фронт-архитектура чата: ядерные модули, поллинг сообщений, режимы inline/modal/popup.
- [`architecture/textblock-editor-architecture.md`](../architecture/textblock-editor-architecture.md) — движок rich-редактора: капсулы ссылок/сносок, caret-guard, целостность капсул, DOCX-экспорт, поверхности `EditableSurface`.
- [`architecture/data-model-acts.md`](../architecture/data-model-acts.md) — модель данных дерева актов и deep-dive по домену acts.
- [`architecture/cross-domain-contracts.md`](../architecture/cross-domain-contracts.md) — межсервисные контракты (forward-tool, factory-registry).
- [`architecture/agent-channel-sequence.md`](../architecture/agent-channel-sequence.md) — sequence-диаграммы форварда к внешнему агенту.

**Инструкции**

- [`guides/adding-chat-tool.md`](adding-chat-tool.md) — чек-лист добавления нового chat-tool.
- [`guides/agent-integration-iframe.md`](agent-integration-iframe.md), [`guides/agent-integration-inprocess.md`](agent-integration-inprocess.md) — интеграция внешнего ИИ-агента.
- [`guides/chat-observability-and-feedback.md`](chat-observability-and-feedback.md) — метрики и обратная связь по чату.
- [`guides/redis-dev-wsl-guide.md`](redis-dev-wsl-guide.md) — поднять Redis для локальной разработки.

**Интеграции**

- [`integrations/redis-llm-bridge.md`](../integrations/redis-llm-bridge.md) — мост к LLM через Redis-стримы и воркер в Jupyter DataLab.
- [`integrations/agent-bus-redis-binding.md`](../integrations/agent-bus-redis-binding.md) — контракт Redis-шины для команды внешнего ИИ-агента.
- [`integrations/external-agent-imitation.sql`](../integrations/external-agent-imitation.sql) — SQL-стенд для имитации внешнего агента.

**Эксплуатация**

- [`operations/deployment-runbook.md`](../operations/deployment-runbook.md) — чек-лист деплоя, старт-проверка, rollback.
- [`operations/troubleshooting.md`](../operations/troubleshooting.md) — типовые проблемы и решения.
- [`operations/operations-recovery.md`](../operations/operations-recovery.md) — playbook инцидентов.
- [`operations/logging.md`](../operations/logging.md) — формат логов и `request_id`-трассировка.
- [`operations/agent-channel-production-checklist.md`](../operations/agent-channel-production-checklist.md) — операторский чек-лист моста к агенту.

**Тестирование и миграции**

- [`testing/retry-test-scenarios.md`](../testing/retry-test-scenarios.md) — покрытие retry-политики.
- [`testing/manual-qa-agent-channel.md`](../testing/manual-qa-agent-channel.md) — ручной QA моста к внешнему агенту.
- [`migrations/drop-all-tables.md`](../migrations/drop-all-tables.md) — пересоздание схемы с нуля.
- `migrations/<дата>-<таблица>-<поле>.md` — расширения схемы для уже развёрнутых БД (формат — [`database.md`](database.md) §6.5.5).

---

## 1. Обзор проекта и быстрый старт

### 1.1 Назначение и основные возможности

Audit Workstation — веб-приложение для создания и управления актами аудиторских проверок. Все пользовательские интерфейсы и доменная терминология на русском языке.

**Основные возможности:**

- Создание и редактирование актов проверок с иерархической структурой (дерево разделов)
- Работа с таблицами, текстовыми блоками и карточками нарушений
- Экспорт актов в DOCX, Markdown и текстовый формат
- Система блокировок для совместной работы (exclusive editing, локи на Redis-TTL)
- AI-ассистент с function-calling для извлечения и анализа данных актов, плюс мост к внешней базе знаний
- Аудит-лог изменений и версионирование содержимого
- Прикрепление фактур к пунктам акта (Hive/Greenplum)
- Ролевая модель доступа (Куратор, Руководитель, Редактор, Участник)
- Авторизация по одноразовому коду на e-mail (ОТП) + JWT-сессии
- Уведомления в интерфейсе и по e-mail
- Доменные страницы центров компетенций (ЦК Фин.Рез, ЦК Клиентский опыт) с верификацией метрик

**Доменная терминология:**

| Термин | Описание |
|--------|----------|
| КМ-номер | Номер контрольного мероприятия (формат `КМ-XX-XXXXX`) |
| Служебная записка | Номер документа при отправке руководству (формат `Текст/ГГГГ`) |
| Поручение (directive) | Задача структурному подразделению на исправление/улучшение |
| Фактура (invoice) | Привязка к таблице данных в Hive/Greenplum |

Полная доменная терминология актов (форматы, валидация, роли, протекшен) — в §2
[`architecture/data-model-acts.md`](../architecture/data-model-acts.md).

### 1.2 Требования

| Компонент | Минимум | Назначение |
|-----------|---------|-----------|
| Python | 3.11 | Runtime |
| PostgreSQL | 14 | БД для локальной разработки (dev) |
| Greenplum | 6.x | Прод-БД (закрытая сеть) |
| Redis | 7+ | **Обязателен во всех окружениях**: OTP-коды, сессии, кэши ролей/уведомлений, локи актов, мост к LLM. Без Redis приложение не стартует (fail-fast) |
| Kerberos `kinit` | — | Только для Greenplum (auth) |

Точные версии Python-пакетов — в `requirements.txt`, dev-зависимости — в `requirements-dev.txt`.
Как поднять Redis локально — [`redis-dev-wsl-guide.md`](redis-dev-wsl-guide.md).

### 1.3 Установка и первый запуск

**Локальная разработка (PostgreSQL):**

```bash
# 1. Клонировать репозиторий
git clone <repo-url>
cd "Audit Workstation"

# 2. Создать виртуальное окружение
python -m venv venv
source venv/bin/activate  # Linux/Mac
venv\Scripts\activate     # Windows

# 3. Установить зависимости
pip install -r requirements.txt

# 4. Создать .env (скопировать из шаблона)
cp .env.dev .env
# Отредактировать .env — указать параметры БД

# 5. Запустить
python -m app.main
```

Приложение будет доступно по адресу `http://localhost:8000` — порт берётся из `SERVER__PORT`
(дефолт в коде и в `.env.dev` — `8000`, на ПРОМе в `.env.prod` — `8484`).

Перед стартом должен быть доступен Redis (`REDIS__HOST`/`REDIS__PORT`, дефолт `127.0.0.1:6379`) —
без него приложение падает на старте намеренно.

**Работа против Greenplum:**

```bash
# 1. Авторизоваться через Kerberos
kinit

# 2. Настроить .env
DATABASE__TYPE=greenplum
DATABASE__GP__HOST=gp_dns_pkap1123_audit.gp.df.sbrf.ru
DATABASE__GP__SCHEMA=s_grnplm_ld_audit_da_project_4

# 3. Запустить
python -m app.main
```

Таблицы создаются автоматически при первом запуске (`create_tables_if_not_exist`) — только отсутствующие
целиком; в существующие таблицы приложение ничего не дописывает. Расширения уже развёрнутой БД
накатываются руками файлами `docs/migrations/<дата>-*.md` ([`database.md`](database.md) §6.5.5).

> На ПРОМе собственные таблицы приложения живут в другой схеме (`_project_34`), чем справочники UA/ЦК и
> каталог пользователей (`_project_4`) — это не опечатка, подробности в
> [`deploy-and-configuration.md`](deploy-and-configuration.md) §9.4.

### 1.4 Структура репозитория

```
Audit Workstation/
├── app/                          — основной пакет приложения
│   ├── main.py                   — точка входа FastAPI (app factory, lifespan)
│   ├── core/                     — ядро (config, middleware, domain registry, redis)
│   ├── auth/                     — авторизация (ОТП, JWT, сессии, user-контекст)
│   ├── db/                       — БД (adapters, connection pool, executor, base repository)
│   ├── domains/                  — доменные плагины (acts, admin, chat, ck_fin_res,
│   │                               ck_client_exp, notifications, sqlagent, ua_data)
│   ├── api/v1/                   — shared API (auth, system, roles)
│   ├── routes/                   — shared HTML routes
│   ├── schemas/                  — shared Pydantic-модели
│   ├── services/                 — shared сервисы
│   ├── formatters/               — shared утилиты форматирования
│   └── integrations/             — shared интеграции
├── static/                       — CSS, JS, изображения
│   ├── css/                      — 3-зонная CSS архитектура
│   └── js/                       — 3-зонная JS архитектура
├── templates/                    — Jinja2 шаблоны
├── tests/                        — pytest тесты (+ tests/playwright — e2e)
├── docs/                         — документация
├── scripts/                      — вспомогательные скрипты
│   └── datalab/                  — воркер LLM-моста (llm_redis_worker.ipynb)
├── acts_storage/                 — файловое хранилище актов (StorageService)
├── .env.dev                      — шаблон конфигурации (DEV)
├── .env.prod                     — шаблон конфигурации (ПРОМ)
├── requirements.txt              — зависимости
├── requirements-dev.txt          — dev-зависимости (pytest и т.д.)
├── playwright.config.ts          — конфигурация e2e-тестов
└── pytest.ini                    — конфигурация pytest
```

---
