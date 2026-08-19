"""Тесты AgentChannelPoller.

Тестируются: subscribe (идемпотентность, поля entry), reconcile (восстановление
реестра), _tick (done/pending/idle-таймауты по фазам/liveness-сигналы),
а также инвариант «тик не удерживает соединение» (TestTickDoesNotHoldConnection —
единственный класс, где реально прокручивается _run).
"""

import pytest
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

from app.core import domain_registry
from app.core.chat import tools as chat_tools
from app.core.chat.tools import ChatTool
from app.db.executor import get_executor
from app.domains.chat.services.agent_channel_poller import AgentChannelPoller
from app.domains.chat.settings import ChatDomainSettings


# ── Фикстуры ─────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _patch_adapter():
    """Подменяет get_adapter, чтобы BaseRepository работал вне init_db()."""
    adapter = MagicMock()
    adapter.get_table_name = lambda name, schema='': name
    adapter.qualify_table_name = lambda name, schema='': name
    with patch("app.db.repositories.base.get_adapter", return_value=adapter):
        yield


@pytest.fixture
def settings():
    return ChatDomainSettings()


@pytest.fixture
def mock_conn():
    """Фейк, играющий роль исполнителя БД (и соединения — API совпадает)."""
    conn = AsyncMock()
    conn.fetchrow = AsyncMock()
    conn.fetch = AsyncMock(return_value=[])
    conn.execute = AsyncMock()
    tx = AsyncMock()
    tx.__aenter__ = AsyncMock(return_value=tx)
    tx.__aexit__ = AsyncMock(return_value=False)
    conn.transaction = MagicMock(return_value=tx)
    return conn


def _make_poller(settings, *, now=None, executor=None):
    """Создаёт поллер с инжектированными зависимостями.

    ``executor`` — фейковый исполнитель БД: поллер работает через DbExecutor
    (соединение на операцию), а не через удерживаемое соединение, поэтому
    инжектируется фабрика исполнителя. AsyncMock подходит: DbExecutor и
    asyncpg.Connection совпадают по используемому API (fetch/fetchrow/
    fetchval/execute/transaction).
    """
    factory = (lambda: executor) if executor is not None else None
    return AgentChannelPoller(
        settings, now=now or (lambda: 0.0), executor_factory=factory,
    )


def _poll_res(**overrides):
    """Базовый poll_once-результат с возможностью перекрытия полей."""
    res = {
        "outcome": "pending",
        "question_status": "pending",
        "answer_exists": False,
        "reasoning_len": 0,
        "queue_ahead": None,
        "answer_updated_at": None,
    }
    res.update(overrides)
    return res


# ── subscribe ─────────────────────────────────────────────────────────────────


class TestSubscribe:

    def test_subscribe_adds_full_entry(self, settings):
        """subscribe создаёт entry со всеми полями idle-состояния."""
        t = [10.0]
        poller = _make_poller(settings, now=lambda: t[0])
        poller.subscribe(assistant_message_id="m1", question_uid="Q1")
        entry = poller._subscriptions["Q1"]
        assert entry["assistant_message_id"] == "m1"
        assert entry["last_activity"] == 10.0
        assert entry["phase"] == "pending"
        assert entry["last_reasoning_len"] == 0
        assert entry["last_queue_ahead"] is None
        assert entry["last_answer_updated_at"] is None
        assert entry["consecutive_errors"] == 0

    def test_subscribe_idempotent(self, settings):
        """Повторный вызов с тем же uid — реестр не дублируется."""
        poller = _make_poller(settings)
        poller.subscribe(assistant_message_id="m1", question_uid="Q1")
        poller.subscribe(assistant_message_id="m1", question_uid="Q1")
        assert len(poller._subscriptions) == 1

    def test_subscribe_two_different_uids(self, settings):
        poller = _make_poller(settings)
        poller.subscribe(assistant_message_id="m1", question_uid="Q1")
        poller.subscribe(assistant_message_id="m2", question_uid="Q2")
        assert len(poller._subscriptions) == 2


# ── reconcile ─────────────────────────────────────────────────────────────────


