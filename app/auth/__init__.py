"""Модуль авторизации: OTP, JWT-токены, профиль пользователя.

Не домен, а shared-инфраструктура: API-роутер подключается через
app/api/v1/routes.py (/api/v1/auth/*), HTML-страницы входа — через
portal_router в create_app, lifespan-hooks — register_lifespan_hooks().
"""
