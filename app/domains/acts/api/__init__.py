"""API роутеры домена актов."""

from app.domains.acts.api.limits import router as limits_router
from app.domains.acts.api.editor_telemetry import router as editor_telemetry_router
from app.domains.acts.api.management import router as management_router
from app.domains.acts.api.content import router as content_router
from app.domains.acts.api.images import router as images_router
from app.domains.acts.api.export import router as export_router
from app.domains.acts.api.invoice import router as invoice_router
from app.domains.acts.api.audit_log import router as audit_log_router
from app.domains.acts.api.users import router as users_router


def get_api_routers():
    """Возвращает список API роутеров домена актов."""
    return [
        # limits — строго ПЕРЕД management: литеральный GET /limits иначе
        # затенялся бы маршрутом GET /{act_id} (int-конвертация "limits"
        # даёт 422 без fallthrough к следующему роуту).
        (limits_router, "/acts", ["Лимиты актов"]),
        # editor-telemetry — тоже литеральный путь, регистрируем до management
        # по той же причине (никакой int-конвертации сегмента пути).
        (editor_telemetry_router, "/acts", ["Телеметрия редактора"]),
        (management_router, "/acts", ["Менеджмент актов"]),
        (content_router, "/acts", ["Содержимое актов"]),
        (images_router, "/acts", ["Картинки нарушений"]),
        (export_router, "/acts/export", ["Операции экспорта"]),
        (invoice_router, "/acts/invoice", ["Фактуры актов"]),
        (audit_log_router, "/acts", ["Аудит-лог актов"]),
        (users_router, "/acts", ["Пользователи актов"]),
    ]