class TestReconcile:

    async def test_reconcile_restores_from_get_streaming_drafts(
        self, settings, mock_conn
    ):
        """reconcile читает streaming-drafts и добавляет их в реестр."""
        mock_conn.fetch = AsyncMock(
            return_value=[
                {"id": "m1", "agent_ref": "Q1", "status": "streaming",
                 "conversation_id": "conv1", "role": "assistant",
                 "content": "[]", "model": None, "token_usage": None,
                 "created_at": None, "updated_at": None},
            ]
        )

        t = [5.0]
        poller = _make_poller(settings, now=lambda: t[0], executor=mock_conn)
        await poller.reconcile()

        assert "Q1" in poller._subscriptions
        entry = poller._subscriptions["Q1"]
        assert entry["assistant_message_id"] == "m1"
        # Восстановленная подписка — phase='pending', last_activity=now (момент reconcile).
        assert entry["phase"] == "pending"
        assert entry["last_activity"] == 5.0

    async def test_reconcile_skips_rows_without_agent_ref(
        self, settings, mock_conn
    ):
        """Строки без agent_ref игнорируются."""
        mock_conn.fetch = AsyncMock(
            return_value=[
                {"id": "m1", "agent_ref": None, "status": "streaming",
                 "conversation_id": "conv1", "role": "assistant",
                 "content": "[]", "model": None, "token_usage": None,
                 "created_at": None, "updated_at": None},
            ]
        )

        poller = _make_poller(settings, executor=mock_conn)
        await poller.reconcile()

        assert len(poller._subscriptions) == 0

    async def test_reconcile_idempotent_with_subscribe(
        self, settings, mock_conn
    ):
        """reconcile + subscribe — дублей нет."""
        mock_conn.fetch = AsyncMock(
            return_value=[
                {"id": "m1", "agent_ref": "Q1", "status": "streaming",
                 "conversation_id": "conv1", "role": "assistant",
                 "content": "[]", "model": None, "token_usage": None,
                 "created_at": None, "updated_at": None},
            ]
        )

        poller = _make_poller(settings, executor=mock_conn)
        poller.subscribe(assistant_message_id="m1", question_uid="Q1")
        await poller.reconcile()

        assert len(poller._subscriptions) == 1


# ── get_status ─────────────────────────────────────────────────────────────────


class TestGetStatus:

    def test_get_status_structure(self, settings):
        poller = _make_poller(settings)
        poller.subscribe(assistant_message_id="m1", question_uid="Q1")
        status = poller.get_status()
        assert status["name"] == "chat.agent_channel_poller"
        assert status["running"] is False  # задача не запущена
        assert status["active_subscriptions"] == 1
        assert (
            status["current_interval_sec"]
            == settings.agent_channel.poll_min_interval_sec
        )


# ── _tick ──────────────────────────────────────────────────────────────────────


