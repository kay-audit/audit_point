"""Сборка мусора картинок нарушений и предзагрузка байт для экспорта.

GC живёт в ``ActContentVersionRepository._cleanup_old_versions`` — там, где
уже вытесняются старые версии: именно вытеснение версии может оборвать
последнюю ссылку на картинку. Ошибка здесь стирает картинки из готовых
актов, поэтому проверяется прежде всего КОНСЕРВАТИВНОСТЬ.
"""

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.core.config import Settings
from app.domains.acts.repositories.act_content_version import (
    ActContentVersionRepository,
)
from app.domains.acts.services.export_service import ExportService
from app.domains.acts.settings import ActsSettings


@pytest.fixture(autouse=True)
def _patch_adapter(mock_adapter):
    with patch("app.db.repositories.base.get_adapter", return_value=mock_adapter):
        yield


def _repo_with_stub_images(mock_conn, *, live_ids=None, deleted=0):
    repo = ActContentVersionRepository(mock_conn)
    repo._images = MagicMock()
    repo._images.collect_live_image_ids = AsyncMock(return_value=live_ids or set())
    repo._images.delete_unreferenced = AsyncMock(return_value=deleted)
    return repo


# ── GC вызывается на вытеснении версий ─────────────────────────────────────


async def test_cleanup_collects_image_garbage(mock_conn):
    """Чистка версий тянет за собой чистку осиротевших картинок."""
    mock_conn.execute.return_value = "DELETE 1"
    repo = _repo_with_stub_images(mock_conn, live_ids={"a"}, deleted=2)

    await repo._cleanup_old_versions(act_id=5, max_versions=50)

    repo._images.collect_live_image_ids.assert_awaited_once_with(5)
    repo._images.delete_unreferenced.assert_awaited_once_with(5, {"a"})


async def test_gc_runs_even_when_no_versions_were_evicted(mock_conn):
    """Версии не вытеснялись — картинки всё равно пересчитываются.

    Ссылка могла оборваться и правкой контента (пользователь удалил блок),
    а не только вытеснением версии.
    """
    mock_conn.execute.return_value = "DELETE 0"
    repo = _repo_with_stub_images(mock_conn)

    await repo._cleanup_old_versions(act_id=5, max_versions=50)

    repo._images.delete_unreferenced.assert_awaited_once()


async def test_gc_error_is_not_swallowed(mock_conn):
    """Ошибка БД в GC пробрасывается — глотать её внутри транзакции нельзя.

    Вызов идёт внутри открытой транзакции сохранения: проглоченное
    исключение оставило бы её в aborted-состоянии и уронило сам COMMIT уже
    без внятного объяснения (та же политика, что у create_version).
    """
    mock_conn.execute.return_value = "DELETE 0"
    repo = _repo_with_stub_images(mock_conn)
    repo._images.collect_live_image_ids = AsyncMock(side_effect=RuntimeError("БД"))

    with pytest.raises(RuntimeError):
        await repo._cleanup_old_versions(act_id=5, max_versions=50)


async def test_dedup_skips_gc_entirely(mock_conn):
    """Снимок-дубль не создаётся — и GC не запускается (ничего не менялось)."""
    from app.domains.acts.repositories.act_content_version import compute_content_hash

    tree = {"id": "root", "children": []}
    mock_conn.fetchval.return_value = compute_content_hash(tree, {}, {}, {}, {})
    repo = _repo_with_stub_images(mock_conn)

    result = await repo.create_version(
        act_id=1, username="12345", save_type="manual",
        tree=tree, tables={}, textblocks={}, violations={},
    )

    assert result is None
    repo._images.delete_unreferenced.assert_not_called()


async def test_gc_runs_after_new_version_inserted(mock_conn):
    """Порядок: сначала INSERT версии, потом сбор живых ссылок.

    Обратный порядок посчитал бы картинку из свежесохранённой версии
    мусором и удалил её.
    """
    calls: list[str] = []
    mock_conn.fetchval.return_value = None
    mock_conn.fetchrow.side_effect = lambda *a, **kw: (
        calls.append("insert") or {"version_number": 3}
    )
    mock_conn.execute.return_value = "DELETE 0"

    repo = _repo_with_stub_images(mock_conn)
    repo._images.collect_live_image_ids = AsyncMock(
        side_effect=lambda act_id: (calls.append("collect") or set()),
    )

    await repo.create_version(
        act_id=1, username="12345", save_type="manual",
        tree={"id": "root"}, tables={}, textblocks={}, violations={},
    )

    assert calls == ["insert", "collect"]


# ── Предзагрузка байт для экспорта ─────────────────────────────────────────


def _export_service(image_repository=None) -> ExportService:
    settings = MagicMock(spec=Settings)
    settings.storage_dir = Path("/tmp/test_storage_export_images")
    with patch("app.domains.acts.services.export_service.TextFormatter"), \
         patch("app.domains.acts.services.export_service.MarkdownFormatter"), \
         patch("app.domains.acts.services.export_service.DocxFormatter"):
        return ExportService(
            storage=MagicMock(),
            settings=settings,
            acts_settings=ActsSettings(),
            act_crud_service=AsyncMock(),
            act_content_service=AsyncMock(),
            image_repository=image_repository,
        )


def _content_with_image(image_id: str):
    from app.domains.acts.schemas.act_content import ActDataSchema

    return ActDataSchema(
        tree={"id": "root", "label": "Акт", "children": []},
        violations={"v1": {
            "id": "v1", "nodeId": "n1",
            "additionalContent": {"enabled": True, "blocks": [
                {"id": "b1", "type": "image", "image_id": image_id},
            ]},
        }},
    )


async def test_export_preloads_images_in_single_query():
    """Байты подгружаются ОДНИМ запросом до рендера (нет N+1, нет БД в потоке)."""
    repo = MagicMock()
    repo.get_many = AsyncMock(return_value={"img-1": {"data": b"x", "mime_type": "image/png"}})
    svc = _export_service(repo)

    images = await svc._load_images(4, _content_with_image("img-1"))

    assert images == {"img-1": {"data": b"x", "mime_type": "image/png"}}
    repo.get_many.assert_awaited_once_with(4, {"img-1"})


async def test_export_skips_query_without_images():
    """В акте нет картинок — в БД не ходим вовсе."""
    from app.domains.acts.schemas.act_content import ActDataSchema

    repo = MagicMock()
    repo.get_many = AsyncMock()
    svc = _export_service(repo)

    content = ActDataSchema(tree={"id": "root", "label": "Акт", "children": []})
    assert await svc._load_images(4, content) == {}
    repo.get_many.assert_not_called()


async def test_export_without_repository_returns_empty_map():
    """Репозиторий не задан (юнит-тесты) — картинки уйдут плейсхолдерами."""
    svc = _export_service(None)
    assert await svc._load_images(4, _content_with_image("img-1")) == {}
