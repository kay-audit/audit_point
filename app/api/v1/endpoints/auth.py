"""
Заглушка для обратной совместимости с JupyterHub.

Содержит минимальную реализацию get_current_user_from_env
для поддержки старых интеграций.
"""

import os
from typing import Any

from app.core.config import get_settings


def get_current_user_from_env(truncate=True) -> str | None:
    """
    Получает текущего пользователя из переменных окружения.

    Используется для обратной совместимости с JupyterHub.

    """
    settings = get_settings()

    # Сначала проверяем реальную переменную окружения (JupyterHub)
    raw_username = os.environ.get('JUPYTERHUB_USER')

    # Если нет — берем из настроек (.env)
    if not raw_username:
        raw_username = settings.jupyterhub_user

    if not raw_username or raw_username == 'unknown_user':
        return None

    return raw_username if not truncate else _extract_digits(raw_username)


def _extract_digits(username: str) -> str:
    """Извлекает только цифры из username."""
    digits = ''.join(filter(str.isdigit, username.split('_')[0]))
    return digits if digits else None
