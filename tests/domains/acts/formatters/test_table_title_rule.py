"""Единое правило оформления подписи таблицы + страж синхронизации зеркал.

Правило владельца (действует во ВСЕХ контурах — редактор, превью, диалог
версий, DOCX/MD/TXT):

- пресетная (автосозданная) таблица разделов 1–4 — обычный текст, НЕ жирный,
  ПОДЧЁРКНУТЫЙ;
- раздел 5, любые таблицы — обычный, не жирный, БЕЗ подчёркивания;
- пользовательская таблица — без эффектов;
- таблица внутри блока нарушения — без эффектов (подписи у неё нет вовсе,
  ``ViolationTableBlockSchema`` поля caption не содержит).

Живёт правило в двух зеркалах — фронтовом
``static/js/constructor/table/table-title.js::tableTitleUnderlined`` и
питоновском ``app/domains/acts/formatters/table_title.py`` — и разъехаться
они могут молча: превью подчеркнёт, а Word нет. Страж ниже гоняет ОДНУ
матрицу случаев через обе реализации (JS — реальным node, не пересказом
регуляркой) и сверяет ответы.
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from app.domains.acts.formatters.table_title import (
    UNDERLINED_TITLE_SECTIONS,
    table_title_underlined,
)

ROOT = Path(__file__).resolve().parents[4]
JS_MODULE = ROOT / "static" / "js" / "constructor" / "table" / "table-title.js"


def _table(**kw) -> dict:
    """Узел-таблица дерева с переопределяемыми полями."""
    return {"id": "t1", "type": "table", "label": "Таблица", **kw}


# Матрица случаев — ОДНА на оба зеркала (питоновский предикат и JS через node).
# Ключи узла — как в дереве акта (protected/kind/type).
CASES: list[dict] = [
    {
        "name": "пресетная в разделе 1 — подчёркнута",
        "node": _table(protected=True),
        "root_section_id": "1",
        "expected": True,
    },
    {
        "name": "пресетная в разделе 2 — подчёркнута",
        "node": _table(protected=True, special="quality_assessment"),
        "root_section_id": "2",
        "expected": True,
    },
    {
        "name": "пресетная в разделе 3 — подчёркнута",
        "node": _table(protected=True),
        "root_section_id": "3",
        "expected": True,
    },
    {
        "name": "пресетная в разделе 4 — подчёркнута",
        "node": _table(protected=True),
        "root_section_id": "4",
        "expected": True,
    },
    {
        "name": "пресетная в разделе 5 — без подчёркивания",
        "node": _table(protected=True),
        "root_section_id": "5",
        "expected": False,
    },
    {
        "name": "пресетная в разделе 6 (Process Mining) — без подчёркивания",
        "node": _table(protected=True),
        "root_section_id": "6",
        "expected": False,
    },
    {
        "name": "пользовательская в разделе 2 — без эффектов",
        "node": _table(protected=False),
        "root_section_id": "2",
        "expected": False,
    },
    {
        "name": "пользовательская в разделе 5 — без эффектов",
        "node": _table(protected=False),
        "root_section_id": "5",
        "expected": False,
    },
    {
        "name": "флага protected нет вовсе — без эффектов",
        "node": _table(),
        "root_section_id": "2",
        "expected": False,
    },
    {
        "name": "metrics-таблица в разделе 5 — без подчёркивания",
        "node": _table(protected=True, kind="metrics"),
        "root_section_id": "5",
        "expected": False,
    },
    {
        "name": "risk-таблица в разделе 5 — без подчёркивания",
        "node": _table(protected=True, kind="operationalRisk"),
        "root_section_id": "5",
        "expected": False,
    },
    {
        "name": "спецтаблица, оказавшаяся в разделе 2 — не пресетная, без эффектов",
        "node": _table(protected=True, kind="metrics"),
        "root_section_id": "2",
        "expected": False,
    },
    {
        "name": "защищённый пункт (не таблица) — правило не про него",
        "node": {"id": "2", "type": "item", "protected": True, "label": "Раздел"},
        "root_section_id": "2",
        "expected": False,
    },
    {
        "name": "раздел неизвестен — без подчёркивания",
        "node": _table(protected=True),
        "root_section_id": None,
        "expected": False,
    },
]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_python_rule(case):
    """Питоновское зеркало правила отвечает по матрице."""
    assert table_title_underlined(
        case["node"], case["root_section_id"]
    ) is case["expected"], case["name"]


def test_underlined_sections_are_1_to_4():
    """Список подчёркиваемых разделов зафиксирован (правило владельца)."""
    assert set(UNDERLINED_TITLE_SECTIONS) == {"1", "2", "3", "4"}


class TestMirrorGuard:
    """Фронтовое и питоновское зеркала описывают ОДНО правило."""

    def test_js_module_declares_same_sections(self):
        """Список разделов во фронтовом модуле совпадает с питоновским."""
        import re

        text = JS_MODULE.read_text(encoding="utf-8")
        match = re.search(
            r"UNDERLINED_TITLE_SECTIONS\s*=\s*Object\.freeze\(\[([^\]]*)\]\)", text
        )
        assert match, (
            "в table-title.js не найдена константа UNDERLINED_TITLE_SECTIONS — "
            "правило переименовали или удалили, зеркала разъехались"
        )
        js_sections = set(re.findall(r"'([^']*)'", match.group(1)))
        assert js_sections == set(UNDERLINED_TITLE_SECTIONS), (
            "разделы с подчёркнутой подписью разошлись: JS "
            f"{sorted(js_sections)} vs Python {sorted(UNDERLINED_TITLE_SECTIONS)}"
        )

    def test_js_rule_answers_identically(self, tmp_path):
        """Та же матрица, прогнанная реальным node через фронтовый модуль."""
        node_exe = shutil.which("node")
        if node_exe is None:
            pytest.skip("node недоступен — сверка зеркал по матрице пропущена")

        cases_path = tmp_path / "cases.json"
        cases_path.write_text(
            json.dumps(
                [
                    {"node": c["node"], "rootSectionId": c["root_section_id"]}
                    for c in CASES
                ],
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        script = tmp_path / "run-rule.mjs"
        script.write_text(
            "import { readFileSync } from 'node:fs';\n"
            f"import {{ tableTitleUnderlined }} from {json.dumps(JS_MODULE.as_uri())};\n"
            f"const cases = JSON.parse(readFileSync({json.dumps(str(cases_path))}, 'utf-8'));\n"
            "console.log(JSON.stringify("
            "cases.map((c) => tableTitleUnderlined(c.node, c.rootSectionId))));\n",
            encoding="utf-8",
        )

        proc = subprocess.run(
            [node_exe, str(script)],
            capture_output=True, text=True, encoding="utf-8",
        )
        assert proc.returncode == 0, (
            "фронтовый модуль правила не исполнился: " + (proc.stderr or "")
        )
        js_answers = json.loads(proc.stdout.strip().splitlines()[-1])

        mismatched = [
            (c["name"], c["expected"], js)
            for c, js in zip(CASES, js_answers)
            if js is not c["expected"]
        ]
        assert not mismatched, (
            "фронтовое и питоновское зеркала правила разошлись (случай, "
            "ожидание Python, ответ JS): " + "; ".join(map(str, mismatched))
        )
