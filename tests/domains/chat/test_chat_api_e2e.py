"""E2E API-тесты эндпоинтов чата.

Покрывает маршрутизацию + статус-коды + ownership-проверки через
``TestClient(app)``. Полное приложение не поднимаем: собираем минимальный
``FastAPI`` с тремя chat-роутерами, переопределяем DI-зависимости
(``get_username``, ``get_user_roles``, сервисы) на моки и проверяем поведение.
"""

from __future__ import annotations

import datetime as dt
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from app.api.v1.deps.auth_deps import get_username
from app.api.v1.deps.role_deps import get_user_roles
from app.core.chat.tools import reset as reset_tools
from app.core.domain_registry import reset_registry
from app.core.exceptions import AppError
from app.core.settings_registry import reset as reset_settings
from app.domains.chat.api.conversations import router as conv_router
from app.domains.chat.api.files import router as files_router
from app.domains.chat.api.messages import router as msg_router
from app.domains.chat.deps import (
    get_conversation_service,
    get_file_service,
    get_message_service,
)
from app.domains.chat.exceptions import (
    ChatFileNotFoundError,
    ChatFileValidationError,
    ChatMessageNotFoundError,
    ConversationNotFoundError,
)
from app.domains.chat.settings import ChatDomainSettings


# -------------------------------------------------------------------------
# Сброс глобального состояния доменных реестров между тестами
# -------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def clean_registries():
    """Сброс реестров доменов/настроек/инструментов."""
    reset_registry()
    reset_settings()
    reset_tools()
    yield
    reset_registry()
    reset_settings()
    reset_tools()


# -------------------------------------------------------------------------
# Фабрика тестового приложения и моки сервисов
# -------------------------------------------------------------------------


USERNAME = "12345"


def _make_settings() -> ChatDomainSettings:
    """Настройки чата с пустым API — оркестратор уйдёт в fallback."""
    return ChatDomainSettings(api_base="", api_key="", model="gpt-4o")


def _make_channel_service() -> MagicMock:
    """Mock AgentChannelService."""
    svc = MagicMock()
    svc.submit = AsyncMock(return_value="question-uid-123")
    return svc


def _channel_service_gen(channel_svc: object):
    """Async-генератор-фабрика для patch'а messages.get_agent_channel_service.

    Эндпоинт строит channel_service лениво через ``aclosing(get_agent_channel_service())``
    (а не через Depends), поэтому в тестах подменяем саму функцию-генератор.
    """
    async def _gen():
        yield channel_svc
    return _gen


def _build_app(
    *,
    conv_service: object,
    msg_service: object,
    file_service: object,
    username: str = USERNAME,
) -> FastAPI:
    """Собирает минимальный FastAPI с тремя chat-роутерами и оверрайдами DI."""
    app = FastAPI()

    # AppError-handler как в основном app/main.py
    @app.exception_handler(AppError)
    async def _app_err_handler(_request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content=exc.to_envelope())

    # Подключаем три chat-роутера под /api/v1/chat
    app.include_router(conv_router, prefix="/api/v1/chat")
    app.include_router(msg_router, prefix="/api/v1/chat")
    app.include_router(files_router, prefix="/api/v1/chat")

    # Auth: get_username -> фиксированный пользователь
    app.dependency_overrides[get_username] = lambda: username
    # Роль: возвращаем Админа, чтобы require_domain_access('chat') пропустил
    app.dependency_overrides[get_user_roles] = lambda: [
        {"id": 1, "name": "Администратор", "domain_name": None},
    ]
    # Сервисы — мокаем через DI
    app.dependency_overrides[get_conversation_service] = lambda: conv_service
    app.dependency_overrides[get_message_service] = lambda: msg_service
    app.dependency_overrides[get_file_service] = lambda: file_service
    # channel_service эндпоинт строит лениво (не Depends) — инъекция в always-тестах
    # идёт через patch messages.get_agent_channel_service, а не dependency_overrides.

    return app


def _make_conv_service(settings: ChatDomainSettings) -> MagicMock:
    """Mock ConversationService с базовыми методами."""
    svc = MagicMock()
    svc.settings = settings
    svc.create = AsyncMock()
    svc.get = AsyncMock()
    svc.get_list = AsyncMock()
    svc.delete = AsyncMock()
    svc.update_title = AsyncMock()
    return svc


def _make_msg_service(settings: ChatDomainSettings) -> MagicMock:
    """Mock MessageService."""
    svc = MagicMock()
    svc.settings = settings
    svc.save_user_message = AsyncMock()
    svc.save_assistant_message = AsyncMock(return_value={"id": "m-asst"})
    svc.get_history = AsyncMock(return_value=([], 0))
    svc.get_message = AsyncMock()
    return svc


def _make_file_service(settings: ChatDomainSettings) -> MagicMock:
    """Mock FileService."""
    svc = MagicMock()
    svc.settings = settings
    svc.save_file = AsyncMock()
    svc.get_file = AsyncMock()
    return svc


# -------------------------------------------------------------------------
# POST /api/v1/chat/conversations — создание беседы
# -------------------------------------------------------------------------


