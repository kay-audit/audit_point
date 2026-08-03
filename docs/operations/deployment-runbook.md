# Deployment Runbook — Audit Workstation

> Closed-network deploy. SDP-кластер (доступ по IP:порту, без proxy-путей) + Greenplum 6.x для прода; PostgreSQL — для dev. Авторизация — ОТП/JWT (`developer-guide.md` §9.3a) либо тест-режим (`AUTH__ENABLED=false`). Исторически деплоилось на JupyterHub Datalab — см. пометки ниже.
> Single-tenant per process: один Python-процесс, защита через singleton-lock в БД.

Документ — пошаговый чек-лист «как развернуть» / «как обновить» / «как проверить, что взлетело». Глубокая архитектура — [`developer-guide.md`](../guides/developer-guide.md). Симптомы и фиксы — [`troubleshooting.md`](troubleshooting.md). Что делать когда сломалось — [`operations-recovery.md`](operations-recovery.md).

---

## 1. Pre-deploy checklist

Перед запуском (или рестартом) уверенно прогнать:

- [ ] **Kerberos** (только GP-окружение). `kinit <user>` для получения тикета. `klist` показывает валидный TGT, срок жизни > планируемого аптайма (обычно 8-24 часа). Без тикета `_is_kerberos_ticket_valid()` (`app/db/connection.py:65`) залогирует инструкции и init БД упадёт.
- [ ] **Redis доступен** (обязателен всегда — приложение без него не стартует, независимо от `AUTH__ENABLED`). `PING` на хост/порт из блока `REDIS__*` в `.env`. Старт fail-fast: на Redis живут ОТП-коды, кэши (уведомления, роли, user-контекст) и блокировки актов. При недоступности Redis уже после старта — кэши прозрачно уходят в БД, а мутации блокировок актов (захват/продление/снятие) отдают 5xx.
- [ ] **`JUPYTERHUB_USER`** в окружении процесса (имя — историческое). Нужна для Kerberos/Greenplum-логина и, при `AUTH__ENABLED=false` (тест-режим), для username RBAC — без неё он `unknown_user`, RBAC сломается. На SDP автоматической подстановки (как раньше делал JupyterHub Datalab) нет — выставлять явно (`export JUPYTERHUB_USER=<digits>_<...>`) в окружении процесса/деплой-скрипте. При `AUTH__ENABLED=true` (ОТП) на веб-авторизацию не влияет — только на Kerberos-логин GP.
- [ ] **`.env` сверен с `.env.example`**. После предыдущего деплоя в `.env.example` мог появиться обязательный ключ или поменяться дефолт. Команда быстрой сверки на Windows PowerShell:
  ```powershell
  Compare-Object (Get-Content .env.example) (Get-Content .env)
  ```
  Особо проверить: `CHAT__*`, `ACTS__*`, `OBSERVABILITY__*`, `SECURITY__*`. Канал к внешнему ИИ-агенту настраивается префиксом `CHAT__AGENT_CHANNEL__*` (`TABLE_NAME=chat_agent_messages_bus`, `POLL_MIN_INTERVAL_SEC=2.0`, `POLL_MAX_INTERVAL_SEC=10.0`, `POLL_BACKOFF_MULTIPLIER=1.5`, `ANSWER_TIMEOUT_SEC=600`, `MAX_BLOCK_TEXT_SIZE=262144`); лимит одновременных запросов — `CHAT__MAX_PARALLEL_STREAMS_PER_USER` (default 3).
