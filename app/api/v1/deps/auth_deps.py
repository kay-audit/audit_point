"""
Зависимости для авторизации (FastAPI Depends).

Используется как в API-эндпоинтах, так и в HTML-роутах для проверки
авторизации пользователя через переменную окружения JUPYTERHUB_USER.
"""

import logging

from fastapi import HTTPException

from fastapi import Depends
from app.auth.dependencies import get_current_user
from app.auth.value_objects import UserContext

async def get_username(user: UserContext = Depends(get_current_user)) -> str:
    """
    Извлекает имя пользователя через модуль app/auth.

    Returns:
        Username в виде логина пользователя

    Raises:
        HTTPException: 401 если пользователь не авторизован
    """
    return user.login
