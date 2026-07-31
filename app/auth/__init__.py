"""Модуль авторизации: OTP, JWT-токены, профиль пользователя."""


AUTH_DOMAIN_NAME = "auth"


def _build_domain():
    """Ленивое построение DomainDescriptor (вызывается из domain_registry)."""
    from app.core.domain import DomainDescriptor
    from app.auth.router import router as api_router
    from app.auth.portal_router import router as portal_router
    from app.auth.lifecycle import register_lifespan_hooks

    # Регистрируем lifecycle hooks
    register_lifespan_hooks()

    return DomainDescriptor(
        name=AUTH_DOMAIN_NAME,
        api_routers=[(api_router, "/auth", ["auth"])],
        html_routers=[portal_router],
        settings_class=None,
        dependencies={},
        on_startup=None,
        on_shutdown=None,
        chat_tools=None,
        public_api=True,  # auth домен доступен всем, без проверки доменного гейта
    )


__all__ = [
    "AUTH_DOMAIN_NAME",
    "_build_domain",
]
