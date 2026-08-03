-- Схема базы данных для домена администрирования (Greenplum)
-- Схема: {SCHEMA}
-- Префикс таблиц: {PREFIX}
-- Примечание: таблица t_db_oarb_ua_user уже существует в GP, НЕ создаём её

-- ============================================================================
-- ТАБЛИЦА РОЛЕЙ
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}roles (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    domain_name VARCHAR(100),
    description TEXT NOT NULL DEFAULT ''
)
WITH (appendonly=false)
DISTRIBUTED BY (id);

-- UNIQUE(name) обеспечивается на уровне приложения (GP: distribution key должен быть в UNIQUE)

COMMENT ON TABLE {SCHEMA}.{PREFIX}roles IS 'Справочник ролей приложения';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}roles.id IS 'Уникальный идентификатор роли';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}roles.name IS 'Уникальное имя роли';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}roles.domain_name IS 'Домен, к которому относится роль (NULL = глобальная)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}roles.description IS 'Описание роли';

-- Заполняем ролями по умолчанию (идемпотентно по name: при добавлении
-- новой сидовой роли в обновлении приложения — она прорастёт без
-- пересоздания таблицы; существующие имена не дублируются).
INSERT INTO {SCHEMA}.{PREFIX}roles (name, domain_name, description)
SELECT s.name, s.domain_name, s.description
FROM (
    SELECT 'Админ'::varchar AS name, NULL::varchar AS domain_name, 'Полный доступ ко всем доменам и функциям'::text AS description
    UNION ALL SELECT 'Цифровой акт', 'acts', 'Доступ к домену актов'
    UNION ALL SELECT 'ЦК финансовый результат', 'ck_fin_res', 'Доступ к ЦК Фин.Рез.'
    UNION ALL SELECT 'ЦК клиентский опыт', 'ck_client_exp', 'Доступ к ЦК Клиентский опыт'
    UNION ALL SELECT 'Чат-ассистент', 'chat', 'Доступ к AI-чату'
    UNION ALL SELECT 'SQL-агент', 'sqlagent', 'Доступ к SQL-агенту'
) AS s
WHERE NOT EXISTS (
    SELECT 1 FROM {SCHEMA}.{PREFIX}roles r WHERE r.name = s.name
);

-- ============================================================================
-- ТАБЛИЦА СВЯЗЕЙ ПОЛЬЗОВАТЕЛЬ — РОЛЬ
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}user_roles (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(50) NOT NULL,
    role_id BIGINT NOT NULL,
    assigned_by VARCHAR(50) NOT NULL,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
WITH (appendonly=false)
DISTRIBUTED BY (id);

-- UNIQUE(username, role_id) обеспечивается на уровне приложения (GP: distribution key должен быть в UNIQUE)

COMMENT ON TABLE {SCHEMA}.{PREFIX}user_roles IS 'Связь пользователей с ролями';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}user_roles.username IS 'Числовой логин пользователя';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}user_roles.role_id IS 'Ссылка на роль';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}user_roles.assigned_by IS 'Кто назначил роль';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}user_roles.assigned_at IS 'Дата и время назначения роли';

-- ============================================================================
-- ИНДЕКСЫ
-- Примечание: CREATE INDEX без IF NOT EXISTS — GP 6.x (PG 9.4) не поддерживает
-- IF NOT EXISTS для индексов. Обработка дублей — на уровне адаптера.
-- ============================================================================

CREATE INDEX idx_{PREFIX}user_roles_username
    ON {SCHEMA}.{PREFIX}user_roles(username);

CREATE INDEX idx_{PREFIX}user_roles_role_id
    ON {SCHEMA}.{PREFIX}user_roles(role_id);

CREATE INDEX idx_{PREFIX}roles_domain_name
    ON {SCHEMA}.{PREFIX}roles(domain_name)
    WHERE domain_name IS NOT NULL;

