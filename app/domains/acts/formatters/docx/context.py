"""Контейнер данных для DOCX-форматера."""
from dataclasses import dataclass, field
from typing import Mapping

from app.domains.acts.schemas.act_content import ActDataSchema
from app.domains.acts.schemas.act_metadata import ActResponse


@dataclass(frozen=True, slots=True)
class ExportContext:
    """Полный контекст для генерации DOCX.

    metadata — из ActCrudService.get_act, content — из ActContentService,
    images — байты картинок нарушений, предзагруженные ОДНИМ запросом до
    сборки документа (``image_id → {"data": bytes, "mime_type": str}``).
    Форматер работает в пуле потоков и в БД не ходит, поэтому всё, что ему
    нужно, обязано лежать здесь.
    """
    metadata: ActResponse
    content: ActDataSchema
    images: Mapping[str, Mapping] = field(default_factory=dict)
