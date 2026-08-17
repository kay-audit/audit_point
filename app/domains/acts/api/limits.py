"""
Эндпоинт лимитов контента актов.

Отдаёт фронту лимиты картинок нарушений (ACTS__IMAGES__*) и жёсткие
границы таблиц/текстблоков из констант схем — чтобы UI-валидация
совпадала с серверной (образец — chat GET /limits).
"""

import logging

from fastapi import APIRouter, Depends

from app.api.v1.deps.auth_deps import get_username
from app.domains.acts.deps import _get_acts_settings
from app.domains.acts.settings import ActsSettings

logger = logging.getLogger("audit_workstation.api.acts.limits")

router = APIRouter()


@router.get(
    "/limits",
    summary="Лимиты контента актов",
)
async def get_acts_limits(
    acts_cfg: ActsSettings = Depends(_get_acts_settings),
    _: str = Depends(get_username),
):
    """Возвращает лимиты картинок нарушений и границы таблиц/текстблоков.

    Фронт читает один раз при инициализации конструктора: валидация
    картинок (MIME/размер/число), границы grid/fontSize, потолок глубины
    списков (textblocks.max_list_level), лимиты числа
    блоков на узел (textblocks/tables/violations.per_node) и allowlist
    санитайзера (секция sanitizer) синхронизируются с серверными настройками
    (ACTS__IMAGES__* / ACTS__TABLES__* / ACTS__TEXTBLOCKS__* /
    ACTS__VIOLATIONS__* / ACTS__SANITIZER__*) — единый источник для UI-гейтов,
    схемы и DOMPurify.
    """
    images = acts_cfg.images
    tables = acts_cfg.tables
    textblocks = acts_cfg.textblocks
    violations = acts_cfg.violations
    sanitizer = acts_cfg.sanitizer
    return {
        "images": {
            "max_file_size": images.max_file_size,
            "max_total_size_per_act": images.max_total_size_per_act,
            "allowed_mime_types": images.allowed_mime_types,
            "max_items_per_violation": images.max_items_per_violation,
            "image_max_height_percent": images.image_max_height_percent,
        },
        "tables": {
            "max_rows": tables.max_rows,
            "max_cols": tables.max_cols,
            "min_col_width_px": tables.min_col_width_px,
            "per_node": tables.per_node,
        },
        "textblocks": {
            "font_size_min": textblocks.font_size_min,
            "font_size_max": textblocks.font_size_max,
            "font_size_default": textblocks.font_size_default,
            "per_node": textblocks.per_node,
            # UI-потолок глубины списков редактора (гейт indent/Tab).
            "max_list_level": textblocks.max_list_level,
        },
        "violations": {
            "per_node": violations.per_node,
        },
        "sanitizer": {
            "allowed_tags": sanitizer.allowed_tags,
            "allowed_css_properties": sanitizer.allowed_css_properties,
            "allowed_data_attrs": sanitizer.allowed_data_attrs,
        },
        # §6.8: kill-switch телеметрии редактора. Фронт кэширует ответ /limits
        # и, получив false, перестаёт слать батчи в /acts/editor-telemetry.
        "editor_telemetry_enabled": acts_cfg.editor_telemetry_enabled,
    }
