"""Домен SQL-агента (Text-to-SQL).

Регистрирует портал-страницу со встроенным через iframe родным UI SQLAgent,
который работает отдельным uvicorn-процессом, и набор пунктов навигации
в сайдбаре (блок «Аналитика»).
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
            # Иконка: голова оператора с наушниками (headset).
            # Окружность-голова + дуга-оголовье + два прямоугольника-амбушюры
            # + микрофон-«гусиная шея» справа.
            NavItem(
                label="CRM",
                url="/sqlagent?tool=crm",
                icon_svg=(
                    # голова оператора
                    '<circle cx="12" cy="10" r="3.5" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    # оголовье (полудуга над головой)
                    '<path d="M6.5 10a5.5 5.5 0 0111 0" '
                    'stroke="currentColor" stroke-width="2" '
                    'stroke-linecap="round" fill="none"/>'
                    # левый амбушюр
                    '<rect x="3" y="9" width="3" height="6" rx="1" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    # правый амбушюр
                    '<rect x="18" y="9" width="3" height="6" rx="1" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    # микрофон-«гусиная шея» от правого амбушюра
                    '<path d="M19 15v2.5a2 2 0 01-2 2h-1.5" '
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
            # Иконка: три связанных цилиндра БД (классический data-lake /
            # data-source граф). Сверху два цилиндра, снизу третий, между
            # ними соединительные линии — образуют «сеть» источников.
            NavItem(
                label="Источники данных",
                url="/sqlagent?tool=sources",
                icon_svg=(
                    # верхний-левый цилиндр
                    '<ellipse cx="6" cy="5" rx="3" ry="1.4" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<path d="M3 5v6c0 .77 1.34 1.4 3 1.4s3-.63 3-1.4V5" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    # верхний-правый цилиндр
                    '<ellipse cx="18" cy="5" rx="3" ry="1.4" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<path d="M15 5v6c0 .77 1.34 1.4 3 1.4s3-.63 3-1.4V5" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    # нижний цилиндр
                    '<ellipse cx="12" cy="19" rx="3" ry="1.4" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<path d="M9 19v2c0 .77 1.34 1.4 3 1.4s3-.63 3-1.4v-2" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    # соединительные линии
                    '<line x1="9" y1="5" x2="15" y2="5" '
                    'stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
                    '<line x1="6" y1="13" x2="10.5" y2="17.5" '
                    'stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
                    '<line x1="18" y1="13" x2="13.5" y2="17.5" '
                    'stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
                ),
                order=34,
                active_page="sqlagent-sources",
                group="Аналитика",
                chat_domains=[DOMAIN_NAME],
                description="Поиск по источникам данных",
            ),
        ],
    )
