"""Тесты ActImageRepository: адресация парой (act_id, id), дедуп и GC.

Реального соединения нет — все запросы через ``mock_conn`` + локальный
autouse-патч ``get_adapter``. Проверяется форма SQL и семантика разбора,
а не поведение СУБД.
"""

from unittest.mock import patch

import pytest

from app.domains.acts.repositories.act_image import (
    GC_MIN_AGE_MINUTES,
    ActImageRepository,
)


@pytest.fixture(autouse=True)
def _patch_adapter(mock_adapter):
    with patch("app.db.repositories.base.get_adapter", return_value=mock_adapter):
        yield


def _repo(mock_conn) -> ActImageRepository:
    return ActImageRepository(mock_conn)


# ── Чтение адресуется парой (act_id, id) ───────────────────────────────────


async def test_get_filters_by_act_id(mock_conn):
    """Одной картинки мало — запрос всегда сужен актом-владельцем.

    Иначе знание чужого uuid давало бы доступ к картинке чужого акта в обход
    проверки прав (и на GP запрос уходил бы во все сегменты).
    """
    mock_conn.fetchrow.return_value = {
        "id": "img-1", "mime_type": "image/png", "byte_size": 3, "data": b"abc",
    }
    result = await _repo(mock_conn).get(42, "img-1")

    assert result["id"] == "img-1"
    sql, *args = mock_conn.fetchrow.call_args[0]
    assert "WHERE id = $1 AND act_id = $2" in sql
    assert args == ["img-1", 42]


async def test_get_returns_none_when_missing(mock_conn):
    mock_conn.fetchrow.return_value = None
    assert await _repo(mock_conn).get(42, "нет-такой") is None


async def test_get_many_is_single_query(mock_conn):
    """Предзагрузка экспорта — один SELECT на все id (без N+1)."""
    mock_conn.fetch.return_value = [
        {"id": "a", "mime_type": "image/png", "byte_size": 1, "data": b"1"},
        {"id": "b", "mime_type": "image/webp", "byte_size": 1, "data": b"2"},
    ]
    result = await _repo(mock_conn).get_many(7, ["a", "b", "a"])

    assert set(result) == {"a", "b"}
    assert mock_conn.fetch.await_count == 1
    sql, act_id, ids = mock_conn.fetch.call_args[0]
    assert "act_id = $1" in sql and "id = ANY($2::varchar[])" in sql
    assert act_id == 7
    # Дубли схлопнуты, порядок первого появления сохранён.
    assert ids == ["a", "b"]


async def test_get_many_skips_query_for_empty_input(mock_conn):
    """Пустой список id — в БД не ходим вовсе."""
    assert await _repo(mock_conn).get_many(7, []) == {}
    assert await _repo(mock_conn).get_many(7, ["", None]) == {}
    assert mock_conn.fetch.await_count == 0


async def test_total_size_defaults_to_zero(mock_conn):
    """Акт без картинок — 0, а не None (бюджет считается арифметикой)."""
    mock_conn.fetchval.return_value = None
    assert await _repo(mock_conn).total_size(1) == 0


# ── Дедуп ──────────────────────────────────────────────────────────────────


async def test_find_id_by_hash_scoped_to_act(mock_conn):
    mock_conn.fetchval.return_value = "img-9"
    result = await _repo(mock_conn).find_id_by_hash(5, "a" * 64)

    assert result == "img-9"
    sql, act_id, digest = mock_conn.fetchval.call_args[0]
    assert "act_id = $1 AND content_hash = $2" in sql
    assert (act_id, digest) == (5, "a" * 64)


async def test_create_inserts_all_columns(mock_conn):
    await _repo(mock_conn).create(
        act_id=3, image_id="img-1", content_hash="h", mime_type="image/png",
        byte_size=4, data=b"1234", created_by="12345",
    )
    sql, *args = mock_conn.execute.call_args[0]
    assert "INSERT INTO act_images" in sql
    assert args == ["img-1", 3, "h", "image/png", 4, b"1234", "12345"]


# ── Сборка живых ссылок ────────────────────────────────────────────────────


