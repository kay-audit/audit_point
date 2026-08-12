-- Схема базы данных для Audit Workstation (PostgreSQL)
-- Использует те же плейсхолдеры {SCHEMA}.{PREFIX}, что и GP-вариант:
-- адаптер подменяет {SCHEMA}. на "" и {PREFIX} на DATABASE__TABLE_PREFIX.

-- ============================================================================
-- ОСНОВНАЯ ТАБЛИЦА АКТОВ
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}acts (
    id BIGSERIAL PRIMARY KEY,

    -- Номер КМ и части
    km_number VARCHAR(50) NOT NULL,
    km_number_digit INTEGER NOT NULL,
    part_number INTEGER NOT NULL DEFAULT 1,
    total_parts INTEGER NOT NULL DEFAULT 1,

    -- Основные метаданные
    inspection_name TEXT NOT NULL,
    city VARCHAR(255) NOT NULL,
    created_date DATE,
    order_number VARCHAR(100) NOT NULL,
    order_date DATE NOT NULL,
    is_process_based BOOLEAN DEFAULT TRUE,
    inspection_start_date DATE NOT NULL,
    inspection_end_date DATE NOT NULL,

    -- Служебная записка
    service_note VARCHAR(100),
    service_note_date DATE,

    -- Служебные флаги для валидации
    needs_created_date BOOLEAN DEFAULT FALSE,
    needs_directive_number BOOLEAN DEFAULT FALSE,
    needs_invoice_check BOOLEAN DEFAULT FALSE,
    needs_service_note BOOLEAN DEFAULT FALSE,

    -- Состояние структурной валидации содержимого (вычисляется при сохранении)
    validation_status VARCHAR(20) NOT NULL DEFAULT 'ok'
        CONSTRAINT check_acts_validation_status_values
        CHECK (validation_status IN ('ok', 'warning', 'error')),
    validation_issues JSONB,

    -- Идентификатор аудита из внешнего сервиса
    audit_act_id VARCHAR(36),

    -- Системные поля
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(50) NOT NULL,
    last_edited_by VARCHAR(50),
    last_edited_at TIMESTAMP,

    -- Constraints
    CONSTRAINT check_km_number_format
        CHECK (km_number ~ '^КМ-\d{2}-\d{5}$'),

    CONSTRAINT check_km_number_digit_length
        CHECK (length(km_number_digit::text) = 7),

    CONSTRAINT check_service_note_format
        CHECK (
            service_note IS NULL OR
            service_note ~ '^.+/\d{4}$'
        ),

    CONSTRAINT check_part_number_positive
        CHECK (part_number > 0),

    CONSTRAINT check_total_parts_positive
        CHECK (total_parts > 0),

    CONSTRAINT check_inspection_dates
        CHECK (inspection_end_date >= inspection_start_date),

    CONSTRAINT check_service_note_consistency
        CHECK (
            (service_note IS NULL AND service_note_date IS NULL) OR
            (service_note IS NOT NULL AND service_note_date IS NOT NULL)
        ),

    -- Уникальность по паре (km_number_digit, part_number)
    UNIQUE(km_number_digit, part_number)
);

COMMENT ON TABLE {SCHEMA}.{PREFIX}acts IS 'Основная таблица актов проверки с метаданными';

-- ============================================================================
-- ТАБЛИЦА АУДИТОРСКОЙ ГРУППЫ
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}audit_team_members (
    id BIGSERIAL PRIMARY KEY,
    act_id INTEGER NOT NULL REFERENCES {SCHEMA}.{PREFIX}acts(id) ON DELETE CASCADE,
    audit_act_id VARCHAR(36),
    role VARCHAR(50) NOT NULL CONSTRAINT check_audit_team_role_values CHECK (role IN ('Куратор', 'Руководитель', 'Редактор', 'Участник', 'AppendixRef')),
    full_name VARCHAR(255) NOT NULL,
    position VARCHAR(255) NOT NULL,
    username VARCHAR(50) NOT NULL,
    order_index INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT check_order_index_non_negative
        CHECK (order_index >= 0)
);

