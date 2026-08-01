// Функции для работы со страницей аутентификации

document.addEventListener('DOMContentLoaded', function() {
    const loginForm = document.getElementById('loginForm');
    const otpSection = document.getElementById('otpSection');
    const emailInput = document.getElementById('email');
    const otpInput = document.getElementById('otp');
    const verifyOtpBtn = document.getElementById('verifyOtp');
    const resendOtpBtn = document.getElementById('resendOtp');
    const messageDiv = document.getElementById('message');

    // Отправка email для получения OTP
    loginForm.addEventListener('submit', async function(e) {
        e.preventDefault();

        const email = emailInput.value.trim();

        if (!email) {
            showMessage('Пожалуйста, введите email', 'error');
            return;
        }

        try {
            const response = await fetch('/api/v1/auth/request-otp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ email: email })
            });

            const data = await response.json();

            if (data.success) {
                showMessage('Код отправлен на ваш email', 'success');
                otpSection.style.display = 'block';
                loginForm.style.display = 'none';
            } else {
                showMessage(data.error || 'Ошибка при отправке кода', 'error');
            }
        } catch (error) {
            console.error('Error:', error);
            showMessage('Ошибка сети. Попробуйте позже.', 'error');
        }
    });

    // Верификация OTP
    verifyOtpBtn.addEventListener('click', async function() {
        const email = emailInput.value.trim();
        const otp = otpInput.value.trim();

        if (!otp) {
            showMessage('Пожалуйста, введите код', 'error');
            return;
        }

        try {
            const response = await fetch('/api/v1/auth/verify-otp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ email: email, otp: otp })
            });

            const data = await response.json();

            if (data.success) {
                console.log('OTP verified successfully:', data);
                // Перенаправление после успешной аутентификации
                console.log('Performing redirect to /');
                window.location.replace('/');
            } else {
                console.error('OTP verification failed:', data);
                showMessage(data.error || 'Неверный код', 'error');
            }
        } catch (error) {
            console.error('Error:', error);
            showMessage('Ошибка сети. Попробуйте позже.', 'error');
        }
    });

    // Отправка OTP повторно
    resendOtpBtn.addEventListener('click', async function() {
        const email = emailInput.value.trim();

        if (!email) {
            showMessage('Сначала введите email', 'warning');
            return;
        }

        try {
            const response = await fetch('/api/v1/auth/request-otp', {
               method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ email: email })
            });

            const data = await response.json();

            if (data.success) {
                showMessage('Код отправлен повторно', 'success');
            } else {
                showMessage(data.error || 'Ошибка при отправке кода', 'error');
            }
        } catch (error) {
            console.error('Error:', error);
            showMessage('Ошибка сети. Попробуйте позже.', 'error');
        }
    });

    // Функция для отображения сообщений
    function showMessage(text, type) {
        messageDiv.textContent = text;
        messageDiv.className = 'message';
        messageDiv.classList.add(type);

        // Автоматическое скрытие сообщения через 5 секунд
        setTimeout(() => {
            messageDiv.style.display = 'none';
        }, 5000);
    }
});
