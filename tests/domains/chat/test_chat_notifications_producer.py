"""Тесты продьюсера уведомлений домена chat (T4).

Проверяют, что ``AgentChannelService.poll_once`` после успешной
финализации ответа внешнего агента эмитит персистентное уведомление через
фабрику ``notifications.push`` — и делает это мягко:
- при наличии фабрики push зовётся с source='chat' и recipient_user_id
  автора вопроса;
- при отсутствии фабрики poll_once отрабатывает как раньше (без push,
  без ошибок) — это страхует от регрессии существующих юнит-тестов, где
  домен notifications не зарегистрирован;
- сбой push не ломает poll_once (outcome='done').
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.core import domain_registry
from app.domains.chat.services.agent_channel import AgentChannelService
from app.domains.chat.settings import ChatDomainSettings
from tests.conftest import register_fake_push_factory


# ── Фикстуры ─────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _patch_adapter():
    """Подменяет get_adapter, чтобы BaseRepository работал вне init_db()."""
    adapter = MagicMock()
    adapter.get_table_name = lambda name, schema='': name
    with patch("app.db.repositories.base.get_adapter", return_value=adapter):
        yield


@pytest.fixture(autouse=True)
def _reset_factories():
    """Сбрасывает реестр фабрик до и после теста (глобальное состояние)."""
    domain_registry.reset_registry()
    yield
    domain_registry.reset_registry()


@pytest.fixture
def settings():
    return ChatDomainSettings()


@pytest.fixture
def mock_conn():
    conn = AsyncMock()
    conn.fetchrow = AsyncMock()
    conn.fetchval = AsyncMock()
    conn.fetch = AsyncMock()
    conn.execute = AsyncMock()
    tx = AsyncMock()
    tx.__aenter__ = AsyncMock(return_value=tx)
    tx.__aexit__ = AsyncMock(return_value=False)
    conn.transaction = MagicMock(return_value=tx)
    return conn


def _make_finalizable_service(mock_conn, settings, *, question_user_id="user1"):
    """Возвращает (svc, fake_agent_repo, fake_msg_repo) с готовым к финализации
    ответом агента (status='complete', без ошибки)."""
    question = {
        "id": "q-uid",
        "user_id": question_user_id,
        "status": "completed",
        "reply_to": None,
    }
    answer = {
        "id": "a-uid",
        "role": "assistant",
        "content": "Ответ от агента",
        "metadata": {},
        "buttons": None,
        "media": None,
        "reply_to": "q-uid",
        "status": "completed",
    }
    fake_agent_repo = AsyncMock()
    fake_agent_repo.get_by_uid = AsyncMock(return_value=question)
    fake_agent_repo.get_answer_for_question = AsyncMock(return_value=answer)

    fake_msg_repo = AsyncMock()
    fake_msg_repo.finalize = AsyncMock(return_value=True)
    fake_msg_repo.mark_failed = AsyncMock(return_value=True)
    fake_msg_repo.upsert_block = AsyncMock(return_value=True)

    svc = AgentChannelService(mock_conn, settings)
    svc._agent_repo = lambda: fake_agent_repo
    svc._message_repo = lambda: fake_msg_repo
    return svc, fake_agent_repo, fake_msg_repo


# ── Тесты ─────────────────────────────────────────────────────────────────────


class TestChatNotificationsProducer:

    async def test_push_called_after_finalize_with_recipient(
        self, mock_conn, settings
    ):
        """При наличии фабрики push зовётся после finalize с source='chat'
        и recipient_user_id автора вопроса."""
        svc, fake_agent_repo, fake_msg_repo = _make_finalizable_service(
            mock_conn, settings, question_user_id="asker-42"
        )
        push_mock = AsyncMock(return_value="notif-1")
        register_fake_push_factory(push_mock)

        res = await svc.poll_once(
            assistant_message_id="msg-1",
            question_uid="q-uid",
        )

        assert res["outcome"] == "done"
        fake_msg_repo.finalize.assert_called_once()
        push_mock.assert_awaited_once()
        kwargs = push_mock.call_args.kwargs
        assert kwargs["source"] == "chat"
        assert kwargs["recipient_user_id"] == "asker-42"
        assert kwargs["title"] == "Готов ответ базы знаний"
        assert kwargs["severity"] == "info"
        assert kwargs["created_by"] == "system"
        # Чат — popup без URL, надёжного act_id нет → link=None.
        assert kwargs["link"] is None

    async def test_no_factory_finalizes_without_push_and_no_error(
        self, mock_conn, settings
    ):
        """Без фабрики notifications.push poll_once отрабатывает как раньше:
        финализация проходит, ошибок нет, push не вызывается (no-regression)."""
        svc, fake_agent_repo, fake_msg_repo = _make_finalizable_service(
            mock_conn, settings
        )
        # Фабрика НЕ зарегистрирована (reset_registry в фикстуре).
        assert not domain_registry.has_factory("notifications.push")

        res = await svc.poll_once(
            assistant_message_id="msg-1",
            question_uid="q-uid",
        )

        assert res["outcome"] == "done"
        fake_msg_repo.finalize.assert_called_once()
        fake_agent_repo.set_status.assert_awaited_once_with(
            uid="q-uid", status="completed",
        )

    async def test_push_failure_does_not_break_finalize(
        self, mock_conn, settings
    ):
        """Сбой push не ломает poll_once: outcome='done', финализация выполнена."""
        svc, fake_agent_repo, fake_msg_repo = _make_finalizable_service(
            mock_conn, settings
        )
        push_mock = AsyncMock(side_effect=RuntimeError("push упал"))
        register_fake_push_factory(push_mock)

        res = await svc.poll_once(
            assistant_message_id="msg-1",
            question_uid="q-uid",
        )

        assert res["outcome"] == "done"
        fake_msg_repo.finalize.assert_called_once()
        push_mock.assert_awaited_once()

    async def test_error_answer_emits_error_notification(
        self, mock_conn, settings
    ):
        """Ветка ошибки: после mark_failed эмитится уведомление severity='error'
        с заголовком «Ошибка ответа базы знаний»."""
        question = {
            "id": "q-uid",
            "user_id": "asker-7",
            "status": "completed",
            "reply_to": None,
        }
        answer = {
            "id": "a-uid",
            "role": "assistant",
            "content": "Ошибка в агенте",
            "metadata": {},
            "buttons": None,
            "media": None,
            "reply_to": "q-uid",
            "status": "failed",
        }
        fake_agent_repo = AsyncMock()
        fake_agent_repo.get_by_uid = AsyncMock(return_value=question)
        fake_agent_repo.get_answer_for_question = AsyncMock(return_value=answer)
        fake_msg_repo = AsyncMock()
        fake_msg_repo.finalize = AsyncMock(return_value=True)
        fake_msg_repo.mark_failed = AsyncMock(return_value=True)
        fake_msg_repo.upsert_block = AsyncMock(return_value=True)

        svc = AgentChannelService(mock_conn, settings)
        svc._agent_repo = lambda: fake_agent_repo
        svc._message_repo = lambda: fake_msg_repo

        push_mock = AsyncMock(return_value="notif-err")
        register_fake_push_factory(push_mock)

        res = await svc.poll_once(
            assistant_message_id="msg-2",
            question_uid="q-uid",
        )

        assert res["outcome"] == "done"
        fake_msg_repo.mark_failed.assert_called_once()
        fake_msg_repo.finalize.assert_not_called()
        push_mock.assert_awaited_once()
        kwargs = push_mock.call_args.kwargs
        assert kwargs["source"] == "chat"
        assert kwargs["recipient_user_id"] == "asker-7"
        assert kwargs["title"] == "Ошибка ответа базы знаний"
        assert kwargs["severity"] == "error"

    async def test_no_push_when_question_has_no_user_id(
        self, mock_conn, settings
    ):
        """Если у вопроса нет user_id — уведомление не эмитим (адресовать
        некому, broadcast здесь не нужен)."""
        svc, fake_agent_repo, fake_msg_repo = _make_finalizable_service(
            mock_conn, settings, question_user_id=None
        )
        push_mock = AsyncMock(return_value="notif")
        register_fake_push_factory(push_mock)

        res = await svc.poll_once(
            assistant_message_id="msg-1",
            question_uid="q-uid",
        )

        assert res["outcome"] == "done"
        fake_msg_repo.finalize.assert_called_once()
        push_mock.assert_not_awaited()

    async def test_no_push_when_finalize_idempotent_noop(
        self, mock_conn, settings
    ):
        """finalize вернул False (повторный тик на уже complete-сообщении) →
        уведомление НЕ эмитим: эмиссия гейтится возвратом finalize, поэтому при
        ретрае поллера уведомление не задваивается."""
        svc, fake_agent_repo, fake_msg_repo = _make_finalizable_service(
            mock_conn, settings
        )
        fake_msg_repo.finalize = AsyncMock(return_value=False)
        push_mock = AsyncMock(return_value="notif")
        register_fake_push_factory(push_mock)

        res = await svc.poll_once(
            assistant_message_id="msg-1",
            question_uid="q-uid",
        )

        assert res["outcome"] == "done"
        fake_msg_repo.finalize.assert_called_once()
        push_mock.assert_not_awaited()
        # set_status всё равно вызывается (закрытие вопроса идемпотентно).
        fake_agent_repo.set_status.assert_awaited_once_with(
            uid="q-uid", status="completed",
        )

    async def test_no_push_when_mark_failed_idempotent_noop(
        self, mock_conn, settings
    ):
        """mark_failed вернул False (повторный тик на уже failed-сообщении) →
        уведомление об ошибке НЕ эмитим: эмиссия в ветке ошибки тоже гейтится
        возвратом mark_failed."""
        question = {
            "id": "q-uid",
            "user_id": "asker-9",
            "status": "completed",
            "reply_to": None,
        }
        answer = {
            "id": "a-uid",
            "role": "assistant",
            "content": "Ошибка в агенте",
            "metadata": {},
            "buttons": None,
            "media": None,
            "reply_to": "q-uid",
            "status": "failed",
        }
        fake_agent_repo = AsyncMock()
        fake_agent_repo.get_by_uid = AsyncMock(return_value=question)
        fake_agent_repo.get_answer_for_question = AsyncMock(return_value=answer)
        fake_msg_repo = AsyncMock()
        fake_msg_repo.finalize = AsyncMock(return_value=True)
        fake_msg_repo.mark_failed = AsyncMock(return_value=False)
        fake_msg_repo.upsert_block = AsyncMock(return_value=True)

        svc = AgentChannelService(mock_conn, settings)
        svc._agent_repo = lambda: fake_agent_repo
        svc._message_repo = lambda: fake_msg_repo

        push_mock = AsyncMock(return_value="notif")
        register_fake_push_factory(push_mock)

        res = await svc.poll_once(
            assistant_message_id="msg-9",
            question_uid="q-uid",
        )

        assert res["outcome"] == "done"
        fake_msg_repo.mark_failed.assert_called_once()
        push_mock.assert_not_awaited()
        fake_agent_repo.set_status.assert_awaited_once_with(
            uid="q-uid", status="failed",
        )
