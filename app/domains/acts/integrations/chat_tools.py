"""ChatTool-инструменты домена acts.

После перехода на внешнего ИИ-агента информационные tool'ы (search_acts,
get_act_by_km и др. — всего 27) удалены: внешний агент сам ходит в БД.
Здесь остаются только action-tools — команды интерфейса.
"""
from app.core.chat.names import (
    TOOL_ADD_PROCESSES_TO_ACT,
    TOOL_CREATE_ACT,
    TOOL_MODIFY_ACT_TREE,
    TOOL_OPEN_ACT_PAGE,
)
from app.core.chat.tools import ChatTool, ChatToolParam
from app.domains.acts.integrations.action_handlers import (
    add_processes_to_act_handler,
    create_act_handler,
    modify_act_tree_handler,
    open_act_page_button_translator,
    open_act_page_handler,
)

_DOMAIN = "acts"


def get_chat_tools() -> list[ChatTool]:
    """Возвращает action-инструменты домена acts."""
    return [
        ChatTool(
            name=TOOL_OPEN_ACT_PAGE,
            domain=_DOMAIN,
            description=(
                "Открыть страницу конкретного акта в интерфейсе AuditWorkstation. "
                "Использовать ТОЛЬКО когда пользователь явно просит открыть/перейти "
                "к акту (а не запрашивает данные о нём — для этого есть "
                "chat.forward_to_knowledge_agent). "
                "Принимает КМ-номер или номер служебной записки (СЗ); должен быть "
                "указан хотя бы один. Если по критериям найдено несколько актов "
                "(один КМ может быть разбит на части с разными СЗ), tool вернёт "
                "список и попросит уточнить."
            ),
            parameters=[
                ChatToolParam(
                    "km_number", "string",
                    "Номер КМ акта, например КМ-12-32141 (опц., если указан sz_number)",
                    required=False,
                ),
                ChatToolParam(
                    "sz_number", "string",
                    "Номер служебной записки в формате текст/YYYY, "
                    "например 100/2024 (опц., если указан km_number)",
                    required=False,
                ),
            ],
            handler=open_act_page_handler,
            category="action",
            button_translator=open_act_page_button_translator,
        ),
        ChatTool(
            name=TOOL_CREATE_ACT,
            domain=_DOMAIN,
            description=(
                "Создать новый акт аудита в системе от имени текущего "
                "пользователя. Использовать когда пользователь говорит «создай "
                "акт», «заведи новую проверку», «оформи проверку», «сделай акт» — "
                "то есть выражает намерение создать новый акт проверки (а не "
                "открыть существующий — для этого есть acts.open_act_page). "
                "Tool задаёт уточняющие вопросы по недостающим обязательным "
                "полям (Наименование проверки, Город, Номер приказа, Дата приказа, "
                "Даты начала/окончания проверки, КМ-номер в формате КМ-XX-XXXXX, "
                "и Состав аудиторской группы с ролями Куратор/Руководитель/"
                "Редактор/Участник). Необязательные поля: Дата составления, "
                "Процессная проверка (true/false). Участники группы резолвятся "
                "из справочника admin по табельному номеру или ФИО — если "
                "пользователь дал только ФИО, tool найдёт совпадение. "
                "Права: создавать акты могут только пользователи с одной из "
                "ролей: Куратор, Руководитель, Админ. При успехе возвращает "
                "client_action с переходом на /constructor?act_id={new_id}."
            ),
            parameters=[
                ChatToolParam(
                    "inspection_name", "string",
                    "Наименование проверки (например: «Проверка соблюдения "
                    "требований по противодействию отмыванию доходов»)",
                    required=False,
                ),
                ChatToolParam(
                    "city", "string",
                    "Город проведения проверки (например: «Москва»)",
                    required=False,
                ),
                ChatToolParam(
                    "order_number", "string",
                    "Номер приказа о проведении проверки (например: «1234»)",
                    required=False,
                ),
                ChatToolParam(
                    "order_date", "date",
                    "Дата приказа в формате ГГГГ-ММ-ДД",
                    required=False,
                ),
                ChatToolParam(
                    "inspection_start_date", "date",
                    "Дата начала проверки в формате ГГГГ-ММ-ДД",
                    required=False,
                ),
                ChatToolParam(
                    "inspection_end_date", "date",
                    "Дата окончания проверки в формате ГГГГ-ММ-ДД (>= начала)",
                    required=False,
                ),
                ChatToolParam(
                    "km_number", "string",
                    "КМ-номер акта в формате КМ-XX-XXXXX (например, КМ-99-10202)",
                    required=False,
                ),
                ChatToolParam(
                    "audit_team", "array",
                    "Состав аудиторской группы — массив объектов {role, "
                    "username или full_name}. role: Куратор/Руководитель/"
                    "Редактор/Участник. Минимум 1 Куратор и 1 Руководитель. "
                    "username — табельный номер, full_name — ФИО (по нему "
                    "tool найдёт совпадение в справочнике)",
                    required=False,
                    items_type="object",
                ),
                ChatToolParam(
                    "created_date", "date",
                    "Дата составления акта в формате ГГГГ-ММ-ДД (опционально)",
                    required=False,
                ),
                ChatToolParam(
                    "is_process_based", "boolean",
                    "Процессная проверка (true/false, по умолчанию true)",
                    required=False, default=True,
                ),
            ],
            handler=create_act_handler,
            category="action",
        ),
ChatTool(
            name=TOOL_ADD_PROCESSES_TO_ACT,
            domain=_DOMAIN,
            description=(
                "Добавить процессы (из справочника t_db_oarb_ua_process_dict) "
                "в акт проверки как отдельные пункты в дереве. Использовать когда "
                "пользователь говорит «добавь в акт процесс П1004», «включи в "
                "проверку процессы ИЖС/готового жилья», «разбей акт по "
                "процессам», «в структуре акта добавь пункты по процессам». "
                "Tool резолвит коды процессов в справочнике, добавляет item-узлы "
                "в выбранный раздел (по умолчанию '5' — «Результаты проверки», "
                "или '6' для Process Mining — он создаётся автоматически), нумерует "
                "их и сохраняет дерево. Каждый процесс становится отдельным пунктом "
                "с label «П1004 - Расчет процентной ставки ИЖС». Права: "
                "Куратор/Руководитель/Редактор/Админ (Участник может только "
                "просматривать акт). На успехе возвращает client_action с переходом "
                "на /constructor?act_id={act_id} и текстовую сводку: какие "
                "процессы добавлены, в какой раздел, с какими номерами."
            ),
            parameters=[
                ChatToolParam(
                    "act_id", "integer",
                    "ID акта, в который добавлять процессы (целое число). "
                    "Обязательный — узнать можно из URL /constructor?act_id=... "
                    "или из таблицы «Мои проекты». Если не указан — tool "
                    "вернёт просьбу указать.",
                    required=False,
                ),
                ChatToolParam(
                    "process_codes", "array",
                    "Коды процессов из справочника ua_data, например "
                    "['П6152', 'П6153'] (формат ПXXXX или схожий). "
                    "Если не переданы — tool вернёт просьбу указать. Если "
                    "пользователь дал только название — СНАЧАЛА найди код через "
                    "chat.forward_to_knowledge_agent.",
                    required=False,
                    items_type="string",
                ),
                ChatToolParam(
                    "section_id", "string",
                    "ID раздела дерева для добавления (по умолчанию '5' — "
                    "«Результаты проверки»). Допустимые: '1'..'5'. Для Process "
                    "Mining используй '6' (раздел создаётся автоматически).",
                    required=False, default="5",
                ),
                ChatToolParam(
                    "start_number", "integer",
                    "Начать нумерацию пунктов с этого числа внутри раздела "
                    "(по умолчанию — продолжаем с последнего + 1).",
                    required=False,
                ),
            ],
            handler=add_processes_to_act_handler,
            category="action",
        ),
        ChatTool(
            name=TOOL_MODIFY_ACT_TREE,
            domain=_DOMAIN,
            description=(
                "Модификация дерева структуры акта: добавить пункт, "
                "текстовый блок, таблицу любого типа, заполнить таблицу, "
                "добавить строку в таблицу, нарушение, раздел Process Mining; "
                "удалить узел; переместить узел. Этот tool делает то же, что "
                "пользователь может сделать через контекстное меню в "
                "конструкторе («Добавить подпункт», «Добавить таблицу "
                "регуляторного риска», «Удалить», и т.д.) — но программно, "
                "без ручного клика. Использовать когда пользователь говорит "
                "«добавь подпункт в пункт 2 — Описание процесса», «добавь "
                "таблицу операционного риска», «удали пункт 5.1.2», «перенеси "
                "пункт 3.2 в пункт 5», «добавь раздел Process Mining», «заполни "
                "таблицу 5.2.3 — колонки Товар/Кол-во, данные: Ручка/5, "
                "Карандаш/12», «добавь строки в таблицу 5.2.3», «впиши П2008 в "
                "таблицу 1 в первый столбец». Параметр operations — список "
                "операций (можно комбинировать в одном вызове, например "
                "добавить сразу 5 пунктов и 1 таблицу, или add_table + "
                "fill_table одним вызовом). Права: Куратор/Руководитель/"
                "Редактор/Админ (Участник без права edit видит понятный "
                "отказ). parent_id и node_id принимают как полный id узла, "
                "так и human-readable number ('2', '5.1.2'). При успехе "
                "возвращает client_action с переходом на /constructor?act_id="
                "{act_id} и сводку с id/number каждого созданного/удалённого "
                "узла."
            ),
            parameters=[
                ChatToolParam(
                    "act_id", "integer",
                    "ID акта, в котором модифицируется структура. Обязательный.",
                    required=False,
                ),
                ChatToolParam(
                    "operations", "array",
                    "Список операций над деревом. Каждая операция — dict "
                    "с полем 'op' и параметрами:\n"
                    "- {'op': 'add_item', 'parent_id': '2', "
                    "'label': 'Описание процесса', 'content': ''}\n"
                    "- {'op': 'add_sibling', 'node_id': '5.1', 'label': '...'}\n"
                    "- {'op': 'add_textblock', 'parent_id': '5', "
                    "'label': 'Заметка', 'content': '<p>...</p>'}\n"
                    "- {'op': 'add_table', 'parent_id': '5', "
                    "'label': 'Риски', 'kind': 'regularRisk'} (kind: "
                    "regular, metrics, mainMetrics, regularRisk, "
                    "operationalRisk, taxRisk, otherRisk)\n"
                    "- {'op': 'fill_table', 'table_id': '<tableId из add_table "
                    "или number таблицы>', 'mode': 'replace'|'append_rows', "
                    "'grid': [[<row0>], [<row1>], ...]}. "
                    "Формат grid: compact — строки текста "
                    "[['Товар','Кол-во'],['Ручка',5]] (первая строка = "
                    "заголовки в режиме replace), full — полные ячейки "
                    "[{content,isHeader,colSpan,rowSpan,originRow,originCol}]. "
                    "Опционально: 'col_widths': [120,80,100] для задания ширин "
                    "колонок. mode='replace' (по умолчанию) заменяет таблицу "
                    "целиком, mode='append_rows' добавляет строки в конец "
                    "существующей таблицы (без заголовков).\n"
                    "- {'op': 'add_table_row', 'table_id': '<id таблицы>', "
                    "'first_value': 'П2008'} — добавить ОДНУ строку в конец "
                    "таблицы (все ячейки кроме первой — пустые). Удобно для "
                    "команд «впиши П2008 в таблицу», «добавь запись в первый "
                    "столбец». Если таблица имеет другие заголовки/ширину, "
                    "first_value попадёт в ячейку колонки 1. Также можно "
                    "передать 'row': ['П2008', 'Описание процесса', '500'] — "
                    "тогда будет добавлена строка с этими значениями по "
                    "колонкам. Длина row нормализуется к ширине таблицы.\n"
                    "- {'op': 'add_violation', 'parent_id': '5.1', "
                    "'label': '...', 'violated': '...', 'established': '...'}\n"
                    "- {'op': 'add_process_mining', 'label': '...'}\n"
                    "- {'op': 'delete_node', 'node_id': '5.1.2'}\n"
                    "- {'op': 'move_node', 'node_id': '5.1.2', "
                    "'new_parent_id': '5.2'}",
                    required=False,
                    items_type="object",
                ),
                ChatToolParam(
                    "dry_run", "boolean",
                    "Если true — операции применяются к копии дерева в "
                    "памяти, но не сохраняются. Используется для предпросмотра.",
                    required=False, default=False,
                ),
            ],
            handler=modify_act_tree_handler,
            category="action",
        ),
    ]
