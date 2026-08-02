"""Шаблон письма с ОТП-кодом для входа."""

from __future__ import annotations


def build_otp_email(otp: str, ttl_minutes: int) -> tuple[str, str]:
    """Собирает письмо с кодом подтверждения.

    Args:
        otp: Код подтверждения.
        ttl_minutes: Срок жизни кода в минутах (для текста письма).

    Returns:
        Пара (тема, HTML-тело).
    """
    subject = "Ваш OTP-код для входа в Audit Workstation"
    html = f"""
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #2c3e50;">Audit Workstation</h2>
                <p style="font-size: 16px; color: #333;">Ваш код подтверждения:</p>
                <div style="background-color: #f8f9fa; padding: 20px; text-align: center; margin: 20px 0;">
                    <span style="font-size: 32px; font-weight: bold; color: #3498db; letter-spacing: 5px;">
                        {otp}
                    </span>
                </div>
                <p style="font-size: 14px; color: #666; margin-top: 20px;">
                    Этот код действителен в течение {ttl_minutes} минут.<br>
                    Если вы не запрашивали этот код, проигнорируйте это письмо.
                </p>
            </div>
            """
    return subject, html
