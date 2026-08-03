-- Схема базы данных для Audit Workstation (Greenplum)
-- Схема: {SCHEMA}
-- Префикс таблиц: {PREFIX}

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
    CONSTRAINT check_part_number_positive
        CHECK (part_number > 0),
    CONSTRAINT check_total_parts_positive
        CHECK (total_parts > 0),
    CONSTRAINT check_inspection_dates
        CHECK (inspection_end_date >= inspection_start_date),
    CONSTRAINT check_service_note_format
        CHECK (service_note IS NULL OR service_note ~ '^.+/\d{4}$'),
    CONSTRAINT check_service_note_consistency
        CHECK ((service_note IS NULL AND service_note_date IS NULL) OR
               (service_note IS NOT NULL AND service_note_date IS NOT NULL))
)
WITH (appendonly=false)
DISTRIBUTED BY (id);

-- UNIQUE(km_number_digit, part_number) обеспечивается на уровне приложения
COMMENT ON TABLE {SCHEMA}.{PREFIX}acts IS
    'Основная таблица актов проверки. '
    'UNIQUE(km_number_digit, part_number) обеспечивается на уровне приложения ';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.id IS 'Уникальный идентификатор акта';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.km_number IS 'КМ номер в формате КМ-XX-XXXXX для отображения (НЕ меняется при добавлении СЗ)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.km_number_digit IS 'КМ номер только цифры (всегда 7 цифр) для быстрого поиска';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.part_number IS 'Номер части акта (1,2,3... для актов без СЗ или 4 цифры из СЗ для актов с СЗ)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.total_parts IS 'Общее количество частей акта (актов с данным КМ)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.inspection_name IS 'Наименование проверки';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.city IS 'Город проведения проверки';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.created_date IS 'Дата составления акта (опционально)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.order_number IS 'Номер приказа о проверке';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.order_date IS 'Дата приказа о проверке';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.is_process_based IS 'Флаг: является ли проверка процессной';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.inspection_start_date IS 'Дата начала проверки';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.inspection_end_date IS 'Дата окончания проверки';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.service_note IS 'Номер служебной записки в формате Текст/XXXX';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.service_note_date IS 'Дата служебной записки';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.needs_created_date IS 'Флаг валидации: требуется ли дата составления';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.needs_directive_number IS 'Флаг валидации: требуется ли номер поручения';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.needs_invoice_check IS 'Флаг валидации: требуется ли проверка фактуры';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.needs_service_note IS 'Флаг валидации: требуется ли информация по служебной записке';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.validation_status IS 'Состояние структурной валидации содержимого: ok / warning / error';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.validation_issues IS 'Список конкретных замечаний валидации (JSON), вычисляется при сохранении';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.created_at IS 'Дата и время создания записи';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.updated_at IS 'Дата и время последнего обновления метаданных';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.created_by IS 'Числовой логин пользователя-создателя';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.last_edited_by IS 'Числовой логин последнего редактора содержимого';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}acts.last_edited_at IS 'Дата и время последнего редактирования содержимого';

-- ============================================================================
-- ТАБЛИЦА АУДИТОРСКОЙ ГРУППЫ
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}audit_team_members (
    id BIGSERIAL NOT NULL,
    act_id BIGINT NOT NULL REFERENCES {SCHEMA}.{PREFIX}acts(id),
    audit_act_id VARCHAR(36),
    role VARCHAR(50) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    position VARCHAR(255) NOT NULL,
    username VARCHAR(50) NOT NULL,
    order_index INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Constraints
    PRIMARY KEY (act_id, id),
    CONSTRAINT check_audit_team_role_values
        CHECK (role IN ('Куратор', 'Руководитель', 'Редактор', 'Участник', 'AppendixRef')),
    CONSTRAINT check_order_index_non_negative
        CHECK (order_index >= 0)
)
WITH (appendonly=false)
DISTRIBUTED BY (act_id);

