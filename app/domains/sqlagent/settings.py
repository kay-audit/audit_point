"""Настройки домена SQL-агента."""

from pydantic import BaseModel, Field


class SQLAgentSettings(BaseModel):
    """Корневая модель настроек домена SQL-агента. Загружаются из SQLAGENT__*.

    SQLAgent работает отдельным uvicorn-процессом, а AuditWorkstation
    встраивает его UI через iframe на проксированный порт.
    """

    enabled: bool = Field(default=True, description="Включён ли домен SQL-агента")
    sidecar_port: int = Field(
        default=8005,
        description="Порт sidecar-процесса SQLAgent (localhost)",
    )
    public_url: str = Field(
        default="",
        description=(
            "Публичный URL UI SQLAgent для iframe (SDP: адрес sidecar-порта "
            "на том же хосте). Пусто — локальный фоллбэк http://localhost:{sidecar_port}/"
        ),
    )
