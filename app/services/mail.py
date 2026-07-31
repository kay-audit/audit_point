''' Модуль по работе с почтой
'''
import smtplib
import poplib
import os
import ssl
import email

from tqdm import tqdm
from typing import Optional
from email import encoders
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email.mime.text import MIMEText
from email.header import decode_header


class Mail:
    ''' класс по работе со входящей почтой
    '''
    def __init__(
            self,
            auth: any,
            server: str,
            port: str,
    ):
        self._config = auth
        self._server = server
        self._smtp_port = port

    def get_attach(self):
        ''' Получение непрочитанных писем с вложениями
        '''
        conf = self._config.get_auth_omega()
        # context = ssl.create_default_context()
        context = ssl._create_unverified_context()
        server = poplib.POP3(self._server, '110')
        # server = poplib.POP3_SSL(self._server, '995', context=context)
        server.login(
            conf[0]
        )
        server.pass_(conf[1])
        server.select('inbox')
        messages = server.search(None, 'UNSEEN')[1]
        for message in tqdm(messages[0].split()):
            data = server.fetch(message, '(RFC822)')[1]
            email_body = data[0][1]
            raw_email_string = email_body.decode('utf-8')
            mail = email.message_from_string(raw_email_string)
            subject = self.get_subject(mail)
            for part in mail.walk():
                if part.get_content_maintype() == 'multipart':
                    continue
                if part.get('Content-Disposition') is None:
                    continue
                file_name = part.get_filename()
                if bool(file_name):
                    self._save_attach(
                        subject,
                        part.get_payload(decode=True),
                        file_name
                    )

    def _save_attach(self, subject, payload, file_name):
        new_filename = file_name.replace(
            '.xlsx',
            '_' + self.theme_dict[subject] + '.xlsx'
        )

        file_path = os.path.join('attachments', new_filename)
        if not os.path.isfile(file_path):
            with open(file_path, 'wb') as fp:
                fp.write(payload)

    def get_subject(self, msg):
        ''' Получение темы письма
        '''
        return decode_header(msg['Subject'])[0][0].decode()

    def send_email(
        self,
        receiver_email,
        receiver_copy,
        subject,
        body,
        attachments: Optional[list] = None,
    ):
        ''' Функция отправки письма
        '''
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
        with smtplib.SMTP(self._server, self._smtp_port) as smtp:
            conf = self._config.get_auth_omega()
            smtp.login(
                conf[0],
                conf[1],
            )
            if smtp.noop()[0] == 250:
                smtp.send_message(msg)
