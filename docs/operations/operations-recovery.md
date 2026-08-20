# Operations Recovery Playbook — Audit Workstation

> Реальные сценарии «что-то не так в проде». У каждого: **симптом**, **как диагностировать**, **как починить**.
> Документ — для оператора, не для разработчика. Глубокая архитектура — [`developer-guide.md`](../guides/developer-guide.md) (хаб гайд-бука). Симптомы со стандартным фиксом — [`troubleshooting.md`](troubleshooting.md).
> Плейсхолдеры в SQL: `{SCHEMA}` — `DATABASE__GP__SCHEMA` (в `.env.prod` — `s_grnplm_ld_audit_da_project_34`; в `.env.dev` — `s_grnplm_ld_audit_da_project_4`); `{PREFIX}` — `DATABASE__TABLE_PREFIX` (default `t_db_oarb_audit_act_`); `{BUS_TABLE}` — имя bus-таблицы целиком из `CHAT__AGENT_CHANNEL__TABLE_NAME` (дефолт кода — `chat_agent_messages_bus`, в `.env.prod` — `agent_conversation_messages`; app-префикс к нему **не** добавляется). Если задан `CHAT__AGENT_CHANNEL__SCHEMA_NAME`, шина лежит в этой схеме, а не в `{SCHEMA}`.

---

## 1. Зависший forward к внешнему агенту

**Симптом.** Пользователь жалуется: «Ассистент завис на печати». В UI крутится typing-индикатор, ответа нет > 5 минут. В чате включён тумблер «База знаний ОАРБ» (режим «Адаптивный» или «Всегда»), вопрос ушёл в шину к внешнему ИИ-агенту.

**Как это работает.** Форвард создаёт черновик ассистент-сообщения в `chat_messages` (`status='streaming'`, `agent_ref` = uid вопроса) и пишет вопрос в единую bus-таблицу `{BUS_TABLE}` (`role='user'`, `status='pending'`). Фоновый `AgentChannelPoller` поллит шину; `AgentChannelService.poll_once` дозаполняет reasoning-блок по дельтам, а когда ответ готов — финализирует черновик (`complete`/`failed`).

**Диагностика.**

```sql
-- 1. Streaming-черновики, которые так и не дошли до финала.
SELECT id, conversation_id, agent_ref, status, created_at
FROM {SCHEMA}.{PREFIX}chat_messages
WHERE status = 'streaming'
  AND created_at < now() - interval '5 minutes';

-- 2. Состояние соответствующих записей в шине (agent_ref → {BUS_TABLE}.id).
SELECT id, chat_id, role, status, created_at, updated_at
FROM {SCHEMA}.{BUS_TABLE}
WHERE id IN (... agent_ref из шага 1 ...)
ORDER BY created_at;

-- 3. Есть ли вообще ответ агента (reply_to ссылается на uid вопроса).
SELECT id, role, status, reply_to, created_at
FROM {SCHEMA}.{BUS_TABLE}
WHERE reply_to IN (... agent_ref из шага 1 ...);
```

Если по шагу 3 ответа нет — внешний агент ещё не ответил (или не работает). Если ответ есть (`status='completed'`), а черновик висит в `streaming` — не сработала финализация (проверить, что `chat.agent_channel_poller` запущен в `/admin/diagnostics`).

**Recovery.**

1. **Не торопиться.** Если процесс жив и `chat.agent_channel_poller` запущен (`/admin/diagnostics`), а внешний агент ещё работает — поллер догонит ответ. Двухфазные таймауты: `CLAIM_TIMEOUT_SEC` (1800 = 30 мин, фаза `pending`) и `ANSWER_TIMEOUT_SEC` (1800 = 30 мин, фаза `processing`). По истечении `mark_timeout` сам пометит черновик `failed`. Дать сработать.
2. **Если рестартовали uvicorn** — `AgentChannelPoller.reconcile()` в startup-hook восстанавливает подписки из всех `streaming`-черновиков с непустым `agent_ref` (`app/domains/chat/services/agent_channel_poller.py:311`). Дождаться, пока поллер сделает первые тики.
3. **Forcibly закрыть.** Если ответа от агента нет и автоматика не помогает — пометить черновик и вопрос вручную:
   ```sql
   -- Черновик ассистент-сообщения → failed (на GP 6.x / PG 9.4 без jsonb-||,
   -- блоки оставляем как есть; финализирующий error-блок дописывает только
   -- Python-путь poll_once/mark_timeout):
   UPDATE {SCHEMA}.{PREFIX}chat_messages
   SET status = 'failed', updated_at = CURRENT_TIMESTAMP
   WHERE id = '<message_id>';

   -- Вопрос в шине → failed ('timeout' CHECK'ом владельца таблицы запрещён).
   UPDATE {SCHEMA}.{BUS_TABLE}
   SET status = 'failed', updated_at = CURRENT_TIMESTAMP
   WHERE id = '<agent_ref>';
   ```
   После этого фронт при reload/повторном поллинге увидит ErrorBlock вместо typing-индикатора. Чтобы добавить читаемый error-блок в content, лучше дождаться рестарта приложения (reconcile подхватит черновик) либо вызвать `AgentChannelService.mark_timeout(...)` из Python.