COMMENT ON TABLE {SCHEMA}.{PREFIX}audit_team_members IS 'Состав аудиторской группы для каждого акта';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}audit_team_members.id IS 'Уникальный идентификатор записи';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}audit_team_members.act_id IS 'Ссылка на акт';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}audit_team_members.role IS 'Роль члена группы: Куратор, Руководитель, Редактор или Участник';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}audit_team_members.full_name IS 'Полное имя члена группы (ФИО)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}audit_team_members.position IS 'Должность члена группы';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}audit_team_members.username IS 'Числовой логин пользователя в системе';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}audit_team_members.order_index IS 'Порядок отображения члена группы (для сортировки)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}audit_team_members.created_at IS 'Дата и время добавления в группу';

-- ============================================================================
-- ТАБЛИЦА ПОРУЧЕНИЙ
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}act_directives (
    id BIGSERIAL NOT NULL,
    act_id BIGINT NOT NULL REFERENCES {SCHEMA}.{PREFIX}acts(id),
    audit_act_id VARCHAR(36),
    audit_point_id VARCHAR(36),
    point_number VARCHAR(50) NOT NULL,
    node_id VARCHAR(100),
    directive_number VARCHAR(100) NOT NULL,
    order_index INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Constraints
    PRIMARY KEY (act_id, id),
    CONSTRAINT check_point_number_format
        CHECK (point_number ~ '^5\.([\d]+\.)*[\d]+$'),
    CONSTRAINT check_order_index_non_negative
        CHECK (order_index >= 0)
)
WITH (appendonly=false)
DISTRIBUTED BY (act_id);

COMMENT ON TABLE {SCHEMA}.{PREFIX}act_directives IS 'Действующие поручения, относящиеся к акту';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_directives.id IS 'Уникальный идентификатор поручения';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_directives.act_id IS 'Ссылка на акт';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_directives.point_number IS 'Номер пункта в акте (формат: 5.X или 5.X.Y или 5.X.Y.Z и т.д.)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_directives.node_id IS 'ID узла в дереве для синхронизации point_number';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_directives.directive_number IS 'Номер действующего поручения';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_directives.order_index IS 'Порядок отображения поручения (для сортировки)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_directives.created_at IS 'Дата и время создания записи';

-- ============================================================================
-- ТАБЛИЦА СТРУКТУРЫ ДЕРЕВА АКТА
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}act_tree (
    id BIGSERIAL NOT NULL,
    act_id BIGINT NOT NULL REFERENCES {SCHEMA}.{PREFIX}acts(id),
    tree_data JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Constraints
    PRIMARY KEY (act_id, id),
    CONSTRAINT check_tree_data_not_empty
        CHECK (jsonb_typeof(tree_data) = 'object'),

    UNIQUE(act_id)
)
WITH (appendonly=false)
DISTRIBUTED BY (act_id);

COMMENT ON TABLE {SCHEMA}.{PREFIX}act_tree IS 'Иерархическая структура акта в формате JSONB дерева';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_tree.id IS 'Уникальный идентификатор записи';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_tree.act_id IS 'Ссылка на акт (один акт = одно дерево)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_tree.tree_data IS 'JSONB структура дерева с узлами, метками и детьми';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_tree.created_at IS 'Дата и время создания дерева';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_tree.updated_at IS 'Дата и время последнего изменения структуры';

-- ============================================================================
-- ТАБЛИЦА ТАБЛИЦ (ДЕНОРМАЛИЗОВАННАЯ)
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}act_tables (
    id BIGSERIAL NOT NULL,
    act_id BIGINT NOT NULL REFERENCES {SCHEMA}.{PREFIX}acts(id),
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

    -- Constraints
    PRIMARY KEY (act_id, id),
    CONSTRAINT check_grid_data_is_array
        CHECK (jsonb_typeof(grid_data) = 'array'),
    CONSTRAINT check_col_widths_is_array
        CHECK (jsonb_typeof(col_widths) = 'array'),
    CONSTRAINT check_table_kind_values
        CHECK (kind IN ('regular', 'metrics', 'mainMetrics', 'regularRisk',
                        'operationalRisk', 'taxRisk', 'otherRisk')),

    UNIQUE(act_id, table_id),
    -- Не более одной активной таблицы на узел дерева.
    -- DISTRIBUTED BY (act_id) ⊆ {act_id, node_id} — правило подмножества соблюдено.
    UNIQUE(act_id, node_id)
)
WITH (appendonly=false)
DISTRIBUTED BY (act_id);

