"""Pydantic-схемы для email-уведомлений."""

from typing import Optional
from pydantic import BaseModel, Field


class EmailSendRequest(BaseModel):
    """Запрос на отправку email-уведомления."""

    to: str = Field(max_length=255, description="Email получателя")
    subject: str = Field(max_length=500, description="Тема письма")
    body: str = Field(description="Тело письма в HTML формате")
    cc: Optional[list[str]] = Field(default=None, description="Копии (CC)")
    attachments: Optional[list[dict]] = Field(
        default=None,
        description="Список вложений [{'filename': str, 'body': bytes}, ...]"
    )


class EmailSendResponse(BaseModel):
    """Ответ на отправку email."""

    success: bool
    message_id: Optional[str] = None
    error: Optional[str] = None


class EmailTemplate(BaseModel):
    """Шаблон email-сообщения."""

    id: str
    name: str
    subject: str
    body_html: str
    body_text: Optional[str] = None
    created_at: str
    updated_at: str


class EmailTemplateCreate(BaseModel):
    """Создание шаблона email."""

    name: str = Field(max_length=100)
    subject: str = Field(max_length=500)
    body_html: str
    body_text: Optional[str] = None


class EmailTemplateUpdate(BaseModel):
    """Обновление шаблона email."""

    name: Optional[str] = Field(default=None, max_length=100)
    subject: Optional[str] = Field(default=None, max_length=500)
    body_html: Optional[str] = None
    body_text: Optional[str] = None