def _field(*image_ids, extra_text=True):
    blocks = [{"id": f"i{n}", "type": "image", "image_id": i}
              for n, i in enumerate(image_ids)]
    if extra_text:
        blocks.insert(0, {"id": "t0", "type": "text", "content": "<p>x</p>"})
    return {"enabled": True, "blocks": blocks}


async def test_collect_live_ids_from_content_and_versions(mock_conn):
    """Живыми считаются ссылки И из текущего контента, И из ВСЕХ версий.

    Пропуск версий стёр бы картинки, нужные при восстановлении из истории.
    """
    import json

    mock_conn.fetch.side_effect = [
        # act_violations: одна строка, ссылка в additional_content
        [{
            "violated": json.dumps(_field("live-current")),
            "established": None, "description": None, "code_mining": None,
            "process_mining": None, "additional_content": None, "reasons": None,
            "measures": None, "consequences": None, "responsible": None,
        }],
        # act_content_versions: снимок со СВОЕЙ ссылкой
        [{"violations_data": json.dumps({
            "v1": {"reasons": _field("live-in-version")},
        })}],
    ]

    live = await _repo(mock_conn).collect_live_image_ids(1)
    assert live == {"live-current", "live-in-version"}


async def test_collect_live_ids_accepts_dict_jsonb(mock_conn):
    """Адаптер может отдать JSONB уже разобранным dict'ом — тоже читаем."""
    mock_conn.fetch.side_effect = [
        [{
            "violated": _field("from-dict"),
            "established": None, "description": None, "code_mining": None,
            "process_mining": None, "additional_content": None, "reasons": None,
            "measures": None, "consequences": None, "responsible": None,
        }],
        [],
    ]
    assert await _repo(mock_conn).collect_live_image_ids(1) == {"from-dict"}


async def test_collect_live_ids_ignores_broken_structures(mock_conn):
    """Повреждённые данные не роняют сбор и не считаются «ссылок нет».

    Мусорные значения просто пропускаются; ошибка здесь стирала бы картинки
    из готовых актов, поэтому разбор консервативен.
    """
    mock_conn.fetch.side_effect = [
        [{
            "violated": "не json вовсе",
            "established": {"blocks": "не список"},
            "description": {"blocks": [{"type": "image"}]},          # нет image_id
            "code_mining": {"blocks": [{"type": "image", "image_id": 42}]},  # не строка
            "process_mining": {"blocks": [None, 5]},
            "additional_content": None, "reasons": None, "measures": None,
            "consequences": None, "responsible": None,
        }],
        [{"violations_data": "["}],
    ]
    assert await _repo(mock_conn).collect_live_image_ids(1) == set()


# ── Удаление ───────────────────────────────────────────────────────────────


async def test_delete_unreferenced_excludes_live_and_fresh(mock_conn):
    """Удаляются только НЕживые И достаточно старые картинки.

    Возрастной порог закрывает гонку: только что загруженная картинка ещё не
    попала ни в контент, ни в версию, но мусором не является.
    """
    mock_conn.execute.return_value = "DELETE 2"
    deleted = await _repo(mock_conn).delete_unreferenced(9, {"keep-b", "keep-a"})

    assert deleted == 2
    sql, act_id, live = mock_conn.execute.call_args[0]
    assert "id <> ALL($2::varchar[])" in sql
    assert f"INTERVAL '{GC_MIN_AGE_MINUTES} minutes'" in sql
    assert act_id == 9
    assert live == ["keep-a", "keep-b"]


async def test_delete_unreferenced_without_live_ids_still_respects_age(mock_conn):
    """Живых ссылок нет — исключающего условия нет, но порог возраста остаётся."""
    mock_conn.execute.return_value = "DELETE 0"
    assert await _repo(mock_conn).delete_unreferenced(9, set()) == 0

    sql, act_id = mock_conn.execute.call_args[0]
    assert "ALL(" not in sql
    assert f"INTERVAL '{GC_MIN_AGE_MINUTES} minutes'" in sql
    assert act_id == 9


async def test_delete_for_act_removes_everything(mock_conn):
    mock_conn.execute.return_value = "DELETE 5"
    assert await _repo(mock_conn).delete_for_act(4) == 5
    sql, act_id = mock_conn.execute.call_args[0]
    assert "DELETE FROM act_images WHERE act_id = $1" in sql
    assert act_id == 4
