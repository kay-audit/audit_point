# Бизнес-требования к данным чата в Greenplum (ПРОМ)

**Версия:** для `app/__init__.py:__version__ = 15.4.1`.
**Область:** домен `chat` (`app/domains/chat/`) и шина канала к внешнему ИИ-агенту (`CHAT__AGENT_CHANNEL__TABLE_NAME`).
**Цель:** гарантировать, что файл-блоки, приходящие в чат, отрисовываются на фронте с иконками «Предпросмотр» и «Скачать», а сами файлы доступны для просмотра и скачивания.

Документ нормативен для всех, кто пишет в эти таблицы в обход фронта/бэка AW: SQL-имитации, скрипты наполнения, миграции данных, прямые правки DBA, воркеры внешнего агента.

---

## 0. Скоуп и принятые сокращения

- **AW** — приложение Audit Workstation (`app/main.py`).
- **БД** — Greenplum (`DATABASE__TYPE=greenplum`, `DATABASE__GP__HOST=…`).
- **Схема AW** — значение `DATABASE__GP__SCHEMA` (на ПРОМе `s_grnplm_ld_audit_da_project_34`).
- **Префикс таблиц AW** — `DATABASE__TABLE_PREFIX` (`t_db_oarb_audit_act_`). Имя таблицы = `<prefix><имя>`.
- **Шина (bus)** — таблица `CHAT__AGENT_CHANNEL__TABLE_NAME` (на ПРОМе `agent_conversation_messages`). Имя задаётся целиком, **без префикса AW**. Владелец таблицы — внешний агент; AW лишь читает/пишет в неё.
- **UUID файла** — он же `file_id` в блоке сообщения, он же `id` в таблице `chat_files`.

---

## 1. Три сценария появления файла в чате

Файл попадает в блок сообщения одним из трёх способов. Для каждого — свои требования к БД.

| # | Сценарий | Где живёт файл | Что в `block.file_id` |
|---|---|---|---|
| **A** | Файл прикрепил пользователь (drag-and-drop / кнопка-скрепка) | `chat_files.file_data` (BYTEA) | UUID из `chat_files.id` |
| **B** | Внешний агент вернул файл в строке-ответе шины | `chat_files.file_data` (BYTEA), `chat_files.id` UUID | UUID из `chat_files.id` |
| **C** | Тулз/агент вернул файл инлайном (data-URL) | В блоке `chat_messages.content` (JSONB), нигде в БД отдельно не хранится | Строка `"data:<mime>;base64,<payload>"` |

Сценарии **A** и **B** — нормативные для ПРОМа. Сценарий **C** — обходной путь для мелких текстов/MD/изображений, которые инструмент не хочет класть в `chat_files`.

> ⚠️ Голый base64 без префикса `data:` (`"IyDQktC+"`) **не поддержан**: фронт трактует любую непустую строку без `data:` как UUID и шлёт `GET /api/v1/chat/files/<строка>` → 404. Иконки на карточке появятся (т.к. условие `if (block.file_id)`), но скачивание и предпросмотр работать не будут.

---

## 2. Общие требования к данным (все таблицы)

### 2.1. Идентификаторы

- Все `id`, `conversation_id`, `message_id`, `file_id`, `agent_ref` — **строки формата UUID v4 в виде текста** (36 символов, с дефисами, нижний регистр). Никаких integer-инкрементов, никаких префиксов `f_`/`m_`/`c_`.
- Совпадение формата с обеих сторон обязательно: если AW сгенерировал `c0e9…`, то и шина должна в `chat_id` хранить тот же `c0e9…`, иначе `JOIN` и поиск по `chat_messages.agent_ref` расходятся.

### 2.2. Время

- `created_at`, `updated_at` в `chat_files`, `chat_messages`, `chat_conversations` — `TIMESTAMP` без таймзоны (Greenplum-схема AW).
- `created_at`, `updated_at` в **bus-таблице** — `TIMESTAMP WITH TIME ZONE` (NOT NULL). Это различие типов — по спеке владельца шины; менять нельзя.
- `updated_at` в шине обновляется на каждом «признаке жизни» агента (переход `pending → processing`, изменение `metadata.reasoning`, рост `content`). Поллер AW использует его как liveness-сигнал.