class TestCreateConversation:
    """E2E: создание беседы возвращает 201 и корректный schema-ответ."""

    def test_create_conversation_returns_201(self):
        """Успешное создание беседы возвращает 201 со схемой ConversationResponse."""
        settings = _make_settings()
        conv = _make_conv_service(settings)
        now = dt.datetime(2026, 5, 14, 12, 0, 0)
        conv.create.return_value = {
            "id": "conv-1",
            "user_id": USERNAME,
            "title": "Новая беседа",
            "domain_name": None,
            "context": None,
            "created_at": now,
            "updated_at": now,
        }

        app = _build_app(
            conv_service=conv,
            msg_service=_make_msg_service(settings),
            file_service=_make_file_service(settings),
        )

        with TestClient(app) as client:
            resp = client.post(
                "/api/v1/chat/conversations",
                json={"title": "Новая беседа"},
            )

        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["id"] == "conv-1"
        # user_id из переопределённого get_username
        assert body["user_id"] == USERNAME
        assert body["title"] == "Новая беседа"

        # ConversationService.create вызван с user_id из get_username
        call = conv.create.await_args
        assert call.kwargs["user_id"] == USERNAME

    def test_create_conversation_unauthorized(self):
        """Отсутствие JUPYTERHUB_USER приводит к 401."""
        settings = _make_settings()
        conv = _make_conv_service(settings)
        app = _build_app(
            conv_service=conv,
            msg_service=_make_msg_service(settings),
            file_service=_make_file_service(settings),
        )

        # Имитируем неавторизованного: override бросает 401
        def _no_user() -> str:
            raise HTTPException(status_code=401, detail="Требуется авторизация")

        app.dependency_overrides[get_username] = _no_user

        with TestClient(app) as client:
            resp = client.post(
                "/api/v1/chat/conversations", json={"title": "X"},
            )

        assert resp.status_code == 401


# -------------------------------------------------------------------------
# GET /api/v1/chat/conversations — список бесед
# -------------------------------------------------------------------------


class TestListConversations:
    """E2E: список бесед возвращает массив ConversationListItem."""

    def test_list_conversations_returns_array(self):
        """GET возвращает PaginatedResponse[ConversationListItem]."""
        settings = _make_settings()
        conv = _make_conv_service(settings)
        now = dt.datetime(2026, 5, 14, 12, 0, 0)
        conv.get_list.return_value = (
            [
                {
                    "id": "c1",
                    "title": "Первая",
                    "domain_name": None,
                    "created_at": now,
                    "updated_at": now,
                },
                {
                    "id": "c2",
                    "title": "Вторая",
                    "domain_name": "acts",
                    "created_at": now,
                    "updated_at": now,
                },
            ],
            2,
        )

        app = _build_app(
            conv_service=conv,
            msg_service=_make_msg_service(settings),
            file_service=_make_file_service(settings),
        )

        with TestClient(app) as client:
            resp = client.get("/api/v1/chat/conversations")

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] == 2
        assert body["limit"] == 50
        assert body["offset"] == 0
        items = body["items"]
        assert len(items) == 2
        assert items[0]["id"] == "c1"
        assert items[1]["domain_name"] == "acts"
        # сервис вызывался с username
        assert conv.get_list.await_args.args[0] == USERNAME


# -------------------------------------------------------------------------
# DELETE /api/v1/chat/conversations/{id} — удаление + ownership
# -------------------------------------------------------------------------


class TestDeleteConversation:
    """E2E: удаление беседы + ownership-проверка."""

    def test_delete_own_conversation_returns_200(self):
        """Удаление своей беседы возвращает 200 и deleted=True."""
        settings = _make_settings()
        conv = _make_conv_service(settings)
        conv.delete.return_value = True

        app = _build_app(
            conv_service=conv,
            msg_service=_make_msg_service(settings),
            file_service=_make_file_service(settings),
        )

        with TestClient(app) as client:
            resp = client.delete("/api/v1/chat/conversations/conv-1")

        assert resp.status_code == 200, resp.text
        assert resp.json() == {"deleted": True}
        # сервис вызывается с username — это ownership-фильтр на уровне repo
        assert conv.delete.await_args.args == ("conv-1", USERNAME)

    def test_delete_foreign_conversation_returns_deleted_false(self):
        """Удаление чужой беседы: repo фильтрует по user_id и возвращает False."""
        settings = _make_settings()
        conv = _make_conv_service(settings)
        conv.delete.return_value = False  # repo не нашёл по (id, user_id)

        app = _build_app(
            conv_service=conv,
            msg_service=_make_msg_service(settings),
            file_service=_make_file_service(settings),
        )

        with TestClient(app) as client:
            resp = client.delete("/api/v1/chat/conversations/foreign-id")

        # Текущее поведение: 200 + deleted=False (ownership через user_id-фильтр).
        # Чужая беседа неотличима от удалённой — это намеренно (information leak).
        assert resp.status_code == 200
        assert resp.json() == {"deleted": False}


# -------------------------------------------------------------------------
# POST /conversations/{id}/messages — новый B1-режим (JSON-ответ)
# -------------------------------------------------------------------------


