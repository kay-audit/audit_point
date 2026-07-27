"""
Конфигурация приложения.

Содержит настройки путей, параметров сервера и других констант.
Использует переменные окружения из .env файла.
"""

import warnings
from functools import lru_cache
from pathlib import Path
from typing import ClassVar, Literal

from pydantic import BaseModel, Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Реэкспорт для обратной совместимости: исторически request_id_var,
# RequestIdFilter и setup_logging жили в этом модуле.
from app.core.logging import RequestIdFilter, request_id_var, setup_logging  # noqa: F401


# === Вложенные модели настроек ===


class ServerSettings(BaseModel):
    """Параметры сервера."""
    host: str = "0.0.0.0"
    port: int = Field(default=8000, ge=1, le=65535)
    api_v1_prefix: str = "/api/v1"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"

    @field_validator("log_level")
    @classmethod
    def normalize_log_level(cls, v: str) -> str:
        """Нормализует уровень логирования к верхнему регистру."""
        return v.upper()


class GreenplumSettings(BaseModel):
    """Настройки подключения к Greenplum."""
    host: str = Field(default="gp_dns_pkap1123_audit.gp.df.sbrf.ru")
    port: int = Field(default=5432, ge=1, le=65535)
    database: str = Field(default="capgp3")
    schema_name: str = Field(
        default="s_grnplm_ld_audit_da_project_4",
        alias="schema"
    )

    model_config = {"populate_by_name": True}


class DatabaseSettings(BaseModel):
    """Настройки базы данных.

    Размер пула рассчитан под одно-воркерный деплой (singleton-lock).
    Активные потребители соединений:

    * HTTP-запросы пользователей — каждый берёт коннект из пула через ``get_db()``;
      типичная нагрузка десятки одновременных запросов на чтение/запись актов.
    * Фоновые батчеры метрик (``admin.http_metrics``, ``chat.tool_metrics``,
      ``chat.audit_log``, ``acts.audit_log``) — каждый при flush берёт один
      коннект на короткое время (раз в ``flush_interval_sec`` секунд или при
      переполнении пакета).
    * Поллер канала к внешнему агенту (``chat.agent_channel_poller``)
      — держит коннект короткими порциями (poll каждые N секунд).
    * Фоновый cleanup expired locks (``acts.expired_locks_cleanup``) — один
      коннект раз в 60 сек.

    Дефолты ``pool_min_size=5`` / ``pool_max_size=20`` подобраны эмпирически:
    минимум держит несколько прогретых коннектов под типичный фон,
    максимум — потолок для всплесков (несколько одновременных HTTP +
    параллельные batcher-flush + polling-runners). Под Greenplum брать
    больше 20 нецелесообразно — GP плохо масштабируется на число коннектов.
    """
    type: Literal["postgresql", "greenplum"] = Field(default="postgresql")
    host: str = Field(default="localhost")
    port: int = Field(default=5432, ge=1, le=65535)
    name: str = Field(default="audit_workstation")
    user: str = Field(default="postgres")
    password: SecretStr = SecretStr("")
    pool_min_size: int = Field(default=5, ge=1)
    pool_max_size: int = Field(default=20, ge=2)
    command_timeout: int = Field(default=60, gt=0)
    # Таймаут ожидания свободного соединения из пула (сек). При исчерпании пула
    # acquire() ждёт не бесконечно, а отдаёт 503 — иначе запрос виснет до
    # освобождения соседнего соединения без какой-либо диагностики.
    acquire_timeout: float = Field(default=10.0, gt=0)
    # При старте — выполнить count=pool_min_size холостых acquire() параллельно,
    # чтобы первые запросы пользователя не платили TCP-handshake.
    pool_warmup_enabled: bool = Field(default=True)
    # Префикс таблиц приложения — общий для PG и GP, чтобы имена совпадали.
    table_prefix: str = Field(default="t_db_oarb_audit_act_")
    gp: GreenplumSettings = GreenplumSettings()

    @model_validator(mode="after")
    def validate_pool_sizes(self):
        """Проверяет, что pool_min_size <= pool_max_size."""
        if self.pool_min_size > self.pool_max_size:
            raise ValueError(
                f"pool_min_size ({self.pool_min_size}) не может быть больше "
                f"pool_max_size ({self.pool_max_size})"
            )
        return self