### 2.3. JSONB-валидность

Колонки `chat_messages.content`, `chat_files.*` (нет JSONB), `chat_conversations.context`, `bus.media`, `bus.metadata`, `bus.buttons`, `chat_tool_metrics.token_usage` (нет такого — `chat_messages.token_usage`), `chat_message_feedback.reasons` — **должны парситься как JSON**. Битый JSON AW трактует как пустой массив/объект (см. `MessageRepository._content_list`) и теряет блоки тихо. На стороне AW это означает, что любой write-tool в Greenplum, формирующий эти колонки, должен класть туда валидный JSON.

### 2.4. Согласованность chat_id ↔ conversation_id ↔ agent_ref

Три идентификатора обязаны сходиться:

- `chat_messages.conversation_id` = `chat_conversations.id`
- `bus.chat_id` (на строке-вопросе И на строке-ответе) = `chat_messages.conversation_id`
- `bus.reply_to` (на строке-ответе) = `bus.id` соответствующей строки-вопроса
- `chat_messages.agent_ref` = `bus.id` строки-вопроса

Любое расхождение → поллер AW не найдёт ответ (см. `AgentMessageRepository.get_answer_for_question`), и фронт зависнет на «Агент работает над ответом…» либо на «В очереди: вы следующий».

---

## 3. Таблица `{prefix}chat_conversations`

Минимум, требуемый для подвязки остальных таблиц:

```sql
CREATE TABLE {schema}.{prefix}chat_conversations (
    id              VARCHAR(36)    PRIMARY KEY,   -- UUID
    user_id         VARCHAR(50)    NOT NULL,      -- табельный номер
    title           VARCHAR(500),                -- может быть NULL
    domain_name     VARCHAR(100),                -- может быть NULL
    context         JSONB,                       -- может быть NULL
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
)
DISTRIBUTED BY (id);
```

**Бизнес-инварианты:**

1. `id` уникален глобально.
2. `user_id` — строковое поле с табельным номером (или логином) пользователя, **не числовой PK**.
3. При удалении беседы (`DELETE FROM chat_conversations WHERE id = ?`) допустимо каскадно удалять `chat_messages` и `chat_files` (`ON DELETE CASCADE` — для PG) или делать это явно через репозиторий (для GP, где FK не enforce-ятся).
4. **Удалять строки `chat_files` и `chat_messages` в обход приложения нельзя** без удаления беседы: orphan-строки занимают место и портят `count_active_for_user` (active-slots лимита параллельных запросов).

---

## 4. Таблица `{prefix}chat_files`

```sql
CREATE TABLE {schema}.{prefix}chat_files (
    id              VARCHAR(36)    PRIMARY KEY,           -- UUID; это и есть file_id в блоке
    conversation_id VARCHAR(36)    NOT NULL,              -- FK → chat_conversations.id
    message_id      VARCHAR(36),                          -- FK → chat_messages.id, NULL допустим
    filename        VARCHAR(500)   NOT NULL,
    mime_type       VARCHAR(200)   NOT NULL,              -- строго из whitelist §4.1
    file_size       INTEGER        NOT NULL CHECK (file_size > 0),
    file_data       BYTEA          NOT NULL,              -- сырой бинарь
    created_at      TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP
)
DISTRIBUTED BY (id);
```

### 4.1. `mime_type` — строгий whitelist

Значение `mime_type` должно **точно** совпадать с одним из элементов `CHAT__ALLOWED_MIME_TYPES` (по умолчанию):

```
text/plain
text/csv
text/markdown
application/pdf
application/json
application/xml
application/vnd.openxmlformats-officedocument.spreadsheetml.sheet   -- .xlsx
application/vnd.ms-excel                                            -- .xls
application/vnd.openxmlformats-officedocument.wordprocessingml.document  -- .docx
image/jpeg
image/png
image/gif
image/webp
```

Запрещено:

