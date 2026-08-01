"""Эндпоинты авторизации: OTP, JWT-токены, профиль пользователя."""

from __future__ import annotations

import logging
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr

from app.auth.dependencies import (
    get_current_user,
    get_jwt_handler,
    get_redis_adapter,
    get_user_repository,
)
from app.auth.jwt_handler import JWTTokenHandler
from app.auth.middleware import set_auth_cookies
from app.auth.user_repository import AuthUserRepository
from app.auth.value_objects import UserContext
from app.core.config import get_settings
from app.core.domain_registry import get_factory, has_factory

logger = logging.getLogger("audit_workstation.auth.router")

router = APIRouter()


class RequestOTPRequest(BaseModel):
    """Тело запроса на отправку OTP."""

    email: EmailStr


class VerifyOTPRequest(BaseModel):
    """Тело запроса на подтверждение OTP."""

    email: EmailStr
    otp: str


class AuthOTPResponse(BaseModel):
    """Ответ результата авторизации."""

    success: bool
    user: dict | None = None
    error: str | None = None
    message: str | None = None


class RefreshResponse(BaseModel):
    """Ответ на обновление токенов."""

    access_token: str
    refresh_token: str
    user: dict


class UserProfile(BaseModel):
    """Профиль аутентифицированного пользователя."""

    sub: str
    email: str
    login: str
    fullname: str
    teams: list[str]
    roles: list[str]


def _otp_key(user_id: str) -> str:
    return f"otp:{user_id}"


@router.post("/request-otp")
async def request_otp(
    body: RequestOTPRequest,
    request: Request,
    repo: AuthUserRepository = Depends(get_user_repository),
):
    """Генерирует OTP-код для входа по email.

    Генерируется 6-значный код, сохраняется в Redis с TTL = 5 минут.
    В режиме отладки OTP логируется (SMTP будет добавлен позже).
    """
    settings = get_settings().auth
    user = await repo.find_by_email(body.email)
    logger.info("request_otp: email=%s, found user=%s", body.email, user and user["id"])
    if user is None:
        logger.info("request_otp: пользователь не найден, возвращаем success=true (скрываем факт существования email)")
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "message": "Если email зарегистрирован, OTP отправлен",
            },
        )

    otp = str(secrets.randbelow(10 ** settings.otp_length)).zfill(settings.otp_length)
    redis = get_redis_adapter(request)
    try:
        await redis.set(_otp_key(user["id"]), otp, ex=settings.otp_ttl)
        logger.info("OTP код сохранен в Redis для пользователя %s (%s): %s (TTL=%s)", 
                    user["email"], user["id"], otp, settings.otp_ttl)
    except Exception as exc:
        logger.error("Ошибка сохранения OTP в Redis: %s", exc)
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": "Внутренняя ошибка сервера"},
        )

    logger.info("OTP для %s (%s) = %s", user["email"], user["id"], otp)

    # Отправка OTP на email через email сервис
    from app.core.settings_registry import get as get_domain_settings
    from app.domains.notifications.settings import NotificationsSettings

    email_enabled = get_domain_settings("notifications", NotificationsSettings).email.enabled
    if email_enabled and has_factory("notifications.email"):
        try:
            from app.domains.notifications.services.email_service import get_mail_client, EmailService

            # Используем EmailService напрямую без async for (не блокирует пул соединений)
            email_svc = EmailService()
            subject = f"Ваш OTP-код для входа в Audit Workstation"
            body_html = f"""
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #2c3e50;">Audit Workstation</h2>
                <p style="font-size: 16px; color: #333;">Ваш код подтверждения:</p>
                <div style="background-color: #f8f9fa; padding: 20px; text-align: center; margin: 20px 0;">
                    <span style="font-size: 32px; font-weight: bold; color: #3498db; letter-spacing: 5px;">
                        {otp}
                    </span>
                </div>
                <p style="font-size: 14px; color: #666; margin-top: 20px;">
                    Этот код действителен в течение {settings.otp_ttl // 60} минут.<br>
                    Если вы не запрашивали этот код, проигнорируйте это письмо.
                </p>
            </div>
            """

            success = await email_svc.send_email(
                to=user["email"],
                subject=subject,
                body=body_html,
            )

            if success:
                logger.info("OTP отправлен на email %s", user["email"])
            else:
                logger.warning("Не удалось отправить OTP на email %s", user["email"])
        except Exception as exc:
            logger.error("Ошибка отправки OTP на email: %s", exc)
            # Не прерываем процесс из-за ошибки email

    return JSONResponse(
        status_code=200,
        content={
            "success": True,
            "message": "Если email зарегистрирован, OTP отправлен",
        },
    )


