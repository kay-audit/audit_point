/**
 * Менеджер главной страницы выбора актов
 *
 * Реализует управление списком актов, включая создание, редактирование (с блокировкой),
 * дублирование и удаление. При редактировании метаданных выполняется логика блокировки
 * через LockManager и безопасного сохранения перед выходом, аналогично поведению конструктора.
 */
import { LockManager } from '../../constructor/lock-manager.js';
import { ActsBroadcast } from './acts-broadcast.js';
import { AuditLogDialog } from './dialog-audit-log.js';
import { CreateActDialog } from './dialog-create-act.js';
import { pickSessionExitNotice } from './session-exit-notice.js';
import { AppConfig } from '../../shared/app-config.js';
import { AuthManager } from '../../shared/auth.js';
import { DialogManager } from '../../shared/dialog/dialog-confirm.js';
import { Notifications } from '../../shared/notifications.js';
import { registerActsSource } from './notifications-source-acts.js';

export class ActsManagerPage {
    /* --- Состояние пагинации (load-more) --- */
    static _pageSize = 50;
    static _offset = 0;
    static _total = 0;
    static _loadingMore = false;

    /* --- Утилиты форматирования --- */

    /**
     * Форматирует отображение КМ с учетом служебной записки.
     * Если есть СЗ — склеиваем КМ + "_" + часть.
     * Для многочастных актов без СЗ также добавляем часть.
     * @private
     * @param {string} kmNumber - Номер КМ
     * @param {number} partNumber - Номер части
     * @param {number} totalParts - Всего частей
     * @param {string} serviceNote - Номер служебной записки
     * @returns {string} Отформатированная строка КМ
     */
    static _formatKmNumber(kmNumber, partNumber, totalParts, serviceNote) {
        if (serviceNote) return `${kmNumber}_${partNumber}`;
        if (totalParts > 1) return `${kmNumber}_${partNumber}`;
        return kmNumber;
    }

    /**
     * Форматирует дату в формате DD.MM.YYYY.
     * @private
     * @param {string} date - Дата в ISO формате
     * @returns {string} Отформатированная дата или прочерк
     */
    static _formatDate(date) {
        if (!date) return '—';
        try {
            const d = new Date(date);
            if (isNaN(d.getTime())) return '—';
            const day = String(d.getDate()).padStart(2, '0');
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const year = d.getFullYear();
            return `${day}.${month}.${year}`;
        } catch {
            return '—';
        }
    }

    /**
     * Форматирует дату и время в формате DD.MM.YYYY HH:MM.
     * @private
     * @param {string} datetime - Дата и время в ISO формате
     * @returns {string} Отформатированная дата-время или текст по умолчанию
     */
    static _formatDateTime(datetime) {
        if (!datetime) return 'Не редактировался';
        try {
            const d = new Date(datetime);
            if (isNaN(d.getTime())) return 'Не редактировался';
            const day = String(d.getDate()).padStart(2, '0');
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const year = d.getFullYear();
            const hours = String(d.getHours()).padStart(2, '0');
            const minutes = String(d.getMinutes()).padStart(2, '0');
            return `Изменено: ${day}.${month}.${year} ${hours}:${minutes}`;
        } catch {
            return 'Не редактировался';
        }
    }

    /**
     * Клонирует template элемент по ID.
     * @private
     * @param {string} templateId - ID template элемента
     * @returns {DocumentFragment|null} Клонированный фрагмент или null
     */
    static _cloneTemplate(templateId) {
        const template = document.getElementById(templateId);
        if (!template) {
            console.error(`Template ${templateId} не найден`);
            return null;
        }
        return template.content.cloneNode(true);
    }

    /**
     * Заполняет поля в элементе данными через data-field атрибуты.
     * @private
     * @param {Element} element - Элемент для заполнения
     * @param {Object} data - Объект с данными
     */
    static _fillFields(element, data) {
        element.querySelectorAll('[data-field]').forEach(field => {
            const fieldName = field.getAttribute('data-field');
            if (Object.prototype.hasOwnProperty.call(data, fieldName)) {
                field.textContent = data[fieldName];
            }
        });
    }

    /* --- Определение статуса акта --- */