- Любые `*/*`, `text/*` и прочие wildcard-значения (валидатор AW их режет — `_no_wildcards_in_mime_types` в `app/domains/chat/settings.py`).
- MIME с параметрами: `"text/html; charset=utf-8"`, `"image/png; profile=foo"` — сравнение жёсткое, посимвольное (`FileService.validate_file`).
- Пустая строка.

### 4.2. `filename` — без служебных символов

Запрещены (валидация `FileService.validate_file`):

- пустая строка,
- `"/"`, `"\\"`, `"\x00"` в любой позиции,
- значения `"."` и `".."` целиком.

Длина — до 500 символов (`VARCHAR(500)`).

### 4.3. `file_size`

- `INTEGER NOT NULL CHECK (file_size > 0)`.
- Значение `0` запрещено (`FileService.validate_file` отвергает пустые/нулевые файлы).
- Должно **точно** равняться `length(file_data)` в байтах.
- Превышение `CHAT__MAX_FILE_SIZE` (по умолчанию 512 МБ) при загрузке через UI → отказ на API; при прямой записи в БД — файл скачается, но загрузить повторно через UI тот же `id` уже не выйдет.

### 4.4. `file_data`

- `BYTEA NOT NULL` — сырой бинарь без перекодирования.
- На скачивание AW возвращает `Content-Type: application/octet-stream` + `X-Content-Type-Options: nosniff` независимо от `mime_type` (см. `download_file` в `app/domains/chat/api/files.py`). Браузер скачивает как blob, MIME не влияет на безопасность.
- На предпросмотр AW возвращает тот же blob + `inline=true` query, фронт сам решает, как рендерить по `block.mime_type`.

### 4.5. `message_id`

- Может быть `NULL` в момент создания файла (файл прикреплён к сообщению, которое ещё не создано — типично для user-uploaded файлов). Заполняется постфактум через `FileRepository.link_to_message`.
- **Для иконок и скачивания `message_id` не нужен** — фронт использует только `id`. Значение важно только для очистки (orphan-файлы после удаления сообщения) и для аудита.

### 4.6. `id` (= `file_id`)

- Уникален глобально. UUID v4. Никогда не переиспользуется.
- Используется в URL `GET /api/v1/chat/files/{file_id}`. Если строка не найдена или не принадлежит пользователю — `404 ChatFileNotFoundError`.

---

## 5. Таблица `{prefix}chat_messages`

```sql
CREATE TABLE {schema}.{prefix}chat_messages (
    id              VARCHAR(36)    PRIMARY KEY,
    conversation_id VARCHAR(36)    NOT NULL,                                  -- FK
    role            VARCHAR(20)    NOT NULL,                                  -- на уровне БД CHECK нет; конвенция AW: 'user' | 'assistant' | 'system'
    content         JSONB          NOT NULL,                                  -- см. §5.1
    model           VARCHAR(100),
    token_usage     JSONB,
    status          VARCHAR(20)    NOT NULL DEFAULT 'complete'
                                  CHECK (status IN ('streaming','complete','failed')),
    agent_ref       VARCHAR(36),                                              -- см. §5.3
    created_at      TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP
)
DISTRIBUTED BY (id);
```

### 5.1. `content` — JSONB-массив блоков

`content` — это JSONB-массив объектов-блоков. Каждый блок имеет поле `"type"`. Для файлов типы:

- `"file"` — файл, который надо показать карточкой с иконкой и кнопками;
- `"image"` — изображение, рендерится inline (`<img>`).

#### 5.1.1. Блок типа `file`

```json
{
  "type": "file",
  "file_id": "<UUID из chat_files.id>  ИЛИ  data:<mime>;base64,<payload>",
  "filename": "<string, ≤500 символов, без /\\ и NUL>",
  "mime_type": "<строка из whitelist §4.1>",
  "file_size": <целое > 0>
}
```

**Жёсткие правила:**

1. `file_id` — **обязательное** поле. Без него (`null`, отсутствует, пустая строка) карточка отрисуется, но кнопок «Предпросмотр» и «Скачать» не будет (`if (block.file_id)` ложно, `ChatRenderer._renderFile`).
2. `file_id` обязан быть **либо** валидным UUID строки из `chat_files`, **либо** data-URL с префиксом `data:`. Промежуточные варианты (голый base64, http-ссылка) не поддержаны фронтом.
3. `mime_type` и `file_size` рекомендованы заполненными (для иконки по расширению, для текста размера). Пустые/нулевые допустимы — карточка отрисуется без них.

