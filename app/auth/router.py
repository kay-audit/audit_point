"""Эндпоинты авторизации: OTP, JWT-токены, профиль пользователя, фото профиля."""

from __future__ import annotations

import logging
import secrets
from contextlib import aclosing

from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr

from app.auth.avatar_image import (
    AVATAR_MAX_UPLOAD_BYTES,
    AVATAR_MIME,
    AvatarImageError,
    process_avatar_image,
)
from app.auth.dependencies import (
    AuthUserDirectory,
    get_current_user,
    get_jwt_handler,
    get_redis_adapter,
    get_user_repository,
)
from app.auth.jwt_handler import JWTTokenHandler
from app.auth.middleware import set_auth_cookies
from app.auth.otp_email import build_otp_email
from app.auth.value_objects import UserContext
from app.core.config import get_settings
from app.core.domain_registry import get_factory, has_factory

logger = logging.getLogger("audit_workstation.auth.router")

router = APIRouter()

# Единый текст отказа для ВСЕХ веток verify-otp. Различающиеся формулировки
# («email не найден» / «код истёк» / «неверный код») были оракулом: по тексту
# ответа перебором можно было выяснить, зарегистрирован ли email.
OTP_INVALID_ERROR = "Неверный email или код. Если код истёк — запросите новый."

# Ответ, когда Redis недоступен: без него ни лимиты, ни коды не работают.
REDIS_UNAVAILABLE_ERROR = "Сервис авторизации временно недоступен, попробуйте позже"

# Отказ при слишком большом файле фото. Размер в тексте — чтобы пользователю
# не пришлось искать лимит в документации.
AVATAR_TOO_LARGE_ERROR = (
    f"Файл больше {AVATAR_MAX_UPLOAD_BYTES // (1024 * 1024)} МБ. "
    "Выберите фото поменьше."
)

# Размер куска при чтении загружаемого файла.
AVATAR_UPLOAD_CHUNK_BYTES = 64 * 1024