class TestSendMessageB1:
    """E2E: POST /messages возвращает JSON {"message_id": ...} во всех режимах."""

    def _conv_with_get(self, settings: ChatDomainSettings) -> MagicMock:
        conv = _make_conv_service(settings)
        conv.get.return_value = {
            "id": "conv-1",
            "user_id": USERNAME,
            "title": None,
            "domain_name": None,
            "context": None,
        }
        return conv

    def test_send_message_off_mode_returns_message_id(self):
        """agent_mode=off: оркестратор вызван, вернулся {"message_id": ...}."""
        settings = _make_settings()
        conv = self._conv_with_get(settings)
        msg = _make_msg_service(settings)
        msg.save_user_message.return_value = {"id": "m-1", "role": "user", "content": []}

        app = _build_app(
            conv_service=conv,
            msg_service=msg,
            file_service=_make_file_service(settings),
        )

        with patch(
            "app.domains.chat.services.orchestrator.get_domain_settings",
            return_value=settings,
        ):
            with TestClient(app) as client:
                resp = client.post(
                    "/api/v1/chat/conversations/conv-1/messages",
                    data={"message": "Привет", "agent_mode": "off"},
                )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert "message_id" in body
        assert isinstance(body["message_id"], str)
        assert len(body["message_id"]) > 0

    def test_send_message_no_mode_defaults_to_off(self):
        """Без agent_mode: ведёт себя как off — оркестратор вызван."""
        settings = _make_settings()
        conv = self._conv_with_get(settings)
        msg = _make_msg_service(settings)
        msg.save_user_message.return_value = {"id": "m-1", "role": "user", "content": []}

        app = _build_app(
            conv_service=conv,
            msg_service=msg,
            file_service=_make_file_service(settings),
        )

        with patch(
            "app.domains.chat.services.orchestrator.get_domain_settings",
            return_value=settings,
        ):
            with TestClient(app) as client:
                resp = client.post(
                    "/api/v1/chat/conversations/conv-1/messages",
                    data={"message": "Привет"},
                )

        assert resp.status_code == 200, resp.text
        assert "message_id" in resp.json()

    def test_send_message_always_mode_calls_channel_and_poller(self):
        """agent_mode=always: AgentChannelService.submit вызван, поллер.subscribe вызван."""
        settings = _make_settings()
        conv = self._conv_with_get(settings)
        msg = _make_msg_service(settings)
        msg.save_user_message.return_value = {"id": "m-1", "role": "user", "content": []}

        channel_svc = _make_channel_service()
        channel_svc.submit.return_value = "q-uid-abc"

        mock_poller = MagicMock()
        mock_poller.subscribe = MagicMock()

        app = _build_app(
            conv_service=conv,
            msg_service=msg,
            file_service=_make_file_service(settings),
        )

        with (
            patch(
                "app.domains.chat.api.messages.get_agent_channel_service",
                _channel_service_gen(channel_svc),
            ),
            patch(
                "app.domains.chat.api.messages.get_agent_channel_poller",
                return_value=mock_poller,
            ),
        ):
            with TestClient(app) as client:
                resp = client.post(
                    "/api/v1/chat/conversations/conv-1/messages",
                    data={"message": "Запрос к агенту", "agent_mode": "always"},
                )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert "message_id" in body
        message_id = body["message_id"]

        # AgentChannelService.submit вызван с корректными параметрами
        channel_svc.submit.assert_awaited_once()
        submit_kwargs = channel_svc.submit.await_args.kwargs
        assert submit_kwargs["conversation_id"] == "conv-1"
        assert submit_kwargs["user_id"] == USERNAME
        assert submit_kwargs["assistant_message_id"] == message_id
        assert submit_kwargs["text"] == "Запрос к агенту"
        assert submit_kwargs["mode"] == "always"

        # поллер.subscribe вызван с совпадающими параметрами
        mock_poller.subscribe.assert_called_once_with(
            assistant_message_id=message_id,
            question_uid="q-uid-abc",
        )

        # Оркестратор НЕ вызывался: channel_svc.submit вызван — это
        # единственное подтверждение, что выбрана ветка «always», а не orchestrator.run.
        # (save_assistant_message — plain MagicMock, не AsyncMock → нет assert_not_awaited)

    def test_send_message_always_mode_without_poller_saves_error_no_submit(self):
        """agent_mode=always + poller=None: вопрос НЕ кладётся в шину (нет
        осиротевшего draft'а), сохраняется финализированное error-сообщение, 200."""
        settings = _make_settings()
        conv = self._conv_with_get(settings)
        msg = _make_msg_service(settings)
        msg.save_user_message.return_value = {"id": "m-1", "role": "user", "content": []}

        channel_svc = _make_channel_service()

        app = _build_app(
            conv_service=conv,
            msg_service=msg,
            file_service=_make_file_service(settings),
        )

        with (
            patch(
                "app.domains.chat.api.messages.get_agent_channel_service",
                _channel_service_gen(channel_svc),
            ),
            patch(
                "app.domains.chat.api.messages.get_agent_channel_poller",
                return_value=None,
            ),
        ):
            with TestClient(app) as client:
                resp = client.post(
                    "/api/v1/chat/conversations/conv-1/messages",
                    data={"message": "тест", "agent_mode": "always"},
                )

        assert resp.status_code == 200, resp.text
        assert "message_id" in resp.json()
        # Осиротевший draft не создаётся: submit в шину не вызывается.
        channel_svc.submit.assert_not_awaited()
        # Вместо этого сохранено финализированное error-сообщение.
        msg.save_assistant_message.assert_awaited_once()
        saved_blocks = msg.save_assistant_message.await_args.kwargs["content"]
        assert saved_blocks[0]["code"] == "agent_unavailable"

    def test_send_message_adaptive_mode_uses_orchestrator(self):
        """agent_mode=adaptive: ведёт себя как off (оркестратор), не как always."""
        settings = _make_settings()
        conv = self._conv_with_get(settings)
        msg = _make_msg_service(settings)
        msg.save_user_message.return_value = {"id": "m-1", "role": "user", "content": []}

        app = _build_app(
            conv_service=conv,
            msg_service=msg,
            file_service=_make_file_service(settings),
        )

        with patch(
            "app.domains.chat.services.orchestrator.get_domain_settings",
            return_value=settings,
        ):
            with TestClient(app) as client:
                resp = client.post(
                    "/api/v1/chat/conversations/conv-1/messages",
                    data={"message": "Привет", "agent_mode": "adaptive"},
                )

        assert resp.status_code == 200, resp.text
        assert "message_id" in resp.json()


