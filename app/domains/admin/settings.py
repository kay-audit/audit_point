"""
Настройки домена администрирования.

Загружаются через ADMIN__* префикс в .env файле.
"""

from pydantic import BaseModel, Field


class UserDirectorySettings(BaseModel):
    """
    Настройки справочника пользователей.

    schema_name — схема таблицы пользователей.
    Пустая строка — используется основная схема GP (или без схемы для PostgreSQL).
    """
    schema_name: str = Field(default="", alias="schema")
    table: str = "t_db_oarb_ua_user"
    branch_filter: str = "Отдел аудита розничного бизнеса"
    # Логины через запятую (как CHAT__PROFILE) — parse_admin_logins() разбирает в список.
    default_admins: str = "22494524"


def parse_admin_logins(value: str) -> list[str]:
    """Разбирает список логинов админов по умолчанию (через запятую)."""
    return [p.strip() for p in (value or "").split(",") if p.strip()]


class DbPoolMonitorSettings(BaseModel):
    """Настройки фонового мониторинга использования asyncpg-пула.

    Раз в ``check_interval_sec`` снимает ``pool.get_size()`` /
    ``pool.get_idle_size()`` и пишет в лог WARNING, если занято больше
    ``warn_ratio`` × ``POOL_MAX_SIZE`` коннектов. Без БД-таблицы —
    просто наблюдатель в логах (Loki/syslog могут построить алёрт).
    """

    enabled: bool = Field(
        default=True,
        description="Запускать фоновый мониторинг пула",
    )
    check_interval_sec: float = Field(
        default=30.0,
        ge=5.0,
        description="Интервал между замерами (секунд)",
    )
    warn_ratio: float = Field(
        default=0.9,
        gt=0.0,
        le=1.0,
        description=(
            "Доля от POOL_MAX_SIZE, при превышении которой эмитим WARNING. "
            "0.9 = алёрт при 18 acquired из 20"
        ),
    )


class AdminSettings(BaseModel):
    """Корневая модель настроек домена администрирования."""
    user_directory: UserDirectorySettings = UserDirectorySettings()
    http_metrics_enabled: bool = Field(
        default=False,
        description="Включить запись HTTP-метрик в БД",
    )
    db_pool_monitor: DbPoolMonitorSettings = DbPoolMonitorSettings()