@router.post("/verify-otp")
async def verify_otp(
    body: VerifyOTPRequest,
    request: Request,
    repo: AuthUserRepository = Depends(get_user_repository),
):
    """Проверяет OTP-код и выдаёт JWT-токены для входа.

    При успехе:
        - удаляет OTP из Redis (одноразовый)
        - создаёт access + refresh токены
        - устанавливает HttpOnly cookie
        - возвращает профиль пользователя
    """
    user = await repo.find_by_email(body.email)
    logger.info("verify_otp: email=%s, found user=%s", body.email, user and user["id"])
    if user is None:
        return JSONResponse(
            status_code=401,
            content={"success": False, "error": "Неверный email или код"},
        )

    redis = get_redis_adapter(request)
    try:
        stored_otp = await redis.get(_otp_key(user["id"]))
        logger.info("Получен OTP из Redis для пользователя %s: stored=%s, input=%s", 
                    user["email"], stored_otp, body.otp)
        logger.info("Сверка OTP в Redis: %s", stored_otp)
        logger.info("Body OTP в Redis: %s", body.otp)
        if not stored_otp or stored_otp != body.otp:
            logger.warning("Неверный OTP для пользователя %s: stored=%s, input=%s", 
                           user["email"], stored_otp, body.otp)
            return JSONResponse(
                status_code=401,
                content={"success": False, "error": "Неверный email или код"},
            )
        await redis.delete(_otp_key(user["id"]))
        logger.info("OTP для пользователя %s (%s) успешно проверен и удален из Redis", user["email"], user["id"])
    except Exception as exc:
        logger.error("Ошибка проверки OTP в Redis: %s", exc)
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": "Внутренняя ошибка сервера"},
        )

    jwt_handler = get_jwt_handler()
    tokens = jwt_handler.create_token_pair(user["id"])
    logger.info("Создана пара токенов для пользователя: %s (%s)", user["email"], user["id"])
    ctx = await repo.get_user_context(user["id"])
    if ctx is None:
        return JSONResponse(
            status_code=401,
            content={"success": False, "error": "Пользователь не найден"},
        )

    user_payload = {
        "sub": ctx["id"],
        "email": ctx["email"],
        "login": ctx["login"],
        "fullname": ctx["fullname"],
        "teams": ctx["teams"],
        "roles": ctx["roles"],
    }
    logger.info("Успешная проверка OTP для пользователя: %s (%s)", user["email"], user["id"])
    logger.info("Данные пользователя для response: %s", user_payload)
    response = JSONResponse(
        status_code=200,
        content={"success": True, "user": user_payload},
    )
    set_auth_cookies(response, tokens.access_token, tokens.refresh_token)
    return response


@router.post("/refresh")
async def refresh_tokens(request: Request):
    """Обновляет пару токенов по refresh_token из cookie."""
    refresh_token = request.cookies.get("refresh_token")
    if not refresh_token:
        raise HTTPException(status_code=401, detail="Refresh-токен отсутствует в cookie")

    jwt_handler = get_jwt_handler()
    payload = jwt_handler.decode_token(refresh_token)
    if payload is None or payload.token_type != "refresh":
        raise HTTPException(status_code=401, detail="Невалидный refresh-токен")

    tokens = jwt_handler.create_token_pair(payload.sub)

    from app.db.connection import get_db

    async with get_db() as conn:
        repo = AuthUserRepository(conn)
        ctx = await repo.get_user_context(payload.sub)
    if ctx is None:
        raise HTTPException(status_code=401, detail="Пользователь не найден")

    user_data = {
        "sub": ctx["id"],
        "email": ctx["email"],
        "login": ctx["login"],
        "fullname": ctx["fullname"],
        "teams": ctx["teams"],
        "roles": ctx["roles"],
    }
    response = JSONResponse(
        status_code=200,
        content={
            "access_token": tokens.access_token,
            "refresh_token": tokens.refresh_token,
            "user": user_data,
        },
    )
    set_auth_cookies(response, tokens.access_token, tokens.refresh_token)
    return response


@router.get("/profile", response_model=UserProfile)
async def get_current_user_profile(
    user: UserContext = Depends(get_current_user),
) -> UserProfile:
    """Возвращает профиль аутентифицированного пользователя."""
    return UserProfile(
        sub=user.sub,
        email=user.email,
        login=user.login,
        fullname=user.fullname,
        teams=user.teams,
        roles=user.roles,
    )


@router.get("/me")
async def get_current_user_me(
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Возвращает текущего пользователя для проверки авторизации."""
    return {
        "authenticated": True,
        "username": user.login,
        "sub": user.sub,
        "email": user.email,
        "login": user.login,
        "fullname": user.fullname,
        "teams": user.teams,
        "roles": user.roles,
    }
