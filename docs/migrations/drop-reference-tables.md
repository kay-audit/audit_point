# DROP-команды для справочников и ETL-данных

Скрипт для **ручной очистки справочных / ETL-управляемых данных** Audit Workstation —
то, что НЕ дропает [`drop-all-tables.md`](drop-all-tables.md) (там только собственные
таблицы приложения).

**Зачем:** в **тестовой** среде эти таблицы наполняются демоданными при старте
приложения (PG: `create_tables_if_not_exist` пересоздаёт их вместе с сидами из
`schema.sql`; на проде/GP — внешний ETL). Чтобы пересобрать их с нуля, нужно
снести всё разом — поштучно не получится из-за зависимостей. Этот скрипт сносит
их в корректном порядке.

> **ВНИМАНИЕ — на проде это внешние данные ETL.** На боевом Greenplum
> справочники (`t_db_oarb_ua_*`) и реестр метрик — read-only данные, которыми
> владеет ETL; таблицы ЦК-валидации (`t_db_oarb_ck_*`) наполняются ETL, но
> пишутся и приложением. **Запускайте этот скрипт только в среде, которую
> намеренно собираетесь перенаполнить.** Не для боевого GP.

**Имена — литеральные, БЕЗ app-префикса.** Справочники называются
`t_db_oarb_ua_*` / `t_db_oarb_ck_*` целиком и **не** несут `DATABASE__TABLE_PREFIX`.
Поэтому замена `s/t_db_oarb_audit_act_/<prefix>/g` из `drop-all-tables.md` их **не
касается** — подставлять префикс здесь не нужно.

- `t_db_oarb_ua_user` — имя из `ADMIN__USER_DIRECTORY__TABLE` (дефолт `t_db_oarb_ua_user`).
- `t_db_oarb_ua_hadoop_tables` — имя из `ACTS__INVOICE__HIVE_REGISTRY_TABLE`.
- `t_db_oarb_ck_validation_reestr_metric` — реестр метрик (формат ФР00001), на проде
  существует только во внешнем ETL; в dev-реплике может отсутствовать → дропаем через
  `IF EXISTS`.

**Схема для PG**: без квалификатора (схема `public`).

**Схема для GP — не одна.** У каждой группы таблиц она берётся из своей настройки,
и это **не обязательно** `DATABASE__GP__SCHEMA` (на ПРОМе тот равен
`s_grnplm_ld_audit_da_project_34`, тогда как часть справочников живёт в `_4`):

| Таблицы | Настройка | Значение в `.env.prod` |
|---|---|---|
| `t_db_oarb_ua_*` (словари и факты) | `UA_DATA__SCHEMA_NAME` | пусто → основная схема адаптера (`DATABASE__GP__SCHEMA`) |
| `t_db_oarb_ua_user` | `ADMIN__USER_DIRECTORY__SCHEMA` | пусто → основная схема адаптера (`DATABASE__GP__SCHEMA`, `_project_34`) |
| `t_db_oarb_ua_hadoop_tables` | `ACTS__INVOICE__HIVE_REGISTRY_SCHEMA` | `s_grnplm_ld_audit_da_project_4` |
| `t_db_oarb_ck_fr_validation` + вью | `CK_FIN_RES__SCHEMA_NAME` | `s_grnplm_ld_audit_da_project_4` |
| `t_db_oarb_ck_cs_validation` + вью | `CK_CLIENT_EXP__SCHEMA_NAME` | `s_grnplm_ld_audit_da_project_4` |

В SQL ниже подставлена `s_grnplm_ld_audit_da_project_4` — сверь с `.env` своей среды
перед запуском.

**Правила те же, что в `drop-all-tables.md`:**
- **Без `CASCADE`.** Дропаем в обратном порядке зависимостей (вью — до таблиц, на
  которые они ссылаются; дочерние факты — до родительских). Физических FK в
  UA-схеме нет (связи логические), поэтому порядок — подстраховка, а не жёсткое
  требование.
- Запускать в инструменте, который НЕ останавливает батч на первой ошибке
  (psql без `ON_ERROR_STOP`, DBeaver «Execute script»).
- **Таблицы ЦК-валидации** (`t_db_oarb_ck_fr_validation` / `t_db_oarb_ck_cs_validation`
  и их VIEW) — это данные приложения, на проде наполняемые ETL. Если в текущей среде
  их сбрасывать не нужно, закомментируйте соответствующий блок.

---

## 1. PostgreSQL (dev-инсталляция)

