# Deployment Runbook — Audit Workstation

> Closed-network deploy. SDP-кластер (доступ по IP:порту, без proxy-путей; прод-адрес — `http://10.110.10.38:<port>`, обычный HTTP, TLS-терминирующего прокси перед приложением нет) + Greenplum 6.x для прода; PostgreSQL — для dev. Авторизация — ОТП по e-mail + JWT + сессии в Redis ([`deploy-and-configuration.md`](../guides/deploy-and-configuration.md) §9.3a) либо тест-режим (`AUTH__ENABLED=false`). Раз соединение HTTP — `AUTH__COOKIE_SECURE` обязан быть `false` (`true` без HTTPS тихо ломает вход — см. §9.3a в `deploy-and-configuration.md`).
> Single-tenant per process: один Python-процесс, защита через singleton-lock в БД.
> Локальная LLM на ПРОМе ходит **не напрямую**, а через Redis-мост к воркеру в Jupyter DataLab (`CHAT__PROFILE=redis-bridge,…`) — это отдельная единица деплоя, см. §1 и [`redis-llm-bridge.md`](../integrations/redis-llm-bridge.md).

Документ — пошаговый чек-лист «как развернуть» / «как обновить» / «как проверить, что взлетело». Глубокая архитектура — [`developer-guide.md`](../guides/developer-guide.md) (хаб гайд-бука). Симптомы и фиксы — [`troubleshooting.md`](troubleshooting.md). Что делать когда сломалось — [`operations-recovery.md`](operations-recovery.md).

---

## 1. Pre-deploy checklist

Перед запуском (или рестартом) уверенно прогнать:

- [ ] **Kerberos** (только GP-окружение). `kinit <user>` для получения тикета. `klist` показывает валидный TGT, срок жизни > планируемого аптайма (обычно 8-24 часа). Без тикета `_is_kerberos_ticket_valid()` (`app/db/connection.py:96`) залогирует инструкции и init БД упадёт.
- [ ] **Redis доступен** (обязателен всегда — приложение без него не стартует, независимо от `AUTH__ENABLED`). `PING` на хост/порт из блока `REDIS__*` в `.env` (ПРОМ — `10.110.10.38:7474`, db `0`). Старт fail-fast в хуке `auth.redis`: на Redis живут ОТП-коды и сессии, кэши (уведомления, роли, user-контекст), блокировки актов и заявки LLM-моста. При недоступности Redis уже после старта — кэши прозрачно уходят в БД, а мутации блокировок актов (захват/продление/снятие) отдают 5xx. Версия Redis — **≥ 7.0** (мост использует `XAUTOCLAIM` в 7.0-формате); на площадках 7.0.15.
- [ ] **`JUPYTERHUB_USER`** в окружении процесса (имя — историческое, к деплою на JupyterHub отношения не имеет). Нужна для Kerberos/Greenplum-логина (`app/db/connection.py:214`) и, при `AUTH__ENABLED=false` (тест-режим), для username RBAC (`app/auth/context.py:30`) — без неё он `unknown_user`, RBAC сломается. На SDP автоподстановки нет — выставлять явно (`export JUPYTERHUB_USER=<digits>_<...>`) в окружении процесса/деплой-скрипте. При `AUTH__ENABLED=true` (ОТП) на веб-авторизацию не влияет — только на Kerberos-логин GP.
- [ ] **`.env` сверен с `.env.prod`** (шаблона `.env.example` больше нет: ПРОМ — `.env.prod`, DEV — `.env.dev`). После предыдущего деплоя в `.env.prod` мог появиться обязательный ключ или поменяться дефолт. Команда быстрой сверки на Windows PowerShell:
  ```powershell
  Compare-Object (Get-Content .env.prod) (Get-Content .env)
  ```
  Особо проверить: `AUTH__*`, `REDIS__*`, `CHAT__*`, `ACTS__*`, `OBSERVABILITY__*`, `SECURITY__*`. Канал к внешнему ИИ-агенту настраивается префиксом `CHAT__AGENT_CHANNEL__*` (`TABLE_NAME` — имя bus-таблицы целиком, дефолт кода `chat_agent_messages_bus`, в `.env.prod` — `agent_conversation_messages`; `SCHEMA_NAME` — пусто → схема чата → основная; `POLL_MIN_INTERVAL_SEC=2.0`, `POLL_MAX_INTERVAL_SEC=10.0`, `POLL_BACKOFF_MULTIPLIER=1.5`, `ANSWER_TIMEOUT_SEC=600`, `CLAIM_TIMEOUT_SEC=1800`, `MAX_BLOCK_TEXT_SIZE=262144`); лимит одновременных запросов — `CHAT__MAX_PARALLEL_STREAMS_PER_USER` (default 3).
