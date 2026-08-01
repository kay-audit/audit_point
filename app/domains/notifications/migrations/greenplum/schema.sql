-- Схема базы данных для домена центра уведомлений (Greenplum)
-- Плейсхолдеры {SCHEMA}.{PREFIX} — адаптер подставляет реальные значения.
-- GP 6.x = PostgreSQL 9.4: CREATE INDEX без IF NOT EXISTS (дубли глотает
-- адаптер), WITH (appendonly=false), DISTRIBUTED BY ⊆ PRIMARY KEY.
-- FK не используем. UUID-id — VARCHAR(36), генерится в Python.

-- ============================================================================
-- ТАБЛИЦА УВЕДОМЛЕНИЙ
-- ============================================================================

-- recipient_user_id IS NULL = broadcast (всем). source — ключ источника
-- (manual/acts/chat; tables — живой, НЕ персистится). link — proxy-safe
-- относительный путь (NULL = без перехода).
CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}notifications (
    id                VARCHAR(36) PRIMARY KEY,
    recipient_user_id VARCHAR(50),
    source            VARCHAR(100) NOT NULL,
    severity          VARCHAR(20) NOT NULL DEFAULT 'info'
                      CONSTRAINT check_notifications_severity
                      CHECK (severity IN ('info','success','warning','error')),
    title             VARCHAR(300) NOT NULL,
    body              TEXT,
    link              VARCHAR(1000),
    element_ref       VARCHAR(200),
    created_by        VARCHAR(50),
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
)
WITH (appendonly=false)
DISTRIBUTED BY (id);

CREATE INDEX idx_{PREFIX}notifications_recipient_created
    ON {SCHEMA}.{PREFIX}notifications(recipient_user_id, created_at DESC);
CREATE INDEX idx_{PREFIX}notifications_created
    ON {SCHEMA}.{PREFIX}notifications(created_at DESC);

-- ============================================================================
-- СОСТОЯНИЕ УВЕДОМЛЕНИЙ ПО ПОЛЬЗОВАТЕЛЮ
-- ============================================================================

-- Создаётся лениво при первом read/dismiss. Отсутствие строки = не прочитано
-- и не скрыто. DISTRIBUTED BY (notification_id) ⊆ PK (notification_id, user_id)
-- — co-location с notifications по id для join.
CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}notification_state (
    notification_id VARCHAR(36) NOT NULL,
    user_id         VARCHAR(50) NOT NULL,
    is_read         BOOLEAN NOT NULL DEFAULT FALSE,
    is_dismissed    BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (notification_id, user_id)
)
WITH (appendonly=false)
DISTRIBUTED BY (notification_id);

CREATE INDEX idx_{PREFIX}notification_state_user
    ON {SCHEMA}.{PREFIX}notification_state(user_id);

-- ============================================================================
-- ШАБЛОНЫ EMAIL
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}email_templates (
    id              VARCHAR(255) PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    subject         TEXT NOT NULL,
    body_html       TEXT NOT NULL,
    body_text       TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
)
WITH (appendonly=false)
DISTRIBUTED BY (id);

CREATE UNIQUE INDEX idx_{PREFIX}email_templates_name
    ON {SCHEMA}.{PREFIX}email_templates(name);

-- ============================================================================
-- ОЧЕРЕДЬ ОТПРАВКИ EMAIL (ОПЦИОНАЛЬНО)
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}email_queue (
    id              VARCHAR(36) PRIMARY KEY,
    to_email        VARCHAR(255) NOT NULL,
    template_id     VARCHAR(255),
    subject         VARCHAR(500),
    body_html       TEXT,
    body_text       TEXT,
    cc              TEXT,
    attachments     TEXT,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'failed')),
    error_message   TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at         TIMESTAMP
)
WITH (appendonly=false)
DISTRIBUTED BY (id);

CREATE INDEX idx_{PREFIX}email_queue_status
    ON {SCHEMA}.{PREFIX}email_queue(status);
CREATE INDEX idx_{PREFIX}email_queue_created
    ON {SCHEMA}.{PREFIX}email_queue(created_at);