COMMENT ON TABLE {SCHEMA}.{PREFIX}audit_team_members IS 'Состав аудиторской группы для каждого акта';

-- ============================================================================
-- ТАБЛИЦА ПОРУЧЕНИЙ
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}act_directives (
    id BIGSERIAL PRIMARY KEY,
    act_id INTEGER NOT NULL REFERENCES {SCHEMA}.{PREFIX}acts(id) ON DELETE CASCADE,
    audit_act_id VARCHAR(36),
    audit_point_id VARCHAR(36),
    point_number VARCHAR(50) NOT NULL,
    node_id VARCHAR(100),
    directive_number VARCHAR(100) NOT NULL,
    order_index INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT check_point_number_format
        CHECK (point_number ~ '^5\.([\d]+\.)*[\d]+$'),

    CONSTRAINT check_order_index_non_negative
        CHECK (order_index >= 0)
);

COMMENT ON TABLE {SCHEMA}.{PREFIX}act_directives IS 'Действующие поручения, относящиеся к акту';

-- ============================================================================
-- ТАБЛИЦА СТРУКТУРЫ ДЕРЕВА АКТА
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}act_tree (
    id BIGSERIAL PRIMARY KEY,
    act_id INTEGER UNIQUE NOT NULL REFERENCES {SCHEMA}.{PREFIX}acts(id) ON DELETE CASCADE,
    tree_data JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT check_tree_data_not_empty
        CHECK (jsonb_typeof(tree_data) = 'object')
);

COMMENT ON TABLE {SCHEMA}.{PREFIX}act_tree IS 'Иерархическая структура акта в формате JSONB дерева';

-- ============================================================================
-- ТАБЛИЦА ТАБЛИЦ (ДЕНОРМАЛИЗОВАННАЯ)
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}act_tables (
    id BIGSERIAL PRIMARY KEY,
    act_id INTEGER NOT NULL REFERENCES {SCHEMA}.{PREFIX}acts(id) ON DELETE CASCADE,
    audit_act_id VARCHAR(36),
    audit_point_id VARCHAR(36),
    table_id VARCHAR(100) NOT NULL,
    node_id VARCHAR(100) NOT NULL,
    node_number VARCHAR(50),
    table_label TEXT,
    grid_data JSONB NOT NULL,
    col_widths JSONB NOT NULL,
    is_protected BOOLEAN DEFAULT FALSE,
    is_deletable BOOLEAN DEFAULT TRUE,
    -- Подвид таблицы (enum). Значения синхронизируются вручную с
    -- TABLE_KINDS (app/domains/acts/schemas/act_content.py) и фронтом
    -- (static/js/constructor/table/table-kind.js).
    kind VARCHAR(20) DEFAULT 'regular' NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT check_grid_data_is_array
        CHECK (jsonb_typeof(grid_data) = 'array'),

    CONSTRAINT check_col_widths_is_array
        CHECK (jsonb_typeof(col_widths) = 'array'),

    CONSTRAINT check_table_kind_values
        CHECK (kind IN ('regular', 'metrics', 'mainMetrics', 'regularRisk',
                        'operationalRisk', 'taxRisk', 'otherRisk')),

    UNIQUE(act_id, table_id),
    -- Не более одной активной таблицы на узел дерева.
    UNIQUE(act_id, node_id)
);

COMMENT ON TABLE {SCHEMA}.{PREFIX}act_tables IS 'Таблицы внутри актов (денормализованное хранение для быстрого доступа)';

-- ============================================================================
-- ТАБЛИЦА ТЕКСТОВЫХ БЛОКОВ
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}act_textblocks (
    id BIGSERIAL PRIMARY KEY,
    act_id INTEGER NOT NULL REFERENCES {SCHEMA}.{PREFIX}acts(id) ON DELETE CASCADE,
    audit_act_id VARCHAR(36),
    audit_point_id VARCHAR(36),
    textblock_id VARCHAR(100) NOT NULL,
    node_id VARCHAR(100) NOT NULL,
    node_number VARCHAR(50),
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(act_id, textblock_id)
);