```sql
-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  VIEW ЦК (дропать ДО таблиц, на которые ссылаются)                  ║
-- ╚══════════════════════════════════════════════════════════════════════╝
DROP VIEW IF EXISTS v_db_oarb_ck_fr_validation;
DROP VIEW IF EXISTS v_db_oarb_ck_cs_validation;

-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  Таблицы ЦК-валидации (пишутся приложением, на проде — ETL)         ║
-- ║  Закомментируйте этот блок, если их сбрасывать не нужно.            ║
-- ╚══════════════════════════════════════════════════════════════════════╝
DROP TABLE IF EXISTS t_db_oarb_ck_fr_validation;
DROP TABLE IF EXISTS t_db_oarb_ck_cs_validation;

-- Реестр метрик (только во внешнем ETL; в dev-реплике может отсутствовать).
DROP TABLE IF EXISTS t_db_oarb_ck_validation_reestr_metric;

-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  Справочники и факты UA_DATA (дочерние → родительские)              ║
-- ╚══════════════════════════════════════════════════════════════════════╝
DROP TABLE IF EXISTS t_db_oarb_ua_violation_ior_metric;
DROP TABLE IF EXISTS t_db_oarb_ua_violation_mkr_metric;
DROP TABLE IF EXISTS t_db_oarb_ua_violation_cs_metric;
DROP TABLE IF EXISTS t_db_oarb_ua_violation_fr_metric;
DROP TABLE IF EXISTS t_db_oarb_ua_violation_facts;
DROP TABLE IF EXISTS t_db_oarb_ua_violation_clients;
DROP TABLE IF EXISTS t_db_oarb_ua_sub_number;
DROP TABLE IF EXISTS t_db_oarb_ua_team_member_by_km;
DROP TABLE IF EXISTS t_db_oarb_ua_team_dict;
DROP TABLE IF EXISTS t_db_oarb_ua_violation_risk_type_dict;
DROP TABLE IF EXISTS t_db_oarb_ua_violation_metric_dict;
DROP TABLE IF EXISTS t_db_oarb_ua_departments;
DROP TABLE IF EXISTS t_db_oarb_ua_subsidiary_dict;
DROP TABLE IF EXISTS t_db_oarb_ua_product_dict;
DROP TABLE IF EXISTS t_db_oarb_ua_channel_dict;
DROP TABLE IF EXISTS t_db_oarb_ua_vsp_dict;
DROP TABLE IF EXISTS t_db_oarb_ua_gosb_dict;
DROP TABLE IF EXISTS t_db_oarb_ua_terbank_dict;
DROP TABLE IF EXISTS t_db_oarb_ua_process_dict;

-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  Реплики справочников из других доменов (PG-only)                   ║
-- ╚══════════════════════════════════════════════════════════════════════╝
DROP TABLE IF EXISTS t_db_oarb_ua_user;           -- ADMIN__USER_DIRECTORY__TABLE
DROP TABLE IF EXISTS t_db_oarb_ua_hadoop_tables;  -- ACTS__INVOICE__HIVE_REGISTRY_TABLE
```

---

## 2. Greenplum (тестовая среда, перенаполняемая ETL)

> Схема `s_grnplm_ld_audit_da_project_4` ниже — это **два разных случая**, не путать:
> для `ACTS__INVOICE__HIVE_REGISTRY_SCHEMA` / `CK_FIN_RES__SCHEMA_NAME` /
> `CK_CLIENT_EXP__SCHEMA_NAME` она захардкожена (`_4` в любом окружении, включая
> ПРОМ — **не** `DATABASE__GP__SCHEMA`); для `UA_DATA__SCHEMA_NAME` /
> `ADMIN__USER_DIRECTORY__SCHEMA` (обе по умолчанию пустые) значение `_4` — это
> просто основная GP-схема **этого конкретного** dev/test-окружения
> (`DATABASE__GP__SCHEMA`), в другом тест-стенде она может быть другой. Сверь со
> своим `.env` перед запуском.
> **Только для тест-среды, которую вы намеренно перезаполняете** — на боевом GP это
> данные ETL.

```sql
-- VIEW ЦК (до таблиц)
DROP VIEW IF EXISTS s_grnplm_ld_audit_da_project_4.v_db_oarb_ck_fr_validation;
DROP VIEW IF EXISTS s_grnplm_ld_audit_da_project_4.v_db_oarb_ck_cs_validation;

-- Таблицы ЦК-валидации (закомментируйте, если сбрасывать не нужно)
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ck_fr_validation;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ck_cs_validation;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ck_validation_reestr_metric;

-- Справочники и факты UA_DATA (дочерние → родительские)
-- UA_DATA__SCHEMA_NAME по умолчанию пуст (основная схема адаптера) — как и у
-- t_db_oarb_ua_user ниже, сверьте фактическую схему со своим .env этой среды.
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ua_violation_ior_metric;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ua_violation_mkr_metric;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ua_violation_cs_metric;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ua_violation_fr_metric;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ua_violation_facts;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ua_violation_clients;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ua_sub_number;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ua_team_member_by_km;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ua_team_dict;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ua_violation_risk_type_dict;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ua_violation_metric_dict;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ua_departments;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ua_subsidiary_dict;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ua_product_dict;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ua_channel_dict;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ua_vsp_dict;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ua_gosb_dict;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ua_terbank_dict;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ua_process_dict;

-- Реплики справочников из других доменов
-- t_db_oarb_ua_user: ADMIN__USER_DIRECTORY__SCHEMA по умолчанию пуст (основная
-- схема адаптера) — сверьте фактическую схему со своим .env этой среды.
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ua_user;
DROP TABLE IF EXISTS s_grnplm_ld_audit_da_project_4.t_db_oarb_ua_hadoop_tables;
```

---

## Проверка после дропа

```sql
-- PG: справочники UA/CK снесены
SELECT tablename FROM pg_tables
WHERE tablename LIKE 't_db_oarb_ua_%' OR tablename LIKE 't_db_oarb_ck_%'
ORDER BY tablename;
-- Ожидается: 0 строк (если сбрасывали и ЦК-блок).

-- GP
SELECT tablename FROM pg_tables
WHERE schemaname = 's_grnplm_ld_audit_da_project_4'
  AND (tablename LIKE 't_db_oarb_ua_%' OR tablename LIKE 't_db_oarb_ck_%')
ORDER BY tablename;
-- Если DATABASE__GP__SCHEMA твоей тест-среды не _project_4 (UA_DATA/user
-- следуют за ней), замени схему в фильтре — иначе проверка тихо покажет
-- 0 строк, даже если DROP ушёл не в ту схему.
```

После дропа справочники пересоздаются: на dev-PG — при следующем старте `uvicorn`
(`create_tables_if_not_exist` + демосиды из `schema.sql`); на GP — внешним ETL.
