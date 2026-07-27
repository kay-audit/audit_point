-- Схема базы данных для домена администрирования (Greenplum)
-- Схема: {SCHEMA}
-- Префикс таблиц: {PREFIX}
-- Примечание: таблица t_db_oarb_ua_user уже существует в GP, НЕ создаём её.
-- Однако в неё добавлены поля tb/is_deleted/deleted_at/deleted_by (идемпотентно
-- через блок DO c information_schema) — см. внизу файла.

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
    SELECT 'Администратор'::varchar AS name, NULL::varchar AS domain_name, 'Полный доступ ко всем доменам и функциям'::text AS description
    UNION ALL SELECT 'Цифровой акт', 'acts', 'Доступ к домену актов'
    UNION ALL SELECT 'ЦК финансовый результат', 'ck_fin_res', 'Доступ к ЦК Фин.Рез.'
    UNION ALL SELECT 'ЦК клиентский опыт', 'ck_client_exp', 'Доступ к ЦК Клиентский опыт'
    UNION ALL SELECT 'ЦК Code Mining', 'ck_code_mining', 'Доступ к ЦК Code Mining'
    UNION ALL SELECT 'ЦК Process Mining', 'ck_process_mining', 'Доступ к ЦК Process Mining'
    UNION ALL SELECT 'Чат-ассистент', 'chat', 'Доступ к AI-чату'
    UNION ALL SELECT 'SQL-агент', 'sqlagent', 'Доступ к SQL-агенту'
) AS s
WHERE NOT EXISTS (
    SELECT 1 FROM {SCHEMA}.{PREFIX}roles r WHERE r.name = s.name
);

-- Миграция: роль «Админ» → «Администратор».
--
-- Идемпотентно (выполняется на каждом старте). Три исходных состояния:
--
-- (A) Только «Админ» существует, «Администратор» нет:
--     Переименовываем (тот же role_id, user_roles-связи продолжают работать).
--
-- (B) Обе роли существуют (INSERT выше уже добавил «Администратор» с новым id,
--     UPDATE выше не отработал из-за NOT EXISTS):
--     Копируем user_roles-связи из «Админ» в «Администратор» (без дублей)
--     и удаляем старую роль.
--
-- (C) Только «Администратор» существует (новая инсталляция): ничего не делаем.
DO $$
DECLARE
    v_admin_id BIGINT;
    v_administrator_id BIGINT;
BEGIN
    -- Случай (A): переименовать «Админ» в «Администратор», сохранив id.
    IF NOT EXISTS (
        SELECT 1 FROM {SCHEMA}.{PREFIX}roles WHERE name = 'Администратор'
    ) AND EXISTS (
        SELECT 1 FROM {SCHEMA}.{PREFIX}roles WHERE name = 'Админ'
    ) THEN
        UPDATE {SCHEMA}.{PREFIX}roles
        SET name = 'Администратор',
            description = 'Полный доступ ко всем доменам и функциям'
        WHERE name = 'Админ';
        RETURN;
    END IF;

    -- Случай (B): обе роли существуют. Копируем связи и удаляем старую.
    SELECT id INTO v_administrator_id
    FROM {SCHEMA}.{PREFIX}roles WHERE name = 'Администратор' LIMIT 1;
    SELECT id INTO v_admin_id
    FROM {SCHEMA}.{PREFIX}roles WHERE name = 'Админ' LIMIT 1;

    IF v_admin_id IS NOT NULL AND v_administrator_id IS NOT NULL THEN
        INSERT INTO {SCHEMA}.{PREFIX}user_roles (username, role_id, assigned_by)
        SELECT ur.username, v_administrator_id, ur.assigned_by
        FROM {SCHEMA}.{PREFIX}user_roles ur
        WHERE ur.role_id = v_admin_id
        ON CONFLICT (username, role_id) DO NOTHING;
        DELETE FROM {SCHEMA}.{PREFIX}roles WHERE id = v_admin_id;
    END IF;
END $$;

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

