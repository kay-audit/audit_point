"""API-эндпоинты auth-домена: login, logout, /me, change-password, avatar, /me/password."""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import (
    APIRouter,
    Cookie,
    Depends,
    File,
    HTTPException,
    Request,
    Response,
    UploadFile,
    status,
)

from app.core.settings_registry import get as get_domain_settings
from app.db.connection import get_db
from app.domains.auth.schemas import (
    AdminResetPasswordRequest,
    AdminResetPasswordResponse,
    ChangePasswordRequest,
    LoginRequest,
    LoginResponse,
    MeResponse,
    UserInfoResponse,
)
from app.domains.auth.services.auth_service import (
    AuthService,
    InvalidCredentialsError,
    InvalidOldPasswordError,
    UserNotFoundError,
)
from app.domains.auth.settings import AuthSettings

logger = logging.getLogger("audit_workstation.api.auth")
router = APIRouter()


def get_api_routers():
    """Возвращает список API-роутеров домена (для DomainDescriptor.api_routers)."""
    return [
        (router, "/auth", ["Авторизация"]),
    ]


async def _service() -> AuthService:
    async with get_db() as conn:
        return AuthService(conn)


async def _service_from_conn(conn) -> AuthService:
    return AuthService(conn)


def _settings() -> AuthSettings:
    return get_domain_settings("auth", AuthSettings)


def _cookie_params() -> dict:
    s = _settings()
    return {
        "key": s.session_cookie_name,
        "httponly": True,
        "samesite": "lax",
        "secure": s.session_cookie_secure,
        "path": "/",
    }


# ---------- login / logout ----------


@router.post("/login", response_model=LoginResponse)
async def login(body: LoginRequest, response: Response):
    """Логин по username+password. Ставит cookie с сессионным токеном."""
    async with get_db() as conn:
        svc = AuthService(conn)
        try:
            user = await svc.authenticate(body.username, body.password)
        except InvalidCredentialsError as e:
            raise HTTPException(status_code=401, detail=str(e))
        token, expires_at = await svc.create_session(body.username)
    params = _cookie_params()
    response.set_cookie(
        value=token,
        max_age=int((expires_at.timestamp() - _now_ts())),
        **params,
    )
    return LoginResponse(**user)


def _now_ts() -> float:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).timestamp()


@router.post("/logout", status_code=204)
async def logout(response: Response, request: Request):
    """Логаут: удаляет сессию и очищает cookie."""
    s = _settings()
    token = request.cookies.get(s.session_cookie_name)
    if token:
        async with get_db() as conn:
            svc = AuthService(conn)
            await svc.logout(token)
    response.delete_cookie(s.session_cookie_name, path="/")
    return Response(status_code=204)


# ---------- /me ----------


async def _read_token(request: Request) -> Optional[str]:
    s = _settings()
    return request.cookies.get(s.session_cookie_name)


async def get_current_username(request: Request) -> Optional[str]:
    """Возвращает username из сессионной cookie, или None."""
    token = await _read_token(request)
    if not token:
        return None
    async with get_db() as conn:
        svc = AuthService(conn)
        sess = await svc.resolve_session(token)
    return sess["username"] if sess else None


@router.get("/me", response_model=MeResponse)
async def me(request: Request):
    """Возвращает профиль текущего авторизованного пользователя.

    Если сессии нет — authenticated=false (без 401, чтобы фронт мог
    отрисовать страницу логина без редиректа).
    """
    username = await get_current_username(request)
    if not username:
        return MeResponse(authenticated=False)
    async with get_db() as conn:
        svc = AuthService(conn)
        info = await svc.build_me(username)
    return MeResponse(**info)


@router.get("/me/password")
async def me_password(request: Request):
    """Возвращает собственный пароль в открытом виде (Fernet-расшифровка).

    Доступно только владельцу. Пометка в UI: «пароль виден только вам».
    Если шифрование не настроено (нет fernet_key) — 404.
    """
    username = await get_current_username(request)
    if not username:
        raise HTTPException(status_code=401, detail="Требуется авторизация")
    async with get_db() as conn:
        svc = AuthService(conn)
        pwd = await svc.get_own_password(username)
    if pwd is None:
        raise HTTPException(
            status_code=404,
            detail="Пароль не может быть показан (нет шифрования или пароль не записан)",
        )
    return {"username": username, "password": pwd}


# ---------- change-password ----------


