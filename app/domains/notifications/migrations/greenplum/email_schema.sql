-- Схема базы данных для домена центра уведомлений (Greenplum)
-- Выполните эти запросы в Greenplum для создания таблиц email

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_{PREFIX}email_templates_name
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

CREATE INDEX IF NOT EXISTS idx_{PREFIX}email_queue_status
    ON {SCHEMA}.{PREFIX}email_queue(status);
CREATE INDEX IF NOT EXISTS idx_{PREFIX}email_queue_created
    ON {SCHEMA}.{PREFIX}email_queue(created_at);
