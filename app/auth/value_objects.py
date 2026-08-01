"""Value Objects для слоя авторизации."""

from __future__ import annotations

from dataclasses import dataclass, field

from pydantic import BaseModel


@dataclass
class UserContext:
    """Контекст аутентифицированного пользователя."""

    sub: str
    email: str
    login: str
    fullname: str
    teams: list[str] = field(default_factory=list)
    roles: list[str] = field(default_factory=list)


class JWTPayload(BaseModel):
    """Декодированный payload JWT-токена."""

    sub: str
    token_type: str
    exp: int
    iat: int

    def to_dict(self) -> dict:
        return {
            "sub": self.sub,
            "type": self.token_type,
            "exp": self.exp,
            "iat": self.iat,
        }


class TokenPair(BaseModel):
    """Пара access + refresh токенов."""

    access_token: str
    refresh_token: str
