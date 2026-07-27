"""Домен ЦК Code Mining.

Регистрирует NavItem «ЦК Code Mining» в группе «ЦЕНТРЫ КОМПЕТЕНЦИЙ»
и страницу-заглушку /ck-code-mining с описанием работы центра.

В текущей итерации домен не имеет собственных API/репозиториев/
сервисов — только информационная карточка. Полноценная логика
(дашборды, инструменты, инструкции, кейсы) будет добавлена позднее.
"""

DOMAIN_NAME = "ck_code_mining"


def _build_domain():
    """Ленивое построение DomainDescriptor."""
    from app.core.domain import DomainDescriptor, NavItem
    from app.domains.ck_code_mining.routes import get_html_routers
    from app.domains.ck_code_mining.settings import CkCodeMiningSettings

    return DomainDescriptor(
        name=DOMAIN_NAME,
        html_routers=get_html_routers(),
        settings_class=CkCodeMiningSettings,
        # public_api=True: реестр не вешает require_domain_access на роутеры —
        # иначе HTML всегда отдаёт 403 для не-членов домена. Своя проверка в
        # routes/portal.py при отсутствии роли рисует «нет доступа».
        public_api=True,
        dependencies={
            "admin": "роли и доступ к домену",
        },
        nav_items=[
            NavItem(
                label="ЦК Code Mining",
                url="/ck-code-mining",
                icon_svg=(
                    # иконка «</>» — символ исходного кода
                    '<path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 '
                    '00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" '
                    'stroke="currentColor" stroke-width="2" '
                    'stroke-linecap="round" stroke-linejoin="round"/>'
                ),
                order=31,
                active_page="ck_code_mining",
                chat_domains=[DOMAIN_NAME, "acts"],
                group="ЦЕНТРЫ КОМПЕТЕНЦИЙ",
                description=(
                    "Центр компетенций по анализу исходного кода "
                    "проверяемых систем (code mining)"
                ),
            ),
        ],
        chat_system_prompt=(
            "ЦК Code Mining — центр компетенций по анализу исходного кода. "
            "Содержит ссылки на инструменты, инструкции, дэшборды и результаты "
            "анализа кейсов группой экспертов."
        ),
    )
