"""Фикстура-эталон для export-parity golden-теста (Б-2.3/Б-2.4).

Один программный акт, задействующий ВСЕ возможности модели данных:
дерево 4 уровней, все 7 подвидов таблиц (TABLE_KINDS), объединения ячеек
(colSpan/rowSpan + spanOrigin), кастомные colWidths, спецсимволы в ячейках,
текстблок с formatting и inline-разметкой (b/i/u/s, ссылка, сноска) и
списками (многоуровневый <ul>, два соседних <ol> с вложенным),
нарушение со всеми 10 полями блочной модели (все 3 типа блоков —
текст/картинка/таблица — и нестандартный fieldOrder), пустая таблица и узел
type='item' с прикреплённой таблицей (известный кандидат на потерю в DOCX).

Все пользовательские строки — УНИКАЛЬНЫЕ маркеры (префикс GOLDEN_), чтобы
presence-проверки в test_export_parity.py были точными: маркер либо есть в
выводе формата, либо данные потеряны.

Фикстура обязана проходить ActDataSchema.model_validate (extra='forbid' на
словарях, кросс-валидатор ссылок дерево↔словари) — это проверяет сам тест.
"""
from datetime import date, datetime

import base64

from app.domains.acts.schemas.act_content import ActDataSchema
from app.domains.acts.schemas.act_metadata import ActResponse, AuditTeamMember

# Валидный PNG 1×1 (прозрачный пиксель) — python-docx встраивает его inline shape'ом.
# Байты картинки живут в отдельной таблице act_images, поэтому фикстура держит
# ссылку (GOLDEN_IMAGE_ID) и карту предзагруженных байт (GOLDEN_IMAGES) — ровно
# то, что экспорт подкладывает форматтерам.
GOLDEN_IMAGE_ID = "golden-image-0001"
GOLDEN_PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)
GOLDEN_IMAGES = {
    GOLDEN_IMAGE_ID: {"data": GOLDEN_PNG_BYTES, "mime_type": "image/png"},
}

# --- Маркеры, теряющиеся в части форматов (известные кандидаты из аудита) ---

# Содержимое таблицы, прикреплённой к узлу type='item' (не type='table'):
# MD/TXT рендерят tableId у любого узла, DOCX — только у type='table'.
MARKER_ATTACHED_TBL_CELL = "GOLDEN_ATTACHED_TBL_CELL"

# URL ссылки текстблока (data-link-url): в DOCX — relationship гиперссылки,
# в MD/TXT атрибут вырезается вместе с тегом.
MARKER_LINK_URL = "GOLDEN_LINK_URL"

# Текст сноски текстблока (data-footnote-text): в DOCX — native footnote,
# в MD/TXT атрибут вырезается вместе с тегом.
MARKER_FOOTNOTE_TEXT = "GOLDEN_TB_FOOTNOTE_TEXT"

# Имя файла картинки: в MD/TXT — текстовый плейсхолдер, в DOCX картинка
# встраивается байтами (имя файла не выводится — проверяется inline shape).
MARKER_IMG_FILENAME = "golden_image.png"

# Подпись картинки — выводится во всех форматах.
MARKER_IMG_CAPTION = "GOLDEN_V_IMG_CAPTION"

# --- Маркеры, обязанные присутствовать во ВСЕХ трёх форматах ---