#### 5.1.2. Блок типа `image`

```json
{
  "type": "image",
  "file_id": "<UUID из chat_files.id>  ИЛИ  data:image/<sub>;base64,<payload>",
  "alt": "<string, имя файла или описание>"
}
```

**Жёсткие правила:**

1. `file_id` **обязателен** для кликабельности (открытие в просмотрщике) и для `<img src>` (см. `ChatRenderer._renderImage`).
2. `mime_type` берётся из блока; если не задан, для image-блока подставляется `image/png` при открытии в viewer.
3. `alt` рекомендован заполненным (a11y).

#### 5.1.3. Другие типы блоков (контекст)

`text`, `reasoning`, `code`, `plan`, `buttons`, `client_action`, `error` — описаны в `ChatRenderer.renderBlock` (`static/js/shared/chat/chat-renderer.js`) и `docs/architecture/chat-frontend-architecture.md`. На появление file-иконок не влияют, но находятся в том же массиве `content` — структурно должны быть валидным JSON-массивом.

### 5.2. `status` и жизненный цикл

- `user`-сообщения: всегда создаются со `status='complete'` (дефолт).
- `assistant`-сообщения: пишутся как `streaming` → материализуются блоками через `append_block`/`upsert_block` → переводятся в `complete` через `MessageRepository.finalize` либо в `failed` через `MessageRepository.mark_failed`.
- `agent_ref` заполняется только у `assistant`-сообщений, обрабатываемых через шину.
- **Снаружи AW напрямую писать в `chat_messages` нельзя**, кроме случаев seed/backfill: при ручном INSERT нужно выставить `status='complete'` сразу, иначе поллер AW будет считать сообщение черновиком и финализировать его.

### 5.3. `agent_ref`

- Только у `assistant`-сообщений, обрабатываемых через шину (`status='streaming'` в момент создания).
- Значение = `bus.id` строки-вопроса (UUID).
- Если заполнено при `status='complete'` — допустимо, ни на что не влияет (поллер смотрит только на streaming).
- Если `NULL` у streaming-сообщения — recover-механизм при старте uvicorn его не подхватит (`get_streaming_drafts` фильтрует `agent_ref IS NOT NULL`).

---

## 6. Шина: таблица `CHAT__AGENT_CHANNEL__TABLE_NAME` (владелец — внешний агент)

> Таблицу создаёт и обслуживает сторона внешнего агента. AW лишь читает/пишет в неё и подписан на спеке-контракт. Ниже — что AW ждёт от данных.

```sql
CREATE TABLE {bus_schema}.{BUS_TABLE} (   -- например agent_conversation_messages
    id          UUID,                                  -- uid одного сообщения шины
    chat_id     TEXT,                                  -- = chat_messages.conversation_id
    user_id     TEXT,
    role        TEXT NOT NULL
                CHECK (role IN ('user','assistant','system','tool')),
    content     TEXT NOT NULL,
    media       JSONB,                                 -- см. §6.3
    metadata    JSONB,
    reply_to    UUID,                                  -- на строке-ответе → id вопроса
    buttons     JSONB,                                 -- на строке-ответе, см. §6.4
    status      TEXT NOT NULL
                CHECK (status IN ('pending','processing','completed','failed','error')),
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at  TIMESTAMP WITH TIME ZONE NOT NULL
)
DISTRIBUTED BY (chat_id);                              -- на GP; см. greenplum/schema.sql
```

### 6.1. Протокол обмена

- Строка-**вопрос** от AW: `role='user'`, `status='pending'`, `reply_to=NULL`, `buttons=[]`, `media=[]` (AW всегда пишет пустой массив, не `{}` — `insert_question`, Task 5). `id` = UUID, который AW сохраняет в `chat_messages.agent_ref`.
- Строка-**ответ** от агента: `role='assistant'`, `reply_to = id строки-вопроса`, `content` = финальный текст, `status` переходит `processing → completed` (или `failed`).
- Агент **обязан** переводить `pending → processing` при взятии в работу. Без этого поллер AW считает, что агент не работает (`phase='pending'`, `claim_timeout_sec=1800`).
- Агент **обязан** обновлять `updated_at` на каждой дельте (`metadata.reasoning` стримится). Без этого поллер решит, что агент завис (`phase='processing'`, `answer_timeout_sec=1800`).