- [ ] **Пул соединений.** Единые дефолты во всех окружениях: `DATABASE__POOL_MIN_SIZE=1` / `POOL_MAX_SIZE=2`. У GP-учётки жёсткий лимит ~5 соединений, «поднять пул» (troubleshooting №17) там не вариант; горячие пути (unread-счётчик, роли, user-контекст, локи) обслуживает Redis. DEV держим идентичным ПРОМу — вилка прятала бы нехватку коннектов до самого прода.
- [ ] **`DATABASE__TABLE_PREFIX`** соответствует БД. Дефолт `t_db_oarb_audit_act_`. При смене окружения проверить, что таблицы существуют под тем же префиксом — иначе `create_tables_if_not_exist` поднимет новый набор пустых таблиц и фактические данные «исчезнут».
- [ ] **Свободен ли singleton-lock**. См. `troubleshooting.md` №20: если предыдущий процесс упал по kill -9, строка в `app_singleton_lock` живёт до `SECURITY__SINGLETON_LOCK_STALE_TTL_SEC` сек (default 60). В пределах окна старт упадёт.
- [ ] **Версия миграций**. Все одноразовые SQL из `docs/migrations/` для апгрейда с предыдущей версии применены (см. §3).
- [ ] **Внешний ИИ-агент жив**. Если деплой завязан на форварды в «Базу знаний ОАРБ» — убедиться, что внешний worker читает bus-таблицу `chat_agent_messages_bus` (вопросы со `status='pending'`/`role='user'`) и пишет ответы туда же. Без него форварды будут висеть до `CHAT__AGENT_CHANNEL__ANSWER_TIMEOUT_SEC` (600 сек default) и финализироваться как ошибка таймаута.

---

## 2. Старт и старт-проверка

**Запуск:**

```powershell
# Standalone (см. dev-guide §9.1)
python -m app.main
# или через uvicorn (с явным портом)
uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8005
```

**Старт-проверка (по порядку):**

1. **Лог жизненного цикла**. В выводе uvicorn должны последовательно появиться:
   - `Database pool ready: ...` (`app/db/connection.py:252`) — пул асинкпг поднят.
   - `Схема базы данных проверена` — `create_tables_if_not_exist` отработала.
   - Сообщение о захвате singleton-lock без ошибок (`Не удалось захватить singleton-lock` → стоп, см. troubleshooting №20).
   - Каждый startup-hook — `agent_channel_poller: запущен (...)`, `audit_log_batcher: started`, и аналогичные. Полный набор:

     | Hook | Что |
     |---|---|
     | `acts.audit_log_batcher` | `MetricsBatcher` для аудита актов |
     | `admin.http_metrics_batcher` | `MetricsBatcher` HTTP-метрик |
     | `admin.access_denied_audit_batcher` | `MetricsBatcher` отказов доступа |
     | `admin.db_pool_monitor` | Мониторинг asyncpg-пула |
     | `chat.tool_metrics_batcher` | `MetricsBatcher` метрик tool-вызовов |
     | `chat.audit_log_batcher` | `MetricsBatcher` chat-аудита |
     | `chat.agent_channel_poller` | Polling bus-таблицы `chat_agent_messages_bus`, финализация форвард-черновиков (adaptive-backoff) |
     | `chat.llm_health_probe` | Периодическая проверка доступности LLM-провайдера |

     Канонический список и детали — dev-guide §11.

2. **Базовый health.**
   ```bash
   curl http://localhost:8005/api/v1/health
   # → {"status": "ok", "service": "Audit Workstation", "version": "1.0.0"}
   ```
   На SDP — тот же путь по IP-адресу хоста: `http://<sdp-host>:8005/api/v1/health` (proxy-путей больше нет; исторический JupyterHub-вариант — `http://<hub>/user/<user>/proxy/8005/api/v1/health`).

3. **Diagnostics (Wave 1).** Требует роль `Админ` (`ADMIN__USER_DIRECTORY__DEFAULT_ADMIN`):
   ```bash
   curl -H "Cookie: ..." http://localhost:8005/api/v1/admin/diagnostics | jq
   ```
   - `batchers.*.running` — все `true`.
   - `batchers.*.dropped_count` — все `0` сразу после старта.
   - `background_tasks.*.running` — все `true`.

   Подробности — dev-guide §9.5b.

