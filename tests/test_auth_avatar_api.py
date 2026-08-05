"""Тесты эндпоинтов фото профиля: POST/DELETE/GET /auth/avatar и /auth/me.

Приложение поднимается минимальное (FastAPI + auth-роутер), репозиторий и
получение username подменяются через ``dependency_overrides`` — образец
взят из tests/domains/chat/test_chat_api_e2e.py.
"""

from __future__ import annotations

import datetime as dt
import io
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.auth.avatar_image import (
    AVATAR_MAX_UPLOAD_BYTES,
    AVATAR_SIZE_PX,
    AvatarImageError,
    process_avatar_image,
)
from app.auth.dependencies import get_current_user
from app.auth.router import get_avatar_repository, get_request_username
from app.auth.router import router as auth_router
from app.auth.value_objects import UserContext
from app.core.domain_registry import register_factory, reset_registry

USERNAME = "12345"

# Момент последней загрузки фото и та же метка в виде avatar_version.
UPLOADED_AT = dt.datetime(2026, 7, 31, 12, 0, 0)
UPLOADED_VERSION = int(UPLOADED_AT.timestamp())


@pytest.fixture(autouse=True)
def clean_registry():
    """Реестр фабрик — глобальное состояние, чистим вокруг каждого теста."""
    reset_registry()
    yield
    reset_registry()


def _png_bytes(size=(400, 200), mode="RGBA", color=(200, 30, 30, 255)) -> bytes:
    """Картинка в памяти для загрузки."""
    buffer = io.BytesIO()
    Image.new(mode, size, color).save(buffer, format="PNG")
    return buffer.getvalue()


def _make_repo(avatar: dict | None = None) -> AsyncMock:
    """Мок UserAvatarRepository с предсказуемыми ответами."""
    repo = AsyncMock()
    repo.get.return_value = avatar
    repo.get_updated_at.return_value = avatar["updated_at"] if avatar else None
    repo.upsert.return_value = None
    repo.delete.return_value = avatar is not None
    return repo


def _make_client(repo: AsyncMock, username: str = USERNAME) -> TestClient:
    """Минимальное приложение с auth-роутером и подменёнными зависимостями."""
    app = FastAPI()
    app.include_router(auth_router, prefix="/auth")
    app.dependency_overrides[get_request_username] = lambda: username
    app.dependency_overrides[get_avatar_repository] = lambda: repo
    return TestClient(app)


class TestUploadAvatar:
    """POST /auth/avatar — загрузка своего фото."""

    def test_saves_normalized_jpeg(self):
        repo = _make_repo({"image": b"x", "mime": "image/jpeg", "updated_at": UPLOADED_AT})
        client = _make_client(repo)

        with patch(
            "app.api.v1.deps.role_deps.invalidate_user_roles_cache",
            new=AsyncMock(),
        ):
            resp = client.post("/auth/avatar", files={"file": ("me.png", _png_bytes(), "image/png")})

        assert resp.status_code == 200
        assert resp.json() == {"avatar_version": UPLOADED_VERSION}

        repo.upsert.assert_awaited_once()
        saved_user, saved_image, saved_mime = repo.upsert.await_args.args
        assert saved_user == USERNAME
        assert saved_mime == "image/jpeg"
        # В БД уходит уже нормализованный квадрат, а не исходный PNG.
        stored = Image.open(io.BytesIO(saved_image))
        assert stored.format == "JPEG"
        assert stored.size == (AVATAR_SIZE_PX, AVATAR_SIZE_PX)

    def test_invalidates_user_cache(self):
        """Загрузка фото сбрасывает кеш userctx (роли/ФИО/должность).

        Версия фото при этом не кэшируется и всегда свежая — сброс не про неё.
        """
        repo = _make_repo({"image": b"x", "mime": "image/jpeg", "updated_at": UPLOADED_AT})
        client = _make_client(repo)
        invalidate = AsyncMock()

        with patch("app.api.v1.deps.role_deps.invalidate_user_roles_cache", new=invalidate):
            client.post("/auth/avatar", files={"file": ("me.png", _png_bytes(), "image/png")})

        invalidate.assert_awaited_once_with(USERNAME)

    def test_not_an_image_rejected(self):
        repo = _make_repo()
        client = _make_client(repo)

        resp = client.post(
            "/auth/avatar",
            files={"file": ("virus.exe", b"MZ\x90\x00 not an image", "image/png")},
        )

        assert resp.status_code == 422
        assert "изображени" in resp.json()["detail"].lower()
        repo.upsert.assert_not_awaited()

    def test_empty_file_rejected(self):
        repo = _make_repo()
        client = _make_client(repo)

        resp = client.post("/auth/avatar", files={"file": ("empty.png", b"", "image/png")})

        assert resp.status_code == 422
        repo.upsert.assert_not_awaited()

    def test_too_large_rejected(self):
        """Файл сверх лимита обрывается на чтении и до Pillow не доходит."""
        repo = _make_repo()
        client = _make_client(repo)
        oversized = b"\x00" * (AVATAR_MAX_UPLOAD_BYTES + 1024)

        resp = client.post("/auth/avatar", files={"file": ("big.png", oversized, "image/png")})

        assert resp.status_code == 413
        assert "МБ" in resp.json()["detail"]
        repo.upsert.assert_not_awaited()

    def test_anonymous_rejected(self):
        """Без подмены get_request_username аноним получает 401, а не запись в БД."""
        repo = _make_repo()
        app = FastAPI()
        app.include_router(auth_router, prefix="/auth")
        app.dependency_overrides[get_avatar_repository] = lambda: repo

        resp = TestClient(app).post(
            "/auth/avatar",
            files={"file": ("me.png", _png_bytes(), "image/png")},
        )

        assert resp.status_code == 401
        repo.upsert.assert_not_awaited()


