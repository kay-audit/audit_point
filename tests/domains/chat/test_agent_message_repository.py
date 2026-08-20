"""Тесты репозитория chat_agent_messages_bus (bus-таблица канала к внешнему агенту).

Покрывают: insert_question, get_by_uid, set_status, count_pending_before,
count_active_for_user.
Стратегия: mock_conn + autouse-патч get_adapter — идентична
test_message_repository.py.
"""

import json
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from app.domains.chat.repositories.agent_message_repository import (
    AgentMessageRepository,
)


@pytest.fixture(autouse=True)
def _patch_adapter():
    """Подменяет get_adapter, чтобы BaseRepository работал вне init_db()."""
    adapter = MagicMock()
    adapter.get_table_name = lambda name, schema='': name
    adapter.qualify_table_name = lambda name, schema='': (
        f"{schema}.{name}" if schema else name
    )
    with patch("app.db.repositories.base.get_adapter", return_value=adapter):
        yield


def test_bus_table_name_is_not_prefixed():
    """Имя bus-таблицы НЕ префиксуется DATABASE__TABLE_PREFIX.

    Шина — интеграционный «провод» к внешнему агенту: репозиторий квалифицирует
    имя только схемой (qualify_table_name), без префикса приложения. Имя задаётся
    настройкой CHAT__AGENT_CHANNEL__TABLE_NAME целиком.
    """
    adapter = MagicMock()
    # get_table_name приклеил бы префикс — если бы его позвали, тест бы упал.
    adapter.get_table_name = lambda name, schema='': f"t_db_oarb_audit_act_{name}"
    adapter.qualify_table_name = lambda name, schema='': (
        f"{schema}.{name}" if schema else name
    )
    with patch("app.db.repositories.base.get_adapter", return_value=adapter):
        repo = AgentMessageRepository(
            MagicMock(), "chat_agent_messages_bus", schema="",
        )
    assert repo.table == "chat_agent_messages_bus"


# ── insert_question ──────────────────────────────────────────────────────


async def test_insert_question_returns_parsed_row(mock_conn):
    """insert_question делает INSERT с role='user', status='pending' и возвращает запись."""
    mock_conn.fetchrow.return_value = {
        "id": "msg-1",
        "chat_id": "chat-1",
        "user_id": "user1",
        "role": "user",
        "content": "Привет",
        "media": None,
        "metadata": '{"source": "aw"}',
        "buttons": None,
        "status": "pending",
    }
    repo = AgentMessageRepository(mock_conn)
    result = await repo.insert_question(
        id="msg-1",
        chat_id="chat-1",
        user_id="user1",
        content="Привет",
        metadata={"source": "aw"},
    )

    # Проверяем SQL-запрос
    sql, *params = mock_conn.fetchrow.call_args.args
    assert "INSERT INTO" in sql
    assert "chat_agent_messages_bus" in sql
    assert "'user'" in sql
    assert "'pending'" in sql
    assert "RETURNING *" in sql
    # Колонки conversation_id в шине больше нет (структура владельца-агента)
    assert "conversation_id" not in sql
    # Таблица чужая, DEFAULT'ы не гарантированы — таймстемпы передаются явно
    assert "created_at" in sql
    assert "updated_at" in sql
    # buttons в списке колонок — иначе владелец подставит DEFAULT (NULL) и
    # уронит INSERT на NOT NULL без DEFAULT
    assert "buttons" in sql

    # Позиционные параметры
    assert params[0] == "msg-1"       # id (uid сообщения)
    assert params[1] == "chat-1"      # chat_id
    assert params[2] == "user1"       # user_id
    assert params[3] == "Привет"      # content

    # metadata сериализована в JSON-строку
    assert json.loads(params[5]) == {"source": "aw"}

    # JSONB-поля раскодированы в _parse_row
    assert result["metadata"] == {"source": "aw"}
    assert result["status"] == "pending"
    assert result["role"] == "user"


async def test_insert_question_media_serialized(mock_conn):
    """media передаётся как JSON-строка в параметре $5."""
    mock_conn.fetchrow.return_value = {
        "id": "msg-2",
        "chat_id": "chat-1",
        "user_id": "user1",
        "role": "user",
        "content": "файл",
        "media": '[{"type": "file", "url": "x"}]',
        "metadata": "{}",
        "buttons": None,
        "status": "pending",
    }
    repo = AgentMessageRepository(mock_conn)
    media = [{"type": "file", "url": "x"}]
    await repo.insert_question(
        id="msg-2",
        chat_id="chat-1",
        user_id="user1",
        content="файл",
        media=media,
    )
    _, *params = mock_conn.fetchrow.call_args.args
    # media — пятый параметр (0-based: 4)
    assert json.loads(params[4]) == media


