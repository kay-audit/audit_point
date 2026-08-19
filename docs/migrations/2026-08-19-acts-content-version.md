# `acts.content_version` — счётчик версий содержимого

**Тип изменения**: расширяющее (одна новая колонка). Пересоздавать БД не нужно —
правила и формат таких файлов см. в
[`database.md` §6.5.5](../guides/database.md#655-файлы-миграций-для-развёрнутых-бд).

**Кому нужна**: инсталляциям, развёрнутым до 2026-08-19. На чистой БД накатывать
не надо: колонка объявлена в `app/domains/acts/migrations/{postgresql,greenplum}/schema.sql`,
и `create_tables_if_not_exist` создаст таблицу сразу с ней.

**Что добавляется**: `content_version INTEGER NOT NULL DEFAULT 0` в таблицу `acts`.
Счётчик версий **содержимого** для optimistic-проверки конкурентного редактирования
(`PUT /content`): фронт получает его в `metadata.content_version`, эхом возвращает
в `expected_content_version` следующего PUT, расхождение → 409 `content-conflict`.
Инкрементируется единственной точкой — `_update_edit_timestamp`
(`app/domains/acts/repositories/act_content.py`), поэтому НЕ-контентные записи
(правка метаданных, пересчёт `total_parts`) ложных конфликтов не дают — в отличие
от `updated_at`.

Индексов, констрейнтов, `COMMENT ON` и sequence изменение не добавляет: для
`content_version` их нет и в `schema.sql`.

**Если не накатить**: приложение стартует, но открытие любого акта падает
`asyncpg.UndefinedColumnError` — колонка перечислена в `SELECT` явно
(`app/domains/acts/repositories/act_crud.py`, `_fetch_act`). На старте о том же
предупредит диагностика дрейфа колонок ([`database.md` §6.5.4](../guides/database.md#654-startup-диагностика-дрейфа-колонок-рассинхрон-схемы--кода)).

**Бэкфилл не нужен.** `0` — валидное значение, ровно такое же, как у только что
созданного акта, который ещё ни разу не сохранял контент. Счётчик монотонен от
момента миграции, история ему не требуется: первое открытие старого акта отдаст
фронту `0`, первый PUT вернёт эхом `expected_content_version: 0`, сверка совпадёт,
счётчик станет `1`. Ложных 409 на легаси-строках не будет.

**Префикс**: `t_db_oarb_audit_act_` (значение `DATABASE__TABLE_PREFIX` по умолчанию).
Если в `.env` префикс другой — подставить руками.

**Схема для PG**: без квалификатора (схема `public`).
**Схема для GP**: значение `DATABASE__GP__SCHEMA` из `.env`. **Сверь перед запуском:**
в `.env.dev` это `s_grnplm_ld_audit_da_project_4` (подставлено в SQL ниже), а в
`.env.prod` — **`s_grnplm_ld_audit_da_project_34`**.

---

## 1. PostgreSQL (dev-инсталляция)

```sql
-- Счётчик версий СОДЕРЖИМОГО (optimistic-проверка PUT /content).
-- Инкрементируется ТОЛЬКО при сохранении контента (_update_edit_timestamp);
-- правки метаданных и total_parts его не трогают — в отличие от updated_at.
ALTER TABLE t_db_oarb_audit_act_acts
    ADD COLUMN IF NOT EXISTS content_version INTEGER NOT NULL DEFAULT 0;
```

## 2. Greenplum (прод-инсталляция)

```sql
-- Счётчик версий СОДЕРЖИМОГО (optimistic-проверка PUT /content).
-- Инкрементируется ТОЛЬКО при сохранении контента (_update_edit_timestamp);
-- правки метаданных и total_parts его не трогают — в отличие от updated_at.
ALTER TABLE s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_acts
    ADD COLUMN content_version INTEGER NOT NULL DEFAULT 0;
```

**Без `IF NOT EXISTS`** — GP 6.x (= PG 9.4) этого синтаксиса не знает
([`database.md` §6.5.1](../guides/database.md#651-правила-миграций), регрессия
`test_no_add_column_if_not_exists`). Повторный запуск упадёт с
`duplicate column name: content_version` — это безопасно: ничего не изменено.

Таблица `acts` на GP — heap (`WITH (appendonly=false)`), поэтому `ADD COLUMN` с
`DEFAULT` перепишет её целиком. Актов немного, это секунды; отдельного окна
простоя не требует.

---

## Проверка

```sql
-- PG
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 't_db_oarb_audit_act_acts'
  AND column_name = 'content_version';
-- Ожидается: content_version | integer | NO | 0

-- GP (схему подставить свою)
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 's_grnplm_ld_audit_da_project_4'
  AND table_name = 't_db_oarb_audit_act_acts'
  AND column_name = 'content_version';
```

После рестарта приложения диагностика дрейфа колонок не должна писать WARNING про
таблицу `acts`.

## Откат

Откатывать миграцию не нужно даже при откате приложения на предыдущую версию:
лишняя колонка старой версии не мешает, она читает своё подмножество колонок
(см. [`deployment-runbook.md` §3](../operations/deployment-runbook.md)). Если
колонку всё же требуется убрать — `ALTER TABLE … DROP COLUMN content_version;`
в соответствующей схеме.