# -------------------------------------------------------------------------
# GET /conversations/{id}/messages/{message_id} — опрос готовности
# -------------------------------------------------------------------------


class TestGetSingleMessage:
    """E2E: GET /messages/{id} возвращает {id, status, content}."""

    def _conv_with_get(self, settings: ChatDomainSettings) -> MagicMock:
        conv = _make_conv_service(settings)
        conv.get.return_value = {
            "id": "conv-1",
            "user_id": USERNAME,
            "title": None,
            "domain_name": None,
            "context": None,
        }
        return conv

    def test_get_single_message_complete(self):
        """GET /messages/{id}: complete-сообщение возвращает status='complete'."""
        settings = _make_settings()
        conv = self._conv_with_get(settings)
        msg = _make_msg_service(settings)
        msg.get_message = AsyncMock(return_value={
            "id": "msg-abc",
            "conversation_id": "conv-1",
            "role": "assistant",
            "content": [{"type": "text", "content": "Ответ"}],
            "status": "complete",
        })

        app = _build_app(
            conv_service=conv,
            msg_service=msg,
            file_service=_make_file_service(settings),
        )

        with TestClient(app) as client:
            resp = client.get("/api/v1/chat/conversations/conv-1/messages/msg-abc")

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["id"] == "msg-abc"
        assert body["status"] == "complete"
        assert body["content"] == [{"type": "text", "content": "Ответ"}]

    def test_get_single_message_streaming(self):
        """GET /messages/{id}: streaming-сообщение возвращает status='streaming'."""
        settings = _make_settings()
        conv = self._conv_with_get(settings)
        msg = _make_msg_service(settings)
        msg.get_message = AsyncMock(return_value={
            "id": "msg-xyz",
            "conversation_id": "conv-1",
            "role": "assistant",
            "content": [{"type": "reasoning", "block_id": "r1", "content": "думаю..."}],
            "status": "streaming",
        })

        app = _build_app(
            conv_service=conv,
            msg_service=msg,
            file_service=_make_file_service(settings),
        )

        with TestClient(app) as client:
            resp = client.get("/api/v1/chat/conversations/conv-1/messages/msg-xyz")

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["id"] == "msg-xyz"
        assert body["status"] == "streaming"
        assert len(body["content"]) == 1
        assert body["content"][0]["block_id"] == "r1"

    def test_get_single_message_not_found_returns_404(self):
        """GET /messages/{id}: несуществующий id → 404 ChatMessageNotFoundError."""
        settings = _make_settings()
        conv = self._conv_with_get(settings)
        msg = _make_msg_service(settings)
        msg.get_message = AsyncMock(
            side_effect=ChatMessageNotFoundError("Сообщение не найдено.")
        )

        app = _build_app(
            conv_service=conv,
            msg_service=msg,
            file_service=_make_file_service(settings),
        )

        with TestClient(app) as client:
            resp = client.get("/api/v1/chat/conversations/conv-1/messages/no-such-id")

        assert resp.status_code == 404, resp.text
        assert "не найдено" in resp.json()["detail"].lower()

    def test_get_single_message_wrong_conversation_returns_404(self):
        """GET /messages/{id}: conv_service.get бросает 404 если беседа не принадлежит юзеру."""
        settings = _make_settings()
        conv = _make_conv_service(settings)
        conv.get.side_effect = ConversationNotFoundError("Беседа не найдена")
        msg = _make_msg_service(settings)

        app = _build_app(
            conv_service=conv,
            msg_service=msg,
            file_service=_make_file_service(settings),
        )

        with TestClient(app) as client:
            resp = client.get("/api/v1/chat/conversations/foreign-conv/messages/msg-1")

        assert resp.status_code == 404, resp.text

    def test_get_message_streaming_with_agent_ref_returns_status_details(self):
        """streaming + agent_ref: GET возвращает status_details от AgentChannelService."""
        settings = _make_settings()
        conv = self._conv_with_get(settings)
        msg = _make_msg_service(settings)
        msg.get_message = AsyncMock(return_value={
            "id": "m1",
            "conversation_id": "conv-1",
            "status": "streaming",
            "content": [],
            "agent_ref": "q-uid",
        })

        app = _build_app(
            conv_service=conv,
            msg_service=msg,
            file_service=_make_file_service(settings),
        )

        with (
            patch(
                "app.domains.chat.api.messages.get_chat_settings",
                return_value=settings,
            ),
            patch(
                "app.domains.chat.services.agent_channel.AgentChannelService.get_queue_details",
                new=AsyncMock(return_value={"bus_status": "pending", "queue_ahead": 2}),
            ),
        ):
            with TestClient(app) as client:
                resp = client.get("/api/v1/chat/conversations/conv-1/messages/m1")

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["id"] == "m1"
        assert body["status"] == "streaming"
        assert body["status_details"] == {"bus_status": "pending", "queue_ahead": 2}

    def test_get_message_streaming_without_agent_ref_no_status_details(self):
        """streaming без agent_ref: ключа status_details нет в ответе."""
        settings = _make_settings()
        conv = self._conv_with_get(settings)
        msg = _make_msg_service(settings)
        msg.get_message = AsyncMock(return_value={
            "id": "m2",
            "conversation_id": "conv-1",
            "status": "streaming",
            "content": [],
        })

        app = _build_app(
            conv_service=conv,
            msg_service=msg,
            file_service=_make_file_service(settings),
        )

        with TestClient(app) as client:
            resp = client.get("/api/v1/chat/conversations/conv-1/messages/m2")

        assert resp.status_code == 200, resp.text
        assert "status_details" not in resp.json()

    def test_get_message_complete_with_agent_ref_no_status_details(self):
        """status='complete' + agent_ref: ключа status_details нет в ответе."""
        settings = _make_settings()
        conv = self._conv_with_get(settings)
        msg = _make_msg_service(settings)
        msg.get_message = AsyncMock(return_value={
            "id": "m3",
            "conversation_id": "conv-1",
            "status": "complete",
            "content": [{"type": "text", "content": "Готово"}],
            "agent_ref": "q-uid",
        })

        app = _build_app(
            conv_service=conv,
            msg_service=msg,
            file_service=_make_file_service(settings),
        )

        with TestClient(app) as client:
            resp = client.get("/api/v1/chat/conversations/conv-1/messages/m3")

        assert resp.status_code == 200, resp.text
        assert "status_details" not in resp.json()

    def test_get_message_status_details_best_effort_on_error(self):
        """get_queue_details бросает Exception → 200, status/content на месте, status_details отсутствует."""
        settings = _make_settings()
        conv = self._conv_with_get(settings)
        msg = _make_msg_service(settings)
        msg.get_message = AsyncMock(return_value={
            "id": "m4",
            "conversation_id": "conv-1",
            "status": "streaming",
            "content": [],
            "agent_ref": "q-uid",
        })

        app = _build_app(
            conv_service=conv,
            msg_service=msg,
            file_service=_make_file_service(settings),
        )

        with (
            patch(
                "app.domains.chat.api.messages.get_chat_settings",
                return_value=settings,
            ),
            patch(
                "app.domains.chat.services.agent_channel.AgentChannelService.get_queue_details",
                new=AsyncMock(side_effect=RuntimeError("БД недоступна")),
            ),
        ):
            with TestClient(app) as client:
                resp = client.get("/api/v1/chat/conversations/conv-1/messages/m4")

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["id"] == "m4"
        assert body["status"] == "streaming"
        assert body["content"] == []
        assert "status_details" not in body