4. **Smoke-проверка домена.** Открыть UI портала, убедиться что:
   - Sidebar показывает доменные пункты (если они зарегистрированы для роли пользователя).
   - Чат отвечает на «привет» (LLM-провайдер доступен).
   - Открытие любого акта (`/constructor?act_id=<id>`) не валится с 5xx.

---

## 3. Миграции БД (одноразовые)

При апгрейде с предыдущих версий могут понадобиться SQL-миграции — `create_tables_if_not_exist` создаёт **только новые** таблицы, не дописывает колонки/индексы в существующие.

Текущий каталог миграций — `docs/migrations/`:

| Файл | Когда применять |
|---|---|
| `drop-all-tables.md` | Тотальная очистка под пересоздание схемы (только dev) |

**Канал к внешнему ИИ-агенту** при апгрейде с версий со старой шиной (3 таблицы `agent_requests` / `agent_response_events` / `agent_responses`) требует ручных шагов: единая bus-таблица `chat_agent_messages_bus` создаётся `create_tables_if_not_exist` автоматически, но в `chat_messages` добавилась колонка `agent_ref VARCHAR(36)` — её нужно дописать ALTER'ом на существующей БД. Старые 3 таблицы можно дропнуть после миграции. Настройки канала живут только в коде (`CHAT__AGENT_CHANNEL__*`). Для имитации внешнего агента см. [`external-agent-imitation.sql`](../integrations/external-agent-imitation.sql).

**Если таблица не создалась автоматически** (старая версия create_tables, специфичные права):

```sql
-- PostgreSQL
\i app/domains/admin/migrations/postgresql/schema.sql
-- Greenplum (через sed на плейсхолдерах)
sed 's/{SCHEMA}/<gp_schema>/g; s/{PREFIX}/t_db_oarb_audit_act_/g' \
    app/domains/admin/migrations/greenplum/schema.sql | psql ...
```

(Linux-окружение деплоя (SDP). Под Windows эквивалент — ручная замена в редакторе или PowerShell `(Get-Content ...) -replace ...`.)

---

## 4. Rollback protocol

Если новый деплой ломает прод, и нужно откатиться:

1. **`SIGTERM`** на текущий процесс (uvicorn ждёт ≤5с graceful drain). Singleton-lock освободится в lifespan-shutdown (`app/main.py:266-280`).
2. **`git checkout <previous-tag>`** в рабочем каталоге.
3. **Проверить совместимость БД-схемы.** Если в новой версии были `ALTER TABLE` / новые колонки, и старая версия их не ждёт — это OK (старая версия читает подмножество колонок). Если же старая версия пишет в колонку, которой в новой версии нет — деплой нельзя откатывать без backup'а.
4. **Старт по §2.**
5. **Проверить zombie streaming-сообщения.** Форвард в «Базу знаний ОАРБ» создаёт черновик `chat_messages` со `status='streaming'`, который финализирует `AgentChannelPoller`; после рестарта зависшие черновики подхватываются reconcile при старте поллера. Здесь — только проверка факта: `SELECT count(*) FROM t_db_oarb_audit_act_chat_messages WHERE status='streaming' AND created_at < now() - interval '5 minutes';`. Если ненулевое — открыть [operations-recovery.md §1](operations-recovery.md).

---

## 5. Известные проблемы

Сборник симптомов — [`troubleshooting.md`](troubleshooting.md). Особо актуально на деплое:

- №1, №2 — Kerberos / GP connection refused.
- №3 — file upload 413.
- №7 — 404 на API под JupyterHub-proxy (`AppConfig.api.getUrl(...)`).
- №9 — `Database pool не инициализирован` (lifespan ещё не отработал).
- №17 — `TooManyConnectionsError` (пул намеренно 1/2 — искать удерживаемое соединение).
- №20 — Singleton-lock застрял (см. также §1 этого runbook'а).
- №21 — Записи теряются в батчерах (Wave 1: проверить `/admin/diagnostics`).
