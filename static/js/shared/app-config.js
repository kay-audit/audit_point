/**
 * Конфигурация приложения
 *
 * Централизованное хранилище всех настроек и констант приложения.
 * Обеспечивает единую точку для изменения параметров поведения системы.
 */
export class AppConfig {
    /**
     * Типы узлов дерева документа
     * @type {{ITEM: string, TABLE: string, TEXTBLOCK: string, VIOLATION: string}}
     */
    /**
     * Список территориальных банков для назначения пунктам раздела 5
     * @type {Array<{abbr: string, name: string}>}
     */
    static territorialBanks = [
        { abbr: 'СибБ',  name: 'Сибирский' },
        { abbr: 'СРБ',   name: 'Среднерусский' },
        { abbr: 'СЗБ',   name: 'Северо-западный' },
        { abbr: 'ЮЗБ',   name: 'Юго-западный' },
        { abbr: 'ЦЧБ',   name: 'Центрально-черноземный' },
        { abbr: 'МБ',    name: 'Московский' },
        { abbr: 'УБ',    name: 'Уральский' },
        { abbr: 'ДВБ',   name: 'Дальневосточный' },
        { abbr: 'ПБ',    name: 'Поволжский' },
        { abbr: 'ВВБ',   name: 'Волговятский' },
        { abbr: 'ББ',    name: 'Байкальский' }
    ];

    /**
     * Канонические строковые типы узлов дерева акта.
     * Полный реестр описаний типов (idProp/dictName/defaultLabel/лимиты/
     * domIndexPrefix) — static/js/constructor/block-types.js: он использует
     * эти константы как ключи, отдельного дубля строк нет. Набор типов
     * синхронизирован ВРУЧНУЮ с бэкенд-реестром app/domains/acts/block_types.py
     * (пин — tests/js/block-types.test.mjs и tests/domains/acts/test_block_types_guard.py).
     */
    static nodeTypes = {
        ITEM: 'item',
        TABLE: 'table',
        TEXTBLOCK: 'textblock',
        VIOLATION: 'violation'
    };

    /**
     * Настройки API и URL
     */
    static api = {
        /**
         * Кеш базового URL (вычисляется один раз)
         * @private
         */
        _baseUrlCache: null,

        /**
         * Получает базовый URL приложения с учетом прокси JupyterHub
         * @returns {string}
         */
        getBaseUrl() {
            // Используем кеш если уже вычислили
            if (this._baseUrlCache !== null) {
                return this._baseUrlCache;
            }

            const origin = window.location.origin;
            const pathname = window.location.pathname;

            // Проверяем, работаем ли мы через JupyterHub прокси
            // Формат: /user/USERNAME/proxy/PORT/
            const proxyMatch = pathname.match(/^(\/user\/[^\/]+\/proxy\/\d+)/);

            if (proxyMatch) {
                // Сохраняем в кеш и возвращаем полный путь с прокси префиксом
                this._baseUrlCache = `${origin}${proxyMatch[1]}`;
                console.log('Обнаружен JupyterHub прокси, базовый URL:', this._baseUrlCache);
            } else {
                // Для локальной разработки или прямого доступа
                this._baseUrlCache = origin;
                console.log('Прямой доступ (без прокси), базовый URL:', this._baseUrlCache);
            }

            return this._baseUrlCache;
        },

        /**
         * Формирует полный URL для API эндпоинта
         * @param {string} endpoint - путь эндпоинта (например, '/api/v1/auth/me' или 'api/v1/auth/me')
         * @returns {string} - полный URL с учетом прокси
         *
         * @example
         * // Локально: 'http://localhost:8000/api/v1/auth/me'
         * // Через прокси: 'https://jupyterhub.../user/USERNAME/proxy/8000/api/v1/auth/me'
         */
        getUrl(endpoint) {
            const baseUrl = this.getBaseUrl();
            // Убираем начальный слеш если есть для корректной конкатенации
            const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
            return `${baseUrl}/${cleanEndpoint}`;
        },

        /**
         * Сбрасывает кеш базового URL (для тестирования)
         * @private
         */
        _resetCache() {
            this._baseUrlCache = null;
        }
    };

