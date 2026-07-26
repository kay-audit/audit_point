-- Схема auth-домена: учётные данные пользователей и серверные сессии.
-- {PREFIX} = DATABASE__TABLE_PREFIX (например, t_db_oarb_audit_act_).

CREATE TABLE IF NOT EXISTS {PREFIX}auth_credentials (
    username VARCHAR(50) PRIMARY KEY,
    password_hash VARCHAR(255) NOT NULL,
    password_recovery BYTEA,
    avatar BYTEA,
    avatar_mime VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);

COMMENT ON TABLE {PREFIX}auth_credentials IS 'Учётные данные пользователей (хеш + Fernet-encrypted для собственного просмотра)';
COMMENT ON COLUMN {PREFIX}auth_credentials.username IS 'Логин пользователя (= t_db_oarb_ua_user.username)';
COMMENT ON COLUMN {PREFIX}auth_credentials.password_hash IS 'Bcrypt-хеш для верификации при логине';
COMMENT ON COLUMN {PREFIX}auth_credentials.password_recovery IS 'Fernet-encrypted пароль (только владелец может расшифровать через свой профиль)';
COMMENT ON COLUMN {PREFIX}auth_credentials.avatar IS 'Бинарные данные аватарки';
COMMENT ON COLUMN {PREFIX}auth_credentials.avatar_mime IS 'MIME-тип аватарки (image/png, image/jpeg, image/webp)';
COMMENT ON COLUMN {PREFIX}auth_credentials.last_login_at IS 'Время последнего успешного логина';

CREATE TABLE IF NOT EXISTS {PREFIX}auth_sessions (
    token VARCHAR(64) PRIMARY KEY,
    username VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE {PREFIX}auth_sessions IS 'Серверные сессии (cookie → username)';
COMMENT ON COLUMN {PREFIX}auth_sessions.token IS 'Сессионный токен из cookie';
COMMENT ON COLUMN {PREFIX}auth_sessions.expires_at IS 'Время истечения сессии (TTL из настроек)';

CREATE INDEX IF NOT EXISTS idx_{PREFIX}auth_sessions_username ON {PREFIX}auth_sessions(username);
CREATE INDEX IF NOT EXISTS idx_{PREFIX}auth_sessions_expires_at ON {PREFIX}auth_sessions(expires_at);