### 6.2. `status`

Словарь владельца (NanoBot 2.3): `pending` / `processing` / `completed` / `error` / `failed`; синоним legacy — `in_progress` вместо `processing`.

- `pending` — AW только что положил вопрос, агент ещё не взял.
- `processing` — агент взял и пишет ответ.
- `completed` — ответ финализирован, в `content` финальный текст.
- `error` — **повторяемая** ошибка: агент вернёт вопрос в пул и переобработает его (счётчик `retry_count` в `metadata`, до `max_stuck_retries` раз на стороне агента), удалив свою строку-ответ. AW при виде `status='error'` без строки-ответа просто ждёт — не финализирует draft (`_BUS_PENDING_STATUSES` в `AgentChannelService.poll_once` включает `error`).
- `failed` — терминальная ошибка, ответ не пишется. AW финализирует draft-сообщение error-блоком.

Возврат вопроса `processing → pending` (reclaim истёкшего lease агента либо повторяемая ошибка) для AW — признак жизни: он продлевает answer-таймер, но не более `_MAX_PENDING_REVERSIONS` (3) эпизодов за всю жизнь подписки — счёт идёт по эпизодам смены статуса, а не по тикам (`AgentChannelPoller`), и не сбрасывается. После исчерпания кап дальнейшие reclaim'ы окно уже не продлевают — защита от бесконечного продления флаппингом чужой таблицы.

### 6.3. `media` — массив/объект файлов (входящие от агента)

**Это ключевое поле для отображения файлов от агента.** Разбор — best-effort, мягкое приведение: один битый элемент не должен ронять весь ответ (`parse_media_items` в `app/domains/chat/services/agent_channel.py`).

```json
[
  {
    "file_id": "<UUID ИЛИ data:<mime>;base64,<payload> ИЛИ http(s)-ссылка>",
    "filename": "<string, опционально>",
    "mime_type": "<string, опционально>",
    "file_size": <целое, опционально>,
    "url": "<string, опционально, fallback вместо file_id>"
  }
]
```

**Фактическое поведение `parse_media_items`:**

1. `media` принимает JSON-объект-одиночку, строку-data-URL или массив — одиночное значение оборачивается в список автоматически. Любое другое (`int`, `bool`, …) даёт пустой список с warning'ом.
2. Элемент-**строка**: принимается, только если начинается с `data:` (`mime_type`/`file_size` вычисляются из самого data-URL); прочие строки — warning + пропуск.
3. Элемент-**объект**: `file_id = item.get("file_id") or item.get("url") or ""` — `url` работает как фолбэк независимо от префикса. Значение классифицируется (`_classify_file_id`) на `data` / `http` / `uuid` / `other` (не UUID и не URL) / `empty` (пусто).
4. `mime_type`/`file_size` приводятся мягко: нечисловой/отсутствующий `file_size` → `0`, не роняя элемент. Для `kind='data'` при пустых `mime_type`/`file_size` они доопределяются из самого data-URL.
5. Любой элемент не-dict и не-`data:`-строка, либо исключение при разборе конкретного элемента — `logger.warning` + пропуск именно этого элемента, остальные элементы и текст ответа не страдают.
6. Если `media=null` или `media=[]` — файл-блоков в ответе не будет, кнопок на фронте не появится, что бы ни писал агент в `content` текстом.

**Что уходит в блок чата** (`_entry_to_block` для `kind` ≠ `data`; `kind='data'` материализуется — см. §6.3.1):