COMMENT ON TABLE {SCHEMA}.{PREFIX}act_textblocks IS 'Текстовые блоки с форматированием внутри актов';

-- ============================================================================
-- ТАБЛИЦА НАРУШЕНИЙ
-- ============================================================================

-- Блочная модель: каждое полевое поле — JSONB-контейнер {enabled, blocks};
-- состав и порядок полевых колонок == реестр VIOLATION_FIELD_COLUMNS
-- (app/domains/acts/violation_fields.py, страж —
-- tests/domains/acts/test_violation_schema_columns_guard.py);
-- field_order — пользовательский порядок полей (JSONB-массив ключей или NULL).
CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}act_violations (
    id BIGSERIAL PRIMARY KEY,
    act_id INTEGER NOT NULL REFERENCES {SCHEMA}.{PREFIX}acts(id) ON DELETE CASCADE,
    audit_act_id VARCHAR(36),
    audit_point_id VARCHAR(36),
    violation_id VARCHAR(100) NOT NULL,
    node_id VARCHAR(100) NOT NULL,
    node_number VARCHAR(50),
    violated JSONB,
    established JSONB,
    description JSONB,
    code_mining JSONB,
    process_mining JSONB,
    additional_content JSONB,
    reasons JSONB,
    measures JSONB,
    consequences JSONB,
    responsible JSONB,
    field_order JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Проверяем только тип (object|null), как в GP-схеме: оператор '?' на GP
    -- недоступен, а форму {enabled, blocks} гарантирует Pydantic
    -- (ViolationFieldSchema). «Прод = контракт» — dev не строже прода.
    CONSTRAINT check_violated_is_object_or_null
        CHECK (violated IS NULL OR jsonb_typeof(violated) = 'object'),

    CONSTRAINT check_established_is_object_or_null
        CHECK (established IS NULL OR jsonb_typeof(established) = 'object'),

    CONSTRAINT check_description_is_object_or_null
        CHECK (description IS NULL OR jsonb_typeof(description) = 'object'),

    CONSTRAINT check_code_mining_is_object_or_null
        CHECK (code_mining IS NULL OR jsonb_typeof(code_mining) = 'object'),

    CONSTRAINT check_process_mining_is_object_or_null
        CHECK (process_mining IS NULL OR jsonb_typeof(process_mining) = 'object'),

    CONSTRAINT check_additional_content_is_object_or_null
        CHECK (additional_content IS NULL OR jsonb_typeof(additional_content) = 'object'),

    CONSTRAINT check_reasons_is_object_or_null
        CHECK (reasons IS NULL OR jsonb_typeof(reasons) = 'object'),

    CONSTRAINT check_measures_is_object_or_null
        CHECK (measures IS NULL OR jsonb_typeof(measures) = 'object'),

    CONSTRAINT check_consequences_is_object_or_null
        CHECK (consequences IS NULL OR jsonb_typeof(consequences) = 'object'),

    CONSTRAINT check_responsible_is_object_or_null
        CHECK (responsible IS NULL OR jsonb_typeof(responsible) = 'object'),

    CONSTRAINT check_field_order_is_array_or_null
        CHECK (field_order IS NULL OR jsonb_typeof(field_order) = 'array'),

    UNIQUE(act_id, violation_id)
);

COMMENT ON TABLE {SCHEMA}.{PREFIX}act_violations IS 'Нарушения, выявленные в ходе проверки';

