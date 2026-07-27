"""Роутеры домена ЦК Process Mining."""

from app.domains.ck_process_mining.routes.portal import router as portal_router


def get_html_routers():
    """Возвращает список HTML роутеров домена."""
    return [portal_router]