    /**
     * Определяет статус акта на основе флагов валидации.
     * Используется для применения классов стилизации и формирования tooltip.
     * @private
     * @param {Object} act - Данные акта
     * @returns {Object} Объект статуса с типом, классами, tooltip и флагами
     */
    static _getActStatus(act) {
        // Проверяем блокировку (приоритетный статус)
        if (act.is_locked) {
            return {
                type: 'locked',
                classes: ['locked'],
                tooltip: `Акт редактируется пользователем ${act.locked_by}.\nПопробуйте открыть его позже.`,
                needsHighlight: false
            };
        }

        // Критичный статус (красная карточка): проверка фактуры ИЛИ
        // структурная ОШИБКА содержимого (#8 — error приравнен к фактуре).
        const needsInvoice = act.needs_invoice_check;
        const validationError = act.validation_status === 'error';
        const isCritical = needsInvoice || validationError;

        // Жёлтое тело дают только незаполненные поля метаданных. Структурный
        // warning (напр. пустые таблицы) карточку НЕ красит — он виден лишь
        // агрегатом в колокольчике лендинга и полным списком внутри акта.
        const hasFieldIssues =
            act.needs_created_date ||
            act.needs_directive_number ||
            act.needs_service_note;

        // Нормальный статус — ничего не подсвечиваем.
        if (!isCritical && !hasFieldIssues) {
            return { type: 'normal', classes: [], tooltip: null, needsHighlight: false };
        }

        const classes = [];
        if (needsInvoice) classes.push('needs-invoice');
        if (validationError) classes.push('validation-error');
        if (hasFieldIssues) classes.push('needs-attention');

        const tooltipParts = [];
        if (needsInvoice) tooltipParts.push('🚨 КРИТИЧНО: Необходима проверка фактуры!');
        if (validationError) {
            const review = this._buildReviewTooltip(act);
            tooltipParts.push('🚨 Акт требует проверки:' + (review ? '\n' + review : ''));
        }
        if (hasFieldIssues) {
            const fields = this._buildValidationTooltip(act);
            if (fields) tooltipParts.push('⚠️ Требуется заполнение полей:\n' + fields);
        }

        return {
            type: isCritical ? 'critical' : 'attention',
            classes,
            tooltip: tooltipParts.join('\n\n'),
            needsHighlight: true,
            isCritical,
        };
    }

    /**
     * Формирует текст tooltip из конкретных ОШИБОК структурной валидации
     * (validation_issues severity='error' с бэка, #8). Warning'и в tooltip
     * критичной карточки не выводим — они видны полным списком внутри акта.
     * @private
     * @param {Object} act - Данные акта
     * @returns {string} Многострочный текст или ''
     */
    static _buildReviewTooltip(act) {
        const issues = Array.isArray(act.validation_issues) ? act.validation_issues : [];
        return issues
            .filter(i => i && i.severity === 'error')
            .map(i => `• ${i.message}`)
            .join('\n');
    }

    /**
     * Формирует текст tooltip с перечислением незаполненных полей.
     * @private
     * @param {Object} act - Данные акта
     * @returns {string} Многострочный текст с пунктами
     */
    static _buildValidationTooltip(act) {
        const issues = [];

        if (act.needs_created_date) {
            issues.push('• Дата составления акта');
        }
        if (act.needs_directive_number) {
            issues.push('• Номера поручений');
        }
        if (act.needs_service_note) {
            issues.push('• Служебная записка');
        }

        return issues.length > 0 ? issues.join('\n') : '';
    }

    /* --- Основной функционал --- */

    /**
     * Загружает список актов из API (всегда свежие данные из БД).
     * Не использует кеш, всегда делает запрос к серверу.
     */
    static async loadActs() {
        const container = document.getElementById('actsListContainer');
        if (!container) return;

        // Сбрасываем состояние пагинации — это всегда загрузка с нуля.
        this._offset = 0;
        this._total = 0;
        this._loadingMore = false;

        // Показываем загрузку
        this._showLoading(container);

        try {
            const username = AuthManager.getCurrentUser();

            if (!username) {
                throw new Error('Пользователь не авторизован');
            }

            const url = AppConfig.api.getUrl(
                `/api/v1/acts/list?limit=${this._pageSize}&offset=0`
            );
            const response = await fetch(url, { headers: {} });

            if (!response.ok) {
                throw new Error('Ошибка загрузки списка актов');
            }

            const data = await response.json();
            const acts = data.items || [];
            this._total = data.total || acts.length;
            this._offset = acts.length;

            if (!acts.length) {
                this._showEmptyState(container);
                return;
            }

            this._renderActsGrid(acts, container);
            this._renderLoadMore(container);

        } catch (error) {
            console.error('Ошибка загрузки актов:', error);
            this._showErrorState(container);
            Notifications.error('Ошибка загрузки списка актов');
        }
    }