- [ ] **Маршрут LLM (`CHAT__PROFILE`) соответствует площадке.** Допустимые значения — `openai`, `gigachat`, `redis-bridge,openai`, `redis-bridge,gigachat` (`parse_route`, `app/domains/chat/settings.py:84`); мусорное значение валит старт на валидации Settings. На ПРОМе прямого доступа к GigaChat и локальным inference-серверам с SDP нет, поэтому используются `redis-bridge,*`. Fallback-маршрут — `CHAT__FALLBACK_PROFILE` в том же формате; **пустое значение = fallback выключен**.
- [ ] **Воркер LLM-моста запущен** (только при `CHAT__PROFILE=redis-bridge,…`). `redis-cli -h <REDIS__HOST> -p <REDIS__PORT> GET llm:bridge:worker:alive` возвращает JSON с непустым `targets`, покрывающим цели primary- и fallback-маршрута. Ключа нет → воркер не поднят: `scripts/llm_redis_worker.ipynb` в Jupyter DataLab, Run All. Без воркера чат отвечает штатной ошибкой недоступности LLM (troubleshooting №7).
- [ ] **Пул соединений.** Единые дефолты во всех окружениях: `DATABASE__POOL_MIN_SIZE=1` / `POOL_MAX_SIZE=2`. У GP-учётки жёсткий лимит ~5 соединений, «поднять пул» (troubleshooting №17) там не вариант; горячие пути (unread-счётчик, роли, user-контекст, локи) обслуживает Redis. DEV держим идентичным ПРОМу — вилка прятала бы нехватку коннектов до самого прода.
- [ ] **`DATABASE__TABLE_PREFIX` и `DATABASE__GP__SCHEMA`** соответствуют БД. Дефолт префикса — `t_db_oarb_audit_act_`; GP-схема собственных таблиц на ПРОМе — `s_grnplm_ld_audit_da_project_34` (`.env.prod`), тогда как справочники UA/ЦК и каталог пользователей живут в `s_grnplm_ld_audit_da_project_4` (`ADMIN__USER_DIRECTORY__SCHEMA`, `CK_*__SCHEMA_NAME`, `ACTS__INVOICE__HIVE_REGISTRY_SCHEMA`). При смене окружения проверить, что таблицы существуют под тем же префиксом и в той же схеме — иначе `create_tables_if_not_exist` поднимет новый набор пустых таблиц и фактические данные «исчезнут».
- [ ] **Свободен ли singleton-lock**. См. `troubleshooting.md` №20: если предыдущий процесс упал по kill -9, строка в `app_singleton_lock` живёт до `SECURITY__SINGLETON_LOCK_STALE_TTL_SEC` сек (default 60). В пределах окна старт упадёт.
- [ ] **Схема БД соответствует коду**. Если с прошлого деплоя менялась `schema.sql` любого домена — БД пересоздана (`docs/migrations/drop-all-tables.md`, см. §3); startup-диагностика дрейфа колонок (§6.5.4 в [`database.md`](../guides/database.md)) не сыпет WARNING'ами.
- [ ] **Внешний ИИ-агент жив**. Если деплой завязан на форварды в «Базу знаний ОАРБ» — убедиться, что внешний worker читает bus-таблицу из `CHAT__AGENT_CHANNEL__TABLE_NAME` (вопросы со `status='pending'`/`role='user'`) и пишет ответы туда же. Без него форварды будут висеть до `CHAT__AGENT_CHANNEL__CLAIM_TIMEOUT_SEC` (1800 сек, фаза `pending`) / `ANSWER_TIMEOUT_SEC` (600 сек, фаза `processing`) и финализироваться как ошибка таймаута.

---

## 2. Старт и старт-проверка

**Запуск:**

```powershell
# Standalone: host/port/log_level берутся из SERVER__* (.env), см. dev-guide §9.1
python -m app.main
# или через uvicorn (порт задаётся явно и перекрывает SERVER__PORT)
uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8484
```

**Старт-проверка (по порядку):**