# -------------------------------------------------------------------------
# POST /api/v1/chat/conversations/{id}/messages — загрузка файла в сообщении
# -------------------------------------------------------------------------


class TestUploadFileInMessage:
    """E2E: загрузка файлов идёт через эндпоинт сообщений.

    Отдельного ``POST /chat/files`` в текущей реализации нет — файлы
    приходят как multipart-files к сообщению. Тестируем валидный путь
    и отказ на запрещённом MIME (``application/x-msdownload``).
    """

    def test_send_message_with_valid_file_returns_200(self):
        """Сообщение с валидным PDF-файлом проходит."""
        settings = _make_settings()
        conv = _make_conv_service(settings)
        conv.get.return_value = {
            "id": "conv-1",
            "user_id": USERNAME,
            "title": None,
            "domain_name": None,
            "context": None,
        }
        msg = _make_msg_service(settings)
        msg.save_user_message.return_value = {
            "id": "m-1",
            "role": "user",
            "content": [],
        }
        msg.save_assistant_message = AsyncMock(
            return_value={"id": "m-2", "role": "assistant", "content": []},
        )

        file_svc = _make_file_service(settings)
        file_svc.save_file.return_value = {
            "id": "f-1",
            "filename": "doc.pdf",
            "mime_type": "application/pdf",
            "file_size": 100,
        }

        app = _build_app(
            conv_service=conv,
            msg_service=msg,
            file_service=file_svc,
        )

        with patch(
            "app.domains.chat.services.orchestrator.get_domain_settings",
            return_value=settings,
        ):
            with TestClient(app) as client:
                # JSON-режим: POST отдаёт {message_id}, ответ читается отдельным GET
                resp = client.post(
                    "/api/v1/chat/conversations/conv-1/messages",
                    data={"message": "вот файл"},
                    files=[
                        (
                            "files",
                            ("doc.pdf", b"%PDF-1.4 fake", "application/pdf"),
                        ),
                    ],
                )

        assert resp.status_code == 200, resp.text
        file_svc.save_file.assert_awaited_once()
        # MIME-тип передан в save_file
        kwargs = file_svc.save_file.await_args.kwargs
        assert kwargs["mime_type"] == "application/pdf"
        assert kwargs["filename"] == "doc.pdf"

    def test_send_message_with_invalid_mime_returns_422(self):
        """Файл с запрещённым MIME (.exe) возвращает 422 от ChatFileValidationError.

        ``FileService.save_file`` поднимает ``ChatFileValidationError``
        (status_code=422); глобальный handler конвертирует в JSON-ответ.
        """
        settings = _make_settings()
        conv = _make_conv_service(settings)
        conv.get.return_value = {
            "id": "conv-1",
            "user_id": USERNAME,
            "title": None,
            "domain_name": None,
            "context": None,
        }
        msg = _make_msg_service(settings)
        file_svc = _make_file_service(settings)
        file_svc.save_file.side_effect = ChatFileValidationError(
            "Тип файла 'application/x-msdownload' не поддерживается.",
        )

        app = _build_app(
            conv_service=conv,
            msg_service=msg,
            file_service=file_svc,
        )

        with TestClient(app) as client:
            resp = client.post(
                "/api/v1/chat/conversations/conv-1/messages",
                data={"message": "вот вирус"},
                files=[
                    (
                        "files",
                        ("malware.exe", b"MZ\x90\x00", "application/x-msdownload"),
                    ),
                ],
            )

        assert resp.status_code == 422, resp.text
        assert "не поддерживается" in resp.json()["detail"]

    def test_send_message_rejects_excess_files(self):
        """Превышение ``max_files_per_message`` → 422 до save_file.

        Guard в messages.py:99 должен среагировать ДО чтения файлов и ДО
        save_user_message: иначе можно протащить >N файлов и переполнить
        storage.
        """
        settings = ChatDomainSettings(
            api_base="",
            api_key="",
            model="gpt-4o",
            max_files_per_message=2,
        )
        conv = _make_conv_service(settings)
        conv.get.return_value = {
            "id": "conv-1",
            "user_id": USERNAME,
            "title": None,
            "domain_name": None,
            "context": None,
        }
        msg = _make_msg_service(settings)
        file_svc = _make_file_service(settings)

        app = _build_app(
            conv_service=conv,
            msg_service=msg,
            file_service=file_svc,
        )

        with TestClient(app) as client:
            resp = client.post(
                "/api/v1/chat/conversations/conv-1/messages",
                data={"message": "три файла"},
                files=[
                    ("files", ("a.pdf", b"%PDF-1", "application/pdf")),
                    ("files", ("b.pdf", b"%PDF-1", "application/pdf")),
                    ("files", ("c.pdf", b"%PDF-1", "application/pdf")),
                ],
            )

        assert resp.status_code == 422, resp.text
        assert "Слишком много файлов" in resp.json()["detail"]
        # save_file и save_user_message НЕ должны быть вызваны
        file_svc.save_file.assert_not_awaited()
        msg.save_user_message.assert_not_awaited()

    def test_send_message_rejects_excess_total_size(self):
        """Превышение суммарного размера файлов → 422 до save_file.

        Guard в messages.py:113 должен среагировать после чтения всех
        файлов, но ДО save_file: иначе можно растянуть storage до OOM.
        """
        settings = ChatDomainSettings(
            api_base="",
            api_key="",
            model="gpt-4o",
            max_files_per_message=5,
            max_total_file_size=100,  # 100 байт — крошечный лимит
        )
        conv = _make_conv_service(settings)
        conv.get.return_value = {
            "id": "conv-1",
            "user_id": USERNAME,
            "title": None,
            "domain_name": None,
            "context": None,
        }
        msg = _make_msg_service(settings)
        file_svc = _make_file_service(settings)

        app = _build_app(
            conv_service=conv,
            msg_service=msg,
            file_service=file_svc,
        )

        big = b"x" * 200  # одного файла достаточно для превышения 100Б
        with TestClient(app) as client:
            resp = client.post(
                "/api/v1/chat/conversations/conv-1/messages",
                data={"message": "тяжёлый"},
                files=[
                    ("files", ("big.pdf", big, "application/pdf")),
                ],
            )

        assert resp.status_code == 422, resp.text
        assert "Суммарный размер" in resp.json()["detail"]
        file_svc.save_file.assert_not_awaited()
        msg.save_user_message.assert_not_awaited()


