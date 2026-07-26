"""Auth-домен: логин, сессии, профиль пользователя, аватары, сброс паролей."""
from __future__ import annotations

import logging

logger = logging.getLogger("audit_workstation.domains.auth")

DOMAIN_NAME = "auth"


async def _on_startup(app) -> None:
    """Сидинг credentials при первом запуске (если credentials_table пуста)."""
    from app.domains.auth._lifecycle import seed_auth_credentials
    try:
        result = await seed_auth_credentials()
        if not result.get("skipped"):
            logger.info(
                "auth-домен: сидинг credentials выполнен — %s",
                result.get("secrets_path"),
            )
    except Exception:
        logger.exception("auth-домен: ошибка при сидинге credentials")


def _build_domain():
    """Ленивое построение DomainDescriptor (вызывается из domain_registry)."""
    from app.core.domain import DomainDescriptor
    from app.domains.auth.api import get_api_routers
    from app.domains.auth.routes import get_html_routers
    from app.domains.auth.settings import AuthSettings

    return DomainDescriptor(
        name=DOMAIN_NAME,
        api_routers=get_api_routers(),
        html_routers=get_html_routers(),
        settings_class=AuthSettings,
        on_startup=_on_startup,
        migration_substitutions={},
        health_check=None,
        nav_items=[],
        chat_system_prompt=None,
        # public_api: True — эндпоинты /auth/* доступны ВСЕМ авторизованным
        # пользователям (включая тех, у кого нет ролей в любом домене). Иначе
        # registry вешает require_domain_access("auth"), а роли "auth" не
        # существует — все (даже залогиненные) пользователи получат 403.
        public_api=True,
    )


__all__ = ["DOMAIN_NAME", "_build_domain"]
