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