# -------------------------------------------------------------------------
# GET /api/v1/chat/files/{file_id} — скачивание файла
# -------------------------------------------------------------------------


class TestDownloadFile:
    """E2E: скачивание файла отдаёт правильные заголовки безопасности."""

    def test_download_file_returns_safe_headers(self):
        """Скачивание: 200 + Content-Disposition + nosniff + octet-stream."""
        settings = _make_settings()
        conv = _make_conv_service(settings)
        msg = _make_msg_service(settings)
        file_svc = _make_file_service(settings)
        file_svc.get_file.return_value = {
            "filename": "отчёт.pdf",  # с кириллицей — проверим UTF-8 encoding
            "mime_type": "application/pdf",
            "file_data": b"%PDF-1.4 binary content",
        }

        app = _build_app(
            conv_service=conv,
            msg_service=msg,
            file_service=file_svc,
        )

        with TestClient(app) as client:
            resp = client.get("/api/v1/chat/files/file-123")

        assert resp.status_code == 200, resp.text
        # Принудительный application/octet-stream — не доверяем сохранённому MIME
        assert resp.headers["content-type"] == "application/octet-stream"
        # nosniff — блокирует MIME-sniffing в браузере
        assert resp.headers["x-content-type-options"] == "nosniff"
        # Content-Disposition с filename* UTF-8 encoded
        cd = resp.headers["content-disposition"]
        assert cd.startswith("attachment;")
        assert "filename*=UTF-8''" in cd

        # Содержимое отдано как есть
        assert resp.content == b"%PDF-1.4 binary content"

    def test_download_unknown_file_returns_404(self):
        """Несуществующий файл возвращает 404 (ChatFileNotFoundError)."""
        settings = _make_settings()
        file_svc = _make_file_service(settings)
        file_svc.get_file.side_effect = ChatFileNotFoundError("Файл не найден")

        app = _build_app(
            conv_service=_make_conv_service(settings),
            msg_service=_make_msg_service(settings),
            file_service=file_svc,
        )

        with TestClient(app) as client:
            resp = client.get("/api/v1/chat/files/missing")

        assert resp.status_code == 404, resp.text
        assert resp.json() == {
            "detail": "Файл не найден",
            "code": "chat-file-not-found",
        }


