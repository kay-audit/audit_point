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
from app.core.domain_registry import has_factory

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


def _otp_attempts_key(user_id: str) -> str:
    return f"otp_att:{user_id}"


def _otp_request_rate_key(email: str) -> str:
    return f"otp_req:{email.lower()}"


@router.post("/request-otp")
async def request_otp(
    body: RequestOTPRequest,
    request: Request,
    repo: AuthUserRepository = Depends(get_user_repository),
):
    """Генерирует OTP-код для входа по email.

    Генерируется 6-значный код, сохраняется в Redis с TTL = 5 минут.
    Частота запросов на один email ограничена (AUTH__OTP_REQUEST_MAX_PER_MINUTE);
    лимит проверяется до похода в БД — это защищает и от перебора email,
    и от флуда SMTP. В dev-режиме (email выключен или отправка не удалась)
    код пишется в лог.
    """
    settings = get_settings().auth
    redis = get_redis_adapter(request)

    rate_key = _otp_request_rate_key(body.email)
    request_count = await redis.incr(rate_key)
    if request_count == 1:
        await redis.expire(rate_key, 60)
    if request_count > settings.otp_request_max_per_minute:
        return JSONResponse(
            status_code=429,
            content={
                "success": False,
                "error": "Слишком много запросов кода, попробуйте через минуту",
            },
        )

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
    try:
        await redis.set(_otp_key(user["id"]), otp, ex=settings.otp_ttl)
        logger.info("OTP сохранён в Redis для пользователя %s (%s), TTL=%s",
                    user["email"], user["id"], settings.otp_ttl)
    except Exception as exc:
        logger.error("Ошибка сохранения OTP в Redis: %s", exc)
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": "Внутренняя ошибка сервера"},
        )

    # Отправка OTP на email через email сервис
    from app.core.settings_registry import get as get_domain_settings
    from app.domains.notifications.settings import NotificationsSettings

    email_enabled = get_domain_settings("notifications", NotificationsSettings).email.enabled
    email_sent = False
    if email_enabled and has_factory("notifications.email"):
        try:
            from app.domains.notifications.services.email_service import EmailService

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

            email_sent = await email_svc.send_email(
                to=user["email"],
                subject=subject,
                body=body_html,
            )

            if email_sent:
                logger.info("OTP отправлен на email %s", user["email"])
            else:
                logger.warning("Не удалось отправить OTP на email %s", user["email"])
        except Exception as exc:
            logger.error("Ошибка отправки OTP на email: %s", exc)
            # Не прерываем процесс из-за ошибки email

    if not email_sent:
        # Email выключен либо отправка не удалась — код забирают из лога (dev-режим).
        logger.info("DEV-режим: ОТП-код для %s = %s", user["email"], otp)

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

    Число неверных попыток ограничено (AUTH__OTP_MAX_ATTEMPTS): по достижении
    лимита код инвалидируется досрочно (нужно запросить новый).
    """
    settings = get_settings().auth
    user = await repo.find_by_email(body.email)
    logger.info("verify_otp: email=%s, found user=%s", body.email, user and user["id"])
    if user is None:
        return JSONResponse(
            status_code=401,
            content={"success": False, "error": "Неверный email или код"},
        )

    redis = get_redis_adapter(request)
    otp_key = _otp_key(user["id"])
    attempts_key = _otp_attempts_key(user["id"])
    try:
        stored_otp = await redis.get(otp_key)
        if stored_otp is None:
            return JSONResponse(
                status_code=401,
                content={"success": False, "error": "Код недействителен, запросите новый"},
            )
        if stored_otp != body.otp:
            logger.warning("Неверный OTP для пользователя %s", user["id"])
            attempts = await redis.incr(attempts_key)
            if attempts == 1:
                await redis.expire(attempts_key, settings.otp_ttl)
            if attempts >= settings.otp_max_attempts:
                await redis.delete(otp_key, attempts_key)
                return JSONResponse(
                    status_code=401,
                    content={"success": False, "error": "Код недействителен, запросите новый"},
                )
            return JSONResponse(
                status_code=401,
                content={"success": False, "error": "Неверный email или код"},
            )
        await redis.delete(otp_key, attempts_key)
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


@router.post("/logout")
async def logout():
    """Программный выход: очищает JWT-cookie."""
    from app.auth.middleware import clear_auth_cookies

    response = JSONResponse(status_code=200, content={"success": True})
    clear_auth_cookies(response)
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