MARKERS_ALL_FORMATS = [
    # Дерево: разделы и пункты (4 уровня вложенности).
    "GOLDEN_SEC1_LABEL",
    "GOLDEN_SEC2_LABEL",
    "GOLDEN_ITEM_1_1_LABEL",
    "GOLDEN_ITEM_1_1_1_LABEL",
    "GOLDEN_ITEM_DEEP_LABEL",
    "GOLDEN_ITEM_2_1_LABEL",
    "GOLDEN_ITEM_WITH_TABLE_LABEL",
    # content пункта — plain-текст, литеральные < и & не искажаются (M.4).
    "GOLDEN_ITEM_1_1_CONTENT",
    "литералы a<b и c&d",
    # Заголовки узлов-таблиц (customLabel) — все 7 kind + пустая.
    "GOLDEN_TBL_REGULAR_TITLE",
    "GOLDEN_TBL_METRICS_TITLE",
    "GOLDEN_TBL_MAINMETRICS_TITLE",
    "GOLDEN_TBL_REGULARRISK_TITLE",
    "GOLDEN_TBL_OPERATIONALRISK_TITLE",
    "GOLDEN_TBL_TAXRISK_TITLE",
    "GOLDEN_TBL_OTHERRISK_TITLE",
    "GOLDEN_EMPTY_TBL_TITLE",
    # Ячейки обычной таблицы: шапка, объединения, спецсимволы.
    "GOLDEN_RTBL_H0",
    "GOLDEN_RTBL_H1",
    "GOLDEN_RTBL_H2",
    "GOLDEN_RTBL_MERGED",
    "GOLDEN_RTBL_TALL",
    "GOLDEN_RTBL_R2C0",
    "GOLDEN_RTBL_SPECIALS",
    'спец x<y & "z"',
    # Ячейки спецтаблиц (по одной на kind).
    "GOLDEN_TBL_METRICS_CELL",
    "GOLDEN_TBL_MAINMETRICS_CELL",
    "GOLDEN_TBL_REGULARRISK_CELL",
    "GOLDEN_TBL_OPERATIONALRISK_CELL",
    "GOLDEN_TBL_TAXRISK_CELL",
    "GOLDEN_TBL_OTHERRISK_CELL",
    # Текстблок: текст внутри inline-разметки сохраняется во всех форматах.
    "GOLDEN_TB_BOLD",
    "GOLDEN_TB_ITALIC",
    "GOLDEN_TB_UNDERLINE",
    "GOLDEN_TB_STRIKE",
    "GOLDEN_TB_LINK_TEXT",
    "GOLDEN_TB_FOOTNOTE_ANCHOR",
    # Списки текстблока: многоуровневый <ul> и два соседних <ol> (изоляция
    # нумерации). Текст пунктов доезжает во всех форматах — в DOCX это
    # абзацы со своим w:numPr, в MD/TXT строки с текстовым маркером.
    "GOLDEN_TB_UL_L0",
    "GOLDEN_TB_UL_L1",
    "GOLDEN_TB_UL_L2",
    "GOLDEN_TB_UL_BACK_L0",
    "GOLDEN_TB_OL1_ITEM1",
    "GOLDEN_TB_OL1_ITEM2",
    "GOLDEN_TB_OL2_ITEM1",
    "GOLDEN_TB_OL_NESTED",
    # Нарушение (блочная модель): контент всех 10 полей и всех 3 типов блоков.
    "GOLDEN_V_VIOLATED",
    "GOLDEN_V_ESTABLISHED",
    "GOLDEN_V_DESC_1",
    "GOLDEN_V_DESC_2",
    "GOLDEN_V_CM_TEXT",
    "GOLDEN_V_CM_TH",
    "GOLDEN_V_CM_TH2",
    "GOLDEN_V_CM_CELL",
    "GOLDEN_V_CM_CELL2",
    "GOLDEN_V_PM_TEXT",
    "GOLDEN_V_FREETEXT",
    "GOLDEN_V_REASONS",
    "GOLDEN_V_MEASURES",
    "GOLDEN_V_CONSEQUENCES",
    "GOLDEN_V_RESPONSIBLE",
    MARKER_IMG_CAPTION,
    # Метка поля с labeled=True — во всех форматах. Метки CodeMining /
    # ProcessMining / Дополнительного контента сюда НЕ входят: эти поля
    # выводятся без заголовка (решение владельца) — их отсутствие проверяет
    # LABELS_NEVER_RENDERED.
    "Описание",
]

# Метки полей с labeled=False: не должны появляться НИ В ОДНОМ формате.
LABELS_NEVER_RENDERED = [
    "CodeMining",
    "ProcessMining",
    "Дополнительный контент",
]


def _cell(content: str = "", **kwargs) -> dict:
    """Ячейка grid в хранимом формате (kwargs поверх дефолтов схемы)."""
    return {"content": content, **kwargs}


