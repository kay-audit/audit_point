"""Домен SQL-агента и блока «Аналитика» в sidebar.

Регистрирует:
- портал-страницу /sqlagent (iframe на отдельный процесс SQLAgent
  или заглушка для placeholder-инструмента);
- набор пунктов навигации в сайдбаре:
  * блок «Аналитика»: SQL-агент, ИОР, CRM, Документы,
    Источники данных, JIRA|BB|Confluence, Follow UP;
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
            # Главный пункт. Иконка — классический цилиндр БД в стиле outline
            # (stroke=currentColor, width=2, round caps/joins) — как и остальные
            # иконки в sidebar. Размер viewBox 0 0 24 24, чтобы вписаться в
            # 20x20 svg-контейнер.
            NavItem(
                label="SQL-агент",
                url="/sqlagent",
                icon_svg=(
                    '<path d="M4 7c0-1.66 3.58-3 8-3s8 1.34 8 3-3.58 3-8 '
                    '3-8-1.34-8-3zm0 0v5c0 1.66 3.58 3 8 3s8-1.34 8-3V7M4 '
                    '12v5c0 1.66 3.58 3 8 3s8-1.34 8-3v-5" '
                    'stroke="currentColor" stroke-width="2" '
                    'stroke-linecap="round" stroke-linejoin="round"/>'
                ),
                order=30,
                active_page="sqlagent",
                group="Аналитика",
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
                group="Аналитика",
                chat_domains=[DOMAIN_NAME],
                description="Поиск информации об инцидентах операционного риска",
            ),
            # --- CRM ---------------------------------------------------------
            # Иконка: голова оператора + наушники с микрофоном-«гусиная шея».
            # Окружность-голова + дуга-оголовье + два прямоугольника-амбушюры
            # + микрофон-«гусиная шея» справа.
            NavItem(
                label="CRM",
                url="/sqlagent?tool=crm",
                icon_svg=(
                    # голова оператора
                    '<circle cx="12" cy="12" r="3" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    # оголовье (полудуга над головой)
                    '<path d="M6 12a6 6 0 0112 0" '
                    'stroke="currentColor" stroke-width="2" '
                    'stroke-linecap="round" fill="none"/>'
                    # левый амбушюр
                    '<rect x="3" y="10" width="3" height="6" rx="1" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    # правый амбушюр
                    '<rect x="18" y="10" width="3" height="6" rx="1" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    # микрофон-«гусиная шея» от правого амбушюра
                    '<path d="M19 16v1.5a1.5 1.5 0 01-1.5 1.5h-1.5" '
                    'stroke="currentColor" stroke-width="2" '
                    'stroke-linecap="round" fill="none"/>'
                ),
                order=32,
                active_page="sqlagent-crm",
                group="Аналитика",
                chat_domains=[DOMAIN_NAME],
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
                group="Аналитика",
                chat_domains=[DOMAIN_NAME],
                description="Поиск документов в SberDocs и Консультант+",
            ),
            # --- Источники данных --------------------------------------------
            # Иконка: три БД-цилиндра, связанных линиями в треугольник —
            # символ сети источников / data lake. Каждый цилиндр упрощён до
            # 3 элементов (ellipse + 2 path) для лучшей читаемости.
            NavItem(
                label="Источники данных",
                url="/sqlagent?tool=sources",
                icon_svg=(
                    # верхний-левый цилиндр
                    '<ellipse cx="6" cy="5" rx="3" ry="1.5" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<path d="M3 5v6M9 5v6" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<path d="M3 11c0 .83 1.34 1.5 3 1.5s3-.67 3-1.5" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    # верхний-правый цилиндр
                    '<ellipse cx="18" cy="5" rx="3" ry="1.5" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<path d="M15 5v6M21 5v6" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<path d="M15 11c0 .83 1.34 1.5 3 1.5s3-.67 3-1.5" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    # нижний цилиндр
                    '<ellipse cx="12" cy="19" rx="3" ry="1.5" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<path d="M9 19v2M15 19v2" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<path d="M9 21c0 .83 1.34 1.5 3 1.5s3-.67 3-1.5" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    # соединительные линии (треугольник)
                    '<line x1="9" y1="5" x2="15" y2="5" '
                    'stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
                    '<line x1="6" y1="13" x2="10.5" y2="17" '
                    'stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
                    '<line x1="18" y1="13" x2="13.5" y2="17" '
                    'stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
                ),
                order=34,
                active_page="sqlagent-sources",
                group="Аналитика",
                chat_domains=[DOMAIN_NAME],
                description="Поиск по источникам данных",
            ),
            # --- JIRA|BB|Confluence ------------------------------------------
            # Иконка: канбан-доска (3 колонки разной высоты) — типичный
            # символ JIRA / трекера задач.
            NavItem(
                label="JIRA|BB|Confluence",
                url="/sqlagent?tool=jira",
                icon_svg=(
                    # 3 колонки разной высоты
                    '<rect x="3" y="4" width="5" height="16" rx="1" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<rect x="9.5" y="4" width="5" height="12" rx="1" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<rect x="16" y="4" width="5" height="9" rx="1" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                ),
                order=35,
                active_page="sqlagent-jira",
                group="Аналитика",
                chat_domains=[DOMAIN_NAME],
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
                group="Аналитика",
                chat_domains=[DOMAIN_NAME],
                description="Данные о прошедших проверках и перспективах повторной проверки",
            ),
        ],
    )