- `kind='data'` (после материализации) или `kind='uuid'` с непустым `mime_type`, начинающимся на `image/`: `{"type":"image","file_id":...,"alt":filename}` — **без** `mime_type`/`filename` в самом блоке (схема `ImageBlock` их не знает).
- `kind='http'` — **всегда** `{"type":"file",...}`, даже при `mime_type` `image/*`: CSP ПРОМа (`img-src 'self' data: blob:`, enforce) блокирует `<img src>` на внешний http(s)-хост, картинка была бы гарантированно битой. Внешняя ссылка агента отображается карточкой файла без inline-предпросмотра, скачивание — прямым переходом по ссылке.
- Прочий `mime_type` (или `kind='data'` без картинки): `{"type":"file","file_id":...,"filename":...,"mime_type":...,"file_size":...}`.
- `kind='other'`/`'empty'`: карточка **без** `file_id` — фронт не рисует кнопок «Предпросмотр»/«Скачать» (битый путь агента не превращается в 404-ссылку).

#### 6.3.1. Модель хранения входящих файлов

Входящие вложения агента (`kind='data'`, инлайн base64) **материализуются в `chat_files`** — транспорт (base64 в шине) отделён от хранения:

- Материализация — `materialize_media_entries` (`app/domains/chat/services/agent_channel.py`), вызывается ровно один раз, **на финализации** ответа в `AgentChannelService.poll_once` (не на каждом тике опроса).
- Идемпотентность ретраев финализации: `file_id` детерминирован — `uuid5(NAMESPACE_URL, "agent-media:{answer_uid}:{idx}")`; повторный `INSERT` при ретрае финализации падает `UniqueViolationError` и просто переиспользует существующую запись.
- Лимит размера — `CHAT__AGENT_CHANNEL__MAX_MEDIA_FILE_SIZE` (`AgentChannelSettings.max_media_file_size`, дефолт **512 МБ**), сверяется по оценке размера из самого base64-payload'а (`len(payload) * 3 // 4`), а не по объявленному агентом `file_size` (тот приходит с чужой стороны и может врать в обе стороны). Тот же порядок величины и на исходящей стороне (`FileRepository`/`CHAT__MAX_FILE_SIZE`, тоже 512 МБ) — единый потолок вложения для обоих направлений.
- MIME **не** сверяется с whitelist §4.1 (в отличие от пользовательского аплоада) — файл от агента всё равно отдаётся только как `application/octet-stream` + `X-Content-Type-Options: nosniff` (см. §4.4), поэтому проверка MIME на входе не даёт защитного эффекта.
- Превышение лимита, битый/пустой base64 и любой сбой записи в `chat_files` дают error-блок про конкретный файл (`_file_error_block`); остальные вложения и текст ответа при этом целы.
- `filename` рекомендован явным от агента; при отсутствии/пустом/`"."`/`".."` AW синтезирует `"file_<idx><ext>"` по `mime_type` (`_sanitize_agent_filename`) — распознавания имени из текста ответа больше нет (снята фронтовая эвристика, ранее сопоставлявшая имена из `text`-блока файловым карточкам по порядку появления).
- **`media` не читается горячим опросом.** Строка bus-таблицы читается узкими проекциями без колонки `media` (поллер каждые 2-10 с, фронт — раз в 1.5 с); полное содержимое (потенциально сотни МБ base64) подтягивается только разово на финализации через `AgentMessageRepository.get_media_by_uid`.

> **Организационная фиксация (M5 аудита):** полный бинарный контент аудиторских документов теперь целиком уезжает в bus-таблицу — таблицу владельца шины (внешний агент), а не остаётся исключительно в `chat_files` AW. Это согласовано с командой аудита (закрытый контур), не является дефектом реализации. Срок хранения строк шины — ручная чистка `docs/integrations/agent-channel-cleanup.sql`, выполняется на стороне эксплуатации; приложение её не запускает.

#### 6.3.2. Запись в `bus.media` со стороны AW (исходящее)

AW web-ui (HTTP `POST /api/v1/chat/conversations/{cid}/messages` в режиме `always` или `adaptive` + forward-тул) **пишет в `bus.media`** (строка-вопрос) данные в формате, который ожидает владелец шины: элементы `{file_id, filename, mime_type, file_size}` **без поля `type`**, и `file_id` это `data:<mime>;base64,<payload>` (байты подтянуты из `chat_files` и закодированы инлайном). Это формат `chat_messages.content`-блока **минус** дискриминатор `type` и **с заменой** UUID на inline data-URL.