async def test_insert_question_media_default_is_empty_list(mock_conn):
    """Если media не передан, в параметр идёт пустой JSON-массив, не NULL.

    Владелец шины держит media NOT NULL без DEFAULT (``media JSONB DEFAULT
    '[]'::jsonb`` — массив) — SQL NULL в этой колонке роняет INSERT.
    """
    mock_conn.fetchrow.return_value = {
        "id": "m", "chat_id": "c", "user_id": "u",
        "role": "user", "content": "x",
        "media": "[]", "metadata": "{}", "buttons": "[]", "status": "pending",
    }
    repo = AgentMessageRepository(mock_conn)
    await repo.insert_question(
        id="m", chat_id="c", user_id="u", content="x",
    )
    _, *params = mock_conn.fetchrow.call_args.args
    assert params[4] is not None
    assert mock_conn.fetchrow.call_args[0][5] == "[]"
    assert json.loads(params[4]) == []  # media


async def test_insert_question_buttons_always_empty_list(mock_conn):
    """buttons не параметризуется вызывающим кодом — всегда пустой JSON-массив.

    Кнопки бывают только в ответе агента, вопрос от AW их никогда не несёт;
    важно лишь не отправлять NULL в NOT NULL колонку владельца.
    """
    mock_conn.fetchrow.return_value = {
        "id": "m", "chat_id": "c", "user_id": "u",
        "role": "user", "content": "x",
        "media": "[]", "metadata": "{}", "buttons": "[]", "status": "pending",
    }
    repo = AgentMessageRepository(mock_conn)
    await repo.insert_question(
        id="m", chat_id="c", user_id="u", content="x",
    )
    _, *params = mock_conn.fetchrow.call_args.args
    # buttons — седьмой параметр (0-based: 6)
    assert json.loads(params[6]) == []


# ── get_by_uid ───────────────────────────────────────────────────────────


async def test_get_by_uid_found(mock_conn):
    """get_by_uid возвращает запись по id (uid сообщения)."""
    mock_conn.fetchrow.return_value = {
        "id": "msg-1",
        "chat_id": "chat-1",
        "user_id": "user1",
        "role": "user",
        "content": "hi",
        "media": None,
        "metadata": '{"k": "v"}',
        "buttons": None,
        "status": "pending",
    }
    repo = AgentMessageRepository(mock_conn)
    result = await repo.get_by_uid("msg-1")

    sql, uid = mock_conn.fetchrow.call_args.args
    assert "SELECT" in sql
    assert "WHERE id = $1" in sql
    assert uid == "msg-1"

    assert result["id"] == "msg-1"
    assert result["metadata"] == {"k": "v"}  # JSONB раскодирован


async def test_get_by_uid_not_found(mock_conn):
    """get_by_uid возвращает None если строка не найдена."""
    mock_conn.fetchrow.return_value = None
    repo = AgentMessageRepository(mock_conn)
    result = await repo.get_by_uid("no-such-uid")
    assert result is None


async def test_parse_row_normalizes_uuid_fields(mock_conn):
    """id/reply_to типа uuid (как у владельца таблицы) нормализуются в str.

    На проде колонки id/reply_to — PG UUID; asyncpg отдаёт их объектами
    uuid.UUID. Остальной код (agent_ref, block_id, get_by_uid(reply_to))
    работает со строками — _parse_row обязан конвертировать.
    """
    row_id = uuid.uuid4()
    reply_to = uuid.uuid4()
    mock_conn.fetchrow.return_value = {
        "id": row_id,
        "chat_id": "chat-1",
        "user_id": "user1",
        "role": "user",
        "content": "hi",
        "media": None,
        "metadata": "{}",
        "buttons": None,
        "reply_to": reply_to,
        "status": "complete",
    }
    repo = AgentMessageRepository(mock_conn)
    result = await repo.get_by_uid(str(row_id))

    assert result["id"] == str(row_id)
    assert isinstance(result["id"], str)
    assert result["reply_to"] == str(reply_to)
    assert isinstance(result["reply_to"], str)


# ── get_answer_for_question ──────────────────────────────────────────────


