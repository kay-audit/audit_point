"""
Точка входа FastAPI приложения.

Этот модуль создает и конфигурирует основное приложение FastAPI,
подключает маршруты API и HTML-роуты, статические файлы,
настраивает middleware и обработчики ошибок.
Домены обнаруживаются автоматически из app/domains/.
"""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.auth.middleware import AuthMiddleware
from app.api.v1.routes import api_router as api_v1_router
from app.core.config import get_settings, setup_logging
from app.core.domain_registry import (
    discover_domains,
    get_shutdown_hooks,
    get_startup_hooks,
    register_domains,
)
from app.core.middleware import (
    HTTPSRedirectMiddleware,
    RateLimitMiddleware,
    RequestIdMiddleware,
    RequestSizeLimitMiddleware,
    SecurityHeadersMiddleware,
)
from app.core.middlewares.http_metrics import HttpMetricsMiddleware
import asyncpg
from asyncpg import CheckViolationError, UniqueViolationError

from app.core.exceptions import AppError, CHECK_CONSTRAINT_MESSAGES
from app.db.connection import (
    init_db,
    close_db,
    create_tables_if_not_exist,
    warmup_pool,
    get_pool, 
    KerberosTokenExpiredError
)
from app.routes.errors import router as error_router
from app.routes.portal import router as portal_router

# Инициализируем настройки и логирование один раз на уровне модуля
settings = get_settings()
logger = setup_logging(settings.server.log_level)

# Директория доменов
_domains_dir = Path(__file__).resolve().parent / "domains"


def _is_html_request(request: Request) -> bool:
    """Проверяет, является ли запрос HTML (не API)."""
    path = request.scope.get("path", request.url.path)
    return not path.startswith("/api/")