- Конверсия — `build_bus_media_from_file_blocks(file_blocks, *, conversation_id, file_repo, max_size)` в `app/domains/chat/services/agent_channel.py`; единая точка входа для вызывающих — `build_bus_media_for_submit` (та же сигнатура минус `file_repo`, сама открывает `FileRepository` через `DbExecutor`, соединение не удерживается на время base64-кодирования). Вызывается перед `AgentChannelService.submit` в `api/messages.py` (режим `always`) и в `services/agent_loop.py` (режим `adaptive` + forward-тул).
- Файл из `chat_files`, превышающий `max_size` (тот же `CHAT__AGENT_CHANNEL__MAX_MEDIA_FILE_SIZE`), в `bus.media` не попадает — пропускается с warning (best-effort: потеря одного вложения не должна ронять вопрос целиком).
- Сам файл по-прежнему хранится в `chat_files` (UUID нужен фронту для иконок/скачивания); в `chat_messages.content` для истории чата блок сохраняется **исходным** `chat_messages.content`-форматом — UI не разъезжается.

### 6.4. `buttons`

JSON-массив кнопок на строке-ответе (на строке-вопросе `buttons` всегда `[]`):

```json
[
  {"action_id": "<server-action-id>", "label": "<label>", "params": {}}
]
```

На файлы не влияет. Кнопки без зарегистрированного `action_id` в реестре AW (`button_translator`) на фронте не отрисуются.

### 6.5. `metadata`

Произвольный JSON. Из него AW читает `metadata.reasoning` (legacy `metadata.thinking`) и кладёт в reasoning-блок сообщения. На файлы не влияет.

### 6.6. `content`

Текст финального ответа. Plain TEXT, не JSONB. Тримится по `CHAT__AGENT_CHANNEL__MAX_BLOCK_TEXT_SIZE` (по умолчанию 262144 байт UTF-8).

### 6.7. `id` ↔ `chat_messages.agent_ref`

- `bus.id` — UUID, **генерируется той стороной, которая пишет строку**.
- AW генерирует `id` для строки-вопроса (`AgentChannelService.submit` — `str(uuid.uuid4())`) и сохраняет его же в `chat_messages.agent_ref`. Это и есть способ join'а.
- Агент при ответе пишет свой `id` (любой UUID), но обязательно проставляет `reply_to = id_вопроса`.

---

## 7. End-to-end: что нужно, чтобы иконки появились на ПРОМе

Чек-лист для прямой проверки (Greenplum → `{schema}.{prefix}chat_*` и `{bus_schema}.{BUS_TABLE}`):

| # | Проверка | Ожидаемо |
|---|---|---|
| 1 | `chat_conversations` имеет строку с `id = <conversation_id>` | строка есть |
| 2 | `chat_messages.content` содержит объект `{"type":"file", "file_id":"<uuid>", ...}` | блок есть, валидный JSON |
| 3 | `chat_files.id = <uuid>` существует и принадлежит той же беседе (`conversation_id` совпадает) | строка есть, `file_data` не NULL |
| 4 | `chat_files.mime_type` ∈ whitelist §4.1 | строгое равенство |
| 5 | `chat_files.file_size > 0` и равен `length(file_data)` | консистентно |
| 6 | `chat_files.conversation_id` → JOIN с `chat_conversations` под владельца-пользователя | возвращает 1 строку |
| 7 | (опц.) `chat_messages.status='complete'` | да (для финальных сообщений) |
| 8 | Если блок пришёл из шины: `bus.media[i].file_id` классифицируется как `data`/`http`/`uuid` (`_classify_file_id`) | не `other`/`empty` — иначе карточка без кнопок (код это обеспечивает сам, ручная проверка не нужна) |
| 9 | Если блок пришёл из шины: `bus.id` строки-вопроса = `chat_messages.agent_ref` ответа | совпадает |
| 10 | Если блок пришёл из шины: `bus.reply_to` строки-ответа = `bus.id` строки-вопроса | совпадает |

