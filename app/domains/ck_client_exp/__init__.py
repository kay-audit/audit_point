"""Домен ЦК Клиентский опыт."""

DOMAIN_NAME = "ck_client_exp"


def _build_domain():
    """Ленивое построение DomainDescriptor."""
    from app.core.domain import DomainDescriptor, NavItem
    from app.domains.ck_client_exp.api import get_api_routers
    from app.domains.ck_client_exp.integrations.chat_tools import get_chat_tools
    from app.domains.ck_client_exp.routes import get_html_routers
    from app.domains.ck_client_exp.settings import CkClientExpSettings

    return DomainDescriptor(
        name=DOMAIN_NAME,
        api_routers=get_api_routers(),
        html_routers=get_html_routers(),
        settings_class=CkClientExpSettings,
        # public_api=True: реестр не вешает require_domain_access на роутеры —
        # иначе HTML всегда отдаёт 403 для не-членов домена. Своя проверка в
        # routes/portal.py при отсутствии роли рисует «нет доступа».
        public_api=True,
        dependencies={
            "admin": "роли и доступ к домену",
            "ua_data": "справочник подразделений для связки",
        },
        chat_tools=get_chat_tools(),
        nav_items=[
            NavItem(
                label="ЦК Клиентский опыт",
                url="/ck-client-experience",
                icon_svg=(
                    '<path d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 '
                    '0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 '
                    '015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 '
                    '0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" '
                    'stroke="currentColor" stroke-width="2" '
                    'stroke-linecap="round" stroke-linejoin="round"/>'
                ),
                order=30,
                active_page="ck_client_experience",
                chat_domains=[DOMAIN_NAME, "acts"],
                group="Центры компетенций",
                description="Центр компетенций по верификации метрик клиентского опыта",
            ),
        ],
        chat_system_prompt=(
            "ЦК Клиентского Опыта — страница верификации метрик "
            "клиентского опыта."
        ),
    )
