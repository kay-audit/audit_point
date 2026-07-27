"""Домен SQL-агента и блока «АГЕНТЫ» в sidebar.

Регистрирует:
- портал-страницу /sqlagent (iframe на отдельный процесс SQLAgent
  или заглушка для placeholder-инструмента);
- набор пунктов навигации в сайдбаре:
  * блок «АГЕНТЫ»: SQL-агент, ИОР, CRM, Документы,
    Источники данных, BackLog команд, Follow UP;
  * все эти инструменты, кроме самого SQL-агента, в данный момент
  в разработке — открываются по URL ``/sqlagent?tool=xxx`` и
  показывают однотипную заглушку с описанием.
"""

DOMAIN_NAME = "sqlagent"


def _build_domain():
    """Ленивое построение DomainDescriptor."""
    from app.core.domain import DomainDescriptor, NavItem
    from app.domains.sqlagent.routes import get_html_routers
    from app.domains.sqlagent.settings import SQLAgentSettings

    return DomainDescriptor(
        name=DOMAIN_NAME,
        html_routers=get_html_routers(),
        settings_class=SQLAgentSettings,
        nav_items=[
            # --- SQL-агент ----------------------------------------------------
            # Главный пункт. Иконка — шестерёнка (settings) — символ
            # автоматизации / конфигурации SQL-агента.
            NavItem(
                label="SQL-агент",
                url="/sqlagent",
                icon_svg=(
                    # шестерёнка: круг + 8 «зубцов» (прямоугольники по периметру)
                    '<circle cx="12" cy="12" r="3" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 '
                    '01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 '
                    '00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 '
                    '1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a'
                    '1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A'
                    '1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 '
                    '012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 '
                    '014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 '
                    '012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 '
                    '010 4h-.09a1.65 1.65 0 00-1.51 1z" '
                    'stroke="currentColor" stroke-width="2" '
                    'stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
                ),
                order=30,
                active_page="sqlagent",
                group="АГЕНТЫ",
                description="Автоматизация запросов к источникам данных",
            ),
            # --- ИОР (операционный риск) -------------------------------------
            # Иконка: «падающая» линия тренда с точками данных.
            # Ось L + ломаная, уходящая вниз-вправо (отражает суть —
            # отслеживание инцидентов операционного риска в динамике).
            NavItem(
                label="ИОР",
                url="/sqlagent?tool=ior",
                icon_svg=(
                    # оси графика
                    '<path d="M3 3v18h18" '
                    'stroke="currentColor" stroke-width="2" '
                    'stroke-linecap="round" stroke-linejoin="round"/>'
                    # падающий тренд: идёт сверху-слева вниз-вправо
                    '<polyline points="6 7 10 12 13 10 17 16 20 18" '
                    'stroke="currentColor" stroke-width="2" '
                    'stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
                    # точки данных на изломах тренда
                    '<circle cx="6" cy="7" r="1" fill="currentColor"/>'
                    '<circle cx="10" cy="12" r="1" fill="currentColor"/>'
                    '<circle cx="13" cy="10" r="1" fill="currentColor"/>'
                    '<circle cx="17" cy="16" r="1" fill="currentColor"/>'
                    '<circle cx="20" cy="18" r="1" fill="currentColor"/>'
                ),
                order=31,
                active_page="sqlagent-ior",
                group="АГЕНТЫ",
                chat_domains=["sqlagent_ior"],
                description="Поиск информации об инцидентах операционного риска",
            ),
            # --- CRM ---------------------------------------------------------
            # Иконка: тучка-диалог (speech bubble в форме облака) — символ
            # общения / обращений клиентов. Два облака, одно больше,
            # второе поменьше — как в классических мессенджерах.
            NavItem(
                label="CRM",
                url="/sqlagent?tool=crm",
                icon_svg=(
                    # большое облако-диалог (со скруглённым «носиком» внизу)
                    '<path d="M21 11.5a3.5 3.5 0 00-3.5-3.5h-.71A6 6 0 005 9.5a4.5 '
                    '4.5 0 00.79 8.93h11.71A3.5 3.5 0 0021 14.93a3.49 3.49 0 '
                    '00-.74-2.13A3.5 3.5 0 0021 11.5z" '
                    'stroke="currentColor" stroke-width="2" '
                    'stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
                    # носик-указатель у большого облака
                    '<path d="M8 18.5l-1.5 2.5 3.5-1" '
                    'stroke="currentColor" stroke-width="2" '
                    'stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
                ),
                order=32,
                active_page="sqlagent-crm",
                group="АГЕНТЫ",
                chat_domains=["sqlagent_crm"],
                description="Поиск информации из обращений клиентов",
            ),
            # --- Документы ---------------------------------------------------
            # Иконка: пара листов с наложением (классика «документы»).
            # Задний лист со скруглёнными углами, передний — со строкой
            # текста и слегка сдвинут, чтобы оба были видны.
            NavItem(
                label="Документы",
                url="/sqlagent?tool=docs",
                icon_svg=(
                    # задний документ
                    '<rect x="3" y="5" width="13" height="15" rx="1.5" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    # передний документ (со сдвигом, чтобы был виден задний)
                    '<rect x="8" y="3" width="13" height="15" rx="1.5" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    # три строки текста на переднем документе
                    '<line x1="11" y1="9" x2="18" y2="9" '
                    'stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
                    '<line x1="11" y1="12.5" x2="18" y2="12.5" '
                    'stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
                    '<line x1="11" y1="16" x2="15" y2="16" '
                    'stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
                ),
                order=33,
                active_page="sqlagent-docs",
                group="АГЕНТЫ",
                chat_domains=["sqlagent_docs"],
                description="Поиск документов в SberDocs и Консультант+",
            ),
            # --- Источники данных --------------------------------------------
            # Иконка: один крупный бочонок СУБД (цилиндр) с зачёркнутыми
            # горизонтальными линиями — символ хранилища данных. Акцент
            # именно на одном бочонке (вместо трёх связанных).
            NavItem(
                label="Источники данных",
                url="/sqlagent?tool=sources",
                icon_svg=(
                    # верхний эллипс бочонка
                    '<ellipse cx="12" cy="5" rx="8" ry="3" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    # боковые стороны
                    '<path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    # промежуточные горизонтальные «крышки» для объёма
                    '<path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                ),
                order=34,
                active_page="sqlagent-sources",
                group="АГЕНТЫ",
                chat_domains=["sqlagent_sources"],
                description="Поиск по источникам данных",
            ),
            # --- BackLog команд (исторически JIRA|BB|Confluence) ----------
            # Иконка: группа человечков (3 фигурки рядом). Символ команды.
            NavItem(
                label="BackLog команд",
                url="/sqlagent?tool=jira",
                icon_svg=(
                    # левая фигурка (голова + плечи)
                    '<circle cx="7" cy="8" r="2" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<path d="M3 19v-1a4 4 0 014-4h0a4 4 0 014 4v1" '
                    'stroke="currentColor" stroke-width="2" '
                    'stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
                    # правая фигурка (голова + плечи)
                    '<circle cx="17" cy="8" r="2" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<path d="M13 19v-1a4 4 0 014-4h0a4 4 0 014 4v1" '
                    'stroke="currentColor" stroke-width="2" '
                    'stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
                    # центральная фигурка (основная, чуть крупнее)
                    '<circle cx="12" cy="6" r="2.2" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<path d="M8 19v-1.5a4 4 0 014-4h0a4 4 0 014 4V19" '
                    'stroke="currentColor" stroke-width="2" '
                    'stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
                ),
                order=35,
                active_page="sqlagent-jira",
                group="АГЕНТЫ",
                chat_domains=["sqlagent_jira"],
                description="Информация о процессе разработки проверяемых команд",
            ),
            # --- Follow UP ---------------------------------------------------
            # Иконка: глаз (символ повторной проверки / инспекции). Миндале-
            # видный контур + круглый зрачок. Стилистически вписывается в
            # общую линейку иконок (stroke, no fill).
            NavItem(
                label="Follow UP",
                url="/sqlagent?tool=followup",
                icon_svg=(
                    # контур глаза
                    '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" '
                    'stroke="currentColor" stroke-width="2" '
                    'stroke-linejoin="round" fill="none"/>'
                    # зрачок
                    '<circle cx="12" cy="12" r="3" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                ),
                order=36,
                active_page="sqlagent-followup",
                group="АГЕНТЫ",
                chat_domains=["sqlagent_followup"],
                description="Данные о прошедших проверках и перспективах повторной проверки",
            ),
        ],
    )