-- ============================================================================
-- ТАБЛИЦА АУДИТ-ЛОГА АДМИНИСТРИРОВАНИЯ
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}admin_audit_log (
    id BIGSERIAL PRIMARY KEY,
    action VARCHAR(50) NOT NULL,
    target_username VARCHAR(50) NOT NULL,
    admin_username VARCHAR(50) NOT NULL,
    role_id BIGINT,
    role_name VARCHAR(100) NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
WITH (appendonly=false)
DISTRIBUTED BY (id);

COMMENT ON TABLE {SCHEMA}.{PREFIX}admin_audit_log IS 'Аудит-лог операций администрирования ролей';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}admin_audit_log.action IS 'Тип операции (assign_role, remove_role)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}admin_audit_log.target_username IS 'Пользователь, над которым выполнена операция';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}admin_audit_log.admin_username IS 'Администратор, выполнивший операцию';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}admin_audit_log.role_id IS 'ID роли';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}admin_audit_log.role_name IS 'Имя роли (денормализовано)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}admin_audit_log.details IS 'Дополнительная информация';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}admin_audit_log.created_at IS 'Дата и время операции';

CREATE INDEX idx_{PREFIX}admin_audit_log_target
    ON {SCHEMA}.{PREFIX}admin_audit_log(target_username);

CREATE INDEX idx_{PREFIX}admin_audit_log_created
    ON {SCHEMA}.{PREFIX}admin_audit_log(created_at DESC);

-- ============================================================================
-- ТАБЛИЦА SINGLETON-БЛОКИРОВКИ ИНСТАНСА ПРИЛОЖЕНИЯ
-- Гарантирует, что в закрытой сети без Redis/etcd работает ровно один
-- uvicorn-воркер с приложением. См. app/main.py lifespan startup.
-- GP-нюанс: distribution key должен входить в PRIMARY KEY, что выполняется
-- автоматически (service_name — единственный PK).
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}app_singleton_lock (
    service_name VARCHAR(64) PRIMARY KEY,
    pid INTEGER NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    host VARCHAR(255) NOT NULL DEFAULT ''
)
WITH (appendonly=false)
DISTRIBUTED BY (service_name);

COMMENT ON TABLE {SCHEMA}.{PREFIX}app_singleton_lock IS 'Блокировка singleton-инстанса приложения (защита от запуска второго воркера)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}app_singleton_lock.service_name IS 'Имя сервиса (например, audit_workstation)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}app_singleton_lock.pid IS 'PID процесса-владельца блокировки';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}app_singleton_lock.started_at IS 'Время захвата блокировки (UTC)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}app_singleton_lock.host IS 'Имя хоста процесса-владельца';

-- ============================================================================
-- HTTP-МЕТРИКИ ЗАПРОСОВ
-- ============================================================================

-- Sequence для id метрик; BIGSERIAL недоступен в GP-схеме PK + DISTRIBUTED.
-- Адаптер ловит DuplicateObjectError при повторном CREATE.
CREATE SEQUENCE {SCHEMA}.{PREFIX}admin_http_metrics_id_seq;

-- Append-only журнал HTTP-запросов: method/path/status/latency/username/request_id.
-- Используется для наблюдаемости (медленные эндпоинты, спайки 5xx, активность
-- пользователей). Запись делается опциональным middleware'ом и проглатывает
-- исключения, чтобы сбой метрики не ломал основной запрос.
CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}admin_http_metrics (
    id          BIGINT NOT NULL
                DEFAULT nextval('{SCHEMA}.{PREFIX}admin_http_metrics_id_seq'),
    method      VARCHAR(8) NOT NULL,
    path        VARCHAR(512) NOT NULL,
    status_code SMALLINT NOT NULL,
    latency_ms  INTEGER NOT NULL,
    username    VARCHAR(64),
    request_id  VARCHAR(64),
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
)
WITH (appendonly=false)
DISTRIBUTED BY (id);

COMMENT ON TABLE {SCHEMA}.{PREFIX}admin_http_metrics IS 'HTTP-метрики запросов: latency / status / пользователь';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}admin_http_metrics.method IS 'HTTP-метод (GET, POST, ...)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}admin_http_metrics.path IS 'Путь запроса без query string';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}admin_http_metrics.status_code IS 'HTTP-статус ответа';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}admin_http_metrics.latency_ms IS 'Длительность обработки запроса (мс)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}admin_http_metrics.username IS 'Username (может быть NULL для unauthenticated)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}admin_http_metrics.request_id IS 'Идентификатор запроса из RequestIdMiddleware';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}admin_http_metrics.created_at IS 'Время записи метрики';