1. **Лог жизненного цикла**. В выводе uvicorn должны последовательно появиться:
   - `Database pool ready: ...` (`app/db/connection.py:294`) — пул асинкпг поднят.
   - `Схема базы данных проверена` — `create_tables_if_not_exist` отработала. Пишется на уровне **DEBUG** (`app/main.py:128`), поэтому при штатном `SERVER__LOG_LEVEL=INFO` строки не будет; ориентир для INFO-логов — отсутствие ошибок и следующая строка `Application startup complete` (`app/main.py:198`).
   - Сообщение о захвате singleton-lock без ошибок (`Не удалось захватить singleton-lock` → стоп, см. troubleshooting №20).
   - Фоновые задачи логируют старт: `agent_channel_poller: запущен` (`agent_channel_poller.py:396`), `llm_health_probe: запущен` (или `…: отключён настройками`), `db_pool_monitor: …`. **Батчеры при старте молчат** — `MetricsBatcher.start()` ничего не пишет, их состояние проверяется только через `/admin/diagnostics` (п. 3). Полный набор хуков:

     | Hook (в порядке запуска) | Что |
     |---|---|
     | `acts.audit_log_batcher` | `MetricsBatcher` для аудита актов |
     | `admin.http_metrics_batcher` | `MetricsBatcher` HTTP-метрик |
     | `admin.access_denied_audit_batcher` | `MetricsBatcher` отказов доступа |
     | `admin.db_pool_monitor` | Мониторинг asyncpg-пула |
     | `chat.tool_metrics_batcher` | `MetricsBatcher` метрик tool-вызовов |
     | `chat.audit_log_batcher` | `MetricsBatcher` chat-аудита |
     | `chat.agent_channel_poller` | Polling bus-таблицы канала агента, финализация форвард-черновиков (adaptive-backoff) |
     | `chat.llm_health_probe` | Фоновый ping primary-LLM при открытом circuit breaker (`CHAT__HEALTH_PROBE__*`) |
     | `notifications.email_init` | Инициализация SMTP-отправки (ОТП-коды, уведомления); при `NOTIFICATIONS__EMAIL__ENABLED=false` или пустом пароле — no-op с WARNING |
     | `auth.redis` | Подключение к Redis (fail-fast: ошибка = приложение не стартует) |

     Канонический список и детали — dev-guide §11. Порядок = порядок регистрации: доменные хуки цепляются при `discover_domains` (домены обходятся по алфавиту), `auth.redis` — строкой ниже в `create_app` (`app/main.py:286` и `:290`, сам хук — `app/auth/lifecycle.py:69`), поэтому он последний на старте и первый на shutdown'е.

2. **Базовый health.**
   ```bash
   curl http://localhost:8484/api/v1/system/health
   # → {"status": "ok", "service": "Audit Workstation", "version": "<версия из app/__init__.py>"}
   ```
   Путь — `{SERVER__API_V1_PREFIX}/system/health` (`app/api/v1/routes.py:19`), там же `/system/health/detailed`, `/system/health/detailed/full` (требует авторизации) и `/system/health/{domain_name}` (per-domain `health_check`). Есть ещё облегчённый корневой `GET /health` → `{"status": "ok"}` (`app/main.py:363`) — не ходит в БД и отфильтрован из HTTP-метрик.

   > **При `AUTH__ENABLED=true` health не анонимный.** `AuthMiddleware` пропускает без cookie только `/static`, `/favicon.ico` и `{prefix}/auth/*`; остальное — 401 JSON для путей с `/api/` и редирект на `/auth/login` для прочих (`app/auth/middleware.py:82-83`, `:187-196`). Поэтому `curl` без cookie на `/api/v1/system/health` вернёт 401, а на корневой `/health` — 307/302 на форму входа. Внешний мониторинг это должен учитывать: «жив» = ответ вообще пришёл (401/302 тоже признак живого процесса), либо запрос идёт с валидной cookie.

   На SDP — тот же путь по IP-адресу и порту хоста: `http://10.110.10.38:<port>/api/v1/system/health` (порт ПРОМа — `SERVER__PORT`, в `.env.prod` — `8484`).

3. **Diagnostics (Wave 1).** Требует роль `Админ` (`ADMIN__USER_DIRECTORY__DEFAULT_ADMIN`):
   ```bash
   curl -H "Cookie: ..." http://localhost:8484/api/v1/admin/diagnostics | jq
   ```
   - `batchers.*.running` — все `true`.
   - `batchers.*.dropped_count` — все `0` сразу после старта.
   - `background_tasks.*.running` — все `true`.

   Подробности — dev-guide §9.5b.

4. **Smoke-проверка домена.** Открыть UI портала, убедиться что:
   - Вход по ОТП проходит: письмо с кодом приходит, `verify-otp` отдаёт 200, cookie ставится и редирект на портал срабатывает (при `AUTH__ENABLED=true`; на HTTP `AUTH__COOKIE_SECURE` обязан быть `false`, иначе вход зацикливается без ошибок в логах).
   - Sidebar показывает доменные пункты (если они зарегистрированы для роли пользователя).
   - Чат отвечает на «привет» — на маршруте `redis-bridge,*` это же проверяет живость воркера моста.
   - Открытие любого акта (`/constructor?act_id=<id>`) не валится с 5xx, блокировка акта берётся (пишется в Redis, `lock:act:{id}`).

