# Домен `acts`: модель данных и deep-dive

Документ описывает домен `acts` целиком: доменную терминологию и жизненный цикл акта, структуру содержимого (`tree_data` и связанные сущности), блокировку, версионирование, валидацию, экспорт и сознательные ограничения конструктора. Это руководство для разработчика, впервые подходящего к домену: какие поля хранятся в `tree_data`, как они связаны с денормализованными таблицами, какие правила инвариантности должна соблюдать клиентская сторона и где лежат точки расширения.

Все артефакты исходят из реальных файлов проекта — где это важно, в тексте указаны ссылки `путь:строка`.

---

## Оглавление

1. [Введение](#1-введение)
2. [Доменная терминология и жизненный цикл акта](#2-доменная-терминология-и-жизненный-цикл-акта)
3. [Корневая структура](#3-корневая-структура)
4. [Node-типы](#4-node-типы)
5. [Pinned (закреплённые) узлы](#5-pinned-закреплённые-узлы)
6. [Protected узлы](#6-protected-узлы)
7. [Spec-таблицы (metrics и risk)](#7-spec-таблицы-metrics-и-risk)
8. [Invoice attachment (прикреплённые фактуры)](#8-invoice-attachment-прикреплённые-фактуры)
9. [Drag-and-drop: правила](#9-drag-and-drop-правила)
10. [Блокировка акта (lock) и inactivity dialog](#10-блокировка-акта-lock-и-inactivity-dialog)
11. [Версионирование содержимого и аудит-лог](#11-версионирование-содержимого-и-аудит-лог)
12. [Статус валидации содержимого](#12-статус-валидации-содержимого)
13. [Карточка нарушения: контракт полей и рендер](#13-карточка-нарушения-контракт-полей-и-рендер)
14. [Экспорт](#14-экспорт)
15. [Как добавить новый тип блока конструктора](#15-как-добавить-новый-тип-блока-конструктора)
16. [URL страницы акта](#16-url-страницы-акта)
17. [Фронтенд: AppState, StorageManager, LockManager](#17-фронтенд-appstate-storagemanager-lockmanager)
18. [Сознательные ограничения конструктора](#18-сознательные-ограничения-конструктора)
19. [Примеры](#19-примеры)
20. [Версионирование схемы](#20-версионирование-схемы)

---

## 1. Введение

**Что такое `tree_data`.** Это JSONB-документ с иерархической структурой акта. Хранится в таблице `act_tree` (одна запись на акт, см. `app/domains/acts/migrations/postgresql/schema.sql:137`). Корневой узел `{id: "root", label: "Акт", children: [...]}` — шесть защищённых разделов (1–5 плюс обязательный пункт «Process Mining», id `6`; см. §6), а в `children` — пункты, подпункты, таблицы, текстовые блоки и нарушения. Если запись отсутствует, репозиторий возвращает пустой каркас `{"id": "root", "label": "Акт", "children": []}` (`app/domains/acts/repositories/act_content.py:155`).

**Где живёт всё остальное содержимое.** Дерево хранит только структуру и ссылки. Тяжёлые данные вынесены в отдельные таблицы:

| Таблица           | Что хранит                                                                  | Ссылка из дерева             |
|-------------------|-----------------------------------------------------------------------------|------------------------------|
| `act_tree`        | сам JSONB `tree_data`                                                       | сам корень                    |
| `act_tables`      | сетки таблиц (`grid_data`), ширины колонок, флаги спец-таблиц                | `node.tableId`               |
| `act_textblocks`  | HTML-контент текстовых блоков и базовое форматирование                       | `node.textBlockId`           |
| `act_violations`  | поля нарушения (нарушено, установлено, причины, последствия…) | `node.violationId`           |
| `act_invoices`    | фактуры, прикреплённые к листьям раздела 5                                   | `node.invoice` + `node.id`   |
| `act_directives`  | поручения по пунктам акта                                                    | `node_id`                    |
| `acts`            | метаданные акта (КМ, СЗ, даты, audit_act_id и т.д.; блокировка — не здесь, а в Redis `lock:act:{id}`) | владелец всех остальных      |

**API между фронтом и бэком.**

- На загрузку: `ActContentRepository.get_content(act_id)` возвращает `{tree, tables, textBlocks, violations}` (`app/domains/acts/repositories/act_content.py:41`). Фактуры подмешиваются в `node.invoice` фронт-кодом `APIClient._attachInvoicesToTree` (`static/js/shared/api.js:1059`).
- На сохранение: фронт отдаёт `ActDataSchema` (`app/domains/acts/schemas/act_content.py`) — те же четыре раздела + `invoiceNodeIds`, `changelog`, `saveType`. Единую плоскую транзакцию (контент + diff аудита + снимок версии) держит сервис `ActContentService.save_content`; репозиторий собственную транзакцию не открывает (контракт в его докстринге). `_save_tree` UPDATE-ит JSONB, остальные секции делают `DELETE … WHERE act_id` + `executemany INSERT`.

Денормализация (дублирование `node_number`, `audit_point_id`, `audit_act_id` в `act_tables`/`act_textblocks`/`act_violations`/`act_invoices`) нужна для BI/выгрузок и поиска. Источник истины — `tree_data`; при сохранении бэк рассчитывает `node_map` и `audit_point_map` единым обходом дерева (`ActContentService::save_content` → `ActContentRepository::_save_tree`) и проставляет денормализованные поля.

---

## 2. Доменная терминология и жизненный цикл акта

### 2.1. Терминология и форматы

| Термин | Формат / описание |
|---|---|
| **КМ-номер** | Номер контрольного мероприятия. Формат `КМ-XX-XXXXX`, CHECK `check_km_number_format`: `km_number ~ '^КМ-\d{2}-\d{5}$'` (`migrations/postgresql/schema.sql:55`). В БД хранится дважды: строкой `km_number VARCHAR(50)` и числом `km_number_digit INTEGER` — для поиска по цифровой части. Отдельный CHECK `check_km_number_digit_length` требует ровно 7 знаков в десятичной записи цифровой части |
| **Служебная записка (СЗ)** | Номер документа для актов, отправленных на рассмотрение. Формат `Text/YYYY`, CHECK `check_service_note_format`: `service_note IS NULL OR service_note ~ '^.+/\d{4}$'`. NULL — пока акт не отправлен; парность с `service_note_date` держит CHECK `check_service_note_consistency` (оба NULL либо оба NOT NULL) |
| **Часть акта** | Один акт может состоять из нескольких частей (`part_number`, `total_parts`, оба CHECK `> 0`). Уникальность — пара `(km_number_digit, part_number)`. **В PG она закреплена констрейнтом `UNIQUE(km_number_digit, part_number)`, в GP — только на уровне приложения** (`ActCrudService.create_act` → `ActCrudRepository.check_km_part_uniqueness`, при конфликте `KmConflictError` → HTTP 409). Причина — правило GP «`DISTRIBUTED BY` ⊆ каждого `UNIQUE`»: таблица `acts` распределена по `id`, добавить UNIQUE по другим колонкам нельзя |
| **Тип проверки** | `is_process_based BOOLEAN`: `TRUE` — процессная, `FALSE` — непроцессная. Отличаются заголовком раздела 1 и наполнением раздела 2. Смена типа перестраивает разделы 1–2 (`ActCrudService.restructure_sections_for_type_change`: разделы очищаются, для процессной в раздел 2 заново добавляется таблица «Результаты оценки качества процесса», `preset=qualityAssessment`, — независимо от того, была ли она перед этим удалена пользователем; разделы 3–5 не затрагиваются). Эта таблица — единственная предустановленная таблица, которую можно удалить вручную и вернуть через контекстное меню раздела 2 (маркер `special: 'quality_assessment'`, см. §6), но смена типа акта по-прежнему создаёт её заново, а не восстанавливает. Тесты — `tests/domains/acts/test_restructure_tree.py` |
| **Предписания (поручения)** | Задачи на исправление/улучшение для подразделений. Таблица `act_directives` (`migrations/postgresql/schema.sql:113`), CHECK `check_point_number_format` ограничивает `point_number` пунктами раздела 5 (`^5\.([\d]+\.)*[\d]+$`). Валидатор — `app/domains/acts/utils/act_directives_validator.py`; право заводить поручения проверяет `AccessGuard.require_management_role` |
| **Роли в акте** | `Куратор`, `Руководитель`, `Редактор`, `Участник`, `AppendixRef` — таблица `audit_team_members`, CHECK `check_audit_team_role_values` (`schema.sql:96`). Доступ проверяет `AccessGuard` (`services/access_guard.py`): `Участник` — только просмотр (`require_edit_permission` его отсекает), управленческие операции доступны только `Куратор`/`Руководитель` (`require_management_role`). `AppendixRef` — техническая запись-ссылка на приложение, не участник группы |
| **audit_act_id** | `VARCHAR(36)` — идентификатор акта во внешнем audit-id-сервисе, для сопоставления с фактурами Hive/GP. Денормализован во все дочерние таблицы (`audit_team_members`, `act_directives`, `act_tables`, `act_textblocks`, `act_violations`, `act_invoices` — у каждой свой partial-индекс). Сейчас в коде — заглушка `AuditIdService` (`app/services/audit_id_service.py`); конечная точка задаётся полями `audit_id_service_url` / `audit_id_service_timeout` корневого `Settings` (`app/core/config.py:280`) |

### 2.2. Жизненный цикл акта

Отдельной колонки-статуса у акта **нет** — состояние выражается набором полей и флагов (`service_note`, `needs_created_date`, `needs_directive_number`, `needs_invoice_check`, `needs_service_note`, `validation_status`).

```
[1] Создание                       POST /api/v1/acts/create           → 201 ActResponse
        ↓                          (409 KmConflictError при дубле КМ+части)
[2] Взятие блокировки              POST /api/v1/acts/{act_id}/lock
        ↓                          (продление — /extend-lock, снятие — /unlock)
[3] Редактирование содержимого     PUT  /api/v1/acts/{act_id}/content  (требует свой активный lock)
        ↓                          → снимок act_content_versions + запись в audit_log
        ↓                          → пересчёт validation_status
[4] Правка метаданных, в т.ч.      PATCH /api/v1/acts/{act_id}
        отправка на рассмотрение   (проставление service_note + service_note_date)
        ↓
[5] Экспорт в файл                 POST /api/v1/acts/export/save-act?act_id=…&fmt=txt|md|docx
        ↓                          затем GET /api/v1/acts/export/download/{filename}
[6] Удаление (при необходимости)   DELETE /api/v1/acts/{act_id}
```

Дополнительно: `POST /api/v1/acts/{act_id}/duplicate` (копия акта), `POST /api/v1/acts/{act_id}/audit-point-ids` (выдача `audit_point_id` узлам), `GET /api/v1/acts/list`, `GET /api/v1/acts/attention-summary`, `GET /api/v1/acts/limits`, `GET /api/v1/acts/config/lock`, `GET /api/v1/acts/config/invoice`. Роутеры и их префиксы — `app/domains/acts/api/__init__.py` (`limits` и `editor-telemetry` регистрируются **до** `management`, иначе литеральный путь затенился бы маршрутом `GET /{act_id}`).

Отдельного эндпоинта «отправить на рассмотрение» нет: СЗ проставляется обычным PATCH метаданных, `ActCrudService` при этом валидирует формат и извлекает суффикс года (`KMUtils.extract_service_note_suffix`).

На ключевых шагах пишется запись в `audit_log` (см. §11). Блокировка отпускается явным `/unlock` либо истекает сама по TTL (см. §10).

---

## 3. Корневая структура

Тело `ActDataSchema` — четыре основных раздела + служебные поля:

```jsonc
{
  "tree":          { /* корневой узел: {id:"root", label:"Акт", children:[…]} */ },
  "tables":        { "<tableId>":     TableSchema,     … },
  "textBlocks":    { "<textBlockId>": TextBlockSchema, … },
  "violations":    { "<violationId>": ViolationSchema, … },
  "invoiceNodeIds": ["<nodeId>", …],
  "changelog":     [ /* гранулярный лог локальных изменений */ ],
  "saveType":      "manual" | "periodic" | "auto"
}
```

Pydantic-описание: `ActDataSchema` (`app/domains/acts/schemas/act_content.py::ActDataSchema`). Поле `saveType` валидируется по regex `^(manual|periodic|auto)$`.

**Ссылочная целостность (на app-уровне).** Жёсткой FK между узлами и `act_tables`/`act_textblocks`/`act_violations` нет (всё перезаписывается одной транзакцией). Связь идёт по `id` контейнера и `nodeId` узла:

- Узел `type=table` имеет `tableId`, ожидается запись в `tables[tableId]`, `tables[tableId].nodeId === node.id`. **Рассогласование лечится мягко в обе стороны, без 422** (решение «lenient», findings 3+8): листовой узел с висячей ссылкой (запись словаря отсутствует) **удаляется из дерева ЦЕЛИКОМ** при сохранении, а не просто снимается с него ссылка. `ActDataSchema.collect_dangling_refs()` собирает такие ссылки, `ActContentService._strip_dangling_refs` вырезает узлы-носители из `children` родителя перед записью. Снять только поле-ссылку было мало: оставался бы бессодержательный «узел-зомби», который walker экспорта всё равно отрисует (пустая «Таблица N»), а пересохранение его не вычистит (висячей ссылки уже нет). Фронт зеркалит это в `act-content-sanitizer.js` (поле отчёта `removedNodes`). Удаление безусловно: защищённые секции 1–5 это `type='item'` без листовых ссылок, под удаление не попадают.
- Аналогично для `type=textblock` (`textBlockId` ↔ `textBlocks[id]`) и `type=violation` (`violationId` ↔ `violations[id]`).
- Обратная сторона: записи в `tables`/`textBlocks`/`violations` без соответствующего узла-носителя в БД не попадают — orphan-фильтр репозитория отбрасывает их при сохранении (с warning-логом) для всех трёх словарей. Фронт дополнительно чистит сирот при удалении узлов (`_deleteNodeData` в `state-tree.js`).
- Когда при сохранении что-то вычищено (удалённые узлы-зомби и/или отброшенные сироты), ответ `PUT /content` несёт одно русскоязычное предупреждение в поле `warning` (`SaveContentResponse.warning`, `str | null`; фронт читает `result.warning`); `status` остаётся `success`. Нулевая половина в тексте опускается, `null` — если чистить было нечего.
- **Статус валидации содержимого.** При каждом сохранении (и при restore версии) бэк вычисляет статус структуры акта и персистит его в `acts.validation_status` + `acts.validation_issues`. Это **отдельная** от `verification_status` (фактуры) и от блокировки система-сигнал «есть что проверить». Полностью — §12.
- `invoiceNodeIds` — плоский список ID узлов, у которых на фронте проставлено `node.invoice`. По нему бэк синхронизирует `act_invoices`: всё, чего нет в списке, удаляется (`act_content.py::_sync_invoices`, `564-603`).

---

## 4. Node-типы

Pydantic-описание узла дерева — `ActItemSchema` (`app/domains/acts/schemas/act_content.py::ActItemSchema`). Поле `type` ограничено `Literal["item", "textblock", "violation", "table"]`. С точки зрения семантики узлы делятся на две группы:

- **Item-узлы** (`type="item"`, либо отсутствие `type` — фронт трактует это как `item`: `_isInformationalNode` не относит его к информационным, см. ниже) — структурные пункты. Могут иметь `children`.
- **Content-узлы** (`type="table" | "textblock" | "violation"`) — «информационные» узлы по фронт-терминологии (`tree-utils.js::_isInformationalNode`, `271`). У них не должно быть `children` (drag-and-drop запрещает делать их родителями: `canAcceptAsChild`, `tree-drag-drop.js:153`).

Канон набора типов держат два реестра — `app/domains/acts/block_types.py` (`NODE_TYPES`, `LEAF_BLOCK_TYPES`, `LEAF_BLOCK_REFS`) и фронтовый `static/js/constructor/block-types.js`; как добавить новый тип — §15.

Сводная таблица обязательности полей. «—» означает «не используется/не имеет смысла».

| Поле                  | item                 | table                | textblock            | violation            | Описание                                                                                       |
|-----------------------|----------------------|----------------------|----------------------|----------------------|------------------------------------------------------------------------------------------------|
| `id`                  | обяз.                | обяз.                | обяз.                | обяз.                | уникальный ID узла в пределах дерева                                                            |
| `label`               | обяз.                | обяз.                | обяз.                | обяз.                | отображаемый текст                                                                              |
| `type`                | опц. (`"item"` или отсутствует) | `"table"`     | `"textblock"`        | `"violation"`        | дискриминатор; для `item` фронт допускает отсутствие                                            |
| `children`            | список               | пусто/отсутствует    | пусто/отсутствует    | пусто/отсутствует    | дочерние узлы (рекурсивная схема)                                                               |
| `content`             | строка               | —                    | —                    | —                    | текстовое содержимое пункта (для item; для content-узлов фронт пишет туда `""`)                |
| `tableId`             | —                    | обяз.                | —                    | —                    | FK на `tables[tableId]`                                                                         |
| `textBlockId`         | —                    | —                    | обяз.                | —                    | FK на `textBlocks[id]`                                                                          |
| `violationId`         | —                    | —                    | —                    | обяз.                | FK на `violations[id]`                                                                          |
| `number`              | опц.                 | опц.                 | опц.                 | опц.                 | автогенерируется фронтом: для item — иерархия (`5.1.2`), для content — `"Таблица N"` и т.п. (`state-tree.js::generateNumbering`, `29`) |
| `customLabel`         | опц.                 | опц.                 | опц.                 | опц.                 | пользовательское название (приоритет над автоматическим)                                        |
| `protected`           | опц., default false  | опц., default false  | опц., default false  | опц., default false  | защита от перемещения и удаления (для разделов 1–5 и пункта Process Mining: `true`)              |
| `deletable`           | опц., default true   | опц., default true   | опц., default true   | опц., default true   | разрешено ли удаление; работает независимо от `protected`                                       |
| `kind`                | —                    | опц., default `'regular'` | —               | —                    | подвид таблицы (enum, см. §7): `regular`/`metrics`/`mainMetrics`/`regularRisk`/`operationalRisk`/`taxRisk`/`otherRisk`. Источник истины на узле; дублируется в `tables[tableId].kind` (`table-kind.js`) |
| `tb`                  | опц., только под 5.* | —                    | —                    | —                    | массив аббревиатур территориальных банков (см. `AppConfig.territorialBanks`, `app-config.js:16-28`) |
| `invoice`             | опц., только под 5.* | —                    | —                    | —                    | прикреплённая фактура (см. §8); НЕ сериализуется бэкендом, существует только во фронт-объекте  |
| `auditPointId`        | опц.                 | опц.                 | опц.                 | опц.                 | UUID точки аудита, выданный внешним сервисом (`AuditIdService`, `services/id-generator.js`)    |
| `special`             | опц.                 | опц.                 | опц.                 | опц.                 | маркер спец-узла: `'process_mining'` на пункте Process Mining, `'quality_assessment'` на таблице раздела 2 (§6); драйвит фронт-предикаты (`_isUnderProcessMining`, пункты контекстного меню), бэк только хранит |
| `titleLocked`         | опц.                 | опц.                 | опц.                 | опц.                 | заголовок узла защищён от редактирования двойным кликом; сейчас проставляется только пункту Process Mining |
| `parentId`            | runtime-only         | runtime-only         | runtime-only         | runtime-only         | техническое поле фронта; в сериализованный `tree_data` не попадает напрямую                     |

Замечания:

- Подвид таблицы кодируется единым enum-полем `kind` (а не набором boolean-флагов `is*Table` — те убраны в kind-рефакторе, `table-kind.js`). Источник истины — `kind` на узле-таблице; значение дублируется в `tables[tableId].kind` для денормализованной выгрузки в `act_tables` (колонка `kind VARCHAR(20)` + CHECK `check_table_kind_values`). Согласованность node↔table при загрузке поддерживает `reconcileTableKind`.
- Проверка «закреплённости»: `isPinnedTable(node)` = `kind !== 'regular'`; «является ли risk-таблицей»: `isRiskTable(node)` = `kind ∈ {regularRisk, operationalRisk, taxRisk, otherRisk}` (`table-kind.js`).
- В сохранённом дереве `_serializeTree` (`state-core.js:592`) форсирует `protected` и `deletable` к булевым значениям и взаимоисключает `content` ↔ `tableId/textBlockId/violationId` (content пишется только для item-узлов).
- `special`/`titleLocked` объявлены в `ActItemSchema` наравне с остальными полями узла (`app/domains/acts/schemas/act_content.py`). До этого политика `extra='ignore'` молча отбрасывала их при сохранении вместе с любыми незадекларированными полями — после перезагрузки акта пункт Process Mining терял и защиту от нарушений/рисков (`special`), и фиксацию заголовка (`titleLocked`). Регрессия — `tests/test_schemas.py`.
- **Глубина дерева ограничена с двух сторон разными числами**: бэк — `ACTS__RESOURCE__MAX_TREE_DEPTH=50` (жёсткая проверка при сохранении, `settings.py::ResourceSettings.max_tree_depth`), фронт — `AppConfig.tree.maxDepth = 4` (гейт drag-and-drop и создания узлов, см. §9). Бэковый лимит — защита от bomb-нагрузки, фронтовый — продуктовое ограничение вложенности.

### 4.1. Подсхемы вложенных сущностей

`TableCellSchema` (`act_content.py::TableCellSchema`) — ячейка матричной таблицы:

| Поле          | Тип / default       | Назначение                                                                                       |
|---------------|---------------------|---------------------------------------------------------------------------------------------------|
| `content`     | str, default `""`   | текстовое содержимое ячейки                                                                       |
| `isHeader`    | bool, default false | признак заголовка                                                                                 |
| `colSpan`     | int ≥ 1, default 1  | горизонтальный span                                                                               |
| `rowSpan`     | int ≥ 1, default 1  | вертикальный span                                                                                 |
| `isSpanned`   | bool, default false | признак ячейки, скрытой под объединением                                                          |
| `spanOrigin`  | `{row,col}` или null| координаты «главной» ячейки объединения                                                           |
| `originRow`   | int ≥ 0 / null      | строка, где была создана ячейка                                                                   |
| `originCol`   | int ≥ 0 / null      | колонка, где была создана ячейка                                                                   |

`TableSchema` (`act_content.py::TableSchema`):

| Поле                      | Тип / default                | Назначение                                                                                              |
|---------------------------|------------------------------|---------------------------------------------------------------------------------------------------------|
| `id`                      | str (обяз.)                  | ID таблицы (ключ в `tables`)                                                                            |
| `nodeId`                  | str (обяз.)                  | ID узла-носителя                                                                                        |
| `grid`                    | `list[list[TableCellSchema]]`, max 64 строк, ≤ 16 колонок в каждой | матрица ячеек; ограничение защищает от исчерпания памяти |
| `colWidths`               | `list[int]`, max 16, все > 0 | относительные веса ширины колонок (DOCX-билдер нормирует по сумме; редактор рендерит colgroup в %)        |
| `protected`               | bool, default false          | защита от изменения структуры (добавление/удаление строк/колонок)                                       |
| `deletable`               | bool, default true           | можно ли удалить таблицу                                                                                |
| `kind`                    | `TableKind`, default `'regular'` | подвид таблицы (`act_content.py::TABLE_KINDS`, `109`; поле `TableSchema.kind`, `205`): `regular`/`metrics`/`mainMetrics`/`regularRisk`/`operationalRisk`/`taxRisk`/`otherRisk`; зеркалит `node.kind`. CHECK `check_table_kind_values` в миграциях PG/GP |

Границы `max_rows`/`max_cols`/`min_col_width_px` — настройки `ACTS__TABLES__*`; фронт получает их через `GET /api/v1/acts/limits`, а не хардкодит.

`TextBlockSchema` (`act_content.py::TextBlockSchema`):

| Поле          | Тип / default                              | Назначение                                                            |
|---------------|---------------------------------------------|-----------------------------------------------------------------------|
| `id`          | str                                         | ID блока                                                              |
| `nodeId`      | str                                         | ID узла-носителя                                                       |
| `content`     | str, default `""`                           | HTML — единственный источник форматирования: `<b>/<i>/<u>`, `span[style="font-size"]`, `text-align` блочных элементов, капсулы ссылок/сносок |

Прежний контейнерный объект `formatting {fontSize, alignment, bold, italic,
underline}` **вырезан целиком** (директива владельца): он писался один раз
при создании блока и правками не обновлялся — всё форматирование живёт в
`content`. При `extra="forbid"` подача поля `formatting` теперь **отвергается**
(шим-валидатор `_drop_legacy_formatting` снят — обратная совместимость не
нужна, БД пересоздаётся с нуля); базовый размер шрифта — единый дефолт
настроек (`ACTS__TEXTBLOCKS__FONT_SIZE_*`, пункты — тот же кегль уходит в
DOCX без конвертации), не хранится per-block. Deep-dive — [`textblock-editor-architecture.md`](textblock-editor-architecture.md) §2/§10.

`ViolationSchema` (`act_content.py::ViolationSchema`) — нарушение, прикреплённое к узлу; блочная модель (полный дизайн реестра — §13):

| Поле         | Тип                    | Назначение                                                  |
|--------------|-------------------------|---------------------------------------------------------------|
| `id`         | str                     | ID нарушения                                                 |
| `nodeId`     | str                     | ID узла-носителя                                             |
| `fieldOrder` | `list[str] \| None`     | Пользовательский порядок отображения 10 полей; `None` (дефолт) — стандартный порядок (`default_order` реестра). Валидатор `validate_field_order` требует перестановку ВСЕХ ключей реестра ровно по разу (ловит дубли/пропуски/чужие ключи) |
| `violated`, `established`, `description`, `codeMining`, `processMining`, `additionalContent`, `reasons`, `measures`, `consequences`, `responsible` | `ViolationFieldSchema` (×10) | Поля-контейнеры; состав, колонки БД, метки и флаги `mandatory`/`small` задаёт реестр `app/domains/acts/violation_fields.py` (§13) |

`ViolationFieldSchema` — единая форма у всех десяти полей: `{enabled: bool, blocks: list[ViolationBlock]}`. У mandatory-полей (`violated`/`established`) чекбокса в UI нет — `enabled` принудительно `True` (`ViolationSchema.enforce_mandatory_enabled`, model_validator). Лимит числа блоков в поле — `ACTS__IMAGES__MAX_ITEMS_PER_VIOLATION` (валидатор `validate_blocks_count` НА МОДЕЛИ контейнера, не Field-аннотацией на списке: комбинация `Len`-аннотации с внутренним дискриминатором ломала сборку схемы на отдельных версиях pydantic — issues #9503/#10352).

**Блоки** — плоский payload (по образцу Portable Text/BlockNote, без Notion-вложенности), дискриминированный union `ViolationBlock` по строковому полю `type` (прямой lookup по тегу, без callable Tag/Discriminator). Стабильный `id = str(uuid4())` на весь жизненный цикл блока (нужен диффу версий и DnD). Неизвестный `type` → HTTP 422, fallback'а сознательно нет:

| Схема | Поля | Назначение |
|---|---|---|
| `ViolationTextBlockSchema` | `id`, `type: "text"`, `content` | Rich-HTML текст-блок — та же rich-поверхность и allowlist, что у `TextBlockSchema.content` (форматирование, выравнивание, размер, капсулы-ссылки, списки `<ul>/<ol>/<li>`; сноски запрещены политикой) |
| `ViolationImageBlockSchema` | `id`, `type: "image"`, `url`, `caption`, `filename`, `width` | Inline-картинка: `url` — data:image-URL разрешённого растрового формата (whitelist из `ACTS__IMAGES__ALLOWED_MIME_TYPES`, валидатор `validate_image_url`, лимит длины `VIOLATION_IMAGE_URL_MAX_LENGTH`); `caption` — rich-HTML; `filename`/`url` — plain/verbatim; `width` 0–100 (% полезной ширины страницы, `0` — авто) |
| `ViolationTableBlockSchema` | `id`, `type: "table"`, `table: EmbeddedTableSchema` | Обычная таблица. `EmbeddedTableSchema` — сиблинг `TableSchema` (оба наследуют `TableGridSchema`, см. выше): та же сетка/`colWidths`/структурные инварианты, но без `id`/`nodeId`/`protected`/`deletable`/`kind` (адресация — по id блока-обёртки; подвид всегда «обычная» таблица — metrics/risk-подвиды, пины и каскады metrics↔risk — семантика дерева, к нарушению не относится). Ячейки хранятся дословно (plain-текст, тот же инвариант B8, что у больших таблиц узла) |

Лимиты картинок (число, байты на файл, байты на акт) считаются по ВСЕМ полям нарушения совокупно, а не по отдельному полю — зеркалятся на фронте (`_validateSubtreeContentItems` в `validation-tree.js`, `estimateActImageBytes`). При сохранении rich-содержимое (`text.content`, `image.caption`) санитизируется `sanitize_rich_html` (nh3; текстблоки — bleach, общий allowlist `ACTS__SANITIZER__*`); ячейки table-блоков — verbatim, не трогаются. Деталь санитайзера — §13, deep-dive §9.3/§15 в [`textblock-editor-architecture.md`](textblock-editor-architecture.md).

Шесть текстовых полей нарушения (`violated`/`established`/`reasons`/`measures`/`consequences`/`responsible`) можно автозаполнить из свободного описания — кнопка
«✨ Формализовать из текста» на карточке нарушения зовёт формализатор
(`app/domains/chat/services/text_actions/formalizer_service.py`, эндпоинт
`POST /api/v1/chat/text-actions/formalize-violation`): 4 экстрактора D17 разбирают
текст параллельно и раскладывают его по полям (что не извлеклось — контейнер не трогается; уже
заполненное поле пустым ответом не затирается). CodeMining/ProcessMining формализатор не заполняет — гарантия держится составом полей `FormalizeResponse` (фронт применяет пересечение ключей ответа с реестром, `formalizedFieldKeys`). Каждое непустое значение ответа уходит НОВЫМ text-блоком в конец своего поля (`ViolationManager._applyFormalized`, `violation-core.js`) с автовключением чекбокса поля. Контракт ответа: ВСЕ поля — готовый безопасный HTML (бэкенд экранирует скаляры + `\n`→`<br>`, списки — `<ul><li>`), фронт только санитизирует `SafeHTML.sanitize(value, 'acts')` — эвристики «HTML или plain» нет. Провал всех экстракторов → 503 `TextActionUnavailableError` («ИИ-сервис недоступен»), а не пустой успех; частичный провал даёт частичный результат. Заголовок панели
подставляет реальный
номер родительского пункта, свободный текст предзаполняется текущими полями карточки.
Вторым этапом (по извлечённым полям) формализатор возвращает `recommendations` —
дисплей-онли подсказки «чего не хватает в описании»: показываются в панели рядом с
превью, но в карточку и экспорт НЕ пишутся (кнопка «Применить» их не трогает).

---

## 5. Pinned (закреплённые) узлы

**Что это.** Узлы, которые удерживаются в начале массива `children` родителя и не могут быть перетащены/смещены ниже обычных пунктов. Используется для спец-таблиц.

**Какие узлы считаются pinned.** `TreeUtils.isPinnedTable` (`static/js/constructor/tree/tree-utils.js:355`) делегирует единому дискриминатору `table-kind.js::isPinnedTable` (один источник истины):

```js
// tree-utils.js
isPinnedTable(node) {
    return kindIsPinnedTable(node);   // table-kind.js: node.type === 'table' && node.kind !== 'regular'
}
```

То есть pinned — любая таблица с подвидом `kind`, отличным от `'regular'`:

1. таблицы метрик пункта `5.X` (`kind='metrics'`),
2. главная сводная таблица метрик раздела 5 (`kind='mainMetrics'`),
3. таблицы рисков (`kind ∈ {regularRisk, operationalRisk, taxRisk, otherRisk}`).

**Правила сортировки.** Метод `AppState._getFirstNonPinnedIndex(parent)` (`state-tree.js:821`) ищет первый незакреплённый индекс в `children` родителя — это «нижняя граница» pinned-зоны. Используется в двух местах:

- При drag-and-drop: если `position === 'before'/'after'` указывает в pinned-зону, эффективный индекс прижимается вниз (`_performMove`, `state-tree.js:784`). Дополнительно `_calculateDropPosition` (`tree-drag-drop.js:203`) запрещает `'before'` на pinned-узле и блокирует `'after'` между двумя соседними pinned-таблицами.
- При создании risk-таблицы: вставляется по индексу `_getFirstNonPinnedIndex` (`state-content.js:562`, `601`, `739`, `827` — `_createRegularRiskTable`/`_createOperationalRiskTable`/`_createTaxRiskTable`/`_createOtherRiskTable`).

Метрик-таблицы (`kind='metrics'`, `kind='mainMetrics'`) создаются через `node.children.unshift(tableNode)` (`state-content.js:269`, `state-content.js:423`) — то есть всегда первыми. Если в `children` уже есть pinned-таблицы, новая всё равно встаёт нулевой; порядок между metrics и risk на одном уровне определяется временем создания.

---

## 6. Protected узлы

**Что это.** Узлы с флагом `protected: true`. Дополнительно у них может стоять `deletable: false` — это два независимых ограничения.

**Где задаётся.** Разделы 1–5 создаются защищёнными при инициализации дерева через `_createProtectedSection` (`state-core.js:76`):

```js
{
    id, label,
    protected: true,
    deletable: false,
    children: [],
    content: ''
}
```

Список разделов — `AppConfig.tree.defaultSections` (`app-config.js:331-337`): `1` «Информация о процессе, клиентском пути» (для непроцессной проверки — «Характеристика проверяемого направления», подставляется в `state-core.js::_createRootStructure`), `2` «Оценка качества…», `3` «Примененные технологии», `4` «Основные выводы», `5` «Результаты проверки». Шестым на 0 уровне для ОБОИХ типов проверки встаёт обязательный пункт «Process Mining» — он не входит в `defaultSections` (фиксированный `label`, `special: 'process_mining'`, `titleLocked: true` отличают его от пяти разделов), а описан отдельным дескриптором `AppConfig.tree.processMiningSection` (`app-config.js:343`) и создаётся `_createProcessMiningSection` (`state-core.js:101`), которую `_createRootStructure` зовёт последней (`state-core.js:67`).

Помимо разделов, `protected: true` ставится фронт-кодом всем спец-таблицам (metrics, main metrics, regular risk, operational risk — `state-content.js:280,434,573,612,750,840`) и предустановленным таблицам разделов 2 и 3 через общий `_createTableFromPreset`/`_createSimpleTable` (`state-core.js:184`; вызовы — `_createQualityAssessmentTable` для раздела 2, `state-core.js:166`, и `_createInitialTables` для раздела 3, `state-core.js:139-141`).

**Что нельзя делать с protected-узлами:**

| Действие                  | Ограничение                                                                                     |
|---------------------------|--------------------------------------------------------------------------------------------------|
| Удаление                  | Если `deletable === false` — невозможно ни через UI, ни через `deleteNode` (`state-tree.js`). Разделы 1–5 и пункт Process Mining имеют `deletable: false`. |
| Перемещение               | Drag запрещён в `_validateMove` (`state-tree.js:507`) и при `dragstart` (`tree-drag-drop.js:109`). |
| Изменение структуры таблицы | Для `protected: true` таблиц добавление/удаление строк и колонок блокируется в `table-cells-operations.js` (см. строки 398, 480, 653, 979, 1064). |

`deletable` работает независимо: можно иметь `protected: true, deletable: true` (защищена от перемещения, но удалить можно) — такая комбинация встречается у спец-таблиц и у таблицы раздела 2 «Результаты оценки качества процесса» (`special: 'quality_assessment'`): та тоже `protected: true`, но, в отличие от разделов и предустановленных таблиц раздела 3, `deletable: true` — её можно удалить и вернуть пунктом контекстного меню (§9), при этом `kind` у неё остаётся `'regular'` — она сознательно не спец-таблица в смысле §7 и не попадает под pinned-правила.

---

## 7. Spec-таблицы (metrics и risk)

### 7.1. Metrics-таблицы

**Цель.** Сводка отклонений по узлам раздела 5.

**Подтипы.**

- `kind='metrics'` — таблица метрик одного пункта `5.X`. Создаётся, когда в потомках узла `5.X` (т.е. на уровне `5.X.X+`) появляется хотя бы одна risk-таблица (`_updateMetricsTablesAfterRiskTableCreated`, `state-content.js:462`). Удаляется автоматически, когда последняя глубокая risk-таблица исчезает (`_cleanupMetricsTablesAfterRiskTableDeleted`, `state-content.js:498`).
- `kind='mainMetrics'` — главная сводная для всего раздела 5. Создаётся при появлении ЛЮБОЙ risk-таблицы в дереве 5, удаляется при их полном отсутствии (та же функция).

**Структура `grid`.** Сетка 4×7 с двумя строками заголовков и двумя строками данных. Заголовки используют объединения (`colSpan`/`rowSpan`/`isSpanned`/`spanOrigin`) для группировки «Количество клиентов / элементов» (ФЛ/ЮЛ под общей шапкой) и «Сумма, руб.» / «Код БП» / «Пункт акта». Полный шаблон — `_createMetricsHeaderGrid` (`state-content.js`).

Схематично (rowSpan=2 — вертикальное объединение через две header-строки; colSpan=2 — горизонтальное в row 0):

```
┌───────────┬──────────────┬──────────────────────────────┬─────────────┬────────┬──────────────────┐
│ Код       │ Наименование │ Количество клиентов /        │ Сумма, руб. │ Код БП │ Пункт / подпункт │  ← row 0
│ метрики   │ метрики      │ элементов, ед.  (colSpan=2)  │             │        │ акта             │
│ (rowSpan  │ (rowSpan=2)  ├──────────────┬───────────────┤ (rowSpan=2) │ (rowS  │ (rowSpan=2)      │
│  =2)      │              │     ФЛ       │      ЮЛ       │             │  =2)   │                  │  ← row 1
├───────────┼──────────────┼──────────────┼───────────────┼─────────────┼────────┼──────────────────┤
│           │              │              │               │             │        │                  │  ← row 2 (данные)
├───────────┼──────────────┼──────────────┼───────────────┼─────────────┼────────┼──────────────────┤
│           │              │              │               │             │        │                  │  ← row 3 (данные)
└───────────┴──────────────┴──────────────┴───────────────┴─────────────┴────────┴──────────────────┘
   col 0        col 1          col 2           col 3           col 4       col 5         col 6
```

В коде ячейки-«дырки» под объединениями явно описаны как `isSpanned: true` с `spanOrigin: {row, col}` — это нужно для корректной отрисовки и редактирования (cм. `headerRow2` в `_createMetricsHeaderGrid`).

**Имя таблицы (`label`).** `"Объем выявленных отклонений (В метриках) по {nodeNumber}"` для `kind='metrics'` и `"Объем выявленных отклонений"` для `kind='mainMetrics'`. При перенумерации узла `5.X` фронт обновляет label автоматически — `updateMetricsTableLabel` (`state-tree.js:77`), не затирая пользовательский `customLabel` (guard `isAutoMetricsTableLabel`).

**Ограничения.**

- Создаются только под разделом 5.
- Всегда `protected: true` (нельзя менять структуру), но `deletable: true` (фронт может убрать вместе с риском).
- Pinned: вставляются `unshift`'ом в начало `children` (см. §5).

### 7.2. Risk-таблицы

**Подтипы.**

- `kind='regularRisk'` — регулярные риски. Шаблон в `AppConfig.content.tablePresets.regularRisk` (см. `app-config.js`), создаётся через `_createRegularRiskTable` (`state-content.js:549`).
- `kind='operationalRisk'` — операционные риски. Шаблон 4×6, заголовки с объединениями, создаётся через `_createOperationalRiskTable` (`state-content.js:588`), сетка — `_createOperationalRiskGrid` (`state-content.js:626`).
- Дополнительно схема допускает `kind='taxRisk'`/`'otherRisk'` (полный набор из 7 подвидов) — `_createTaxRiskTable`/`_createTaxRiskGrid` (`state-content.js:727`/`767`), `_createOtherRiskTable` (`state-content.js:814`).

Подвид `kind` хранится на узле-таблице (источник истины) и дублируется в `tables[tableId].kind`. Проверка «узел — risk-таблица»: `isRiskTable(node)` (`table-kind.js`; `TreeUtils.isPinnedTable`/`isRiskTable` делегируют туда).

**Правила размещения.**

- Только под разделом 5 (любая глубина: `5.X`, `5.X.Y`, …).
- Все risk-таблицы в разделе 5 должны быть на ОДНОМ уровне глубины — либо все на уровне пунктов (`5.X`), либо все на уровне подпунктов (`5.X.Y+`), смешивать запрещено (`_checkSection5RiskConstraints`, `state-tree.js:706`).
- Pinned: вставляются через `splice` после всех остальных pinned-таблиц.
- Создание risk-таблицы триггерит ревизию metrics-таблиц (см. §7.1).
- Risk-таблицы **нельзя перетаскивать** — `dragstart` блокирует любую попытку, см. `_hasRiskTablesInSubtree` (`tree-drag-drop.js:143`). Это касается и перетаскивания узла-носителя, и перетаскивания пункта, содержащего risk-таблицу в любой ветке поддерева (исключение — перемещение в пределах раздела 5).

### 7.3. Оформление подписи таблицы (table title)

Единое правило владельца, действующее одинаково во ВСЕХ контурах — редакторе заполнения, обоих поверхностях предпросмотра (inline-панель и модальное меню), вкладке «Просмотр» диалога истории версий и трёх экспортных форматтерах (DOCX/MD/TXT):

- **Начертание всегда обычное, `font-weight: normal`** — ни жирного, ни полужирного нет ни в одном контуре. До правки жирной (`run.bold = True` безусловно) была подпись в DOCX; в превью, из-за независимого CSS-бага со специфичностью, подпись рисовалась semibold (см. «CSS-механика превью» ниже) при формально «нормальном» правиле. Подчёркивание до правки было не единым: в редакторе, превью и TXT ставилось БЕЗУСЛОВНО всем подписям без разбора раздела/типа, а в DOCX и диалоге версий подчёркивания не было вовсе — теперь везде одно правило.
- **Подчёркнута** только подпись **пресетной** (автоматически созданной) таблицы **разделов 1–4**.
- Раздел 5 (в т.ч. metrics/risk-таблицы) и пользовательские таблицы — обычным начертанием, БЕЗ подчёркивания.
- Таблица внутри блока нарушения (`ViolationTableBlockSchema`, §4.1) подписи не имеет вовсе — у схемы нет поля `caption`/`label` (в отличие от `ViolationImageBlockSchema.caption`), правило к ней неприменимо структурно, а не по значению предиката.

**Предикат «пресетная таблица».** Признака «создана автоматически» в модели узла нет — дискриминатор различает по составу уже существующих полей: `protected === true` И `kind` отсутствует либо равен `'regular'` (`isPresetTable`/`is_preset_table`). Пользовательские таблицы имеют `protected: false`; spec-таблицы (§7.1/§7.2) отличаются `kind !== 'regular'`; таблица раздела 2 «Результаты оценки качества процесса» (§6) — `protected: true` и `kind: 'regular'`, то есть остаётся пресетной для целей этого правила несмотря на удаляемость и `special`.

**Единая точка правила — две зеркальные реализации**, не связанные импортом (фронт не может импортировать Python):

- Python — `table_title_underlined(node, root_section_id)` в `app/domains/acts/formatters/table_title.py`, звана всеми тремя форматтерами.
- JS — `tableTitleUnderlined(node, rootSectionId)` в `static/js/constructor/table/table-title.js` (модуль без DOM-зависимостей, там же живёт `isPresetTable` и предикат показа подписи `shouldShowTableTitle`/`tableTitleText`).
- Синхронность держит `tests/domains/acts/formatters/test_table_title_rule.py` — одна матрица случаев (protected/kind/root_section_id → ожидание) прогоняется через обе реализации.

`root_section_id` — id раздела верхнего уровня, в поддереве которого лежит узел; `null`/`None`, если он неизвестен (правило тогда трактует подпись как неподчёркнутую). На бэке его несёт `WalkContext.root_section_id` (`formatters/tree_walker.py`): `walk()` открывает новый `root_section_id` для каждого ребёнка корня и передаёт его вниз по всему поддереву без изменений — так одно поле обслуживает все три форматтера без отдельного прохода. На фронте раздел не передаётся параметром рендера напрямую — его вычисляет каждый вызывающий код своим способом: `ItemsRenderer._createTableTitle` — через `TreeUtils.getNodePath(node.id)[1]` (путь от корня дерева, элемент с индексом 1 — раздел); `PreviewManager.renderNode`/`_renderTableNode` — рекурсивным параметром `rootSectionId`, который каждый ребёнок корня открывает своим `id`; `VersionPreviewOverlay._renderNode` — тем же приёмом для диалога истории версий.

Матрица «класс таблицы × контур → оформление» (раздел 1–4, пресетная):

| Контур | Подчёркивание | Класс/атрибут |
|---|---|---|
| DOCX | `run.underline = True` | `DocxFormatter._add_table_title(..., underlined=True)` |
| TXT | строка дефисов под подписью (ASCII-аналог подчёркивания) | `text_formatter.py::_TextTreeVisitor.on_table` |
| MD | не поддерживается принципиально (см. ниже) | — |
| Редактор заполнения | подчёркнута | `.table-title.table-title--underline` (`table-base.css`) |
| Предпросмотр (inline-панель и модальное меню) | подчёркнута | `.preview-table-title.preview-table-title--underline` (`preview-table.css`) |
| Диалог версий, вкладка «Просмотр» | подчёркнута | `.version-preview-label.version-preview-label--table.version-preview-label--underline` (`version-preview.css`) |
| Диалог версий, вкладка «Сравнение» | не поддерживается — интерфейсная поверхность | `diff-renderer.js::_renderDiffTable` рисует голую `<table>` и подпись `.version-preview-label` без модификаторов `--table`/`--underline`, тем же сознательным решением, что и для гарнитуры/кегля (§13 [`textblock-editor-architecture.md`](textblock-editor-architecture.md)) |

Для остальных классов (раздел 5, пользовательская, spec-таблица) все контуры дают «обычное начертание, без эффектов» — модификаторные классы просто не проставляются, DOCX не ставит `underline`, TXT не печатает строку дефисов.

**MD принципиально не поддерживает эффект и правки не потребовал** — подпись там всегда плоская строка текста (`markdown_formatter.py::on_table`). Подчёркивания в Markdown нет как понятия; строка дефисов под текстом дала бы setext-заголовок H2 — подпись превратилась бы в заголовок раздела документа. Зафиксировано тестами как осознанное поведение, а не недоделка (`tests/domains/acts/formatters/test_table_title_txt_md.py`).

**CSS-механика превью.** Модификатор — отдельный класс (`*--underline`), а не безусловный инлайн-стиль: раньше `ItemsRenderer._createTableTitle` ставил `Object.assign(tableTitle.style, {textDecoration: 'underline'})` каждой подписи без разбора. У подписи в предпросмотре была отдельная ловушка специфичности: `.preview-table-title` — голый класс (специфичность 0,1,0), а её перебивали более специфичные `.preview h4`/`.preview-menu-body h4` (0,1,1) из типографики поверхностей, из-за чего `font-weight: normal` не применялся и подпись рисовалась semibold независимо от правила. Лечение — не `!important`, а перечисление селектора для обеих поверхностей плюс голый `h4.preview-table-title` (`preview-table.css`). Заодно кегль подписи в предпросмотре переведён с интерфейсного `--font-size-sm` на документный `--doc-font-size` (12pt) — подпись печатается в акте наравне с телом; ratchet, сторожащий протечки UI-шкалы в документные зоны — `tests/test_document_css_font_size_ratchet.py` (детали токенов — §13.4 [`frontend-architecture.md`](frontend-architecture.md)).

Тесты: `tests/domains/acts/formatters/test_table_title_rule.py` (матрица предиката Python↔JS), `tests/domains/acts/formatters/docx/test_table_title.py`, `tests/domains/acts/formatters/test_table_title_txt_md.py`, `tests/js/table-title-underline-rule.test.mjs`.

---

## 8. Invoice attachment (прикреплённые фактуры)

**Куда прикрепляются.** К листовым item-узлам под разделом 5 («TB-leaf»: item под `5.*` без дочерних item-узлов). Проверка: `TreeUtils.isTbLeaf` (`tree-utils.js:328`). Фактура — ссылка на строку внешней таблицы Hive или Greenplum, использованной как доказательная база нарушения.

**Структура `node.invoice`.** Объект на узле, существующий ТОЛЬКО во фронт-объекте — в сериализованный `tree_data` он не попадает (см. `_serializeTree`, `state-core.js:592`). Содержимое (`dialog-invoice.js:769-777`):

```jsonc
{
  "db_type":     "hive" | "greenplum",
  "schema_name": "<имя схемы>",
  "table_name":  "<имя таблицы>",
  "metrics":     [ { "metric_type": "КС|ФР|ОР|РР|МКР", "metric_code": "...", "metric_name": "..." }, … ],  // 1..5 элементов, типы уникальны
  "process":     [ { "process_code": "...", "process_name": "..." }, … ] | null,
  "profile_div": "<подразделение>" | null
}
```

Валидация на бэке — `InvoiceSave` (`app/domains/acts/schemas/act_invoice.py:36`): `db_type` строгая литералка, `metrics` ровно 1–5 элементов с уникальными типами из множества `{КС, ФР, ОР, РР, МКР}` (`VALID_METRICS_TYPES`).

**Как привязывается.**

1. На фронте `InvoiceDialog` при сохранении отправляет POST `/api/v1/acts/invoice/save` через `APIClient.saveInvoice` (`dialog-invoice.js:795`, URL — `api.js:1165`) и сразу проставляет фактуру на узел через мутатор `AppState.setNodeInvoice(this._currentNode.id, {...})` (`dialog-invoice.js:804`; мутатор помечает dirty через Proxy-трекинг — ручной `markAsUnsaved` убран, см. state-6).
2. На бэке создаётся/обновляется строка в `act_invoices` (`{SCHEMA}.{PREFIX}act_invoices`, схема в `migrations/postgresql/schema.sql:265`). `UNIQUE(act_id, node_id)` гарантирует одну фактуру на узел; CHECK `check_act_invoices_db_type_values` ограничивает `db_type IN ('hive', 'greenplum')`.
3. При следующем `save_content` бэк синхронизирует `act_invoices`: всё, что отсутствует в `data.invoiceNodeIds`, удаляется; для оставшихся обновляются `node_number`, `audit_act_id`, `audit_point_id` (`act_content.py::_sync_invoices`, `564-603`).
4. На загрузке акта `APIClient._attachInvoicesToTree` обходит дерево и навешивает `node.invoice` на узлы с прикреплёнными фактурами (`api.js:1059`).

**Сборка `invoiceNodeIds` для отправки.** Фронт-функция `_collectInvoiceNodeIds` обходит дерево и собирает ID всех узлов с `node.invoice` (`state-core.js:575`). Это единственный канал, через который бэк узнаёт о привязках; самой структуры `invoice` бэк из дерева не читает.

**Чистка при перемещении.** Если узел уезжает за пределы раздела 5, `_clearInvoiceRecursive` стирает `invoice` у узла и всех потомков (`state-tree.js:1025`). Аналогично при добавлении ребёнка к TB-leaf — родитель перестаёт быть листом, и его `invoice` удаляется (`state-tree.js:126`).

**Дополнительные denormalized-поля в `act_invoices`.** `verification_status` (`pending|verified|rejected`, default `pending`), `audit_act_id`, `audit_point_id`, `etl_loading_id`, `create_date`, `created_by` — заполняются бэком, не приходят с фронта.

**Сервис и справочники.** `app/domains/acts/services/act_invoice_service.py`; эндпоинты справочников — `GET /api/v1/acts/invoice/{metrics,processes,subsidiaries}` и `GET /api/v1/acts/invoice/tables/{db_type}`. Реестр Hive-таблиц подставляется в миграции плейсхолдером `{REF_HADOOP_TABLES}` (резолвится из `HIVE_REGISTRY_SCHEMA` + `HIVE_REGISTRY_TABLE`).

| Env-var | Дефолт | Назначение |
|---|---|---|
| `ACTS__INVOICE__HIVE_SCHEMA` | `team_sva_oarb_3` | Hive-схема для фактур |
| `ACTS__INVOICE__GP_SCHEMA` | `s_grnplm_ld_audit_da_sandbox_oarb` | GP-схема для списка таблиц |
| `ACTS__INVOICE__HIVE_REGISTRY_SCHEMA` | `s_grnplm_ld_audit_project_4` | Где лежит реестр Hive-таблиц |
| `ACTS__INVOICE__HIVE_REGISTRY_TABLE` | `t_db_oarb_ua_hadoop_tables` | Имя таблицы реестра |

Все четыре значения проходят через `validate_sql_identifier` — некорректный идентификатор роняет загрузку настроек.

**Restore версии переприкрепляет фактуры.** Отдельный канал — `AuditLogService.restore_version` (`audit_log_service.py`). При восстановлении версии фактуры её снимка (`act_content_versions.invoices_data`, см. §11) заново прикрепляются через `ActInvoiceRepository.save_invoice` (UPSERT по `(act_id, node_id)`), `verification_status` при этом сбрасывается в `pending` (восстановленная фактура требует повторной верификации). `invoiceNodeIds` restore-данных выставляется из снимка, поэтому финальный `_sync_invoices` (см. п.3 выше) удаляет только фактуры узлов вне снимка, а не все фактуры акта.

---

## 9. Drag-and-drop: правила

Реализация — `TreeDragDrop` (`static/js/constructor/tree/tree-drag-drop.js`) + `AppState.moveNode` (`static/js/constructor/state/state-tree.js:378`). Валидация на старте и на drop'е.

| Правило                                                                                          | Где проверяется                                                  |
|--------------------------------------------------------------------------------------------------|------------------------------------------------------------------|
| Узлы с `protected: true` не draggable                                                            | `handleDragStart` (`tree-drag-drop.js:109`), `_validateMove` (`state-tree.js:507`) |
| Узлы, содержащие risk-таблицу в поддереве, draggable только внутри раздела 5                     | `handleDragStart` (`tree-drag-drop.js:114`), повторно в `moveNode` (`state-tree.js::_getNodesForMove`) |
| Content-узлы (`table`, `textblock`, `violation`) не могут быть родителями                        | `canAcceptAsChild` (`tree-drag-drop.js:153`)                      |
| Запрет drop'а в собственного потомка                                                              | `handleDragOver` через `TreeUtils.isDescendant` (`tree-drag-drop.js:184`) |
| Запрет drop'а `'before'` на pinned-узле; `'after'` блокируется, если следом ещё одна pinned       | `_calculateDropPosition` (`tree-drag-drop.js:203`)                |
| Превышение `AppConfig.tree.maxDepth` (= 4) запрещено                                              | `_checkDepthConstraints` (`state-tree.js:589`)                    |
| Перенос узла на первый уровень (`root.children`) запрещён — состав 0 уровня фиксирован (разделы 1–5 + Process Mining) | `_checkFirstLevelConstraints` (`state-tree.js:630`)      |
| В разделе 5: risk-таблицы должны быть на одном уровне глубины                                    | `_checkSection5RiskConstraints` (`state-tree.js:706`)             |
| В разделе 5: нельзя создавать подпункты `5.X.X+`, если risk-таблицы стоят на уровне пунктов     | то же                                                              |
| Перемещение metrics-таблицы за пределы раздела 5: требуется подтверждение пользователя (диалог) и она удаляется | `_checkMetricsTableDeletion` (`state-tree.js:537`)       |
| В режиме read-only любое перемещение запрещено                                                    | `handleDragStart` (`tree-drag-drop.js:97`), `moveNode` (`state-tree.js:379`, `ValidationCore.requireWrite`) |
| Эффективный индекс drop'а прижимается ниже pinned-зоны, даже если drop был «выше»                | `_performMove` (`state-tree.js:784`)                              |

Дополнительный side-effect перемещения: пересчёт metrics-таблиц через `_reconcileMetricsTablesAfterMove` (`state-tree.js:895`) и очистка `tb`/`invoice` у поддерева, ушедшего из раздела 5 (`state-tree.js:453-465`).

**Контекстное меню дерева** (`TreeContextMenu`, `static/js/constructor/context-menu/context-menu-tree.js`) следует тем же ограничениям состава уровней, что и DnD, но показывает/скрывает пункты меню, а не просто отбивает действие:

- «Добавить соседний пункт» (`add-sibling`) скрыт целиком на 0 уровне (`node.id` — дитя `root`) — состав уровня фиксирован, добавить туда ничего нельзя (`context-menu-tree.js:118-119`). Глубже 0 уровня пункт виден всегда, но может быть задизейблен тем же правилом «риски на уровне 5.X.X+», что и `_checkSection5RiskConstraints` (`context-menu-tree.js:120-124`).
- «Добавить дочерний пункт» (`add-child`) не имеет специальной логики уровня — доступен везде, где не превышен `AppConfig.tree.maxDepth` (гейт — `ValidationTree.canAddChild`, а не пункт меню).
- «Добавить таблицу: Результаты оценки качества процесса» (`add-quality-assessment-table`) — пункт виден ТОЛЬКО на узле раздела `2` процессного акта (`window.actMetadata?.is_process_based !== false`) и задизейблен, если у раздела 2 уже есть ребёнок с `special === 'quality_assessment'` (`context-menu-tree.js:76-82`); для непроцессного акта и любого другого узла пункт скрыт. Обработчик `handleAddQualityAssessmentTable` зовёт `AppState.addQualityAssessmentTable()` (`context-menu-tree.js:362`).
- Пункт «Добавить пункт: Process Mining», раньше подменявший собой «Добавить соседний пункт» на 0 уровне, из меню убран целиком (коммит `826dc503`) — Process Mining создаётся вместе со скелетом акта и добавлять его вручную больше не нужно.

---

## 10. Блокировка акта (lock) и inactivity dialog

Источник истины — **не колонки таблицы `acts`** (их убрали), а ключ Redis `lock:act:{act_id}` с нативным TTL `DURATION_MINUTES`: пока ключ жив — акт занят, истёк TTL — акт свободен автоматически, отдельного снятия не требуется. Фонового таска чистки просроченных локов нет — его убрали вместе с SQL-колонками.

Репозиторий-фасад — `app/domains/acts/repositories/act_lock.py` (`ActLockRepository`; имена методов и формы возвратов сохранены с эпохи SQL-колонок: `atomic_lock_act`, `atomic_extend_lock`, `get_lock_info`, `bulk_lock_info`, `unlock_act`). Бэкенд один — `RedisLockBackend` (`app/domains/acts/repositories/act_lock_backends.py`, префикс ключа — константа `KEY_PREFIX = "lock:act:"`), все мутации атомарны через Lua-скрипты (захват-или-продление, снятие только своей блокировки). Redis обязателен во всех окружениях, включая тесты (в pytest — fakeredis из autouse-фикстуры `fake_redis`), поэтому альтернативного in-memory бэкенда больше нет. Сервис — `app/domains/acts/services/act_lock_service.py` (`lock_act` / `unlock_act` / `extend_lock`).

**API:** `POST /api/v1/acts/{act_id}/lock`, `POST /api/v1/acts/{act_id}/unlock`, `POST /api/v1/acts/{act_id}/extend-lock`. Параметры таймингов фронт забирает через `GET /api/v1/acts/config/lock` (`LockConfigResponse`), а не хардкодит.

**Поведение:**

- Захват/продление — атомарная Lua-операция: чужую блокировку не тронет, свою продлит. Если акт занят другим — `ActLockError` (HTTP 409, `app/domains/acts/exceptions.py:26`), в теле `locked_by` / `locked_until`.
- Продление — не чаще, чем раз в `MIN_EXTENSION_INTERVAL_MINUTES` (антифлуд), до `now() + DURATION_MINUTES`.
- При истечении TTL ключ исчезает сам — следующий запрос на изменение содержимого возвращает 409 (`AccessGuard.require_lock_owner`), пользователь должен заново «взять» акт.
- **Inactivity dialog**: фронт по таймеру `INACTIVITY_TIMEOUT_MINUTES` без активности (нет клика/keypress/скролла) показывает диалог «Продолжить работу?» с обратным отсчётом. Если пользователь не ответил за `INACTIVITY_DIALOG_TIMEOUT_SECONDS` — контент автосохраняется, lock отпускается, происходит редирект на список актов.
- **Деградация Redis**: мутации (захват/продление/снятие) при недоступном Redis — 5xx (fail-closed, разъехавшиеся блокировки хуже отказа); чтение состояния лока при обогащении списка актов — fail-open (акт считается свободным + warning в лог).

> **Фронт-часть LockManager** (`static/js/constructor/lock-manager.js`, 706 строк) описана в [`frontend-architecture.md`](frontend-architecture.md) §6: heartbeat + retry, countdown по `Date.now()` (устойчив к Chrome background throttling), `visibilitychange`-handler с autoExit, идемпотентный `_initiateExit`, capture `actId` в `_handleInactivity`, beacon-unlock через `navigator.sendBeacon`, жёсткий редирект на 409.

| Env-var | Дефолт | Назначение |
|---|---|---|
| `ACTS__LOCK__DURATION_MINUTES` | `15` | Срок жизни одного lock'а (TTL Redis-ключа) |
| `ACTS__LOCK__INACTIVITY_TIMEOUT_MINUTES` | `5.0` | Через сколько без активности — диалог |
| `ACTS__LOCK__INACTIVITY_CHECK_INTERVAL_SECONDS` | `30` | Период проверки активности на фронте |
| `ACTS__LOCK__MIN_EXTENSION_INTERVAL_MINUTES` | `5.0` | Анти-флуд продлений |
| `ACTS__LOCK__INACTIVITY_DIALOG_TIMEOUT_SECONDS` | `15` | Если не ответил на диалог — автосохранение и снятие lock'а |

Декларации — `app/domains/acts/settings.py::LockSettings`.

---

## 11. Версионирование содержимого и аудит-лог

Две независимые системы.

**1. Снэпшоты содержимого — `{PREFIX}act_content_versions`** (`migrations/postgresql/schema.sql:340`). Каждое `manual`/`periodic`-сохранение содержимого создаёт запись со снимком `tree_data`/`tables_data`/`textblocks_data`/`violations_data`/`invoices_data` (все JSONB), `version_number` инкрементируется. Исключение — дедуп: `ActContentVersionRepository.create_version` считает канонический SHA-256 содержимого (колонка `content_hash`) и при совпадении с хэшем последней версии снимок НЕ создаёт (возвращает `None`) — no-op сохранение неизменённого акта не плодит версию-дубль и не вытесняет реальную из кольца `MAX_CONTENT_VERSIONS`. Дедуп покрывает и снимки-предохранители `restore_version` (централизован в репозитории), best-effort без блокировок; волатильные поля фактур (`id`/`created_at`/`updated_at`) в хэш не входят. `invoices_data` — привязка `node_id` → реквизиты фактуры на момент версии (см. §8). Сервис — `app/domains/acts/services/act_content_service.py`, репозиторий — `app/domains/acts/repositories/act_content_version.py`. Индекс `idx_{PREFIX}act_content_versions_act(act_id, version_number DESC)` — для быстрой выборки последних N версий.

**2. Аудит-лог — `{PREFIX}audit_log`** (`migrations/postgresql/schema.sql:324`). Запись о каждом действии (создание, редактирование, блокировка, правка метаданных, экспорт). Сервис — `app/domains/acts/services/audit_log_service.py`, репозиторий — `act_audit_log.py`. Здесь же лежит diff между версиями (по элементам дерева и ячейкам таблиц). Запись ленивая: если поднят фоновый батчер `acts.audit_log_batcher` (50 записей / 30 с) — пишет через него, иначе одиночным INSERT.

API истории и восстановления — роутер `app/domains/acts/api/audit_log.py` (список версий/записей + `POST` восстановления версии).

**Лимиты** (`settings.py::AuditLogSettings`):

| Env-var | Значение | Назначение |
|---|---|---|
| `ACTS__AUDIT_LOG__RETENTION_DAYS` | `365` | Заявленный срок хранения записей аудит-лога |
| `ACTS__AUDIT_LOG__MAX_CONTENT_VERSIONS` | `50` | Макс. версий снэпшота на один акт (старые ротируются) |
| `ACTS__AUDIT_LOG__MAX_DIFF_ELEMENTS` | `20` | Макс. элементов в diff |
| `ACTS__AUDIT_LOG__MAX_DIFF_CELLS_PER_TABLE` | `50` | Макс. ячеек diff на одну таблицу |

> `RETENTION_DAYS` — декларативная настройка: background-job ретеншена в коде **нет**, чистка просроченных записей на стороне DBA (по аналогии с bus-таблицей внешнего агента, см. §9.6 в [`../guides/deploy-and-configuration.md`](../guides/deploy-and-configuration.md)). Ротация кольца версий по `MAX_CONTENT_VERSIONS`, наоборот, работает в коде при каждой записи.

---

## 12. Статус валидации содержимого

Отдельная от блокировки и от верификации фактур система-сигнал «в акте есть что проверить». Колонки `acts.validation_status` (`ok`/`warning`/`error`, CHECK `check_acts_validation_status_values`) + `acts.validation_issues` (JSONB) — см. `migrations/postgresql/schema.sql:39-42` и §6.1 в [`../guides/database.md`](../guides/database.md).

- **Источник истины — бэк.** `services/content_validation.py::collect_validation_issues(data)` — **чистая, не бросающая** функция, зеркалит фронт-правила (структура базовых разделов 1–6 — `_BASE_SECTION_IDS`, включая обязательный Process Mining — заголовки/данные таблиц, пустые поля нарушений) и возвращает список замечаний (`code`/`severity`/`message`/`ref`). `status_from_issues(...)` даёт **три уровня**: **`error`** при любом замечании `severity='error'` (сломанная структура, таблица без заголовка), иначе **`warning`** при только «мягких» замечаниях (`severity='warning'`, напр. пустая таблица), иначе **`ok`**. Жёсткие проверки (`_validate_tree`) по-прежнему **бросают** (их сохранить нельзя) — нет корня / превышена глубина дерева / узел содержит слишком много текстблоков, нарушений или таблиц; это **один DFS-обход**, считающий глубину и первое превышение лимита каждого типа одновременно (порядок ошибок при нескольких нарушениях сразу: глубина → root-id → textblocks → violations → tables). Проверка текстблоков на бэк **не** портирована (зависит от фронтовой нумерации `node.number`, не гарантированной в хранимом дереве).
- **Вычисляется на сохранении** (любой `saveType`), персистится в `acts`, возвращается в `SaveContentResponse` (`validation_status`/`validation_issues`) и в `ActListItem`/`ActResponse`. **Restore версии** тоже пересчитывает статус из восстановленного содержимого (`audit_log_service.restore_version` → `collect_validation_issues`/`status_from_issues`), а не сбрасывает в `ok`.
- **WIP не блокируется.** Фронт-гейт сохранения «только в БД» снят (`navigation-manager.js`): структурно невалидный черновик **сохраняется как есть**. Гейт остался **только на экспорт в файл** (error-level, отдельный клиентский контур `ValidationAct`, не поле `validation_status`) — битый документ хуже отказа.
- **Поверхности уведомлений зависят от уровня** (решение: warning не должен шуметь, error приравнен к фактуре):
  - **`error` — критично, как проверка фактуры.** Карточка списка краснеет (класс `validation-error`, та же стилизация, что `needs-invoice`); на лендинге колокольчик показывает конкретные ошибки «Проверить: …» (severity элемента — error, «вечно горит»: read/delete недоступны); toast при ручном сохранении — красный. Персистентного уведомления при сохранении **не создаётся**: раньше `_emit_validation_error_notification` слал его при каждом manual-сохранении, что дублировало лендинг-сводку и плодило записи (INSERT без дедупликации). Удалён; источник истины для лендинга — серверная сводка attention (ниже).
  - **`warning` — работа не закончена, не критично.** Карточку **НЕ** красит; на лендинге — один агрегат «Работа не закончена…» (без перечисления, severity warning, его **можно** прочитать/вернуть в непрочитанное/удалить — клиентское состояние, см. ниже); toast при ручном сохранении — жёлтый.
  - **Лендинг-колокольчик берёт данные из серверной сводки** `GET /api/v1/acts/attention-summary` (`ActCrudService.get_attention_summary` → `ActCrudRepository.get_user_acts_needing_attention`, `act_crud.py:562`) — ВСЕ акты пользователя с незакрытыми требованиями (`needs_*`) ИЛИ `validation_status <> 'ok'`, посчитанные на сервере (не клиентский пересчёт по загруженной странице). Источник `static/js/portal/acts-manager/notifications-source-acts.js` тянет её сам: при загрузке страницы, по таймеру (5 мин — `needs_invoice_check` меняется на стороне ETL, чаще нет смысла) и при возврате на вкладку. Форматтер `buildActsNotificationItems` (чистая функция, переиспользует node-тесты) превращает сводку в элементы колокольчика.
  - **Чтение/удаление warning-замечаний на лендинге — клиентское** (localStorage `notif:acts:state`, чистые `actItemSignature`/`reconcileActsItemsState`): ключ = акт + сигнатура замечания; состояние автоматически сбрасывается, когда акт исправлен (выпал из сводки) или замечание изменилось. error-элементы состояние игнорируют (горят всегда). Бейдж считает только непрочитанные.
  - **Полный список замечаний обоих уровней** виден внутри акта в колокольчике конструктора (`static/js/constructor/header/notifications-source-validation.js`, читает `validation_issues` последнего сохранения). Внутри акта живые замечания **read/delete не поддерживают** (всегда напоминают) — контекстное меню записи пустое («Нет доступных действий»).

---

## 13. Карточка нарушения: контракт полей и рендер

**Контракт полей — `app/domains/acts/violation_fields.py`.** Single source of truth: `VIOLATION_FIELDS` — кортеж `ViolationFieldDescriptor(key, column, label, default_order, mandatory, small, labeled)` для всех 10 полей нарушения (`id`/`nodeId`/`fieldOrder` — метаданные нарушения, не входят в реестр):

| `key` | `column` | `label` | `default_order` | `mandatory` | `small` | `labeled` |
|---|---|---|---|---|---|---|
| `violated` | `violated` | «Нарушено» | 0 | ✔ | ✔ | ✔ |
| `established` | `established` | «Установлено» | 1 | ✔ | ✔ | ✔ |
| `description` | `description` | «Описание» | 2 | ✘ | ✘ | ✔ |
| `codeMining` | `code_mining` | «CodeMining» | 3 | ✘ | ✘ | ✘ |
| `processMining` | `process_mining` | «ProcessMining» | 4 | ✘ | ✘ | ✘ |
| `additionalContent` | `additional_content` | «Дополнительный контент» | 5 | ✘ | ✘ | ✘ |
| `reasons` | `reasons` | «Причины» | 6 | ✘ | ✘ | ✔ |
| `measures` | `measures` | «Принятые меры» | 7 | ✘ | ✘ | ✔ |
| `consequences` | `consequences` | «Последствия» | 8 | ✘ | ✘ | ✔ |
| `responsible` | `responsible` | «Ответственные» (канон #11 — не «Ответственный») | 9 | ✘ | ✘ | ✔ |

`mandatory=True` (`violated`/`established`) — чекбокса в UI нет, `enabled` принудительно `True` (`ViolationSchema.enforce_mandatory_enabled`). `small=True` (`violated`/`established`) → 9pt (`Sizes.violation_pt`) в DOCX + курсив; `small=False` → 12pt (`Sizes.body_pt`, обычное начертание; закреплено `test_reasons_block_stays_12pt_non_italic`). `labeled=False` (`codeMining`/`processMining`/`additionalContent`, решение владельца) — в экспортах и превью поле выводится БЕЗ заголовка-метки, одним контентом подряд, как текстблок; в форме конструктора подпись и чекбокс поля остаются. Поля `kind`/`rich` старого реестра (виды `pair`/`list`/`additional`/`optional_text` + флаг `rich` per-поле) удалены — все 10 полей одной формы `{enabled, blocks}`, «богатость» контента определяется типом блока (text/image/table), а не полем-контейнером.

**Политика рендеров централизована в реестре** (там же, `violation_fields.py`): `should_render_field(field, enabled, has_blocks)` — выводить ли поле (mandatory всегда, опциональное — при `enabled` и непустом контейнере) и `field_label_for_render(field)` — метка либо `None` при `labeled=False`. Оба Python-рендера (DOCX и MD/TXT) ОБЯЗАНЫ звать эти предикаты, а не повторять условия у себя; фронтовое превью (`preview-violation-renderer.js`) остаётся ручным зеркалом, как и весь реестр. Семантику предикатов пинит `TestRenderPolicy` в страже реестра, паритет трёх форматов — `test_violation_parity.py` (метки `labeled=True` обязаны быть в каждом выводе, метки `labeled=False` — отсутствовать в каждом).

Реестр синхронизируется **ВРУЧНУЮ** с фронтовым зеркалом `static/js/constructor/violation/violation-fields.js` (как `block_types.py` ↔ `block-types.js`, `chat/names.py` ↔ `chat-client-actions.js` — фронт Python не импортирует). Два теста-стража держат соответствие: `tests/domains/acts/test_violation_fields_guard.py` (бэк) и `tests/js/violation-fields.test.mjs` (фронт, точные строки меток). `ordered_fields(violation_data)` (`violation_fields.py`) — единая точка порядка отображения: `fieldOrder` нарушения, если он валиден (перестановка ВСЕХ ключей реестра), иначе `VIOLATION_FIELDS` как есть; читают DOCX/MD/TXT-рендеры и фронтовый `getOrderedFieldKeys` (`violation-fields.js`).

**Хранение — колонка на поле.** Таблица `act_violations` (`migrations/{postgresql,greenplum}/schema.sql`) хранит все 10 полей JSONB-колонками по имени `column` реестра (`violated`, `established`, `description`, `code_mining`, `process_mining`, `additional_content`, `reasons`, `measures`, `consequences`, `responsible`) + `field_order JSONB` (пользовательский порядок; `NULL` — стандартный). Каждая полевая колонка несёт CHECK `check_<column>_is_object_or_null` (`jsonb_typeof(...) = 'object'`), `field_order` — `check_field_order_is_array_or_null`. Единственное место знания «строка БД ↔ документ нарушения» — `app/domains/acts/repositories/violation_row_mapper.py`: `select_columns_sql`/`insert_sql`/`copy_sql` строятся циклом по `VIOLATION_FIELDS`, `row_to_violation_dict`/`violation_insert_args` конвертируют строку в JSON и обратно (NULL-колонка → дефолтный контейнер, mandatory-поля — включённые). Потребители — загрузка/сохранение (`act_content.py`), копирование акта (`act_crud.py`, INSERT…SELECT). Страж состава колонок — `tests/domains/acts/test_violation_schema_columns_guard.py` (обе schema.sql ↔ реестр), маппера — `tests/domains/acts/test_violation_row_mapper.py`.

**Санитайзер — `utils/html_sanitizer.py`.** Единый цикл `_sanitize_violation_common` (общий для obj- и dict-формы) — по всем 10 полям реестра → по блокам поля → диспетчер `_sanitize_block` по `type`: `text` → `content` через `sanitize_rich_html` (nh3); `image` → `caption` через `sanitize_rich_html`, `url`/`filename` — plain, не трогаются; `table` — не трогается (ячейки хранятся дословно, тот же инвариант B8, что у больших таблиц узла). Отсутствующее/`None`-поле или `blocks` не-список пропускаются без исключения.

**Общий рендер MD/TXT — `formatters/violation_render.py::format_violation`.** Единый цикл по `ordered_fields(violation_data)`; видимость поля и его метка — через предикаты реестра (`should_render_field`/`field_label_for_render`, см. выше): у mandatory-поля метка выводится всегда (даже при пустом контейнере — паритет с DOCX), у остальных — только при `enabled` и хотя бы одном блоке, у `labeled=False` строка метки не выводится вовсе. Внутри поля — по блокам: `text` → `text_conv(content)` (колбэк HTML→Markdown/plain от вызывающего форматтера), `image`/`table` → колбэки `add_image`/`add_table`. `bold_wrap`/`wrap_plain` — единственная точка расхождения MD/TXT по оформлению метки. Прежний зоопарк per-kind функций (`add_required_pair`/`add_description_list`/`add_case`/`add_additional_content`/…) убран вместе со старой моделью полей.

**DOCX — `formatters/docx/builders/violation.py::build_violation`.** Тот же цикл по `ordered_fields` и те же предикаты видимости/метки: размер шрифта поля — `Sizes.violation_pt` при `small=True`, иначе `Sizes.body_pt` (вместо позиционного хардкода «первые четыре поля мелкие»); у поля С МЕТКОЙ первый text-блок идёт inline с ней («Метка: текст» — привычный вид), остальные блоки — своими абзацами/shape'ами. Исключение — text-блок, НАЧИНАЮЩИЙСЯ со списка: метка тогда остаётся самостоятельным абзацем, а список идёт следом. Иначе абзац с меткой сам получал бы `w:numPr` первого пункта, и в Word выходило «• Причины: текст пункта» — служебное слово читалось как часть маркированного пункта (развилка — в `render_block_segments`, ветка `label_only`; превью повторяет её предикатом `startsWithList`, MD/TXT метку не инлайнят вовсе); у поля с `labeled=False` абзац-метка не создаётся вовсе (в том числе пустой, когда поле начинается с картинки или таблицы) — все блоки рендерятся напрямую; `image` → `_add_image`/`_scale_picture`, `table` → общий `build_table` через `EmbeddedTableSchema`. Списки (`<ul>/<ol>/<li>`) получают собственную нумерацию — каждый элемент списка свою пару `w:abstractNum`+`w:num` (`docx/numbering.py::create_list_num`), вложенность передаётся через `w:ilvl`, а не built-in стиль абзаца Word — на общем пути `render_block_segments` (`docx/builders/inline.py`) — рендерятся одинаково и из текстблоков, и из любого rich-поля нарушения (§9.3/§15 в [`textblock-editor-architecture.md`](textblock-editor-architecture.md)).

**Фронт: контейнер блоков и аудит.** `violation-blocks.js::createBlocksField` — единый компонент секции ОДНОГО поля (заголовок/чекбокс, тулбар «+ Текст | + Таблица | + Картинка», зона вставки с контекстным меню и приёмом файлов) для всех 10 полей реестра — «Дополнительный контент» перестал быть особым случаем. Записи в модель — только через мутаторы `violation-mutations.js` (`setFieldEnabled`/`setFieldOrder`/`setBlockField`/`addBlock`/`removeBlock`/`removeBlocks`/`moveBlocks`); исключение — ячейки встроенных таблиц: их правит общая машинерия таблиц напрямую в `blocks[].table.grid` через резолвер `table-store.js` (запись ловит Proxy состояния, read-only отсекают гейты самой машинерии). `violation-audit.js::ViolationAudit` — снимок для дифф-аудита двухфазный: `synthesize()` кладёт фингерпринты (по реестру, блок-за-блоком; картинки — без `url`, таблицы — только содержимое ячеек) в статический `_pendingSnapshot` (не коммитит), `confirmSave()` промотирует его в `_snapshot` только ПОСЛЕ подтверждённого успешного сохранения (вызывается из `shared/api.js` — `saveActContent`/`forceSaveToDb` — и `constructor/lock-manager.js` — `_initiateExit` — в ветке успеха). Раньше снимок коммитился независимо от результата сохранения, что могло зафиксировать несохранённое состояние как базу для следующего диффа.

---

## 14. Экспорт

Сервис — `app/domains/acts/services/export_service.py`. Поддерживаемые форматы: **DOCX**, **Markdown**, **plain text**.

**Эндпоинты** (роутер зарегистрирован под префиксом `/acts/export`):

- `POST /api/v1/acts/export/save-act?act_id={int}&fmt={txt|md|docx}` — генерация файла (`fmt` — строгая литералка, дефолт `docx`); ответ `ActSaveResponse` с именем файла.
- `GET /api/v1/acts/export/download/{filename}` — скачивание сгенерированного файла.

Параметры форматирования управляются настройками `ACTS__FORMATTING__*` (`settings.py::FormattingSettings`; полная таблица переменных — §9.5 в [`../guides/deploy-and-configuration.md`](../guides/deploy-and-configuration.md)):

- **DOCX**: `DOCX_IMAGE_WIDTH=4.0` (дюймы), `DOCX_MAX_HEADING_LEVEL=9`, `MAX_IMAGE_SIZE_MB=10.0`.
- **Markdown**: `MARKDOWN_MAX_HEADING_LEVEL=6` (MD `#` ограничено 6).
- **HTML-парсинг**: `HTML_PARSE_TIMEOUT=30`, `MAX_HTML_DEPTH=100`, `HTML_PARSE_CHUNK_SIZE=1000` — защита от bomb-нагрузки на парсер.
- **Plain text**: `TEXT_HEADER_WIDTH=80`, `TEXT_INDENT_SIZE=2`.
- Общие retry: `MAX_RETRIES=3`, `RETRY_DELAY=0.5` для нестабильных операций (например, загрузка картинок).

**Особенности форматтеров (важно при правке):**

- **Извлечение ссылок/сносок в TXT/MD** (`formatters/utils/html_utils.py`) — **сканер с учётом вложенности `<span>`** (depth-tracking парный `</span>`), а не нежадная регулярка `(.*?)</span>`. Регулярка обрывала ссылку/сноску на первом *внутреннем* `</span>` (вложенный жирный/размерный span внутри ссылки), вываливая часть текста наружу. Жадный матч до последнего `</span>` склеивал бы соседние ссылки.
- **`_PX_TO_PT` определён единственный раз** в `formatters/docx/builders/inline.py`; `docx/formatter.py` его **импортирует**, своего определения не держит.
- **Размер шрифта текстблоков в DOCX**: если форматирование отличается от дефолтного, размер = `fontSize * _PX_TO_PT`, **но** при дефолтном `fontSize` берётся `body_pt` (12pt) — текстблок с дефолтным размером, но изменённым выравниванием/жирностью **не** мельчает (раньше уезжал в 10.5pt). alignment/b/i/u считаются независимо от размера.
- **`_scale_picture`** (`docx/builders/violation.py`) — ранний `return` при нулевой ширине картинки (`if not int(shape.width): return`), иначе масштабирование делило бы на 0 и роняло весь экспорт.

Обход дерева у всех трёх форматтеров общий — `formatters/tree_walker.py::walk(tree, visitor, blocks)` диспетчит leaf-типы по `LEAF_BLOCK_REFS` (см. §15).

---

## 15. Как добавить новый тип блока конструктора

Типы листовых блоков (`table`, `textblock`, `violation`) и структурный `item` описаны **двумя реестрами**, синхронизируемыми вручную (как `names.py` ↔ `chat-client-actions.js`):

- **Фронт** — `static/js/constructor/block-types.js`: `BLOCK_TYPES` (frozen-объект описаний: `idProp`, `dictName`, `defaultLabel`, `limitPerNode`, `domIndexPrefix`), `LEAF_BLOCK_TYPES`, хелперы `getBlockType` / `isBlockType` / `isLeafBlockType`. Строки типов — `AppConfig.nodeTypes` (реестр использует их как ключи).
- **Бэк** — `app/domains/acts/block_types.py`: константы `NODE_TYPE_*`, наборы `NODE_TYPES` / `LEAF_BLOCK_TYPES`, маппинг `LEAF_BLOCK_REFS` (тип → поле-ссылка + имя словаря `ActDataSchema`).

Синхронность и полноту обработки держат **тест-стражи**: `tests/domains/acts/test_block_types_guard.py` (Literal схемы = реестр; каждый leaf-тип семантически доходит до вывода DOCX/MD/text-форматтеров; HTML-поля проходят санитайзер) и `tests/js/block-types.test.mjs` (точные строки типов, полнота полей, render-обработчики `ItemsRenderer._leafRenderers`). Новый тип в реестре **провалит стражи**, пока не закрыты все точки ниже.

Чек-лист добавления типа (пример — гипотетический блок `chart` → `chartId` → словарь `charts`):

**Одна запись в каждом реестре (закрывает сразу несколько бывших точек):**

1. `AppConfig.nodeTypes.CHART = 'chart'` + лимит в `AppConfig.content.limits` (`app-config.js`) + метка в `AppConfig.tree.labels` — строки-источники.
2. Описание типа в `BLOCK_TYPES` (`block-types.js`) — после этого `state-content._createContentNode`, диспетч `ItemsRenderer.renderItem`, лимиты `ValidationTree` и префикс `_domIndex` работают автоматически.
3. Константа + наборы + запись `LEAF_BLOCK_REFS` в `block_types.py` — после этого кросс-валидатор ссылок дерево↔словари (`validate_tree_dict_refs`) подхватывает тип автоматически.

**Оставшиеся ручные точки (стражи о них напомнят):**

4. Pydantic-схема: `"chart"` в `Literal` `ActItemSchema.type`, поле `chartId` на `ActItemSchema`, класс `ChartSchema`, словарь `charts: dict[str, ChartSchema]` в `ActDataSchema` (`schemas/act_content.py`).
5. Метод создания `addChartToNode()` в `state-content.js` + render-метод и запись в `ItemsRenderer._leafRenderers` (`items-renderer.js:252`).
6. Preview-рендерер: `preview-chart-renderer.js` + диспетч в `preview.js`.
7. Три форматтера экспорта: обход у всех общий — `formatters/tree_walker.py` (`walk(tree, visitor, blocks)` сам диспетчит leaf-типы по `LEAF_BLOCK_REFS`, включая «item с прикреплённой таблицей»), поэтому достаточно по **одному визитор-методу `on_chart` на формат**: `_TextTreeVisitor` (`text_formatter.py`), `_MarkdownTreeVisitor` (`markdown_formatter.py`), `_DocxTreeVisitor` (`docx/formatter.py`, + builder).
8. Санитайзер: если у блока есть HTML-поля — обработка в `sanitize_act_data` И `sanitize_act_content_dict` (`utils/html_sanitizer.py:478` и `:509`). Санитайзера два: `sanitize_html` (bleach — текстблоки/дерево) и `sanitize_rich_html` (nh3 — rich-содержимое блоков нарушения: `text.content`, `image.caption`, диспетчер `_sanitize_block` по всем 10 полям реестра `violation_fields.py`); для нового блока выбери движок сознательно и задокументируй выбор. Пропуск = молчаливая XSS-дыра.
9. Фикстура типа в `_BLOCK_PAYLOADS` тест-стража (`test_block_types_guard.py`) — параметризация по `LEAF_BLOCK_TYPES` сама потребует её.
10. Иконка типа в `AppConfig.tree.icons` и, при необходимости, названия в `typeNames` / `limitNames` (`app-config.js`).

Отдельно: при добавлении нового `node.type` не забыть фронтовые проверки `_isInformationalNode` / `canAcceptAsChild` и сериализатор `_serializeTree` (см. §20).

> До реестров добавление типа требовало ~13-16 несвязанных правок в 9 файлах, и пропуск любой был молчаливым (блок исчезал из одного экспорта, забытый санитайзер не чистил HTML). Теперь точки 1-3 декларативны, а пропуск точек 4, 7-9 ловят стражи.

---

## 16. URL страницы акта

Канонический формат: **`/constructor?act_id={int}`**, где значение — `INTEGER` из `{PREFIX}acts.id` (BIGSERIAL). HTML-роут — `app/domains/acts/routes/constructor.py:27` (`act_id: int` как обязательный query-параметр, доступ проверяется до рендера).

> **Важно**: НЕ `/acts/{km_number}`. КМ-номер — это бизнес-идентификатор, а не маршрут. Поиск по КМ/СЗ резолвит в `acts.id` через `acts`-репозиторий, и только потом строится URL.

Это используется во всех client-action handler'ах (`acts.open_act_page`, button-translator), в `chat-client-actions.js` (`resolveProxyUrl`) и в навигации из чата. См. §7.8/§7.9 в [`../guides/ai-assistant.md`](../guides/ai-assistant.md).

---

## 17. Фронтенд: AppState, StorageManager, LockManager

Deep-dive — [`frontend-architecture.md`](frontend-architecture.md):

- **§4 «AppState и состояние конструктора»** — рекурсивная Proxy-обёртка через `_wrapStateWithProxy` / `_wrapDeep`, `_stateProxyCache: WeakMap` для защиты от двойной обёртки, `Object.assign(AppState, ...)` расширение из `state-tree.js`/`state-content.js`, pinned tables (`isPinnedTable`, `_getFirstNonPinnedIndex`, см. §5), protected nodes (секции 1–5, см. §6).
- **§5 «StorageManager и persistence»** — state machine `saved` / `local-only` / `unsaved`, debounce 3 сек + periodic 2 мин, `_dragInProgress` guard, ручное сохранение через `NavigationManager` (Ctrl+S → `saveToDatabase` — PUT в БД; Ctrl+Shift+S / кнопка-индикатор → `saveAndExport` — сохранение + генерация), navigation interception (popstate + `confirmNavigation` + `_lockNavGuard`), per-act LS-ключи с префиксом `actId`.
- **§6 «LockManager и inactivity»** — фронт-часть механизма из §10.

> **Защита `_trackingDepth` от утечки.** Операции, отключающие трекинг на время работы (`saveActContent` / `generateAct` / `loadActContent`), включают его обратно в `finally`/отложенном таймере; если страница уничтожается до re-enable, `destroy()` принудительно сбрасывает `_trackingDepth=0`. Иначе при переоткрытии конструктора без полной перезагрузки страницы трекинг оставался бы выключенным → правки молча не помечались грязными (тихая потеря данных).

> **Лимиты структуры — из настроек через `/limits`.** Границы таблиц (`max_rows`/`max_cols`/`min_col_width_px`) и шрифта текстблоков (`font_size_min`/`font_size_max`) фронт получает тем же `GET /api/v1/acts/limits`, что и лимиты картинок (`violation-image-validator.js`, `getStructureLimits()`). Гейты таблиц (`table-cells-operations.js`, `table-sizes.js`) и клампинг шрифта (textblock-тулбар) читают именно его. `AppConfig.limits` остаётся синхронным фолбэком/контрактом (пин-тесты). Источник истины этих чисел — настройки `ACTS__TABLES__*`/`ACTS__TEXTBLOCKS__*`, end-to-end (UI-гейт → `/limits` → Pydantic-валидаторы схемы).

**Связь с lock-механизмом**: при 409 на `PUT /content` `APIClient` бросает `LockLostError`, `NavigationManager._handleSaveExportError` ловит и делает жёсткий редирект на `/acts` (без `confirmNavigation`-диалога — сессия уже потеряна). Детали — §6.8 в `frontend-architecture.md`.

---

## 18. Сознательные ограничения конструктора

- **Конструктор — desktop-only.** Мобильная поддержка сознательно отсутствует: в шаблонах конструктора нет viewport-меты, раскладка (дерево + редактор + превью) рассчитана на широкий экран, drag-and-drop и resize-handles таблиц требуют мыши. Не добавляй viewport/media-queries «для галочки» — это создаст видимость поддержки без работоспособного UX.
- **Копирование узлов между актами поддерживается** (`static/js/constructor/clipboard/node-clipboard.js`): Ctrl+C/Ctrl+V вне текстовых редакторов + пункты «Копировать»/«Вставить» в контекстном меню дерева. Транспорт — localStorage-буфер (ключ `CLIPBOARD_STORAGE_KEY = 'constructor:clipboard'`, работает между вкладками одного origin, версия формата проверяется). При вставке все `id` регенерируются, а ссылки на словари (`tableId`/`textBlockId`/`violationId`) и сами записи `tables`/`textBlocks`/`violations` переносятся в целевой акт под новыми id — без сирот (иначе бэк-кросс-валидатор дерево↔словари вернул бы 422). Ограничения: защищённые секции 1–5 и pinned-таблицы (metrics/risk) нельзя копировать как корень выделения; pinned-дети пропускаются при вставке (с уведомлением); invoice-привязки сбрасываются (фактура принадлежит акту/узлу); картинки (inline base64) копируются с проверкой лимита суммарного размера картинок акта; вставка проходит штатную валидацию (`ValidationTree.canAddChild` + `maxDepth`) и официальный мутатор `AppState.insertNodeAt` (позиция — после pinned). Вставка транзакционна: при сбое `insertNodeAt` перенесённые записи словарей откатываются.
- **a11y-адаптация конструктора не является целью** — решение по Б-3.1 (десктоп-онли, известный круг пользователей). Текущего покрытия достаточно; не заводить как технический долг.

---

## 19. Примеры

Примеры иллюстративные и сокращённые — реальные узлы содержат больше служебных полей, генерируемых фронтом (`number`, `customLabel`, и т. д.).

### 19.1. Минимальный валидный акт (пустой каркас)

```jsonc
{
  "tree": {
    "id": "root",
    "label": "Акт",
    "children": [
      { "id": "1", "label": "Информация о процессе, клиентском пути", "type": "item", "protected": true, "deletable": false, "content": "", "children": [] },
      { "id": "2", "label": "Оценка качества …", "type": "item", "protected": true, "deletable": false, "content": "", "children": [] },
      { "id": "3", "label": "Примененные технологии", "type": "item", "protected": true, "deletable": false, "content": "", "children": [] },
      { "id": "4", "label": "Основные выводы", "type": "item", "protected": true, "deletable": false, "content": "", "children": [] },
      { "id": "5", "label": "Результаты проверки", "type": "item", "protected": true, "deletable": false, "content": "", "children": [] },
      { "id": "6", "label": "Оценка процесса по результатам исследования методом Process Mining", "type": "item", "special": "process_mining", "protected": true, "deletable": false, "titleLocked": true, "content": "", "children": [] }
    ]
  },
  "tables": {},
  "textBlocks": {},
  "violations": {},
  "invoiceNodeIds": [],
  "changelog": [],
  "saveType": "manual"
}
```

### 19.2. Акт с одним пунктом `5.1`, risk-таблицей и автоматически созданной сводной

```jsonc
{
  "tree": {
    "id": "root", "label": "Акт",
    "children": [
      /* … разделы 1..4 … */
      {
        "id": "5", "label": "Результаты проверки", "type": "item",
        "protected": true, "deletable": false, "number": "5",
        "children": [
          /* главная сводная (создана автоматически) */
          {
            "id": "5_table_1717000000000_abc",
            "label": "Объем выявленных отклонений",
            "type": "table",
            "tableId": "table_1717000000000_abc",
            "kind": "mainMetrics",
            "protected": true, "deletable": true,
            "number": "Таблица 1"
          },
          {
            "id": "node_1717000001000_def", "label": "Подпункт 1",
            "type": "item", "number": "5.1",
            "children": [
              /* сводная метрик для 5.1 (создаётся при появлении risk-таблицы в 5.1.*) */
              {
                "id": "...", "label": "Объем выявленных отклонений (В метриках) по 5.1",
                "type": "table", "tableId": "table_metrics_5_1",
                "kind": "metrics", "protected": true, "deletable": true,
                "number": "Таблица 1"
              },
              {
                "id": "node_1717000002000_ghi", "label": "Подпункт 1.1",
                "type": "item", "number": "5.1.1",
                "children": [
                  {
                    "id": "...", "label": "Таблица регулярных рисков",
                    "type": "table", "tableId": "table_risk_reg_1",
                    "kind": "regularRisk", "protected": true, "deletable": true, "number": "Таблица 1"
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  },
  "tables": {
    "table_1717000000000_abc": {
      "id": "table_1717000000000_abc",
      "nodeId": "5_table_1717000000000_abc",
      "grid": [ /* 4×7 шаблон метрик из _createMetricsHeaderGrid */ ],
      "colWidths": [120, 200, 80, 80, 100, 80, 120],
      "protected": true, "deletable": true,
      "kind": "mainMetrics"
    },
    "table_metrics_5_1": { /* такой же шаблон, kind: "metrics" */ },
    "table_risk_reg_1":  { /* шаблон regularRisk, kind: "regularRisk" */ }
  },
  "textBlocks": {},
  "violations": {},
  "invoiceNodeIds": [],
  "changelog": [],
  "saveType": "auto"
}
```

### 19.3. Акт с прикреплённой фактурой на листе `5.2.1`

```jsonc
{
  "tree": {
    "id": "root", "label": "Акт",
    "children": [
      /* … разделы 1..4 … */
      {
        "id": "5", "label": "Результаты проверки", "type": "item", "protected": true, "deletable": false, "number": "5",
        "children": [
          {
            "id": "node_p52", "label": "Пункт 2", "type": "item", "number": "5.2",
            "children": [
              {
                "id": "node_p521", "label": "Подпункт 1", "type": "item", "number": "5.2.1",
                "tb": ["МБ", "СибБ"],
                "invoice": {
                  "db_type": "greenplum",
                  "schema_name": "audit_schema",
                  "table_name": "t_audit_invoices_main",
                  "metrics": [
                    { "metric_type": "ФР", "metric_code": "ФР00001", "metric_name": "Финансовые результаты" }
                  ],
                  "process": [ { "process_code": "P-001", "process_name": "Кредитование" } ],
                  "profile_div": "Дирекция корпоративного бизнеса"
                },
                "children": []
              }
            ]
          }
        ]
      }
    ]
  },
  "tables": {},
  "textBlocks": {},
  "violations": {},
  "invoiceNodeIds": ["node_p521"],
  "changelog": [],
  "saveType": "manual"
}
```

Замечание: при сериализации фронтом через `_serializeTree` поле `invoice` НЕ войдёт в отправляемый `tree`. Бэк узнаёт о фактуре только через `invoiceNodeIds` и существующую строку в `act_invoices`. На загрузке `_attachInvoicesToTree` подмешивает `invoice` обратно в живой объект дерева.

---

## 20. Версионирование схемы

**На текущем этапе явного версионирования схемы `tree_data` нет.**

- Поле `version` или аналог в `tree_data` отсутствует — ни Pydantic-схема (`ActDataSchema`, `ActItemSchema`), ни таблица `act_tree` не содержат такого поля.
- Эволюция структуры идёт через:
  1. SQL-миграции — изменения схемы таблиц (`migrations/postgresql/schema.sql`, `migrations/greenplum/schema.sql`); схема исполняется при старте через `create_tables_if_not_exist` (см. [`database.md §6.5`](../guides/database.md#65-миграции)). Легаси-данных не держим: ломающее изменение схемы означает пересоздание БД, расширяющее — правку `schema.sql` плюс файл миграции в `docs/migrations/` для уже развёрнутых БД.
  2. Pydantic-валидаторы — `ActItemSchema.model_rebuild()` после декларации и `field_validator`'ы на `TableSchema.grid`/`colWidths`. Политика незнакомых полей задана явно: словарные схемы и `ActDataSchema` — `extra="forbid"` (незадекларированное поле → 422), узлы дерева (`ActItemSchema`) — явный `extra="ignore"` с нормализацией через `model_dump` (дерево хранится нормализованным). При несовместимом изменении схемы валидация старых документов упадёт с `ValidationError` — новые поля добавляются опциональными с `default=` и обязательно декларируются в схеме.
  3. Денормализация — если меняется набор флагов в `act_tables` (например, новый тип спец-таблицы), нужно одновременно обновить SQL-миграции (новая колонка, индекс при необходимости) и `ActContentRepository._load_tables`/`_save_tables`.

**Снапшоты содержимого** — таблица `act_content_versions` — это версионирование данных конкретного акта, а не схемы; подробно (включая дедуп по `content_hash` и кольцо `MAX_CONTENT_VERSIONS`) — §11.

**Рекомендации при изменении модели.**

- Новые поля узлов или контейнеров добавлять с `default=` и явной декларацией в схеме: для словарных схем действует `extra="forbid"` — незадекларированное поле от фронта отклоняется 422.
- Удаление полей делать в два шага: сначала перевод в опциональные, миграция данных, потом удаление.
- При добавлении нового `node.type` — обновлять `Literal[...]` в `ActItemSchema.type`, фронтовый `AppConfig.nodeTypes`, проверки `_isInformationalNode` / `canAcceptAsChild` и сериализатор `_serializeTree`; полный чек-лист — §15.
- При добавлении нового подвида спец-таблицы — расширять `TABLE_KINDS`/CHECK `check_table_kind_values` (миграции PG + GP), маппинг в `_load_tables`/`_save_tables`, дискриминаторы `table-kind.js` (`isPinnedTable`/`isRiskTable`).
- CHECK-констрейнты в SQL: при добавлении нового CHECK обязательно зарегистрировать сообщение в `CHECK_CONSTRAINT_MESSAGES` (`app/core/exceptions.py`) — см. [`database.md §6.5a`](../guides/database.md#65a-как-добавить-check-constraint).
- Greenplum: помнить про PG 9.4 (нет `IF NOT EXISTS` для индексов, нет `gen_random_uuid()`, UUID-id — `VARCHAR(36)`); `DISTRIBUTED BY` должен быть подмножеством `PRIMARY KEY` и каждого `UNIQUE` — именно поэтому уникальность `(km_number_digit, part_number)` в GP держится на app-уровне (см. §2.1).
