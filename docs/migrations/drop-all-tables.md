# DROP-команды для таблиц приложения

Скрипт для **ручной очистки БД** под Audit Workstation — дропает только
**собственные таблицы приложения** (домены `acts`, `admin`, `chat`,
`notifications`).
**Без `CASCADE`**: таблицы дропаются в обратном порядке FK-зависимостей.

> **Справочники и ETL-данные — отдельным скриптом.** Таблицы-справочники
> (`t_db_oarb_ua_*`), реестр метрик и таблицы ЦК-валидации
> (`t_db_oarb_ck_*`, вью `v_db_oarb_ck_*`) здесь **не дропаются** — для них
> есть [`drop-reference-tables.md`](drop-reference-tables.md). На проде это
> внешние данные, управляемые ETL; в dev-реплике (PG) — пересоздаются при старте
> приложения вместе с демоданными.

**Префикс**: `t_db_oarb_audit_act_` (значение `DATABASE__TABLE_PREFIX` по умолчанию).
Если в `.env` префикс другой — подставить руками (`s/t_db_oarb_audit_act_/<your_prefix>/g`).

**Схема для PG**: без квалификатора (схема `public`).
**Схема для GP**: `s_grnplm_ld_audit_da_project_4` (значение `DATABASE__GP__SCHEMA` из `.env`; подставить своё при отличии).

**Внимание**:
- **Намеренно без `CASCADE`.** От рабочих таблиц могли быть сделаны зависимые
  объекты — вью, исторические копии/снимки. `CASCADE` снёс бы их вместе с
  таблицей, в т.ч. исторические данные. Поэтому дропаем строго в обратном
  порядке FK-зависимостей. Если на таблице висит чужой зависимый объект, `DROP`
  упадёт с ошибкой зависимости — это **сигнал разобраться вручную**, а не молча
  потерять данные. Запускать в инструменте, который НЕ останавливает весь
  батч на первой ошибке (psql без `ON_ERROR_STOP`, DBeaver «Execute script»),
  чтобы единичная зависимость не оборвала остальной сброс.
- Если задан `CHAT__SCHEMA_NAME` и/или `CHAT__AGENT_CHANNEL__SCHEMA_NAME`, таблицы чата / bus-таблица создаются в указанной схеме — дропать их в ней, а не в основной.
- **Bus-таблица — без app-префикса**: её имя задаётся `CHAT__AGENT_CHANNEL__TABLE_NAME` целиком (дефолт `chat_agent_messages_bus`, **без** `DATABASE__TABLE_PREFIX`). Здесь подставлено фактическое имя из `.env` (`t_db_oarb_audit_act_chat_agent_messages_bus`). Если задано другое — подставить его.
- Sequences дропаются ПОСЛЕ таблиц, у которых они в DEFAULT.

> **Важно про пересоздание.** Приложение на старте (`create_tables_if_not_exist`)
> создаёт только **ОТСУТСТВУЮЩИЕ таблицы целиком** и НЕ добавляет новые колонки в
> уже существующую таблицу (проверяется лишь наличие таблиц). Поэтому при
> изменении схемы существующей таблицы нужен полный дроп (этот скрипт) и
> пересоздание. Чтобы такое расхождение не
> всплывало рантайм-ошибкой (`UndefinedColumnError`), при старте работает
> диагностика: если таблица существует, но устарела по колонкам, в лог пишется
> WARNING со списком недостающих колонок (см. `developer-guide.md` §6.5.4).

---

## 1. PostgreSQL (dev-инсталляция)