COMMENT ON TABLE {SCHEMA}.{PREFIX}act_tables IS 'Таблицы внутри актов (денормализованное хранение для быстрого доступа)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_tables.id IS 'Уникальный идентификатор записи';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_tables.act_id IS 'Ссылка на акт';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_tables.table_id IS 'Уникальный ID таблицы внутри акта';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_tables.node_id IS 'ID узла в дереве, к которому привязана таблица';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_tables.node_number IS 'Номер узла (например, 3.2.1) для аналитики';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_tables.table_label IS 'Название таблицы для поиска и навигации';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_tables.grid_data IS 'JSONB массив строк и ячеек таблицы';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_tables.col_widths IS 'JSONB массив ширин колонок в пикселях';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_tables.is_protected IS 'Флаг: защищена ли таблица от редактирования';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_tables.is_deletable IS 'Флаг: можно ли удалить таблицу';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_tables.kind IS 'Подвид таблицы: regular / metrics / mainMetrics / regularRisk / operationalRisk / taxRisk / otherRisk';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_tables.created_at IS 'Дата и время создания таблицы';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_tables.updated_at IS 'Дата и время последнего изменения таблицы';

-- ============================================================================
-- ТАБЛИЦА ТЕКСТОВЫХ БЛОКОВ
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}act_textblocks (
    id BIGSERIAL NOT NULL,
    act_id BIGINT NOT NULL REFERENCES {SCHEMA}.{PREFIX}acts(id),
    audit_act_id VARCHAR(36),
    audit_point_id VARCHAR(36),
    textblock_id VARCHAR(100) NOT NULL,
    node_id VARCHAR(100) NOT NULL,
    node_number VARCHAR(50),
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Constraints
    PRIMARY KEY (act_id, id),

    UNIQUE(act_id, textblock_id)
)
WITH (appendonly=false)
DISTRIBUTED BY (act_id);

COMMENT ON TABLE {SCHEMA}.{PREFIX}act_textblocks IS 'Текстовые блоки с форматированием внутри актов';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_textblocks.id IS 'Уникальный идентификатор записи';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_textblocks.act_id IS 'Ссылка на акт';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_textblocks.textblock_id IS 'Уникальный ID текстового блока внутри акта';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_textblocks.node_id IS 'ID узла в дереве, к которому привязан блок';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_textblocks.node_number IS 'Номер узла (например, 2.1) для аналитики';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_textblocks.content IS 'Текстовое содержимое блока (inline-HTML с форматированием)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_textblocks.created_at IS 'Дата и время создания блока';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_textblocks.updated_at IS 'Дата и время последнего изменения блока';

-- ============================================================================
-- ТАБЛИЦА НАРУШЕНИЙ
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}act_violations (
    id BIGSERIAL NOT NULL,
    act_id BIGINT NOT NULL REFERENCES {SCHEMA}.{PREFIX}acts(id),
    audit_act_id VARCHAR(36),
    audit_point_id VARCHAR(36),
    violation_id VARCHAR(100) NOT NULL,
    node_id VARCHAR(100) NOT NULL,
    node_number VARCHAR(50),
    violated TEXT,
    established TEXT,
    description_list JSONB,
    additional_content JSONB,
    reasons JSONB,
    measures JSONB,
    consequences JSONB,
    responsible JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Constraints (GP 5.x не поддерживает оператор '?' для JSONB, проверяем только тип)
    PRIMARY KEY (act_id, id),
    CONSTRAINT check_description_list_is_object_or_null
        CHECK (description_list IS NULL OR jsonb_typeof(description_list) = 'object'),
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

    UNIQUE(act_id, violation_id)
)
WITH (appendonly=false)
DISTRIBUTED BY (act_id);

