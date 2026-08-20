"""Базовые исключения приложения."""

from typing import Any, ClassVar


class AppError(Exception):
    """Базовый класс всех доменных исключений.

    Несёт HTTP-статус, человекочитаемое сообщение и машинный ``code``
    (kebab-case) для унифицированного error envelope:

        {"detail": "...", "code": "...", "extra": {...}?}

    Каждый подкласс ОБЯЗАН переопределить ``code``. На базе оставлен
    дефолт ``"app-error"`` как fallback для прямых инстансов ``AppError``
    (например, обёртка OSError в ExportService).
    """

    status_code: int = 500
    code: ClassVar[str] = "app-error"

    def __init__(self, message: str) -> None:
        self.message = message
        # ``extra`` — словарь дополнительных полей envelope-а (locked_by,
        # km_number и т.п.). Подклассы заполняют в собственных ``__init__``.
        self.extra: dict[str, Any] = {}
        super().__init__(message)

    def to_envelope(self) -> dict[str, Any]:
        """Возвращает унифицированный error envelope для HTTP-ответа."""
        envelope: dict[str, Any] = {"detail": self.message, "code": self.code}
        if self.extra:
            envelope["extra"] = self.extra
        return envelope


class ServiceUnavailableError(AppError):
    """Сервис временно недоступен (например, исчерпан пул соединений к БД).

    Отдаётся при таймауте ожидания свободного соединения из пула: вместо
    бессрочного зависания запроса клиент получает 503 и может повторить позже.
    """

    status_code: int = 503
    code: ClassVar[str] = "service-unavailable"


# Полевые колонки таблицы нарушений (блочная модель) — источник имён для
# однотипных CHECK-сообщений ниже. Список продублирован из доменного реестра
# app/domains/acts/violation_fields.py СОЗНАТЕЛЬНО: core не импортирует домены
# (слоение). Расхождение поймает test_check_constraints_complete — он сверяет
# маппинг с реальными констрейнтами schema.sql.
_VIOLATION_FIELD_COLUMNS = (
    "violated",
    "established",
    "description",
    "code_mining",
    "process_mining",
    "additional_content",
    "reasons",
    "measures",
    "consequences",
    "responsible",
)