@router.post("/me/change-password", status_code=200)
async def change_password(body: ChangePasswordRequest, request: Request):
    """Смена собственного пароля (требует знание текущего)."""
    username = await get_current_username(request)
    if not username:
        raise HTTPException(status_code=401, detail="Требуется авторизация")
    if body.old_password == body.new_password:
        raise HTTPException(
            status_code=400, detail="Новый пароль совпадает со старым",
        )
    async with get_db() as conn:
        svc = AuthService(conn)
        try:
            await svc.change_password(username, body.old_password, body.new_password)
        except InvalidOldPasswordError as e:
            raise HTTPException(status_code=400, detail=str(e))
    return {"changed": True, "detail": "Пароль изменён; залогиньтесь заново"}


# ---------- avatar ----------


@router.get("/me/avatar")
async def me_avatar(request: Request):
    """Аватар текущего пользователя (image/*) или 404."""
    username = await get_current_username(request)
    if not username:
        raise HTTPException(status_code=401, detail="Требуется авторизация")
    async with get_db() as conn:
        svc = AuthService(conn)
        av = await svc.get_avatar(username)
    if not av:
        raise HTTPException(status_code=404, detail="Аватар не задан")
    data, mime = av
    return Response(content=data, media_type=mime)


@router.put("/me/avatar")
async def me_avatar_upload(
    request: Request,
    file: UploadFile = File(...),
):
    """Загрузка/замена своей аватарки."""
    username = await get_current_username(request)
    if not username:
        raise HTTPException(status_code=401, detail="Требуется авторизация")
    s = _settings()
    if file.content_type not in s.avatar_allowed_mime:
        raise HTTPException(
            status_code=400,
            detail=f"Недопустимый тип файла: {file.content_type}",
        )
    data = await file.read()
    if len(data) > s.avatar_max_size_bytes:
        raise HTTPException(
            status_code=400,
            detail=f"Слишком большой файл: {len(data)} > {s.avatar_max_size_bytes}",
        )
    async with get_db() as conn:
        svc = AuthService(conn)
        await svc.set_avatar(username, data, file.content_type)
    return {"uploaded": True, "size": len(data), "mime": file.content_type}


@router.delete("/me/avatar", status_code=204)
async def me_avatar_delete(request: Request):
    """Удаление своей аватарки."""
    username = await get_current_username(request)
    if not username:
        raise HTTPException(status_code=401, detail="Требуется авторизация")
    async with get_db() as conn:
        svc = AuthService(conn)
        await svc.clear_avatar(username)
    return Response(status_code=204)


# ---------- admin: reset / info ----------


async def _require_admin(request: Request) -> str:
    from app.api.v1.deps.role_deps import require_admin

    username = await get_current_username(request)
    if not username:
        raise HTTPException(status_code=401, detail="Требуется авторизация")
    # Переиспользуем существующий require_admin() — он проверяет роли в БД.
    async with get_db() as conn:
        svc = AuthService(conn)
        if not await svc.is_admin(username):
            raise HTTPException(status_code=403, detail="Требуется роль Админ")
    return username


@router.post(
    "/admin/users/{username}/reset-password",
    response_model=AdminResetPasswordResponse,
    dependencies=[],  # проверка в _require_admin ниже
)
async def admin_reset_password(
    username: str,
    body: AdminResetPasswordRequest,
    request: Request,
):
    """Сброс пароля пользователя (только админ). Возвращает новый пароль один раз."""
    await _require_admin(request)
    async with get_db() as conn:
        svc = AuthService(conn)
        try:
            pwd = await svc.reset_password(username, body.new_password)
        except UserNotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e))
    return AdminResetPasswordResponse(username=username, new_password=pwd)


@router.get("/users/{username}", response_model=UserInfoResponse)
async def public_user_info(username: str, request: Request):
    """Публичная карточка пользователя (ФИО, должность, логин, наличие аватарки)."""
    await get_current_username(request)  # требуем авторизацию
    async with get_db() as conn:
        svc = AuthService(conn)
        try:
            info = await svc.user_info(username)
        except UserNotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e))
    return UserInfoResponse(**info)


@router.get("/users/{username}/avatar")
async def user_avatar(username: str):
    """Аватар произвольного пользователя (для отрисовки в списках)."""
    async with get_db() as conn:
        svc = AuthService(conn)
        av = await svc.get_avatar(username)
    if not av:
        raise HTTPException(status_code=404, detail="Аватар не задан")
    data, mime = av
    return Response(content=data, media_type=mime)
