/**
 * Профиль-попап в правом верхнем углу.
 *
 * - Загружает данные с /api/v1/auth/me
 * - Показывает ФИО + должность + логин в шапке
 * - По клику на #topbarUserProfile открывает диалог с формой:
 *     - смена пароля (старый + новый)
 *     - загрузка/замена аватарки
 *     - показ своего пароля (если Fernet настроен)
 *     - кнопка logout
 */
(function () {
    "use strict";

    const profileEl = document.getElementById("topbarUserProfile");
    if (!profileEl) return;

    // Подключаем к глобальному AuthManager: обновляет username/role/login
    const nameEl = document.getElementById("currentUserName");
    const roleEl = document.getElementById("currentUserRole");
    const loginEl = document.getElementById("currentUserLogin");
    const avatarEl = document.getElementById("topbarUserAvatar");

    let currentMe = null;

    async function loadMe() {
        try {
            const r = await fetch("/api/v1/auth/me", { credentials: "same-origin" });
            if (!r.ok) return null;
            const me = await r.json();
            currentMe = me;
            if (me.authenticated) {
                // Сервер уже отрендерил ФИО/должность/логин в topbar (см. templating.py
                // и templates/portal/layout/topbar.html). Здесь обновляем только если
                // /me вернул непустое значение — иначе не затираем серверный рендер
                // пустой строкой (это и был «флик» на /acts, /sqlagent, /ck_*_*).
                if (nameEl && me.fullname && me.fullname.trim()) {
                    nameEl.textContent = me.fullname;
                } else if (nameEl && !nameEl.textContent.trim()) {
                    nameEl.textContent = "Пользователь";
                }
                if (roleEl) {
                    roleEl.textContent = me.job || "";
                }
                if (loginEl) {
                    loginEl.textContent = me.username ? `Логин: ${me.username}` : "";
                    loginEl.style.display = me.username ? "" : "none";
                }
                if (me.avatar_available) {
                    avatarEl.innerHTML = "";
                    const img = document.createElement("img");
                    img.src = "/api/v1/auth/me/avatar?t=" + Date.now();
                    img.alt = "avatar";
                    img.className = "topbar-user-avatar-img";
                    avatarEl.appendChild(img);
                } else {
                    avatarEl.innerHTML = avatarDefaultSvg();
                }
            } else {
                window.location.href = "/login";
            }
            return me;
        } catch (e) {
            console.warn("loadMe failed", e);
            return null;
        }
    }

    function avatarDefaultSvg() {
        return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none">' +
            '<path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"' +
            ' stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
            '</svg>';
    }

    // ============================================================
    // POPUP
    // ============================================================

    let overlayEl = null;

    function openPopup() {
        if (overlayEl) {
            overlayEl.remove();
        }
        if (!currentMe || !currentMe.authenticated) {
            window.location.href = "/login";
            return;
        }

        overlayEl = document.createElement("div");
        overlayEl.className = "profile-popup-overlay";
        overlayEl.innerHTML = `
            <div class="profile-popup" role="dialog" aria-modal="true" aria-label="Профиль">
                <div class="profile-popup-header">
                    <h3 class="profile-popup-title">Профиль</h3>
                    <button class="profile-popup-close" id="profilePopupClose"
                            aria-label="Закрыть">&times;</button>
                </div>
                <div class="profile-popup-body">
                    <div class="profile-popup-section profile-popup-user">
                        <div class="profile-popup-user-avatar" id="profilePopupAvatar">
                            ${currentMe.avatar_available
                                ? `<img src="/api/v1/auth/me/avatar?t=${Date.now()}" alt="avatar">`
                                : avatarDefaultSvg()}
                        </div>
                        <div class="profile-popup-user-info">
                            <div class="profile-popup-user-name">${escapeHtml(currentMe.fullname || "")}</div>
                            <div class="profile-popup-user-job">${escapeHtml(currentMe.job || "")}</div>
                            <div class="profile-popup-user-login">Логин: <code>${escapeHtml(currentMe.username || "")}</code></div>
                        </div>
                    </div>

                    <div class="profile-popup-section">
                        <h4 class="profile-popup-section-title">Сменить пароль</h4>
                        <form id="profileChangePwdForm" class="profile-popup-form">
                            <label>
                                <span>Текущий пароль</span>
                                <input type="password" name="old_password" required minlength="1" autocomplete="current-password">
                            </label>
                            <label>
                                <span>Новый пароль</span>
                                <input type="password" name="new_password" required minlength="1" autocomplete="new-password">
                            </label>
                            <div class="profile-popup-error" id="profilePwdError" hidden></div>
                            <div class="profile-popup-actions">
                                <button type="button" class="btn btn-warning profile-popup-pwd-show" id="profileShowOwnPwd">
                                    Показать свой пароль
                                </button>
                                <button type="submit" class="btn btn-warning profile-popup-submit">Сменить</button>
                            </div>
                        </form>
                    </div>

                    <div class="profile-popup-section">
                        <h4 class="profile-popup-section-title">Аватар</h4>
                        <form id="profileAvatarForm" class="profile-popup-form" enctype="multipart/form-data">
                            <label>
                                <span>Файл (PNG / JPEG / WebP, до 2 МБ)</span>
                                <input type="file" name="file" accept="image/png,image/jpeg,image/webp" required>
                            </label>
                            <div class="profile-popup-error" id="profileAvatarError" hidden></div>
                            <div class="profile-popup-actions">
                                <button type="submit" class="btn btn-warning profile-popup-submit">Загрузить</button>
                                <button type="button" class="btn btn-warning profile-popup-ghost" id="profileDeleteAvatarBtn">Удалить</button>
                            </div>
                        </form>
                    </div>

                    <div class="profile-popup-section">
                        <button type="button" class="profile-popup-logout" id="profileLogoutBtn">Выйти</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(overlayEl);

        overlayEl.addEventListener("click", (e) => {
            if (e.target === overlayEl) closePopup();
        });
        overlayEl.querySelector("#profilePopupClose").addEventListener("click", closePopup);
        overlayEl.querySelector("#profileChangePwdForm").addEventListener("submit", onChangePwd);
        overlayEl.querySelector("#profileAvatarForm").addEventListener("submit", onUploadAvatar);
        overlayEl.querySelector("#profileDeleteAvatarBtn").addEventListener("click", onDeleteAvatar);
        overlayEl.querySelector("#profileLogoutBtn").addEventListener("click", onLogout);
        overlayEl.querySelector("#profileShowOwnPwd").addEventListener("click", onShowOwnPwd);
    }

    function closePopup() {
        if (overlayEl) {
            overlayEl.remove();
            overlayEl = null;
        }
    }

    function escapeHtml(s) {
        return String(s || "").replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
    }

    function showError(elId, msg) {
        const el = overlayEl && overlayEl.querySelector("#" + elId);
        if (!el) return;
        el.textContent = msg;
        el.hidden = false;
    }
    function hideError(elId) {
        const el = overlayEl && overlayEl.querySelector("#" + elId);
        if (!el) return;
        el.textContent = "";
        el.hidden = true;
    }

    // ---------- handlers ----------

    async function onChangePwd(e) {
        e.preventDefault();
        hideError("profilePwdError");
        const fd = new FormData(e.target);
        const body = {
            old_password: fd.get("old_password"),
            new_password: fd.get("new_password"),
        };
        try {
            const r = await fetch("/api/v1/auth/me/change-password", {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (r.ok) {
                alert("Пароль изменён. Необходимо войти заново.");
                window.location.href = "/login";
                return;
            }
            let detail = "Не удалось сменить пароль";
            try {
                const j = await r.json();
                if (j && j.detail) detail = j.detail;
            } catch (_) {}
            showError("profilePwdError", detail);
        } catch (err) {
            showError("profilePwdError", "Ошибка: " + err.message);
        }
    }

    async function onUploadAvatar(e) {
        e.preventDefault();
        hideError("profileAvatarError");
        const fd = new FormData(e.target);
        try {
            const r = await fetch("/api/v1/auth/me/avatar", {
                method: "PUT",
                credentials: "same-origin",
                body: fd,
            });
            if (r.ok) {
                // Обновляем аватар
                currentMe.avatar_available = true;
                const avEl = overlayEl.querySelector("#profilePopupAvatar");
                if (avEl) {
                    avEl.innerHTML = `<img src="/api/v1/auth/me/avatar?t=${Date.now()}" alt="avatar">`;
                }
                // И в topbar
                if (avatarEl) {
                    avatarEl.innerHTML = "";
                    const img = document.createElement("img");
                    img.src = "/api/v1/auth/me/avatar?t=" + Date.now();
                    img.alt = "avatar";
                    img.className = "topbar-user-avatar-img";
                    avatarEl.appendChild(img);
                }
                return;
            }
            let detail = "Не удалось загрузить аватар";
            try {
                const j = await r.json();
                if (j && j.detail) detail = j.detail;
            } catch (_) {}
            showError("profileAvatarError", detail);
        } catch (err) {
            showError("profileAvatarError", "Ошибка: " + err.message);
        }
    }

    async function onDeleteAvatar() {
        hideError("profileAvatarError");
        if (!confirm("Удалить аватар?")) return;
        try {
            const r = await fetch("/api/v1/auth/me/avatar", {
                method: "DELETE",
                credentials: "same-origin",
            });
            if (r.ok || r.status === 204) {
                currentMe.avatar_available = false;
                if (overlayEl) {
                    const avEl = overlayEl.querySelector("#profilePopupAvatar");
                    if (avEl) avEl.innerHTML = avatarDefaultSvg();
                }
                if (avatarEl) {
                    avatarEl.innerHTML = avatarDefaultSvg();
                }
            }
        } catch (err) {
            showError("profileAvatarError", "Ошибка: " + err.message);
        }
    }

    async function onShowOwnPwd() {
        hideError("profilePwdError");
        try {
            const r = await fetch("/api/v1/auth/me/password", { credentials: "same-origin" });
            if (r.ok) {
                const j = await r.json();
                const msg = `Ваш пароль: ${j.password}\n\nСкопируйте вручную. В целях безопасности просмотр доступен только вам.`;
                prompt("Пароль (можно скопировать через Ctrl+C)", j.password);
                return;
            }
            if (r.status === 404) {
                showError("profilePwdError",
                    "Невозможно показать пароль: шифрование не настроено. " +
                    "Пароль можно только сменить.");
                return;
            }
            if (r.status === 401) {
                showError("profilePwdError", "Сессия истекла — войдите снова.");
                return;
            }
            showError("profilePwdError", "Не удалось получить пароль (HTTP " + r.status + ")");
        } catch (err) {
            showError("profilePwdError", "Ошибка: " + err.message);
        }
    }

    async function onLogout() {
        try {
            await fetch("/api/v1/auth/logout", { method: "POST", credentials: "same-origin" });
        } catch (e) { /* noop */ }
        window.location.href = "/login";
    }

    profileEl.addEventListener("click", openPopup);
    profileEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openPopup();
        }
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && overlayEl) closePopup();
    });

    // Инициализация: имя/роль/логин уже отрендерены сервером в topbar.
    // Нам нужно только обновить аватар (если есть) и убедиться, что
    // пользователь аутентифицирован (иначе middleware уже редиректнул).
    loadMe().then((me) => {
        if (!me || !me.authenticated) {
            window.location.href = "/login";
        }
    });
})();