-- ============================================================================
-- МЕТАДАННЫЕ ПОЛЬЗОВАТЕЛЯ (tb, is_deleted) В {REF_USER_TABLE}
-- ============================================================================
--
-- В Greenplum (PG 9.4) форма ALTER TABLE с условным добавлением колонки
-- (IF NOT EXISTS) не поддерживается — синтаксис появился только в PG 9.6+.
-- Делаем идемпотентные добавления через DO-блок с проверкой
-- information_schema.columns. Адаптер миграций проглатывает ошибки
-- дублирования, но эта форма явная и безопасная: если колонка уже есть —
-- DO-блок просто пропускает изменение.
--
-- {REF_USER_TABLE} подставляется в qualified-форме (myschema.t_db_oarb_ua_user
-- для GP или просто t_db_oarb_ua_user для PG). Парсим split_part'ом: если
-- точка есть — schema = часть до точки, table = часть после; иначе берём
-- текущую схему подключения и table = вся строка.

DO $$
DECLARE
    v_schema TEXT;
    v_table TEXT;
BEGIN
    IF position('.' in '{REF_USER_TABLE}') > 0 THEN
        v_schema := split_part('{REF_USER_TABLE}', '.', 1);
        v_table := split_part('{REF_USER_TABLE}', '.', 2);
    ELSE
        v_schema := current_schema();
        v_table := '{REF_USER_TABLE}';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = v_schema
          AND table_name = v_table
          AND column_name = 'tb'
    ) THEN
        ALTER TABLE {REF_USER_TABLE}
            ADD COLUMN tb VARCHAR(16) NOT NULL DEFAULT '';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = v_schema
          AND table_name = v_table
          AND column_name = 'is_deleted'
    ) THEN
        ALTER TABLE {REF_USER_TABLE}
            ADD COLUMN is_deleted BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = v_schema
          AND table_name = v_table
          AND column_name = 'deleted_at'
    ) THEN
        ALTER TABLE {REF_USER_TABLE}
            ADD COLUMN deleted_at TIMESTAMP;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = v_schema
          AND table_name = v_table
          AND column_name = 'deleted_by'
    ) THEN
        ALTER TABLE {REF_USER_TABLE}
            ADD COLUMN deleted_by VARCHAR(50) NOT NULL DEFAULT '';
    END IF;
END $$;

-- ============================================================================
-- Идемпотентная миграция: добавление отдельных ролей для Агентов.
--
-- До этой миграции все агенты (ИОР, CRM, Документы, Источники данных,
-- BackLog команд, Follow UP) разделяли одну общую роль «SQL-агент».
-- Админ-панель не могла отдельно управлять доступом к каждому агенту.
-- Эти роли имеют уникальный domain_name (sqlagent_xxx / chat_assistant),
-- чтобы sidebar мог разграничивать доступ через chat_domains в NavItem.
--
-- Идемпотентно: используется NOT EXISTS-фильтр на имени (GP не позволяет
-- UNIQUE(name) как часть PK, но name-уникальность обеспечивается приложением
-- и защитой от дублей в DO-блоке). Повторное выполнение безопасно.
-- ============================================================================

DO $$
BEGIN
    INSERT INTO {SCHEMA}.{PREFIX}roles (name, domain_name, description)
    SELECT s.name, s.domain_name, s.description
    FROM (
        SELECT 'ИОР'::varchar AS name, 'sqlagent_ior'::varchar AS domain_name,
               'Доступ к агенту «ИОР» (анализ отклонений)'::text AS description
        UNION ALL SELECT 'CRM', 'sqlagent_crm', 'Доступ к агенту «CRM» (анализ клиентской базы)'
        UNION ALL SELECT 'Документы', 'sqlagent_docs', 'Доступ к агенту «Документы» (анализ SberDocs)'
        UNION ALL SELECT 'Источники данных', 'sqlagent_sources', 'Доступ к агенту «Источники данных» (метаданные)'
        UNION ALL SELECT 'BackLog команд', 'sqlagent_jira', 'Доступ к агенту «BackLog команд» (Jira/Confluence)'
        UNION ALL SELECT 'Follow UP', 'sqlagent_followup', 'Доступ к агенту «Follow UP» (контроль задач)'
        UNION ALL SELECT 'AI-ассистент', 'chat_assistant', 'Доступ к боковой панели AI-ассистента'
    ) AS s
    WHERE NOT EXISTS (
        SELECT 1 FROM {SCHEMA}.{PREFIX}roles r WHERE r.name = s.name
    );
END $$;