class SecuritySettings(BaseModel):
    """Лимиты безопасности."""
    max_request_size: int = Field(default=10 * 1024 * 1024, gt=0)
    rate_limit_per_minute: int = Field(default=1024, gt=0)
    max_tracked_ips: int = 100
    rate_limit_ttl: int = 120
    # TTL «stale» singleton-lock'а в секундах. Если строка старше — старый
    # воркер считается мёртвым, новый перезаписывает блокировку.
    # Уменьшать только если deploy достаточно быстрый, чтобы корректный
    # shutdown гарантированно успел вызвать ``release_singleton_lock``.
    singleton_lock_stale_ttl_sec: int = Field(default=60, gt=0)

    # === Security response headers ===
    # CSP в enforce-режиме (csp_report_only=False) с реальной защитой от инъекции
    # inline-скриптов через per-request nonce. SecurityHeadersMiddleware генерит
    # nonce на каждый http-запрос, подставляет его в плейсхолдер {nonce} директивы
    # script-src и кладёт в request.state.csp_nonce; единственные inline-скрипты
    # (init-блоки <script type="module"> в 5 шаблонах) проставляют этот nonce
    # атрибутом. Inline-обработчиков (onclick/onchange) в шаблонах нет.
    # style-src сохраняет 'unsafe-inline' осознанно: вынос inline-стилей —
    # отдельный несоизмеримый объём, выходит за рамки этой задачи (follow-up).
    csp_enabled: bool = True
    csp_report_only: bool = False
    csp_policy: str = (
        "default-src 'self'; "
        "script-src 'self' 'nonce-{nonce}'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; "
        "font-src 'self' data:; "
        "connect-src 'self'; "
        "frame-ancestors 'self'; "
        "base-uri 'self'; "
        "form-action 'self'; "
        "object-src 'none'"
    )
    # HSTS добавляется только для HTTPS-ответов (scope.scheme=='https' или X-Forwarded-Proto).
    hsts_enabled: bool = True
    hsts_max_age: int = Field(default=31536000, gt=0)  # 1 год
    hsts_include_subdomains: bool = True
    # Clickjacking — SAMEORIGIN покрывает JupyterHub-iframe-сценарий.
    frame_options: Literal["DENY", "SAMEORIGIN"] = "SAMEORIGIN"
    # Referrer не отправляется на cross-origin, но шлётся в полном виде для same-origin.
    referrer_policy: str = "strict-origin-when-cross-origin"
    # Минимально разрешающий Permissions-Policy: всё блокируется по умолчанию.
    permissions_policy: str = (
        "camera=(), microphone=(), geolocation=(), payment=(), "
        "usb=(), magnetometer=(), gyroscope=(), accelerometer=()"
    )


class ObservabilitySettings(BaseModel):
    """Параметры батчинга записи метрик в БД.

    Применяется для трёх потоков метрик: HTTP-запросы (admin), tool-метрики
    чата и audit-лог чата. Параметры общие — каждый поток создаёт свой
    ``MetricsBatcher`` с этими настройками.
    """
    metrics_batch_size: int = Field(
        default=100,
        ge=1,
        le=10000,
        description="Размер пакета метрик для bulk-INSERT",
    )
    metrics_flush_interval_sec: float = Field(
        default=5.0,
        ge=0.5,
        le=300.0,
        description="Интервал flush метрик в секундах",
    )
    metrics_max_buffer_size: int = Field(
        default=10000,
        ge=100,
        description=(
            "Защитный потолок буфера; при переполнении старые записи "
            "дропаются с warning-логом"
        ),
    )


class Settings(BaseSettings):
    """
    Класс настроек приложения на основе Pydantic.

    Автоматически загружает переменные из .env файла и предоставляет
    типизированный доступ к конфигурации. Вложенные настройки используют
    разделитель __ (например, SERVER__HOST, DATABASE__TYPE).
    """

    # Метаданные приложения
    app_title: str = "Единое рабочее место аудитора"
    app_version: str = "1.0.0"

    # Аутентификация
    jupyterhub_user: str = Field(default="unknown_user")

    # Сервис идентификации аудита
    # TODO: URL внешнего сервиса идентификации аудита
    audit_id_service_url: str = ""
    audit_id_service_timeout: int = 10

    # Вложенные настройки (shared)
    server: ServerSettings = ServerSettings()
    database: DatabaseSettings = DatabaseSettings()
    security: SecuritySettings = SecuritySettings()
    observability: ObservabilitySettings = ObservabilitySettings()
    # Базовая директория проекта.
    # Относительный путь от конфига до корня проекта.
    base_dir: ClassVar[Path] = Path(__file__).resolve().parent.parent.parent

    # Директория для хранения файлов актов
    @property
    def storage_dir(self) -> Path:
        """Возвращает директорию для хранения актов."""
        path = self.base_dir / "acts_storage"
        path.mkdir(parents=True, exist_ok=True)
        return path

    # Директория с HTML-шаблонами
    @property
    def templates_dir(self) -> Path:
        """Возвращает директорию с шаблонами."""
        return self.base_dir / "templates"

    # Директория со статическими файлами (CSS, JS)
    @property
    def static_dir(self) -> Path:
        """Возвращает директорию со статическими файлами."""
        return self.base_dir / "static"

    @model_validator(mode='after')
    def warn_empty_db_password(self):
        """Предупреждает если пароль БД не задан для PostgreSQL."""
        if self.database.type == "postgresql" and not self.database.password.get_secret_value():
            warnings.warn(
                "DATABASE__PASSWORD не задан. Подключение к PostgreSQL без пароля. "
                "Задайте DATABASE__PASSWORD в .env для production.",
                stacklevel=2,
            )
        return self

    # Конфигурация Pydantic
    model_config = SettingsConfigDict(
        env_file=str(base_dir / ".env"),  # Файл с переменными окружения
        env_nested_delimiter="__",  # Разделитель для вложенных настроек
        case_sensitive=False,  # Нечувствительность к регистру переменных
        extra="ignore",  # Игнорировать неизвестные поля из .env
    )

    def ensure_directories(self) -> None:
        """
        Создает все необходимые директории при инициализации.

        Вызывайте этот метод при запуске приложения для гарантии
        существования всех рабочих директорий.

        Raises:
            RuntimeError: Если критичные директории не найдены
        """
        # storage_dir создается автоматически через property
        _ = self.storage_dir

        # Проверяем существование критичных директорий
        if not self.templates_dir.exists():
            raise RuntimeError(
                f"Директория шаблонов не найдена: {self.templates_dir}"
            )
        if not self.static_dir.exists():
            raise RuntimeError(
                f"Директория статики не найдена: {self.static_dir}"
            )


@lru_cache()
def get_settings() -> Settings:
    """Возвращает singleton экземпляр Settings с кэшированием."""
    return Settings()