# Маппинг имён CHECK-ограничений БД → понятные сообщения для пользователя.
# Используется глобальным обработчиком CheckViolationError в main.py.
# ВАЖНО: при добавлении нового CHECK constraint в schema.sql — обязательно
# добавить маппинг здесь. CI-тест test_check_constraints_complete проверяет
# полноту маппинга и упадёт, если появится constraint без записи.
CHECK_CONSTRAINT_MESSAGES: dict[str, str] = {
    # ── acts: основная таблица актов ─────────────────────────────────────────
    "check_km_number_format": "КМ-номер должен быть в формате КМ-XX-XXXXX",
    "check_km_number_digit_length": "Цифровая часть КМ-номера должна содержать 7 цифр",
    "check_part_number_positive": "Номер части должен быть положительным числом",
    "check_total_parts_positive": "Общее количество частей должно быть положительным числом",
    "check_inspection_dates": "Дата окончания проверки не может быть раньше даты начала",
    "check_service_note_format": "Служебная записка должна быть в формате Текст/XXXX",
    "check_service_note_consistency": (
        "Служебная записка и дата должны быть указаны вместе или отсутствовать вместе"
    ),
    # ── acts: audit_team_members ─────────────────────────────────────────────
    # Общее PG/GP-имя констрейнта (GP-схема тоже использует это имя; AppendixRef —
    # служебное значение для строки-маркера приложения, в user-facing сообщении
    # не упоминаем).
    "check_audit_team_role_values": (
        "Недопустимая роль участника аудиторской группы. "
        "Допустимые значения: Куратор, Руководитель, Редактор, Участник"
    ),
    "check_order_index_non_negative": "Порядковый индекс не может быть отрицательным",
    # ── acts: act_directives ─────────────────────────────────────────────────
    "check_point_number_format": (
        "Неверный формат номера пункта поручения: ожидается 5.X или 5.X.Y и т.д."
    ),
    # ── acts: act_tree ───────────────────────────────────────────────────────
    "check_tree_data_not_empty": "Данные дерева акта должны быть объектом JSON",
    # ── acts: act_tables ─────────────────────────────────────────────────────
    "check_grid_data_is_array": "Данные таблицы (grid_data) должны быть массивом JSON",
    "check_col_widths_is_array": "Ширины столбцов (col_widths) должны быть массивом JSON",
    "check_table_kind_values": (
        "Недопустимый подвид таблицы. Допустимые значения: regular, metrics, "
        "mainMetrics, regularRisk, operationalRisk, taxRisk, otherRisk"
    ),
    "check_acts_validation_status_values": (
        "Недопустимое состояние валидации акта. Допустимые значения: ok, warning, error"
    ),
    # ── acts: act_violations (блочная модель: контейнеры {enabled, blocks}) ──
    # Десять полевых колонок нарушения — один и тот же CHECK с точностью до
    # имени колонки, поэтому сообщения генерируются, а не переписываются.
    **{
        f"check_{column}_is_object_or_null": (
            f"Поле {column} должно быть объектом JSON "
            "с полями enabled и blocks, или отсутствовать"
        )
        for column in _VIOLATION_FIELD_COLUMNS
    },
    "check_field_order_is_array_or_null": (
        "Порядок полей нарушения (field_order) должен быть массивом JSON или отсутствовать"
    ),
    # ── acts: act_invoices ───────────────────────────────────────────────────
    # PG-имена (явные, добавлены при заполнении)
    "check_act_invoices_db_type_values": (
        "Недопустимый тип базы данных фактуры. Допустимые значения: hive, greenplum"
    ),
    "check_act_invoices_verification_status_values": (
        "Недопустимый статус верификации фактуры. "
        "Допустимые значения: pending, verified, rejected"
    ),
    # GP-имена (уже были явными)
    "check_db_type_values": (
        "Недопустимый тип базы данных фактуры. Допустимые значения: hive, greenplum"
    ),
    "check_verification_status_values": (
        "Недопустимый статус верификации фактуры. "
        "Допустимые значения: pending, verified, rejected"
    ),
    "check_metrics_is_array": "Поле metrics должно быть массивом JSON",
    # ── acts: act_editor_telemetry ───────────────────────────────────────────
    "check_editor_telemetry_event_type_values": (
        "Недопустимый тип события телеметрии редактора. Допустимые значения: "
        "observer_heal, capsule_repair, dup_id_fix, save_failure, empty_paste, "
        "word_paste"
    ),
    # ── chat: chat_files ─────────────────────────────────────────────────────
    "check_chat_files_file_size_positive": "Размер файла должен быть больше нуля",
    # ── chat: chat_messages ──────────────────────────────────────────────────
    "check_chat_messages_status_values": (
        "Недопустимый статус сообщения. "
        "Допустимые значения: streaming, complete, failed"
    ),
    # ── chat: chat_tool_metrics ──────────────────────────────────────────────
    "check_chat_tool_metrics_status_values": (
        "Недопустимый статус выполнения tool'а. "
        "Допустимые значения: success, error, validation_error"
    ),
    "check_chat_tool_metrics_latency_nonneg": (
        "Длительность выполнения tool'а не может быть отрицательной"
    ),
    # ── chat: chat_agent_messages_bus (dev-имитация шины внешнего агента;
    #    словари — подтверждённая спека владельца таблицы) ───────────────────
    "check_chat_agent_messages_bus_role_values": (
        "Недопустимая роль сообщения шины агента. "
        "Допустимые значения: user, assistant, system, tool"
    ),
    "check_chat_agent_messages_bus_status_values": (
        "Недопустимый статус сообщения шины агента. "
        "Допустимые значения: pending, processing, completed, failed, error"
    ),
    # ── chat: chat_message_feedback ──────────────────────────────────────────
    "check_chat_message_feedback_rating_values": (
        "Недопустимая оценка сообщения. Допустимые значения: up, down"
    ),
    "check_chat_message_feedback_source_values": (
        "Недопустимый источник оценки. Допустимые значения: user, auto, llm"
    ),
    # ── notifications: notifications ──────────────────────────────────────────
    "check_notifications_severity": (
        "Недопустимая критичность уведомления. "
        "Допустимые значения: info, success, warning, error"
    ),
}