class TestDeleteAvatar:
    """DELETE /auth/avatar — удаление своего фото, идемпотентно."""

    def test_removes_existing(self):
        repo = _make_repo({"image": b"x", "mime": "image/jpeg", "updated_at": UPLOADED_AT})
        client = _make_client(repo)
        invalidate = AsyncMock()

        with patch("app.api.v1.deps.role_deps.invalidate_user_roles_cache", new=invalidate):
            resp = client.delete("/auth/avatar")

        assert resp.status_code == 200
        assert resp.json() == {"removed": True}
        repo.delete.assert_awaited_once_with(USERNAME)
        invalidate.assert_awaited_once_with(USERNAME)

    def test_second_call_is_ok(self):
        """Фото уже нет — тот же 200, removed=false, кеш трогать незачем."""
        repo = _make_repo(None)
        client = _make_client(repo)
        invalidate = AsyncMock()

        with patch("app.api.v1.deps.role_deps.invalidate_user_roles_cache", new=invalidate):
            resp = client.delete("/auth/avatar")

        assert resp.status_code == 200
        assert resp.json() == {"removed": False}
        invalidate.assert_not_awaited()


class TestGetAvatar:
    """GET /auth/avatar/{username} — просмотр фото, в том числе чужого."""

    def test_returns_bytes_with_mime_and_cache_headers(self):
        image = _png_bytes(size=(10, 10))
        repo = _make_repo({"image": image, "mime": "image/jpeg", "updated_at": UPLOADED_AT})
        client = _make_client(repo)

        resp = client.get("/auth/avatar/67890")

        assert resp.status_code == 200
        assert resp.content == image
        assert resp.headers["content-type"] == "image/jpeg"
        assert resp.headers["cache-control"] == "private, max-age=86400"
        repo.get.assert_awaited_once_with("67890")

    def test_version_query_param_ignored(self):
        """?v= нужен только браузеру — сервер его не разбирает."""
        repo = _make_repo({"image": b"jpegbytes", "mime": "image/jpeg", "updated_at": UPLOADED_AT})
        client = _make_client(repo)

        resp = client.get(f"/auth/avatar/{USERNAME}?v={UPLOADED_VERSION}")

        assert resp.status_code == 200
        repo.get.assert_awaited_once_with(USERNAME)

    def test_missing_avatar_is_404(self):
        repo = _make_repo(None)
        client = _make_client(repo)

        resp = client.get("/auth/avatar/67890")

        assert resp.status_code == 404


class TestMeAvatarVersion:
    """GET /auth/me отдаёт avatar_version — по нему фронт строит ?v=."""

    @staticmethod
    def _client_with_factory(repo: AsyncMock | None) -> TestClient:
        """Приложение, где фото достаётся не через Depends, а через фабрику.

        /me обязан отвечать и там, где admin-домен не поднят, поэтому версия
        читается через реестр фабрик, а не через зависимость роутера.
        """
        app = FastAPI()
        app.include_router(auth_router, prefix="/auth")
        app.dependency_overrides[get_current_user] = lambda: UserContext(
            sub=USERNAME, email="", login=USERNAME, fullname="Иванов И.И.", job="Аудитор",
        )
        if repo is not None:
            register_factory("admin.user_avatars", lambda: repo)
        return TestClient(app)

    def test_returns_version_when_avatar_exists(self):
        repo = _make_repo({"image": b"x", "mime": "image/jpeg", "updated_at": UPLOADED_AT})

        resp = self._client_with_factory(repo).get("/auth/me")

        assert resp.status_code == 200
        assert resp.json()["avatar_version"] == UPLOADED_VERSION

    def test_returns_null_when_no_avatar(self):
        resp = self._client_with_factory(_make_repo(None)).get("/auth/me")

        assert resp.json()["avatar_version"] is None

    def test_returns_null_when_admin_domain_absent(self):
        """Домен не зарегистрирован — /me отвечает как обычно, без фото."""
        resp = self._client_with_factory(None).get("/auth/me")

        assert resp.status_code == 200
        assert resp.json()["avatar_version"] is None


class TestProcessAvatarImage:
    """Нормализация изображения: квадрат, JPEG, без прозрачности и EXIF."""

    def test_crops_to_square_jpeg(self):
        result = process_avatar_image(_png_bytes(size=(800, 200)))

        image = Image.open(io.BytesIO(result))
        assert image.format == "JPEG"
        assert image.size == (AVATAR_SIZE_PX, AVATAR_SIZE_PX)
        assert image.mode == "RGB"

    def test_transparency_flattened_to_white(self):
        """Прозрачные области без подложки ушли бы в JPEG чёрными."""
        transparent = _png_bytes(size=(64, 64), mode="RGBA", color=(0, 0, 0, 0))

        image = Image.open(io.BytesIO(process_avatar_image(transparent)))

        assert image.mode == "RGB"
        assert image.getpixel((128, 128)) == (255, 255, 255)

    def test_exif_dropped_on_resave(self):
        """Пересохранение выбрасывает EXIF целиком — в том числе геометки."""
        source = Image.new("RGB", (300, 300), (10, 20, 30))
        buffer = io.BytesIO()
        source.save(buffer, format="JPEG", exif=Image.Exif())

        result = Image.open(io.BytesIO(process_avatar_image(buffer.getvalue())))

        assert not result.getexif()

    def test_broken_file_raises(self):
        with pytest.raises(AvatarImageError):
            process_avatar_image(b"\x89PNG\r\n\x1a\n broken tail")
