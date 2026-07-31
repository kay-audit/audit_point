-- Схема базы данных для домена центра уведомлений (PostgreSQL)
-- Выполните эти запросы в PostgreSQL для создания таблиц email

-- ============================================================================
-- ШАБЛОНЫ EMAIL
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}email_templates (
    id              VARCHAR(255) PRIMARY KEY,
    name            VARCHAR(100) NOT NULL UNIQUE,
    subject         TEXT NOT NULL,
    body_html       TEXT NOT NULL,
    body_text       TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_{PREFIX}email_templates_name
    ON {SCHEMA}.{PREFIX}email_templates(name);

-- ============================================================================
-- ОЧЕРЕДЬ ОТПРАВКИ EMAIL (ОПЦИОНАЛЬНО)
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}email_queue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    to_email        VARCHAR(255) NOT NULL,
    template_id     VARCHAR(255) REFERENCES {SCHEMA}.{PREFIX}email_templates(id),
    subject         VARCHAR(500),
    body_html       TEXT,
    body_text       TEXT,
    cc              TEXT[],
    attachments     JSONB,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'failed')),
    error_message   TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at         TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_{PREFIX}email_queue_status
    ON {SCHEMA}.{PREFIX}email_queue(status);
CREATE INDEX IF NOT EXISTS idx_{PREFIX}email_queue_created
    ON {SCHEMA}.{PREFIX}email_queue(created_at);
