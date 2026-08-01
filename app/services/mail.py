"""Модуль отправки почты через SMTP.

Урезан при интеграции наработок внутреннего контура: оставлена только отправка
(send_email). POP3-приём вложений из исходной версии удалён как неиспользуемый
и нерабочий (обращался к несуществующим атрибутам).
"""
import smtplib

from typing import Optional
from email import encoders
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email.mime.text import MIMEText


class Mail:
    """Клиент отправки писем через корпоративный SMTP-релей."""

    def __init__(
            self,
            auth: any,
            server: str,
            port: str,
    ):
        self._config = auth
        self._server = server
        self._smtp_port = port

    def send_email(
        self,
        receiver_email,
        receiver_copy,
        subject,
        body,
        attachments: Optional[list] = None,
    ):
        """Отправка письма (HTML-тело, опциональные вложения)."""
        msg = MIMEMultipart()
        git_mail = self._config.get_mail_from_git()
        msg['From'] = git_mail
        msg['To'] = receiver_email
        # преобразуем список в строку с разделителями запятыми
        if isinstance(receiver_copy, list):
            msg['Cc'] = ", ".join(receiver_copy)
        else:
            msg['Cc'] = receiver_copy
        msg['Subject'] = subject
        msg.attach(MIMEText(body, 'html'))

        if attachments is not None:
            for att in attachments:
                # Создание вложения
                filename = att['filename']
                attachment = MIMEBase('application', 'octet-stream')
                attachment.set_payload(att['body'])

                # Кодирование в base64
                encoders.encode_base64(attachment)
                attachment.add_header(
                    'Content-Disposition',
                    f'attachment; filename= {filename}',
                )

                msg.attach(attachment)

        return self.__smtp(msg)

    def __smtp(self, msg):
        with smtplib.SMTP(self._server, self._smtp_port, timeout=30) as smtp:
            conf = self._config.get_auth_omega()
            smtp.login(
                conf[0],
                conf[1],
            )
            if smtp.noop()[0] == 250:
                smtp.send_message(msg)