---

## 3. Миграции БД

Апгрейд-миграций нет: `create_tables_if_not_exist` создаёт **только отсутствующие** таблицы, не дописывает колонки/индексы в существующие. При изменении схемы БД пересоздаётся — `docs/migrations/drop-all-tables.md` (дроп строго в обратном порядке FK) и рестарт приложения. Для имитации внешнего агента см. [`external-agent-imitation.sql`](../integrations/external-agent-imitation.sql).

**Если таблица не создалась автоматически** (старая версия create_tables, специфичные права):

Файлы `schema.sql` **нельзя скормить psql как есть** — они содержат плейсхолдеры, которые подставляет адаптер (`{SCHEMA}`, `{PREFIX}`, `{REF_USER_TABLE}`, `{REF_HADOOP_TABLES}` и в chat-домене `{CHAT_SCHEMA_Q}`, `{BUS_SCHEMA_Q}`, `{BUS_TABLE}`). На PG адаптер заменяет `{SCHEMA}.` на пустую строку, на GP — на реальную схему.

```bash
# Greenplum (админ-домен как пример)
sed 's/{SCHEMA}/<gp_schema>/g; s/{PREFIX}/t_db_oarb_audit_act_/g' \
    app/domains/admin/migrations/greenplum/schema.sql | psql ...

# PostgreSQL — то же, но {SCHEMA}. вырезается (так делает PostgreSQLAdapter, postgresql.py:60)
sed 's/{SCHEMA}\.//g; s/{PREFIX}/t_db_oarb_audit_act_/g; s/{REF_USER_TABLE}/t_db_oarb_ua_user/g' \
    app/domains/admin/migrations/postgresql/schema.sql | psql ...
```

Доменные подстановки (`migration_substitutions` в дескрипторе домена): `{REF_USER_TABLE}` → `ADMIN__USER_DIRECTORY__TABLE` (имя без схемы), `{REF_HADOOP_TABLES}` → `ACTS__INVOICE__HIVE_REGISTRY_TABLE`, `{CHAT_SCHEMA_Q}` / `{BUS_SCHEMA_Q}` → квалификатор схемы с точкой либо пустая строка, `{BUS_TABLE}` → `CHAT__AGENT_CHANNEL__TABLE_NAME`. В GP-схемах `{REF_*}` не встречаются — эти таблицы на проде создаёт ETL.

(Linux-окружение деплоя (SDP). Под Windows эквивалент — ручная замена в редакторе или PowerShell `(Get-Content ...) -replace ...`.)

---

## 4. Rollback protocol

Если новый деплой ломает прод, и нужно откатиться:

1. **`SIGTERM`** на текущий процесс (uvicorn ждёт ≤5с graceful drain). Singleton-lock освободится в lifespan-shutdown (`app/main.py:249-259`).
2. **`git checkout <previous-tag>`** в рабочем каталоге.
3. **Проверить совместимость БД-схемы.** Если новая версия меняла `schema.sql`, лишние для старой версии колонки не мешают (она читает своё подмножество). При несовместимом изменении (переименование, смена типа) — пересоздание БД по старой `schema.sql`; при необходимости сохранить данные — backup/restore.
4. **Старт по §2.**
5. **Проверить zombie streaming-сообщения.** Форвард в «Базу знаний ОАРБ» создаёт черновик `chat_messages` со `status='streaming'`, который финализирует `AgentChannelPoller`; после рестарта зависшие черновики подхватываются reconcile при старте поллера. Здесь — только проверка факта: `SELECT count(*) FROM t_db_oarb_audit_act_chat_messages WHERE status='streaming' AND created_at < now() - interval '5 minutes';`. Если ненулевое — открыть [operations-recovery.md §1](operations-recovery.md).

---

## 5. Известные проблемы

Сборник симптомов — [`troubleshooting.md`](troubleshooting.md). Особо актуально на деплое:

- №1, №2 — Kerberos / GP connection refused.
- №3 — file upload 413.
- №7 — LLM-мост `redis-bridge`: нет heartbeat воркера / дедлайн заявки.
- №9 — `Database pool не инициализирован` (lifespan ещё не отработал).
- №17 — `TooManyConnectionsError` (пул намеренно 1/2 — искать удерживаемое соединение).
- №20 — Singleton-lock застрял (см. также §1 этого runbook'а).
- №21 — Записи теряются в батчерах (Wave 1: проверить `/admin/diagnostics`).
- №23 — Redis недоступен (старт fail-fast; в рантайме — 5xx на блокировках актов).
