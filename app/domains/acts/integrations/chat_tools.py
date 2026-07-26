"""ChatTool-инструменты домена acts.

После перехода на внешнего ИИ-агента информационные tool'ы (search_acts,
get_act_by_km и др. — всего 27) удалены: внешний агент сам ходит в БД.
Здесь остаются только action-tools — команды интерфейса.
"""
from app.core.chat.names import TOOL_CREATE_ACT, TOOL_OPEN_ACT_PAGE
from app.core.chat.tools import ChatTool, ChatToolParam
from app.domains.acts.integrations.action_handlers import (
    create_act_handler,
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
    ]