-- ============================================================================
-- ТАБЛИЦА ФАКТУР
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}act_invoices (
    id BIGSERIAL PRIMARY KEY,
    act_id INTEGER NOT NULL REFERENCES {SCHEMA}.{PREFIX}acts(id) ON DELETE CASCADE,
    audit_act_id VARCHAR(36),
    audit_point_id VARCHAR(36),
    node_id VARCHAR(100) NOT NULL,
    node_number VARCHAR(50),
    db_type VARCHAR(20) NOT NULL CONSTRAINT check_act_invoices_db_type_values CHECK (db_type IN ('hive', 'greenplum')),
    schema_name VARCHAR(255) NOT NULL,
    table_name VARCHAR(255) NOT NULL,
    metrics JSONB NOT NULL DEFAULT '[]',
    process JSONB DEFAULT NULL,
    profile_div TEXT DEFAULT NULL,
    verification_status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CONSTRAINT check_act_invoices_verification_status_values
        CHECK (verification_status IN ('pending', 'verified', 'rejected')),

    CONSTRAINT check_metrics_is_array
        CHECK (jsonb_typeof(metrics) = 'array'),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(50) NOT NULL,
    etl_loading_id BIGINT DEFAULT NULL,
    create_date DATE DEFAULT NULL,

    UNIQUE(act_id, node_id)
);

COMMENT ON TABLE {SCHEMA}.{PREFIX}act_invoices IS 'Фактуры, прикрепленные к пунктам акта';

-- ============================================================================
-- РЕЕСТР HIVE-ТАБЛИЦ (для локального тестирования)
-- ============================================================================

CREATE TABLE IF NOT EXISTS {REF_HADOOP_TABLES} (
    id BIGSERIAL PRIMARY KEY,
    table_name VARCHAR(255) NOT NULL UNIQUE
);

COMMENT ON TABLE {REF_HADOOP_TABLES} IS 'Реестр hive-таблиц (реплика для фактур)';

