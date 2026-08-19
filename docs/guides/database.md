# База данных

> Часть гайд-бука разработчика Audit Workstation. Точка входа и навигация по всем частям — [`developer-guide.md`](developer-guide.md).

Схема, адаптеры PostgreSQL/Greenplum, пул и исполнитель соединений, репозитории, миграции.
Нумерация разделов (§6) сохранена от единого гайд-бука — ссылки вида «§6.3a» остаются валидными.


## Оглавление

- [6. База данных](#6-база-данных)
  - [6.1 Схема: основные и справочные таблицы](#61-схема-основные-и-справочные-таблицы)
  - [6.2 Адаптеры (PostgreSQL vs Greenplum)](#62-адаптеры-postgresql-vs-greenplum)
  - [6.3 Пул подключений (asyncpg)](#63-пул-подключений-asyncpg)
  - [6.3a Исполнитель БД (connection-per-operation)](#63a-исполнитель-бд-connection-per-operation)
  - [6.4 BaseRepository: паттерн работы с БД](#64-baserepository-паттерн-работы-с-бд)
  - [6.5 Миграции](#65-миграции)
  - [6.5a Как добавить CHECK constraint](#65a-как-добавить-check-constraint)
  - [6.6 JSON/JSONB утилиты](#66-jsonjsonb-утилиты)
  - [6.7 Как добавить новое поле в таблицу](#67-как-добавить-новое-поле-в-таблицу)
  - [6.8 Пример: добавление новой таблицы](#68-пример-добавление-новой-таблицы)
  - [6.9 Добавление UA-справочника](#69-добавление-ua-справочника)

---

## 6. База данных

### 6.1 Схема: основные и справочные таблицы

> **Префикс таблиц.** Все таблицы доменов `acts`, `chat`, `admin` и `notifications` имеют общий префикс из `DATABASE__TABLE_PREFIX` (по умолчанию `t_db_oarb_audit_act_`). В таблицах и в коде ниже имена приведены без префикса для краткости — реальное имя в БД: `t_db_oarb_audit_act_<имя>` (на GP дополнительно квалифицируется схемой `{SCHEMA}.`). Подстановкой занимаются адаптеры (`PostgreSQLAdapter.get_table_name`, `GreenplumAdapter.get_table_name`).

**Домен актов — 12 таблиц в PG-схеме, 11 в GP** (`{REF_HADOOP_TABLES}` создаётся только в PG — на GP это внешняя ETL-таблица):

| Таблица | Назначение | Связь |
|---------|-----------|-------|
| `acts` | Метаданные акта | Главная |
| `audit_team_members` | Состав аудиторской группы | FK → acts |
| `act_directives` | Поручения (привязка к п.5) | FK → acts |
| `act_tree` | Иерархическая структура (JSONB) | FK → acts, UNIQUE(act_id) |
| `act_tables` | Табличные данные (grid JSONB) | FK → acts |
| `act_textblocks` | Текстовые блоки с форматированием | FK → acts |
| `act_violations` | Карточки нарушений | FK → acts |
| `act_invoices` | Прикрепленные фактуры | FK → acts |
| `{REF_HADOOP_TABLES}` | Реестр hive-таблиц (реплика для фактур) | Справочная, только PG |
| `audit_log` | Журнал операций (JSONB details) | FK → acts |
| `act_content_versions` | Снимки содержимого для истории; дедуп по `content_hash` | FK → acts |
| `act_editor_telemetry` | Счётчики событий здоровья редактора (self-heal, починки капсул, ошибки сохранения) | `act_id` без FK |

> **`ON DELETE CASCADE` — только в PG-схеме.** GP 6 его не поддерживает (регрессия `test_no_on_delete_cascade`), поэтому в GP-схеме те же `REFERENCES {PREFIX}acts(id)` объявлены без `ON DELETE`, а каскад выполняется кодом. См. §6.2.

> **Блокировки актов в колонках `acts` НЕТ.** Локи живут на Redis (`lock:act:{id}`, TTL, Lua-атомарность, `app/core/redis.py`) и истекают сами; фоновой задачи очистки просроченных локов не существует.

**Домен администрирования — 8 таблиц в PG-схеме, 7 в GP** (`{REF_USER_TABLE}` создаётся только в PG — реплика GP-справочника для локального тестирования):

| Таблица | Назначение |
|---------|-----------|
| `{REF_USER_TABLE}` | Справочник пользователей (ФИО, должность, подразделение); только PG |
| `roles` | Справочник ролей приложения (Админ, Цифровой акт, ЦК...) |
| `user_roles` | Связь пользователь → роль |
| `admin_audit_log` | Аудит-лог операций администрирования ролей |
| `app_singleton_lock` | Блокировка singleton-инстанса (защита от второго воркера) |
| `admin_http_metrics` | HTTP-метрики запросов: latency / status / пользователь |
| `user_avatars` | Фото профиля пользователя |
| `access_denied_audit` | Аудит-лог отказов доступа к доменам (`require_domain_access` → 403) |

**Домен чата (`chat`) — 7 таблиц:**

| Таблица | Назначение |
|---------|-----------|
| `chat_conversations` | Беседы пользователя |
| `chat_messages` | Сообщения беседы (блоки, `status`, `agent_ref`) |
| `chat_files` | Файлы, приложенные к сообщениям |
| `{BUS_TABLE}` (`chat_agent_messages_bus`) | Шина к внешнему ИИ-агенту; имя задаётся целиком, **без** `{PREFIX}` |
| `chat_tool_metrics` | Метрики выполнения ChatTool'ов |
| `chat_audit_log` | Аудит-лог домена чата |
| `chat_message_feedback` | Оценки сообщений (`up`/`down`), PK `(message_id, user_id)` |

Таблицы чата могут жить в отдельной схеме — за это отвечают плейсхолдеры `{CHAT_SCHEMA_Q}` / `{BUS_SCHEMA_Q}` (см. §6.5.1). Деталь домена — §7 и §11 в [`ai-assistant.md`](ai-assistant.md).

**Домен уведомлений (`notifications`) — 2 таблицы:**

| Таблица | Назначение |
|---------|-----------|
| `notifications` | Уведомления; `recipient_user_id IS NULL` = broadcast |
| `notification_state` | Прочитано/скрыто по пользователю; PK `(notification_id, user_id)`, строка создаётся лениво |

**Домен ЦК Фин.Рез. (`ck_fin_res`) — 1 таблица:**

| Таблица | Назначение |
|---------|-----------|
| `t_db_oarb_ck_fr_validation` | Результаты верификации метрик FR (факты риска) |

Связанная таблица `t_db_oarb_ck_validation_reestr_metric` (реестр метрик, формат ФР00001) управляется ETL и в приложении не создаётся. VIEW `v_db_oarb_ck_fr_validation` (JOIN на `t_db_oarb_ua_sub_number` по `act_sub_number_id`) создаётся вне приложения средствами ETL/DBA.

Колонка `tb_leader TEXT NOT NULL DEFAULT ''` (ТБ-руководитель проверки, `tb_id` справочника терр. банков строкой) объявлена в PG-`schema.sql` вместе с VIEW. На уже развёрнутую dev-БД такие расширения доносятся файлом миграции (§6.5.5). На GP таблицу и VIEW заводит ETL до деплоя. Учитывай, что репозиторий читает только VIEW (`self.view`) — новая колонка таблицы становится видимой лишь после того, как VIEW пересоздан тем же DDL, что в `schema.sql`, поэтому в файле миграции рядом с `ALTER TABLE` обязан стоять `CREATE OR REPLACE VIEW`; стартовая диагностика дрейфа (§6.5.4) этого не ловит — она сверяет колонки таблицы, а не выходной список VIEW.

Показатель «NPL 90+» — `npl_amount_rubles NUMERIC(38, 2) DEFAULT 0`, заполняется только для метрик с флагом `has_npl` в словаре `t_db_oarb_ua_violation_metric_dict` (сегодня это код `602`). Флаг — единый источник истины: его читают и бэкенд (`_npl_metric_codes` в `fr_validation_service.py`), и фронт (`nplCodesFromMetrics` в `ck-fin-res-config.js`); статические наборы `NPL_METRIC_CODES_FALLBACK` (`frozenset({"602"})`) и `CkFinResConfig.NPL_METRIC_CODES` — фолбэк на случай, когда словарь не отдал флаг. На GP таблица `t_db_oarb_ck_fr_validation` целиком создаётся и наполняется ETL вне приложения (`app/domains/ck_fin_res/migrations/greenplum/schema.sql` содержит только комментарий, `CREATE TABLE` там нет). `FRValidationService.group_save` проверяет обе стороны правила метрики 602 (NPL заполнен ⇒ метрика 602, метрика 602 ⇒ NPL заполнен), а строка развёртки по ТБ существует, если сумма ИЛИ NPL больше нуля (`TBBreakdownItem._at_least_one_amount` в `schemas/group.py`). Групповой агрегат `total_npl_amount` (`SUM(npl_amount_rubles)`) сортируется и фильтруется HAVING-диапазоном наравне с `total_amount` (`AGG_SORT_EXPR`/`AGG_FILTER_EXPR` в `fr_validation_repository.py`).

Membership-фильтр (строка попадает в выдачу, если условию удовлетворяет хотя бы одна строка группы, но агрегаты группы считаются по всем строкам — HAVING, не WHERE) расширен под NPL. `MEMBERSHIP_FILTER_COLS` в `fr_validation_repository.py` теперь хранит не голую колонку, а пары «колонка членства + опциональное доп.условие» (`{алиас: (column, extra|None)}`): существующие `neg_finder_tb_id`/`tb_breakdown` получили `extra=None` (SQL не изменился побайтово), новый `npl_breakdown` — `extra='npl_amount_rubles > 0'` («группа содержит выбранный ТБ, у которого есть строка с NPL 90+ больше нуля»). `_build_membership_having` распаковывает пару и добавляет `AND {extra}` внутрь `CASE WHEN ... THEN`-условия для всех трёх поддерживаемых op (`in`/`eq`/`contains`) — `range`/`contains_any` в membership сознательно не реализованы и отклоняются явным `raise` (а не молчаливым пропуском — иначе HAVING вернул бы все группы, как будто фильтра не было): единственный источник membership-фильтров с фронта — чекбокс-пикер, а он всегда шлёт `op:'in'`. Маршрутизация `_split_filters` (статик-метод, разносит фильтры на row/agg/membership) не изменилась — она смотрит только на `column in MEMBERSHIP_FILTER_COLS`, форма значения словаря для неё не важна.

Новый оп `contains_any` — «колонка содержит любую из перечисленных фраз» — добавлен в `Literal` поля `op` схемы фильтра в обоих ЦК-доменах (`ck_fin_res/schemas/requests.py`, `ck_client_exp/schemas/requests.py`: `Literal["contains", "in", "range", "eq", "contains_any"]`) и реализован в трёх местах SQL-слоя, побайтово одинаково по семантике — разнится только обёрнутое выражение: `_build_filter_where` в обоих доменах (row-level WHERE, колонка) и дополнительно `_build_having` в ЦКФР (агрегатная HAVING-ветка, выражение `expr`, например `SUM(npl_amount_rubles)`; у ЦК КО HAVING нет — плоский поиск без группировки). Строится как `(CAST(<col|expr> AS TEXT) ILIKE $i OR CAST(<col|expr> AS TEXT) ILIKE $i+1 OR ...)`, один bind-параметр `%фраза%` на каждую непустую (после trim) фразу; пустые/пробельные фразы отфильтровываются перед сборкой, а если итоговый список пуст — фильтр просто пропускается (`continue`), в отличие от `in`, где пустой список `values` даёт `1=0`: «фраз не введено» читается как «фильтр не задан», а не «ничего не найдено». Client-mode зеркалирует эту семантику в `datatable-logic.js`: `specActive` считает спек `contains_any` активным, только если в `values` есть хотя бы одна непустая после trim фраза; `specMatches` нормализует (нижний регистр + схлопывание пробелов) и фразы, и сырое значение, возвращает true, если сырое значение содержит любую из фраз (пустой список фраз — true для всех строк, тот же смысл «фильтр не задан»); при массивном `raw` (через `col.filterValue`) проверка, как и у `contains`/`eq`/`in`, рекурсивно применяется к каждому элементу.

Тулкит таблицы (`static/js/shared/datatable/`, доменно-агностичен) типизирует фильтр колонки по `col.type`, если явно не указано иное. `number` без `col.filterPicker` уже получает попап-диапазон «от/до» по умолчанию (`_buildFilterControl`: `col.filterPicker === 'numrange' || (!col.filterPicker && col.type === 'number')`; `id` числовым не считается — остаётся текстовым фильтром). Текстовые типы (`text`/`textarea`/`id`/`readonly-text`/`process-picker`/`amount-breakdown`/`dictionary` без `filterResolve`) по умолчанию получают контрол чипов-фраз: Enter коммитит введённый текст в чип (регистронезависимый дедуп, инпут очищается), `×` на чипе и Backspace на пустом инпуте удаляют (крестик — конкретный чип, Backspace — последний); состояние — `this._filterText[key] = {text, chips}` (лениво мигрирует со старого строкового формата при первом чтении). 0 чипов делегирует в живой `contains` по тексту (`_specFromTextChips(col, state)` → `_specFromText`), ≥1 чип даёт `{op:'contains_any', values:[...chips, ...живой текст, если непуст]}`. `checkbox` — попап `<select>` «Все/Да/Нет» (спек `{op:'eq', value}`), а `build-columns.js::toColumn` вдобавок проставляет дефолтный `format` ячейки любой checkbox-колонке без явного форматтера: `null → ''`, `true → 'Да'`, `false → 'Нет'` (явный `format`/`render` из `extra`/`overrides` по-прежнему перекрывает — спред в `buildColumns` это гарантирует). Опт-ауты: `col.noFilter: true` — шапка без фильтр-контрола вовсе, только подпись и сортировка (pivot-колонки ТБ, `tb_count`, которого нет в `ALLOWED_COLUMNS` бэка); `col.filterPicker: 'checkbox'|'numrange'` — попап-оболочка (`DataTable._openPopover`/`_closePopover`, тот же паттерн, что у date-попапа): `checkbox` — мультивыбор по обязательному `col.filterOptions: [{value, label, short?}]` (пустой набор галочек снимает фильтр), `numrange` для `number`-колонок теперь дублирует дефолт, но остаётся явным способом получить тот же диапазонный контрол на колонке другого типа; `col.filterResolve` — опт-аут от чипов для `dictionary`-колонок: единственный текстовый инпут, введённое имя резолвится в id (`{op:'in', values: filterResolve(text, dicts)}`), чипы туда не заходят.

Панель видимости колонок группирует чекбоксы подписями по `col.group`. Для колонок, выведенных из полей формы, группа проставляется автоматически: `sectionByKey(fields)` (приватный хелпер в `build-columns.js`) строит карту `key → section.section`, не мутируя саму структуру `fields` (форма продолжает читать её как раньше); `buildColumns` подмешивает `group` между сборкой колонок (`extra`+`flat`) и применением `overrides` — `cols.map(c => (c.group == null && sections[c.key] ? {...c, group: sections[c.key]} : c))`, поэтому `extra`-колонка с уже выставленным `group` не перезаписывается, а `overrides` при желании домена может перекрыть секционный `group` следующим шагом. `ColumnVisibility.mount`, перебирая `columns` в порядке `order`, отслеживает `lastGroup` и вставляет `<div class="dt-colvis-grouplabel">` перед чекбоксом при каждой смене `col.group` относительно предыдущей колонки (не на каждой колонке); колонки без `group` или до первой группы — без заголовка. Отсюда контракт: группы обязаны идти в `order` непрерывными блоками — если та же группа снова встретится после другой, её заголовок вставится повторно (дубль); тулкит это не проверяет — ответственность на доменном конфиге. Вставка заголовков сдвигает позиции чекбоксов в гриде, поэтому `_sync(grid, columns, viewState)` (общий для кнопок «Выбрать все»/«Снять все»/«Сбросить к умолчанию», открытия панели по клику на якорь и `onApi.sync`) больше не ищет чекбоксы позиционным индексом (`querySelectorAll(...)[i] ↔ columns[i]`) — каждый чекбокс несёт `cb.dataset.key`, а `grid._dtBoxByKey` (`Map<key, checkbox>`, строится тем же проходом) даёт `_sync` прямой доступ по ключу колонки. `ColumnVisibility.mount({..., onApi})` по-прежнему отдаёт вызывающему `api.sync()` — синхронизирует чекбоксы уже открытой панели с `viewState` без переоткрытия (нужно при программном изменении видимости, например из секции ТБ ниже). Обе ЦК-страницы используют группировку: у ЦКФР `group` явно проставлен на 9 `extra`-колонках (`id`/`created_at`/`updated_at` → «Системное», `metric_name`/`total_amount`/`total_npl_amount`/`tb_count`/`total_counts` → «Метрика», `act_sub_number` → «Идентификация»; `tb_breakdown`/`npl_breakdown` — уже поля формы секции «Метрика», группу получают автоматически), а `id` перенесён в `order` из начала в хвост (`..., 'reestr_metric_id', 'id', 'created_at', 'updated_at'`) — иначе группа «Системное» рвалась бы. Итоговая последовательность групп — «Идентификация → Процесс и владельцы → Отклонение → Метрика → Поручения → Системное», без повторов. У ЦК КО — тот же перенос `id` в хвост `order` плюс `group` на 5 `extra`-колонках; остальные колонки группируются автоматически по 4 уже существующим секциям формы («Идентификация»/«Процесс и владельцы»/«Метрика»/«Системное») — типовые дефолты фильтра (предыдущий абзац) при этом не потребовали ни одной правки конфига.

ЦКФР добавляет в панель видимости собственную секцию над сеткой чекбоксов — `preContent`, которую строит `_buildTbViewSection(columns)` (`ck-fin-res-page.js`): заголовок «Развертка по ТБ» (стилизован тем же классом `.dt-colvis-grouplabel`, что и автогруппы, для визуальной консистентности, хотя к механизму `col.group` эта секция отношения не имеет), радио «Чипы с суммами» / «Колонки по ТБ» (персистится через `viewState.getExtra('tbView', 'chips')`) и грид галочек — по одной на территориальный банк из живого `this._dictionaries.terbanks` (не статический словарь), подпись — `CkFinResConfig.tbAbbr`, `title` — `full_name`. Одна галочка управляет парой pivot-колонок сразу: `change` дёргает `setVisible` и для `piv:{id}` (сумма), и для `pivnpl:{id}` (NPL) — банк либо показан в обеих сериях, либо ни в одной. Pivot-колонки (ключи с префиксом `piv:`/`pivnpl:`) исключены из общего списка чекбоксов панели (`columns.filter(c => !isPivotKey(c.key))`) — ими управляет только эта секция, не общий грид с группами. Переключение радио (`_applyTbView`) безусловно выставляет видимость всех pivot-колонок под выбранный вид и инвертирует видимость чип-колонок `tb_breakdown`/`npl_breakdown`, затем зовёт `_syncTbChecks(view)` (галочки банков активны и отмечены только в виде `pivot`) и `this._colvisApi.sync()` — тот самый `onApi` из предыдущего абзаца, чтобы уже открытая панель обновилась без переоткрытия. Отдельно — `_reassertTbView(columns)`, передаётся в `ColumnVisibility.mount` как общий `onChange` панели (своя пара галочек банка в него не заходит — она вызывает `setVisible`/`refresh()` напрямую) и срабатывает на любое изменение видимости через общий грид чекбоксов, в первую очередь — на «Сбросить к умолчанию»: сброс возвращает к дефолту видимость, ширины и extra-флаги (включая `tbView`) в обход самих радио. Кнопки «Выбрать все»/«Снять все» скоуплены тулкитом к переданным в панель колонкам (`ColumnVisibility._setAll`) и pivot-ключи не трогают. `_reassertTbView` восстанавливает инвариант «вид — либо чипы, либо колонки»: при `tbView !== 'pivot'` принудительно прячет все `piv:`/`pivnpl:` колонки, в режиме `pivot` — чип-колонки `tb_breakdown`/`npl_breakdown`, а затем пересинхронизирует радио и галочки банков (`_syncTbChecks`).

**Домен ЦК Клиентский опыт (`ck_client_exp`) — 1 таблица:**

| Таблица | Назначение |
|---------|-----------|
| `t_db_oarb_ck_cs_validation` | Результаты верификации метрик CS (клиентский опыт) |

VIEW `v_db_oarb_ck_cs_validation` (JOIN на `t_db_oarb_ua_sub_number` по `act_sub_number_id`, как и у ЦКФР) создаётся вне приложения средствами ETL/DBA.

**Домен справочных данных (`ua_data`) — 19 таблиц** (создаются только в PG-схеме; на GP их заводит и наполняет ETL, GP-`schema.sql` домена — заглушка из одного комментария)**:**

Содержит словари и справочники, используемые другими доменами:

| Таблица | Назначение |
|---------|-----------|
| `t_db_oarb_ua_process_dict` | Словарь бизнес-процессов |
| `t_db_oarb_ua_terbank_dict` | Справочник территориальных банков |
| `t_db_oarb_ua_gosb_dict` | Справочник ГОСБ |
| `t_db_oarb_ua_vsp_dict` | Справочник ВСП |
| `t_db_oarb_ua_channel_dict` | Словарь каналов |
| `t_db_oarb_ua_product_dict` | Словарь продуктов |
| `t_db_oarb_ua_subsidiary_dict` | Словарь дочерних компаний |
| `t_db_oarb_ua_departments` | Справочник подразделений |
| `t_db_oarb_ua_violation_metric_dict` | Словарь метрик нарушений (в т.ч. флаг `has_npl`) |
| `t_db_oarb_ua_violation_risk_type_dict` | Словарь типов риска |
| `t_db_oarb_ua_team_dict` | Справочник команд |
| `t_db_oarb_ua_team_member_by_km` | Участники команд по КМ |
| `t_db_oarb_ua_sub_number` | Номера подактов (служебные записки) |
| `t_db_oarb_ua_violation_clients` | Клиенты нарушений |
| `t_db_oarb_ua_violation_facts` | Факты нарушений |
| `t_db_oarb_ua_violation_fr_metric` | Метрики нарушений FR |
| `t_db_oarb_ua_violation_cs_metric` | Метрики нарушений CS |
| `t_db_oarb_ua_violation_mkr_metric` | Метрики нарушений MKR |
| `t_db_oarb_ua_violation_ior_metric` | Метрики нарушений IOR |

**Плейсхолдеры внешних имён в миграциях** (полный перечень, кроме универсальных `{SCHEMA}` / `{PREFIX}`):

| Плейсхолдер | Домен | Во что разворачивается |
|-------------|-------|------------------------|
| `{REF_HADOOP_TABLES}` | `acts` | `ACTS__INVOICE__HIVE_REGISTRY_TABLE` — реестр hive-таблиц для поиска фактур |
| `{REF_USER_TABLE}` | `admin` | `ADMIN__USER_DIRECTORY__TABLE` — справочник пользователей |
| `{CHAT_SCHEMA_Q}` | `chat` | Квалификатор `<схема>.` таблиц чата из `CHAT__SCHEMA_NAME`; пусто → основная схема адаптера (`<main>.` на GP, ничего на PG) |
| `{BUS_SCHEMA_Q}` | `chat` | То же для bus-таблицы: `CHAT__AGENT_CHANNEL__SCHEMA_NAME` → схема чата → основная |
| `{BUS_TABLE}` | `chat` | `CHAT__AGENT_CHANNEL__TABLE_NAME` — имя bus-таблицы целиком, **без** `{PREFIX}` |

**Ключевые constraints таблицы `acts`:**

```sql
-- инлайн на колонке validation_status
CONSTRAINT check_acts_validation_status_values
    CHECK (validation_status IN ('ok', 'warning', 'error')),

CONSTRAINT check_km_number_format
    CHECK (km_number ~ '^КМ-\d{2}-\d{5}$'),
CONSTRAINT check_km_number_digit_length
    CHECK (length(km_number_digit::text) = 7),   -- km_number_digit — INTEGER
CONSTRAINT check_service_note_format
    CHECK (service_note IS NULL OR service_note ~ '^.+/\d{4}$'),
CONSTRAINT check_part_number_positive
    CHECK (part_number > 0),
CONSTRAINT check_total_parts_positive
    CHECK (total_parts > 0),
CONSTRAINT check_inspection_dates
    CHECK (inspection_end_date >= inspection_start_date),
CONSTRAINT check_service_note_consistency
    CHECK (
        (service_note IS NULL AND service_note_date IS NULL) OR
        (service_note IS NOT NULL AND service_note_date IS NOT NULL)
    ),
UNIQUE(km_number_digit, part_number)  -- только в PG-схеме; на GP — app-level (см. §6.5)
```

> **Колонки статуса валидации содержимого** (фича #8, обе схемы PG+GP): `validation_status VARCHAR(20) NOT NULL DEFAULT 'ok'` (CHECK `ok`/`warning`/`error`) + `validation_issues JSONB`. Статус вычисляется на бэке при сохранении содержимого (`services/content_validation.py::collect_validation_issues` — **не бросает**, зеркалит фронт-правила структуры 1–5 и заголовков/данных таблиц; `error` при любом замечании `severity='error'`, иначе `warning` при только мягких замечаниях, иначе `ok`). Возвращается в `SaveContentResponse` и выставляется в `ActListItem`/`ActResponse`. CHECK замаплен в `CHECK_CONSTRAINT_MESSAGES` (`app/core/exceptions.py`). Подробнее — §12 в [`data-model-acts.md`](../architecture/data-model-acts.md).

> **Уникальность `(km_number_digit, part_number)` на Greenplum обеспечивается на уровне приложения** (`ActCrudService.create_act` проверяет наличие активного дубля перед INSERT), а не БД-констрейнтом. Причина — правило `DISTRIBUTED BY ⊆ UNIQUE` (§6.5): для DB-UNIQUE пришлось бы либо `DISTRIBUTED REPLICATED` (копия на каждом сегменте — приемлемо для маленьких таблиц, но требует миграции данных), либо composite-PK с обязательным `id` (меняет distribution). Это сознательный выбор, не баг.

**Роли в `audit_team_members`:**

| Роль | Права |
|------|-------|
| Куратор | Управление доступом и метаданными |
| Руководитель | Изменение содержимого, аудит-лог |
| Редактор | Редактирование содержимого |
| Участник | Только просмотр |

CHECK `check_audit_team_role_values` (одинаковый в PG и GP) допускает пятое значение — `AppendixRef`: служебный маркер строки-приложения, в UI как роль не показывается.

### 6.2 Адаптеры (PostgreSQL vs Greenplum)

Абстрактный `DatabaseAdapter` (`app/db/adapters/base.py`) определяет интерфейс:

```python
class DatabaseAdapter(ABC):
    # Имена и возможности СУБД
    @abstractmethod
    def get_table_name(self, base_name: str, schema: str = "") -> str: ...
    @abstractmethod
    def qualify_table_name(self, full_name: str, schema: str = "") -> str: ...
    @abstractmethod
    def get_serial_type(self) -> str: ...
    @abstractmethod
    def get_index_strategy(self, index_type: str) -> str: ...
    @abstractmethod
    def supports_cascade_delete(self) -> bool: ...
    @abstractmethod
    def supports_on_conflict(self) -> bool: ...
    @abstractmethod
    async def get_current_schema(self, conn) -> str: ...

    # Методы создания таблиц
    @abstractmethod
    async def create_tables(
        self, conn, schema_paths: list[Path],
        substitutions: dict[str, str | Callable[[], str]] | None = None,
    ) -> None: ...
    @abstractmethod
    async def _get_existing_tables(self, conn, expected_names: list[str]) -> set[str]: ...

    # Общие утилиты (реализованы на базе, доступны обоим адаптерам)
    @staticmethod
    def _extract_table_names_from_sql(sql: str) -> list[str]: ...
    @staticmethod
    def _extract_columns_from_sql(sql: str) -> dict[str, set[str]]: ...
    @staticmethod
    def _split_sql_statements(sql: str) -> list[str]: ...
    @staticmethod
    async def _existing_tables_by_schema(conn, expected_names, *, default_schema) -> set[str]: ...
    @classmethod
    def _external_tables_from_sql(cls, sql: str) -> set[str]: ...
    async def _warn_on_stale_tables(self, conn, schema_sql, domain_name, *, db_label, default_schema) -> None: ...

    # Конкретный метод
    def qualify_column(self, table_alias: str, column: str) -> str: ...
```

`get_table_name` / `qualify_table_name` принимают необязательный `schema` — override основной схемы. Это позволяет домену разместить свои таблицы отдельно (`CHAT__SCHEMA_NAME`, `CHAT__AGENT_CHANNEL__SCHEMA_NAME`); проверка существования и диагностика дрейфа группируют имена по схемам (`_existing_tables_by_schema`), а не смотрят в одну фиксированную.

`create_tables` получает **список путей** к `schema.sql` (по одному на домен), а не готовый SQL-текст: подстановку плейсхолдеров, разбор на операторы и pre/post-verify адаптер делает сам.

**Внешние таблицы.** Директива `-- @external-table: <имя>` в `schema.sql` помечает таблицу, которой владеет другая сторона (пример — bus-таблица канала агента). Для уже существующей внешней таблицы адаптер пропускает операторы-«спутники» (`CREATE INDEX`, `COMMENT ON`) — на чужой таблице они падают с `InsufficientPrivilegeError` («must be owner of relation»). Спутники собственных существующих таблиц исполняются как обычно.

**Сравнение реализаций:**

| Аспект | PostgreSQL | Greenplum |
|--------|-----------|-----------|
| Имена таблиц | `{PREFIX}acts` | `{SCHEMA}.{PREFIX}acts` |
| Auto-increment | `SERIAL` | `BIGSERIAL` |
| CASCADE DELETE | Да | Нет (ручное управление) |
| ON CONFLICT | Да | Нет (DELETE + INSERT) |
| Индексы | GIN на JSONB | BTREE |
| Аутентификация | Пароль | Kerberos (kinit) |

Из этих различий репозитории спрашивают адаптер только про две возможности: `supports_cascade_delete()` (`act_crud.py`, `conversation_repository.py` — при `False` удаляют потомков вручную) и `supports_on_conflict()` (`role_deps.py`, `act_invoice.py`, `admin_repository.py` — при `False` делают DELETE + INSERT). Остальные методы (`get_serial_type`, `get_index_strategy`, `get_current_schema`, `qualify_column`) вне адаптеров сейчас не вызываются: типы и индексы прописаны в `schema.sql` напрямую.

Оба адаптера используют общие плейсхолдеры `{SCHEMA}` и `{PREFIX}` в `schema.sql`. PG-адаптер подставляет `{SCHEMA}.` → `""` и `{PREFIX}` → `DATABASE__TABLE_PREFIX`; GP-адаптер — `{SCHEMA}` → реальную схему и `{PREFIX}` → тот же префикс. За счёт этого имена таблиц совпадают в обеих СУБД (минус schema-qualifier на PG).

```python
class PostgreSQLAdapter(DatabaseAdapter):
    def __init__(self, table_prefix: str = ""):
        self.table_prefix = table_prefix  # t_db_oarb_audit_act_

    def get_table_name(self, base_name: str) -> str:
        return f"{self.table_prefix}{base_name}"
        # → t_db_oarb_audit_act_acts


class GreenplumAdapter(DatabaseAdapter):
    def __init__(self, schema: str, table_prefix: str):
        self.schema = schema              # s_grnplm_ld_audit_da_project_4
        self.table_prefix = table_prefix  # t_db_oarb_audit_act_

    def get_table_name(self, base_name: str) -> str:
        return f"{self.schema}.{self.table_prefix}{base_name}"
        # → s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_acts
```

### 6.3 Пул подключений (asyncpg)

Файл `app/db/connection.py` управляет пулом подключений. `init_db` — тонкий координатор над двумя функциями: `make_adapter` (чистая: адаптер + `pool_kwargs` по типу БД, ничего не открывает и не пишет в глобалы) и `open_pool` (открывает `asyncpg.Pool`, переводит Kerberos-ошибки в `KerberosTokenExpiredError` с инструкцией `kinit` в логе).

```python
def make_adapter(settings: Settings) -> tuple[DatabaseAdapter, dict]:
    if settings.database.type == "postgresql":
        adapter = PostgreSQLAdapter(table_prefix=settings.database.table_prefix)
        pool_kwargs = dict(
            host=settings.database.host,
            port=settings.database.port,
            database=settings.database.name,
            user=settings.database.user,
            password=settings.database.password.get_secret_value(),
        )
    elif settings.database.type == "greenplum":
        adapter = GreenplumAdapter(
            schema=settings.database.gp.schema_name,
            table_prefix=settings.database.table_prefix,
        )
        # user для GP — только цифры из settings.jupyterhub_user (env JUPYTERHUB_USER)
        ...
    return adapter, pool_kwargs


async def open_pool(settings, adapter, pool_kwargs) -> Pool:
    # для GP — pre-flight проверка Kerberos-билета (POSIX: klist -s)
    return await asyncpg.create_pool(
        **pool_kwargs,
        min_size=settings.database.pool_min_size,
        max_size=settings.database.pool_max_size,
        command_timeout=settings.database.command_timeout,
    )
```

**Ключевые функции:**
- `make_adapter(settings)` / `open_pool(settings, adapter, kwargs)` — сборка адаптера и открытие пула
- `init_db(settings)` — инициализация при старте (координатор, сохраняет глобалы)
- `warmup_pool(pool, count)` — прогрев: `count` параллельных холостых `acquire()` + `SELECT 1`, чтобы первые запросы не платили TCP-handshake (`DATABASE__POOL_WARMUP_ENABLED`, count = `pool_min_size`)
- `get_pool()` — текущий пул
- `get_adapter()` — текущий адаптер
- `get_db()` — async-контекстменеджер: одно соединение из пула
- `close_db()` — закрытие при shutdown
- `create_tables_if_not_exist(domains)` — автосоздание таблиц

**`get_db` не ждёт соединения бесконечно.** `pool.acquire()` вызывается с `timeout=DATABASE__ACQUIRE_TIMEOUT` (дефолт `10.0` сек) отдельно от тела — чтобы таймаут исчерпанного пула не спутался с `asyncio.TimeoutError` самого запроса. При срабатывании — ERROR в лог и `ServiceUnavailableError` (HTTP 503, `code: "service-unavailable"`), а не зависший запрос. `asyncpg.PostgresError` на этапе acquire и во время работы проверяется на признаки протухшего Kerberos-билета и переводится в `KerberosTokenExpiredError`.

**Размер пула** (`DATABASE__POOL_MIN_SIZE` / `DATABASE__POOL_MAX_SIZE`, дефолты `1` / `2`, одинаковые во всех окружениях; валидатор `DatabaseSettings` запрещает `min > max`, границы полей — `min ≥ 1`, `max ≥ 2`). Обоснование: у ПРОМ-учётки Greenplum жёсткий лимит порядка 5 соединений, и «поднять пул» там невозможно в принципе. Уложиться в такой потолок позволил переезд горячих путей на Redis — счётчик непрочитанных, роли, user-контекст и блокировки актов больше не ходят в БД на каждый запрос, а батчеры и `AgentChannelPoller` берут коннект короткими порциями. DEV держим идентичным ПРОМу: вилка дефолтов прятала бы нехватку коннектов до самого прода. Диагностика исчерпания — [troubleshooting №17](../operations/troubleshooting.md).

Канал к внешнему ИИ-агенту (`AgentChannelPoller`) также использует пул, но не держит соединение даже на время тика — тик работает через исполнитель (`DbExecutor`, §6.3a), берущий коннект из пула на каждую SQL-операцию отдельно. Архитектура канала и sequence-диаграмма — §11.5–§11.7 в [`ai-assistant.md`](ai-assistant.md).

### 6.3a Исполнитель БД (connection-per-operation)

`app/db/executor.py` — класс `DbExecutor`, процесс-синглтон без состояния,
повторяющий API `asyncpg.Connection` через duck-typing:
`fetch`/`fetchrow`/`fetchval`/`execute`/`executemany` + `transaction()`.
Каждый вызов сам берёт соединение из пула через `get_db()` и сразу
возвращает его — в отличие от held-DI до ветки `connection-per-operation`
(§3.2 в [`architecture-and-backend.md`](architecture-and-backend.md) показывает
актуальный паттерн), исполнитель никогда не удерживает соединение дольше
одного SQL-вызова.

Формально `DbExecutor` реализует протокол `DbConn` (`app/db/types.py`) — то же
подмножество API, что и у `asyncpg.Connection`, поэтому репозиторий не
отличает одно от другого.

```python
from app.db.executor import get_executor

executor = get_executor()           # процесс-синглтон, без состояния
await executor.fetch("SELECT ...")  # взял соединение → SQL → сразу отдал
```

**Явная транзакция** — `executor.transaction()` привязывает соединение к
`ContextVar` на время блока: все вызовы исполнителя внутри блока (в том
числе из других репозиториев — они держат тот же синглтон) идут через одно
и то же соединение.

```python
async with get_executor().transaction():
    await repo_a.insert(...)   # то же соединение
    await repo_b.update(...)   # атомарно с insert выше
```

Вложенный `transaction()` на том же task делегируется в `conn.transaction()`
того же соединения — asyncpg открывает SAVEPOINT, семантика вложенных
транзакций (на неё рассчитывает `act_content.py`) сохраняется 1:1.

**Три инварианта** (заменяют прежнее правило «второе соединение не берём»):

1. Соединение берётся только на время SQL-вызова или явной транзакции —
   **никогда** на время await'ов сети/LLM/файлов.
2. Внутри явной транзакции нет новых захватов пула (вложенный `transaction()`
   → savepoint на том же соединении) и нет `create_task` с работой в этой
   транзакции.
3. DI-слой не держит соединений: фабрики зависимостей отдают сервисы на
   исполнителе, без `yield`.

**DI-фабрики домена** (`deps.py` каждого домена, вызываются через `Depends`)
оформлены корутинами (`async def`): синхронную зависимость FastAPI шлёт в
пул потоков через `run_in_threadpool`, а на горячих путях (в т.ч. поллинг
чата) это лишний оверхед. Тело фабрики не изменилось — `yield` в ней как не
было, так и нет, соединение по-прежнему не удерживается:

```python
async def get_crud_service(settings: Settings = Depends(get_settings)) -> ActCrudService:
    return ActCrudService(conn=get_executor(), settings=settings)
```

**Когда фабрика остаётся `def` (без `async`)** — если её НЕ зовут через
`Depends`:
- **Реестровые фабрики** `domain_registry` — `admin.user_directory` /
  `admin.user_avatars` / `notifications.push` (см.
  [`cross-domain-contracts.md`](../architecture/cross-domain-contracts.md) §2).
  Их вызывают как `get_factory("...")()`
  напрямую, FastAPI про них не знает и в threadpool не заворачивает.
- **Фабрики домена, вызываемые напрямую из кода, а не из роутера** —
  `chat/deps.py::get_agent_channel_service` (зовётся из `api/messages.py`
  в режиме `always`) и `chat/deps.py::get_tool_metrics_repository` (зовётся
  из оркестратора).

**Транзиентные `get_db`-места остаются легальным паттерном вне DI** — там,
где операция БД короткая и не спрятана за yield-фабрикой (батчеры,
role_deps, health-check'и, ChatTool action-handlers вроде
`open_act_page_handler`, разовые вызовы внутри `orchestrator.py`). Переписывать
их на исполнитель не нужно — это уменьшает диф и сохраняет тестовые
patch-точки `patch.multiple("app.db.connection", get_db=..., get_adapter=...)`
(§8 в [`testing.md`](testing.md), «Handler-функции с `get_db`/`get_adapter`»).

Исключение — поллер шины агента (`AgentChannelPoller`, §11.6 в
[`ai-assistant.md`](ai-assistant.md)): его перевели
на исполнитель отдельно, потому что тик вызывает чужой код с собственными
обращениями к БД (эмиссия уведомлений, трансляция кнопок) — держать
транзиентное соединение всё это время означало бы повторный захват пула в
том же task'е. Фоновые задачи тоже подчиняются инварианту 1: соединение
живёт не дольше одной SQL-операции, даже вне DI-слоя.

**Страж повторного захвата** (`app/db/connection.py::get_db`) — per-task
счётчик глубины захвата в `ContextVar`. Повторный `get_db()` в том же task,
пока первый ещё не отдан, — риск самоблокировки на пуле `max=2`:

- `DATABASE__STRICT_ACQUIRE_GUARD=true` — `RuntimeError`. В тестах включён
  БЕЗУСЛОВНО через autouse-фикстуру `strict_acquire_guard`
  (`tests/conftest.py`), независимо от `.env`.
- `false` (дефолт, `.env.prod`, ПРОМ) — WARNING со стеком, запрос не падает.

Глубина хранится вместе с task-владельцем (`_AcquireDepth`): contextvar
копируется в `create_task`, дочерний task наследует значение родителя — но его
собственный первый захват считается с нуля, а не «повторным» (по аналогии с
`_bound_tx` у `transaction()`). Регрессия:
`tests/db/test_executor.py::test_child_task_acquire_not_flagged_by_guard`.

**Ratchet-тест** `tests/test_connection_budget.py` — статический AST-обход
`app/`: находит функции, где `async with get_db()` содержит `yield` внутри
блока (соединение живёт всё время жизни зависимости — held-DI). Ассерт —
`holders == set()`, любой новый holder валит тест. Модуль `app/db/executor.py`
исключён из обхода намеренно: `DbExecutor.transaction()` легально удерживает
соединение на время явной транзакции — это разрешает инвариант 1.

### 6.4 BaseRepository: паттерн работы с БД

```python
# app/db/repositories/base.py
class BaseRepository:
    """Базовый класс репозиториев: инкапсулирует соединение и адаптер."""

    def __init__(self, conn: DbConn):
        self.conn = conn
        self.adapter = get_adapter()
```

`DbConn` (`app/db/types.py`) — протокол, а не `asyncpg.Connection`: под него подходят и настоящее соединение, и `DbExecutor`, и `AsyncMock` из тестов.

**Использование в доменных репозиториях:**

```python
class ActCrudRepository(BaseRepository):
    def __init__(self, conn: DbConn):
        super().__init__(conn)
        self.acts = self.adapter.get_table_name("acts")

    async def get_act_by_id(self, act_id: int) -> dict | None:
        return await self.conn.fetchrow(
            f"SELECT * FROM {self.acts} WHERE id = $1",
            act_id,
        )
```

Имена таблиц всегда получаются через `self.adapter.get_table_name()` — это обеспечивает работу с обеими СУБД.

В production-коде `conn`, который получает репозиторий, — почти всегда
`DbExecutor` (§6.3a), а не голое соединение из пула: имя атрибута и
сигнатура сохранены намеренно, тело репозитория не отличает одно от
другого (duck-typing). Юнит-тесты по-прежнему передают `mock_conn`
напрямую — оба варианта совместимы.

### 6.5 Миграции

#### 6.5.1 Правила миграций

- SQL-схемы лежат в `app/domains/<name>/migrations/postgresql/schema.sql` и `.../greenplum/schema.sql`.
- Таблицы создаются на старте через `create_tables_if_not_exist(domains)`. Всё через `CREATE TABLE IF NOT EXISTS` — повторный запуск безопасен.
- Автоматических ALTER-миграций (Alembic и т.п.) НЕТ: приложение создаёт только отсутствующие таблицы целиком и в существующие ничего не дописывает. Что делать при изменении схемы — зависит от его характера:
  - **Расширяющее** (новая колонка, индекс, констрейнт на существующей таблице) — правим `schema.sql` и кладём файл миграции для уже развёрнутых БД, см. §6.5.5. Целиком новая таблица — исключение: её приложение создаст само на старте, файл миграции ей не нужен.
  - **Ломающее** (переименование, смена типа, удаление колонки, несовместимая перестройка) — миграцию не пишем: пересоздаём затронутые таблицы или всю БД ([`../migrations/drop-all-tables.md`](../migrations/drop-all-tables.md)). Легаси-данных не держим, сохранять нечего.
- `schema.sql` — источник истины для чистой установки, и он всегда актуален: файл миграции его не заменяет, а повторяет для тех БД, что уже развёрнуты. Расхождение «в схеме колонка есть, в БД нет» ловится startup-предупреждением — см. §6.5.4.
- Плейсхолдеры в SQL: `{SCHEMA}.` (префикс схемы), `{PREFIX}` (`DATABASE__TABLE_PREFIX`), плюс доменные из `migration_substitutions` — `{REF_HADOOP_TABLES}`, `{REF_USER_TABLE}`, `{CHAT_SCHEMA_Q}`, `{BUS_SCHEMA_Q}`, `{BUS_TABLE}` (полная таблица — §6.1). Bare-имена без `{PREFIX}` — баг: имена разойдутся PG/GP. Исключение — таблицы, которыми владеет ETL (`ua_data`, ЦК-домены, шина агента): они именуются целиком, префикс приложения к ним не добавляется.
- UUID-id хранятся как `VARCHAR(36)`, не как PG-тип `UUID`. Python шлёт `str(uuid.uuid4())` строкой; одно правило для PG и GP.
- В Greenplum 6.x (= PG 9.4) НЕЛЬЗЯ: `CREATE INDEX IF NOT EXISTS`, `CREATE SEQUENCE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `ON CONFLICT`, `jsonb_set()`/`jsonb_pretty()`, `gen_random_uuid()`, `TABLESAMPLE`, `SKIP LOCKED`, `ON DELETE CASCADE`/`ON DELETE SET NULL`, `CREATE TRIGGER` и `LANGUAGE plpgsql` (на GP исполнялись бы только на координаторе). GP-адаптер исполняет SQL по одному statement и глотает `DuplicateTableError`/`DuplicateObjectError`/`DuplicateColumnError`. Регрессии — `tests/test_gp_compatibility.py`.
- В Greenplum `DISTRIBUTED BY (col)` должен быть подмножеством каждого `PRIMARY KEY` и `UNIQUE`. Для co-location по foreign-key используют составной PK с ключом распределения внутри. Пример — `chat_message_feedback` (PK `(message_id, user_id)`, `DISTRIBUTED BY (message_id)`) в `app/domains/chat/migrations/greenplum/schema.sql`. Регрессия — `test_distributed_by_subset_of_primary_key`.
- `BIGSERIAL` в GP-схемах используется (например `acts`, `audit_team_members`), но не везде проходит в связке PK + `DISTRIBUTED BY`. Там, где не проходит, id выдаёт явная последовательность: `CREATE SEQUENCE {SCHEMA}.{PREFIX}<table>_id_seq;` + `id BIGINT NOT NULL DEFAULT nextval('…')`. Так сделаны `admin_http_metrics`, `access_denied_audit`, `chat_tool_metrics`, `chat_audit_log`.
- Имена: таблицы `{PREFIX}<name>`, индексы `idx_{PREFIX}<table>_<purpose>`, sequence (только GP) `{PREFIX}<table>_id_seq`, CHECK `check_<table>_<purpose>` (без `{PREFIX}`, см. §6.5a).
- `updated_at` выставляется **явным** `SET updated_at = CURRENT_TIMESTAMP` в SQL репозиториев. Функции `update_updated_at_column()` и триггеров нет ни в GP-, ни в PG-схемах — обе синхронизированы. Регрессии — `test_no_pl_pgsql_triggers`, `test_pg_acts_schema_no_updated_at_trigger`.

#### 6.5.2 Как `discover_domains` подставляет значения

Плейсхолдеры подставляет адаптер во время `create_tables`. PG-адаптер заменяет `{SCHEMA}.` **вместе с точкой** на пустую строку (используется схема `public`), GP-адаптер заменяет `{SCHEMA}` на реальную схему из `DATABASE__GP__SCHEMA`. `{PREFIX}` в обоих превращается в `DATABASE__TABLE_PREFIX`. Итог: `{SCHEMA}.{PREFIX}acts` → `t_db_oarb_audit_act_acts` в PG и `s_grnplm_ld_audit_da_project_4.t_db_oarb_audit_act_acts` в GP.

Доменные плейсхолдеры (`{REF_*}`, `{CHAT_SCHEMA_Q}`, `{BUS_TABLE}`, …) указывают на внешние имена — например, `{REF_USER_TABLE}` для справочника пользователей. Они описаны в поле `migration_substitutions` каждого `DomainDescriptor` (`app/core/domain.py`), тип — `dict[str, str | Callable[[], str]]`. Функция нужна, когда имя берётся из settings, которые ещё не загружены при регистрации домена — оно подставляется при первом запуске `create_tables`. Пример из домена `admin`:

```python
migration_substitutions={
    "{REF_USER_TABLE}": lambda: settings_registry.get(
        "admin", AdminSettings
    ).user_directory.table,
},
```

Перед созданием таблиц `create_tables_if_not_exist` сливает `migration_substitutions` всех доменов в один словарь и собирает список путей `<домен>/migrations/<postgresql|greenplum>/schema.sql` (`app/db/connection.py`); адаптер применяет подстановки к каждой схеме.

#### 6.5.3 Как добавить таблицу

См. §6.8 — пошаговый рецепт.

#### 6.5.4 Startup-диагностика дрейфа колонок (рассинхрон схемы ↔ кода)

**Проблема.** `create_tables_if_not_exist` проверяет только **наличие таблиц**: если все таблицы домена существуют, его `schema.sql` не исполняется вообще (`CREATE TABLE IF NOT EXISTS` всё равно был бы no-op). Автоматических ALTER-миграций нет (§6.5.1). Значит новая колонка, добавленная в `schema.sql` существующей таблицы, **не появится** в уже развёрнутой БД, пока человек не накатит файл миграции (§6.5.5). Раньше это всплывало рантайм-ошибкой `asyncpg.UndefinedColumnError` при первом запросе с новой колонкой — без всякого сигнала на старте.

**Решение.** В ветке «все таблицы домена существуют» адаптер дополнительно сверяет колонки. Если у существующей таблицы не хватает колонок, объявленных в `schema.sql`, в лог пишется **WARNING** с перечнем недостающих колонок и подсказкой. Это превращает немой рантайм-500 в понятное сообщение при старте. Текст warning'а отсылает к `docs/migrations/` — накатить файл миграции (§6.5.5) либо, если изменение ломающее, пересоздать БД ([`../migrations/drop-all-tables.md`](../migrations/drop-all-tables.md)).

Реализация — общий код в `app/db/adapters/base.py` (используют оба адаптера):
- `_extract_columns_from_sql(sql)` — best-effort парсер: `{полное_имя_таблицы: {колонка}}`. Отсекает строки-ограничения таблицы (`CONSTRAINT/PRIMARY/FOREIGN/UNIQUE/CHECK/EXCLUDE/LIKE`), игнорирует строковые литералы, комментарии и вложенные скобки (`VARCHAR(20)`, инлайн `CHECK (a IN (1,2))`). Опирается на проверенный `_split_sql_statements`.
- `_actual_columns_by_schema(conn, names, default_schema)` — читает реальные колонки из `information_schema.columns`, группируя по схеме так же, как `_existing_tables_by_schema` (квалифицированные имена — в своей схеме).
- `_warn_on_stale_tables(conn, schema_sql, domain, db_label, default_schema)` — сверяет ожидаемые колонки с фактическими и логирует WARNING на расхождение.

**Гарантии безопасности (важно для прод/GP):**
- **Только диагностика, не блокирует старт.** Весь `_warn_on_stale_tables` обёрнут в `try/except`: любая ошибка (сбой запроса, парсинга, транзиентный сбой) → `logger.debug(...)` и продолжение. Упасть на старте из-за неё нельзя.
- **Read-only.** Делает только `SELECT` из `information_schema`; ни DDL, ни записи, ни блокировок — повредить данные не может.
- **Нет ложных срабатываний на ETL-таблицах.** GP-схемы доменов `ck_fin_res`/`ck_client_exp`/`ua_data` не содержат `CREATE TABLE` (внешние данные ETL) → проверяются только app-таблицы (`acts`/`chat`/`admin`/`notifications`).
- **Паттерн запроса проверен на GP.** `= ANY($2::text[])` уже используется `_existing_tables_by_schema` в проде; `information_schema.columns` стандартен для GP 6.x (= PG 9.4).
- **Стоимость пренебрежима.** Один дополнительный `SELECT` на домен, только когда все его таблицы уже существуют (обычный старт).

Регрессии — `tests/db/test_adapters.py` (`TestExtractColumns`, `TestStaleTableWarning`), включая интеграционный кейс «таблица есть, но устарела → WARNING, схема не исполняется».

#### 6.5.5 Файлы миграций для развёрнутых БД

Расширяющее изменение **существующей** таблицы (§6.5.1) оформляется **одним markdown-файлом на изменение** в `docs/migrations/`. Ломающее изменение файла не получает — там пересоздание; целиком новая таблица тоже, её создаст `create_tables_if_not_exist`. Тем же файлом доносятся сидовые `INSERT`ы, которые иначе исполняются только при создании таблицы (например, новая строка в `roles`).

**Имя**: `YYYY-MM-DD-<таблица>-<поле>.md` — дата, таблица, что добавлено. Пример: [`2026-08-19-acts-content-version.md`](../migrations/2026-08-19-acts-content-version.md). Дата, а не сквозной номер: параллельные ветки и worktree не дерутся за следующий номер, а порядок применения читается прямо из имени. Две миграции за день — суффикс `-2`.

**Внутри — оба скрипта, PG и GP**, отдельными разделами: инсталляции разные, синтаксис тоже (§6.5.1 — на GP нет `IF NOT EXISTS` для `ADD COLUMN`/`CREATE INDEX`, нет `ON DELETE CASCADE` и plpgsql). Имена таблиц пишутся целиком, с дефолтным префиксом и схемой из `.env.dev`, плюс напоминание подставить свои, — как в [`drop-all-tables.md`](../migrations/drop-all-tables.md).

**Полнота изменения.** Миграция воспроизводит ВСЁ, что `schema.sql` объявляет для этого изменения: колонку с `DEFAULT`/`NOT NULL`, именованные CHECK (§6.5a), индексы, sequence, `COMMENT ON`, описания в комментариях. Не меньше — иначе развёрнутая БД тихо разойдётся со свежей и диагностика дрейфа (§6.5.4) этого не поймает, она сверяет только колонки. И не больше — объект, которого нет в `schema.sql`, на чистой установке не появится, то есть расхождение будет обратным. Триггеров в схемах нет вовсе и на GP они запрещены (§6.5.1); если такой объект однажды появится, он тоже обязан лежать в обоих местах.

**Обязательные разделы файла** (чтобы «когда и как применять» читалось без раскопок): тип изменения; кому нужна — с какой даты развёрнутые БД, и что на чистой БД накатывать не надо; что именно добавляется и зачем; что сломается, если не накатить; нужен ли бэкфилл и почему; SQL для PG; SQL для GP с оговорками про синтаксис и блокировки; проверочный запрос; откат.

**Применение** — руками, тем, кто накатывает релиз: приложение эти файлы не читает и не исполняет. Порядок — по дате в имени. Реестра применённых миграций нет: факт применения проверяется запросом из раздела «Проверка» и отсутствием WARNING'ов диагностики дрейфа на старте.

> **DO-блок в `schema.sql` файла миграции не заменяет.** В `app/domains/chat/migrations/*/schema.sql` есть идемпотентные `DO $$ … ADD COLUMN … $$` для `status`/`agent_ref`. Они срабатывают только тогда, когда схема домена вообще исполняется, — а исполняется она, лишь если хотя бы одной таблицы домена в БД нет (§6.5.4). На полностью развёрнутой БД такой блок молчит, и расширение всё равно нужно накатить файлом миграции.

### 6.5a Как добавить CHECK constraint

CHECK constraint'ы защищают инварианты данных на уровне БД и одновременно дают пользователю понятное сообщение об ошибке через глобальный обработчик `CheckViolationError` в `app/main.py`.

> Convention `check_<table>_<purpose>` ниже применяется к **новым** constraint'ам. Существующие имена (например `check_km_number_format`, `check_part_number_positive` в словаре `CHECK_CONSTRAINT_MESSAGES`, `app/core/exceptions.py:53-169`) остаются как есть — переименование требует миграции и риска десинхронизации `CHECK_CONSTRAINT_MESSAGES`.

CI-тест `tests/test_check_constraints_complete.py` автоматически проверяет, что каждый именованный CHECK в `schema.sql` имеет маппинг в `CHECK_CONSTRAINT_MESSAGES` — билд упадёт, если что-то пропустить.

#### Шаг 1. Дать constraint явное имя

Соглашение об именовании: `CONSTRAINT check_<table>_<purpose> CHECK (...)`.

Примеры:
- `CONSTRAINT check_acts_km_number_format CHECK (km_number ~ '^КМ-\d{2}-\d{5}$')`
- `CONSTRAINT check_chat_files_file_size_positive CHECK (file_size > 0)`
- `CONSTRAINT check_act_invoices_db_type_values CHECK (db_type IN ('hive', 'greenplum'))`

**Нельзя**: безымянный `CHECK (...)` в строке колонки — PostgreSQL сгенерирует нестабильное имя вида `<table>_<col>_check`, которое невозможно надёжно замапить. Тест `test_no_unnamed_checks_in_pg_schemas` упадёт.

#### Шаг 2. Добавить constraint в обе схемы (PG и GP)

`app/domains/<domain>/migrations/postgresql/schema.sql`:

```sql
CONSTRAINT check_act_invoices_db_type_values
    CHECK (db_type IN ('hive', 'greenplum'))
```

`app/domains/<domain>/migrations/greenplum/schema.sql` — то же самое. GP 6.x синтаксически поддерживает `CHECK`, логику НЕ меняем, только имя. Убедиться, что constraint-имена одинаковы в обоих файлах (иначе потребуются два маппинга — так исторически вышло у `act_invoices`: в `CHECK_CONSTRAINT_MESSAGES` живут и PG-имена `check_act_invoices_*`, и GP-имена `check_db_type_values`/`check_verification_status_values` с одинаковым текстом).

#### Шаг 3. Добавить маппинг в CHECK_CONSTRAINT_MESSAGES

Файл `app/core/exceptions.py`, словарь `CHECK_CONSTRAINT_MESSAGES`:

```python
"check_act_invoices_db_type_values": (
    "Недопустимый тип базы данных фактуры. Допустимые значения: hive, greenplum"
),
```

Правила хорошего сообщения:
- На русском языке, без технического жаргона.
- Если constraint проверяет допустимые значения — перечислить их явно.
- Если constraint проверяет формат — привести пример корректного значения.

#### Шаг 4. Добавить негативный тест

В тест-файле домена (или в новом) проверить, что вставка невалидного значения приводит к читаемой ошибке:

```python
import asyncpg
import pytest

async def test_invalid_db_type_raises_check_violation(mock_repo):
    with pytest.raises(asyncpg.CheckViolationError) as exc_info:
        await mock_repo.create_invoice(act_id=1, db_type="oracle", ...)
    assert exc_info.value.constraint_name == "check_act_invoices_db_type_values"
```

#### Шаг 5. Убедиться, что CI-lint проходит

```bash
pytest tests/test_check_constraints_complete.py -v
```

Тест `test_all_constraints_are_mapped` упадёт, если новый constraint не добавлен в маппинг.
Тест `test_no_orphan_keys_in_mapping` упадёт, если в маппинге остался ключ от удалённого constraint'а.
Тест `test_no_unnamed_checks_in_pg_schemas` упадёт, если в PG-схеме есть безымянный CHECK.

### 6.6 JSON/JSONB утилиты

Файл `app/db/utils/json_db_utils.py` — класс `JSONDBUtils` (stateless): конвертация JSON/JSONB из asyncpg в Python dict. Asyncpg возвращает JSON-поля строками — утилиты парсят их.

Рядом — `app/db/utils/sql_utils.py`: `validate_sql_identifier(name)` и `quote_ident(name)` для мест, где имя объекта приходит из настроек и подставляется в SQL текстом (плейсхолдер `$1` там неприменим).

### 6.7 Как добавить новое поле в таблицу

Пример: добавить колонку `priority INT DEFAULT 0 NOT NULL` в таблицу `acts`. Доменную семантику полей таблицы `acts` (КМ-номер, СЗ, audit_id) см. в §2 и §10 в [`data-model-acts.md`](../architecture/data-model-acts.md).

> **Напоминание**: приложение ALTER'ов не исполняет (см. §6.5.1). На чистой БД новая колонка появляется из обновлённой `schema.sql` сама, на уже развёрнутой — только файлом миграции, который пишется в том же коммите (§6.5.5, шаг 6).

**Шаг 1. Обновить PG-схему** — `app/domains/acts/migrations/postgresql/schema.sql`, в блок `CREATE TABLE … acts`:

```sql
CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}acts (
    id BIGSERIAL PRIMARY KEY,
    ...
    priority INT DEFAULT 0 NOT NULL,
    ...
);
```

**Шаг 2. Обновить GP-схему** — `app/domains/acts/migrations/greenplum/schema.sql`, тот же блок. Избегать запрещённого синтаксиса (см. §6.5). `INT DEFAULT 0 NOT NULL` — совместимо с GP 6.x.

**Шаг 3. Если поле требует валидации** — добавить именованный CHECK constraint и маппинг в `CHECK_CONSTRAINT_MESSAGES`. См. §6.5a.

```sql
priority INT DEFAULT 0 NOT NULL,
CONSTRAINT check_acts_priority_range
    CHECK (priority BETWEEN 0 AND 10),
```

**Шаг 4. Обновить Pydantic-схему** — `app/domains/acts/schemas.py` (если поле сериализуется в API):

```python
class ActOut(BaseModel):
    id: int
    km_number: str
    ...
    priority: int = 0
```

Если поле опциональное в input — добавить в соответствующий `ActUpdate`/`ActCreate`.

**Шаг 5. Обновить репозиторий** — `app/domains/acts/repositories/act_crud.py` (или соответствующий):

- В `INSERT`: добавить колонку и `$N`-параметр.
- В `UPDATE`: добавить `SET priority = $N` (если поле редактируется).
- В `SELECT *`: явно — обычно ничего не меняется, потому что `*` подтянет новую колонку. Если в репозитории явный список колонок (`SELECT id, km_number, ...`) — дописать `priority`.
- В маппинге row → dict (если есть): дописать ключ.

**Шаг 6. Донести изменение до уже развёрнутых БД** — написать файл миграции по формату §6.5.5: `docs/migrations/<дата>-acts-priority.md` с `ALTER TABLE` для PG и для GP. Чистой установке он не нужен — там таблицу создаст `create_tables_if_not_exist` уже с колонкой.

Для `NOT NULL`-колонки обязателен `DEFAULT` — и в `schema.sql`, и в миграции: без него упадут существующие INSERT'ы, которые эту колонку не перечисляют, а `ALTER TABLE` не пройдёт на непустой таблице. Бэкфилл существующих строк, как правило, не нужен — значение из `DEFAULT` и есть корректное для «этого поля у строки ещё не было»; если это не так, изменение не расширяющее, и его место в пересоздании (§6.5.1). UPDATE-бэкфилл на старте из lifespan — плохая практика (race при первом запуске, no-op после), не делайте так.

**Шаг 7. Тесты**.

- Если есть CHECK — негативный тест на невалидное значение (см. §6.5a, шаг 4).
- Тесты сервиса/репозитория, использующие `mock_conn.fetch.return_value = [...]`, обновить — добавить ключ `"priority"` в моки строк, иначе KeyError при маппинге.
- E2E-тесты API, проверяющие сериализацию `ActOut`, — обновить ожидаемые ответы.

**Шаг 8. Документировать** в `.env.dev` и `.env.prod`, если поле управляется конфигом (новая `ACTS__*`-настройка). См. §9.4.3 в [`deploy-and-configuration.md`](deploy-and-configuration.md).

### 6.8 Пример: добавление новой таблицы

**Шаг 1.** Добавить SQL в `app/domains/acts/migrations/postgresql/schema.sql`. Плейсхолдеры `{SCHEMA}.{PREFIX}` обязательны — bare-имена разойдутся между PG и GP (§6.5.1):

```sql
CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}act_attachments (
    id BIGSERIAL PRIMARY KEY,
    act_id INTEGER NOT NULL
        REFERENCES {SCHEMA}.{PREFIX}acts(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    file_path TEXT NOT NULL,
    uploaded_by VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Шаг 2.** Добавить аналог для Greenplum в `greenplum/schema.sql`: те же плейсхолдеры, но **без** `ON DELETE CASCADE` (GP 6 не поддерживает — каскад делает код под `adapter.supports_cascade_delete()`), плюс `WITH (appendonly=false)` и `DISTRIBUTED BY (act_id)`; ключ распределения обязан входить в PK, поэтому PK делается составным — `PRIMARY KEY (act_id, id)`.

**Шаг 3.** Создать репозиторий:

```python
# app/domains/acts/repositories/act_attachment.py
class ActAttachmentRepository(BaseRepository):
    def __init__(self, conn):
        super().__init__(conn)
        self.table = self.adapter.get_table_name("act_attachments")

    async def save(self, act_id: int, filename: str, path: str, username: str):
        await self.conn.execute(
            f"INSERT INTO {self.table} (act_id, filename, file_path, uploaded_by) "
            f"VALUES ($1, $2, $3, $4)",
            act_id, filename, path, username,
        )
```

**Шаг 4.** Перезапустить приложение — таблица создастся автоматически.

### 6.9 Добавление UA-справочника

Справочники UA (процессы, тербанки, метрики, типы риска и т.п.) — read-only-таблицы домена `ua_data`, используемые из других доменов через `DictionaryRepository`. На PostgreSQL они создаются автоматически по миграции; на Greenplum таблицы и view создаются вручную (наполняются ETL).

Пошаговый чек-лист добавления нового справочника (на примере `violation_risk_type_dict`):

**Шаг 1. PostgreSQL-миграция.** Добавить `CREATE TABLE` + сидовые `INSERT … ON CONFLICT DO NOTHING` в `app/domains/ua_data/migrations/postgresql/schema.sql`. Колонки-метки актуальны: `created_at`, `updated_at`, `created_by`, `updated_by`, `deleted_at`, `is_actual` — все справочники должны их иметь.

**Шаг 2. Настройки.** Добавить поле в `UaDataSettings` (`app/domains/ua_data/settings.py`) с дефолтным именем таблицы:

```python
violation_risk_type_dict: str = "t_db_oarb_ua_violation_risk_type_dict"
```

**Шаг 3. Репозиторий.** В `app/domains/ua_data/repositories/dictionary_repository.py`:
- проинициализировать атрибут через `q(s.<имя_поля>)` в `__init__`;
- добавить метод `get_<имя>() -> list[dict]` с фильтром `WHERE is_actual = true`.

**Шаг 4. Регистрация в потребителе.** Чтобы справочник стал доступен через `/api/v1/<domain>/dictionaries/{name}`:
- добавить ключ в `_DICT_DISPATCH` сервиса домена-потребителя (например, `app/domains/ck_fin_res/services/fr_validation_service.py`);
- расширить `Literal` в `app/domains/<domain>/api/dictionaries.py`.

**Шаг 5. `.env`, `.env.dev`, `.env.prod`.** Добавить переменную `UA_DATA__<NAME>=t_db_oarb_…` во все файлы рядом с остальными `UA_DATA__*` — позволяет переопределить имя таблицы без релиза кода.

**Шаг 6. Фронтенд.** На странице, где справочник используется:
- добавить ключ справочника в `static dictNames = [...]` конфига (например, `ck-fin-res-config.js`);
- описать поле как `{ key: '<поле>', type: 'dictionary', dict: '<имя_справочника>' }`.

**Шаг 7. Greenplum (вручную).** Таблицы UA-справочников в GP создаются и наполняются ETL — приложение их только читает. Перед первым запуском в проде нужно вручную выполнить DDL на двух схемах:

```sql
-- 1. Проектная схема: реальная таблица (DATABASE__GP__SCHEMA)
CREATE TABLE s_grnplm_ld_audit_da_project_4.t_db_oarb_ua_violation_risk_type_dict (
    id          SERIAL PRIMARY KEY,
    risk        TEXT NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP,
    created_by  TEXT DEFAULT 'system',
    updated_by  TEXT,
    deleted_at  TIMESTAMP,
    is_actual   BOOLEAN NOT NULL DEFAULT true
)
DISTRIBUTED BY (id);

-- сидовые INSERT'ы (для GP — без ON CONFLICT, см. ограничения совместимости ниже)

-- 2. Sandbox-схема: представление для приложения
CREATE OR REPLACE VIEW s_grnplm_ld_audit_da_sandbox_oarb.v_db_oarb_ua_violation_risk_type_dict AS
SELECT id, risk, created_at, updated_at, created_by, updated_by, deleted_at, is_actual
FROM   s_grnplm_ld_audit_da_project_4.t_db_oarb_ua_violation_risk_type_dict;
```

> Схему, из которой читает приложение, задаёт `UA_DATA__SCHEMA_NAME` (`DictionaryRepository` квалифицирует каждое имя через `adapter.qualify_table_name(name, s.schema_name)`). В `.env.dev`/`.env.prod` она закомментирована — то есть по умолчанию используется основная GP-схема (`DATABASE__GP__SCHEMA`). Sandbox-вариант выше рабочий только при явно выставленном `UA_DATA__SCHEMA_NAME`; иначе объект (таблица или VIEW) должен лежать в основной схеме.

GP-схема `app/domains/ua_data/migrations/greenplum/schema.sql` — заглушка из одного комментария; она нужна только для прохождения автомиграции.

> **Важно для Greenplum:** полный перечень запрещённого — §6.5.1. Коротко: никаких `CREATE INDEX/SEQUENCE IF NOT EXISTS`, `ON CONFLICT`, `ADD COLUMN IF NOT EXISTS`, `jsonb_set()`/`jsonb_pretty()`, `gen_random_uuid()`, `ON DELETE CASCADE`, триггеров и PL/pgSQL (GP 6.x ≈ PG 9.4). GP-адаптер выполняет SQL по одному statement и сам ловит `DuplicateTableError`/`DuplicateObjectError` — поэтому достаточно `CREATE INDEX` без `IF NOT EXISTS`.

**Шаг 8. Перезапуск.** На PG приложение создаст таблицу автоматически; на GP — после ручного DDL.

---