    /**
     * Подгружает следующую страницу актов и дописывает карточки в существующий грид.
     * @private
     */
    static async _loadMore() {
        if (this._loadingMore) return;
        if (this._offset >= this._total) return;

        const container = document.getElementById('actsListContainer');
        if (!container) return;
        const grid = container.querySelector('.acts-grid');
        if (!grid) return;

        this._loadingMore = true;
        const btn = container.querySelector('.acts-load-more-btn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Загрузка...';
        }

        try {
            const url = AppConfig.api.getUrl(
                `/api/v1/acts/list?limit=${this._pageSize}&offset=${this._offset}`
            );
            const response = await fetch(url, { headers: {} });
            if (!response.ok) {
                throw new Error('Ошибка загрузки списка актов');
            }

            const data = await response.json();
            const acts = data.items || [];
            this._total = data.total || this._total;
            this._offset += acts.length;

            acts.forEach(act => {
                const card = this._createActCard(act);
                if (card) grid.appendChild(card);
            });

            this._renderLoadMore(container);
        } catch (error) {
            console.error('Ошибка подгрузки актов:', error);
            Notifications.error('Не удалось загрузить ещё акты');
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Загрузить ещё';
            }
        } finally {
            this._loadingMore = false;
        }
    }

    /**
     * Создаёт/обновляет кнопку «Загрузить ещё» под гридом.
     * Скрывается (удаляется), когда загружены все акты (offset >= total).
     * @private
     * @param {HTMLElement} container - Контейнер списка актов
     */
    static _renderLoadMore(container) {
        let btn = container.querySelector('.acts-load-more-btn');

        if (this._offset >= this._total) {
            if (btn) btn.remove();
            return;
        }

        if (!btn) {
            btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-secondary acts-load-more-btn';
            btn.addEventListener('click', () => this._loadMore());
            container.appendChild(btn);
        }
        btn.disabled = false;
        const remaining = this._total - this._offset;
        btn.textContent = `Загрузить ещё (осталось ${remaining})`;
    }

    /**
     * Показывает индикатор загрузки.
     * @private
     * @param {HTMLElement} container - Контейнер для вставки
     */
    static _showLoading(container) {
        const loading = this._cloneTemplate('actsLoadingTemplate');
        if (loading) {
            container.innerHTML = '';
            container.appendChild(loading);
        }
    }

    /**
     * Показывает пустое состояние (нет актов).
     * @private
     * @param {HTMLElement} container - Контейнер для вставки
     */
    static _showEmptyState(container) {
        const emptyState = this._cloneTemplate('actsEmptyStateTemplate');
        if (emptyState) {
            container.innerHTML = '';
            container.appendChild(emptyState);
        }
    }

    /**
     * Показывает состояние ошибки.
     * @private
     * @param {HTMLElement} container - Контейнер для вставки
     */
    static _showErrorState(container) {
        const errorState = this._cloneTemplate('actsErrorStateTemplate');
        if (errorState) {
            container.innerHTML = '';
            container.appendChild(errorState);
            const reloadBtn = container.querySelector('[data-action="reload-acts"]');
            if (reloadBtn) {
                reloadBtn.addEventListener('click', () => this.loadActs());
            }
        }
    }

    /**
     * Рендерит сетку карточек актов.
     * @private
     * @param {Array} acts - Массив данных актов
     * @param {HTMLElement} container - Контейнер для вставки
     */
    static _renderActsGrid(acts, container) {
        const grid = document.createElement('div');
        grid.className = 'acts-grid';

        acts.forEach(act => {
            const card = this._createActCard(act);
            if (card) {
                grid.appendChild(card);
            }
        });

        container.innerHTML = '';
        container.appendChild(grid);
    }

    /**
     * Создает карточку акта из template с применением статусов.
     * Статусы влияют на стилизацию рамок карточки.
     * @private
     * @param {Object} act - Данные акта
     * @returns {DocumentFragment|null} Фрагмент с карточкой или null
     */
    static _createActCard(act) {
        const cardFragment = this._cloneTemplate('actCardTemplate');
        if (!cardFragment) return null;

        const cardElement = cardFragment.querySelector('.act-card');
        if (!cardElement) return null;

        // Получаем статус акта для определения стилизации
        const status = this._getActStatus(act);
        status.classes.forEach(cls => cardElement.classList.add(cls));

        // Добавляем tooltip если есть
        if (status.tooltip) {
            cardElement.setAttribute('data-tooltip', status.tooltip);
        }

        // Подготавливаем данные для заполнения
        const data = {
            inspection_name: act.inspection_name,
            user_role: act.user_role,
            km_display: this._formatKmNumber(
                act.km_number,
                act.part_number || 1,
                act.total_parts || 1,
                act.service_note
            ),
            order_number: act.order_number,
            inspection_start_date: this._formatDate(act.inspection_start_date),
            inspection_end_date: this._formatDate(act.inspection_end_date),
            last_edited_at: this._formatDateTime(act.last_edited_at)
        };
        this._fillFields(cardFragment, data);

        // Название обрезается двумя строками (acts-manager-cards.css), полное
        // показываем по наведению
        const titleElement = cardElement.querySelector('.act-card-title');
        if (titleElement && act.inspection_name) {
            titleElement.title = act.inspection_name;
        }

        // Привязываем обработчики к кнопкам действий
        const openBtn = cardElement.querySelector('[data-action="open"]');
        const editBtn = cardElement.querySelector('[data-action="edit"]');
        const historyBtn = cardElement.querySelector('[data-action="history"]');
        const duplicateBtn = cardElement.querySelector('[data-action="duplicate"]');
        const deleteBtn = cardElement.querySelector('[data-action="delete"]');

        // Проверяем, может ли пользователь редактировать (не Участник)
        const canEdit = act.user_role !== 'Участник';

        // Скрываем кнопки редактирования и удаления для роли "Участник"
        // Примечание: кнопка "Дублировать" остаётся активной — Участник может
        // дублировать акт и станет Редактором в новом акте
        if (!canEdit) {
            if (editBtn) editBtn.hidden = true;
            if (deleteBtn) deleteBtn.hidden = true;
        }

        // Универсальный helper для безопасного клика по кнопке
        const safeClick = (handler) => (e) => {
            e.preventDefault();
            e.stopPropagation(); // 🔥 предотвращаем всплытие и двойной вызов
            handler();
        };

        if (openBtn) {
            openBtn.addEventListener('click', safeClick(() => {
                if (act.is_locked) {
                    Notifications.warning(`Акт редактируется пользователем ${act.locked_by}.`);
                    return;
                }
                this.openAct(act.id);
            }));
        }

        if (editBtn) {
            editBtn.addEventListener('click', safeClick(() => {
                if (!canEdit) {
                    Notifications.warning('Редактирование недоступно для роли "Участник"');
                    return;
                }
                if (act.is_locked) {
                    Notifications.warning(`Акт редактируется пользователем ${act.locked_by}.`);
                    return;
                }
                this.editAct(act.id, status);
            }));
        }

        // Кнопка «История» — видна только Куратору и Руководителю
        if (historyBtn && ['Куратор', 'Руководитель'].includes(act.user_role)) {
            historyBtn.style.display = '';
            historyBtn.addEventListener('click', safeClick(async () => {
                if (typeof AuditLogDialog !== 'undefined') {
                    await AuditLogDialog.show(act.id, act.inspection_name);
                }
            }));
        }

        if (duplicateBtn) {
            duplicateBtn.addEventListener('click', safeClick(() => {
                // Дублирование доступно для всех ролей, включая Участника
                // Участник станет Редактором в новом акте
                if (act.is_locked) {
                    Notifications.warning(`Акт редактируется пользователем ${act.locked_by}.`);
                    return;
                }
                this.duplicateAct(act.id, act.inspection_name);
            }));
        }

        if (deleteBtn) {
            deleteBtn.addEventListener('click', safeClick(() => {
                if (!canEdit) {
                    Notifications.warning('Удаление недоступно для роли "Участник"');
                    return;
                }
                if (act.is_locked) {
                    Notifications.warning(`Акт редактируется пользователем ${act.locked_by}.`);
                    return;
                }
                this.deleteAct(act.id, act.inspection_name);
            }));
        }

        return cardFragment;
    }

    /**
     * Открывает акт в конструкторе.
     * @param {number} actId - ID акта
     */
    static openAct(actId) {
        window.location.href = AppConfig.api.getUrl(`/constructor?act_id=${actId}`);
    }

    /**
     * Открывает диалог редактирования акта с блокировкой и автосохранением.
     * Защищен от повторных вызовов и гарантирует одиночный unlock.
     */
    static async editAct(actId, status = null) {
        if (this._editingActInProgress) {
            console.warn('[ActsManagerPage] Повторный вызов editAct проигнорирован');
            return;
        }
        this._editingActInProgress = true;

        // Признак, что diалог реально открылся и сброс _editingActInProgress
        // должен случиться внутри safeClose. Иначе finally сбросит флаг сразу.
        let dialogOpened = false;

        try {
            const username = AuthManager.getCurrentUser();
            if (!username) throw new Error('Пользователь не авторизован');

            const response = await fetch(AppConfig.api.getUrl(`/api/v1/acts/${actId}`), {
                headers: {}
            });
            if (!response.ok) throw new Error('Ошибка загрузки акта');

            const actData = await response.json();

            let lockAcquired = false;

            // В конструкторе акт уже заблокирован, поэтому
            // здесь блокируем ТОЛЬКО если открываем метаданные из списка актов (acts-manager page),
            // где window.currentActId, как правило, не задан.
            if (typeof window.currentActId === 'undefined' && typeof LockManager !== 'undefined') {
                console.log(`[ActsManagerPage] Блокируем акт ${actId} для редактирования метаданных`);
                try {
                    await LockManager.init(actId);
                    lockAcquired = true;
                    console.log(`[ActsManagerPage] Акт ${actId} успешно заблокирован`);
                } catch (err) {
                    if (err.message === 'ACT_LOCKED' || err.message === 'LOCK_FAILED') {
                        return;
                    }
                    throw err;
                }
            }

            if (!window.CreateActDialog || typeof window.CreateActDialog.showEdit !== 'function') {
                Notifications.error('Ошибка: CreateActDialog не найден');
                return;
            }

            // --- Перехватываем закрытие диалога для автосохранения и аккуратного unlock ---
            const originalClose = CreateActDialog._closeDialog.bind(CreateActDialog);

            // сохраняем ссылку, чтобы использовать корректный контекст
            const dialogClass = CreateActDialog;
            const pageClass = this;

            // Запоминаем overlay этого диалога, чтобы safeClose не перезатёр
            // _closeDialog для следующего диалога, открытого поверх (race).
            let expectedOverlay = null;

            CreateActDialog._closeDialog = async function safeClose() {
                // Race-guard: если поверх нас уже открыли другой диалог
                // (CreateActDialog._currentDialog указывает на иной overlay),
                // делегируем оригиналу без сайд-эффектов — этот editAct
                // больше не «владеет» состоянием диалога.
                if (expectedOverlay && dialogClass._currentDialog !== expectedOverlay) {
                    console.warn('[ActsManagerPage] safeClose: overlay изменился — оригинальный close без unlock');
                    CreateActDialog._closeDialog = originalClose;
                    pageClass._editingActInProgress = false;
                    originalClose();
                    return;
                }

                try {
                    if (!dialogClass._isSaving && lockAcquired) {
                        dialogClass._isSaving = true;
                        console.log('[ActsManagerPage] Выполняется автосохранение перед закрытием');

                        const form = dialogClass._currentDialog?.querySelector('#actForm');
                        if (form) {
                            try {
                                // 1️⃣ вызывем автосохранение с правильным контекстом
                                await dialogClass._handleFormSubmit(form, true, actId, username, form);
                                console.log('[ActsManagerPage] Автосохранение завершено');
                            } catch (e) {
                                console.error('Ошибка автосохранения перед закрытием:', e);
                            }
                        }
                    }

                    // 2️⃣ после сохранения снимаем блокировку
                    if (lockAcquired && typeof LockManager !== 'undefined') {
                        try {
                            await LockManager.manualUnlock();
                            console.log(`[ActsManagerPage] Акт ${actId} разблокирован (manualUnlock)`);
                        } catch (unlockErr) {
                            console.error('Ошибка ручной разблокировки:', unlockErr);
                        }
                    }
                } finally {
                    // 3️⃣ восстанавливаем оригинальное закрытие
                    CreateActDialog._closeDialog = originalClose;
                    dialogClass._isSaving = false;
                    // Защиту _editingActInProgress держим до фактического
                    // закрытия диалога — иначе второй клик «Редактировать»
                    // во время открытого диалога перерегистрирует safeClose.
                    pageClass._editingActInProgress = false;
                    console.log('[ActsManagerPage] Закрытие диалога после сохранения и unlock');
                    originalClose();
                }
            };

            CreateActDialog.showEdit(actData, status);
            expectedOverlay = dialogClass._currentDialog;
            dialogOpened = true;
        } catch (err) {
            console.error('Ошибка editAct:', err);
            Notifications.error(err.message);
        } finally {
            // Сбрасываем флаг только если diалог НЕ открылся (early-return / ошибка).
            // Если открылся — сброс делает safeClose при фактическом закрытии.
            if (!dialogOpened) {
                this._editingActInProgress = false;
            }
        }
    }

    /**
     * Дублирует акт с подтверждением.
     * @param {number} actId - ID акта для дублирования
     * @param {string} actName - Название акта для отображения
     */
    static async duplicateAct(actId, actName) {
        const confirmed = await DialogManager.show({
            title: 'Дублирование акта',
            message: `Будет создана копия акта "${actName}". Продолжить?`,
            icon: '📋',
            confirmText: 'Создать копию',
            cancelText: 'Отмена'
        });

        if (!confirmed) return;

        try {
            const username = AuthManager.getCurrentUser();

            if (!username) {
                throw new Error('Пользователь не авторизован');
            }

            const response = await fetch(AppConfig.api.getUrl(`/api/v1/acts/${actId}/duplicate`), {
                method: 'POST',
                headers: {}
            });

            if (!response.ok) {
                if (response.status === 403) {
                    throw new Error('Нет доступа к акту');
                } else if (response.status === 404) {
                    throw new Error('Акт не найден');
                }

                let error;
                try {
                    error = await response.json();
                } catch {
                    error = {};
                }
                throw new Error(error.detail || 'Ошибка дублирования акта');
            }

            const newAct = await response.json();

            Notifications.success(`Копия создана: ${newAct.inspection_name}`);

            if (typeof ActsBroadcast !== 'undefined') {
                ActsBroadcast.notify('act:duplicated', {sourceId: actId, newId: newAct.id});
            }

            const openNewAct = await DialogManager.show({
                title: 'Копия создана',
                message: 'Хотите открыть новый акт сейчас?',
                icon: '✅',
                confirmText: 'Открыть',
                cancelText: 'Остаться здесь'
            });

            if (openNewAct) {
                window.location.href = AppConfig.api.getUrl(`/constructor?act_id=${newAct.id}`);
            } else {
                // Обновляем список актов
                await this.loadActs();
            }

        } catch (error) {
            console.error('Ошибка дублирования акта:', error);
            Notifications.error(`Не удалось создать копию: ${error.message}`);
        }
    }

    /**
     * Удаляет акт с подтверждением.
     * @param {number} actId - ID акта для удаления
     * @param {string} actName - Название акта для отображения
     */
    static async deleteAct(actId, actName) {
        const confirmed = await DialogManager.show({
            title: 'Удаление акта',
            message: `Вы уверены, что хотите удалить акт "${actName}"? Это действие необратимо и удалит все данные акта.`,
            icon: '🗑️',
            confirmText: 'Удалить',
            cancelText: 'Отмена'
        });

        if (!confirmed) return;

        try {
            const username = AuthManager.getCurrentUser();

            if (!username) {
                throw new Error('Пользователь не авторизован');
            }

            const response = await fetch(AppConfig.api.getUrl(`/api/v1/acts/${actId}`), {
                method: 'DELETE',
                headers: {}
            });

            if (!response.ok) {
                if (response.status === 403) {
                    throw new Error('Нет доступа к акту');
                } else if (response.status === 404) {
                    throw new Error('Акт не найден');
                }
                throw new Error('Ошибка удаления акта');
            }

            Notifications.success('Акт успешно удален');

            if (typeof ActsBroadcast !== 'undefined') {
                ActsBroadcast.notify('act:deleted', {actId});
            }

            // Обновляем список актов
            await this.loadActs();

        } catch (error) {
            console.error('Ошибка удаления акта:', error);
            Notifications.error(`Не удалось удалить акт: ${error.message}`);
        }
    }

    /**
     * Инициализация страницы при загрузке.
     */
    static async init() {
        console.log('ActsManagerPage.init() вызван');

        // Живой источник уведомлений «acts»: акты с незакрытыми требованиями
        // (фактура/СЗ/дата/поручения) попадают в shared-колокольчик. Центр
        // создаётся в portal-common.js; источник сам тянет серверную сводку
        // (GET /acts/attention-summary) — по всем актам, не только загруженным.
        if (window.notificationCenter) {
            registerActsSource(window.notificationCenter, {
                onOpen: (actId) => this.openAct(actId),
            });
        }

        // Проверяем флаги из sessionStorage и показываем диалоги
        await this._checkSessionExit();

        // Загружаем список актов (всегда свежие данные из БД)
        this.loadActs();

        // Привязываем кнопку создания нового акта
        const createBtn = document.getElementById('createNewActBtn');
        if (createBtn) {
            createBtn.addEventListener('click', () => {
                if (window.CreateActDialog && typeof window.CreateActDialog.show === 'function') {
                    window.CreateActDialog.show();
                } else {
                    console.error('CreateActDialog не найден');
                    Notifications.error('Ошибка открытия диалога создания акта');
                }
            });
        }

        // Привязываем кнопку обновления списка
        const refreshBtn = document.getElementById('refreshActsBtn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                this.loadActs();
            });
        }

        // Cross-tab синхронизация: при удалении/дублировании/обновлении акта
        // в другой вкладке — перезагружаем список
        if (typeof ActsBroadcast !== 'undefined') {
            this._unsubscribeBroadcast = ActsBroadcast.subscribe((msg) => {
                if (!msg || typeof msg.type !== 'string') return;
                if (msg.type === 'act:deleted' || msg.type === 'act:duplicated' || msg.type === 'act:updated') {
                    this.loadActs();
                }
            });
        }
    }

    /**
     * Освобождает подписки страницы. Вызывается перед уходом со страницы.
     */
    static destroy() {
        if (typeof this._unsubscribeBroadcast === 'function') {
            this._unsubscribeBroadcast();
            this._unsubscribeBroadcast = null;
        }
    }

    /**
     * Проверяет флаги завершения сессии и показывает соответствующий диалог.
     * Флаги устанавливаются при выходе из конструктора (autoExit или exitWithSave).
     * @private
     */
    static async _checkSessionExit() {
        const notice = pickSessionExitNotice({
            lockLost: !!sessionStorage.getItem('sessionLockLost'),
            saveFailed: !!sessionStorage.getItem('sessionExitSaveFailed'),
            autoExited: !!sessionStorage.getItem('sessionAutoExited'),
            exitedWithSave: !!sessionStorage.getItem('sessionExitedWithSave'),
        });
        if (!notice) return;

        // Снимаем ВСЕ exit-флаги: показали максимум по приоритету, прочие — устаревшие.
        ['sessionLockLost', 'sessionExitSaveFailed', 'sessionAutoExited', 'sessionExitedWithSave']
            .forEach((k) => sessionStorage.removeItem(k));

        await DialogManager.alert({
            title: notice.title,
            message: notice.message,
            icon: notice.icon,
            type: notice.type,
            confirmText: notice.confirmText,
        });
    }
}

// Экспортируем в глобальную область для доступа из HTML
window.ActsManagerPage = ActsManagerPage;