-- Заполняем тестовыми данными (аналог текущего HIVE_MOCK_TABLES)
INSERT INTO {REF_HADOOP_TABLES} (table_name) VALUES
    ('t_audit_invoices_main'),
    ('t_audit_invoices_details'),
    ('t_audit_invoices_summary'),
    ('t_audit_metrics_ks'),
    ('t_audit_metrics_fr'),
    ('t_audit_metrics_or'),
    ('t_audit_risk_regular'),
    ('t_audit_risk_operational'),
    ('t_audit_fact_data'),
    ('t_audit_fact_aggregated')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- ТАБЛИЦА АУДИТ-ЛОГА
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}audit_log (
    id BIGSERIAL PRIMARY KEY,
    act_id INTEGER,
    action VARCHAR(50) NOT NULL,
    username VARCHAR(50) NOT NULL,
    details JSONB DEFAULT '{}',
    changelog JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE {SCHEMA}.{PREFIX}audit_log IS 'Лог чувствительных операций для compliance';

-- ============================================================================
-- ТАБЛИЦА ВЕРСИЙ СОДЕРЖИМОГО
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}act_content_versions (
    id BIGSERIAL PRIMARY KEY,
    act_id INTEGER NOT NULL REFERENCES {SCHEMA}.{PREFIX}acts(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    save_type VARCHAR(20) NOT NULL DEFAULT 'auto',
    username VARCHAR(50) NOT NULL,
    tree_data JSONB NOT NULL,
    tables_data JSONB NOT NULL DEFAULT '{}',
    textblocks_data JSONB NOT NULL DEFAULT '{}',
    violations_data JSONB NOT NULL DEFAULT '{}',
    invoices_data JSONB NOT NULL DEFAULT '{}',
    content_hash VARCHAR(64),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (act_id, version_number)
);

COMMENT ON TABLE {SCHEMA}.{PREFIX}act_content_versions IS 'Снэпшоты содержимого актов для просмотра истории и восстановления';

-- ============================================================================
-- ТАБЛИЦА ТЕЛЕМЕТРИИ ЗДОРОВЬЯ РЕДАКТОРА (§6.8)
-- ============================================================================
-- Минимальная наблюдаемость самовосстановлений редактора: фронт копит счётчики
-- событий (self-heal observer'а, починки капсул, ошибки сохранения, пустой
-- paste) и батчами шлёт их сюда. Read-API нет — данные смотрим SQL'ем.

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}act_editor_telemetry (
    id VARCHAR(36) PRIMARY KEY,
    act_id INTEGER NOT NULL,
    username VARCHAR(50) NOT NULL,
    event_type VARCHAR(32) NOT NULL
        CONSTRAINT check_editor_telemetry_event_type_values
        CHECK (event_type IN ('observer_heal', 'capsule_repair', 'dup_id_fix',
                              'save_failure', 'empty_paste', 'word_paste')),
    event_count INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE {SCHEMA}.{PREFIX}act_editor_telemetry IS 'Счётчики событий здоровья редактора актов (self-heal, починки капсул, ошибки сохранения)';

-- ============================================================================
-- ИНДЕКСЫ ДЛЯ ОПТИМИЗАЦИИ ЗАПРОСОВ
-- ============================================================================

-- Индексы на acts
CREATE INDEX IF NOT EXISTS idx_{PREFIX}acts_km_digit
    ON {SCHEMA}.{PREFIX}acts(km_number_digit);

CREATE INDEX IF NOT EXISTS idx_{PREFIX}acts_km_digit_part
    ON {SCHEMA}.{PREFIX}acts(km_number_digit, part_number);

CREATE INDEX IF NOT EXISTS idx_{PREFIX}acts_service_note
    ON {SCHEMA}.{PREFIX}acts(service_note)
    WHERE service_note IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_{PREFIX}acts_service_note_date
    ON {SCHEMA}.{PREFIX}acts(service_note_date)
    WHERE service_note_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_{PREFIX}acts_created_by
    ON {SCHEMA}.{PREFIX}acts(created_by);

CREATE INDEX IF NOT EXISTS idx_{PREFIX}acts_last_edited_at
    ON {SCHEMA}.{PREFIX}acts(last_edited_at DESC NULLS LAST);

-- Индексы на audit_team_members
CREATE INDEX IF NOT EXISTS idx_{PREFIX}audit_team_username
    ON {SCHEMA}.{PREFIX}audit_team_members(username);

CREATE INDEX IF NOT EXISTS idx_{PREFIX}audit_team_act_id
    ON {SCHEMA}.{PREFIX}audit_team_members(act_id);

CREATE INDEX IF NOT EXISTS idx_{PREFIX}audit_team_act_order
    ON {SCHEMA}.{PREFIX}audit_team_members(act_id, order_index);

-- Индексы на act_directives
CREATE INDEX IF NOT EXISTS idx_{PREFIX}act_directives_act_id
    ON {SCHEMA}.{PREFIX}act_directives(act_id);

CREATE INDEX IF NOT EXISTS idx_{PREFIX}act_directives_act_order
    ON {SCHEMA}.{PREFIX}act_directives(act_id, order_index);

-- Индексы на act_tables
CREATE INDEX IF NOT EXISTS idx_{PREFIX}act_tables_act_id
    ON {SCHEMA}.{PREFIX}act_tables(act_id);

CREATE INDEX IF NOT EXISTS idx_{PREFIX}act_tables_node_number
    ON {SCHEMA}.{PREFIX}act_tables(act_id, node_number)
    WHERE node_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_{PREFIX}act_tables_label
    ON {SCHEMA}.{PREFIX}act_tables(act_id, table_label)
    WHERE table_label IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_{PREFIX}act_tables_special_kind
    ON {SCHEMA}.{PREFIX}act_tables(act_id)
    WHERE kind <> 'regular';

-- Индексы на act_textblocks
CREATE INDEX IF NOT EXISTS idx_{PREFIX}act_textblocks_act_id
    ON {SCHEMA}.{PREFIX}act_textblocks(act_id);

CREATE INDEX IF NOT EXISTS idx_{PREFIX}act_textblocks_node_number
    ON {SCHEMA}.{PREFIX}act_textblocks(act_id, node_number)
    WHERE node_number IS NOT NULL;

-- Индексы на act_violations
CREATE INDEX IF NOT EXISTS idx_{PREFIX}act_violations_act_id
    ON {SCHEMA}.{PREFIX}act_violations(act_id);

CREATE INDEX IF NOT EXISTS idx_{PREFIX}act_violations_node_number
    ON {SCHEMA}.{PREFIX}act_violations(act_id, node_number)
    WHERE node_number IS NOT NULL;

-- Индексы на act_invoices
CREATE INDEX IF NOT EXISTS idx_{PREFIX}act_invoices_act_id
    ON {SCHEMA}.{PREFIX}act_invoices(act_id);

CREATE INDEX IF NOT EXISTS idx_{PREFIX}act_invoices_node
    ON {SCHEMA}.{PREFIX}act_invoices(act_id, node_id);

-- Индексы на audit_act_id
CREATE INDEX IF NOT EXISTS idx_{PREFIX}acts_audit_act_id
    ON {SCHEMA}.{PREFIX}acts(audit_act_id)
    WHERE audit_act_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_{PREFIX}audit_team_audit_act_id
    ON {SCHEMA}.{PREFIX}audit_team_members(audit_act_id)
    WHERE audit_act_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_{PREFIX}act_directives_audit_act_id
    ON {SCHEMA}.{PREFIX}act_directives(audit_act_id)
    WHERE audit_act_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_{PREFIX}act_tables_audit_act_id
    ON {SCHEMA}.{PREFIX}act_tables(audit_act_id)
    WHERE audit_act_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_{PREFIX}act_textblocks_audit_act_id
    ON {SCHEMA}.{PREFIX}act_textblocks(audit_act_id)
    WHERE audit_act_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_{PREFIX}act_violations_audit_act_id
    ON {SCHEMA}.{PREFIX}act_violations(audit_act_id)
    WHERE audit_act_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_{PREFIX}act_invoices_audit_act_id
    ON {SCHEMA}.{PREFIX}act_invoices(audit_act_id)
    WHERE audit_act_id IS NOT NULL;

-- Индексы на audit_log
CREATE INDEX IF NOT EXISTS idx_{PREFIX}audit_log_act_id
    ON {SCHEMA}.{PREFIX}audit_log(act_id)
    WHERE act_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_{PREFIX}audit_log_username
    ON {SCHEMA}.{PREFIX}audit_log(username);

CREATE INDEX IF NOT EXISTS idx_{PREFIX}audit_log_action
    ON {SCHEMA}.{PREFIX}audit_log(action);

CREATE INDEX IF NOT EXISTS idx_{PREFIX}audit_log_created_at
    ON {SCHEMA}.{PREFIX}audit_log(created_at);

CREATE INDEX IF NOT EXISTS idx_{PREFIX}audit_log_act_created
    ON {SCHEMA}.{PREFIX}audit_log(act_id, created_at DESC)
    WHERE act_id IS NOT NULL;

-- Индексы на act_content_versions
CREATE INDEX IF NOT EXISTS idx_{PREFIX}act_content_versions_act
    ON {SCHEMA}.{PREFIX}act_content_versions(act_id, version_number DESC);

-- GIN индексы на JSONB для полнотекстового поиска
CREATE INDEX IF NOT EXISTS idx_{PREFIX}act_tree_data
    ON {SCHEMA}.{PREFIX}act_tree USING GIN(tree_data);

CREATE INDEX IF NOT EXISTS idx_{PREFIX}act_tables_grid_data
    ON {SCHEMA}.{PREFIX}act_tables USING GIN(grid_data);

CREATE INDEX IF NOT EXISTS idx_{PREFIX}violations_content
    ON {SCHEMA}.{PREFIX}act_violations USING GIN(
        violated, established, description, code_mining, process_mining,
        additional_content, reasons, measures, consequences, responsible
    );

-- ============================================================================
-- updated_at — устанавливается явным SET updated_at = CURRENT_TIMESTAMP в коде
-- ============================================================================
-- Поведение синхронизировано с GP-схемой: PL/pgSQL-триггер не нужен, обновление
-- метки времени делается явно в SQL-запросах репозиториев (act_content.py,
-- act_crud.py, act_lock.py, act_invoice.py, act_crud_service._build_update_query).
