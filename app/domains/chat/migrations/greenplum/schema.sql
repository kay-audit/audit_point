-- Схема базы данных для домена чата (Greenplum)
-- Плейсхолдеры (подставляются перед выполнением):
--   {CHAT_SCHEMA_Q} — квалификатор схемы таблиц чата ("<schema>.");
--                     из CHAT__SCHEMA_NAME (пусто → основная схема адаптера).
--   {BUS_SCHEMA_Q}  — квалификатор схемы bus-таблицы; из
--                     CHAT__AGENT_CHANNEL__SCHEMA_NAME (fallback на схему чата).
--   {PREFIX}        — DATABASE__TABLE_PREFIX.

-- ============================================================================
-- ТАБЛИЦА БЕСЕД
-- ============================================================================

CREATE TABLE IF NOT EXISTS {CHAT_SCHEMA_Q}{PREFIX}chat_conversations (
    id              VARCHAR(36) PRIMARY KEY,
    user_id         VARCHAR(50) NOT NULL,
    title           VARCHAR(500),
    domain_name     VARCHAR(100),
    context         JSONB,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
)
WITH (appendonly=false)
DISTRIBUTED BY (id);

CREATE INDEX idx_{PREFIX}chat_conversations_user
    ON {CHAT_SCHEMA_Q}{PREFIX}chat_conversations(user_id);
-- Составной индекс под список бесед: get_by_user сортирует по updated_at DESC.
CREATE INDEX idx_{PREFIX}chat_conversations_user_updated
    ON {CHAT_SCHEMA_Q}{PREFIX}chat_conversations(user_id, updated_at DESC);

-- ============================================================================
-- ТАБЛИЦА СООБЩЕНИЙ
-- ============================================================================

CREATE TABLE IF NOT EXISTS {CHAT_SCHEMA_Q}{PREFIX}chat_messages (
    id              VARCHAR(36) PRIMARY KEY,
    conversation_id VARCHAR(36) NOT NULL REFERENCES {CHAT_SCHEMA_Q}{PREFIX}chat_conversations(id),
    role            VARCHAR(20) NOT NULL,
    content         JSONB NOT NULL,
    model           VARCHAR(100),
    token_usage     JSONB,
    -- Жизненный цикл assistant-сообщения: streaming → complete (или failed).
    -- User-сообщения создаются сразу со статусом 'complete'.
    status          VARCHAR(20) NOT NULL DEFAULT 'complete'
                    CONSTRAINT check_chat_messages_status_values
                    CHECK (status IN ('streaming','complete','failed')),
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
)
WITH (appendonly=false)
DISTRIBUTED BY (id);

-- Идемпотентная миграция для существующих GP-таблиц. GP 6.x (PG 9.4)
-- не поддерживает ADD COLUMN/CONSTRAINT IF NOT EXISTS — выполняем
-- безусловно и полагаемся на GreenplumAdapter, который ловит
-- DuplicateColumnError / DuplicateObjectError.
ALTER TABLE {CHAT_SCHEMA_Q}{PREFIX}chat_messages
    ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'complete';

ALTER TABLE {CHAT_SCHEMA_Q}{PREFIX}chat_messages
    ADD CONSTRAINT check_chat_messages_status_values
    CHECK (status IN ('streaming','complete','failed'));

-- agent_ref: безусловный ALTER, дубль глотает GreenplumAdapter.
ALTER TABLE {CHAT_SCHEMA_Q}{PREFIX}chat_messages ADD COLUMN agent_ref VARCHAR(36);

CREATE INDEX idx_{PREFIX}chat_messages_conversation
    ON {CHAT_SCHEMA_Q}{PREFIX}chat_messages(conversation_id);

CREATE INDEX idx_{PREFIX}chat_messages_created
    ON {CHAT_SCHEMA_Q}{PREFIX}chat_messages(conversation_id, created_at);

-- Под выборку «висящих» streaming-сообщений беседы. На GP partial-индексы
-- (WHERE ...) не используем — полный композитный надёжнее.
CREATE INDEX idx_{PREFIX}chat_messages_status
    ON {CHAT_SCHEMA_Q}{PREFIX}chat_messages(conversation_id, status);

-- ============================================================================
-- ТАБЛИЦА ФАЙЛОВ
-- ============================================================================

-- В GP FK referential actions не enforce-ятся (declarative FK — только документация модели).
-- Целостность поддерживается на уровне репозитория: conversation_repository
-- сам удаляет файлы беседы.
CREATE TABLE IF NOT EXISTS {CHAT_SCHEMA_Q}{PREFIX}chat_files (
    id              VARCHAR(36) PRIMARY KEY,
    conversation_id VARCHAR(36) NOT NULL REFERENCES {CHAT_SCHEMA_Q}{PREFIX}chat_conversations(id),
    message_id      VARCHAR(36),
    filename        VARCHAR(500) NOT NULL,
    mime_type       VARCHAR(200) NOT NULL,
    file_size       INTEGER NOT NULL CONSTRAINT check_chat_files_file_size_positive CHECK (file_size > 0),
    file_data       BYTEA NOT NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
)
WITH (appendonly=false)
DISTRIBUTED BY (id);