def build_golden_act_dict() -> dict:
    """Сырой dict акта-эталона (вход ActDataSchema.model_validate)."""
    tree = {
        "id": "root",
        "label": "Акт",
        "type": "item",
        "children": [
            {
                "id": "sec1",
                "label": "GOLDEN_SEC1_LABEL Общие сведения",
                "type": "item",
                "number": "1",
                "children": [
                    {
                        "id": "n11",
                        "label": "GOLDEN_ITEM_1_1_LABEL",
                        "type": "item",
                        "number": "1.1",
                        "content": "GOLDEN_ITEM_1_1_CONTENT литералы a<b и c&d",
                        "children": [
                            {
                                "id": "n111",
                                "label": "GOLDEN_ITEM_1_1_1_LABEL",
                                "type": "item",
                                "number": "1.1.1",
                                "children": [
                                    {
                                        "id": "n1111",
                                        "label": "GOLDEN_ITEM_DEEP_LABEL",
                                        "type": "item",
                                        "number": "1.1.1.1",
                                        "children": [],
                                    },
                                ],
                            },
                        ],
                    },
                    {
                        "id": "n_tb",
                        "label": "Текстовый блок",
                        "type": "textblock",
                        "textBlockId": "tb1",
                        "number": "Текстовый блок 1",
                        "children": [],
                    },
                    {
                        "id": "n_v",
                        "label": "Нарушение",
                        "type": "violation",
                        "violationId": "v1",
                        "number": "Нарушение 1",
                        "children": [],
                    },
                    {
                        # Известный кандидат на потерю: tableId у узла type='item'.
                        "id": "n12",
                        "label": "GOLDEN_ITEM_WITH_TABLE_LABEL",
                        "type": "item",
                        "number": "1.2",
                        "tableId": "t_attached",
                        "children": [],
                    },
                ],
            },
            {
                "id": "sec2",
                "label": "GOLDEN_SEC2_LABEL Таблицы",
                "type": "item",
                "number": "2",
                "children": [
                    _table_node("regular", 1),
                    _table_node("metrics", 2),
                    _table_node("mainMetrics", 3),
                    _table_node("regularRisk", 4),
                    _table_node("operationalRisk", 5),
                    _table_node("taxRisk", 6),
                    _table_node("otherRisk", 7),
                    {
                        "id": "n_t_empty",
                        "label": "Пустая таблица",
                        "customLabel": "GOLDEN_EMPTY_TBL_TITLE",
                        "type": "table",
                        "tableId": "t_empty",
                        "number": "Таблица 8",
                        "children": [],
                    },
                    {
                        # Пункт ПОСЛЕ не-нумеруемых узлов-таблиц: проверка, что
                        # Word-нумерация не сбивается на смешанных siblings (Б-2.4).
                        "id": "n21",
                        "label": "GOLDEN_ITEM_2_1_LABEL",
                        "type": "item",
                        "number": "2.1",
                        "children": [],
                    },
                ],
            },
        ],
    }

    tables = {
        # Обычная таблица: шапка, merge по горизонтали и вертикали,
        # кастомные colWidths, спецсимволы.
        "t_regular": {
            "id": "t_regular",
            "nodeId": "n_t_regular",
            "kind": "regular",
            "colWidths": [200, 100, 100],
            "grid": [
                [
                    _cell("GOLDEN_RTBL_H0", isHeader=True),
                    _cell("GOLDEN_RTBL_H1", isHeader=True),
                    _cell("GOLDEN_RTBL_H2", isHeader=True),
                ],
                [
                    _cell("GOLDEN_RTBL_MERGED", colSpan=2),
                    _cell("", isSpanned=True, spanOrigin={"row": 1, "col": 0}),
                    _cell("GOLDEN_RTBL_TALL", rowSpan=2),
                ],
                [
                    _cell("GOLDEN_RTBL_R2C0"),
                    _cell('GOLDEN_RTBL_SPECIALS спец x<y & "z"'),
                    _cell("", isSpanned=True, spanOrigin={"row": 1, "col": 2}),
                ],
            ],
        },
        "t_metrics": _kind_table("metrics", "GOLDEN_TBL_METRICS_CELL"),
        "t_mainMetrics": _kind_table("mainMetrics", "GOLDEN_TBL_MAINMETRICS_CELL"),
        "t_regularRisk": _kind_table("regularRisk", "GOLDEN_TBL_REGULARRISK_CELL"),
        "t_operationalRisk": _kind_table(
            "operationalRisk", "GOLDEN_TBL_OPERATIONALRISK_CELL"
        ),
        "t_taxRisk": _kind_table("taxRisk", "GOLDEN_TBL_TAXRISK_CELL"),
        "t_otherRisk": _kind_table("otherRisk", "GOLDEN_TBL_OTHERRISK_CELL"),
        "t_attached": {
            "id": "t_attached",
            "nodeId": "n12",
            "kind": "regular",
            "grid": [[_cell(MARKER_ATTACHED_TBL_CELL)]],
        },
        "t_empty": {
            "id": "t_empty",
            "nodeId": "n_t_empty",
            "kind": "regular",
            "grid": [],
        },
    }

    text_blocks = {
        "tb1": {
            "id": "tb1",
            "nodeId": "n_tb",
            "content": (
                "<b>GOLDEN_TB_BOLD</b> <i>GOLDEN_TB_ITALIC</i> "
                "<u>GOLDEN_TB_UNDERLINE</u> <s>GOLDEN_TB_STRIKE</s> "
                '<span class="text-link" '
                f'data-link-url="https://example.com/{MARKER_LINK_URL}">'
                "GOLDEN_TB_LINK_TEXT</span> "
                '<span class="text-footnote" '
                f'data-footnote-text="{MARKER_FOOTNOTE_TEXT}">'
                "GOLDEN_TB_FOOTNOTE_ANCHOR</span>"
                # Маркированный список на 3 уровня с возвратом на верхний.
                "<ul>"
                "<li>GOLDEN_TB_UL_L0"
                "<ul>"
                "<li>GOLDEN_TB_UL_L1"
                "<ul><li>GOLDEN_TB_UL_L2</li></ul>"
                "</li>"
                "</ul>"
                "</li>"
                "<li>GOLDEN_TB_UL_BACK_L0</li>"
                "</ul>"
                # Два СОСЕДНИХ <ol>: изоляция нумерации (второй стартует с 1,
                # а не продолжает счёт первого) — регрессия правки §3.1.
                "<ol>"
                "<li>GOLDEN_TB_OL1_ITEM1</li>"
                "<li>GOLDEN_TB_OL1_ITEM2"
                "<ol><li>GOLDEN_TB_OL_NESTED</li></ol>"
                "</li>"
                "</ol>"
                "<ol><li>GOLDEN_TB_OL2_ITEM1</li></ol>"
            ),
        },
    }

    # Блочная модель: все 10 полей — контейнеры {enabled, blocks}; у нарушения
    # нестандартный fieldOrder (responsible поднят наверх) — паритет-тесты
    # проверяют, что все три формата уважают пользовательский порядок полей.
    violations = {
        "v1": {
            "id": "v1",
            "nodeId": "n_v",
            "fieldOrder": [
                "responsible", "violated", "established", "description",
                "codeMining", "processMining", "additionalContent",
                "reasons", "measures", "consequences",
            ],
            "violated": {
                "enabled": True,
                "blocks": [
                    {"id": "vb1", "type": "text", "content": "GOLDEN_V_VIOLATED"},
                ],
            },
            "established": {
                "enabled": True,
                "blocks": [
                    {"id": "vb2", "type": "text", "content": "GOLDEN_V_ESTABLISHED"},
                ],
            },
            "description": {
                "enabled": True,
                "blocks": [
                    {"id": "vb3", "type": "text", "content": "GOLDEN_V_DESC_1"},
                    {"id": "vb4", "type": "text", "content": "GOLDEN_V_DESC_2"},
                ],
            },
            "codeMining": {
                "enabled": True,
                "blocks": [
                    {"id": "vb5", "type": "text", "content": "GOLDEN_V_CM_TEXT"},
                    {
                        "id": "vb6",
                        "type": "table",
                        "table": {
                            "grid": [
                                [
                                    {"content": "GOLDEN_V_CM_TH", "isHeader": True},
                                    {"content": "GOLDEN_V_CM_TH2", "isHeader": True},
                                ],
                                [
                                    {"content": "GOLDEN_V_CM_CELL"},
                                    {"content": "GOLDEN_V_CM_CELL2"},
                                ],
                            ],
                            "colWidths": [120, 80],
                        },
                    },
                ],
            },
            "processMining": {
                "enabled": True,
                "blocks": [
                    {"id": "vb7", "type": "text", "content": "GOLDEN_V_PM_TEXT"},
                ],
            },
            "additionalContent": {
                "enabled": True,
                "blocks": [
                    {"id": "vb8", "type": "text", "content": "GOLDEN_V_FREETEXT"},
                    {
                        "id": "vb9",
                        "type": "image",
                        "image_id": GOLDEN_IMAGE_ID,
                        "caption": MARKER_IMG_CAPTION,
                        "filename": MARKER_IMG_FILENAME,
                        "width": 50,
                    },
                ],
            },
            "reasons": {
                "enabled": True,
                "blocks": [
                    {"id": "vb10", "type": "text", "content": "GOLDEN_V_REASONS"},
                ],
            },
            "measures": {
                "enabled": True,
                "blocks": [
                    {"id": "vb11", "type": "text", "content": "GOLDEN_V_MEASURES"},
                ],
            },
            "consequences": {
                "enabled": True,
                "blocks": [
                    {"id": "vb12", "type": "text", "content": "GOLDEN_V_CONSEQUENCES"},
                ],
            },
            "responsible": {
                "enabled": True,
                "blocks": [
                    {"id": "vb13", "type": "text", "content": "GOLDEN_V_RESPONSIBLE"},
                ],
            },
        },
    }

    return {
        "tree": tree,
        "tables": tables,
        "textBlocks": text_blocks,
        "violations": violations,
    }