Если все 10 — на фронте (`/`, конструктор, popup-чат) отрисуется:

- иконка типа файла (PDF/DOCX/PNG/…),
- имя файла,
- размер,
- кнопка «глаз» (предпросмотр),
- кнопка «скачать» (download).

---

## 8. Провалы и как их увидеть

| Симптом на фронте | Вероятная причина в данных |
|---|---|
| Карточка с именем/размером есть, кнопок нет | `block.file_id` пустой/`null`; для блоков из шины — `kind='other'`/`'empty'` (`_entry_to_block` не проставил `file_id`) |
| Кнопка «Скачать» есть, файл не скачивается (404) | `file_id` — UUID-строка, которой нет в `chat_files` (для http(s)-ссылок и data-URL 404 такого рода не бывает — они не идут через `/api/v1/chat/files/`) |
| Карточки нет вообще, только текст с упоминанием файла | В `content` нет объекта `{"type":"file",...}`, только `text`-блок; агент описал файл словами |
| Иконка «глаз» есть, viewer показывает «Не удалось декодировать» | data-URL битый, `payload` после запятой не base64/url-encoded; для входящих файлов агента это же ловит `materialize_media_entries` на финализации (error-блок `agent_file_invalid`) |
| Скачивание работает, но viewer показывает «Предпросмотр недоступен» | `mime_type` блока не `image/*`, не `application/pdf`, не `text/*`, не `application/json`, не `application/xml` (ветки в `ChatRenderer._openFileViewer`) |

---

## 9. Что делать нельзя

1. **Писать в `chat_messages.content` блоки `{"type":"file","file_id":"<base64 без data:>"}`** — на UI появятся битые кнопки. Либо префикс `data:`, либо UUID из `chat_files`.
2. **Писать в `chat_files` файлы вне whitelist MIME** — даже если бэкенд их съест, фронт их не отрендерит (иконка по расширению не подберётся, viewer скажет «не поддерживается»).
3. **Переиспользовать `chat_files.id`** для разных файлов — старые блоки в `content` старых сообщений будут показывать новый файл.
4. **Удалять `chat_messages` со ссылкой `agent_ref` без удаления соответствующей строки в шине** — поллер AW при старте подхватит осиротевший streaming-draft и подпишется на несуществующий `bus.id`.
5. **Писать в `chat_messages` напрямую со `status='streaming'` и пустым `content`**, минуя `create_streaming` — приложение не сможет нормально финализировать (нужен был `agent_ref`).
6. **Менять `chat_id` шины после создания строки-вопроса** — `AgentMessageRepository.get_answer_for_question` ищет по `reply_to`, не по `chat_id`, но `count_pending_before` и reconcile смотрят на `created_at` именно этой строки.
7. **Заполнять `bus.buttons` на строке-вопросе** — кнопки рендерятся только в строке-ответе; `AgentMessageRepository.insert_question` пишет вопросу всегда пустой `buttons`, параметра для их передачи в вопрос у него нет.

---

## 10. Сводка инвариантов в одну строку

- `chat_files.id` (UUID) — единственный допустимый «не-data»/«не-http» значение `file_id` в блоках, идущих через `/api/v1/chat/files/`.
- `block.file_id` обязан начинаться с `data:`, быть http(s)-ссылкой, либо UUID из `chat_files` — классификация (`_classify_file_id`) и отсутствие кнопок для `other`/`empty` обеспечены кодом, не требуют ручной проверки.
- `mime_type` в `chat_files` — строго из whitelist §4.1, без параметров и wildcard'ов **для пользовательского аплоада**; для файлов, материализованных из ответа агента (§6.3.1), whitelist не применяется — скачивание в любом случае идёт как `application/octet-stream`.
- `file_size > 0`, `file_data` — реальные байты той же длины.
- `bus.id ↔ chat_messages.agent_ref ↔ bus.reply_to` — согласованная троица.
- `bus.media` не NULL и не пустой массив — обязательное условие появления файловых блоков от агента.
- `bus.media` в горячий опрос не попадает — только узкие проекции (`AgentMessageRepository`); полное содержимое читается разово при финализации через `get_media_by_uid`.