CREATE INDEX idx_{PREFIX}admin_http_metrics_path_created
    ON {SCHEMA}.{PREFIX}admin_http_metrics(path, created_at);
CREATE INDEX idx_{PREFIX}admin_http_metrics_status_created
    ON {SCHEMA}.{PREFIX}admin_http_metrics(status_code, created_at);
CREATE INDEX idx_{PREFIX}admin_http_metrics_username_created
    ON {SCHEMA}.{PREFIX}admin_http_metrics(username, created_at);

-- ============================================================================
-- ФОТО ПРОФИЛЯ ПОЛЬЗОВАТЕЛЯ
-- ============================================================================

-- Справочник пользователей t_db_oarb_ua_user наполняется ETL и доступен
-- приложению только на чтение, поэтому фото хранится отдельной таблицей.
-- Одна строка на пользователя: изображение уже нормализовано (квадрат JPEG),
-- версии не храним. updated_at служит и версией для кеша браузера (?v=).
-- distribution key = user_id: он же PRIMARY KEY, все обращения идут по нему.
CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}user_avatars (
    user_id    VARCHAR(64) PRIMARY KEY,
    image      BYTEA NOT NULL,
    mime       VARCHAR(32) NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
)
WITH (appendonly=false)
DISTRIBUTED BY (user_id);

COMMENT ON TABLE {SCHEMA}.{PREFIX}user_avatars IS 'Фото профиля пользователя (загружает сам пользователь)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}user_avatars.user_id IS 'Логин пользователя — владелец фото';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}user_avatars.image IS 'Изображение после нормализации (квадрат 256x256, JPEG)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}user_avatars.mime IS 'MIME-тип сохранённого изображения';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}user_avatars.updated_at IS 'Время последней загрузки; она же версия для cache-busting';

-- ============================================================================
-- АУДИТ-ЛОГ ОТКАЗОВ ДОСТУПА К ДОМЕНАМ
-- ============================================================================

-- Append-only журнал случаев, когда require_domain_access вернул 403. Нужен
-- для observability в закрытой сети: разбор инцидентов «у меня перестало
-- работать», поиск подозрительной активности. Запись делается через батчер,
-- чтобы 403-ответ не задерживался на ожидании INSERT.
-- Sequence создаётся отдельно: BIGSERIAL не совместим с PK+DISTRIBUTED BY (id).
-- Адаптер ловит DuplicateObjectError при повторном CREATE.
CREATE SEQUENCE {SCHEMA}.{PREFIX}access_denied_audit_id_seq;

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}access_denied_audit (
    id         BIGINT NOT NULL
               DEFAULT nextval('{SCHEMA}.{PREFIX}access_denied_audit_id_seq'),
    username   VARCHAR(64) NOT NULL,
    domain     VARCHAR(64) NOT NULL,
    path       TEXT NOT NULL,
    method     VARCHAR(8) NOT NULL,
    reason     TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
)
WITH (appendonly=false)
DISTRIBUTED BY (id);

COMMENT ON TABLE {SCHEMA}.{PREFIX}access_denied_audit IS 'Аудит-лог отказов доступа к доменам (require_domain_access → 403)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}access_denied_audit.username IS 'Пользователь, которому отказано в доступе';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}access_denied_audit.domain IS 'Запрошенный домен (acts, chat, ck_fin_res, ...)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}access_denied_audit.path IS 'HTTP-путь запроса';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}access_denied_audit.method IS 'HTTP-метод запроса';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}access_denied_audit.reason IS 'Краткое описание причины отказа';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}access_denied_audit.created_at IS 'Время отказа';

CREATE INDEX idx_{PREFIX}access_denied_audit_username
    ON {SCHEMA}.{PREFIX}access_denied_audit(username, created_at DESC);

CREATE INDEX idx_{PREFIX}access_denied_audit_domain
    ON {SCHEMA}.{PREFIX}access_denied_audit(domain, created_at DESC);