def _render_error_page(request: Request, code: int, reason: str | None = None):
    """Рендерит HTML-страницу ошибки."""
    from app.core.templating import get_templates
    _templates = get_templates()
    template_map = {
        400: "shared/errors/400.html",
        401: "shared/errors/401.html",
        403: "shared/errors/403.html",
        404: "shared/errors/404.html",
        500: "shared/errors/500.html",
        503: "shared/errors/503.html",
    }
    template_name = template_map.get(code, template_map[500])
    return _templates.TemplateResponse(
        request,
        template_name,
        {"reason": reason},
        status_code=code,
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Управление жизненным циклом приложения.
    """
    # Startup
    logger.info("Запуск приложения Audit Workstation")
    settings.ensure_directories()

    # discover_domains() вызывается повторно (первый раз — в create_app для роутеров).
    # Результат кэшируется в _domains, здесь нужен для lifecycle и БД.
    domains = discover_domains(_domains_dir)
    logger.info(
        "Зарегистрировано доменов: %d (%s)",
        len(domains),
        ", ".join(d.name for d in domains),
    )

    # Список успешно стартовавших доменов — используется и в startup-откате, и в shutdown
    started: list = []

    async def _close_pool_on_failed_startup() -> None:
        """Закрывает пул при провале старта после успешного init_db.

        Иначе открытый пул утечёт: процесс при провале lifespan-startup не
        дойдёт до shutdown-секции, а на GP это N висящих сессий до рестарта.
        ``close_db`` идемпотентен (no-op, если пул не открыт).
        """
        try:
            await close_db()
        except Exception:
            logger.exception("Не удалось закрыть пул при провале старта")

    # ИНИЦИАЛИЗАЦИЯ БД
    try:
        await init_db(settings)
        logger.debug("База данных инициализирована")

        # ПРОГРЕВ ПУЛА — устраняет TCP-handshake-задержку первых запросов
        if settings.database.pool_warmup_enabled:
            await warmup_pool(get_pool(), settings.database.pool_min_size)

        # СОЗДАНИЕ ТАБЛИЦ ЕСЛИ НЕ СУЩЕСТВУЮТ
        await create_tables_if_not_exist(domains)
        logger.debug("Схема базы данных проверена")

        # SINGLETON-БЛОКИРОВКА ИНСТАНСА ПРИЛОЖЕНИЯ
        # В закрытой сети без Redis multi-worker деплой повредил бы
        # process-level состояние (например, in-process батчеры/поллеры).
        # Lock в БД гарантирует ровно одного активного воркера.
        from app.core.singleton_lock import (
            acquire_singleton_lock,
            SingletonLockBusyError,
        )
        from app.db.connection import get_adapter, get_db
        adapter = get_adapter()
        singleton_table = adapter.get_table_name("app_singleton_lock")
        try:
            async with get_db() as conn:
                await acquire_singleton_lock(
                    conn,
                    singleton_table,
                    stale_ttl_sec=settings.security.singleton_lock_stale_ttl_sec,
                )
        except SingletonLockBusyError as exc:
            logger.critical("Не удалось захватить singleton-lock: %s", exc)
            raise RuntimeError(str(exc)) from exc

        # Lifespan-hooks доменов: каждый домен в своём _build_domain()
        # регистрирует свои startup/shutdown через app.core.domain_registry.
        # На этом этапе уже инициализированы БД, settings_registry, доменные
        # Settings — но ещё НЕ захвачен singleton-lock. Hooks вызываются
        # в порядке регистрации, ошибка hook'а откатывает уже стартовавшие.
        started_startup_hooks: list[tuple[str, object]] = []
        try:
            for hook_name, hook in get_startup_hooks():
                await hook(app)
                started_startup_hooks.append((hook_name, hook))
        except Exception:
            logger.exception(
                "Ошибка в startup-hook, откат уже выполненных hooks",
            )
            for name, _ in reversed(started_startup_hooks):
                # Подбираем парный shutdown-hook по имени и вызываем его.
                for sd_name, sd_hook in reversed(get_shutdown_hooks()):
                    if sd_name == name:
                        try:
                            await sd_hook(app)
                        except Exception:
                            logger.exception(
                                "Ошибка отката shutdown-hook %s", sd_name,
                            )
                        break
            raise

        # Запуск доменов с откатом при частичной ошибке:
        # если on_startup домена N падает, вызываем on_shutdown для 1..N-1
        try:
            for d in domains:
                if d.on_startup:
                    await d.on_startup(app)
                started.append(d)
        except Exception:
            logger.exception(
                "Ошибка при запуске домена, откат инициализированных доменов"
            )
            for d in reversed(started):
                if d.on_shutdown:
                    try:
                        await d.on_shutdown(app)
                    except Exception:
                        logger.exception(f"Ошибка при откате домена {d.name}")
            raise

        logger.info("Application startup complete")

    except KerberosTokenExpiredError as e:
        logger.critical(
            "\n" + "=" * 80 + "\n"
                              "КРИТИЧЕСКАЯ ОШИБКА: Не удалось запустить приложение\n"
                              "=" * 80 + "\n"
                                         "Причина: Kerberos токен авторизации протух\n\n"
                                         "Решение:\n"
                                         "1. Откройте терминал JupyterHub\n"
                                         "2. Выполните команду: kinit\n"
                                         "3. Введите ваш пароль\n"
                                         "4. Перезапустите приложение\n"
                                         "=" * 80
        )
        await _close_pool_on_failed_startup()
        raise RuntimeError(
            "Приложение не может запуститься без валидного Kerberos токена. "
            "Выполните 'kinit' в терминале."
        ) from e
    except asyncpg.PostgresError as e:
        logger.critical(f"Ошибка PostgreSQL при запуске приложения: {e}")
        await _close_pool_on_failed_startup()
        raise RuntimeError(f"Не удалось инициализировать БД при старте: {e}") from e
    except Exception as e:
        logger.critical(f"Критическая ошибка при запуске приложения: {e}")
        await _close_pool_on_failed_startup()
        raise

    yield

    # Shutdown
    logger.info("Завершение работы приложения Audit Workstation")

    # Завершение доменов в обратном порядке (только успешно стартовавшие)
    for d in reversed(started):
        if d.on_shutdown:
            try:
                await d.on_shutdown(app)
            except Exception:
                logger.exception(f"Ошибка при завершении домена {d.name}")

    # Lifespan shutdown-hooks доменов — вызываются в обратном порядке
    # регистрации. Каждый домен останавливает свои батчеры и сбрасывает
    # ссылки в собственных deps.
    for hook_name, hook in reversed(get_shutdown_hooks()):
        try:
            await hook(app)
        except Exception:
            logger.exception("Ошибка в shutdown-hook %s", hook_name)

    # Освобождаем singleton-блокировку (best-effort, до закрытия пула).
    try:
        from app.core.singleton_lock import release_singleton_lock
        from app.db.connection import get_adapter, get_db
        adapter = get_adapter()
        singleton_table = adapter.get_table_name("app_singleton_lock")
        async with get_db() as conn:
            await release_singleton_lock(conn, singleton_table)
    except Exception:
        logger.exception(
            "Не удалось освободить singleton-lock (не блокирует shutdown)",
        )

    # Закрываем пул БД
    await close_db()
    logger.info("Database pool закрыт")


def create_app() -> FastAPI:
    """
    Создает и конфигурирует экземпляр FastAPI приложения.

    Returns:
        Полностью сконфигурированное приложение
    """
    # Создание FastAPI приложения с базовыми настройками
    app = FastAPI(
        title=settings.app_title,
        version=settings.app_version,
        description="Рабочая станция аудитора — акты, AI-ассистент, аналитика, интеграции",
        lifespan=lifespan,
    )

    # Обнаружение доменов выполняем до настройки middleware: discover_domains()
    # регистрирует доменные настройки в settings_registry, без чего HttpMetricsMiddleware
    # (использующий AdminSettings) не может инициализироваться. Результат кэшируется,
    # повторный вызов в register_domains ниже отдаёт тот же список.
    domains = discover_domains(_domains_dir)

    # Модуль auth — не домен: hooks регистрируются напрямую (идемпотентно),
    # API-роутер живёт в api_v1_router, HTML-страницы входа подключаются ниже.
    from app.auth.lifecycle import register_lifespan_hooks
    register_lifespan_hooks()

    # Порядок middleware: add_middleware вставляет запись в начало списка,
    # а стек собирается обходом этого списка в обратном порядке — поэтому
    # ПОСЛЕДНИЙ add_middleware оказывается самым внешним (видит request первым
    # и response последним). Добавляем от внутреннего к внешнему; итоговая
    # «луковица» снаружи внутрь:
    #   HTTPSRedirect → RequestId → SecurityHeaders → RequestSizeLimit
    #   → RateLimit → HttpMetrics → Auth → роутер.

    # 1. Auth — самый внутренний: его 401 и редиректы поднимаются через весь
    #    стек, получая и security-заголовки, и request_id, и запись в метрики.
    app.add_middleware(AuthMiddleware)

    # 2. HTTP-метрики — снаружи Auth (видят 401 анонимов) и внутри лимитов:
    #    отбитые 429/413 в БД не пишутся, чтобы флуд не разгонял журнал.
    # Сервис разрешается через реестр фабрик admin-домена (admin сам инкапсулирует
    # проверку http_metrics_enabled и возвращает None, если метрики выключены) —
    # core не импортирует admin напрямую. Фабрика зарегистрирована при discover_domains
    # выше; если admin-домена нет — метрики отключены (service=None).
    _http_metrics_service = None
    try:
        from app.core.domain_registry import get_factory, has_factory
        if has_factory("admin.http_metrics_service"):
            _http_metrics_service = get_factory("admin.http_metrics_service")()
    except Exception:
        logger.exception(
            "Не удалось инициализировать HttpMetricsService — метрики отключены",
        )
    app.add_middleware(HttpMetricsMiddleware, service=_http_metrics_service)

    # 3. Rate limiting
    app.add_middleware(
        RateLimitMiddleware,
        rate_limit=settings.security.rate_limit_per_minute,
        settings=settings
    )

    # 4. Request size limit
    app.add_middleware(
        RequestSizeLimitMiddleware,
        max_size=settings.security.max_request_size
    )

    # 5. Security headers — снаружи лимитов и Auth, чтобы CSP/HSTS/X-Frame
    #    выставлялись и на коротких 429/413/401-ответах.
    app.add_middleware(SecurityHeadersMiddleware, settings=settings)

    # 6. Request ID — почти самый внешний: X-Request-ID получают все ответы,
    #    включая отбитые лимитами и неавторизованные.
    app.add_middleware(RequestIdMiddleware)

    # 7. HTTPS redirect — самый внешний: правит scope.scheme до SecurityHeaders,
    #    иначе за прокси HSTS не выставится (схема осталась бы http).
    app.add_middleware(HTTPSRedirectMiddleware)

    # Подключение статических файлов (доступны по URL /static/*)
    app.mount(
        "/static",
        StaticFiles(directory=str(settings.static_dir)),
        name="static"
    )

    @app.get("/favicon.ico", include_in_schema=False)
    async def favicon():
        favicon_path = settings.static_dir / "favicon.ico"
        return FileResponse(favicon_path)

    # Корневой /health для внешних поллеров (Docker/k8s/Prometheus/JupyterHub
    # proxy). Под /api/v1/system/health остаётся развёрнутая версия с
    # per-domain health-check'ами. HttpMetricsMiddleware фильтрует /health —
    # лог не пухнет.
    @app.get("/health", include_in_schema=False)
    async def root_health():
        return {"status": "ok"}

    # Обработчик ошибки Kerberos токена
    @app.exception_handler(KerberosTokenExpiredError)
    async def kerberos_token_expired_handler(
            request: Request,
            exc: KerberosTokenExpiredError
    ):
        """Обработчик для протухшего Kerberos токена."""
        logger.warning(
            f"Kerberos токен протух во время запроса: {request.url.path}"
        )

        if _is_html_request(request):
            return _render_error_page(request, 401, reason="kerberos")

        return JSONResponse(
            status_code=401,
            content={
                "error": "kerberos_token_expired",
                "detail": "Токен авторизации Kerberos истек",
                "message": (
                    "Ваш токен авторизации Kerberos истек и требует обновления. "
                    "Для продолжения работы выполните команду 'kinit' в терминале "
                    "JupyterHub и введите ваш пароль. После этого обновите страницу."
                ),
                "instructions": [
                    "Откройте терминал JupyterHub",
                    "Выполните команду: kinit",
                    "Введите ваш пароль",
                    "Обновите страницу приложения"
                ],
                "action_required": "kinit"
            }
        )

    @app.exception_handler(AppError)
    async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
        """Единый обработчик всех доменных исключений."""
        if _is_html_request(request):
            return _render_error_page(request, exc.status_code)
        return JSONResponse(status_code=exc.status_code, content=exc.to_envelope())

    @app.exception_handler(UniqueViolationError)
    async def unique_violation_handler(request: Request, exc: UniqueViolationError) -> JSONResponse:
        """Fallback для неизвестных конфликтов уникальности из БД."""
        logger.warning(f"UniqueViolationError: {exc} (path: {request.url.path})")
        return JSONResponse(
            status_code=409,
            content={
                "detail": "Запись с такими данными уже существует",
                "code": "db-unique-violation",
            },
        )

    @app.exception_handler(CheckViolationError)
    async def check_violation_handler(request: Request, exc: CheckViolationError) -> JSONResponse:
        """Обработчик нарушений CHECK-ограничений БД."""
        exc_str = str(exc)
        logger.warning(f"CheckViolationError: {exc_str} (path: {request.url.path})")

        detail = "Данные не прошли проверку ограничений базы данных"
        for constraint_name, message in CHECK_CONSTRAINT_MESSAGES.items():
            if constraint_name in exc_str:
                detail = message
                break

        return JSONResponse(
            status_code=422,
            content={"detail": detail, "code": "db-check-violation"},
        )

    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException):
        """HTTP-ошибки: HTML-страница для браузера, JSON для API."""
        if _is_html_request(request):
            return _render_error_page(request, exc.status_code)
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail, "code": "http-error"},
        )

    @app.exception_handler(Exception)
    async def generic_exception_handler(request: Request, exc: Exception):
        """Перехват необработанных исключений — detail ТОЛЬКО в логах."""
        logger.exception(f"Необработанное исключение: {request.url.path}")
        if _is_html_request(request):
            return _render_error_page(request, 500)
        return JSONResponse(
            status_code=500,
            content={
                "detail": "Внутренняя ошибка сервера",
                "code": "internal-server-error",
            },
        )

    # Подключение роута ошибок (до portal_router)
    app.include_router(error_router)

    # Подключение shared HTML-роутов (лендинг, CK-заглушки, страницы входа)
    app.include_router(portal_router)
    from app.auth.portal_router import router as auth_portal_router
    app.include_router(auth_portal_router)

    # Подключение shared API роутеров (auth, chat, system)
    app.include_router(
        api_v1_router,
        prefix=settings.server.api_v1_prefix
    )

    # domains обнаружены выше до middleware-секции. Повторный вызов в lifespan()
    # (для БД и lifecycle) использует кэш _domains.
    register_domains(app, domains, settings.server.api_v1_prefix)

    return app


# Создание экземпляра приложения — только если модуль импортируется (не запускается напрямую).
# При запуске через `python -m app.main` uvicorn сам импортирует модуль в дочернем процессе,
# поэтому здесь не нужно создавать приложение — это исключает лишний цикл инициализации.
if __name__ != "__main__":
    app = create_app()

if __name__ == "__main__":
    # Запуск сервера разработки
    import uvicorn


    uvicorn.run(
        # Настройки сервера
        "app.main:app",
        host=settings.server.host,
        port=settings.server.port,
        # Автоматическая перезагрузка при изменении кода
        reload=True,
        # Уровень uvicorn синхронизирован с SERVER__LOG_LEVEL
        log_level=settings.server.log_level.lower(),
    )