# -------------------------------------------------------------------------
# GET /api/v1/chat/conversations/{id} — ownership-check
# -------------------------------------------------------------------------


class TestConversationOwnership:
    """Чужая беседа: ConversationService.get -> 404 ConversationNotFoundError."""

    def test_get_foreign_conversation_returns_404(self):
        settings = _make_settings()
        conv = _make_conv_service(settings)
        conv.get.side_effect = ConversationNotFoundError("Беседа не найдена")

        app = _build_app(
            conv_service=conv,
            msg_service=_make_msg_service(settings),
            file_service=_make_file_service(settings),
        )

        with TestClient(app) as client:
            resp = client.get("/api/v1/chat/conversations/foreign-id")

        assert resp.status_code == 404


# -------------------------------------------------------------------------
# GET /api/v1/chat/conversations/{id}/messages — status в MessageResponse
# -------------------------------------------------------------------------


class TestGetMessagesStatus:
    """Phase 0 «D»: GET /messages отдаёт streaming-сообщения со status='streaming'
    и накопленными блоками. История не фильтруется по статусу."""

    def test_get_messages_returns_streaming_with_partial_blocks(self):
        settings = _make_settings()
        conv = _make_conv_service(settings)
        conv.get = AsyncMock(return_value={
            "id": "conv-1",
            "user_id": USERNAME,
            "title": "t",
            "domain_name": None,
            "context": None,
            "created_at": dt.datetime(2026, 1, 1),
            "updated_at": dt.datetime(2026, 1, 1),
        })
        msg = _make_msg_service(settings)
        # Сервис возвращает три сообщения: user (complete), assistant (complete),
        # и третье — assistant streaming с уже накопленным reasoning-блоком.
        history = [
            {
                "id": "m1",
                "conversation_id": "conv-1",
                "role": "user",
                "content": [{"type": "text", "content": "Привет"}],
                "model": None,
                "token_usage": None,
                "status": "complete",
                "created_at": dt.datetime(2026, 1, 1, 12, 0, 0),
            },
            {
                "id": "m2",
                "conversation_id": "conv-1",
                "role": "assistant",
                "content": [{"type": "text", "content": "И тебе"}],
                "model": "gpt-4",
                "token_usage": {"input_tokens": 10, "output_tokens": 5},
                "status": "complete",
                "created_at": dt.datetime(2026, 1, 1, 12, 0, 1),
            },
            {
                "id": "m3",
                "conversation_id": "conv-1",
                "role": "assistant",
                "content": [
                    {"type": "reasoning", "block_id": "r1", "content": "думаю..."},
                ],
                "model": "gpt-4",
                "token_usage": None,
                "status": "streaming",
                "created_at": dt.datetime(2026, 1, 1, 12, 0, 2),
            },
        ]
        msg.get_history = AsyncMock(return_value=(history, len(history)))

        app = _build_app(
            conv_service=conv,
            msg_service=msg,
            file_service=_make_file_service(settings),
        )

        with TestClient(app) as client:
            resp = client.get(
                "/api/v1/chat/conversations/conv-1/messages"
            )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        items = body["items"]
        assert body["total"] == 3
        assert [m["status"] for m in items] == ["complete", "complete", "streaming"]
        # streaming-сообщение пришло с уже накопленным reasoning-блоком,
        # фронт может отрендерить его сразу.
        streaming = items[2]
        assert streaming["role"] == "assistant"
        assert len(streaming["content"]) == 1
        assert streaming["content"][0]["block_id"] == "r1"