    /**
     * Константы chat-эндпоинтов
     *
     * Все пути относительные (без origin/proxy-префикса); итоговый URL
     * получается через AppConfig.api.getUrl(...), который оборачивает
     * путь под JupyterHub-proxy при необходимости.
     *
     * Параметризованные пути — функции (cid/mid/rid/fileId).
     * Статические — строки.
     */
    static chatEndpoints = {
        // CRUD бесед
        conversations: '/api/v1/chat/conversations',
        conversation: (cid) => `/api/v1/chat/conversations/${cid}`,

        // Сообщения беседы
        messages: (cid) => `/api/v1/chat/conversations/${cid}/messages`,

        // Обратная связь по сообщению ассистента (PUT — оценить, DELETE — снять).
        // id экранируем (defense-in-depth): id — серверные UUID, encode защищает
        // путь при любых неожиданных символах.
        feedback: (cid, mid) =>
            `/api/v1/chat/conversations/${encodeURIComponent(cid)}`
            + `/messages/${encodeURIComponent(mid)}/feedback`,

        // Активный forward к внешнему агенту (чтобы продолжить polling после reload)
        activeForward: (cid) =>
            `/api/v1/chat/conversations/${cid}/active-forward`,

        // Лимиты файлов (размер, типы)
        limits: '/api/v1/chat/limits',

        // Скачивание/просмотр файла чата
        file: (fileId) => `/api/v1/chat/files/${fileId}`,
    };

    /**
     * Тайминги магических setTimeout'ов из разных модулей.
     * Вынесены сюда чтобы не плодить unnamed-числа по коду; меняются в одном месте.
     *
     *  - enableTrackingAfterLoad: пауза перед re-enable Proxy-tracking после loadActContent
     *    (нужна, чтобы мутации внутри AppState.importData/PreviewManager не подняли _hasUnsavedChanges).
     *  - enableTrackingAfterGenerate / enableTrackingAfterSave: то же, но после генерации/сохранения акта.
     *  - redirectAfterUnlock: задержка перед редиректом на /acts после LockManager._initiateExit
     *    (даёт UI время показать notification «сессия завершена»).
     *  - redirectAfterDelete: задержка перед редиректом после успешного удаления акта.
     *  - showMenuRetry: задержка перед ActsMenuManager.show() при первом открытии конструктора без act_id.
     */
    static timings = {
        enableTrackingAfterLoad: 500,
        enableTrackingAfterGenerate: 100,
        enableTrackingAfterSave: 100,
        redirectAfterUnlock: 300,
        redirectAfterDelete: 1500,
        showMenuRetry: 500
    };

