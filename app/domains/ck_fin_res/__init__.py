"""Домен ЦК Фин.Рез."""

DOMAIN_NAME = "ck_fin_res"


def _build_domain():
    """Ленивое построение DomainDescriptor."""
    from app.core.domain import DomainDescriptor, NavItem
    from app.domains.ck_fin_res.api import get_api_routers
    from app.domains.ck_fin_res.integrations.chat_tools import get_chat_tools
    from app.domains.ck_fin_res.routes import get_html_routers
    from app.domains.ck_fin_res.settings import CkFinResSettings

    return DomainDescriptor(
        name=DOMAIN_NAME,
        api_routers=get_api_routers(),
        html_routers=get_html_routers(),
        settings_class=CkFinResSettings,
        # public_api=True: реестр не вешает require_domain_access на роутеры
        # (иначе HTML всегда отдаёт 403 для не-членов домена). Свою проверку
        # делает ck_fin_res/routes/portal.py — при отсутствии роли рисует
        # дружелюбную страницу «нет доступа» вместо стандартной 403-ошибки.
        public_api=True,
        dependencies={
            "admin": "роли и доступ к домену для проверки прав на верификацию метрик",
            "ua_data": "справочник подразделений (IDictionaryRepository) для связки записей с act_sub_number_id",
        },
        chat_tools=get_chat_tools(),
        nav_items=[
            NavItem(
                label="ЦК Фин. результат",
                url="/ck-fin-res",
                icon_svg=(
                    '<path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 '
                    '002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 '
                    '2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 '
                    '012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" '
                    'stroke="currentColor" stroke-width="2" '
                    'stroke-linecap="round" stroke-linejoin="round"/>'
                ),
                order=20,
                active_page="ck_fin_res",
                chat_domains=[DOMAIN_NAME, "acts"],
                group="ЦЕНТРЫ КОМПЕТЕНЦИЙ",
                description="Центр компетенций по верификации метрик финансовых результатов",
            ),
        ],
        chat_system_prompt=(
            "ЦК Финансовых Результатов — это страница верификации метрик "
            "финансовых результатов. Метрики хранятся в реестре с кодами "
            "формата ФР00001."
        ),
    )