COMMENT ON TABLE {SCHEMA}.{PREFIX}act_violations IS 'Нарушения, выявленные в ходе проверки';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_violations.id IS 'Уникальный идентификатор записи';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_violations.act_id IS 'Ссылка на акт';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_violations.violation_id IS 'Уникальный ID нарушения внутри акта';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_violations.node_id IS 'ID узла в дереве, к которому привязано нарушение';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_violations.node_number IS 'Номер узла (например, 5.1.3) для аналитики';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_violations.violated IS 'Что нарушено (нормативная база)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_violations.established IS 'Что установлено (факты нарушения)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_violations.description_list IS 'JSONB объект с полями enabled и items для списка описаний';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_violations.additional_content IS 'JSONB объект с полями enabled и items для дополнительного содержимого';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_violations.reasons IS 'JSONB объект с полями enabled и content для причин нарушения';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_violations.measures IS 'JSONB объект с полями enabled и content для принятых мер';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_violations.consequences IS 'JSONB объект с полями enabled и content для последствий нарушения';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_violations.responsible IS 'JSONB объект с полями enabled и content для ответственных лиц';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_violations.created_at IS 'Дата и время создания записи о нарушении';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_violations.updated_at IS 'Дата и время последнего изменения записи';

-- ============================================================================
-- ТАБЛИЦА ФАКТУР
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}act_invoices (
    id BIGSERIAL NOT NULL,
    act_id BIGINT NOT NULL REFERENCES {SCHEMA}.{PREFIX}acts(id),
    audit_act_id VARCHAR(36),
    audit_point_id VARCHAR(36),
    node_id VARCHAR(100) NOT NULL,
    node_number VARCHAR(50),
    db_type VARCHAR(20) NOT NULL,
    schema_name VARCHAR(255) NOT NULL,
    table_name VARCHAR(255) NOT NULL,
    metrics JSONB NOT NULL DEFAULT '[]',
    process JSONB DEFAULT NULL,
    profile_div TEXT DEFAULT NULL,
    verification_status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(50) NOT NULL,
    etl_loading_id BIGINT DEFAULT NULL,
    create_date DATE DEFAULT NULL,

    -- Constraints
    PRIMARY KEY (act_id, id),
    CONSTRAINT check_db_type_values
        CHECK (db_type IN ('hive', 'greenplum')),
    CONSTRAINT check_verification_status_values
        CHECK (verification_status IN ('pending', 'verified', 'rejected')),
    CONSTRAINT check_metrics_is_array
        CHECK (jsonb_typeof(metrics) = 'array'),

    UNIQUE(act_id, node_id)
)
WITH (appendonly=false)
DISTRIBUTED BY (act_id);

COMMENT ON TABLE {SCHEMA}.{PREFIX}act_invoices IS 'Фактуры, прикрепленные к пунктам акта';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_invoices.id IS 'Уникальный идентификатор записи';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_invoices.act_id IS 'Ссылка на акт';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_invoices.node_id IS 'ID узла в дереве, к которому привязана фактура';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_invoices.node_number IS 'Номер узла (например, 5.1.3) для аналитики';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_invoices.db_type IS 'Тип базы данных: hive или greenplum';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_invoices.schema_name IS 'Имя схемы в базе данных';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_invoices.table_name IS 'Имя таблицы в базе данных';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_invoices.metrics IS 'JSONB массив метрик [{metric_type, metric_code, metric_name}, ...] (до 5 элементов)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_invoices.verification_status IS 'Статус верификации: pending, verified, rejected';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_invoices.created_at IS 'Дата и время создания записи';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_invoices.updated_at IS 'Дата и время последнего обновления';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_invoices.created_by IS 'Числовой логин пользователя-создателя';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_invoices.process IS 'JSONB массив процессов [{"process_code": "П6152"}, ...]';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_invoices.profile_div IS 'Подразделение профиля';