**См. также:** dev-guide §11 (Chat domain), `docs/integrations/external-agent-imitation.sql` (имитация внешнего агента под единую таблицу).

---

## 2. Singleton-lock застрял

См. [`troubleshooting.md` №20](troubleshooting.md#20-singleton-lock--приложение-не-стартует--зависший-процесс).

Короткая выжимка: `app_singleton_lock`-строка живёт после kill -9 до `SECURITY__SINGLETON_LOCK_STALE_TTL_SEC` (default 60 сек). Старт в окне TTL упадёт. Если реального процесса нет — дождаться TTL или вручную:

```sql
DELETE FROM {SCHEMA}.{PREFIX}app_singleton_lock
WHERE service_name = 'audit_workstation';
```

---

## 3. Bus-таблица канала агента распухла

**Симптом.** GP-таблица `{BUS_TABLE}` (единая шина к внешнему агенту) стала большой, тики `AgentChannelPoller` заметно медленнее (видно по росту нагрузки на GP и по `/admin/diagnostics` для `chat.agent_channel_poller`).

**Диагностика.**

```sql
-- Размер таблицы.
SELECT count(*) AS rows,
       pg_size_pretty(pg_total_relation_size('{SCHEMA}.{BUS_TABLE}')) AS size
FROM {SCHEMA}.{BUS_TABLE};

-- Распределение по статусам.
SELECT status, count(*) AS messages
FROM {SCHEMA}.{BUS_TABLE}
GROUP BY status;
```

**Recovery.**

> Автоматического фонового cleanup для шины сейчас нет — чистка ручная/кроновая.

1. **Ручная очистка** старых терминальных сообщений (`completed`/`failed`). Не трогать `pending`/`processing` — это ещё живые запросы:
   ```sql
   DELETE FROM {SCHEMA}.{BUS_TABLE}
   WHERE status IN ('completed', 'failed')
     AND created_at < now() - interval '7 days';
   ```
2. **Кроном** — тот же DELETE раз в неделю с подходящим retention.
3. **VACUUM ANALYZE** после массовой чистки (для PG; на GP лучше партиционирование, см. dev-guide §7.8.6).

---

## 4. Записи теряются в батчерах

См. [`troubleshooting.md` №21](troubleshooting.md#21-записи-в-audit_log--metrics-пропадают--что-проверить).

**Когда дроп ожидаем.** Прод с высокой нагрузкой: например `metrics_max_buffer_size=10000`, поток 100 событий/сек, GP в нагрузке отстаёт. Через ~100 сек overflow начинает дропать старые записи. Это безопаснее, чем OOM процесса.

**Митигация:**

- Поднять `OBSERVABILITY__METRICS_MAX_BUFFER_SIZE` (больше буфера, дольше выдерживает пик).
- Уменьшить `OBSERVABILITY__METRICS_FLUSH_INTERVAL_SEC` (быстрее опустошение → меньше шансов накопить overflow).
- Поднять `OBSERVABILITY__METRICS_BATCH_SIZE` (больше за раз — меньше round-trip'ов в GP).
- Найти источник нагрузки (`batcher.name` в overflow-WARNING; для admin.http_metrics_batcher — проверить нет ли DDoS / спам-бота).

**Дополнительно для `last_error` ≠ null.** Это значит, что flush в БД стабильно падает. Чаще всего — CHECK constraint без mapping (см. dev-guide §6.5a), сетевой обрыв до GP, или права на таблицу. Логи покажут точный exception.

---

## 5. Восстановление после рестарта uvicorn

**Что автоматически:**

- `AgentChannelPoller.reconcile()` в startup-hook восстанавливает подписки из всех `streaming`-черновиков с непустым `agent_ref` (`app/domains/chat/services/agent_channel_poller.py:311`). Поллер продолжит ждать ответы из шины.
- `chat_messages.status='streaming'` с уже пришедшим ответом агента — поллер финализирует через `poll_once`; без ответа дольше `CLAIM_TIMEOUT_SEC`/`ANSWER_TIMEOUT_SEC` → `mark_timeout` пометит `failed`.
- Singleton-lock освобождается мягко в shutdown-hook (`app/main.py:249-259`).

**Что НЕ автоматически:**

- Записи, дропнутые батчерами при shutdown'е без graceful drain — ушли в /dev/null. `stop()` каждого батчера делает финальный flush (`app/core/metrics_batcher.py:163-187`), но если процесс получил SIGKILL, до stop() не дошло.

**Что проверить после рестарта:**

1. По §2 чек-листа из `deployment-runbook.md` — все hook'и запустились, `/admin/diagnostics` чистый.
2. SQL по §1 из этого playbook'а — нет ли «зомби» streaming-сообщений.
3. Логи на WARNING/ERROR за первые 5 минут — особо `metrics_batcher` overflow, `agent_channel_poller` ошибки, Kerberos.

---

## 6. Просмотр denied access (Wave 1)

Когда поступила жалоба «кто-то ломится в админку» или «юзер видит чужой ЦК-домен»:

```sql
-- Последние сутки отказов.
SELECT username, domain, path, method, reason, created_at
FROM {SCHEMA}.{PREFIX}access_denied_audit
WHERE created_at > now() - interval '24 hours'
ORDER BY created_at DESC
LIMIT 100;

-- Конкретный пользователь.
SELECT domain, path, method, reason, created_at
FROM {SCHEMA}.{PREFIX}access_denied_audit
WHERE username = '<username>'
  AND created_at > now() - interval '7 days'
ORDER BY created_at DESC;

-- Топ-доменов по отказам.
SELECT domain, count(*) AS denied
FROM {SCHEMA}.{PREFIX}access_denied_audit
WHERE created_at > now() - interval '7 days'
GROUP BY domain
ORDER BY denied DESC;
```

Каждая запись — это случай, когда `require_domain_access(domain)` вернул 403 (`app/api/v1/deps/role_deps.py:160-177`). Поле `reason` показывает роли пользователя и какой `domain_name` ему не хватило.

См. dev-guide §9.5c.

---

## 7. Полная остановка пользовательского процесса

Если процесс висит и не реагирует на нормальный shutdown.

**Сначала gracefully — `SIGTERM`.** Uvicorn ждёт ≤5 сек для graceful drain (остановка фоновых задач, финальный flush батчеров, release singleton-lock). Большинство сценариев обрабатываются.

**Forcibly — `SIGKILL`.** Если SIGTERM не сработал за 30 сек:

```bash
# Найти процесс.
ps -u <user> -f | grep "uvicorn\|app.main"
kill -9 <pid>
```

После SIGKILL:

- **Singleton-lock**: строка в `app_singleton_lock` останется. Следующий старт через `SECURITY__SINGLETON_LOCK_STALE_TTL_SEC` сек (default 60) перезапишет её автоматически. Если нужно стартовать раньше — DELETE вручную (см. §2).
- **Активные forward'ы**: соответствующие `chat_messages` останутся в `status='streaming'`. При следующем старте `AgentChannelPoller.reconcile()` восстановит подписки по `agent_ref`.
- **Дропнутые метрики**: всё, что было в буферах батчеров — потеряно.

**Не делать SIGKILL когда:**

- Активный сохранение акта в `acts.audit_log_batcher` (потеряется аудит). Подождать ~30 сек после последней пользовательской активности.
- Активный forward к внешнему агенту (`chat_messages.status='streaming'` с непустым `agent_ref`). После SIGKILL черновик остаётся в `streaming`; финализация/таймаут не отработают — состояние подвиснет до reconcile следующего старта.

---

## 8. Redis лёг

**Симптом.** Приложение не стартует: `RuntimeError: Redis недоступен (<host>:<port>/<db>) … Redis обязателен во всех окружениях`. Либо процесс жив, но пользователи не могут войти (ОТП-код «не принимается»), в логе — WARNING'и о недоступности кеша, а взятие акта в работу падает с 5xx.

**Как это работает.** Redis — обязательная зависимость, подключается startup-хуком `auth.redis` (`app/auth/lifecycle.py:69`) по принципу fail-fast. На нём живут: ОТП-коды и сессии авторизации, кеши (роли, user-контекст, счётчик непрочитанных уведомлений), блокировки актов (`lock:act:{act_id}` с TTL, `app/domains/acts/repositories/act_lock_backends.py`) и очередь LLM-моста (`llm:bridge:*`).

**Диагностика.**

```bash
redis-cli -h <REDIS__HOST> -p <REDIS__PORT> PING          # ожидаем PONG
redis-cli -h <REDIS__HOST> -p <REDIS__PORT> INFO server | grep redis_version   # нужен >= 7.0
redis-cli -h <REDIS__HOST> -p <REDIS__PORT> -n <REDIS__DB> DBSIZE
```

**Recovery.**

1. Поднять Redis / восстановить сетевую доступность, затем **перезапустить приложение**, если оно упало на старте.
2. Данные восстанавливать не нужно и негде: ОТП-коды короткоживущие (`AUTH__OTP_TTL`, 300 сек — пользователь просто запросит код заново), кеши перезаполнятся сами, блокировки актов исчезают вместе с ключами (акты становятся свободными — это безопасное состояние), заявки моста эфемерны.
3. Проверить, что не потерялись «повисшие» блокировки: отдельного сборщика просроченных локов нет и не нужно — истечение обеспечивает TTL Redis.
4. После восстановления — smoke по §2 runbook'а: вход по ОТП, открытие акта, сообщение в чат.

**См. также:** [`troubleshooting.md` №23](troubleshooting.md#23-redis-недоступен-приложение-не-стартует--ошибки-блокировок), `app/core/redis.py`.

---

## 9. Воркер LLM-моста не отвечает

**Симптом.** При маршруте `CHAT__PROFILE=redis-bridge,…` чат на любой вопрос отдаёт ошибку недоступности LLM (иногда мгновенно), тогда как остальное приложение работает штатно.

**Как это работает.** Запрос к локальной LLM исполняется воркером в Jupyter DataLab: приложение кладёт заявку в Redis Stream `llm:bridge:requests` и ждёт ответ в `llm:bridge:resp:{id}`. Перед отправкой проверяется heartbeat `llm:bridge:worker:alive` (TTL 45 сек).

**Диагностика.**

```bash
redis-cli -h <REDIS__HOST> -p <REDIS__PORT> GET llm:bridge:worker:alive   # JSON: worker_id, targets, target_health
redis-cli -h <REDIS__HOST> -p <REDIS__PORT> XLEN llm:bridge:requests      # глубина очереди заявок
```

Плюс `/admin/diagnostics` → `background_tasks."chat.llm_health_probe"`: поля `breaker_state` и `last_ping_ok` показывают, видит ли приложение primary-маршрут живым.

**Recovery.**

1. Запустить/перезапустить воркер: `scripts/llm_redis_worker.ipynb` в DataLab, Run All. Рестарт приложения при этом **не нужен** — клиент моста не кеширует «воркер мёртв».
2. Если heartbeat есть, а нужной цели нет в `targets` — в окружении ноутбука не задан URL цели (`GIGACHAT_API_URL` / `OPENAI_API_URL`).
3. Если очередь `llm:bridge:requests` растёт, а ответов нет — воркер завис; Kernel → Interrupt и повторный Run All. Незаконченные заявки подхватит `XAUTOCLAIM` следующего запуска (min-idle 10 мин), просроченные по `deadline_ts` будут пропущены.
4. Временная мера — переключить `CHAT__PROFILE` на прямой маршрут (`gigachat` / `openai`) с рестартом приложения; **работает только там, где у площадки есть прямой сетевой доступ к бэкенду LLM** — с SDP его нет.

**См. также:** [`troubleshooting.md` №7](troubleshooting.md#7-llm-мост-redis-bridge-воркер-недоступен--дедлайн-заявки), [`redis-llm-bridge.md`](../integrations/redis-llm-bridge.md) §8-§9.
