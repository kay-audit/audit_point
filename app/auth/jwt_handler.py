"""JWT-обработчик: создание и проверка токенов."""

from __future__ import annotations

import logging
import time

import jwt

from app.auth.value_objects import JWTPayload, TokenPair
from app.core.config import get_settings

logger = logging.getLogger("audit_workstation.auth.jwt")


class JWTTokenHandler:
    """Синглтон-обработчик JWT-токенов.

    Payload содержит поля:
        - sub  (user_id / username)
        - type ("access" | "refresh")
        - exp  (время истечения)
        - iat  (время выпуска)
    """

    @staticmethod
    def create_access_token(user_id: str) -> str:
        """Создаёт access-токен с TTL из настроек."""
        settings = get_settings().auth
        now = int(time.time())
        payload = {
            "sub": user_id,
            "type": "access",
            "iat": now,
            "exp": now + settings.jwt_access_ttl,
        }
        return jwt.encode(
            payload,
            settings.jwt_secret.get_secret_value(),
            algorithm=settings.jwt_algorithm,
        )

    @staticmethod
    def create_refresh_token(user_id: str) -> str:
        """Создаёт refresh-токен с TTL из настроек."""
        settings = get_settings().auth
        now = int(time.time())
        payload = {
            "sub": user_id,
            "type": "refresh",
            "iat": now,
            "exp": now + settings.jwt_refresh_ttl,
        }
        return jwt.encode(
            payload,
            settings.jwt_secret.get_secret_value(),
            algorithm=settings.jwt_algorithm,
        )

    @staticmethod
    def create_token_pair(user_id: str) -> TokenPair:
        """Создаёт пару access + refresh токенов."""
        return TokenPair(
            access_token=JWTTokenHandler.create_access_token(user_id),
            refresh_token=JWTTokenHandler.create_refresh_token(user_id),
        )

    @staticmethod
    def decode_token(token: str) -> JWTPayload | None:
        """Декодирует и валидирует JWT-токен.

        Returns:
            JWTPayload при успехе, None при ошибке.
        """
        settings = get_settings().auth
        try:
            raw = jwt.decode(
                token,
                settings.jwt_secret.get_secret_value(),
                algorithms=[settings.jwt_algorithm],
                options={"require": ["sub", "type", "exp", "iat"]},
            )
            return JWTPayload(
                sub=raw["sub"],
                token_type=raw["type"],
                exp=raw["exp"],
                iat=raw["iat"],
            )
        except jwt.ExpiredSignatureError:
            return None
        except Exception as exc:
            logger.debug("JWT decode error: %s", exc)
            return None
