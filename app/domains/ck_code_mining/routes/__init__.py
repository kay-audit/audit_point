"""Роутеры домена ЦК Code Mining."""

from app.domains.ck_code_mining.routes.portal import router as portal_router


def get_html_routers():
    """Возвращает список HTML роутеров домена."""
    return [portal_router]
