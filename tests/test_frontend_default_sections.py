"""Регрессия: defaultSections содержит 5 разделов; Process Mining — отдельный
обязательный пункт скелета (собирается вместе с defaultSections в
_createRootStructure, не входит в сам массив из-за фиксированного label)."""
import re
from pathlib import Path

CONFIG = Path(__file__).resolve().parents[1] / "static" / "js" / "shared" / "app-config.js"


def test_default_sections_are_one_to_five():
    text = CONFIG.read_text(encoding="utf-8")
    match = re.search(r"defaultSections:\s*\[(.+?)\]", text, re.DOTALL)
    assert match, "defaultSections не найден"
    items = re.findall(r"id:\s*'(\d)'", match.group(1))
    assert items == ["1", "2", "3", "4", "5"]


def test_process_mining_label_present_as_mandatory_section():
    text = CONFIG.read_text(encoding="utf-8")
    assert "processMiningSection" in text
    assert "Оценка процесса по результатам исследования методом Process Mining" in text
