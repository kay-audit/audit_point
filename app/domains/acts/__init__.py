"""
Домен актов.

Содержит всю бизнес-логику, связанную с актами:
CRUD, блокировки, содержимое, экспорт, фактуры.

Импорты API/routes/lifecycle — lazy, чтобы избежать
циклических импортов при загрузке settings из config.py.
"""


DOMAIN_NAME = "acts"


async def _health_check() -> dict:
    """Health-проверка домена актов: пинг БД и наличие таблицы acts.

    Возвращает структуру:
        {"status": "ok"|"error", "db": "reachable"|<msg>, "tables": "present"|"missing"}
    """
    from app.db.connection import get_db, get_adapter

    result: dict = {"status": "ok", "db": "reachable", "tables": "present"}

    try:
        adapter = get_adapter()
        async with get_db() as conn:
            await conn.fetchval("SELECT 1")
            expected = adapter.get_table_name("acts").split(".")[-1]
            existing = await adapter._get_existing_tables(conn, [expected])
            if expected not in existing:
                result["status"] = "error"
                result["tables"] = "missing"
    except Exception as exc:
        return {"status": "error", "db": str(exc), "tables": "unknown"}

    return result


def _build_domain():
    """Ленивое построение DomainDescriptor (вызывается из domain_registry)."""
    from app.core.domain import DomainDescriptor, KnowledgeBase, NavItem
    from app.domains.acts.api import get_api_routers
    from app.domains.acts.routes import get_html_routers
    from app.domains.acts._lifecycle import (
        on_shutdown,
        on_startup,
        register_lifespan_hooks,
    )
    from app.core import settings_registry
    from app.domains.acts.settings import ActsSettings
    from app.domains.acts.integrations.chat_tools import get_chat_tools

    # Регистрация инфраструктурных lifespan-hooks (батчер аудит-лога,
    # очистка просроченных блокировок) в общем реестре.
    register_lifespan_hooks()

    return DomainDescriptor(
        name=DOMAIN_NAME,
        api_routers=get_api_routers(),
        html_routers=get_html_routers(),
        settings_class=ActsSettings,
        dependencies={
            "admin": "роли/доступ к домену, справочник пользователей (IUserDirectory) для атрибуции авторов актов",
            "ua_data": "имена таблиц фактур (UaInvoiceTableNames) и справочники подразделений/контрагентов",
        },
        on_startup=on_startup,
        on_shutdown=on_shutdown,
        chat_tools=get_chat_tools(),
        migration_substitutions={
            "{REF_HADOOP_TABLES}": lambda: settings_registry.get(DOMAIN_NAME, ActsSettings).invoice.hive_registry_table,
        },
        health_check=_health_check,
        nav_items=[
            NavItem(
                label="Управление актами",
                url="/acts",
                icon_svg=(
                    '<path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 '
                    '012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 '
                    '01.293.707V19a2 2 0 01-2 2z" '
                    'stroke="currentColor" stroke-width="2" '
                    'stroke-linecap="round" stroke-linejoin="round"/>'
                ),
                order=10,
                active_page="acts",
                chat_domains=[DOMAIN_NAME],
                group="Аудит",
                description=(
                    "Список и редактирование актов аудита; конкретный акт "
                    "открывается через инструмент acts.open_act_page"
                ),
            ),
        ],
        knowledge_bases=[
            KnowledgeBase(
                key="knowledge_base_oarb",
                label="База Знаний ОАРБ",
                description="Поиск по базе знаний отдела аудита розничного бизнеса",
            ),
            KnowledgeBase(
                key="knowledge_base_sources",
                label="База знаний источников информации",
                description="Поиск по каталогу источников данных",
            ),
            KnowledgeBase(
                key="knowledge_base_tools",
                label="База знаний по инструментам",
                description="Поиск по документации инструментов",
            ),
        ],
chat_system_prompt=(
            "Ты — AI-ассистент для работы с актами аудита. "
            "Акты имеют древовидную структуру с 5 разделами: "
            "1) Информация о процессе, клиентском пути, "
            "2) Оценка качества проверенного процесса, "
            "3) Примененные технологии, "
            "4) Основные выводы, "
            "5) Результаты проверки. "
            "КМ-номера имеют формат КМ-XX-XXXXX. "
            "Служебные записки — формат Текст/ГГГГ.\n"
            "\n"
            "## Контекст пользователя и текущего акта\n"
            "В system-промпте ниже — раздел «## Контекст текущего пользователя» "
            "с логином, ФИО, должностью, ролями, списком доступных актов "
            "(id, КМ, наименование, твоя роль в команде, статус) и "
            "(если чат открыт из конструктора) пометкой «← ОТКРЫТ» на акте, "
            "который сейчас редактирует пользователь. По «я», «мой», "
            "«руководитель я», «куратор я» — подставляй username из этого "
            "контекста. На «открой мой последний акт», «какие у меня проекты» — "
            "отвечай по таблице актов без отдельных tool-вызовов.\n"
            "\n"
            "## Текущий открытый акт — приоритет для операций\n"
            "Если в контексте есть строка «Текущий открытый акт» — это "
            "значит, что пользователь редактирует акт в конструкторе и "
            "хочет работать с НИМ (а не с другими актами из таблицы). "
            "При вызове acts.add_processes_to_act / acts.open_act_page / "
            "любых tool'ов модификации — передавай этот act_id по умолчанию, "
            "если пользователь не указал явно другой. Если пользователь "
            "просит «найди в других моих актах», «посмотри в КМ-99-XXXXX» — "
            "тогда используй соответствующий КМ/название из таблицы актов.\n"
            "\n"
            "## ВАЖНО: действуй через инструменты, не на словах\n"
            "Если тебе нужно что-то СДЕЛАТЬ (создать акт, добавить процессы, "
            "открыть страницу) — ОБЯЗАТЕЛЬНО вызови соответствующий tool. "
            "Только ответить текстом «я добавил процессы» — НЕДОСТАТОЧНО: "
            "без вызова tool изменения в БД не произойдут. Никогда не сообщай "
            "пользователю об успехе, пока tool не вернул подтверждение (текст "
            "с client_action или сообщение об ошибке). Если tool вернул отказ "
            "(нет прав, нет данных) — объясни причину пользователю.\n"
            "\n"
            "## Создание нового акта (acts.create_act)\n"
            "Когда пользователь хочет СОЗДАТЬ новый акт (а не открыть существующий — "
            "для открытия используй acts.open_act_page), вызови acts.create_act и "
            "собирай данные через диалог:\n"
            "- Обязательные поля: наименование проверки, город, номер приказа, "
            "дата приказа, даты начала/оконца проверки, КМ-номер (КМ-XX-XXXXX), "
            "состав аудиторской группы (минимум 1 Куратор и 1 Руководитель).\n"
            "- Необязательные: дата составления, признак процессной проверки (по "
            "умолчанию true).\n"
            "- Если пользователь дал только ФИО участника — инструмент найдёт его в "
            "справочнике; если дал табельный номер — резолвится точнее.\n"
            "- Если инструмент сообщает, что не хватает полей — задай уточняющие "
            "вопросы пользователю. Не пытайся угадывать.\n"
            "- При успехе инструмент вернёт client_action с переходом на новый акт.\n"
            "\n"
            "## Добавление процессов в акт (acts.add_processes_to_act)\n"
            "Когда пользователь говорит «добавь в акт процесс П1004», «включи в "
            "проверку процессы ИЖС/готового жилья», «разбей акт по процессам», "
            "«в структуре акта добавь пункты по процессам» — ОБЯЗАТЕЛЬНО вызови "
            "acts.add_processes_to_act (одного chat.notify НЕ достаточно). "
            "Передай:\n"
            "- act_id (id акта — бери из таблицы «Доступные вам акты» в контексте "
            "пользователя или из истории диалога),\n"
            "- process_codes (список кодов процессов из справочника, формат "
            "«ПXXXX» — если пользователь дал только название, "
            "СНАЧАЛА найди код через chat.forward_to_knowledge_agent, "
            "и только потом вызывай add_processes_to_act),\n"
            "- section_id (по умолчанию '5' — «Результаты проверки»; для Process "
            "Mining — '6', раздел создаётся автоматически).\n"
            "Каждый процесс становится отдельным item-пунктом в дереве с label "
            "«П1004 - <название>». Инструмент сам проверит права (Куратор/"
            "Руководитель/Редактор/Админ), резолвит процессы в справочнике и "
            "сохранит изменения. Участник (без права edit) увидит понятный отказ. "
            "НЕ сообщай пользователю об успехе, пока tool не вернул подтверждение.\n"
            "\n"
            "## Модификация структуры акта (acts.modify_act_tree)\n"
            "Этот tool делает всё, что пользователь может сделать через "
            "контекстное меню в конструкторе (но без ручного клика):\n"
            "- add_item — добавить обычный подпункт (item) в раздел "
            "(parent_id — id раздела '1'..'5' или номер '2').\n"
            "- add_sibling — добавить соседний пункт ПОСЛЕ существующего.\n"
            "- add_textblock — добавить текстовый блок (HTML).\n"
            "- add_table — добавить таблицу (kind: regular / metrics / "
            "mainMetrics / regularRisk / operationalRisk / taxRisk / otherRisk).\n"
            "- add_violation — добавить нарушение.\n"
            "- add_process_mining — добавить раздел «Process Mining» (id='6') "
            "в корень, если ещё нет.\n"
            "- delete_node — удалить узел (рекурсивно с детьми).\n"
            "- move_node — переместить узел.\n"
            "parent_id / node_id принимают как полный id узла, так и "
            "human-readable number ('2', '5.1.2'). Используй этот tool на ЛЮБОЕ "
            "«добавь подпункт», «удали таблицу», «перенеси в раздел X», "
            "«вставь таблицу рисков» и т.п. — НЕ говори пользователю, что "
            "надо делать руками, делай сам. Если нужно несколько операций — "
            "передай их одним списком в operations.\n"
        ),
    )
