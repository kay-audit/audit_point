/**
 * Страница логина (/login).
 *
 * - POST /api/v1/auth/login (FormData) → set-cookie + redirect на /
 * - показывает inline-ошибку при 401
 */
(function () {
    "use strict";

    const form = document.getElementById("loginForm");
    const errorBox = document.getElementById("loginError");
    const submitBtn = document.getElementById("loginSubmitBtn");
    const togglePwdBtn = document.getElementById("loginTogglePwd");
    const pwdInput = document.getElementById("loginPassword");

    if (togglePwdBtn && pwdInput) {
        togglePwdBtn.addEventListener("click", () => {
            pwdInput.type = pwdInput.type === "password" ? "text" : "password";
        });
    }

    if (!form) return;

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        errorBox.hidden = true;
        errorBox.textContent = "";
        submitBtn.disabled = true;
        const originalText = submitBtn.textContent;
        submitBtn.textContent = "Входим...";

        const username = document.getElementById("loginUsername").value.trim();
        const password = document.getElementById("loginPassword").value;

        try {
            const response = await fetch("/api/v1/auth/login", {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username, password }),
            });

            if (response.ok) {
                window.location.href = "/";
                return;
            }

            let detail = "Не удалось войти";
            try {
                const body = await response.json();
                if (body && body.detail) detail = body.detail;
            } catch (_) { /* noop */ }
            errorBox.textContent = detail;
            errorBox.hidden = false;
        } catch (err) {
            errorBox.textContent = "Ошибка сети: " + (err && err.message ? err.message : err);
            errorBox.hidden = false;
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
        }
    });
})();
