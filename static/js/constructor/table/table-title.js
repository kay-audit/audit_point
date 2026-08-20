/**
 * Единый предикат и текст заголовка таблицы — общий для DOM-рендерера
 * (items-renderer) и превью (preview). Без него условия показа расходились:
 * рендерер/превью скрывали заголовок при customLabel==='' (дефолт защищённых
 * таблиц из act_crud_service), хотя DOCX-экспорт в этом случае показывает
 * label (см. app/domains/acts/formatters/docx/formatter.py::_add_table_title:
 * `title = customLabel or label; if not title: return`).
 *
 * Эталон — DOCX: заголовок показывается, если есть непустой customLabel ИЛИ
 * label. Фронт дополнительно поддерживает автонумерацию (number) как
 * запасной текст, поэтому в предикат включён и number — это надмножество
 * DOCX, не сужающее показ.
 *
 * Здесь же — единое правило ОФОРМЛЕНИЯ подписи (tableTitleUnderlined): до него
 * оформление было размазано по контурам (инлайн-стили редактора, CSS превью,
 * bold в DOCX, дефисы в TXT) и разъехалось. Питоновское зеркало правила —
 * app/domains/acts/formatters/table_title.py, страж синхронизации —
 * tests/domains/acts/formatters/test_table_title_rule.py.
 *
 * Модуль БЕЗ DOM-зависимостей (импортируется и из тестов напрямую).
 */
import { getTableKind, KIND_REGULAR } from './table-kind.js';

/** Тип узла-таблицы (зеркало AppConfig.nodeTypes.TABLE, как в table-kind.js). */
const NODE_TYPE_TABLE = 'table';

/**
 * Разделы, у которых пресетная таблица получает подчёркнутую подпись.
 * Правило владельца сформулировано ПО РАЗДЕЛАМ: 1–4 — подчёркиваем, 5 — нет.
 * @type {readonly string[]}
 */
export const UNDERLINED_TITLE_SECTIONS = Object.freeze(['1', '2', '3', '4']);

/**
 * Текст заголовка таблицы: пользовательская метка → автонумерация → label.
 * @param {Object} node Узел-таблица дерева.
 * @returns {string} Текст заголовка ('' если показывать нечего).
 */
export function tableTitleText(node) {
    return node.customLabel || node.number || node.label || '';
}

/**
 * Показывать ли заголовок таблицы. Эталон — DOCX: непустой customLabel/label
 * (+ number как фронтовый fallback). customLabel==='' больше не скрывает
 * заголовок, если есть number/label.
 * @param {Object} node Узел-таблица дерева.
 * @returns {boolean} true если заголовок нужно отрисовать.
 */
export function shouldShowTableTitle(node) {
    return tableTitleText(node) !== '';
}

/**
 * Пресетная (автоматически созданная) таблица: признака «создана автоматически»
 * в модели нет, дискриминатор — защищённая обычная таблица. У пользовательских
 * protected=false, у спецтаблиц (метрики/риски) kind !== 'regular'.
 * @param {Object} node Узел-таблица дерева.
 * @returns {boolean} true если таблица пресетная.
 */
export function isPresetTable(node) {
    return !!node
        && node.type === NODE_TYPE_TABLE
        && node.protected === true
        && getTableKind(node) === KIND_REGULAR;
}

/**
 * Подчёркивать ли подпись таблицы — единое правило всех контуров.
 * Подчёркивается только пресетная таблица разделов 1–4; раздел 5, любые
 * пользовательские и спецтаблицы — без эффектов (жирного нет нигде).
 * @param {Object} node Узел-таблица дерева.
 * @param {string|null} rootSectionId ID раздела верхнего уровня, под которым лежит узел.
 * @returns {boolean} true если подпись подчёркивается.
 */
export function tableTitleUnderlined(node, rootSectionId) {
    if (rootSectionId === null || rootSectionId === undefined) return false;
    return isPresetTable(node)
        && UNDERLINED_TITLE_SECTIONS.includes(String(rootSectionId));
}

// Дублируем в window ради inline-скриптов в шаблонах (см. CLAUDE.md).
// Guard: модуль также импортируется в node:test, где window отсутствует.
if (typeof window !== 'undefined') {
    window.tableTitleText = tableTitleText;
    window.shouldShowTableTitle = shouldShowTableTitle;
    window.tableTitleUnderlined = tableTitleUnderlined;
}