-- ============================================================================
-- ТАБЛИЦА АУДИТ-ЛОГА
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}audit_log (
    id BIGSERIAL PRIMARY KEY,
    act_id BIGINT,
    action VARCHAR(50) NOT NULL,
    username VARCHAR(50) NOT NULL,
    details JSONB DEFAULT '{}',
    changelog JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
WITH (appendonly=false)
DISTRIBUTED BY (id);

COMMENT ON TABLE {SCHEMA}.{PREFIX}audit_log IS 'Лог чувствительных операций для compliance';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}audit_log.act_id IS 'ID акта (NULL для системных событий)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}audit_log.action IS 'Тип операции: create, update, delete, duplicate, lock, unlock';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}audit_log.username IS 'Пользователь, выполнивший операцию';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}audit_log.details IS 'JSONB с деталями операции';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}audit_log.changelog IS 'JSONB массив гранулярных изменений из конструктора';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}audit_log.created_at IS 'Время операции';

-- ============================================================================
-- ТАБЛИЦА ВЕРСИЙ СОДЕРЖИМОГО
-- ============================================================================

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}act_content_versions (
    id BIGSERIAL NOT NULL,
    act_id BIGINT NOT NULL REFERENCES {SCHEMA}.{PREFIX}acts(id),
    version_number BIGINT NOT NULL,
    save_type VARCHAR(20) NOT NULL DEFAULT 'auto',
    username VARCHAR(50) NOT NULL,
    tree_data JSONB NOT NULL,
    tables_data JSONB NOT NULL DEFAULT '{}',
    textblocks_data JSONB NOT NULL DEFAULT '{}',
    violations_data JSONB NOT NULL DEFAULT '{}',
    invoices_data JSONB NOT NULL DEFAULT '{}',
    content_hash VARCHAR(64),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (act_id, id),
    UNIQUE (act_id, version_number)
)
WITH (appendonly=false)
DISTRIBUTED BY (act_id);

COMMENT ON TABLE {SCHEMA}.{PREFIX}act_content_versions IS 'Снэпшоты содержимого актов для просмотра истории и восстановления';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_content_versions.act_id IS 'ID акта';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_content_versions.version_number IS 'Порядковый номер версии';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_content_versions.save_type IS 'Тип сохранения: manual, periodic, auto';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_content_versions.username IS 'Пользователь, создавший версию';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_content_versions.tree_data IS 'Снэпшот дерева';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_content_versions.tables_data IS 'Снэпшот таблиц';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_content_versions.textblocks_data IS 'Снэпшот текстовых блоков';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_content_versions.violations_data IS 'Снэпшот нарушений';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_content_versions.invoices_data IS 'Снэпшот фактур (привязка node_id → реквизиты фактуры на момент версии)';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_content_versions.content_hash IS 'Канонический SHA-256 содержимого снимка для дедупликации версий';
COMMENT ON COLUMN {SCHEMA}.{PREFIX}act_content_versions.created_at IS 'Время создания версии';

-- ============================================================================
-- ТАБЛИЦА ТЕЛЕМЕТРИИ ЗДОРОВЬЯ РЕДАКТОРА (§6.8)
-- ============================================================================
-- Минимальная наблюдаемость самовосстановлений редактора: фронт копит счётчики
-- событий (self-heal observer'а, починки капсул, ошибки сохранения, пустой
-- paste) и батчами шлёт их сюда. Read-API нет — данные смотрим SQL'ем.
-- PK (id, act_id) ⊇ DISTRIBUTED BY (act_id); id ведущий, но lookups не делаем
-- (таблица только пишется). FK на acts нет — как у audit_log (лог-таблица).

CREATE TABLE IF NOT EXISTS {SCHEMA}.{PREFIX}act_editor_telemetry (
    id VARCHAR(36) NOT NULL,
    act_id BIGINT NOT NULL,
    username VARCHAR(50) NOT NULL,
    event_type VARCHAR(32) NOT NULL,
    event_count INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Constraints
    PRIMARY KEY (id, act_id),
    CONSTRAINT check_editor_telemetry_event_type_values
        CHECK (event_type IN ('observer_heal', 'capsule_repair', 'dup_id_fix',
                              'save_failure', 'empty_paste', 'word_paste'))
)
WITH (appendonly=false)
DISTRIBUTED BY (act_id);

