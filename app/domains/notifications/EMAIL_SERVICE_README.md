# Email Service

## Интеграция с Notifications Domain

Email-сервис интегрирован в домен notifications и использует существующий класс `Mail` из `app/services/mail.py`.

## Настройка

### 1. Конфигурация в .env

```env
DATABASE__TYPE=greenplum
NOTIFICATIONS__EMAIL__ENABLED=true
NOTIFICATIONS__EMAIL__SMTP_HOST=smtp.company.com
NOTIFICATIONS__EMAIL__SMTP_PORT=587
NOTIFICATIONS__EMAIL__SMTP_USER=notify@company.com
NOTIFICATIONS__EMAIL__DEFAULT_FROM=notify@company.com
```

### 2. Пароль SMTP

Пароль можно задать в `.env` файле:
```env
NOTIFICATIONS__EMAIL__SMTP_PASSWORD=ваш_пароль
```

Если пароль не задан в `.env`, он будет запрошен через `getpass()` при инициализации приложения.

## Использование из других доменов

### Пример: Отправка email при экспорте акта

```python
# В acts domain (например, в сервисе экспорта)

from app.core.domain_registry import get_factory, has_factory

async def export_act_and_notify(user_email: str, act_id: str):
    # Экспорт акта...

    # Отправка уведомления
    if has_factory("notifications.email"):
        factory = get_factory("notifications.email")
        async for svc in factory():
            await svc.send_email(
                to=user_email,
                subject="Акт готов к загрузке",
                body=f"<p>Акт №{act_id} готов к загрузке.</p>",
            )
```

### Асинхронная отправка

```python
from app.domains.notifications.services.email_service import send_email_to_user
from app.domains.notifications.schemas.email import EmailSendRequest

# Метод 1: Через EmailService
async def notify_user(user_email: str, subject: str, body: str):
    from app.core.domain_registry import get_factory, has_factory

    if has_factory("notifications.email"):
        factory = get_factory("notifications.email")
        async for svc in factory():
            await svc.send_email(
                to=user_email,
                subject=subject,
                body=body,
                cc=["copy@example.com"],
            )

# Метод 2: Прямой вызов
async def send_simple_email(user_email: str, subject: str, body: str):
    response = await send_email_to_user(
        user_email=user_email,
        subject=subject,
        body=body,
    )
    if response.success:
        logger.info("Email sent successfully")
    else:
        logger.error(f"Failed to send email: {response.error}")
```

## Структура

```
app/domains/notifications/
├── services/
│   ├── email_service.py      # Основной сервис email
│   └── notification_service.py  # Внутренние уведомления
├── schemas/
│   └── email.py              # Pydantic схемы для email
├── migrations/
│   ├── postgresql/schema.sql
│   └── greenplum/schema.sql
└── settings.py               # EmailSettings
```

## Технические детали

### Классы

- **EmailService** - сервис для использования в доменах
- **EmailSendRequest** - запрос на отправку email
- **EmailSendResponse** - ответ с результатом отправки

### Функции

- `init_email_service()` - инициализация сервиса при старте
- `send_email()` - асинхронная отправка email
- `send_email_to_user()` - упрощённая отправка пользователю

### Запросы из .env

| Параметр | Описание | Значение по умолчанию |
|----------|----------|----------------------|
| `NOTIFICATIONS__EMAIL__ENABLED` | Включить отправку email | false |
| `NOTIFICATIONS__EMAIL__SMTP_HOST` | Хост SMTP-сервера | smtp.company.com |
| `NOTIFICATIONS__EMAIL__SMTP_PORT` | Порт SMTP-сервера | 587 |
| `NOTIFICATIONS__EMAIL__SMTP_USER` | Логин SMTP | user@domain.com |
| `NOTIFICATIONS__EMAIL__SMTP_PASSWORD` | Пароль (запрашивается) | - |
| `NOTIFICATIONS__EMAIL__DEFAULT_FROM` | Email отправителя | noreply@company.com |

## Шаблоны email

В будущем можно расширить функциональность для работы с шаблонами:

```sql
-- Таблица email_templates уже создана в миграции
CREATE TABLE email_templates (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    subject TEXT NOT NULL,
    body_html TEXT NOT NULL,
    body_text TEXT
);
```