CREATE INDEX idx_{PREFIX}chat_files_conversation
    ON {CHAT_SCHEMA_Q}{PREFIX}chat_files(conversation_id);

-- ============================================================================
-- BUS-ТАБЛИЦА КАНАЛА К ВНЕШНЕМУ АГЕНТУ (nanobot)
-- ============================================================================

-- «Провод» между AW и агентом. Таблицу на проде создаёт и ВЛАДЕЕТ ею сторона
-- агента — блок ниже лишь dev-имитация её фактической структуры. Типы
-- uuid/text/timestamptz — как у владельца (наша конвенция VARCHAR(36) здесь
-- сознательно не применяется, чтобы dev ловил те же type-ошибки, что и прод).
-- Имя таблицы — плейсхолдер {BUS_TABLE} (= CHAT__AGENT_CHANNEL__TABLE_NAME),
-- БЕЗ {PREFIX}: app-префикс к шине не клеится, имя задаётся настройкой целиком.
-- id = uid одного сообщения шины (его же хранит chat_messages.agent_ref);
-- chat_id = uid треда (= chat_messages.conversation_id). Отдельной колонки
-- conversation_id в шине НЕТ. reply_to агент проставляет НА СТРОКЕ-ОТВЕТЕ —
-- ссылка на id вопроса. PRIMARY KEY отсутствует (фактическая ПРОМ-таблица
-- без PK) — DISTRIBUTED BY задаём явно. CHECK'и по role/status зеркалят
-- подтверждённую спеку владельца (у него DEFAULT'ы тоже есть, но AW на них
-- не полагается и передаёт status/created_at/updated_at явно).
-- Словарь NanoBot 2.3: role — user | assistant | system | tool;
-- status — pending | processing | completed | error | failed, где 'error'
-- ПОВТОРЯЕМАЯ ошибка (агент вернёт вопрос в пул и переобработает его, удалив
-- свою строку-ответ), а терминален только 'failed'.
-- Директива адаптеру: таблица внешняя — если она уже существует (создана
-- владельцем), её «спутники» (CREATE INDEX / COMMENT ON) пропускаются.
-- @external-table: {BUS_SCHEMA_Q}{BUS_TABLE}
CREATE TABLE IF NOT EXISTS {BUS_SCHEMA_Q}{BUS_TABLE} (
    id          UUID,
    chat_id     TEXT,
    user_id     TEXT,
    role        TEXT NOT NULL
                CONSTRAINT check_chat_agent_messages_bus_role_values
                CHECK (role IN ('user','assistant','system','tool')),
    content     TEXT NOT NULL,
    media       JSONB,
    metadata    JSONB,
    reply_to    UUID,
    buttons     JSONB,
    status      TEXT NOT NULL
                CONSTRAINT check_chat_agent_messages_bus_status_values
                CHECK (status IN ('pending','processing','completed','failed','error')),
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at  TIMESTAMP WITH TIME ZONE NOT NULL
)
WITH (appendonly=false)
DISTRIBUTED BY (chat_id);

CREATE INDEX idx_{BUS_TABLE}_id
    ON {BUS_SCHEMA_Q}{BUS_TABLE}(id);

-- ============================================================================
-- МЕТРИКИ ВЫПОЛНЕНИЯ CHATTOOL'ОВ
-- ============================================================================

-- Sequence для id метрик; BIGSERIAL недоступен в GP-схеме PK + DISTRIBUTED.
-- Адаптер ловит DuplicateObjectError при повторном CREATE.
CREATE SEQUENCE {CHAT_SCHEMA_Q}{PREFIX}chat_tool_metrics_id_seq;

-- Append-only журнал latency/status/ошибок tool-вызовов. conversation_id
-- хранится как VARCHAR(36) БЕЗ FK — метрики переживают удаление беседы.
CREATE TABLE IF NOT EXISTS {CHAT_SCHEMA_Q}{PREFIX}chat_tool_metrics (
    id              BIGINT NOT NULL
                    DEFAULT nextval('{CHAT_SCHEMA_Q}{PREFIX}chat_tool_metrics_id_seq'),
    tool_name       VARCHAR(128) NOT NULL,
    status          VARCHAR(32) NOT NULL
                    CONSTRAINT check_chat_tool_metrics_status_values
                    CHECK (status IN ('success','error','validation_error')),
    latency_ms      INTEGER NOT NULL
                    CONSTRAINT check_chat_tool_metrics_latency_nonneg
                    CHECK (latency_ms >= 0),
    username        VARCHAR(64),
    conversation_id VARCHAR(36),
    error_message   TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
)
WITH (appendonly=false)
DISTRIBUTED BY (id);