COMMENT ON TABLE {SCHEMA}.{PREFIX}act_editor_telemetry IS 'Счётчики событий здоровья редактора актов (self-heal, починки капсул, ошибки сохранения)';

-- ============================================================================
-- ИНДЕКСЫ ДЛЯ ОПТИМИЗАЦИИ ЗАПРОСОВ
-- Примечание: CREATE INDEX без IF NOT EXISTS — GP 6.x (PG 9.4) не поддерживает
-- IF NOT EXISTS для индексов. Обработка дублей — на уровне адаптера.
-- ============================================================================

-- Индексы на acts
CREATE INDEX idx_{PREFIX}acts_id
    ON {SCHEMA}.{PREFIX}acts(id);

CREATE INDEX idx_{PREFIX}acts_km_digit
    ON {SCHEMA}.{PREFIX}acts(km_number_digit);

CREATE INDEX idx_{PREFIX}acts_km_digit_part
    ON {SCHEMA}.{PREFIX}acts(km_number_digit, part_number);

CREATE INDEX idx_{PREFIX}acts_service_note
    ON {SCHEMA}.{PREFIX}acts(service_note)
    WHERE service_note IS NOT NULL;

CREATE INDEX idx_{PREFIX}acts_service_note_date
    ON {SCHEMA}.{PREFIX}acts(service_note_date)
    WHERE service_note_date IS NOT NULL;

CREATE INDEX idx_{PREFIX}acts_created_by
    ON {SCHEMA}.{PREFIX}acts(created_by);

CREATE INDEX idx_{PREFIX}acts_last_edited_at
    ON {SCHEMA}.{PREFIX}acts(last_edited_at);

-- Индексы на audit_team_members
CREATE INDEX idx_{PREFIX}audit_team_username
    ON {SCHEMA}.{PREFIX}audit_team_members(username);

CREATE INDEX idx_{PREFIX}audit_team_act_id
    ON {SCHEMA}.{PREFIX}audit_team_members(act_id);

CREATE INDEX idx_{PREFIX}audit_team_act_order
    ON {SCHEMA}.{PREFIX}audit_team_members(act_id, order_index);

-- Индексы на act_directives
CREATE INDEX idx_{PREFIX}act_directives_act_id
    ON {SCHEMA}.{PREFIX}act_directives(act_id);

CREATE INDEX idx_{PREFIX}act_directives_act_order
    ON {SCHEMA}.{PREFIX}act_directives(act_id, order_index);

-- Индексы на act_tree
CREATE INDEX idx_{PREFIX}act_tree_act_id
    ON {SCHEMA}.{PREFIX}act_tree(act_id);

-- Индексы на act_tables
CREATE INDEX idx_{PREFIX}act_tables_act_id
    ON {SCHEMA}.{PREFIX}act_tables(act_id);

CREATE INDEX idx_{PREFIX}act_tables_act_table
    ON {SCHEMA}.{PREFIX}act_tables(act_id, table_id);

CREATE INDEX idx_{PREFIX}act_tables_node_number
    ON {SCHEMA}.{PREFIX}act_tables(act_id, node_number)
    WHERE node_number IS NOT NULL;

CREATE INDEX idx_{PREFIX}act_tables_label
    ON {SCHEMA}.{PREFIX}act_tables(act_id, table_label)
    WHERE table_label IS NOT NULL;

CREATE INDEX idx_{PREFIX}act_tables_special_kind
    ON {SCHEMA}.{PREFIX}act_tables(act_id)
    WHERE kind <> 'regular';

-- Индексы на act_textblocks
CREATE INDEX idx_{PREFIX}act_textblocks_act_id
    ON {SCHEMA}.{PREFIX}act_textblocks(act_id);

CREATE INDEX idx_{PREFIX}act_textblocks_act_textblock
    ON {SCHEMA}.{PREFIX}act_textblocks(act_id, textblock_id);

CREATE INDEX idx_{PREFIX}act_textblocks_node_number
    ON {SCHEMA}.{PREFIX}act_textblocks(act_id, node_number)
    WHERE node_number IS NOT NULL;