async def test_get_answer_for_question_reverse_lookup(mock_conn):
    """Ответ ищется обратным lookup'ом: reply_to стоит НА ОТВЕТЕ агента.

    Протокол владельца шины: агент вставляет строку-ответ (role='assistant')
    с reply_to = id вопроса. Регрессия «вечной печати»: поиск по reply_to
    вопроса не находил ответ.
    """
    mock_conn.fetchrow.return_value = {
        "id": "a-uid",
        "chat_id": "c1",
        "user_id": None,
        "role": "assistant",
        "content": "Ответ",
        "media": None,
        "metadata": "{}",
        "buttons": None,
        "reply_to": "q-uid",
        "status": "completed",
    }
    repo = AgentMessageRepository(mock_conn)
    result = await repo.get_answer_for_question("q-uid")

    sql, q_uid = mock_conn.fetchrow.call_args.args
    assert "WHERE reply_to = $1" in sql
    assert "role = 'assistant'" in sql
    assert "ORDER BY created_at DESC" in sql
    assert "LIMIT 1" in sql
    assert q_uid == "q-uid"
    assert result["id"] == "a-uid"


async def test_get_answer_for_question_not_found(mock_conn):
    """Нет строки-ответа → None."""
    mock_conn.fetchrow.return_value = None
    repo = AgentMessageRepository(mock_conn)
    assert await repo.get_answer_for_question("q-uid") is None


# ── C1: узкие проекции колонок ─────────────────────────────────────────────


class TestColumnProjection:
    """C1: горячий опрос не тянет media. Ratchet на текст SQL."""

    async def test_get_by_uid_does_not_select_media(self, mock_conn):
        mock_conn.fetchrow.return_value = None
        repo = AgentMessageRepository(mock_conn)
        await repo.get_by_uid("q-uid")
        sql = mock_conn.fetchrow.call_args[0][0]
        assert "SELECT *" not in sql
        assert "media" not in sql

    async def test_get_answer_for_question_does_not_select_media(self, mock_conn):
        mock_conn.fetchrow.return_value = None
        repo = AgentMessageRepository(mock_conn)
        await repo.get_answer_for_question("q-uid")
        sql = mock_conn.fetchrow.call_args[0][0]
        assert "SELECT *" not in sql
        assert "media" not in sql

    async def test_get_media_by_uid_selects_only_media(self, mock_conn):
        mock_conn.fetchrow.return_value = {
            "media": '[{"file_id": "data:text/plain;base64,QQ=="}]'
        }
        repo = AgentMessageRepository(mock_conn)
        media = await repo.get_media_by_uid("a-uid")
        sql = mock_conn.fetchrow.call_args[0][0]
        assert sql.strip().lower().startswith("select media")
        assert media == [{"file_id": "data:text/plain;base64,QQ=="}]

    async def test_get_status_by_uid_narrow(self, mock_conn):
        mock_conn.fetchrow.return_value = {
            "status": "pending",
            "created_at": datetime(2026, 6, 10, 10, 0, tzinfo=timezone.utc),
        }
        repo = AgentMessageRepository(mock_conn)
        row = await repo.get_status_by_uid("q-uid")
        sql = mock_conn.fetchrow.call_args[0][0]
        assert "media" not in sql and "content" not in sql
        assert row["status"] == "pending"


# ── set_status ───────────────────────────────────────────────────────────


async def test_set_status_executes_update(mock_conn):
    """set_status делает UPDATE status + updated_at по id (uid сообщения)."""
    repo = AgentMessageRepository(mock_conn)
    await repo.set_status(uid="msg-1", status="in_progress")

    sql, status, uid = mock_conn.execute.call_args.args
    assert "UPDATE" in sql
    assert "chat_agent_messages_bus" in sql
    assert "status = $1" in sql
    assert "updated_at = CURRENT_TIMESTAMP" in sql
    assert "WHERE id = $2" in sql
    assert status == "in_progress"
    assert uid == "msg-1"


# ── count_pending_before ─────────────────────────────────────────────────


async def test_count_pending_before_filters_role_status_and_time(mock_conn):
    """count_pending_before считает глобальную очередь pending-вопросов до отметки времени."""
    repo = AgentMessageRepository(mock_conn)
    mock_conn.fetchval.return_value = 3
    ts = datetime(2026, 6, 10, 12, 0, tzinfo=timezone.utc)
    n = await repo.count_pending_before(ts)
    assert n == 3
    sql = mock_conn.fetchval.call_args.args[0]
    assert "role = 'user'" in sql and "status = 'pending'" in sql and "created_at < $1" in sql