# Сколько браузеру держать фото в кеше. Смена фото не ждёт истечения: фронт
# запрашивает картинку с ?v=<avatar_version>, и версия меняется вместе с фото.
AVATAR_CACHE_CONTROL = "private, max-age=86400"


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
    repo: AuthUserDirectory = Depends(get_user_repository),
):
    """Генерирует OTP-код для входа по email.

    Генерируется 6-значный код, сохраняется в Redis с TTL = 5 минут.
    Частота запросов на один email ограничена (AUTH__OTP_REQUEST_MAX_PER_MINUTE);
    лимит проверяется до похода в БД — это защищает и от перебора email,
    и от флуда SMTP. Код пишется в лог только в dev-режиме, то есть когда
    почта выключена или домен уведомлений не зарегистрирован; при включённой
    почте несостоявшаяся отправка попадает только в error-лог.
    """
    settings = get_settings().auth
    redis = get_redis_adapter(request)

    rate_key = _otp_request_rate_key(body.email)
    try:
        request_count = await redis.incr(rate_key)
        if request_count == 1:
            await redis.expire(rate_key, 60)
        elif await redis.ttl(rate_key) == -1:
            # INCR и EXPIRE неатомарны: падение между ними оставляет ключ без
            # TTL, и счётчик залипает навсегда. Дотягиваем TTL при первой же
            # встрече такого ключа.
            await redis.expire(rate_key, 60)
    except Exception as exc:
        logger.error("Ошибка проверки лимита запросов OTP в Redis: %s", exc)
        return JSONResponse(
            status_code=503,
            content={"success": False, "error": REDIS_UNAVAILABLE_ERROR},
        )

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

    # Отправка OTP на email через фабрику домена уведомлений. Домен может быть
    # не зарегистрирован (отключён) — вход от этого падать не должен: код
    # уйдёт в лог, как в dev-режиме.
    from app.core.settings_registry import get as get_domain_settings
    from app.domains.notifications.settings import NotificationsSettings

    try:
        email_enabled = get_domain_settings("notifications", NotificationsSettings).email.enabled
    except KeyError:
        email_enabled = False

    email_configured = email_enabled and has_factory("notifications.email")
    if email_configured:
        email_sent = False
        subject, body_html = build_otp_email(otp, settings.otp_ttl // 60)
        try:
            async for email_svc in get_factory("notifications.email")():
                email_sent = await email_svc.send_email(
                    to=user["email"],
                    subject=subject,
                    body=body_html,
                )
        except Exception as exc:
            logger.error("Ошибка отправки ОТП-письма для %s: %s", user["email"], exc)

        if email_sent:
            logger.info("OTP отправлен на email %s", user["email"])
        else:
            # Клиенту сбой не раскрываем: ответ «письмо не ушло» только для
            # существующих email снова стал бы оракулом. Живой код в прод-лог
            # не пишем — забрать его должен только владелец почты.
            logger.error(
                "Не удалось отправить ОТП-письмо для %s — код пользователю не доставлен",
                user["email"],
            )
    else:
        # Почта выключена или домен уведомлений не зарегистрирован —
        # код забирают из лога (dev-режим).
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
    repo: AuthUserDirectory = Depends(get_user_repository),
):
    """Проверяет OTP-код и выдаёт JWT-токены для входа.

    При успехе:
        - удаляет OTP из Redis (одноразовый)
        - создаёт access + refresh токены
        - устанавливает HttpOnly cookie
        - возвращает профиль пользователя

    Число неверных попыток ограничено (AUTH__OTP_MAX_ATTEMPTS): по достижении
    лимита код инвалидируется досрочно (нужно запросить новый). Все отказы
    отвечают одним текстом (OTP_INVALID_ERROR) — по ответу нельзя отличить
    незарегистрированный email от неверного или истёкшего кода.
    """
    settings = get_settings().auth
    user = await repo.find_by_email(body.email)
    logger.info("verify_otp: email=%s, found user=%s", body.email, user and user["id"])
    if user is None:
        return JSONResponse(
            status_code=401,
            content={"success": False, "error": OTP_INVALID_ERROR},
        )

    redis = get_redis_adapter(request)
    otp_key = _otp_key(user["id"])
    attempts_key = _otp_attempts_key(user["id"])
    try:
        stored_otp = await redis.get(otp_key)
        if stored_otp is None:
            return JSONResponse(
                status_code=401,
                content={"success": False, "error": OTP_INVALID_ERROR},
            )
        # Сравнение за постоянное время: обычное != завершается на первом
        # несовпавшем символе и по времени ответа подсказывает верный префикс.
        # encode обязателен — compare_digest на str падает при не-ASCII вводе.
        if not secrets.compare_digest(stored_otp.encode(), body.otp.encode()):
            logger.warning("Неверный OTP для пользователя %s", user["id"])
            attempts = await redis.incr(attempts_key)
            if attempts == 1:
                await redis.expire(attempts_key, settings.otp_ttl)
            elif await redis.ttl(attempts_key) == -1:
                # Счётчик без TTL (падение между INCR и EXPIRE) залипнет
                # навсегда и заблокирует все следующие коды — лечим на месте.
                await redis.expire(attempts_key, settings.otp_ttl)
            if attempts >= settings.otp_max_attempts:
                await redis.delete(otp_key, attempts_key)
            return JSONResponse(
                status_code=401,
                content={"success": False, "error": OTP_INVALID_ERROR},
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
            content={"success": False, "error": OTP_INVALID_ERROR},
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
async def refresh_tokens(
    request: Request,
    repo: AuthUserDirectory = Depends(get_user_repository),
):
    """Обновляет пару токенов по refresh_token из cookie.

    Новые токены уходят только в HttpOnly-cookie: в теле ответа их нет, иначе
    любой скрипт на странице смог бы их прочитать и HttpOnly обесценился бы.
    """
    refresh_token = request.cookies.get("refresh_token")
    if not refresh_token:
        raise HTTPException(status_code=401, detail="Refresh-токен отсутствует в cookie")

    jwt_handler = get_jwt_handler()
    payload = jwt_handler.decode_token(refresh_token)
    if payload is None or payload.token_type != "refresh":
        raise HTTPException(status_code=401, detail="Невалидный refresh-токен")

    tokens = jwt_handler.create_token_pair(payload.sub)

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
        content={"success": True, "user": user_data},
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


@router.get("/me")
async def get_current_user_me(
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Возвращает текущего пользователя для проверки авторизации.

    Работает одинаково в обоих режимах: get_current_user собирает контекст
    из БД либо, при AUTH__ENABLED=false, из окружения — фото профиля
    подхватывается в обоих случаях, ключ у него один (логин).
    """
    return {
        "authenticated": True,
        "username": user.login,
        "sub": user.sub,
        "email": user.email,
        "login": user.login,
        "fullname": user.fullname,
        "job": user.job,
        "teams": user.teams,
        "roles": user.roles,
        "avatar_version": await _read_avatar_version(user.login),
    }


# ---------------------------------------------------------------------------
# ФОТО ПРОФИЛЯ
# ---------------------------------------------------------------------------


async def get_avatar_repository():
    """Репозиторий фото профиля — фабрика admin-домена.

    Таблица принадлежит admin-домену, а обращается к ней слой авторизации,
    поэтому связь идёт через реестр фабрик (как acts → admin.user_directory),
    а не прямым импортом.
    """
    factory = get_factory("admin.user_avatars")
    async for repo in factory():
        yield repo


async def get_request_username(request: Request) -> str:
    """Username текущего пользователя (401, если не авторизован).

    Импорт отложен внутрь функции сознательно: ``app.api.v1.routes``
    подключает этот роутер, поэтому импорт ``app.api`` на уровне модуля
    замкнул бы цикл.
    """
    from app.api.v1.deps.auth_deps import get_username

    return await get_username(request)


async def _invalidate_user_cache(username: str) -> None:
    """Сбрасывает кеш ролей и user-контекста, из которого /me берёт версию фото.

    Без сброса пользователь видел бы прежнюю аватарку до истечения TTL.
    Импорт отложен по той же причине, что и в ``get_request_username``.
    """
    from app.api.v1.deps.role_deps import invalidate_user_roles_cache

    await invalidate_user_roles_cache(username)


async def _read_avatar_version(username: str) -> int | None:
    """Версия фото пользователя (unix-время загрузки) или None, если фото нет.

    Отдельно от ``get_avatar_repository``: /me вызывается на каждой загрузке
    страницы и обязан отвечать даже там, где admin-домен не зарегистрирован
    (минимальное приложение в тестах, отключённый домен) — тогда просто
    «фото нет».
    """
    if not has_factory("admin.user_avatars"):
        return None

    async with aclosing(get_factory("admin.user_avatars")()) as gen:
        async for repo in gen:
            updated_at = await repo.get_updated_at(username)
            return int(updated_at.timestamp()) if updated_at else None
    return None


async def _read_upload_limited(upload: UploadFile, limit: int) -> bytes:
    """Читает загружаемый файл кусками, обрываясь на превышении лимита.

    Ограничивает то, что окажется в памяти: ``await upload.read()`` без
    аргумента поднял бы файл целиком, каким бы он ни был.
    """
    chunks: list[bytes] = []
    total = 0
    while chunk := await upload.read(AVATAR_UPLOAD_CHUNK_BYTES):
        total += len(chunk)
        if total > limit:
            raise HTTPException(status_code=413, detail=AVATAR_TOO_LARGE_ERROR)
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/avatar")
async def upload_avatar(
    file: UploadFile = File(...),
    username: str = Depends(get_request_username),
    repo=Depends(get_avatar_repository),
) -> dict:
    """Загружает фото профиля текущего пользователя.

    Только своё: пользователь берётся из авторизации, а не из тела запроса.
    Изображение нормализуется до квадратного JPEG (см. avatar_image) —
    в БД не попадает ни исходный формат, ни EXIF.
    """
    raw = await _read_upload_limited(file, AVATAR_MAX_UPLOAD_BYTES)
    if not raw:
        raise HTTPException(status_code=422, detail="Файл пустой")

    try:
        image = process_avatar_image(raw)
    except AvatarImageError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    await repo.upsert(username, image, AVATAR_MIME)
    await _invalidate_user_cache(username)
    logger.info("Пользователь %s обновил фото профиля", username)

    version = await repo.get_updated_at(username)
    return {"avatar_version": int(version.timestamp()) if version else None}


@router.delete("/avatar")
async def delete_avatar(
    username: str = Depends(get_request_username),
    repo=Depends(get_avatar_repository),
) -> dict:
    """Убирает фото профиля текущего пользователя.

    Идемпотентно: повторный вызов без фото — тот же 200, ``removed=false``.
    """
    removed = await repo.delete(username)
    if removed:
        await _invalidate_user_cache(username)
        logger.info("Пользователь %s удалил фото профиля", username)
    return {"removed": removed}


@router.get("/avatar/{username}")
async def get_avatar(
    username: str,
    _viewer: str = Depends(get_request_username),
    repo=Depends(get_avatar_repository),
) -> Response:
    """Отдаёт фото профиля пользователя.

    Чужое фото видно так же, как ФИО в справочнике, — своим отдельным
    эндпоинт не ограничен. Запрос параметра ``?v=`` не разбирает: версия
    нужна только браузеру, чтобы обойти собственный кеш после смены фото.
    """
    avatar = await repo.get(username)
    if avatar is None:
        raise HTTPException(status_code=404, detail="Фото профиля не найдено")

    return Response(
        content=bytes(avatar["image"]),
        media_type=avatar["mime"],
        headers={"Cache-Control": AVATAR_CACHE_CONTROL},
    )