def _table_node(kind: str, index: int) -> dict:
    """Узел-таблица данного kind с уникальным customLabel-заголовком."""
    return {
        "id": f"n_t_{kind}",
        "label": f"Таблица {kind}",
        "customLabel": f"GOLDEN_TBL_{kind.upper()}_TITLE",
        "type": "table",
        "kind": kind,
        "tableId": f"t_{kind}",
        "number": f"Таблица {index}",
        "children": [],
    }


def _kind_table(kind: str, cell_marker: str) -> dict:
    """TableSchema-словарь 2×2 с шапкой и маркером в data-ячейке."""
    return {
        "id": f"t_{kind}",
        "nodeId": f"n_t_{kind}",
        "kind": kind,
        "grid": [
            [_cell(f"{cell_marker}_H", isHeader=True), _cell("Значение", isHeader=True)],
            [_cell(cell_marker), _cell("42")],
        ],
    }


def build_golden_act() -> ActDataSchema:
    """Валидированный акт-эталон (упадёт, если фикстура не проходит схему)."""
    return ActDataSchema.model_validate(build_golden_act_dict())


def build_golden_metadata() -> ActResponse:
    """Метаданные акта для DOCX-пайплайна (cover/header/signature)."""
    return ActResponse(
        id=1,
        km_number="КМ-77-00001",
        part_number=1,
        total_parts=1,
        inspection_name="GOLDEN_INSPECTION",
        city="Москва",
        created_date=date(2026, 6, 1),
        order_number="Р-001",
        order_date=date(2026, 1, 15),
        is_process_based=True,
        inspection_start_date=date(2026, 2, 1),
        inspection_end_date=date(2026, 3, 1),
        audit_team=[
            AuditTeamMember(
                role="Куратор",
                full_name="Иванов Иван Иванович",
                position="Куратор отдела",
                username="ivanov",
            ),
            AuditTeamMember(
                role="Руководитель",
                full_name="Петров Пётр Петрович",
                position="Руководитель проверки",
                username="petrov",
            ),
        ],
        directives=[],
        created_at=datetime(2026, 6, 1, 12, 0, 0),
        updated_at=datetime(2026, 6, 1, 12, 0, 0),
        created_by="tester",
        last_edited_by=None,
        last_edited_at=None,
    )


def expected_item_numbers() -> list[str]:
    """Последовательность node.number структурных узлов type='item' (DFS).

    Источник истины для сверки Б-2.4: симулированная Word-нумерация DOCX
    обязана дать ту же последовательность.
    """
    numbers: list[str] = []

    def walk(node: dict) -> None:
        for child in node.get("children", []):
            if child.get("type", "item") == "item":
                numbers.append(child["number"])
            walk(child)

    walk(build_golden_act_dict()["tree"])
    return numbers
