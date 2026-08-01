"""Сервис email-уведомлений с интеграцией класса Mail."""

import logging
import asyncio
import os
from typing import Optional

from app.services.mail import Mail as MailClient
from app.domains.notifications.schemas.email import (
    EmailSendRequest,
    EmailSendResponse,
)

logger = logging.getLogger("audit_workstation.domains.notifications.email")

# Глобальный объект Mail (инициализируется при старте)
_mail_client: Optional[MailClient] = None


class EmailService:
    """Сервис email-уведомлений с интеграцией класса Mail.

    Принимает соединение из пула, но email-отправка использует глобальный
    _mail_client (инициализируется при старте приложения).
    """

    def __init__(self, conn: Optional[None] = None):
        """
        Args:
            conn: Соединение с БД (не используется в первой версии, оставлено
                  для совместимости с паттерном domain service)
        """
        self.conn = conn

    async def send_email(
        self,
        to: str,
        subject: str,
        body: str,
        cc: Optional[list[str]] = None,
        attachments: Optional[list[dict]] = None,
        timeout: float = 30.0,
    ) -> bool:
        """
        Отправляет email-уведомление.

        Args:
            to: Email получателя
            subject: Тема письма
            body: Тело письма в HTML
            cc: Копии (CC)
            attachments: Список вложений
            timeout: Таймаут отправки в секундах

        Returns:
            True если отправка успешна, False иначе
        """
        request = EmailSendRequest(
            to=to,
            subject=subject,
            body=body,
            cc=cc,
            attachments=attachments,
        )
        response = await send_email(request, timeout=timeout)
        return response.success


def init_email_service(
    smtp_host: str,
    smtp_port: int,
    smtp_user: str,
    smtp_password: str,
    default_from: str,
) -> None:
    """
    Инициализирует email-сервис с параметрами SMTP.

    Вызывается в lifespan при старте приложения.
    Пароль передаётся из .env файла или secure prompt.

    Args:
        smtp_host: Хост SMTP-сервера
        smtp_port: Порт SMTP-сервера
        smtp_user: Логин SMTP-пользователя
        smtp_password: Пароль SMTP-пользователя
        default_from: Email по умолчанию для поля From
    """
    global _mail_client

    # Создаём класс для работы с почтой с переданными параметрами
    # Класс Mail ожидает auth объект с методами get_auth_omega() и get_mail_from_git()
    # Для совместимости создаём простой объект-обёртку
    auth_config = _create_auth_config(smtp_user, smtp_password, default_from)

    _mail_client = MailClient(
        auth=auth_config,
        server=smtp_host,
        port=str(smtp_port),
    )

    logger.info(
        "Email service initialized: %s:%d, user=%s",
        smtp_host,
        smtp_port,
        smtp_user,
    )


def _create_auth_config(
    smtp_user: str,
    smtp_password: str,
    default_from: str,
) -> object:
    """
    Создаёт объект конфигурации для класса Mail.

    Возвращает объект с методами get_auth_omega() и get_mail_from_git(),
    совместимыми с текущей реализацией Mail.

    Args:
        smtp_user: Логин SMTP
        smtp_password: Пароль SMTP
        default_from: Email отправителя

    Returns:
        Объект конфигурации
    """
    class AuthConfig:
        def get_auth_omega(self) -> tuple[str, str]:
            """Возвращает кортеж (login, password) для SMTP-аутентификации."""
            return (smtp_user, smtp_password)

        def get_mail_from_git(self) -> str:
            """Возвращает email для поля From."""
            return default_from

    return AuthConfig()


def get_mail_client() -> MailClient:
    """
    Возвращает инициализированный клиент Mail.

    Returns:
        Экземпляр Mail

    Raises:
        RuntimeError: Если email-сервис не инициализирован
    """
    if _mail_client is None:
        raise RuntimeError(
            "Email service not initialized. Call init_email_service() first."
        )
    return _mail_client


async def send_email(
    request: EmailSendRequest,
    timeout: float = 30.0,
) -> EmailSendResponse:
    """
    Отправляет email-уведомление асинхронно.

    Args:
        request: Запрос на отправку email
        timeout: Таймаут отправки в секундах

    Returns:
        EmailSendResponse с результатом отправки
    """
    if _mail_client is None:
        logger.error("Email service not initialized")
        return EmailSendResponse(
            success=False,
            error="Email service not initialized",
        )

    # Обёртка синхронного метода send_email в async
    def _sync_send():
        return _mail_client.send_email(
            receiver_email=request.to,
            receiver_copy=request.cc or [],
            subject=request.subject,
            body=request.body,
            attachments=request.attachments,
        )

    try:
        # Выполняем синхронный метод в пуле потоков
        loop = asyncio.get_event_loop()
        result = await asyncio.wait_for(
            loop.run_in_executor(None, _sync_send),
            timeout=timeout,
        )

        return EmailSendResponse(success=True, message_id=str(result))

    except asyncio.TimeoutError:
        logger.error("Email sending timed out after %.1f seconds", timeout)
        return EmailSendResponse(
            success=False,
            error="Timeout while sending email",
        )

    except Exception as e:
        logger.exception("Failed to send email: %s", e)
        return EmailSendResponse(
            success=False,
            error=str(e),
        )


async def send_email_to_user(
    user_email: str,
    subject: str,
    body: str,
    cc: Optional[list[str]] = None,
    attachments: Optional[list[dict]] = None,
) -> EmailSendResponse:
    """
    Упрощённый метод для отправки email пользователю.

    Args:
        user_email: Email получателя
        subject: Тема письма
        body: Тело письма в HTML
        cc: Копии (CC)
        attachments: Список вложений

    Returns:
        EmailSendResponse с результатом
    """
    request = EmailSendRequest(
        to=user_email,
        subject=subject,
        body=body,
        cc=cc,
        attachments=attachments,
    )
    return await send_email(request)
