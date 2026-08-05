"""ChatTool-инструменты домена acts.

После перехода на внешнего ИИ-агента информационные tool'ы (search_acts,
get_act_by_km и др. — всего 27) удалены: внешний агент сам ходит в БД.
Здесь остаются только action-tools — команды интерфейса.
"""
from app.core.chat.names import (
    TOOL_FORWARD_TO_KNOWLEDGE_AGENT,
    TOOL_OPEN_ACT_PAGE,
)
from app.core.chat.tools import ChatTool, ChatToolParam, to_wire_name
from app.domains.acts.integrations.action_handlers import (
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
                f"{to_wire_name(TOOL_FORWARD_TO_KNOWLEDGE_AGENT)}). "
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
    ]
