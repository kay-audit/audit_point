-- Схема базы данных для домена центра уведомлений (PostgreSQL)
-- Плейсхолдеры {SCHEMA}.{PREFIX} — те же, что в остальных доменах:
-- адаптер подменяет {SCHEMA}. на "" и {PREFIX} на DATABASE__TABLE_PREFIX.
-- FK не используем (паритет PG/GP, как в chat-домене). UUID-id — VARCHAR(36),
-- генерится в Python.

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
);

CREATE INDEX IF NOT EXISTS idx_{PREFIX}notifications_recipient_created
    ON {SCHEMA}.{PREFIX}notifications(recipient_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_{PREFIX}notifications_created
    ON {SCHEMA}.{PREFIX}notifications(created_at DESC);

-- ============================================================================
-- СОСТОЯНИЕ УВЕДОМЛЕНИЙ ПО ПОЛЬЗОВАТЕЛЮ
-- ============================================================================

-- Создаётся лениво при первом read/dismiss. Отсутствие строки = не прочитано
-- и не скрыто. Это корректно покрывает broadcast для будущих пользователей.
CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}notification_state (
    notification_id VARCHAR(36) NOT NULL,
    user_id         VARCHAR(50) NOT NULL,
    is_read         BOOLEAN NOT NULL DEFAULT FALSE,
    is_dismissed    BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (notification_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_{PREFIX}notification_state_user
    ON {SCHEMA}.{PREFIX}notification_state(user_id);

-- ============================================================================
-- ШАБЛОНЫ EMAIL
-- ============================================================================

-- Таблица для хранения шаблонов email-сообщений
CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}email_templates (
    id              VARCHAR(255) PRIMARY KEY,
    name            VARCHAR(100) NOT NULL UNIQUE,
    subject         TEXT NOT NULL,
    body_html       TEXT NOT NULL,
    body_text       TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- ОЧЕРЕДЬ ОТПРАВКИ EMAIL (ОПЦИОНАЛЬНО)
-- ============================================================================

-- Таблица для асинхронной отправки email (если потребуется в будущем)
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
