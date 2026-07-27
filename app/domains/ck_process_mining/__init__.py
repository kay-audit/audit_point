"""Домен ЦК Process Mining.

Регистрирует NavItem «ЦК Process Mining» в группе «ЦЕНТРЫ КОМПЕТЕНЦИЙ»
и страницу-заглушку /ck-process-mining с описанием работы центра.

В текущей итерации домен не имеет собственных API/репозиториев/
сервисов — только информационная карточка. Полноценная логика
(дашборды, инструменты, инструкции, кейсы) будет добавлена позднее.
"""

DOMAIN_NAME = "ck_process_mining"


def _build_domain():
    """Ленивое построение DomainDescriptor."""
    from app.core.domain import DomainDescriptor, NavItem
    from app.domains.ck_process_mining.routes import get_html_routers
    from app.domains.ck_process_mining.settings import CkProcessMiningSettings

    return DomainDescriptor(
        name=DOMAIN_NAME,
        html_routers=get_html_routers(),
        settings_class=CkProcessMiningSettings,
        # public_api=True: реестр не вешает require_domain_access на роутеры —
        # иначе HTML всегда отдаёт 403 для не-членов домена. Своя проверка в
        # routes/portal.py при отсутствии роли рисует «нет доступа».
        public_api=True,
        dependencies={
            "admin": "роли и доступ к домену",
        },
        nav_items=[
            NavItem(
                label="ЦК Process Mining",
                url="/ck-process-mining",
                icon_svg=(
                    # иконка «граф процесса» — узлы + рёбра
                    '<circle cx="5" cy="6" r="2" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<circle cx="5" cy="18" r="2" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<circle cx="19" cy="6" r="2" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<circle cx="19" cy="18" r="2" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<circle cx="12" cy="12" r="2.5" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<line x1="6.5" y1="7.5" x2="10" y2="10.5" '
                    'stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
                    '<line x1="6.5" y1="16.5" x2="10" y2="13.5" '
                    'stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
                    '<line x1="17.5" y1="7.5" x2="14" y2="10.5" '
                    'stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
                    '<line x1="17.5" y1="16.5" x2="14" y2="13.5" '
                    'stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
                ),
                order=32,
                active_page="ck_process_mining",
                chat_domains=[DOMAIN_NAME, "acts"],
                group="ЦЕНТРЫ КОМПЕТЕНЦИЙ",
                description=(
                    "Центр компетенций по анализу процессов на основе бизнес-логов"
                ),
            ),
        ],
        chat_system_prompt=(
            "ЦК Process Mining — центр компетенций по процессной аналитике. "
            "Содержит ссылки на инструменты, инструкции, дэшборды и результаты "
            "анализа кейсов группой экспертов."
        ),
    )