CREATE INDEX idx_{PREFIX}chat_tool_metrics_tool_created
    ON {CHAT_SCHEMA_Q}{PREFIX}chat_tool_metrics(tool_name, created_at);
CREATE INDEX idx_{PREFIX}chat_tool_metrics_status_created
    ON {CHAT_SCHEMA_Q}{PREFIX}chat_tool_metrics(status, created_at);

-- ============================================================================
-- AUDIT-ЛОГ ЖИЗНЕННОГО ЦИКЛА БЕСЕДЫ
-- ============================================================================

-- Sequence для id audit-записей.
CREATE SEQUENCE {CHAT_SCHEMA_Q}{PREFIX}chat_audit_log_id_seq;

-- Append-only журнал действий пользователей. Пишется глушащим сервисом:
-- сбой записи не должен ломать основную операцию (см. AuditService).
-- conversation_id хранится как VARCHAR(36) БЕЗ FK — записи о DELETE
-- беседы остаются после её удаления (forensic-trail).
CREATE TABLE IF NOT EXISTS {CHAT_SCHEMA_Q}{PREFIX}chat_audit_log (
    id              BIGINT NOT NULL
                    DEFAULT nextval('{CHAT_SCHEMA_Q}{PREFIX}chat_audit_log_id_seq'),
    username        VARCHAR(64) NOT NULL,
    action          VARCHAR(64) NOT NULL,
    conversation_id VARCHAR(36),
    details_json    JSONB,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
)
WITH (appendonly=false)
DISTRIBUTED BY (id);

CREATE INDEX idx_{PREFIX}chat_audit_log_username_created
    ON {CHAT_SCHEMA_Q}{PREFIX}chat_audit_log(username, created_at);
CREATE INDEX idx_{PREFIX}chat_audit_log_action_created
    ON {CHAT_SCHEMA_Q}{PREFIX}chat_audit_log(action, created_at);
CREATE INDEX idx_{PREFIX}chat_audit_log_conversation_created
    ON {CHAT_SCHEMA_Q}{PREFIX}chat_audit_log(conversation_id, created_at);

-- ============================================================================
-- ОБРАТНАЯ СВЯЗЬ ПО СООБЩЕНИЯМ АССИСТЕНТА (ЛАЙК/ДИЗЛАЙК)
-- ============================================================================

-- Идемпотентна по паре (message_id, user_id): одна активная оценка пользователя
-- на сообщение. Составной PK (message_id, user_id) служит ключом идемпотентности
-- (UPSERT = read-modify-write в транзакции; upsert-синтаксис в GP 6.x недоступен).
-- DISTRIBUTED BY (message_id) ⊆ PK — co-location по сообщению, message_id ведущий
-- (lookup WHERE message_id=$1 по PK-индексу). БЕЗ FK на chat_messages — оценка
-- переживает удаление беседы. reasons — JSONB-массив кодов причин дизлайка
-- (валидируется в сервисе).
CREATE TABLE IF NOT EXISTS {CHAT_SCHEMA_Q}{PREFIX}chat_message_feedback (
    conversation_id VARCHAR(36) NOT NULL,
    message_id      VARCHAR(36) NOT NULL,
    user_id         VARCHAR(50) NOT NULL,
    rating          VARCHAR(8) NOT NULL
                    CONSTRAINT check_chat_message_feedback_rating_values
                    CHECK (rating IN ('up','down')),
    reasons         JSONB,
    comment         TEXT,
    source          VARCHAR(16) NOT NULL DEFAULT 'user'
                    CONSTRAINT check_chat_message_feedback_source_values
                    CHECK (source IN ('user','auto','llm')),
    route_type      VARCHAR(16),
    agent_mode      VARCHAR(16),
    model           VARCHAR(100),
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, user_id)
)
WITH (appendonly=false)
DISTRIBUTED BY (message_id);

CREATE INDEX idx_{PREFIX}chat_message_feedback_conversation
    ON {CHAT_SCHEMA_Q}{PREFIX}chat_message_feedback(conversation_id);
CREATE INDEX idx_{PREFIX}chat_message_feedback_rating_created
    ON {CHAT_SCHEMA_Q}{PREFIX}chat_message_feedback(rating, created_at);
CREATE INDEX idx_{PREFIX}chat_message_feedback_user_created
    ON {CHAT_SCHEMA_Q}{PREFIX}chat_message_feedback(user_id, created_at);