    static lock = {
        // Продолжительность блокировки на сервере (минуты) - фолбэк значение
        lockDurationMinutes: 30,

        // Через сколько минут бездействия показывать предупреждение - фолбэк
        inactivityTimeoutMinutes: 5,

        // Как часто проверять бездействие (секунды) - фолбэк
        inactivityCheckIntervalSeconds: 30,

        // Как часто можно продлевать блокировку (минуты) - фолбэк
        minExtensionIntervalMinutes: 5,

        // Через сколько секунд автовыхода при бездействии - фолбэк
        inactivityDialogTimeoutSeconds: 30,

        messages: {
            inactivityTitle: 'Долгое бездействие',
            inactivityQuestion: (minutes) =>
                `Вы не проявляли активность уже ${minutes} ${AppConfig.lock._pluralizeMinutes(minutes)}. Продолжить работу с актом или завершить сессию?`,

            exitConfirmTitle: 'Завершить работу с актом',
            exitConfirmQuestion: 'Сохранить изменения перед выходом?',

            sessionExtended: 'Сессия продлена',
            cannotExtend: 'Не удалось продлить сессию',
            changesSaved: 'Изменения сохранены',
            changesNotSaved: 'Не удалось сохранить изменения',
            exitRedirect: 'Сессия завершена. Переадресация...',

            actLockedByUser: (username) =>
                `Акт сейчас редактируется пользователем ${username}. Попробуйте открыть его позже.`,

            lockFailed: 'Не удалось заблокировать акт для редактирования. Попробуйте позже.'
        },

        _pluralizeMinutes: (n) => {
            if (n % 10 === 1 && n % 100 !== 11) return 'минуту';
            if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) return 'минуты';
            return 'минут';
        }
    };

    /**
     * Настройки предпросмотра документа
     */
    static preview = {
        // Максимальная длина текста по умолчанию для обрезки
        defaultTrimLength: 30,

        // Максимальный уровень вложенности заголовков (h1-h4)
        maxHeadingLevel: 4,

        // Настройки обрезки текста для разных типов контента
        trimLengths: {
            // Базовое значение (используется если не указано специфичное)
            default: 30,

            // Критичные короткие поля (Нарушено, Установлено и т.д.)
            short: 15,

            // Расширенные поля (Кейсы, свободный текст)
            extended: 50
        }
    };

    /**
     * Настройки навигации
     * TODO: Добавить настройки навигации при работе с модулем
     */
    static navigation = {
        // Здесь будут настройки навигации
    };

    /**
     * Настройки меню форматов
     * TODO: Добавить настройки меню форматов при работе с модулем
     */
    static formatMenu = {
        // Здесь будут настройки меню форматов
    };

    /**
     * Настройки диалоговых окон
     */
    static dialog = {
        // Анимация
        closeDelay: 200
    };

    /**
     * Настройки уведомлений
     */
    static notifications = {
        // H-N8-UX: глобальный cap одновременно показываемых уведомлений.
        // При шторме РАЗНЫХ сообщений (cacheKey не совпадает → дедуп не срабатывает)
        // самый старый вытесняется по FIFO. Иначе DOM забивается на сотни узлов.
        maxConcurrent: 15,

        // Длительности показа уведомлений (мс)
        duration: {
            error: 7000,
            warning: 6000,
            info: 4000,
            success: 4000,
            longSuccess: 6000
        },

        // Анимация
        animation: {
            // Длительность анимации скрытия
            hidingDuration: 250,
            // Длительность анимации счетчика
            counterScaleDuration: 150
        },

        // Группировка повторяющихся уведомлений
        grouping: {
            // Статус активности
            enabled: true,
            // Дополнительное время за каждое повторение (мс)
            extensionPerRepeat: 500
        },

        // Иконки для типов уведомлений
        icons: {
            success: '✓',
            error: '✗',
            info: 'ℹ',
            warning: '⚠'
        },
    };

    /**
     * Настройки системы помощи
     */
    static help = {
        // ID контейнеров с инструкциями
        contentIds: {
            1: 'help-step-1-content',
            2: 'help-step-2-content'
        },

        // Названия шагов для подсказок
        stepNames: {
            1: 'Составление структуры акта',
            2: 'Заполнение данных'
        },

        // Заголовки инструкций
        titles: {
            1: 'Инструкция: Шаг 1 - Составление структуры акта',
            2: 'Инструкция: Шаг 2 - Заполнение данных'
        }
    };

    /**
     * Настройки дерева документа
     */
    static tree = {
        // Ограничения структуры
        maxDepth: 4,

        // Стандартные разделы
        defaultSections: [
            {id: '1', label: 'Информация о процессе, клиентском пути'},
            {id: '2', label: 'Оценка качества проверенного процесса / сценария процесса / потока работ'},
            {id: '3', label: 'Примененные технологии'},
            {id: '4', label: 'Основные выводы'},
            {id: '5', label: 'Результаты проверки'}
        ],

        // Опциональный пункт «Process Mining» (добавляется по требованию,
        // по умолчанию в дереве отсутствует). Название фиксировано.
        processMiningSection: {
            id: '6',
            special: 'process_mining',
            label: 'Оценка процесса по результатам исследования методом Process Mining'
        },

        // Префиксы для автогенерации названий
        labels: {
            newItem: 'Новый пункт',
            table: 'Таблица',
            textBlock: 'Текстовый блок',
            violation: 'Нарушение'
        },

        // Иконки типов узлов
        icons: {
            table: {
                className: 'table-icon',
                emoji: '📊'
            },
            textblock: {
                className: 'textblock-icon',
                emoji: '📝'
            },
            violation: {
                className: 'violation-icon',
                emoji: '⚠️'
            }
        },

        // Настройки взаимодействия
        interaction: {
            // Задержка для определения двойного клика (мс)
            doubleClickDelay: 300,

            // Классы элементов, игнорируемые при обработке кликов
            ignoredClickClasses: [
                'toggle-icon',
                'table-icon',
                'textblock-icon',
                'violation-icon',
                'tb-badge'
            ],

            // Иконки раскрытия/сворачивания
            toggleIcons: {
                expanded: '▼',
                collapsed: '▶'
            }
        },

        // Настройки прокрутки при Ctrl+Click
        scrollSettings: {
            // Отступ от верха шапки (px)
            headerOffset: 20,

            // Поведение прокрутки
            behavior: 'smooth',

            // Задержка перед прокруткой после перехода на шаг 2 (мс)
            transitionDelay: 300
        },

        // Сообщения валидации
        validation: {
            maxDepthExceeded: (depth) => `Достигнута максимальная вложенность (${depth} уровней: ${'.'.repeat(depth - 1)}*)`,
            cannotMoveToFirstLevel: 'Нельзя переносить пункты на верхний уровень',
            cannotAddFirstLevelSibling: 'На верхнем уровне можно добавить только пункт Process Mining',
            cannotMoveToSelf: 'Нельзя переместить узел в самого себя',
            cannotMoveProtected: 'Нельзя перемещать защищенный элемент',
            cannotMoveToDescendant: 'Нельзя переместить узел внутрь своего потомка',
            nodeNotFound: 'Узел не найден',
            parentNotFound: 'Родительский узел не найден'
        }
    };

    /**
     * Настройки контента
     */
    static content = {
        // Лимиты элементов на узел
        limits: {
            tablesPerNode: 10,
            textBlocksPerNode: 10,
            violationsPerNode: 10
        },

        // Значения по умолчанию
        defaults: {
            // Таблицы
            tableRows: 3,
            tableCols: 3,
            columnWidth: 100
            // Текстовые блоки: форматирование целиком в inline-HTML content
            // (директива владельца, EXP-2). Базовый размер — из /acts/limits
            // (limits.textblock.fontSizeDefault), контейнерных дефолтов нет.
        },

        // Сообщения об ошибках
        errors: {
            cannotAddToTable: (type) => `Нельзя добавить ${type} к таблице`,
            cannotAddToTextBlock: (type) => `Нельзя добавить ${type} к текстовому блоку`,
            cannotAddToViolation: (type) => `Нельзя добавить ${type} к нарушению`,
            limitReached: (type, limit) => `Достигнуто максимальное количество ${type} (${limit}) для этого пункта`,
            // §5.10b: лимит блоков — не «на пункт», а внутри ОДНОГО ПОЛЯ
            // нарушения, поэтому отдельная фраза, а не limitReached.
            // №14: единственная точка формирования этого текста — используется
            // и здесь (paste/undo-гейт validation-tree.js), и кнопкой/приёмом
            // картинок (violation-image-validator.js), и вставкой блоков
            // (violation-blocks.js). Синхронизировано ВРУЧНУЮ с бэкендом
            // (act_content.py: ViolationFieldSchema.validate_blocks_count) —
            // текст должен совпадать дословно (прецедент синхронизации —
            // names.py ↔ chat-client-actions.js).
            contentItemsLimitReached: (limit) =>
                `Достигнут лимит блоков в поле нарушения (${limit}).`,
            protectedFromDeletion: 'Эта таблица защищена от удаления',
            notFound: (type) => `${type} не найден`
        },

        // Названия типов контента для сообщений
        typeNames: {
            [AppConfig.nodeTypes?.TABLE || 'table']: 'таблицу',
            [AppConfig.nodeTypes?.TEXTBLOCK || 'textblock']: 'текстовый блок',
            [AppConfig.nodeTypes?.VIOLATION || 'violation']: 'нарушение'
        },

        // Названия для лимитов (множественное число)
        limitNames: {
            [AppConfig.nodeTypes?.TABLE || 'table']: 'таблиц',
            [AppConfig.nodeTypes?.TEXTBLOCK || 'textblock']: 'текстовых блоков',
            [AppConfig.nodeTypes?.VIOLATION || 'violation']: 'нарушений'
        },

        // Предустановленные таблицы
        tablePresets: {
            qualityAssessment: {
                rows: 2,
                cols: 4,
                headers: [
                    'Процесс',
                    'Количество проверенных экземпляров области проверки процесса, шт',
                    'Общее количество отклонений, шт',
                    'Уровень отклонений, %'
                ],
                colWidths: [150, 200, 150, 100]
            },

            dataTools: {
                rows: 2,
                cols: 4,
                headers: ['Решаемая задача', 'Методы/технологии', 'Среда/инструменты', 'Tag'],
                label: 'Инструменты обработки данных'
            },

            dataSources: {
                rows: 2,
                cols: 4,
                headers: ['Автоматизированная система', 'Источник', 'База данных', 'Tag'],
                label: 'Источники данных'
            },

            repositories: {
                rows: 2,
                cols: 6,
                headers: [
                    'Процесс',
                    'Ссылка на репозиторий, отвечающий за данный процесс',
                    'Ссылка на описание релизов',
                    'Ссылка на описание бизнес требований и постановку задач',
                    'Контактное лицо по вопросам к коду',
                    'Комментарий к коду'
                ],
                label: 'Репозитории по процессу'
            },

            metrics: {
                headers: {
                    row1: [
                        {content: 'Код метрики', colspan: 1, rowspan: 2},
                        {content: 'Наименование метрики', colspan: 1, rowspan: 2},
                        {content: 'Количество клиентов / элементов, ед.', colspan: 2, rowspan: 1},
                        {content: 'Сумма, руб.', colspan: 1, rowspan: 2},
                        {content: 'Код БП', colspan: 1, rowspan: 2},
                        {content: 'Пункт / подпункт акта', colspan: 1, rowspan: 2}
                    ],
                    row2: [
                        {content: 'ФЛ', colspan: 1, rowspan: 1},
                        {content: 'ЮЛ', colspan: 1, rowspan: 1}
                    ]
                },
                colWidths: [80, 200, 100, 100, 120, 80, 120],
                rows: 2
            },

            regularRisk: {
                headers: [
                    'Код процесса (номер-название)',
                    'Клиентский путь (номер-название)',
                    'Наименование нормативно-правового акта (НПА), который был нарушен',
                    'Статья/пункт НПА',
                    'Пункт, статья, название нормативного документа (КоАП/ФЗ и пр.), в соответствии с которыми к Банку могут быть применены санкции, с указанием суммы штрафа (min/max) согласно формулировок нормативного документа',
                    'Нефинансовые последствия/санкция к должностному лицу'
                ],
                colWidths: [150, 150, 200, 120, 250, 180],
                rows: 2,
                label: 'Выявленные инциденты регуляторного риска'
            },

            operationalRisk: {
                headers: {
                    row1: [
                        {content: 'ОР', colspan: 1, rowspan: 1},
                        {content: 'Отклонения с признаками операционного риска (далее - ОР)', colspan: 5, rowspan: 1}
                    ],
                    row2: [
                        {content: 'Код процесса', colspan: 1, rowspan: 1},
                        {content: 'Блок - владелец процесса', colspan: 1, rowspan: 1},
                        {content: 'Тип рискового события (уровень 2)', colspan: 1, rowspan: 1},
                        {content: 'Оценка суммы события, руб', colspan: 1, rowspan: 1},
                        {content: 'Подтип и сумма последствия', colspan: 2, rowspan: 1}
                    ]
                },
                colWidths: [120, 150, 180, 150, 150, 150],
                rows: 2,
                label: 'Выявленные отклонения с признаками операционного риска'
            },

            taxRisk: {
                headers: {
                    row1: [
                        {content: 'Выявлены налоговые риски', colspan: 6, rowspan: 1}
                    ],
                    row2: [
                        {content: 'Код процесса (номер-название)', colspan: 1, rowspan: 1},
                        {content: 'Клиентский путь (номер-название)', colspan: 1, rowspan: 1},
                        {content: 'Наименование нормативно-правового акта (НПА), который был нарушен', colspan: 1, rowspan: 1},
                        {content: 'Статья/пункт НПА', colspan: 1, rowspan: 1},
                        {content: 'Налоговые последствия', colspan: 1, rowspan: 1},
                        {content: 'Сумма последствий, руб.', colspan: 1, rowspan: 1}
                    ]
                },
                colWidths: [140, 160, 260, 120, 220, 120],
                rows: 2,
                label: 'Выявленные инциденты налогового риска'
            },

            otherRisk: {
                // Headers/colWidths наследуются от metrics preset через _createOtherRiskTable
                // в state-content.js. Здесь только label, чтобы у узла было осмысленное имя.
                label: 'Прочие риски'
            }
        },

        // Диалоги
        dialogs: {
            deleteMetricsTable: {
                title: 'Удаление таблицы метрик',
                message: 'При перемещении этого пункта таблица метрик будет удалена. Продолжить?',
                icon: '⚠️',
                confirmText: 'Да, переместить',
                cancelText: 'Отмена'
            }
        }
    };

    /**
     * Синхронный ФОЛБЭК структурных лимитов до ответа GET /acts/limits.
     *
     * Источник истины в рантайме — настройки ACTS__TABLES__* /
     * ACTS__TEXTBLOCKS__* (отдаются /limits, читаются через
     * getStructureLimits() в violation-image-validator.js). Эти числа —
     * зеркало дефолтов настроек (= фолбэк-констант схемы
     * app/domains/acts/schemas/act_content.py); действуют, пока ответ сервера
     * не пришёл. Контракт фронт↔бэк закреплён стражами:
     * tests/js/table-cells-limits.test.mjs и tests/test_act_content_roundtrip.py
     * — при изменении дефолтов менять синхронно.
     */
    static limits = {
        table: {
            // Максимум строк grid (бэк: TableSchema.grid max_length=64)
            maxRows: 64,

            // Максимум колонок grid (бэк: validate_grid_dimensions ≤ 16)
            maxCols: 16,

            // Минимальная ширина колонки при интерактивном ресайзе, px
            // (table-sizes.js переводит в проценты от ширины таблицы)
            minColWidthPx: 80
        },

        textblock: {
            // Границы размера шрифта span'ов (бэк: ACTS__TEXTBLOCKS__FONT_SIZE_*)
            fontSizeMin: 8,
            fontSizeMax: 72,
            // Базовый (экранный) размер текстблока в px — база редактора/превью,
            // экспорт конвертирует ×0.75 (16px → 12pt, EXP-2).
            fontSizeDefault: 16
        }
    };

    /**
     * Настройки таблиц
     * TODO: Добавить настройки таблиц при работе с модулем
     */
    static table = {
        // Здесь будут настройки таблиц
    };

    /**
     * Настройки текстовых блоков
     * TODO: Добавить настройки текстовых блоков при работе с модулем
     */
    static textBlock = {
        // Здесь будут настройки текстовых блоков
    };

    /**
     * Настройки нарушений
     * TODO: Добавить настройки нарушений при работе с модулем
     */
    static violation = {
        // Здесь будут настройки нарушений
    };

    /**
     * Настройки контекстного меню
     * TODO: Добавить настройки контекстного меню при работе с модулем
     */
    static contextMenu = {
        // Здесь будут настройки контекстного меню
    };

    /**
     * Настройки горячих клавиш
     */
    static hotkeys = {
        save: {
            key: 'KeyS',
            ctrlOrMeta: true
        }
    };

    /**
     * Настройки режима только для чтения
     * Активируется для пользователей с ролью "Участник"
     */
    static readOnlyMode = {
        // Флаг активности режима только чтения
        isReadOnly: false,

        // Роль пользователя в команде акта
        userRole: null,

        // Сообщения для UI
        messages: {
            viewOnlyBanner: 'Режим просмотра. Редактирование недоступно для роли "Участник".',
            cannotEdit: 'Редактирование недоступно в режиме просмотра',
            cannotSave: 'Сохранение недоступно в режиме просмотра',
            cannotDelete: 'Удаление недоступно в режиме просмотра',
            cannotDuplicate: 'Дублирование недоступно в режиме просмотра',
            cannotAddContent: 'Добавление контента недоступно в режиме просмотра',
            cannotModifyTree: 'Изменение структуры недоступно в режиме просмотра'
        }
    };

    /**
     * Настройки локального хранилища
     */
    static localStorage = {
        // Префикс ключа снимка-черновика акта; полный ключ — per-act:
        // `${stateKeyPrefix}:{actId}` (снимки разных актов не затирают друг друга)
        stateKeyPrefix: 'audit_workstation_state',

        // Дебаунс для автосохранения (мс). ФОЛБЭК: на старте StorageManager
        // переопределяет его значением с бэка (autoSavePeriodSeconds из
        // /config/lock). Держать синхронным с ACTS__AUTOSAVE__PERIOD_SECONDS
        // (AutosaveSettings.period_seconds, дефолт 3 сек) — это число работает,
        // только если конфиг не подгрузился (offline/деградация).
        autoSaveDebounce: 3000,

        // Интервал периодического автосохранения (мс) - каждые 2 минуты
        periodicSaveInterval: 120000,

        // Максимальный размер данных в localStorage (байты)
        // Учитываем, что лимит обычно 5-10MB, ставим консервативный лимит
        maxStorageSize: 4 * 1024 * 1024, // 4MB
    };
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.AppConfig = AppConfig;
