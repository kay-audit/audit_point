# `chat_agent_messages_bus` — статус `error` и роль `tool` в CHECK'ах

**Тип изменения**: расширяющее (два CHECK-констрейнта расширяются новыми
допустимыми значениями, данные не трогаются). Пересоздавать БД не нужно —
правила и формат таких файлов см. в
[`database.md` §6.5.5](../guides/database.md#655-файлы-миграций-для-развёрнутых-бд).

**Кому нужна**: **только дев-стендам с локальной имитацией шины** — тем, где
таблицу `chat_agent_messages_bus` создало само приложение
(`create_tables_if_not_exist` по `app/domains/chat/migrations/*/schema.sql`).
ПРОМ-таблицей владеет сторона агента (NanoBot), и CHECK'ов на ней нет вообще —
там накатывать нечего. На чистой дев-БД накатывать тоже не надо: расширенные
списки уже объявлены в обеих `schema.sql`.

**Что меняется**:

| Констрейнт | Было | Стало |
|---|---|---|
| `check_chat_agent_messages_bus_status_values` | `pending, processing, completed, failed` | + `error` |
| `check_chat_agent_messages_bus_role_values` | `user, assistant, system` | + `tool` |

`error` в словаре NanoBot 2.3 — **повторяемая** ошибка: пока
`retry_count < max_stuck_retries`, агент возвращает вопрос в пул через
`error_retry_delay` и переобрабатывает его, удаляя свою строку-ответ.
Терминальным остаётся только `failed`. Роль `tool` агент использует для
служебных сообщений своего цикла.

**Если не накатить**: приложение стартует и работает, но локальная имитация
расходится с реальным агентом — `UPDATE … SET status = 'error'` (в том числе
из сниппетов `docs/integrations/external-agent-imitation.sql`) падает
`asyncpg.CheckViolationError`, и повторяемую ошибку на дев-стенде
воспроизвести нельзя. На ПРОМе не проявляется никак.

**Бэкфилл не нужен**: существующие строки уже удовлетворяют расширенным
спискам — расширение множества допустимых значений не может сделать
валидную строку невалидной.

**Префикс**: к имени шины `DATABASE__TABLE_PREFIX` **не приклеивается** — оно
задаётся настройкой `CHAT__AGENT_CHANNEL__TABLE_NAME` целиком (дефолт
`chat_agent_messages_bus`). Если в `.env` имя другое — подставить руками.

**Схема для PG**: без квалификатора (схема `public`).
**Схема для GP**: значение `DATABASE__GP__SCHEMA` из `.env` (либо
`CHAT__AGENT_CHANNEL__SCHEMA_NAME`, если шина вынесена в отдельную схему).
**Сверь перед запуском:** в `.env.dev` это `s_grnplm_ld_audit_da_project_4`
(подставлено в SQL ниже), а в `.env.prod` — **`s_grnplm_ld_audit_da_project_34`**
(но на ПРОМе таблица чужая — см. «Кому нужна»).

---

## 1. PostgreSQL (dev-инсталляция)

```sql
-- Статус 'error' — повторяемая ошибка NanoBot 2.3 (терминален только 'failed').
ALTER TABLE chat_agent_messages_bus
    DROP CONSTRAINT check_chat_agent_messages_bus_status_values;
ALTER TABLE chat_agent_messages_bus
    ADD CONSTRAINT check_chat_agent_messages_bus_status_values
    CHECK (status IN ('pending','processing','completed','failed','error'));

-- Роль 'tool' — служебные сообщения цикла агента.
ALTER TABLE chat_agent_messages_bus
    DROP CONSTRAINT check_chat_agent_messages_bus_role_values;
ALTER TABLE chat_agent_messages_bus
    ADD CONSTRAINT check_chat_agent_messages_bus_role_values
    CHECK (role IN ('user','assistant','system','tool'));
```

## 2. Greenplum (dev-стенд с локальной имитацией шины)

```sql
-- Статус 'error' — повторяемая ошибка NanoBot 2.3 (терминален только 'failed').
ALTER TABLE s_grnplm_ld_audit_da_project_4.chat_agent_messages_bus
    DROP CONSTRAINT check_chat_agent_messages_bus_status_values;
ALTER TABLE s_grnplm_ld_audit_da_project_4.chat_agent_messages_bus
    ADD CONSTRAINT check_chat_agent_messages_bus_status_values
    CHECK (status IN ('pending','processing','completed','failed','error'));

-- Роль 'tool' — служебные сообщения цикла агента.
ALTER TABLE s_grnplm_ld_audit_da_project_4.chat_agent_messages_bus
    DROP CONSTRAINT check_chat_agent_messages_bus_role_values;
ALTER TABLE s_grnplm_ld_audit_da_project_4.chat_agent_messages_bus
    ADD CONSTRAINT check_chat_agent_messages_bus_role_values
    CHECK (role IN ('user','assistant','system','tool'));
```

**Без `IF EXISTS` у `DROP CONSTRAINT`** — GP 6.x (= PG 9.4) поддерживает эту
форму, но опираться на неё не нужно: если констрейнта нет (таблицу создал
владелец), `DROP` упадёт с `constraint … does not exist` — это и есть сигнал,
что миграция не для этой инсталляции. Ничего при этом не изменено, запускать
без `ON_ERROR_STOP`.

---

## Проверка

```sql
-- PG
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'chat_agent_messages_bus'::regclass
  AND conname LIKE 'check_chat_agent_messages_bus_%';
-- Ожидается: в определении status-констрейнта присутствует 'error',
--            в определении role-констрейнта — 'tool'.
```

Функциональная проверка (обе СУБД) — вставка строки с новым статусом проходит:

```sql
INSERT INTO chat_agent_messages_bus
    (id, chat_id, user_id, role, content, status, created_at, updated_at)
VALUES (md5(random()::text || clock_timestamp()::text)::uuid,
        'migration-check', 'migration-check', 'user', 'проверка CHECK',
        'error', now(), now());

DELETE FROM chat_agent_messages_bus WHERE chat_id = 'migration-check';
```

## Откат

Обратные `ALTER`: снять расширенные констрейнты и вернуть прежние списки.

```sql
ALTER TABLE chat_agent_messages_bus
    DROP CONSTRAINT check_chat_agent_messages_bus_status_values;
ALTER TABLE chat_agent_messages_bus
    ADD CONSTRAINT check_chat_agent_messages_bus_status_values
    CHECK (status IN ('pending','processing','completed','failed'));

ALTER TABLE chat_agent_messages_bus
    DROP CONSTRAINT check_chat_agent_messages_bus_role_values;
ALTER TABLE chat_agent_messages_bus
    ADD CONSTRAINT check_chat_agent_messages_bus_role_values
    CHECK (role IN ('user','assistant','system'));
```

Откат упадёт, если в таблице уже есть строки со `status = 'error'` или
`role = 'tool'` — сначала удали их (это завершённые/мусорные строки шины).
Откатывать при откате приложения на предыдущую версию **не требуется**:
расширенный CHECK старой версии не мешает.