class TestTick:

    async def test_tick_done_removes_subscription(self, settings, mock_conn):
        """Если poll_once возвращает outcome='done' — подписка снимается."""
        poller = _make_poller(settings, executor=mock_conn)
        poller.subscribe(assistant_message_id="m1", question_uid="Q1")

        with patch(
            "app.domains.chat.services.agent_channel.AgentChannelService.poll_once",
            new_callable=AsyncMock,
            return_value=_poll_res(outcome="done", question_status="completed", answer_exists=True),
        ):
            n = await poller._tick(mock_conn)

        assert n == 1
        assert "Q1" not in poller._subscriptions

    async def test_tick_done_does_not_call_mark_timeout(self, settings, mock_conn):
        """При outcome='done' mark_timeout НЕ вызывается."""
        poller = _make_poller(settings, executor=mock_conn)
        poller.subscribe(assistant_message_id="m1", question_uid="Q1")

        with (
            patch(
                "app.domains.chat.services.agent_channel.AgentChannelService.poll_once",
                new_callable=AsyncMock,
                return_value=_poll_res(outcome="done", question_status="completed", answer_exists=True),
            ),
            patch(
                "app.domains.chat.services.agent_channel.AgentChannelService.mark_timeout",
                new_callable=AsyncMock,
            ) as mock_mark,
        ):
            await poller._tick(mock_conn)

        mock_mark.assert_not_called()

    async def test_tick_pending_no_liveness_claim_timeout(self, settings, mock_conn):
        """pending без признаков жизни: по истечении claim_timeout — mark_timeout(reason='claim')."""
        claim_timeout = settings.agent_channel.claim_timeout_sec
        # now[0]=0.0 при subscribe, now[1]=claim_timeout+1 при _tick
        times = [0.0, float(claim_timeout + 1)]
        idx = [0]

        def fake_now():
            val = times[idx[0]]
            idx[0] = min(idx[0] + 1, len(times) - 1)
            return val

        poller = _make_poller(settings, now=fake_now, executor=mock_conn)
        poller.subscribe(assistant_message_id="m1", question_uid="Q1")
        # Первый тик устанавливает baseline queue_ahead (None → None, без activity)

        with (
            patch(
                "app.domains.chat.services.agent_channel.AgentChannelService.poll_once",
                new_callable=AsyncMock,
                return_value=_poll_res(),  # pending, нет признаков жизни
            ),
            patch(
                "app.domains.chat.services.agent_channel.AgentChannelService.mark_timeout",
                new_callable=AsyncMock,
            ) as mock_mark,
        ):
            n = await poller._tick(mock_conn)

        mock_mark.assert_called_once_with(
            assistant_message_id="m1",
            question_uid="Q1",
            reason="claim",
        )
        assert n == 1
        assert "Q1" not in poller._subscriptions

    async def test_tick_queue_movement_extends_claim_timeout(self, settings, mock_conn):
        """Движение очереди продлевает idle-таймаут (тик1 baseline, тик2 activity, тик3 жив)."""
        claim_timeout = settings.agent_channel.claim_timeout_sec
        # Временная шкала: subscribe=0, тик1=10, тик2=claim_timeout-5, тик3=claim_timeout+1
        times = [0.0, 10.0, float(claim_timeout - 5), float(claim_timeout + 1)]
        idx = [0]

        def fake_now():
            val = times[idx[0]]
            idx[0] = min(idx[0] + 1, len(times) - 1)
            return val

        poller = _make_poller(settings, now=fake_now, executor=mock_conn)
        poller.subscribe(assistant_message_id="m1", question_uid="Q1")

        with (
            patch(
                "app.domains.chat.services.agent_channel.AgentChannelService.poll_once",
                new_callable=AsyncMock,
            ) as mock_poll,
            patch(
                "app.domains.chat.services.agent_channel.AgentChannelService.mark_timeout",
                new_callable=AsyncMock,
            ) as mock_mark,
        ):
            # Тик 1: queue_ahead=5 — baseline (НЕ activity), now=10
            mock_poll.return_value = _poll_res(queue_ahead=5)
            await poller._tick(mock_conn)
            assert poller._subscriptions["Q1"]["last_activity"] == 0.0  # не обновилась

            # Тик 2: queue_ahead=3 → уменьшилось → activity, now=claim_timeout-5
            mock_poll.return_value = _poll_res(queue_ahead=3)
            await poller._tick(mock_conn)
            assert poller._subscriptions["Q1"]["last_activity"] == float(claim_timeout - 5)

            # Тик 3: now=claim_timeout+1; от last_activity=(claim_timeout-5) прошло 6 сек < claim_timeout
            mock_poll.return_value = _poll_res(queue_ahead=3)
            n = await poller._tick(mock_conn)

        mock_mark.assert_not_called()  # таймаута нет
        assert n == 0
        assert "Q1" in poller._subscriptions

    async def test_tick_phase_transition_to_processing_triggers_answer_timeout(
        self, settings, mock_conn
    ):
        """Переход в processing меняет лимит на answer_timeout_sec."""
        answer_timeout = settings.agent_channel.answer_timeout_sec
        # subscribe=0, тик1=5 (переход в processing), тик2=5+answer_timeout+1
        times = [0.0, 5.0, float(5 + answer_timeout + 1)]
        idx = [0]

        def fake_now():
            val = times[idx[0]]
            idx[0] = min(idx[0] + 1, len(times) - 1)
            return val

        poller = _make_poller(settings, now=fake_now, executor=mock_conn)
        poller.subscribe(assistant_message_id="m1", question_uid="Q1")

        with (
            patch(
                "app.domains.chat.services.agent_channel.AgentChannelService.poll_once",
                new_callable=AsyncMock,
            ) as mock_poll,
            patch(
                "app.domains.chat.services.agent_channel.AgentChannelService.mark_timeout",
                new_callable=AsyncMock,
            ) as mock_mark,
        ):
            # Тик 1: answer_exists=True → phase становится processing, activity=5
            mock_poll.return_value = _poll_res(answer_exists=True, question_status="processing")
            n1 = await poller._tick(mock_conn)
            assert n1 == 0
            assert poller._subscriptions["Q1"]["phase"] == "processing"
            assert poller._subscriptions["Q1"]["last_activity"] == 5.0

            # Тик 2: now=5+answer_timeout+1, reasoning не растёт → таймаут answer
            mock_poll.return_value = _poll_res(answer_exists=True, question_status="processing")
            n2 = await poller._tick(mock_conn)

        mock_mark.assert_called_once_with(
            assistant_message_id="m1",
            question_uid="Q1",
            reason="answer",
        )
        assert n2 == 1
        assert "Q1" not in poller._subscriptions

    async def test_tick_reasoning_growth_extends_answer_timeout(self, settings, mock_conn):
        """Рост reasoning_len продлевает idle-таймаут в фазе processing."""
        answer_timeout = settings.agent_channel.answer_timeout_sec
        # subscribe=0, тик1=5 (переход в processing+reasoning=10, activity=5)
        # тик2=5+answer_timeout-1 (reasoning растёт до 25, activity обновляется)
        # тик3=5+answer_timeout-1+answer_timeout+1 (reasoning не растёт → таймаут)
        t1 = 5.0
        t2 = t1 + answer_timeout - 1
        t3 = t2 + answer_timeout + 1
        times = [0.0, t1, t2, t3]
        idx = [0]

        def fake_now():
            val = times[idx[0]]
            idx[0] = min(idx[0] + 1, len(times) - 1)
            return val

        poller = _make_poller(settings, now=fake_now, executor=mock_conn)
        poller.subscribe(assistant_message_id="m1", question_uid="Q1")

        with (
            patch(
                "app.domains.chat.services.agent_channel.AgentChannelService.poll_once",
                new_callable=AsyncMock,
            ) as mock_poll,
            patch(
                "app.domains.chat.services.agent_channel.AgentChannelService.mark_timeout",
                new_callable=AsyncMock,
            ) as mock_mark,
        ):
            # Тик 1: переход в processing, reasoning_len=10 → alive=True
            mock_poll.return_value = _poll_res(answer_exists=True, question_status="processing", reasoning_len=10)
            await poller._tick(mock_conn)
            assert poller._subscriptions["Q1"]["last_activity"] == t1

            # Тик 2: reasoning растёт 10→25 → alive=True, last_activity=t2
            mock_poll.return_value = _poll_res(answer_exists=True, question_status="processing", reasoning_len=25)
            await poller._tick(mock_conn)
            assert poller._subscriptions["Q1"]["last_activity"] == t2

            # Тик 3: reasoning не растёт (25=25), now=t3, t3-t2=answer_timeout+1 → таймаут
            mock_poll.return_value = _poll_res(answer_exists=True, question_status="processing", reasoning_len=25)
            n = await poller._tick(mock_conn)

        mock_mark.assert_called_once_with(
            assistant_message_id="m1",
            question_uid="Q1",
            reason="answer",
        )
        assert n == 1

    async def test_tick_pending_keeps_subscription_no_liveness(self, settings, mock_conn):
        """Если poll_once возвращает outcome='pending' без признаков жизни — подписка остаётся."""
        poller = _make_poller(settings, executor=mock_conn)
        poller.subscribe(assistant_message_id="m1", question_uid="Q1")

        with patch(
            "app.domains.chat.services.agent_channel.AgentChannelService.poll_once",
            new_callable=AsyncMock,
            return_value=_poll_res(),
        ):
            n = await poller._tick(mock_conn)

        assert n == 0
        assert "Q1" in poller._subscriptions

    async def test_tick_want_queue_position_only_in_pending(self, settings, mock_conn):
        """want_queue_position=True только в pending-фазе; в processing — False."""
        poller = _make_poller(settings, executor=mock_conn)
        poller.subscribe(assistant_message_id="m1", question_uid="Q1")

        with patch(
            "app.domains.chat.services.agent_channel.AgentChannelService.poll_once",
            new_callable=AsyncMock,
        ) as mock_poll:
            # Тик 1: pending → want_queue_position=True
            mock_poll.return_value = _poll_res()
            await poller._tick(mock_conn)
            kwargs1 = mock_poll.call_args.kwargs
            assert kwargs1["want_queue_position"] is True

            # Переключаем в processing вручную
            poller._subscriptions["Q1"]["phase"] = "processing"

            # Тик 2: processing → want_queue_position=False
            mock_poll.return_value = _poll_res(answer_exists=True, question_status="processing")
            await poller._tick(mock_conn)
            kwargs2 = mock_poll.call_args.kwargs
            assert kwargs2["want_queue_position"] is False

    async def test_tick_answer_updated_at_first_observation_is_baseline(
        self, settings, mock_conn
    ):
        """Первое ненулевое answer_updated_at — baseline (не activity); второе изменение — activity."""
        dt1 = datetime(2024, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
        dt2 = datetime(2024, 1, 1, 12, 0, 5, tzinfo=timezone.utc)

        times = [0.0, 10.0, 20.0]
        idx = [0]

        def fake_now():
            val = times[idx[0]]
            idx[0] = min(idx[0] + 1, len(times) - 1)
            return val

        poller = _make_poller(settings, now=fake_now, executor=mock_conn)
        poller.subscribe(assistant_message_id="m1", question_uid="Q1")
        # Переводим в processing, чтобы answer_updated_at был релевантен
        poller._subscriptions["Q1"]["phase"] = "processing"

        with patch(
            "app.domains.chat.services.agent_channel.AgentChannelService.poll_once",
            new_callable=AsyncMock,
        ) as mock_poll:
            # Тик 1 (now=10): первое наблюдение answer_updated_at=dt1 → baseline, НЕ activity
            mock_poll.return_value = _poll_res(
                answer_exists=True, question_status="processing", answer_updated_at=dt1
            )
            await poller._tick(mock_conn)
            assert poller._subscriptions["Q1"]["last_activity"] == 0.0  # не обновилась при subscribe
            assert poller._subscriptions["Q1"]["last_answer_updated_at"] == dt1

            # Тик 2 (now=20): answer_updated_at изменился dt1→dt2 → activity
            mock_poll.return_value = _poll_res(
                answer_exists=True, question_status="processing", answer_updated_at=dt2
            )
            await poller._tick(mock_conn)
            assert poller._subscriptions["Q1"]["last_activity"] == 20.0

    async def test_tick_phase_does_not_roll_back_to_pending(self, settings, mock_conn):
        """Фаза монотонна: откат шины (ответ исчез / статус вернулся pending)
        НЕ откатывает phase processing → pending, НЕ обновляет last_activity,
        и по истечении answer_timeout_sec наступает mark_timeout(reason='answer').
        """
        answer_timeout = settings.agent_channel.answer_timeout_sec
        # subscribe=0, тик1=5 (answer_exists → processing), тик2=10 (шина «откатилась»),
        # тик3=10+answer_timeout+1 (нет признаков жизни → answer-таймаут)
        t1, t2, t3 = 5.0, 10.0, float(10 + answer_timeout + 1)
        times = [0.0, t1, t2, t3]
        idx = [0]

        def fake_now():
            val = times[idx[0]]
            idx[0] = min(idx[0] + 1, len(times) - 1)
            return val

        poller = _make_poller(settings, now=fake_now, executor=mock_conn)
        poller.subscribe(assistant_message_id="m1", question_uid="Q1")

        with (
            patch(
                "app.domains.chat.services.agent_channel.AgentChannelService.poll_once",
                new_callable=AsyncMock,
            ) as mock_poll,
            patch(
                "app.domains.chat.services.agent_channel.AgentChannelService.mark_timeout",
                new_callable=AsyncMock,
            ) as mock_mark,
        ):
            # Тик 1: answer_exists=True → phase становится processing, activity=t1
            mock_poll.return_value = _poll_res(answer_exists=True, question_status="processing")
            await poller._tick(mock_conn)
            assert poller._subscriptions["Q1"]["phase"] == "processing"
            assert poller._subscriptions["Q1"]["last_activity"] == t1

            # Тик 2: шина «откатилась» — answer_exists=False, question_status="pending";
            # phase НЕ должна вернуться к pending, last_activity НЕ должна обновиться
            mock_poll.return_value = _poll_res(answer_exists=False, question_status="pending")
            await poller._tick(mock_conn)
            assert poller._subscriptions["Q1"]["phase"] == "processing"
            assert poller._subscriptions["Q1"]["last_activity"] == t1  # не изменилась

            # Тик 3: now=t3, от last_activity=t1 прошло answer_timeout+1 → answer-таймаут
            mock_poll.return_value = _poll_res(answer_exists=False, question_status="pending")
            n = await poller._tick(mock_conn)

        mock_mark.assert_called_once_with(
            assistant_message_id="m1",
            question_uid="Q1",
            reason="answer",
        )
        assert n == 1
        assert "Q1" not in poller._subscriptions

    async def test_tick_answer_disappearance_does_not_extend_timeout(
        self, settings, mock_conn
    ):
        """Исчезновение строки-ответа (answer_updated_at=None) не продлевает idle-таймер.

        Регрессия: до фикса None != datetime → alive=True на каждом тике после
        первого базового наблюдения, таймаут никогда не наступал.
        """
        dt1 = datetime(2024, 6, 1, 10, 0, 0, tzinfo=timezone.utc)
        answer_timeout = settings.agent_channel.answer_timeout_sec

        # Временная шкала:
        # subscribe=0, тик1=5 (baseline dt1, фаза processing),
        # тик2=6 (answer исчез → None, last_activity НЕ должна обновиться),
        # тики3..N=6+answer_timeout+1 (таймаут наступает)
        t_subscribe = 0.0
        t1 = 5.0
        t2 = 6.0
        t3 = float(6 + answer_timeout + 1)
        times = [t_subscribe, t1, t2, t3]
        idx = [0]

        def fake_now():
            val = times[idx[0]]
            idx[0] = min(idx[0] + 1, len(times) - 1)
            return val

        poller = _make_poller(settings, now=fake_now, executor=mock_conn)
        poller.subscribe(assistant_message_id="m1", question_uid="Q1")
        # Сразу переводим в processing, чтобы тестировать answer_updated_at-ветку
        poller._subscriptions["Q1"]["phase"] = "processing"

        with (
            patch(
                "app.domains.chat.services.agent_channel.AgentChannelService.poll_once",
                new_callable=AsyncMock,
            ) as mock_poll,
            patch(
                "app.domains.chat.services.agent_channel.AgentChannelService.mark_timeout",
                new_callable=AsyncMock,
            ) as mock_mark,
        ):
            # Тик 1 (now=t1): первое наблюдение answer_updated_at=dt1 → baseline, не активность
            mock_poll.return_value = _poll_res(
                answer_exists=True,
                question_status="processing",
                answer_updated_at=dt1,
            )
            await poller._tick(mock_conn)
            assert poller._subscriptions["Q1"]["last_answer_updated_at"] == dt1
            assert poller._subscriptions["Q1"]["last_activity"] == t_subscribe  # не изменилась

            # Тик 2 (now=t2): ответ исчез из шины — answer_updated_at=None
            # Ключевой ассерт: last_activity НЕ должна обновиться
            mock_poll.return_value = _poll_res(
                answer_exists=False,
                question_status="pending",
                answer_updated_at=None,
            )
            await poller._tick(mock_conn)
            assert poller._subscriptions["Q1"]["last_activity"] == t_subscribe  # не обновилась

            # Тик 3 (now=t3): от last_activity=t_subscribe прошло answer_timeout+1 → таймаут
            mock_poll.return_value = _poll_res(
                answer_exists=False,
                question_status="pending",
                answer_updated_at=None,
            )
            n = await poller._tick(mock_conn)

        mock_mark.assert_called_once_with(
            assistant_message_id="m1",
            question_uid="Q1",
            reason="answer",
        )
        assert n == 1
        assert "Q1" not in poller._subscriptions

    async def test_tick_exception_in_one_subscription_does_not_abort(
        self, settings, mock_conn
    ):
        """Ошибка в одной подписке не прерывает обработку остальных."""
        poller = _make_poller(settings, executor=mock_conn)
        poller.subscribe(assistant_message_id="m1", question_uid="Q1")
        poller.subscribe(assistant_message_id="m2", question_uid="Q2")

        async def _poll_once_side_effect(**kwargs):
            if kwargs.get("question_uid") == "Q1":
                raise RuntimeError("симулируем ошибку")
            return _poll_res(outcome="done", question_status="completed", answer_exists=True)

        with patch(
            "app.domains.chat.services.agent_channel.AgentChannelService.poll_once",
            new_callable=AsyncMock,
            side_effect=_poll_once_side_effect,
        ):
            n = await poller._tick(mock_conn)

        # Q2 обработан успешно — считается как done.
        assert n == 1
        assert "Q2" not in poller._subscriptions
        # Q1 остался в реестре — не удалён при ошибке.
        assert "Q1" in poller._subscriptions

    async def test_tick_repeated_exceptions_abandon_subscription(
        self, settings, mock_conn
    ):
        """Серия ошибок подряд → аварийное снятие + best-effort финализация draft'а.

        Транзиентные ошибки ретраятся (подписка живёт), но «отравленная»
        подписка (например, сменилась структура bus-таблицы) не должна
        ретраиться вечно, оставляя draft в 'streaming' до рестарта.
        """
        from app.domains.chat.services.agent_channel_poller import (
            _MAX_CONSECUTIVE_ENTRY_ERRORS,
        )

        poller = _make_poller(settings, executor=mock_conn)
        poller.subscribe(assistant_message_id="m1", question_uid="Q1")

        with patch(
            "app.domains.chat.services.agent_channel.AgentChannelService.poll_once",
            new_callable=AsyncMock,
            side_effect=RuntimeError("шина сломана"),
        ), patch(
            "app.domains.chat.services.agent_channel.AgentChannelService.mark_timeout",
            new_callable=AsyncMock,
        ) as mock_mark:
            for _ in range(_MAX_CONSECUTIVE_ENTRY_ERRORS - 1):
                await poller._tick(mock_conn)
            # До порога подписка живёт — ошибки считаются транзиентными.
            assert "Q1" in poller._subscriptions
            n = await poller._tick(mock_conn)

        assert n == 1
        assert "Q1" not in poller._subscriptions
        mock_mark.assert_called_once_with(
            assistant_message_id="m1",
            question_uid="Q1",
            reason="answer",
        )

    async def test_tick_abandon_swallows_finalize_failure(self, settings, mock_conn):
        """Сбой финализации при аварийном снятии глотается — подписка всё равно снята."""
        from app.domains.chat.services.agent_channel_poller import (
            _MAX_CONSECUTIVE_ENTRY_ERRORS,
        )

        poller = _make_poller(settings, executor=mock_conn)
        poller.subscribe(assistant_message_id="m1", question_uid="Q1")

        with patch(
            "app.domains.chat.services.agent_channel.AgentChannelService.poll_once",
            new_callable=AsyncMock,
            side_effect=RuntimeError("шина сломана"),
        ), patch(
            "app.domains.chat.services.agent_channel.AgentChannelService.mark_timeout",
            new_callable=AsyncMock,
            side_effect=RuntimeError("и финализация сломана"),
        ):
            for _ in range(_MAX_CONSECUTIVE_ENTRY_ERRORS):
                await poller._tick(mock_conn)

        assert "Q1" not in poller._subscriptions

    async def test_tick_success_resets_consecutive_errors(self, settings, mock_conn):
        """Успешный тик сбрасывает счётчик ошибок — ошибки должны идти ПОДРЯД."""
        poller = _make_poller(settings, executor=mock_conn)
        poller.subscribe(assistant_message_id="m1", question_uid="Q1")

        calls = [RuntimeError("транзиентная ошибка"), _poll_res()]

        async def _poll_once_side_effect(**kwargs):
            res = calls.pop(0)
            if isinstance(res, Exception):
                raise res
            return res

        with patch(
            "app.domains.chat.services.agent_channel.AgentChannelService.poll_once",
            new_callable=AsyncMock,
            side_effect=_poll_once_side_effect,
        ):
            await poller._tick(mock_conn)
            assert poller._subscriptions["Q1"]["consecutive_errors"] == 1
            await poller._tick(mock_conn)

        assert poller._subscriptions["Q1"]["consecutive_errors"] == 0


# ── Удержание соединения ──────────────────────────────────────────────────────


class _StopLoop(Exception):
    """Прерывает бесконечный цикл _run сразу после первого тика."""


class _CountingPool:
    """Фейковый пул: считает одновременно выданные соединения.

    ``held`` — выдано прямо сейчас, ``peak`` — максимум за тест. Поверх пула
    работает НАСТОЯЩИЙ ``get_db`` вместе со стражем повторного захвата
    (autouse-фикстура conftest включает строгий режим), поэтому тик,
    удерживающий соединение, ловится ровно как в dev-окружении.
    """

    def __init__(self, conn):
        self._conn = conn
        self.held = 0
        self.peak = 0

    async def acquire(self, timeout=None):
        self.held += 1
        self.peak = max(self.peak, self.held)
        return self._conn

    async def release(self, conn):
        self.held -= 1


class _BusFakeConn:
    """Соединение-заглушка на один тик: вопрос, ответ агента и draft-сообщение."""

    def __init__(self, question, answer):
        self._question = question
        self._answer = answer
        self.executed = []

    async def fetchrow(self, query, *args, **kwargs):
        if "FOR UPDATE" in query:          # draft в chat_messages
            return {"content": "[]", "status": "streaming"}
        if query.strip().lower().startswith("select media"):  # C1: get_media_by_uid
            return {"media": self._answer.get("media")}
        if "WHERE reply_to" in query:      # строка-ответ агента (C1: reply_to
            return self._answer            # теперь ещё и в списке колонок get_by_uid)
        return self._question              # строка-вопрос по id

    async def fetchval(self, query, *args, **kwargs):
        return 0

    async def fetch(self, query, *args, **kwargs):
        return []

    async def execute(self, query, *args, **kwargs):
        self.executed.append(query)
        return "UPDATE 1"

    def transaction(self):
        @asynccontextmanager
        async def _tx():
            yield

        return _tx()


class TestTickDoesNotHoldConnection:
    """Регрессия: тик поллера НЕ удерживает соединение из пула.

    Пока _run оборачивал тик в get_db(), обращения к БД из хвоста финализации
    — эмиссия уведомления «готов ответ базы знаний» и трансляция кнопок агента
    (acts.open_act_page → open_url) — оказывались повторным захватом пула в том
    же task'е. Страж get_db бросал RuntimeError, а вызывающий код его глотал:
    уведомление молча терялось, кнопка оставалась непереведённой.
    """

    @pytest.fixture(autouse=True)
    def _reset_global_registries(self):
        """Реестр фабрик и реестр ChatTool — глобальное состояние."""
        domain_registry.reset_registry()
        chat_tools.reset()
        yield
        domain_registry.reset_registry()
        chat_tools.reset()

    async def test_notification_and_buttons_run_with_zero_held_connections(
        self, settings
    ):
        """Один тик _run: пик захватов == 1, а уведомление и трансляция
        кнопок выполняются при нуле удерживаемых соединений."""
        question = {
            "id": "q-uid", "user_id": "u1", "status": "processing",
            "created_at": None,
        }
        answer = {
            "id": "a-uid", "role": "assistant", "status": "completed",
            "content": "Ответ агента", "metadata": {}, "media": None,
            "reply_to": "q-uid", "updated_at": None,
            "buttons": [{
                "action_id": "acts.open_act_page",
                "label": "Открыть акт",
                "params": {"km_number": "КМ-23-001"},
            }],
        }
        conn = _BusFakeConn(question, answer)
        pool = _CountingPool(conn)
        seen = {}

        async def _push(**kwargs):
            seen["push_held"] = pool.held
            # Уведомление пишется в БД — это и есть «второй захват пула».
            await get_executor().execute("INSERT INTO notifications ...")
            seen["pushed"] = True

        def _push_factory():
            svc = MagicMock()
            svc.push = _push
            return svc

        domain_registry.register_factory("notifications.push", _push_factory)

        async def _translate(params):
            seen["button_held"] = pool.held
            # Транслятор acts.open_act_page ходит в БД за id акта.
            await get_executor().fetchval("SELECT 1")
            seen["button_translated"] = True
            return {"action": "open_url", "params": {"url": "/constructor?act_id=1"}}

        chat_tools.register_tools([
            ChatTool(
                name="acts.open_act_page",
                domain="acts",
                description="Открыть страницу акта",
                button_translator=_translate,
            )
        ])

        # Исполнитель — процесс-синглтон (как на проде), поверх фейкового пула.
        poller = _make_poller(settings)
        poller.subscribe(assistant_message_id="m1", question_uid="q-uid")

        async def _stop_loop(_interval):
            raise _StopLoop

        # sleep в конце _run — вне try/except, поэтому исключение из него
        # выпускает нас из цикла ровно после первого тика.
        with (
            patch("app.db.connection._pool", pool),
            patch(
                "app.domains.chat.services.agent_channel_poller.asyncio.sleep",
                _stop_loop,
            ),
            pytest.raises(_StopLoop),
        ):
            await poller._run()

        assert seen.get("button_translated") is True, (
            "трансляция кнопки не дошла до БД — тик удерживал соединение"
        )
        assert seen["button_held"] == 0
        assert seen.get("pushed") is True, (
            "уведомление о готовности ответа потеряно — тик удерживал соединение"
        )
        assert seen["push_held"] == 0
        assert pool.peak == 1
        assert pool.held == 0
        assert "q-uid" not in poller._subscriptions
