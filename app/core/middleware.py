"""
Middleware для FastAPI приложения.

Все middleware реализованы как raw ASGI — без BaseHTTPMiddleware,
который буферизирует тело ответа и ломает SSE-стриминг.

Содержит middleware классы для:
- Форсирования HTTPS схемы за прокси (HTTPSRedirectMiddleware)
- Ограничения частоты запросов (RateLimitMiddleware)
- Ограничения размера тела запроса (RequestSizeLimitMiddleware)
- Назначения request_id (RequestIdMiddleware)
- Выставления security response headers (SecurityHeadersMiddleware)
"""

import asyncio
import json
import logging
import secrets
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta

from cachetools import TTLCache

from app.core.config import Settings, get_settings, request_id_var

settings = get_settings()
logger = logging.getLogger("audit_workstation.middleware")


class HTTPSRedirectMiddleware:
    """
    Middleware для форсирования HTTPS схемы в запросах.

    Необходим для корректной работы url_for() за прокси JupyterHub,
    который проксирует HTTPS, но отправляет запросы по HTTP.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = dict(scope.get("headers", []))
            if (
                headers.get(b"x-forwarded-proto") == b"https"
                or headers.get(b"x-scheme") == b"https"
            ):
                scope["scheme"] = "https"

        await self.app(scope, receive, send)


# Префиксы путей, не участвующие в подсчёте частоты запросов.
#
# Фронт собран на Native ES Modules без бандлера: страница конструктора тянет
# ~230 отдельных файлов (модули + CSS), портальная — около сотни. Считать их
# наравне с API означает, что бюджет любого разумного лимита съедают несколько
# жёстких перезагрузок (Ctrl+Shift+R), причём 429 прилетает и на сами модули —
# страница собирается с дырами вместо внятной ошибки. Статика отдаётся
# StaticFiles с диска, к БД и LLM не ходит, защищать её лимитом нечего.
RATE_LIMIT_EXEMPT_PREFIXES: tuple[str, ...] = ("/static/",)


class RateLimitMiddleware:
    """
    Middleware для ограничения частоты запросов (rate limiting).

    Используется TTLCache вместо defaultdict для автоматической очистки
    старых записей. Thread-safe и без memory leak.

    Ключ — пользователь, если запрос удалось опознать (``identify``), иначе
    IP TCP-пира. Ключ по пользователю корректен независимо от сетевой
    топологии: прокси, NAT и общий выход в интернет больше не схлопывают всех
    в один счётчик, а сменой IP лимит не обходится. Аноним считается по IP —
    иначе поток на ``/auth/*`` до входа остался бы вообще без ограничения.

    Заголовки прокси (``X-Forwarded-For``) сознательно НЕ читаются: без списка
    доверенных прокси это дало бы любому клиенту подделать ключ лимита одной
    строкой. На SDP приложение открыто по IP:порту напрямую — см. §9
    deploy-and-configuration.md.
    """

    def __init__(
        self,
        app,
        rate_limit: int,
        settings: Settings,
        exempt_prefixes: tuple[str, ...] = RATE_LIMIT_EXEMPT_PREFIXES,
        identify: Callable[[dict], str | None] | None = None,
    ):
        self.app = app
        self.rate_limit = rate_limit
        self.exempt_prefixes = exempt_prefixes
        # Резолвер личности внедряется снаружи (из app/main.py), а не
        # импортируется здесь: core не должен знать про app.auth, а тесты
        # получают возможность подменить опознание одной функцией.
        self.identify = identify

        # TTLCache автоматически удаляет старые записи.
        self.requests = TTLCache(
            maxsize=settings.security.max_tracked_ips,
            ttl=settings.security.rate_limit_ttl
        )

        # asyncio.Lock — корректный примитив для async-кода.
        self.lock = asyncio.Lock()

        logger.info(
            f"Rate limiting инициализирован: {rate_limit} запросов/минуту, "
            f"max_ips={settings.security.max_tracked_ips}, "
            f"ttl={settings.security.rate_limit_ttl}s, "
            f"exempt={list(self.exempt_prefixes)}"
        )

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if path.startswith(self.exempt_prefixes):
            await self.app(scope, receive, send)
            return

        client_key = self._client_key(scope)
        now = datetime.now()
        cutoff_time = now - timedelta(minutes=1)

        async with self.lock:
            if client_key not in self.requests:
                self.requests[client_key] = []

            client_requests = self.requests[client_key]

            # Скользящее окно: отбрасываем метки старше 60 секунд
            recent_requests = [ts for ts in client_requests if ts > cutoff_time]

            if len(recent_requests) >= self.rate_limit:
                logger.warning(f"Rate limit превышен для клиента: {client_key}")
                body = json.dumps({
                    "detail": "Слишком много запросов. Попробуйте позже.",
                    "retry_after": 60,
                }).encode("utf-8")
                await send({
                    "type": "http.response.start",
                    "status": 429,
                    "headers": [
                        [b"content-type", b"application/json"],
                        [b"content-length", str(len(body)).encode()],
                    ],
                })
                await send({
                    "type": "http.response.body",
                    "body": body,
                })
                return

            recent_requests.append(now)
            self.requests[client_key] = recent_requests

        await self.app(scope, receive, send)

    def _client_key(self, scope) -> str:
        """Ключ счётчика: опознанный пользователь, иначе IP.

        Префиксы ``u:``/``ip:`` обязательны — без них username, совпавший с
        текстом адреса, разделил бы счётчик с этим адресом.
        """
        if self.identify is not None:
            try:
                username = self.identify(scope)
            except Exception:
                # Сбой опознания не должен ронять запрос: молча откатываемся
                # на IP, лимит продолжает работать.
                logger.warning("Не удалось опознать клиента для rate limit", exc_info=True)
                username = None
            if username:
                return f"u:{username}"

        client = scope.get("client")
        return f"ip:{client[0]}" if client else "ip:unknown"


# Используется raw ASGI middleware вместо BaseHTTPMiddleware, т.к. BaseHTTPMiddleware
# буферизует тело запроса целиком до вызова dispatch(), что делает невозможным
# потоковый контроль размера при chunked transfer encoding (без Content-Length).
class RequestSizeLimitMiddleware:
    """
    Middleware для ограничения размера тела запроса.

    Предотвращает исчерпание памяти при отправке огромных JSON.
    Raw ASGI middleware для поддержки chunked transfer encoding.
    """

    def __init__(self, app, max_size: int):
        self.app = app
        self.max_size = max_size
        logger.info(f"Request size limit установлен: {max_size / (1024 * 1024):.1f}MB")

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # Fast path: проверка Content-Length до чтения тела
        headers = dict(scope.get("headers", []))
        content_length_raw = headers.get(b"content-length")
        if content_length_raw:
            try:
                content_length = int(content_length_raw)
            except (ValueError, TypeError):
                content_length = 0
            if content_length > self.max_size:
                client_host = self._get_client_host(scope)
                logger.warning(
                    f"Отклонен запрос с размером {content_length / (1024 * 1024):.1f}MB "
                    f"от {client_host}"
                )
                await self._send_413(send)
                return

        # Streaming path: оборачиваем receive для контроля размера по чанкам
        received_size = 0
        rejected = False

        async def receive_wrapper():
            nonlocal received_size, rejected
            message = await receive()
            if message["type"] == "http.request" and not rejected:
                received_size += len(message.get("body", b""))
                if received_size > self.max_size:
                    rejected = True
                    client_host = self._get_client_host(scope)
                    logger.warning(
                        f"Отклонен chunked запрос с размером >{received_size / (1024 * 1024):.1f}MB "
                        f"от {client_host}"
                    )
                    await self._send_413(send)
                    return {"type": "http.disconnect"}
            return message

        # Блокируем send после отправки 413, чтобы app не отправил повторный ответ
        async def send_wrapper(message):
            if not rejected:
                await send(message)

        await self.app(scope, receive_wrapper, send_wrapper)

    def _get_client_host(self, scope) -> str:
        client = scope.get("client")
        return client[0] if client else "unknown"

    async def _send_413(self, send):
        body = json.dumps(
            {"detail": f"Размер запроса превышает лимит ({self.max_size / (1024 * 1024):.1f}MB)"}
        ).encode("utf-8")
        await send({
            "type": "http.response.start",
            "status": 413,
            "headers": [
                [b"content-type", b"application/json"],
                [b"content-length", str(len(body)).encode()],
            ],
        })
        await send({
            "type": "http.response.body",
            "body": body,
        })


class SecurityHeadersMiddleware:
    """
    Выставляет security response headers на каждый HTTP-ответ.

    Управляется settings.security.*:
    - CSP (Content-Security-Policy) — пока в report-only по умолчанию;
    - HSTS (Strict-Transport-Security) — только для HTTPS-ответов;
    - X-Content-Type-Options: nosniff — всегда;
    - X-Frame-Options — защита от clickjacking;
    - Referrer-Policy — ограничивает утечку URL во внешние ресурсы;
    - Permissions-Policy — отключает не используемые browser-features.

    Заголовки добавляются НЕ перезаписывая уже выставленные приложением
    (например, если эндпоинт явно сменил CSP).

    CSP в enforce-режиме защищён per-request nonce: для каждого http-запроса
    генерируется свежий nonce (``secrets.token_urlsafe``), кладётся в
    ``scope["state"]["csp_nonce"]`` (доступен шаблонам через
    ``request.state.csp_nonce``) и подставляется в плейсхолдер ``{nonce}``
    директивы ``script-src``. Так inline-скрипты с верным ``nonce``-атрибутом
    исполняются, а инъектированные злоумышленником — нет.
    """

    def __init__(self, app, settings: Settings):
        self.app = app
        sec = settings.security
        self._csp_enabled = sec.csp_enabled
        self._csp_header_name = (
            b"content-security-policy-report-only"
            if sec.csp_report_only
            else b"content-security-policy"
        )
        # Политика — шаблон-строка с плейсхолдером {nonce} в script-src.
        # Реальный nonce подставляется в send_wrapper на каждый запрос.
        self._csp_policy_template = sec.csp_policy
        self._csp_has_nonce = "{nonce}" in sec.csp_policy
        self._hsts_enabled = sec.hsts_enabled
        hsts_directives = [f"max-age={sec.hsts_max_age}"]
        if sec.hsts_include_subdomains:
            hsts_directives.append("includeSubDomains")
        self._hsts_value = "; ".join(hsts_directives).encode()
        self._frame_options = sec.frame_options.encode()
        self._referrer_policy = sec.referrer_policy.encode()
        self._permissions_policy = sec.permissions_policy.encode()

        logger.info(
            "Security headers инициализированы: CSP=%s (%s), HSTS=%s, X-Frame=%s",
            "on" if self._csp_enabled else "off",
            "report-only" if sec.csp_report_only else "enforce",
            "on" if self._hsts_enabled else "off",
            sec.frame_options,
        )

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        is_https = scope.get("scheme") == "https"

        # Per-request nonce: генерируем ДО рендера роутом и кладём в state,
        # чтобы шаблон проставил его inline-скриптам. Тот же nonce уходит в
        # заголовок CSP ниже — значения совпадают по построению.
        # request.state.csp_nonce публикуется ВСЕГДА (пустая строка, когда CSP
        # выключен или в политике нет плейсхолдера {nonce}): шаблоны читают его
        # безусловно, и отсутствие атрибута сломало бы рендер при StrictUndefined.
        csp_nonce = ""
        if self._csp_enabled and self._csp_has_nonce:
            csp_nonce = secrets.token_urlsafe(16)
        scope.setdefault("state", {})["csp_nonce"] = csp_nonce

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                existing = {name for name, _ in headers}

                def add(name: bytes, value: bytes):
                    if name not in existing:
                        headers.append([name, value])

                add(b"x-content-type-options", b"nosniff")
                add(b"x-frame-options", self._frame_options)
                add(b"referrer-policy", self._referrer_policy)
                add(b"permissions-policy", self._permissions_policy)
                if self._csp_enabled:
                    csp_value = self._csp_policy_template.replace(
                        "{nonce}", csp_nonce
                    )
                    add(self._csp_header_name, csp_value.encode())
                if self._hsts_enabled and is_https:
                    add(b"strict-transport-security", self._hsts_value)

                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_wrapper)


class RequestIdMiddleware:
    """
    Назначает уникальный request_id каждому входящему запросу.

    Читает X-Request-ID из заголовков (для сквозной трассировки через прокси),
    иначе генерирует короткий UUID. Сохраняет в ContextVar — доступен во всех логах
    в рамках обработки запроса. Возвращает request_id в заголовке ответа.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # Извлекаем X-Request-ID из заголовков запроса
        request_id = None
        for name, value in scope.get("headers", []):
            if name == b"x-request-id":
                request_id = value.decode()
                break

        if not request_id:
            request_id = uuid.uuid4().hex[:8]

        request_id_var.set(request_id)

        # Добавляем X-Request-ID в заголовки ответа
        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.append([b"x-request-id", request_id.encode()])
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_wrapper)
