# Миграция: колонка `invoices_data` в `act_content_versions` (2026-07-14)

Колонка `invoices_data` (снимок прикреплённых фактур в версии содержимого акта,
решение Q2 волны `violations-audit-fixes`) добавлена в `schema.sql` обеих СУБД.
`create_tables_if_not_exist` создаёт только отсутствующие таблицы целиком и **не
добавляет колонки в существующие** — на БД, развёрнутых до 2026-07-14, нужен
ручной `ALTER`.

**Без колонки каждое сохранение акта падает с откатом транзакции**: снимок версии
пишется в той же транзакции, что и сохранение содержимого. Тесты идут на моках,
поэтому зелёные гейты наличие колонки в реальной БД не подтверждают.

## SQL (PostgreSQL и Greenplum — одинаково)

```sql
ALTER TABLE <схема>.<префикс>act_content_versions
    ADD COLUMN invoices_data JSONB NOT NULL DEFAULT '{}';
```

Подстановки — как в миграциях (`{SCHEMA}.{PREFIX}`):

- **PostgreSQL (dev)**: без схемы; префикс — `DATABASE__TABLE_PREFIX`
  (дефолт `t_db_oarb_audit_act_`), т.е.
  `ALTER TABLE t_db_oarb_audit_act_act_content_versions ...`.
- **Greenplum (прод)**: схема из `DATABASE__GP__SCHEMA`
  (в проде `s_grnplm_ld_audit_da_project_4`), тот же префикс.

Новые БД в порядке: колонка есть в
`app/domains/acts/migrations/postgresql/schema.sql` и
`app/domains/acts/migrations/greenplum/schema.sql`, паритет схем закреплён
`tests/test_gp_compatibility.py`.

## Связанное

Если БД создана до появления дедупликации версий, той же таблице нужна и колонка
`content_hash` — SQL и детали в
[`docs/architecture/data-model-acts.md`](../architecture/data-model-acts.md)
(раздел «Дедупликация версий»).
