"""Тест-страж зеркала SUPPRESSED_CODES ↔ табличные коды серверной валидации.

Источник «validation» колокольчика конструктора
(static/js/constructor/header/notifications-source-validation.js) подавляет
табличные замечания сервера, потому что то же самое живее и сгруппированно
показывает источник «tables». Набор подавляемых кодов — ручное зеркало
`collect_validation_issues` (app/domains/acts/services/content_validation.py),
автоматической сверки у него нет.

Рассинхрон молчалив в обе стороны: новый серверный код таблиц, не попавший в
SUPPRESSED_CODES, вернётся в колокольчик двойным показом (плоско + группой);
переименованный или удалённый код останется в зеркале мёртвым, а живое
замечание исчезнет. Страж читает оба файла как текст и сверяет множества.

Валидацию сознательно НЕ исполняем на фейковых данных: набор эмитируемых кодов
зависел бы от того, какие ветки удалось задеть фикстурой, — это хрупко.
"""
import re
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parents[3]

_CONTENT_VALIDATION_PY = (
    _PROJECT_ROOT / "app" / "domains" / "acts" / "services" / "content_validation.py"
)
_SOURCE_VALIDATION_JS = (
    _PROJECT_ROOT / "static" / "js" / "constructor" / "header"
    / "notifications-source-validation.js"
)


def _server_table_codes() -> set[str]:
    """Табличные коды, которые эмитит collect_validation_issues."""
    source = _CONTENT_VALIDATION_PY.read_text(encoding="utf-8")
    return set(re.findall(r'"code":\s*"(table_[a-z_]+)"', source))


def _suppressed_codes() -> set[str]:
    """Содержимое литерала SUPPRESSED_CODES фронтового источника «validation»."""
    source = _SOURCE_VALIDATION_JS.read_text(encoding="utf-8")
    literal = re.search(
        r"SUPPRESSED_CODES\s*=\s*new Set\(\[(.*?)\]\)", source, re.DOTALL
    )
    assert literal, (
        "В notifications-source-validation.js не найден литерал "
        "`SUPPRESSED_CODES = new Set([...])` — страж не может его разобрать; "
        "либо константу переименовали, либо изменили форму объявления"
    )
    return set(re.findall(r"'([^']+)'", literal.group(1)))


class TestSuppressedCodesMirrorServer:
    """SUPPRESSED_CODES обязан совпадать с набором табличных кодов сервера."""

    def test_server_emits_table_codes(self):
        """Sanity-check самого стража: regex по серверу что-то нашёл."""
        assert _server_table_codes(), (
            "В content_validation.py не найдено ни одного кода вида "
            '`"code": "table_..."` — regex стража перестал соответствовать коду'
        )

    def test_suppressed_codes_match_server_table_codes(self):
        server = _server_table_codes()
        suppressed = _suppressed_codes()
        assert suppressed == server, (
            "Набор SUPPRESSED_CODES в notifications-source-validation.js "
            "разошёлся с табличными кодами collect_validation_issues.\n"
            f"Только на сервере (замечание попадёт в колокольчик дважды — "
            f"плоско и группой): {sorted(server - suppressed) or '—'}\n"
            f"Только во фронтовом зеркале (подавляется несуществующий код, "
            f"живое замечание могло пропасть): {sorted(suppressed - server) or '—'}\n"
            "Обнови SUPPRESSED_CODES под серверный набор — либо, если код "
            "исключён из подавления осознанно, отрази это здесь явным списком "
            "исключений с обоснованием."
        )