-- Индексы на act_violations
CREATE INDEX idx_{PREFIX}act_violations_act_id
    ON {SCHEMA}.{PREFIX}act_violations(act_id);

CREATE INDEX idx_{PREFIX}act_violations_act_violation
    ON {SCHEMA}.{PREFIX}act_violations(act_id, violation_id);

CREATE INDEX idx_{PREFIX}act_violations_node_number
    ON {SCHEMA}.{PREFIX}act_violations(act_id, node_number)
    WHERE node_number IS NOT NULL;

-- Индексы на act_invoices
CREATE INDEX idx_{PREFIX}act_invoices_act_id
    ON {SCHEMA}.{PREFIX}act_invoices(act_id);

CREATE INDEX idx_{PREFIX}act_invoices_act_node
    ON {SCHEMA}.{PREFIX}act_invoices(act_id, node_id);

-- Индексы на audit_act_id
CREATE INDEX idx_{PREFIX}acts_audit_act_id
    ON {SCHEMA}.{PREFIX}acts(audit_act_id)
    WHERE audit_act_id IS NOT NULL;

CREATE INDEX idx_{PREFIX}audit_team_audit_act_id
    ON {SCHEMA}.{PREFIX}audit_team_members(audit_act_id)
    WHERE audit_act_id IS NOT NULL;

CREATE INDEX idx_{PREFIX}act_directives_audit_act_id
    ON {SCHEMA}.{PREFIX}act_directives(audit_act_id)
    WHERE audit_act_id IS NOT NULL;

CREATE INDEX idx_{PREFIX}act_tables_audit_act_id
    ON {SCHEMA}.{PREFIX}act_tables(audit_act_id)
    WHERE audit_act_id IS NOT NULL;

CREATE INDEX idx_{PREFIX}act_textblocks_audit_act_id
    ON {SCHEMA}.{PREFIX}act_textblocks(audit_act_id)
    WHERE audit_act_id IS NOT NULL;

CREATE INDEX idx_{PREFIX}act_violations_audit_act_id
    ON {SCHEMA}.{PREFIX}act_violations(audit_act_id)
    WHERE audit_act_id IS NOT NULL;

CREATE INDEX idx_{PREFIX}act_invoices_audit_act_id
    ON {SCHEMA}.{PREFIX}act_invoices(audit_act_id)
    WHERE audit_act_id IS NOT NULL;

-- Индексы на audit_log
CREATE INDEX idx_{PREFIX}audit_log_act_id
    ON {SCHEMA}.{PREFIX}audit_log(act_id)
    WHERE act_id IS NOT NULL;

CREATE INDEX idx_{PREFIX}audit_log_username
    ON {SCHEMA}.{PREFIX}audit_log(username);

CREATE INDEX idx_{PREFIX}audit_log_action
    ON {SCHEMA}.{PREFIX}audit_log(action);

CREATE INDEX idx_{PREFIX}audit_log_created_at
    ON {SCHEMA}.{PREFIX}audit_log(created_at);

CREATE INDEX idx_{PREFIX}audit_log_act_created
    ON {SCHEMA}.{PREFIX}audit_log(act_id, created_at DESC);

-- Индексы на act_content_versions
CREATE INDEX idx_{PREFIX}act_content_versions_act
    ON {SCHEMA}.{PREFIX}act_content_versions(act_id, version_number DESC);

-- ============================================================================
-- updated_at — устанавливается явным SET updated_at = CURRENT_TIMESTAMP в коде
-- ============================================================================
-- На Greenplum 6 PL/pgSQL-триггеры исполняются только на координаторе → каждый
-- UPDATE превращается в RPC к мастер-узлу. Чтобы не платить эту цену, обновление
-- метки времени делается явно в SQL-запросах репозиториев (см. act_content.py,
-- act_crud.py, act_lock.py, act_invoice.py, act_crud_service._build_update_query).
-- PG-схема (postgresql/schema.sql) — отдельный путь dev/локального деплоя;
-- триггер там тоже не нужен (тот же контракт), но менять PG-схему сейчас
-- не обязательно — поведение совпадает.
