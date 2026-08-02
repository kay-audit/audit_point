"""Тесты почтовой цепочки: Mail -> send_email -> EmailService.

Ключевая регрессия — молчаливая потеря письма: раньше отправка шла только
если предварительный NOOP отвечал 250, иначе письмо не уходило и никакой
ошибки не возникало — вызывающий код считал, что код доставлен.
"""

import smtplib
from unittest.mock import MagicMock, patch

import pytest

from app.domains.notifications.schemas.email import EmailSendRequest
from app.domains.notifications.services.email_service import (
    EmailService,
    send_email,
)
from app.services.mail import Mail


class _AuthConfig:
    """Минимальная конфигурация, которую ожидает Mail."""

    def get_auth_omega(self) -> tuple[str, str]:
        return ("login", "password")

    def get_mail_from_git(self) -> str:
        return "noreply@example.com"


@pytest.fixture
def smtp_mock():
    """Подменяет smtplib.SMTP и отдаёт мок соединения."""
    smtp = MagicMock()
    context = MagicMock()
    context.__enter__.return_value = smtp
    context.__exit__.return_value = False
    with patch("app.services.mail.smtplib.SMTP", return_value=context):
        yield smtp


def _make_mail() -> Mail:
    return Mail(auth=_AuthConfig(), server="smtp.example.com", port="25")


class TestMailSend:
    """Mail.__smtp: письмо уходит безусловно, ошибки не глотаются."""

    def test_message_is_sent(self, smtp_mock):
        _make_mail().send_email(
            receiver_email="user@example.com",
            receiver_copy=[],
            subject="Тема",
            body="<p>Тело</p>",
        )
        smtp_mock.login.assert_called_once_with("login", "password")
        smtp_mock.send_message.assert_called_once()

    def test_noop_gate_is_gone(self, smtp_mock):
        """NOOP больше не спрашиваем: его ответ решал, уйдёт ли письмо."""
        smtp_mock.noop.return_value = (421, b"Service not available")

        _make_mail().send_email(
            receiver_email="user@example.com",
            receiver_copy=[],
            subject="Тема",
            body="<p>Тело</p>",
        )

        smtp_mock.noop.assert_not_called()
        smtp_mock.send_message.assert_called_once()

    def test_smtp_error_propagates(self, smtp_mock):
        """Отказ SMTP поднимается исключением, а не превращается в тишину."""
        smtp_mock.send_message.side_effect = smtplib.SMTPRecipientsRefused({})

        with pytest.raises(smtplib.SMTPException):
            _make_mail().send_email(
                receiver_email="user@example.com",
                receiver_copy=[],
                subject="Тема",
                body="<p>Тело</p>",
            )


class TestSendEmailResult:
    """send_email/EmailService возвращают фактический результат отправки."""

    async def test_success_reported(self, monkeypatch, smtp_mock):
        monkeypatch.setattr(
            "app.domains.notifications.services.email_service._mail_client",
            _make_mail(),
        )
        response = await send_email(
            EmailSendRequest(to="user@example.com", subject="Тема", body="<p>Тело</p>")
        )
        assert response.success is True
        assert await EmailService().send_email(
            to="user@example.com", subject="Тема", body="<p>Тело</p>"
        ) is True

    async def test_smtp_failure_reported(self, monkeypatch, smtp_mock):
        smtp_mock.send_message.side_effect = smtplib.SMTPRecipientsRefused({})
        monkeypatch.setattr(
            "app.domains.notifications.services.email_service._mail_client",
            _make_mail(),
        )

        response = await send_email(
            EmailSendRequest(to="user@example.com", subject="Тема", body="<p>Тело</p>")
        )
        assert response.success is False
        assert response.error

        assert await EmailService().send_email(
            to="user@example.com", subject="Тема", body="<p>Тело</p>"
        ) is False

    async def test_uninitialized_client_reported(self, monkeypatch):
        monkeypatch.setattr(
            "app.domains.notifications.services.email_service._mail_client",
            None,
        )
        assert await EmailService().send_email(
            to="user@example.com", subject="Тема", body="<p>Тело</p>"
        ) is False
