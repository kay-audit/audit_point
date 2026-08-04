"""Тесты сводки «мои акты, требующие внимания» и признака блокировки в списке.

Репозиторий проверяется по SQL-форме (EXISTS по участнику, фильтр
needs_*/validation_status) и маппингу строк в ActAttentionItem; стратегия —
mock_conn + autouse-патч get_adapter, как в
tests/domains/notifications/test_notification_repository.py.

Блокировки в БД больше не хранятся, поэтому их вклад в оба ответа —
исключение заблокированных из сводки и is_locked/locked_by в списке —
проверяется на уровне ActCrudService, куда он и переехал.
"""

from datetime import date
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.domains.acts.repositories.act_crud import ActCrudRepository
from app.domains.acts.schemas.act_metadata import ActAttentionItem, ActListItem
from app.domains.acts.services.act_crud_service import ActCrudService


@pytest.fixture(autouse=True)
def _patch_adapter():
    """Подменяет get_adapter, чтобы BaseRepository работал вне init_db()."""
    adapter = MagicMock()
    adapter.get_table_name = lambda name, schema="": name
    with patch("app.db.repositories.base.get_adapter", return_value=adapter):
        yield


async def test_attention_query_shape(mock_conn):
    """SQL фильтрует по участнику (EXISTS) и берёт только акты с незакрытыми
    требованиями ИЛИ validation_status <> 'ok'."""
    mock_conn.fetch.return_value = []
    repo = ActCrudRepository(mock_conn)
    await repo.get_user_acts_needing_attention("12345")

    sql, *params = mock_conn.fetch.call_args.args
    assert "FROM acts a" in sql
    # участник через EXISTS по audit_team_members
    assert "EXISTS (" in sql
    assert "FROM audit_team_members atm" in sql
    assert "atm.username = $1" in sql
    # фильтр требований/валидации
    assert "a.needs_invoice_check" in sql
    assert "a.validation_status <> 'ok'" in sql
    assert params[0] == "12345"


async def test_attention_maps_rows_to_items(mock_conn):
    """Строки маппятся в ActAttentionItem с прокинутыми флагами/issues."""
    mock_conn.fetch.return_value = [
        {
            "id": 42, "inspection_name": "Акт А",
            "needs_created_date": False, "needs_directive_number": False,
            "needs_invoice_check": True, "needs_service_note": False,
            "validation_status": "ok", "validation_issues": None,
        },
        {
            "id": 43, "inspection_name": "Акт Б",
            "needs_created_date": False, "needs_directive_number": False,
            "needs_invoice_check": False, "needs_service_note": False,
            "validation_status": "error",
            "validation_issues": [{"code": "x", "severity": "error", "message": "M"}],
        },
    ]
    repo = ActCrudRepository(mock_conn)
    result = await repo.get_user_acts_needing_attention("12345")

    assert all(isinstance(it, ActAttentionItem) for it in result)
    assert [it.id for it in result] == [42, 43]
    assert result[0].needs_invoice_check is True
    assert result[1].validation_status == "error"
    assert result[1].validation_issues == [{"code": "x", "severity": "error", "message": "M"}]


async def test_attention_passes_limit(mock_conn):
    """limit прокидывается вторым позиционным параметром (потолок payload)."""
    mock_conn.fetch.return_value = []
    repo = ActCrudRepository(mock_conn)
    await repo.get_user_acts_needing_attention("12345", limit=50)

    _, *params = mock_conn.fetch.call_args.args
    assert params[1] == 50


# -------------------------------------------------------------------------
# Блокировки в ответах сервиса
# -------------------------------------------------------------------------


def _list_item(act_id: int) -> ActListItem:
    """Минимальный элемент списка актов (поля блокировки — по умолчанию пустые)."""
    return ActListItem(
        id=act_id,
        km_number=f"КМ-24-{act_id:05d}",
        part_number=1,
        total_parts=1,
        inspection_name=f"Акт {act_id}",
        order_number="1",
        inspection_start_date=date(2026, 1, 1),
        inspection_end_date=date(2026, 2, 1),
        last_edited_at=None,
        user_role="Куратор",
    )


def _make_service(*, acts=None, attention=None, locks=None, lock_error=None):
    """ActCrudService с замоканными репозиториями CRUD и блокировок."""
    crud = MagicMock()
    crud.count_user_acts = AsyncMock(return_value=len(acts or []))
    crud.get_user_acts = AsyncMock(return_value=acts or [])
    crud.get_user_acts_needing_attention = AsyncMock(return_value=attention or [])

    lock = MagicMock()
    lock.bulk_lock_info = AsyncMock(
        side_effect=lock_error, return_value=locks or {},
    )

    return ActCrudService(
        conn=MagicMock(), settings=MagicMock(),
        crud=crud, lock=lock, access=MagicMock(),
    )


async def test_list_marks_locked_acts():
    """is_locked/locked_by приезжают из хранилища блокировок, не из БД."""
    service = _make_service(
        acts=[_list_item(1), _list_item(2)],
        locks={2: {"locked_by": "11111111", "lock_expires_at": None}},
    )

    acts, total = await service.list_acts("12345")

    assert total == 2
    assert (acts[0].is_locked, acts[0].locked_by) == (False, None)
    assert (acts[1].is_locked, acts[1].locked_by) == (True, "11111111")


async def test_list_survives_lock_storage_failure():
    """Сбой хранилища блокировок не роняет список: акты отдаются как свободные."""
    service = _make_service(
        acts=[_list_item(1)], lock_error=ConnectionError("redis down"),
    )

    acts, _ = await service.list_acts("12345")

    assert [a.is_locked for a in acts] == [False]


async def test_attention_excludes_locked_acts():
    """Пока акт кто-то правит, в сводке «требуют внимания» его нет."""
    items = [ActAttentionItem(id=i, inspection_name=f"Акт {i}") for i in (1, 2, 3)]
    service = _make_service(
        attention=items,
        locks={2: {"locked_by": "11111111", "lock_expires_at": None}},
    )

    result = await service.get_attention_summary("12345")

    assert [it.id for it in result] == [1, 3]


async def test_attention_survives_lock_storage_failure():
    """Сбой хранилища блокировок оставляет сводку целиком — чтение fail-open."""
    items = [ActAttentionItem(id=1, inspection_name="Акт 1")]
    service = _make_service(attention=items, lock_error=ConnectionError("redis down"))

    result = await service.get_attention_summary("12345")

    assert [it.id for it in result] == [1]