```sql
-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  Домен CHAT (зависимые → родительские)                              ║
-- ╚══════════════════════════════════════════════════════════════════════╝
DROP TABLE IF EXISTS t_db_oarb_audit_act_chat_audit_log;
DROP TABLE IF EXISTS t_db_oarb_audit_act_chat_tool_metrics;
DROP TABLE IF EXISTS t_db_oarb_audit_act_chat_message_feedback;
-- ВНИМАНИЕ: имя bus-таблицы задаётся ЦЕЛИКОМ через CHAT__AGENT_CHANNEL__TABLE_NAME
-- (дефолт chat_agent_messages_bus, БЕЗ префикса DATABASE__TABLE_PREFIX).
-- Если в .env задано другое значение — подставить его здесь вместо
-- t_db_oarb_audit_act_chat_agent_messages_bus, иначе DROP не найдёт таблицу.
DROP TABLE IF EXISTS t_db_oarb_audit_act_chat_agent_messages_bus;
DROP TABLE IF EXISTS t_db_oarb_audit_act_chat_files;
DROP TABLE IF EXISTS t_db_oarb_audit_act_chat_messages;
DROP TABLE IF EXISTS t_db_oarb_audit_act_chat_conversations;

-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  Домен NOTIFICATIONS (центр уведомлений)                            ║
-- ╚══════════════════════════════════════════════════════════════════════╝
DROP TABLE IF EXISTS t_db_oarb_audit_act_notification_state;
DROP TABLE IF EXISTS t_db_oarb_audit_act_notifications;

-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  Домен ACTS (зависимые → родительские)                              ║
-- ╚══════════════════════════════════════════════════════════════════════╝
DROP TABLE IF EXISTS t_db_oarb_audit_act_audit_log;
DROP TABLE IF EXISTS t_db_oarb_audit_act_act_editor_telemetry;
DROP TABLE IF EXISTS t_db_oarb_audit_act_act_content_versions;
DROP TABLE IF EXISTS t_db_oarb_audit_act_act_invoices;
DROP TABLE IF EXISTS t_db_oarb_audit_act_act_violations;
DROP TABLE IF EXISTS t_db_oarb_audit_act_act_textblocks;
DROP TABLE IF EXISTS t_db_oarb_audit_act_act_tables;
DROP TABLE IF EXISTS t_db_oarb_audit_act_act_tree;
DROP TABLE IF EXISTS t_db_oarb_audit_act_act_directives;
DROP TABLE IF EXISTS t_db_oarb_audit_act_audit_team_members;
DROP TABLE IF EXISTS t_db_oarb_audit_act_acts;

-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  Домен ADMIN (зависимые → родительские)                             ║
-- ╚══════════════════════════════════════════════════════════════════════╝
DROP TABLE IF EXISTS t_db_oarb_audit_act_admin_http_metrics;
DROP TABLE IF EXISTS t_db_oarb_audit_act_admin_audit_log;
DROP TABLE IF EXISTS t_db_oarb_audit_act_access_denied_audit;
DROP TABLE IF EXISTS t_db_oarb_audit_act_app_singleton_lock;
DROP TABLE IF EXISTS t_db_oarb_audit_act_user_roles;
DROP TABLE IF EXISTS t_db_oarb_audit_act_roles;

-- Standalone sequence admin-домена (не owned через BIGSERIAL → DROP TABLE её не удаляет)
DROP SEQUENCE IF EXISTS t_db_oarb_audit_act_access_denied_audit_id_seq;
```

---

## 2. Greenplum (прод-инсталляция)

> Схема `s_grnplm_ld_audit_da_project_4` (значение `DATABASE__GP__SCHEMA` из `.env`; подставить своё при отличии).
> Справочники и ЦК-данные (`t_db_oarb_ua_*`, `t_db_oarb_ck_*`) на GP — внешние ETL-данные, в этом скрипте не дропаются.

```sql
-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  Домен CHAT (зависимые → родительские)                              ║
-- ╚══════════════════════════════════════════════════════════════════════╝
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_chat_audit_log;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_chat_tool_metrics;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_chat_message_feedback;
-- ВНИМАНИЕ: имя bus-таблицы задаётся ЦЕЛИКОМ через CHAT__AGENT_CHANNEL__TABLE_NAME
-- (дефолт chat_agent_messages_bus, БЕЗ префикса DATABASE__TABLE_PREFIX).
-- Если в .env задано другое значение — подставить его здесь вместо
-- t_db_oarb_audit_act_chat_agent_messages_bus, иначе DROP не найдёт таблицу.
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_chat_agent_messages_bus;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_chat_files;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_chat_messages;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_chat_conversations;

-- Sequences chat-домена
DROP SEQUENCE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_chat_tool_metrics_id_seq;
DROP SEQUENCE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_chat_audit_log_id_seq;

-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  Домен NOTIFICATIONS (центр уведомлений)                            ║
-- ╚══════════════════════════════════════════════════════════════════════╝
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_notification_state;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_notifications;

-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  Домен ACTS (зависимые → родительские)                              ║
-- ╚══════════════════════════════════════════════════════════════════════╝
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_audit_log;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_act_editor_telemetry;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_act_content_versions;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_act_invoices;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_act_violations;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_act_textblocks;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_act_tables;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_act_tree;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_act_directives;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_audit_team_members;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_acts;

-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  Домен ADMIN (зависимые → родительские)                             ║
-- ╚══════════════════════════════════════════════════════════════════════╝
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_admin_http_metrics;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_admin_audit_log;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_access_denied_audit;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_app_singleton_lock;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_user_roles;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_roles;

-- Sequences admin-домена (standalone: PK+DISTRIBUTED BY (id) не допускает BIGSERIAL)
DROP SEQUENCE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_admin_http_metrics_id_seq;
DROP SEQUENCE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_access_denied_audit_id_seq;
```

---

## Проверка после дропа

```sql
-- PG
SELECT tablename FROM pg_tables
WHERE tablename LIKE 't_db_oarb_audit_act_%'
ORDER BY tablename;
-- Ожидается: 0 строк.

-- GP
SELECT tablename FROM pg_tables
WHERE schemaname = 's_grnplm_ld_audit_da_project_4'
  AND tablename LIKE 't_db_oarb_audit_act_%'
ORDER BY tablename;
-- Ожидается: 0 строк.
```

После дропа при следующем старте `uvicorn` приложение пересоздаст все таблицы из миграций
(`app/domains/*/migrations/{postgresql,greenplum}/schema.sql` через `create_tables_if_not_exist`).