# ── count_active_for_user ────────────────────────────────────────────────


async def test_count_active_for_user_two_phase_cutoffs(mock_conn):
    """count_active_for_user принимает раздельные отсечки для pending и processing."""
    repo = AgentMessageRepository(mock_conn)
    mock_conn.fetchval.return_value = 1
    now = datetime.now(timezone.utc)
    n = await repo.count_active_for_user(
        "77123", pending_created_after=now, processing_updated_after=now,
    )
    assert n == 1
    sql = mock_conn.fetchval.call_args.args[0]
    assert "status = 'pending' AND created_at > $2" in sql
    assert "status IN ('processing', 'in_progress', 'error') AND updated_at > $3" in sql


async def test_count_active_for_user_counts_error_by_updated_at_window(mock_conn):
    """Вопрос со status='error' занимает слот и считается по окну updated_at.

    NanoBot 2.3: 'error' — ПОВТОРЯЕМАЯ ошибка, вопрос вернётся в пул и будет
    переобработан, подписка AW жива → слот параллельных запросов занят.
    Отсечка — та же, что у processing: `_mark_failed` обновляет updated_at,
    поэтому error-строка в окне answer_timeout_sec учитывается, а залипшая
    (updated_at старше окна) слот не съедает.

    Стратегия файла — проверка SQL-контракта на mock_conn (реального db_conn в
    тестах нет), поэтому ассертим ветку запроса, а не результат COUNT.
    """
    repo = AgentMessageRepository(mock_conn)
    mock_conn.fetchval.return_value = 1
    now = datetime.now(timezone.utc)
    await repo.count_active_for_user(
        "77123", pending_created_after=now, processing_updated_after=now,
    )
    sql = mock_conn.fetchval.call_args.args[0]

    # 'error' — в ветке updated_at ($3), вместе с processing/in_progress.
    assert "status IN ('processing', 'in_progress', 'error') AND updated_at > $3" in sql
    # ...и НЕ в ветке created_at ($2) — иначе залипшая error-строка жила бы по
    # claim-окну и занимала слот дольше положенного.
    pending_branch = sql.split("OR (")[0]
    assert "'error'" not in pending_branch
    assert "status = 'pending' AND created_at > $2" in pending_branch


async def test_count_active_for_user_returns_count(mock_conn):
    """count_active_for_user делает SELECT COUNT по user_id, role='user' и активным статусам.

    'processing' — словарь владельца шины (агент claim'ит вопрос этим статусом);
    без него вопросы в работе у агента не считались бы активными.
    """
    mock_conn.fetchval.return_value = 2
    now = datetime.now(timezone.utc)
    repo = AgentMessageRepository(mock_conn)
    result = await repo.count_active_for_user(
        "user1",
        pending_created_after=now,
        processing_updated_after=now,
    )

    sql, user_id, *_ = mock_conn.fetchval.call_args.args
    assert "SELECT COUNT(*)" in sql
    assert "chat_agent_messages_bus" in sql
    assert "user_id = $1" in sql
    assert "role = 'user'" in sql
    assert "'pending'" in sql
    assert "'processing'" in sql
    assert user_id == "user1"
    assert result == 2


async def test_count_active_for_user_returns_zero_on_none(mock_conn):
    """count_active_for_user возвращает 0 если fetchval вернул None."""
    mock_conn.fetchval.return_value = None
    now = datetime.now(timezone.utc)
    repo = AgentMessageRepository(mock_conn)
    result = await repo.count_active_for_user(
        "user-empty",
        pending_created_after=now,
        processing_updated_after=now,
    )
    assert result == 0


async def test_count_active_for_user_passes_both_cutoffs(mock_conn):
    """Обе отсечки передаются в запрос как $2 и $3 соответственно."""
    mock_conn.fetchval.return_value = 1
    pending_cutoff = datetime(2026, 6, 10, 10, 0, tzinfo=timezone.utc)
    processing_cutoff = datetime(2026, 6, 10, 11, 0, tzinfo=timezone.utc)
    repo = AgentMessageRepository(mock_conn)
    result = await repo.count_active_for_user(
        "user1",
        pending_created_after=pending_cutoff,
        processing_updated_after=processing_cutoff,
    )

    sql, user_id, p_after, pr_after = mock_conn.fetchval.call_args.args
    assert user_id == "user1"
    assert p_after == pending_cutoff
    assert pr_after == processing_cutoff
    assert result == 1