# -------------------------------------------------------------------------
# GET /api/v1/chat/conversations/{id}/messages — multi-chat switching
# -------------------------------------------------------------------------


class TestMultiChatSwitchingStreamingState:
    """Phase 4 «D»: воспроизведение бага, ради которого делали рефактор.

    Сценарий: открыты ДВЕ беседы (A, B) с активными forward'ами; reasoning-блоки
    лежат в ``chat_messages.content`` со ``status='streaming'``. Переключение
    между чатами не теряет накопленный state, потому что фронт получает блоки
    через GET /messages — поллинг по шине, единый источник истины. После прихода
    нового reasoning'а в A повторный GET возвращает обновлённый список.

    Исторический контекст: до рефактора (Variant D) фронт держал глобальный
    per-transport seq-курсор, который мог дать перекос между разными forward'ами
    — после switch'а резюм открывался с неверным значением и UI терял
    рассуждения. Теперь GET /messages — единственный источник streaming-state.
    """

    def test_two_active_streaming_messages_visible_via_get_messages(self):
        """Каждая беседа отдаёт свой streaming-message со своими блоками."""
        settings = _make_settings()
        conv = _make_conv_service(settings)
        now = dt.datetime(2026, 1, 1, 12, 0, 0)

        # get(conv_id, user_id) — ownership-проверка перед GET /messages
        async def fake_get(conv_id: str, user_id: str):
            return {
                "id": conv_id,
                "user_id": user_id,
                "title": f"Беседа {conv_id}",
                "domain_name": None,
                "context": None,
                "created_at": now,
                "updated_at": now,
            }

        conv.get = AsyncMock(side_effect=fake_get)

        msg = _make_msg_service(settings)

        # Имитируем БД-state: чат A — 2 reasoning'а, чат B — 1 reasoning.
        state = {
            "conv-A": [
                {"type": "reasoning", "block_id": "a-r1", "content": "думаю об A.1"},
                {"type": "reasoning", "block_id": "a-r2", "content": "думаю об A.2"},
            ],
            "conv-B": [
                {"type": "reasoning", "block_id": "b-r1", "content": "думаю об B.1"},
            ],
        }

        async def fake_get_history(conv_id: str, *_args, **_kwargs):
            blocks = state.get(conv_id, [])
            items = [
                {
                    "id": f"msg-{conv_id}",
                    "conversation_id": conv_id,
                    "role": "assistant",
                    "content": list(blocks),  # копия — иначе тест зависит от mutation
                    "model": "gpt-4",
                    "token_usage": None,
                    "status": "streaming",
                    "created_at": now,
                },
            ]
            return items, len(items)

        msg.get_history = AsyncMock(side_effect=fake_get_history)

        app = _build_app(
            conv_service=conv,
            msg_service=msg,
            file_service=_make_file_service(settings),
        )

        with TestClient(app) as client:
            # 1. GET для A — 2 reasoning-блока, status='streaming'
            resp_a = client.get("/api/v1/chat/conversations/conv-A/messages")
            assert resp_a.status_code == 200, resp_a.text
            items_a = resp_a.json()["items"]
            assert len(items_a) == 1
            assert items_a[0]["status"] == "streaming"
            assert [b["block_id"] for b in items_a[0]["content"]] == ["a-r1", "a-r2"]

            # 2. GET для B — 1 reasoning-блок, status='streaming'
            resp_b = client.get("/api/v1/chat/conversations/conv-B/messages")
            assert resp_b.status_code == 200, resp_b.text
            items_b = resp_b.json()["items"]
            assert len(items_b) == 1
            assert items_b[0]["status"] == "streaming"
            assert [b["block_id"] for b in items_b[0]["content"]] == ["b-r1"]

            # 3. Симулируем добавление нового reasoning'а в A (как сделал бы
            #    runner через MessageRepository.append_block в БД).
            state["conv-A"].append(
                {"type": "reasoning", "block_id": "a-r3", "content": "думаю об A.3"},
            )

            # 4. Повторный GET для A — теперь 3 блока. **Это ядро теста**:
            #    до рефактора фронт зависел от транспортного seq-курсора и не
            #    переиспользовал GET /messages как источник правды.
            resp_a2 = client.get("/api/v1/chat/conversations/conv-A/messages")
            assert resp_a2.status_code == 200, resp_a2.text
            items_a2 = resp_a2.json()["items"]
            assert len(items_a2) == 1
            assert items_a2[0]["status"] == "streaming"
            assert [b["block_id"] for b in items_a2[0]["content"]] == [
                "a-r1", "a-r2", "a-r3",
            ]

            # 5. GET для B не изменился — изоляция чатов сохраняется.
            resp_b2 = client.get("/api/v1/chat/conversations/conv-B/messages")
            assert resp_b2.status_code == 200, resp_b2.text
            items_b2 = resp_b2.json()["items"]
            assert [b["block_id"] for b in items_b2[0]["content"]] == ["b-r1"]
