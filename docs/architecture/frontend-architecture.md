# Архитектура фронтенда Audit Workstation

> Единый документ по всему фронту проекта (зоны `shared/`, `portal/`, `constructor/`). Чат описан отдельно — см. главу 14 и [`docs/architecture/chat-frontend-architecture.md`](chat-frontend-architecture.md).
>
> Источник истины — код в `static/js/`, `static/css/`, `templates/`. Все ссылки `file:line` сверены grep'ом на момент написания. При расхождении документа и кода — источник истины код.

## Оглавление

1. [Обзор](#1-обзор)
2. [ES-модули и entry-файлы](#2-es-модули-и-entry-файлы)
3. [`AppConfig` и сборка URL](#3-appconfig-и-сборка-url)
4. [`AppState` и состояние конструктора](#4-appstate-и-состояние-конструктора)
5. [`StorageManager` и persistence](#5-storagemanager-и-persistence)
6. [`LockManager` и inactivity](#6-lockmanager-и-inactivity)
7. [Tree, items, per-node render API](#7-tree-items-per-node-render-api)
8. [`PreviewManager`](#8-previewmanager)
9. [Диалоги](#9-диалоги)
10. [Acts manager и кросс-доменная навигация](#10-acts-manager-и-кросс-доменная-навигация)
11. [Безопасность и санитизация](#11-безопасность-и-санитизация)
12. [Accessibility и i18n](#12-accessibility-и-i18n)
13. [CSS-архитектура](#13-css-архитектура)
14. [Чат](#14-чат)

---

## 1. Обзор

Audit Workstation — Server-side rendered (Jinja2) + vanilla JS приложение **без бандлера и без npm-зависимостей**. Фронт использует **Native ES Modules** (`import`/`export`): браузер сам резолвит граф зависимостей через `<script type="module">`; Node.js на проде не нужен — статика отдаётся как есть. Модули дополнительно публикуют свои синглтоны в `window` (`window.X = X`) — для совместимости с inline-скриптами в шаблонах, которые ссылаются на bare-names (в inline `<script>` без `type="module"` bare-name резолвится через `window`; без этого `AuthManager.requireAuth()` упадёт `ReferenceError`).

### 1.1 Цифры (на момент аудита)

| Параметр | Значение |
|---|---|
| Всего JS-файлов | 183 (`static/js/**/*.js`) |
| `constructor/` (редактор актов) | 106 файлов (включая `search/` и инфраструктуру поверхностей, §1.2) |
| `shared/` (cross-zone модули + чат) | 42 файла (включая 13 модулей чата) |
| `portal/` (sidebar-страницы) | 32 файла (включая профиль/карточку пользователя и `sqlagent/`) |
| `entries/` | 2 (`portal-common.js`, `constructor.js`) |
| Вне зон | 1 (`static/js/auth.js` — страница входа) |
| Всего CSS-файлов | 97 |
| `constructor/` CSS | 45 файлов (включая `layout/density.css`, §13.5) |
| `portal/` CSS | 20 файлов (включая `layout/density.css`, §13.5) |
| `shared/` CSS | 17 файлов |
| `base/` CSS | 11 файлов |
| CSS-переменных | 581 (уникальных имён, дублей нет), `base/variables.css` — агрегатор, сами переменные в `base/variables/{colors,components,typography,spacing,shadows,motion,z-index}.css` |

### 1.2 Три зоны

```
static/js/
├── auth.js      # Standalone classic-script страницы входа (/auth/login).
│                #   Вне ESM-зон: OTP-форма, прямые fetch к /api/v1/auth/* (§3.2)
│
├── shared/      # Cross-zone: AppConfig, APIClient, AuthManager,
│   │            #   Notifications, SafeHTML, ErrorBoundary, DialogBase/Manager,
│   │            #   FilterEngine, makeDraggablePanel, makeResizablePanel
│   ├── dialog/  # DialogBase + DialogManager (confirm/alert)
│   ├── ck/      # CkForm, CkProcessPicker — реюзаемые компоненты ЦК-страниц
│   ├── datatable/            # Тулкит таблиц (DataTable, DataSource, ColumnVisibility,
│   │                         #   TableViewState, сортировка/фильтры/пагинация) — база ЦК
│   ├── notifications-center/ # Колокольчик уведомлений
│   └── chat/    # 13 модулей чата — реестр в docs/architecture/chat-frontend-architecture.md
│
├── portal/      # Sidebar-страницы: landing, acts-manager, admin, ck-fin-res,
│   │            #   ck-client-exp, sqlagent, профиль/карточка пользователя
│   ├── acts-manager/   # ActsManagerPage, CreateActDialog, AuditLogDialog,
│   │                   #   VersionPreviewOverlay, DiffEngine/Renderer, ActsBroadcast
│   ├── admin/          # AdminPage (roles/diagnostics/audit-log)
│   ├── ck-fin-res/     # ЦК «финансовые результаты»
│   ├── ck-client-exp/  # ЦК «клиентский опыт»
│   ├── sqlagent/       # Встроенный iframe SQL-агента + баннер «недоступен»
│   └── landing/        # + profile-page.js, user-avatar.js, user-card*.js в корне portal/
│
└── constructor/ # Редактор актов (`/constructor?act_id=...`)
    ├── state/        # AppState (state-core + state-tree + state-content),
    │                 #   MetricsRiskCoordinator
    ├── tree/         # TreeManager, TreeRenderer, TreeDragDrop, TreeUtils
    ├── items/        # ItemsRenderer (per-node DOM updates),
    │                 #   ItemsTitleEditing
    ├── table/        # TableManager + cells-operations + sizes
    ├── textblock/    # TextBlockManager + editor + formatting + toolbar
    │                 #   + links-footnotes + capsule-integrity
    │                 #   + инфраструктура поверхностей (editable-surface,
    │                 #   editor-registry/SURFACE_POLICY, editor-controller) —
    │                 #   deep-dive: docs/architecture/textblock-editor-architecture.md
    ├── search/       # FindBar (Ctrl+F) + ActSearchEngine/Highlight/Replace —
    │                 #   поиск/замена по текстблокам и rich-полям нарушений,
    │                 #   deep-dive §12 в textblock-editor-architecture.md
    ├── violation/    # ViolationManager (21 файл, включая
    │                 #   violation-field-surface.js — ViolationBlockSurface,
    │                 #   violation-blocks.js — контейнер блоков поля,
    │                 #   violation-table-block.js — редактор встроенной таблицы)
    ├── preview/      # PreviewManager + per-type renderer'ы
    ├── dialog/       # HelpManager, InvoiceDialog
    ├── context-menu/ # 5 файлов (tree, cells, violation, links-footnotes, core)
    ├── header/       # Топбар: acts-menu, settings-menu, preview-menu,
    │                 #   format-menu-manager, header-exit, chat-popup
    ├── validation/   # 5 модулей (act/tree/table/core/result)
    └── services/     # id-generator (audit_point_id)
```

CSS повторяет тройное разделение — см. главу 13.

### 1.3 Backend-routes

| URL | Обработчик | Шаблон | Что грузится |
|---|---|---|---|
| `/` | `app/routes/portal.py:25` | `landing/landing.html` (extends `base_portal.html`) | inline-чат |
| `/acts` | `app/domains/acts/routes/portal.py:15` | `acts-manager/acts_manager.html` | список актов |
| `/admin` | `app/domains/admin/routes/portal.py:15` | `admin/admin.html` | 3 таба |
| `/ck-fin-res`, `/ck-client-experience` | `app/domains/ck_*/routes/portal.py:15` | `ck/ck_*.html` (extends `_ck_layout.html`) | редактор записей ЦК |
| `/sqlagent` | `app/domains/sqlagent/routes/portal.py:57` | `portal/sqlagent/*.html` | iframe родного UI SQL-агента либо баннер «недоступен» |
| `/profile` | `app/auth/portal_router.py:39` | `portal/profile.html` | карточка пользователя |
| `/auth/login` | `app/auth/portal_router.py:21` | `auth/login.html` | форма входа по OTP (`static/js/auth.js`, вне ESM-зон) |
| `/error/{code}` | `app/routes/errors.py:23` | страница ошибки | — |
| `/constructor?act_id={int}` | `app/domains/acts/routes/constructor.py:27` | `constructor/constructor.html` (extends `base_constructor.html`) | редактор актов |

`/constructor` принимает обязательный `act_id: int` — обработчик в `app/domains/acts/routes/constructor.py` редиректит на `/acts` при невалидном значении.

Домен ЦК «клиентский опыт» — единственное место, где имя домена (`ck_client_exp`) и URL (`/ck-client-experience`) не совпадают по написанию.

### 1.4 Связанные документы

- [`docs/architecture/chat-frontend-architecture.md`](chat-frontend-architecture.md) — чат-фронт (13 модулей, транспорт polling по шине `chat_agent_messages_bus`).
- [`docs/architecture/textblock-editor-architecture.md`](textblock-editor-architecture.md) — редактор текстблоков: капсулы ссылок/сносок, caret-guard, целостность капсул, DOCX-экспорт.
- [`docs/guides/architecture-and-backend.md`](../guides/architecture-and-backend.md) §4 — высокоуровневый обзор фронта.
- [`docs/architecture/data-model-acts.md`](data-model-acts.md) — модель данных акта, жизненный цикл, lock и версионирование.
- [`docs/architecture/agent-channel-sequence.md`](agent-channel-sequence.md) — sequence-диаграммы forward'а к внешнему агенту.
- [`docs/architecture/cross-domain-contracts.md`](cross-domain-contracts.md) — контракты между бэк-доменами.
- `tests/playwright/` — Playwright e2e smoke-тесты (открытие акта, drag-and-drop, ctrl+s, focus-trap диалогов и т.п.).

---

## 2. ES-модули и entry-файлы

### 2.1 Архитектура модулей

Фронт использует **Native ES Modules** без bundler'а. Каждый JS-файл — ESM-модуль с `import`/`export`. Браузер сам резолвит граф зависимостей через `<script type="module">`. Node.js на проде не нужен — статика отдаётся как есть.

**Контракт коммуникации:**

1. Top-level декларации файла помечены `export`: `export class AuthManager`, `export const AppState = {...}`, `export const treeManager = new TreeManager(...)`.
2. Потребители импортят явно: `import { AuthManager } from '../shared/auth.js';`.
3. Зависимости резолвятся автоматически — порядок `<script>`-тегов в шаблоне load-bearing **только** для entry-модуля (один тег на зону) и vendor-DOMPurify (классический script, который должен встать раньше ESM-входа).
4. Каждый ESM-модуль дополнительно публикует свой singleton на `window` (`window.AuthManager = AuthManager`) — для совместимости с inline-скриптами в шаблонах, которые ссылаются на bare-names. Без этого `AuthManager.requireAuth()` в inline `<script>` не работал бы (в classic-script bare-name резолвится через `window`).

### 2.2 Entry-модули

Два entry-файла на зону:

- **`static/js/entries/portal-common.js`** — импортит `shared/` (app-config, auth, api, notifications, error-boundary, escape-stack, sanitize, dialog-base, dialog-confirm), `portal/portal-sidebar`, `portal/portal-settings`, `shared/notifications-center/notification-center.js` (инициализируется на `DOMContentLoaded`) и **12** чат-модулей (13-й, chat-feedback, подтягивается через граф chat-messages.js, не напрямую в entry). Подключается в `templates/portal/base_portal.html` одним тегом.

- **`static/js/entries/constructor.js`** — импортит весь конструктор (state, tree, items, table, preview, textblock, violation, validation, lock-manager, header) + общие `shared/` + диалоги + чат + portal-cross-zone (team-member-search, dialog-create-act, acts-broadcast). Подключается в `templates/constructor/base_constructor.html`.

Каждая page-template добавляет минимальный inline `<script type="module">` с импортом нужных страничных классов (`LandingPage`, `ActsManagerPage`, `AdminPage`, `CkFinResPage`, `CkClientExpPage`) и вызовом `init()` на `DOMContentLoaded`.

**Vendor DOMPurify** грузится отдельным классическим `<script src="...purify.min.js">` ДО entry-модуля — он публикует `window.DOMPurify`, который потом использует `shared/sanitize.js`. Это единственный sync-script в шаблонах.

### 2.3 Реестр публичных имён

Каждый файл экспортирует один singleton + публикует его как `window.<Name>`. Имена соответствуют классам (PascalCase) или инстансам (camelCase).

**`shared/` (доступны во всех зонах):**

| Файл | Экспорт | Тип |
|---|---|---|
| `shared/app-config.js` | `AppConfig` | static class |
| `shared/auth.js` | `AuthManager` | static class |
| `shared/api.js` | `APIClient`, `LockLostError` | static class + Error subclass |
| `shared/notifications.js` | `NotificationManager`, `Notifications` (instance) | class + singleton-instance |
| `shared/sanitize.js` | `SafeHTML` | object literal |
| `shared/error-boundary.js` | `ErrorBoundary` | static class |
| `shared/escape-stack.js` | `EscapeStack` | static class |
| `shared/filter-engine.js` | `FilterEngine` | static class |
| `shared/dialog/dialog-base.js` | `DialogBase` | static class |
| `shared/dialog/dialog-confirm.js` | `DialogManager` | static class |
| `shared/ck/{ck-form,ck-process-picker}.js` | `Ck*` | static classes |
| `shared/datatable/*` (8 файлов) | `DataTable`, `DataSource`, `ColumnVisibility`, `TableViewState`, `buildColumns`, `filterRows`, `sortRowsMulti`, `paginate`, … | классы + pure-функции |
| `shared/resizable-panel.js` | `makeResizablePanel` | функция-фабрика |
| `shared/draggable-panel.js` | `makeDraggablePanel` | функция-фабрика (поповер корректора, find-bar) |
| `shared/format-units.js` | `formatMb`, `formatFileSize` | утилиты форматирования |
| `shared/notifications-center/notification-center.js` | `NotificationCenter` | class |
| `shared/api-errors.js` | `formatValidationDetail` | функция (window-публикация с guard для node:test) |
| `shared/html-text.js` | `plainToRichHtml` | функция (plain → rich-HTML: escape + `\n`→`<br>`; формализатор/корректор) |
| `shared/rich-text.js` | `serializeVisibleText` | функция (rich-HTML → видимый plain-текст с переносами) |
| `shared/editable-target.js` | `isEditableTarget` | предикат «фокус в редактируемом поле» (input/textarea/select/contenteditable; чекбоксы-кнопки — нет); общий для ESC-слоёв, clipboard и undo |

**`shared/chat/`** — 13 модулей (ChatEventBus, ChatRenderer, ClientActionsRegistry, ChatStream, ChatHistory, ChatUI, ChatFiles, ChatTitle, ChatContext, ChatMessages, ChatManager, ChatModalManager, ChatFeedback). Полный реестр — [`docs/architecture/chat-frontend-architecture.md`](chat-frontend-architecture.md).

**`constructor/` (дополнительно):**

| Файл | Экспорт |
|---|---|
| `constructor/navigation-manager.js` | `NavigationManager` (step-кнопки + save+export pipeline; ловит `LockLostError`) |

**`portal/`:**

| Файл | Экспорт |
|---|---|
| `portal/portal-sidebar.js` | `PortalSidebar` |
| `portal/portal-settings.js` | `LandingSettingsManager` |
| `portal/landing/landing-page.js` | `LandingPage` |
| `portal/acts-manager/*` | `ActsManagerPage`, `CreateActDialog`, `AuditLogDialog`, `VersionPreviewOverlay`, `DiffEngine`, `DiffRenderer`, `ActsBroadcast`, `TeamMemberSearch`, `AppendixNumberDropdown` |
| `portal/admin/*` | `AdminPage`, `AdminRoles`, `AdminAddUserDialog`, `AdminDiagnostics`, `AdminAuditLog`, `AdminSearch` |
| `portal/ck-fin-res/*`, `portal/ck-client-exp/*` | `Ck*Page`, `Ck*Config` |

**`constructor/`:**

| Файл | Экспорт |
|---|---|
| `constructor/app.js` | `App` |
| `constructor/state/state-core.js` | `AppState` (с методами, расширенными в `state-tree.js`/`state-content.js` через `Object.assign`) |
| `constructor/state/metrics-risk-coordinator.js` | `MetricsRiskCoordinator` |
| `constructor/tree/tree-core.js` | `TreeManager`, `treeManager` (instance) |
| `constructor/tree/tree-utils.js` | `TreeUtils` |
| `constructor/table/table-core.js` | `TableManager`, `tableManager` |
| `constructor/textblock/textblock-core.js` | `TextBlockManager`, `textBlockManager` (расширяется через `Object.assign` из `textblock-{formatting,editor,toolbar,links-footnotes,capsule-integrity}.js` — deep-dive: [`textblock-editor-architecture.md`](textblock-editor-architecture.md)); + standalone-предикаты `isCapsuleNode`/`isZeroWidthNode` (единый источник истины для капсул, используются `constructor/search/act-search-engine.js`) |
| `constructor/textblock/editor-registry.js` | `EditorRegistry` (активная поверхность), `SURFACE_POLICY` (политика возможностей по kind; deep-dive §15 в `textblock-editor-architecture.md`) |
| `constructor/textblock/editable-surface.js` | `TextBlockSurface` (контракт `EditableSurface`) |
| `constructor/textblock/editor-controller.js` | `EditorController` (mount/unmount поверхности, capsule-lifecycle, drop) |
| `constructor/violation/violation-field-surface.js` | `ViolationBlockSurface` (единая поверхность text-блоков и image-caption всех 10 полей), `_createRichFieldEditor` (rich-поля нарушений) |
| `constructor/search/find-bar.js` | `FindBar` (немодальная панель поиска/замены; `installHotkey()` — `Ctrl+F`, зовётся в bootstrap после `App.init`, по образцу `NodeClipboard.installHotkey()`) |
| `constructor/search/act-search-engine.js` | `ActSearchEngine`, `TextBlockSearchTarget`, `FootnoteBodySearchTarget`, `ViolationFieldSearchTarget` (движок поиска/замены по текстблокам и rich-полям нарушений, без UI) |
| `constructor/search/act-search-highlight.js` | `ActSearchHighlight` (подсветка через CSS Custom Highlight API) |
| `constructor/search/act-search-replace.js` | `ActSearchReplace` (чистые хелперы форматирования/снимков для replace-all) |
| `constructor/violation/violation-init.js` | `violationManager` (instance, инстанциируется при загрузке модуля) |
| `constructor/items/items-renderer.js` | `ItemsRenderer` |
| `constructor/preview/preview.js` | `PreviewManager` |
| `constructor/lock-manager.js` | `LockManager` |
| `constructor/inactivity-watchdog.js` | `InactivityWatchdog` (instance-класс; слежение за бездействием, вынесено из `LockManager`) |
| `constructor/clipboard/node-clipboard.js` | `NodeClipboard` (copy-paste узлов между актами; `installHotkey`/`installMenuItems` зовутся в bootstrap после `App.init`) |
| `constructor/storage-manager.js` | `StorageManager` |
| `constructor/changelog-tracker.js` | `ChangelogTracker` |
| `constructor/lifecycle-helper.js` | `LifecycleHelper` |
| `constructor/dialog/dialog-help.js` | `HelpManager` (extends DialogBase) |
| `constructor/dialog/dialog-invoice.js` | `InvoiceDialog` |
| `constructor/header/{acts,settings,preview,chat,format,header}-*.js` | `ActsMenuManager`, `SettingsMenuManager`, `previewMenuManager`, `ChatPopupManager`, `FormatMenuManager`, `HeaderExit` |

### 2.4 Side-effect-модули

Некоторые файлы не экспортируют ничего — они существуют ради побочного эффекта (мутации внешнего state):

- **`constructor/state/state-tree.js`** и **`state-content.js`** делают `Object.assign(AppState, {...})`, добавляя методы к синглтону из `state-core.js`. Entry-модуль импортит их явно после `state-core.js` — иначе их module-level код не выполнится.
- **`constructor/violation/violation-init.js`** инстанцирует `ViolationManager` и вызывает `initialize()`. Должен импортиться entry-модулем после всех violation-helpers.
- **Inline-скрипт в `base_constructor.html`** инициализирует `window.actMetadata = null` и `window.__authReady` — promise готовности авторизации. Init-обработчики (`acts-menu.js`) `await window.__authReady` перед первым `AuthManager.getCurrentUser()`.

### 2.5 Strict-mode под ESM

`<script type="module">` принудительно включает strict mode. Reserved-words нельзя использовать как имена биндингов:

- `protected`, `private`, `public`, `implements`, `interface`, `package` — не могут быть параметрами функций или именами `let`/`const`/`var`. Если такое имя нужно как ключ объекта (например, `{ protected: true }`), это OK — только биндинг запрещён.
- `arguments` и `eval` не могут быть переприсвоены.
- Объявление функции внутри блока (`if (...) { function foo(){} }`) разрешено, но scope другой.

При добавлении нового кода под ESM учитывай эти правила.

---

## 3. `AppConfig` и сборка URL

### 3.1 Зачем нужен AppConfig

Single source of truth для констант, тайминговых магических чисел и URL-builder'а. Декларации:

| Секция | Что в ней |
|---|---|
| `AppConfig.api` | `getBaseUrl()`, `getUrl(endpoint)` — единственная точка построения абсолютного URL из относительного пути |
| `AppConfig.chatEndpoints` | URL-шаблоны всех чат-эндпоинтов (`/api/v1/chat/conversations/...`) |
| `AppConfig.timings` | Магические `setTimeout`-задержки (`redirectAfterUnlock=300`, `enableTrackingAfterLoad=500` и т.п.) |
| `AppConfig.lock` | fallback-конфиг блокировок и сообщения для inactivity-диалога |
| `AppConfig.preview` | `defaultTrimLength=30`, `trimLengths={default, short, extended}` |
| `AppConfig.notifications` | `maxConcurrent=15`, длительности, иконки |
| `AppConfig.tree` | `maxDepth=4`, `defaultSections`, presets icons, validation messages |
| `AppConfig.content` | Лимиты (`tablesPerNode=10` и т.д.), table presets (metrics/regularRisk/operationalRisk/taxRisk/otherRisk/qualityAssessment/dataTools/...) |
| `AppConfig.localStorage` | `stateKeyPrefix` (снимок-черновик per-act: `audit_workstation_state:{actId}`), `autoSaveDebounce=3000`, `periodicSaveInterval=120000`, `maxStorageSize=4MB` |
| `AppConfig.readOnlyMode` | Флаги read-only сессии для роли «Участник» + сообщения |
| `AppConfig.hotkeys` | `save = {key:'KeyS', ctrlOrMeta:true}` |

`app-config.js:158-165` — все load-bearing тайминги в одном месте; меняются здесь, не в callsite'ах.

### 3.2 `AppConfig.api.getUrl()` — единая точка

```js
getBaseUrl() {                        // app-config.js:59
    if (this._baseUrlCache !== null) return this._baseUrlCache;
    const origin = window.location.origin;
    const pathname = window.location.pathname;
    const proxyMatch = pathname.match(/^(\/user\/[^\/]+\/proxy\/\d+)/);
    this._baseUrlCache = proxyMatch ? `${origin}${proxyMatch[1]}` : origin;
    return this._baseUrlCache;
}

getUrl(endpoint) {                    // app-config.js:94
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
    return `${this.getBaseUrl()}/${cleanEndpoint}`;
}
```
(`shared/app-config.js:47-107`)

Ветка `proxyMatch` — унаследованное распознавание path-префикса вида
`/user/{name}/proxy/{port}`. На текущем деплое (доступ по IP:порту, `root_path`
приложение не выставляет — `grep -rn "root_path" app/` пусто) она не
срабатывает, и `getBaseUrl()` просто возвращает `origin`. Оставлена как
недорогая страховка; трогать её незачем, инвариант ниже от неё не зависит.

**Регрессионный инвариант:** все `fetch('/api/v1/...')` и навигационные `window.location.href = '/...'` внутри ESM-зон (`shared/`, `portal/`, `constructor/`) обязаны идти через `AppConfig.api.getUrl()`. Смысл — одна точка, где относительный путь становится абсолютным: смена схемы размещения приложения правится в одном методе, а не в десятках callsite'ов. `getBaseUrl()` кэширует результат в `_baseUrlCache`; сброс для тестов — `_resetCache()` (`:105`).

Текущий статус: `Grep "AppConfig.api.getUrl"` → **115 совпадений в 29 файлах**.

**Единственное исключение — `static/js/auth.js`** (страница `/auth/login`): standalone classic-script, не ESM-модуль, `AppConfig` там не загружен, поэтому три вызова OTP-эндпоинтов идут прямыми относительными путями (`auth.js:34, 68, 103`). Регрессионный греп по коду формулируется с исключением этого файла:

```bash
grep -rn "fetch(\s*['\"\`]/api" static/js/shared static/js/portal static/js/constructor
# ожидается пусто
```

### 3.3 `chatEndpoints`

`app-config.js:120-...` — реестр URL для чата (`conversations`, `conversation(cid)`, `messages(cid)`, `feedback(cid, mid)`, `activeForward(cid)`, `limits`, `file(fileId)`). Параметризованные — функции (`messages(cid)`), статические — строки. Полные URL получаются комбинацией: `AppConfig.api.getUrl(AppConfig.chatEndpoints.messages(cid))`. Магические строки `/api/v1/chat/...` в callsite'ах — рефакторинг-запах.

### 3.4 `timings`

```js
static timings = {
    enableTrackingAfterLoad: 500,       // пауза перед re-enable Proxy после loadActContent
    enableTrackingAfterGenerate: 100,
    enableTrackingAfterSave: 100,
    redirectAfterUnlock: 300,           // setTimeout перед window.location.href = /acts
    redirectAfterDelete: 1500,
    showMenuRetry: 500
};
```

Эти числа — компромиссы UX (notification успевает мелькнуть) vs тесты (не зависают). Менять только с пониманием контекста.

---

## 4. `AppState` и состояние конструктора

### 4.1 Декларация и расширение через `Object.assign`

`AppState` объявлен как **object literal** в `constructor/state/state-core.js:14`. Поля:

| Поле | Тип | Trackable? |
|---|---|---|
| `treeData` | `{id:'root', children: Node[]}` | ✅ |
| `tables` | `{[tableId]: TableData}` | ✅ |
| `textBlocks` | `{[blockId]: TextBlockData}` | ✅ |
| `violations` | `{[violationId]: ViolationData}` | ✅ |
| `currentStep` | `1` или `2` | ✅ |
| `selectedNode` | текущий выбранный узел | ✅ |
| `selectedCells` | выделенные ячейки таблицы | ✅ |
| `_dragInProgress` | bool | ❌ (координационный флаг, не trackable) |

Методы CRUD добавлены через `Object.assign`:

- `state-tree.js:23` — `generateNumbering`, `addNode`, `deleteNode`, `moveNode`, `setNodeTb`, `setNodeInvoice`, и др.
- `state-content.js:27` — `addTableToNode`, `addTextBlockToNode`, `addViolationToNode`, `_updateMetricsTablesAfterRiskTableCreated`, и др.

Порядок загрузки `state-core → state-tree → state-content` обязателен (см. §2.4).

### 4.2 Deep-tracking через Proxy

`state-core.js:740-907` — модуль рекурсивно оборачивает `trackedProperties` (`:856`) в `Proxy`, чтобы любая мутация (включая `AppState.tables[id].cells[r][c] = ...` или `node.children.push(...)`) триггерила `StorageManager.markAsUnsaved()`.

Реализация — функция `_wrapDeep(value)` (`state-core.js:791-836`): trap'ы `get` (lazy-wrap на первом обращении), `set` (вызывает `_notifyDirty` при реальной смене значения), `deleteProperty` (`:816`). Кэш через `_stateProxyCache: WeakMap` для стабильности ссылок.

**Гарантии:**

- `_isTrackable` (`:769`) исключает `Node`, `Date`, `RegExp`, `Map`, `Set`, `WeakMap`, `WeakSet` — у них собственная семантика.
- `_stateProxyCache: WeakMap` (`:747`) обеспечивает стабильность ссылок (повторный `get` той же ветки возвращает тот же proxy).
- `_stateProxyOriginals: WeakSet` (`:748`) ловит повторную обёртку proxy → proxy.
- `_stateProxyTargets: WeakMap` (`:756`) — обратный маппинг proxy → target; даёт `_unwrap(value)` (`:843`) за O(1). Нужен горячим read-путям (индекс узлов, нумерация, сериализация) и set-трапу: в target кладётся только «сырой» объект. `_serializeTree` вызывается именно от `_unwrap(this.treeData)` (`:562`).

### 4.3 Bootstrap-race

`_initStateTracking` (`state-core.js:897`) **экспортируется, но на module-level не вызывается**: `shared/api.js` импортирует `state-core.js`, и через `portal-common.js` цепочка доходит до portal-страниц, где Proxy-обёртка `AppState` не нужна и не работает (комментарий — `state-core.js:908-910`). Вызов делает entry конструктора: `entries/constructor.js:161` — `setTimeout(_initStateTracking, 0)` сразу после `App.init()` (`:160`). Нулевой таймаут ставит обёртку в очередь после всех module-level `Object.assign(AppState, ...)`. Гарантия: к моменту обёртки `AppState` уже содержит все методы.

Но bootstrap-структура дерева (создание дефолтных секций 1–5 в `app.js`) выполняется до загрузки данных акта и тоже триггерит `markAsUnsaved`. Поэтому `App.init()` **первым делом** вызывает `StorageManager.disableTracking()` (`app.js:74`); tracking повторно включается после `loadActContent` + `markAsSyncedWithDB()` с задержкой `AppConfig.timings.enableTrackingAfterLoad=500ms`.

### 4.4 Pinned tables (metrics/risk)

В дереве конструктора некоторые таблицы **закреплены** вверху children-массива:

Подвид таблицы — единое enum-поле `node.kind` (`table-kind.js`, 7 значений), а не набор boolean-флагов `is*Table` (убраны в kind-рефакторе):

- Metrics-таблицы: `kind='metrics'` (метрики пункта `5.X`), `kind='mainMetrics'` (сводная раздела 5).
- Risk-таблицы: `kind ∈ {'regularRisk', 'operationalRisk', 'taxRisk', 'otherRisk'}`.
- `kind='regular'` (или отсутствие поля) — обычная таблица, не закреплена.

API:

| Метод | Где | Что делает |
|---|---|---|
| `TreeUtils.isPinnedTable(node)` | `tree/tree-utils.js:355` | Делегирует `table-kind.js`: `node.type==='table' && node.kind !== 'regular'` |
| `AppState._getFirstNonPinnedIndex(parent)` | `state/state-tree.js:821` | Возвращает индекс первого нон-pinned ребёнка (точка вставки) |
| `TreeUtils.findRiskTables(node, {firstOnly})` | `tree/tree-utils.js:372` | Единая утилита; учитывает **все 4 риск-подвида** (`regularRisk`/`operationalRisk`/`taxRisk`/`otherRisk`) через `table-kind.js::isRiskTable` — все полноправные риски (формируют/удерживают сводные, блокируются от перемещения за §5) |

**Защита от drag:** `tree-drag-drop.js:114-118` — при `dragstart` если `_hasRiskTablesInSubtree(node) && !isUnderSection5(node)` → `e.preventDefault()` + Notification. Drop **перед** pinned заблокирован (`_calculateDropPosition`, `tree-drag-drop.js:244`).

### 4.5 Protected nodes (секции 1–5)

Создаются через `_createProtectedSection(id, label)` (`state-core.js:76`) с `protected:true, deletable:false`.

| Барьер | Где |
|---|---|
| API-страховка удаления | `state-tree.js:251` — `deleteNode` ловит `(node.protected && node.deletable !== true) \|\| node.deletable === false`. Явный `deletable: true` **перебивает** `protected` (кейс риск-таблиц: перемещение и правка структуры по-прежнему заблокированы, удаление разрешено) |
| Каскад-исключение | `_deleteNodeUnchecked` (`state-tree.js:282`) пропускает проверку для каскадного удаления |
| Move-валидация | `_validateMove` (`state-tree.js:507`) |
| CSS-класс | `tree-renderer.js:394-395` — `li.classList.add('protected')` |

### 4.6 MetricsRiskCoordinator

`state/metrics-risk-coordinator.js:41-225` — фасад над каскадной логикой metrics ↔ risk. Принципиально:

1. Полная экстракция reconcile-логики из `state-content.js` / `state-tree.js` / `context-menu-tree.js` / `tree-drag-drop.js` признана **слишком рискованной без e2e-покрытия** — известный технический долг. Coordinator — единая точка входа в каскад, но реализация делегирована методам `AppState`.
2. **Snapshot/rollback safety**: каждый хук обёрнут в `_withSnapshot(name, fn)` (`:165`), который делает shallow JSON-копию §5 и `AppState.tables`, ловит исключение и откатывает.

Публичные хуки:

| Метод | Где | Когда вызывается |
|---|---|---|
| `onRiskTableAdded(nodeId)` | `:186` | Добавлена risk-таблица — создаёт metrics на 5.X (если risk на 5.X.Y+) и main metrics в §5 |
| `onRiskTableRemovedWithDeletion(deleteFn)` | `:204` | Удаление риск-узла под единым snapshot'ом: snapshot §5 снимается ДО `deleteFn()`, поэтому откат при сбое reconcile восстанавливает и сам риск-узел (D1) |
| `onSubtreeMoved(draggedNode, oldAncestor5x)` | `:218` | Поддерево перемещено внутри §5 — пересчитывает metrics для старого и нового предка 5.X |

Все callsite'ы каскада (`state-tree.deleteNode`, `state-tree.moveNode`, context-menu, drag-drop) обязаны идти через coordinator — раньше часть кода звала `AppState._...AfterRiskTableDeleted` напрямую, что порождало partial-state при exception'е.

---

## 5. `StorageManager` и persistence

`constructor/storage-manager.js` (1235 строк) — менеджер двухуровневого хранилища: localStorage (быстро, локально) + БД через `APIClient.saveActContent` (медленно, надёжно).

### 5.1 State machine

```
'saved'      ─── markAsUnsaved() ──▶ 'unsaved'
   ▲                                      │
   │                                      │ _debouncedSave (3s) или
   │                                 periodic save (120s)
   │                                      ▼
markAsSyncedWithDB()  ◀──── PUT /content ──── 'local-only'
   │                          (success)         (LS-only, БД ещё не синхронизирована)
   │                                      ▲
   │                                      │
   └─────────────────────────── _markAsSaved() (из saveState)
```

Единое поле `_state ∈ {'saved'|'local-only'|'unsaved'}` (`storage-manager.js:65`). Зеркала `_hasUnsavedChanges` и `_isSyncedWithDB` (`:73, :81`) сохраняются только для backward-совместимости со старыми консьюмерами (beforeunload-warning, `hasUnsavedChanges()`); единая точка перехода — `_setState(newState)` (`:560-570`).

UI:

| Состояние | Цвет индикатора (`_updateSaveIndicator`) |
|---|---|
| `saved` | белый (всё синхронизировано) |
| `local-only` | жёлтый (есть в LS, ещё не в БД) |
| `unsaved` | красный (есть мутации, ещё даже не в LS) |

### 5.2 Debounce и периодические сохранения

| Таймер | Период | Что делает |
|---|---|---|
| `_saveTimeout` | `AppConfig.localStorage.autoSaveDebounce = 3000ms` | `saveState(true)` — пишет в LS |
| `_periodicSaveInterval` | `AppConfig.localStorage.periodicSaveInterval = 120000ms` | `saveState(true)` если `_hasUnsavedChanges` |
| `_periodicDbSaveInterval` | 120s | `APIClient.saveActContent(window.currentActId, {saveType:'periodic'})` |

Оба периодических таймера пропускают тик при `AppState._dragInProgress` — иначе во время DnD получим лишнюю запись с промежуточным состоянием.

Ручное сохранение — через `NavigationManager` (не через LS): **Ctrl+S** → `saveToDatabase()` → `APIClient.saveActContent(..,{saveType:'manual'})` (прямой PUT в БД, только если есть что синхронизировать; в read-only — no-op). **Ctrl+Shift+S** / клик по кнопке-индикатору → `saveAndExport()` (то же + генерация и скачивание выбранных в настройках форматов).

> **Гарантированный декремент `_trackingDepth`.** Операции, отключающие deep-tracking на время работы (`saveActContent`, `generateAct`, `loadActContent`), включают его обратно в `finally`/отложенном таймере. Если страница уничтожается до re-enable, `destroy()` принудительно сбрасывает `_trackingDepth=0`. Без этого счётчик «утекал» вверх → `markAsUnsaved()` уходил в no-op, и при переоткрытии конструктора без полной перезагрузки страницы правки молча не помечались грязными (тихая потеря данных).

### 5.3 Navigation interception

`_setupNavigationInterception()` (`storage-manager.js:418`) защищает от навигации с несохранёнными изменениями двумя слоями:

1. **`popstate`-страж** — `history.replaceState({_lockNavGuard:true}, ...)` плюс `history.pushState`. Перехватывает «Назад» в браузере и предлагает диалог сохранения.
2. **Click-handler на `<a href>` с внутренним hostname** — захватывает клик до навигации, показывает диалог.

`confirmNavigation(targetUrl, opts)` (`:1177`) — публичный API: показать диалог «Сохранить и уйти / уйти без сохранения / отменить», вернуть Promise<bool>. Используется в `LockManager._lockAct` (на 409 и на 5xx: `lock-manager.js:220, 241`), `acts-menu.js` (при switch'е акта).

`allowUnload()` (`:1022`) — снимает `_lockNavGuard`, разрешая `window.location.href = ...` без диалога. Вызывается в `LockManager._initiateExit` (`lock-manager.js:603-604`) — сессия завершается принудительно, диалог здесь блокировал бы автоэкзит.

### 5.4 ChangelogTracker

`constructor/changelog-tracker.js` (189 строк) — гранулярный аудит-лог локальных операций. Операции:

| Источник | Операции |
|---|---|
| `state-tree.js` | `add_node`, `delete_node`, `move_node`, `tb_change`, `invoice_set`, `invoice_remove` |
| `state-content.js` | `add_table` |

Persistence: `localStorage['act_changelog_{actId}']` (`:29`), MAX 500 entries (`MAX_ENTRIES`, `:12`; обрезка — `:57-58`).

**`flush()`** (`:101`) — собирает все pending записи, возвращает массив. Перед сбором прогоняет зарегистрированные pre-flush хуки (`:16-18`) — они позволяют синтезировать записи и **не** сбрасываются в `destroy()`. Вызывается в `LockManager._initiateExit` (`lock-manager.js:627-628`) и прикрепляется к телу `PUT /content` (`data.changelog = changelog`) — серверная аудит-запись синхронна с фактическим сохранением, без отдельного запроса.

**`destroy()`** (`:168`) — полный сброс при switch'е акта (`acts-menu.js` делает `destroy() → init(actId)`).

### 5.5 LifecycleHelper

`constructor/lifecycle-helper.js` (58 строк) — единый реестр `beforeunload`-обработчиков (`Map<name, handler>`). Без него каждый менеджер вешал бы свой listener на `window.addEventListener('beforeunload', ...)`, что усложняет снятие.

API: `registerBeforeUnload(name, handler)`, `unregister(name)`, `list()`. Использует `lock-manager.js` (имя `'lock:manual-unlock'`) и `storage-manager.js` (имя `'storage:warn-unsaved'`).

---

## 6. `LockManager` и inactivity

`constructor/lock-manager.js` (706 строк) — клиентская часть оптимистичного блока актов. Слежение за бездействием вынесено в `InactivityWatchdog` (`constructor/inactivity-watchdog.js`), `LockManager` использует его композицией (§6.1). На бэке блокировка — ключ Redis `lock:act:{act_id}` с TTL, не поля `acts` (см. §10 в [`data-model-acts.md`](data-model-acts.md)). На фронте:

| Цикл | Что делает |
|---|---|
| **Init** | `_loadConfig` → `_lockAct` (POST /lock) → activity-tracker → heartbeat → beforeunload → visibilitychange |
| **Heartbeat** | Каждые `inactivityCheckIntervalSeconds` секунд (`setInterval` в `_startAutoExtension`), если активность была — `_extendLockSafely` (POST /extend-lock) |
| **Inactivity** | При превышении `inactivityTimeoutMinutes` минут без активности — диалог «Продолжить?» с countdown'ом; нет ответа → autoExit |
| **Exit** | `_initiateExit(action)` — save + unlock + redirect `/acts` |

### 6.1 Состояние

`lock-manager.js:20-41`. Все поля **static** (LockManager используется как singleton-class):

| Поле | Назначение |
|---|---|
| `_actId` | Текущий заблокированный акт |
| `_config` | Полученный с бэка `{lockDurationMinutes, inactivityTimeoutMinutes, inactivityCheckIntervalSeconds, minExtensionIntervalMinutes, inactivityDialogTimeoutSeconds}` |
| `_extensionInterval`, `_countdownInterval` | Таймеры |
| `_lastExtensionAt` | timestamp последнего продления |
| `_watchdog` | Экземпляр `InactivityWatchdog` (`constructor/inactivity-watchdog.js`): activity-листенеры (`mousedown`/`keydown`/`scroll`/`touchstart`), idle-таймер, visibilitychange; `destroy()` делегирует `watchdog.stop()` |
| `_isExiting`, `_exitPromise` | Идемпотентность `_initiateExit` |
| `_manualUnlockTriggered` | Блокирует sendBeacon |
| `_beforeUnloadHandler` | Bound-handler для корректного `removeEventListener` |
| `_inactivityDialogDeadline` | `Date.now() + timeoutSeconds*1000`, null если диалог не показан |
| `_inactivityDialogClose` | Программный close активного inactivity-диалога |

### 6.2 Lock (POST /lock)

`_lockAct()` (`lock-manager.js:185`):

- 409: показать диалог с username владельца — envelope `ActLockError` `{detail, code: 'act-locked', extra: {locked_by, locked_until}}` из `api.js`; fallback на regex по `error.detail` для старых non-AppError ответов (`lock-manager.js:200-206`).
- После диалога — `confirmNavigation('/acts')` если StorageManager доступен, иначе жёсткий редирект (`lock-manager.js:219-224`).
- 5xx → диалог «Ошибка блокировки», редирект (`:240-245`).

### 6.3 Heartbeat с retry

`_extendLock` (`lock-manager.js:277`) делит ответы на два класса: 4xx — лок потерян, сразу выход; 5xx/network — transient, можно ретраить.

`_extendLockSafely` (`:314`) копит подряд-неудачи (`_extendConsecutiveFailures`, `:33`) до `_MAX_EXTEND_FAILURES=3` (`:267`); при достижении — `_initiateExit('extensionFailed')` (`:353`). Транзиентный сетевой сбой не выкидывает пользователя сразу — retry на следующем тике.

### 6.4 Inactivity-диалог с Date.now-countdown

`_handleInactivity(minutesInactive)` (`lock-manager.js:493-580`):

1. **Capture actId**: `const capturedActId = this._actId;` ДО `await dialogPromise`. Закрывает кейс «switch актов во время открытого диалога inactivity».
2. **Deadline по Date.now**: `const deadline = Date.now() + timeoutSeconds * 1000`. `setInterval(250ms)` обновляет UI countdown'а, решение об exit принимается по `Date.now() >= deadline` — устойчиво к Chrome background throttling (`setTimeout/setInterval` в фоне throttle'ятся до ~раза в минуту, decrement-counter разъезжается с реальностью).
3. **Orphan-protection**: после `await dialogPromise` проверяется `this._actId !== capturedActId || this._isExiting` — если за время ожидания состояние изменилось, ветка extend/exit не выполняется (`:557`).
4. **Программный close**: handler `close` сохраняется в `_inactivityDialogClose` (через `onMount`, `:514`), чтобы `_closeInactivityDialog()` (`:471`) мог программно закрыть overlay при autoExit'е — иначе диалог «висит» поверх редиректа.

### 6.5 visibilitychange

`_handleVisibilityChange()` (`lock-manager.js:435`) реагирует на возврат вкладки из фона:

- **Случай A**: диалог открыт и `Date.now() >= _inactivityDialogDeadline` → немедленный `_closeInactivityDialog()` + `_initiateExit('autoExit')`.
- **Случай B**: диалога нет, но `idleMs >= inactivityTimeoutMinutes*60*1000` → сразу autoExit без промежуточного диалога. Лок мог уже истечь сам по TTL (`lockDurationMinutes`, ключ Redis без отдельного снятия); спрашивать «остаться?» бессмысленно — extend упадёт 4xx → fatal → exit.

Никаких HTTP-запросов в visibility-handler'е не делается; решение принимается локально по `Date.now()`.

### 6.6 beforeunload и beacon-unlock

`_setupBeforeUnload()` (`lock-manager.js:364`):

- Регистрируется через `LifecycleHelper.registerBeforeUnload('lock:manual-unlock', ...)`.
- Игнорирует beacon при `_isExiting || _manualUnlockTriggered || !_actId` (избегаем дубликата с `_initiateExit`).
- `navigator.sendBeacon(unlockUrl, blob)` — гарантирует доставку даже при закрытии вкладки.
- В `finally` всегда вызывает `destroy()` — снимает 4 listener'а на document плюс активные интервалы (иначе при back-button оставались).

### 6.7 Идемпотентный exit с fallback

`_initiateExit(action)` (`lock-manager.js:590-706`) — единственная точка выхода из сессии. Сигнатура и ключевой инвариант:

```js
static async _initiateExit(action) {
    if (this._isExiting) return this._exitPromise;  // идемпотентность
    this._isExiting = true;
    this._closeInactivityDialog();  // ДО destroy, иначе handle обнулится
    // далее: destroy → allowUnload → save (+changelog flush) → unlock → жёсткий редирект
    // детали — см. lock-manager.js:590-706
}
```

Что важно помнить:

- **Идемпотентность**: повторный вызов отдаёт тот же promise.
- **Fallback на `window.currentActId`**: страхует, если `_actId` уже сброшен после `destroy()`.
- **Save идёт с `ChangelogTracker.flush()`** — одной транзакцией на сервере (`:627-628`).
- **Редирект жёсткий, без `confirmNavigation`** — сессия закрывается принудительно (пояснение в коде — `:691-695`). Если save упал (409 при чужом локе), `confirmNavigation` показал бы «Несохранённые изменения. Уйти?» и заблокировал бы выход. `allowUnload()` снимает страж явно (`:603-604`).
- **`messageFlag`**: `'sessionAutoExited'` или `'sessionExitedWithSave'` пишется в sessionStorage; `acts-manager-page.js` показывает toast на следующей загрузке. Отдельный флаг `'sessionLockLost'` (см. §6.8) — для случая, когда лок снят и save вернул 409: плашка честно сообщает, что изменения НЕ в БД (только в локальном черновике), приоритет выбора `pickSessionExitNotice` — lockLost > autoExited > exitedWithSave.

### 6.8 NavigationManager и LockLostError

`constructor/navigation-manager.js` — навигация по шагам (клик по индикатору шага) + `saveAndExport` (сохранить в БД + сгенерировать и скачать выбранные в настройках форматы; вызывается кликом по кнопке-индикатору в шапке и Ctrl+Shift+S). `saveAndExport` и быстрый `saveToDatabase` (Ctrl+S) через `_handleSaveExportError` ловят `LockLostError` из `APIClient.saveActContent` (409 → custom Error subclass из `shared/api.js`) → ставят **`sessionStorage['sessionLockLost']`** (НЕ `sessionAutoExited`: save вернул 409, изменения в БД не записаны — плашка autoExit'а врала бы «сохранено») и делает жёсткий редирект на `/acts`. Локальный черновик при этом НЕ чистится (`allowUnload()` лишь снимает beforeunload-страж). Honest-плашку выбирает чистый `pickSessionExitNotice` (`portal/acts-manager/session-exit-notice.js`).

**Восстановление черновика на повторном входе:** загрузка акта — `APIClient.loadActContent` = `_fetchActContent` (сеть) + `_applyActContent` (применение); при автозагрузке в конструкторе (`acts-menu.js::_autoLoadAct`) между ними захватывается лок, чтобы условный prompt восстановления показывался уже после захвата (§3.4 — когда известно, занят ли акт). Prompt восстановления локального черновика (`_maybeRestoreDraft`) показывается **только** если акт с момента снимка никто не менял (серверный `updated_at` совпадает с базой снимка); иначе устаревший снимок молча удаляется, контент из БД перезаписывает черновик через `saveState(true)`. В сценарии потери лока (см. выше) honest-редирект уходит на `/acts` без перезагрузки акта — правки физически остаются в `localStorage`, но в этот момент не применяются; honest-плашка сообщает именно это.

`beforeunload` и `confirmNavigation` — у `StorageManager`, не у NavigationManager.

---

## 7. Tree, items, per-node render API

### 7.1 Зоны

| Зона | Узлы DOM | Менеджер | Renderer |
|---|---|---|---|
| Дерево (шаг 1) | `#tree > ul > li[data-node-id]` | `treeManager: TreeManager` | `TreeRenderer` |
| Items (шаг 2) | `#itemsContainer > .item-block[data-node-id]` | `static class ItemsRenderer` | себя |
| Таблицы | `.table-section[data-table-id]` (внутри items) | `tableManager: TableManager` | себя |
| Preview | `#preview` | `static class PreviewManager` | preview-table-renderer + preview-textblock-renderer + preview-violation-renderer |

### 7.2 TreeManager

`constructor/tree/tree-core.js:606` — `export const treeManager = new TreeManager('tree')` (top-level const, не `window`). Координирует `TreeRenderer`, `TreeDragDrop`, `TreeContextMenu`.

`TreeRenderer` (`tree/tree-renderer.js`):

- `render(node = AppState.treeData)` (`:65`) — полный rebuild контейнера `#tree`. Тяжёлая операция; вызывается из точек в §7.5.
- **Точечные публичные API** (заменяют полный `render()`), подписки на шину — `:45-56`:
  - `updateInvoiceBadge(node)` (`tree-renderer.js:765`) — subscriber `node:invoice-changed`. Снимает старый бейдж, ставит новый.
  - `updateTbBadge(node)` (`:904`) — обновляет узел и всех родителей под §5 (computed TB вверх по дереву).

### 7.3 TreeUtils (object literal)

`tree/tree-utils.js:12` — `export const TreeUtils = {...}`. Не класс, не singleton-instance — **plain object**. Ключевые функции:

| Метод | Назначение |
|---|---|
| `findNodeById(id, node?)` | Поиск узла, default root = `AppState.treeData` |
| `findParentNode(id)` | Родитель узла |
| `isUnderSection5(node)` | Проверка попадания узла под §5 (через путь номеров) |
| `_isInformationalNode(node)` (`:271`) | Content-узел (`table`/`textblock`/`violation`) — не может быть родителем |
| `isTbLeaf(node)` (`:328`) | Узел может иметь чекбокс TB |
| `isPinnedTable(node)` (`:355`) | Делегирует `table-kind.js`: `kind !== 'regular'` |
| `findRiskTables(node, {firstOnly})` (`:372`) | Единая утилита; учитывает **все 4 риск-подвида** (включая `otherRisk`) через `table-kind.js::isRiskTable` |

### 7.4 ItemsRenderer и `_domIndex`

`items/items-renderer.js` (793 строки). Static class, не имеет singleton-instance.

**`_domIndex: Map<string, HTMLElement>`** (`items-renderer.js:32`) — индекс адресуемых DOM-узлов, ключи вида `item:${nodeId}`, `table:${tableId}` и т.п. Заполняется в `_createItemContainer/renderTable`, очищается в начале `renderAll()` (`:46`) и при удалении узлов.

Per-node API (вместо полного `renderAll()`, `:39`):

| Метод | Когда вызывать | Fallback |
|---|---|---|
| `updateItem(nodeId)` (`:73`) | После структурных изменений в пределах одного узла (add/delete child, move) | `renderAll()` если узел не в `_domIndex` или `AppState` |
| `updateTable(tableId)` (`:113`) | Только пересоздать table-section, сохраняя размеры колонок | `renderAll()` |
| `updateTextBlock(blockId)` | Пересоздать textblock | `renderAll()` |
| `updateViolation(violationId)` | Пересоздать violation-карточку | `renderAll()` |
| `updateNodeTitle(nodeId)` | Только заголовок узла | — |

Также:

- `_updateTbBadgeInItems(badge, node)` (`:539`) — апдейт чекбокса TB в шаге 2.
- `_updateParentTbInItems(node)` (`:560`) — каскад вверх.
- Обратной синхронизации DOM → AppState нет: ввод в ячейку таблицы пишется в состояние сразу (write-through, `table/cell-write-through.js`), текстблоки и rich-поля нарушений — через debounce/blur-коммит своей поверхности (`EditorController`/`finalizeEdit`, deep-dive §15 в `textblock-editor-architecture.md`).

### 7.5 `renderAll` — оставшиеся call-sites

Полный `treeManager.render()` (тяжёлый rebuild всего `#tree`) остался в **двух** точках:

| Точка | Контекст |
|---|---|
| `app.js:143` | Bootstrap при `App.init()` |
| `context-menu/context-menu-tree.js:603` | `updateTreeViews(scopeNodeId)` — fallback для каскадных операций (без `scopeNodeId`) |

Inline-редактирование заголовков (`items/items-title-editing.js:120, 174`) полный render **больше не зовёт** — там точечное обновление подписи в дереве.

Полный `ItemsRenderer.renderAll()` (`items-renderer.js:39`, `#itemsContainer`):

| Точка | Контекст |
|---|---|
| `app.js:312` | Bootstrap шага 2 |
| `context-menu/context-menu-tree.js:610` | Каскадный fallback |
| `tree/tree-drag-drop.js:393` | После DnD, если не удалось определить старого/нового родителя |
| `items-renderer.js:74, 81, 114, 127, 131, 145, 152, 158, …` | Внутренний fallback per-node методов, когда узла нет в `_domIndex`/`AppState` |

Прочее (`updateXxx`-методы внутри `items-renderer.js`, `tableManager.renderAll` в `table-core.js`/`context-menu-cells.js`) — локальные rebuilds, не полные.

### 7.6 Event-driven моменты

Конструктор почти не использует CustomEvent через `dispatchEvent`:

- `header/preview-menu.js:266, 287` — `preview-menu:opened` / `preview-menu:closed`. **Потребителей в конструкторе нет.**

Основная event-шина — `window.ChatEventBus` (опубликован модулем чата в `shared/`). Конструктор использует её **как общий event bus** — явно прокомментировано в `state-tree.js:956-957`:

**Эмиттеры:**

| File:Line | Событие | Контекст |
|---|---|---|
| `state/state-tree.js:958` | `node:tb-changed` | `AppState.setNodeTb(nodeId, abbr, checked)` |
| `state/state-tree.js:997` | `node:invoice-changed` | `AppState.setNodeInvoice(nodeId, invoiceData, opts)` |

Оба через `window.ChatEventBus?.emit?.(...)` (optional chaining — emit срабатывает даже если чат не загружен).

**Подписчики:**

| File:Line | Событие | Действие |
|---|---|---|
| `tree/tree-renderer.js:45-49` | `node:invoice-changed` | `this.updateInvoiceBadge(node)` |
| `tree/tree-renderer.js:52-56` | `node:tb-changed` | `this.updateTbBadge(node)` — обновляет бейдж текущего узла + всех родителей под §5 |
| `items/items-renderer.js:786-789` (module-level) | `node:tb-changed` | `ItemsRenderer._updateTbBadgeInItems` + `_updateParentTbInItems` — обновляет селектор ТБ на шаге 2 |

Подписчики ставятся на module-level при загрузке файлов. ChatEventBus используется как универсальная шина, optional chaining (`window.ChatEventBus?.on?.(...)`) защищает на случай, если шина не загружена. Callsite'ы (TB-чекбокс в дереве и в items) только дёргают `AppState.setNodeTb` — каскадное обновление badge'ей делают подписчики.

---

## 8. `PreviewManager`

`constructor/preview/preview.js` (617 строк) — рендер финальной версии акта в правую панель (шаг 1) или в overlay version-preview. Static class. Per-type renderer'ы (`preview-table-renderer.js`, `preview-textblock-renderer.js`, `preview-violation-renderer.js`) — рядом в той же папке.

### 8.1 RAF-дедупликация (`update`)

`preview.js:55-68`:

```js
static update() {
    if (this._pendingUpdate) {
        return;  // RAF уже запланирован — выходим
    }
    this._pendingUpdate = true;
    requestAnimationFrame(() => {
        this._pendingUpdate = false;
        this._performUpdate();
    });
}
```

На N подряд идущих вызовов в одном кадре выполняется ровно один `_performUpdate`.

### 8.2 Debounce 150мс для typing (`scheduleTyping`)

`preview.js:105-111`:

```js
static scheduleTyping(options = {}) {
    clearTimeout(this._typingTimer);
    this._typingTimer = setTimeout(() => {
        this._typingTimer = null;
        this.update(options);
    }, this._TYPING_DEBOUNCE_MS);  // 150
}
```

Используется в обработчиках `input`-событий (textblock-editor, rich-поля нарушений). Серия мутаций при наборе текста не запускает рендер на каждый кадр — только через 150мс тишины.

`update` и `scheduleTyping` — взаимозаменяемые для callsite'а: тяжёлая структурная операция (add/delete table) использует `update` (немедленный RAF), typing-flow — `scheduleTyping` (debounce). Блочный аналог для точечных контентных правок (ввод в ячейку, текстблок) — `scheduleTypingBlock(kind, id)` (`:128`).

### 8.3 Fit-масштаб листа (`preview-fit.js`)

`PreviewFitScaler` вписывает лист A4 в ширину панели: `transform: scale(k)` на самом листе плюс sizer, который держит габариты под прокрутку. Четыре инварианта — каждый закрывает свой сорт «дёргания» превью, и каждый легко снести по незнанию:

- **Место под скроллбар зарезервировано всегда** — `scrollbar-gutter: stable` у `.column` (`two-columns.css`) и у холста меню превью (`preview-menu.css`). Без резерва появление скроллбара сужает колонку → падает `k` → лист становится ниже → скроллбар исчезает → и так кадр за кадром: на пограничной высоте окна петля живая, а не теоретическая.
- **Натуральные размеры листа меряются layout-метриками** `offsetWidth`/`offsetHeight`, а не `getBoundingClientRect()`. Они не зависят ни от собственного transform листа, ни от transform предков: прежний замер во время scaleIn-анимации модалки давал искажённый масштаб, который застревал после её конца — transform не дёргает `ResizeObserver`.
- **`ResizeObserver` наблюдает и лист**, а не только панель. Поздний рост контента (декодировалась картинка, точечный патч блока) бокс панели не меняет, и без наблюдения листа sizer оставался бы с устаревшим footprint'ом — лишняя или обрезанная прокрутка.
- **Гейт `isNegligibleRefit`** — расчёт не переприменяется, если натуральные размеры те же, а сдвиг масштабированной ширины меньше полпикселя (субпиксельный дребезг целочисленного `clientWidth` при дробном browser zoom). Изменение размеров листа — всегда переприменение.

Регрессии: `tests/js/preview-fit.test.mjs` (юнит) и e2e-спека `27-preview-fit-stability`, которой нужен отдельный Playwright-проект `chromium-scrollbars` — см. [§8.1 в `testing.md`](../guides/testing.md).

---

## 9. Диалоги

### 9.1 DialogBase

`shared/dialog/dialog-base.js` (452 строки) — базовый класс модалок. Все диалоги в системе **обязаны** наследоваться от него, чтобы получить focus-trap, ARIA, ESC-handling и стек.

**Возможности (`shared/dialog/dialog-base.js`):**

| Что | Где |
|---|---|
| `_activeDialogs: HTMLElement[]` | `:19` — стек overlay'ев для вложенных диалогов |
| `_createOverlay()` | `:26` |
| `_FOCUSABLE_SELECTOR` | `:38` — `a[href]`, `button:not([disabled])`, input/textarea/select без disabled, `[tabindex]` без `-1` |
| `_setupFocusTrap(overlay)` | `:77` — Tab на последнем focusable → first; Shift+Tab на первом → last. Trap работает **только** на верхнем диалоге стека (`:82`); handler хранится в `overlay._trapHandler` и снимается в `_hideDialog` |
| `_setupEscapeHandler(overlay, onClose)` | `:280` — ESC закрывает топовый overlay |
| `_setupOverlayClickHandler(...)` | `:256` — клик по overlay вне dialog'а → close |
| `_lockBodyScroll() / _unlockBodyScroll()` | `:301` — `overflow:hidden` на `<body>` пока есть открытые диалоги |
| `_showDialog(overlay, opts)` | `:130` — навешивает `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, focus-trap, сохраняет `_previousFocus`; `opts.appendToBody: false` — overlay уже в DOM (кейс `HelpManager`, §9.5) |
| `_hideDialog(overlay, delay=AppConfig.dialog.closeDelay)` | `:204` — снимает trap, восстанавливает фокус |
| `_createElement(tag, attrs, text)`, `_createButton(...)`, `_cloneTemplate(id)` | DOM-хелперы |
| `_fillField(...)` / `_fillFields(element, data)` | `:381 / :406` — заполнение полей по `data-field` атрибуту |
| `getActiveDialogsCount()` | `:433` |
| `closeAllDialogs()` | `:440` — копия `_activeDialogs` для безопасной итерации |

### 9.2 DialogManager (confirm/alert)

`shared/dialog/dialog-confirm.js` (298 строк) — `extends DialogBase`. Promise-based confirm/alert:

```js
const ok = await DialogManager.show({
    title, message, icon, type: 'warning'|'danger'|'info',
    confirmText, cancelText, hideCancel: bool,
    allowEscape: bool, allowOverlayClose: bool,
    onMount: ({overlay, close}) => { ... }
});
```

`onMount` хук используется `LockManager._handleInactivity` (`lock-manager.js:514`) для получения handle к программному `close()` диалога — чтобы при autoExit'е programmatically закрыть overlay без user-click'а.

### 9.3 Крупные диалоги конструктора

| Диалог | File | LOC | Особенности |
|---|---|---|---|
| `InvoiceDialog` | `constructor/dialog/dialog-invoice.js` | 893 | Кеши справочников (метрики, процессы, БП-таблицы), TTL 15min, AJAX-валидация. Виджет автодополнения вынесен в `InvoiceAutocomplete` |
| `InvoiceAutocomplete` | `constructor/dialog/invoice-autocomplete.js` | 433 | Вынесен из `InvoiceDialog` (§6 п.8 аудита): 4 searchable-dropdown (таблицы/метрики/процессы/подразделения). Состояние остаётся в `InvoiceDialog`, передаётся параметром — без generic-абстракции |
| `HelpManager` | `constructor/dialog/dialog-help.js` | 153 | extends DialogBase (§9.5). Init на `DOMContentLoaded` — без него кнопка help не привяжется |

### 9.4 Крупные диалоги portal

| Диалог | File | LOC | Особенности |
|---|---|---|---|
| `CreateActDialog` | `portal/acts-manager/dialog-create-act.js` | 1740 | Сложная форма: КМ-валидация, секции из API, team-members с autocomplete, поручения |
| `AuditLogDialog` | `portal/acts-manager/dialog-audit-log.js` | 740 | Два таба (Лог/Версии), `FilterEngine` для фильтров, load-more 50/стр. |
| `VersionPreviewOverlay` | `portal/acts-manager/version-preview.js` | 354 | extends DialogBase; 3 режима (UI/JSON/Diff) через `DiffEngine` + `DiffRenderer` |
| `AdminAddUserDialog` | `portal/admin/admin-add-user-dialog.js` | 239 | Search → выбор → assign |
| `CkProcessPicker` | `shared/ck/ck-process-picker.js` | 174 | Popup выбора БП для CkForm |

### 9.5 HelpManager через DialogBase

`HelpManager` (extends DialogBase) показывает существующий в DOM `<div id="helpModal">` через `DialogBase._showDialog(modal, {appendToBody: false})` (`dialog-base.js:130`). Опция `appendToBody: false` сообщает DialogBase, что overlay уже в DOM и не нужно его добавлять/удалять — только показать/скрыть через классы `.visible`/`.hidden`. Это даёт HelpManager:

- Единый стек `_activeDialogs` (вложенность с другими диалогами работает корректно).
- `aria-modal`, `role="dialog"`, `aria-labelledby` автоматически.
- Focus-trap + восстановление `_previousFocus` при закрытии.
- ESC через общий `EscapeStack` (см. §6.7 EscapeStack).
- Lock body scroll.

Раньше HelpManager имел свой `_showModalHelp` / `_currentModal` — отдельная иерархия, без focus-trap. Теперь унифицирован.

---

## 10. Acts manager и кросс-доменная навигация

### 10.1 ActsManagerPage

`portal/acts-manager/acts-manager-page.js` (903 строки) — главная страница `/acts`. Координирует:

- Загрузку списка актов через `GET /api/v1/acts/list` (`:245, :295`; постраничная подгрузка `limit`/`offset`, фильтрация по статусу/КМ/датам).
- Карточки актов из template'а `acts_card.html` (`_cloneTemplate` + `_fillFields` из DialogBase).
- Действия `open` / `edit` / `history` / `duplicate` / `delete` — с проверкой роли пользователя в команде акта.
- Cross-tab subscribe на `ActsBroadcast` — событиях `act:deleted/duplicated/updated` инвалидирует и перезагружает список.
- Перехват `CreateActDialog._closeDialog` через `safeClose` — обвязка, чтобы после успешного создания/редактирования сразу обновить список.

### 10.2 Role-checks (роль «Участник»)

`acts-manager-page.js:465-540` — кнопки `edit`/`delete` **скрываются** (`hidden = true`) для роли «Участник»:

```js
const canEdit = act.user_role !== 'Участник';
if (!canEdit) {
    if (editBtn) editBtn.hidden = true;
    if (deleteBtn) deleteBtn.hidden = true;
}
```

Дополнительно при клике (на случай гонок состояния) — `Notifications.warning('Редактирование недоступно для роли "Участник"')`.

- **Дублирование** — доступно всем; Участник станет Редактором в новом акте (`:523-524`).
- **История** — только Куратору/Руководителю (`:512`).

Серверная страховка — `require_domain_access('acts')` плюс role-check в `app/domains/acts/services/permissions.py`; UI-логика выше — UX-слой.

### 10.3 BroadcastChannel `'acts'`

`portal/acts-manager/acts-broadcast.js` (36 строк) — `ActsBroadcast.CHANNEL = 'acts'`. События `act:deleted`, `act:duplicated`, `act:updated`.

Использование:
- `acts-manager-page.js:734-735, 798` — notify на duplicate/delete; subscribe → `loadActs()`.
- Сценарий: открыто две вкладки `/acts`, удалили акт в одной → вторая инвалидирует и перезагружается.

Подключается **и в конструкторе** — `entries/constructor.js:128` импортит `acts-broadcast.js` перед `acts-menu.js`: бургер-меню актов в конструкторе тоже реагирует на cross-tab события.

Fallback: если `BroadcastChannel` недоступен (старый Safari), модуль логирует `console.warn` и работает no-op (`acts-broadcast.js:14`).

### 10.4 Cross-zone зависимость: portal → constructor

Два portal-модуля импортируют `constructor/lock-manager.js` ESM-импортом (тега `<script>` в шаблоне нет):
`portal/acts-manager/acts-manager-page.js:8` и `portal/acts-manager/dialog-audit-log.js:7`. Портальная страница использует constructor's `LockManager` для редактирования **метаданных** акта (через `CreateActDialog` в edit-режиме) без открытия конструктора. Сценарий:

1. Юзер на `/acts` нажимает «Редактировать» (карандаш).
2. `ActsManagerPage.editAct(actId, status)` (`:562`) — `LockManager.init(actId)` берёт лок (`:592`).
3. Открывается `CreateActDialog` в edit-режиме (форма метаданных без contents).
4. На submit / close — `LockManager.manualUnlock()` снимает лок (`:652`).

Плюс обратная зависимость: entry конструктора импортирует `portal/acts-manager/acts-broadcast.js` (`entries/constructor.js:128`) — бургер-меню актов в конструкторе реагирует на cross-tab события.

Это единственные cross-zone зависимости между `portal/` и `constructor/`. Документируем явно — без них рефакторинг папок может сломать edit-flow.

### 10.5 `portal.css` подсасывает `constructor/preview/*`

Аналогично — `static/css/entry/portal.css:26-29` импортит `constructor/preview/{preview-base, preview-table, preview-typography, preview-violation}.css` для `VersionPreviewOverlay`, который реюзает preview-renderer'ы конструктора.

### 10.6 Diff engine

`portal/acts-manager/diff-engine.js` (815 строк) — чистый utility без DOM. `DiffEngine.compute(oldData, newData)` возвращает `{tree, tables, textblocks, violations, invoices, hasChanges}`.

- `_diffTree` — flatten оба дерева в map по id, `node._diff = added/modified/unchanged`.
- `_diffTables` — cell-level (row × col matrix).
- `_diffTextBlocks` — word-level через LCS на `Uint16Array`, fallback на coarse-diff если `m*n > 250000`.
- `_diffViolations` — блочная модель: по каждому из 10 полей реестра — дифф списка блоков по `id` (added/removed/modified/reordered), внутри modified text-блока — word-diff, у table-блока — плоское сравнение ячеек; плюс дифф `fieldOrder` и `enabled` каждого поля.
- `_diffInvoices` — поле-за-полем по `INVOICE_DIFF_FIELD_KEYS` (`portal/acts-manager/invoice-diff-fields.js`, новый shared-модуль с списком полей и подписей — переиспользуется `diff-renderer.js` для `INVOICE_FIELD_LABELS`).

`portal/acts-manager/diff-renderer.js` (755 строк) — DOM-рендер с подсветкой.

---

## 11. Безопасность и санитизация

### 11.1 SafeHTML (frontend)

`shared/sanitize.js` (296 строк) — единый wrapper над `window.DOMPurify` (`static/vendor/dompurify/purify.min.js`):

```js
window.SafeHTML = { set, sanitize, escapeHtml };
```

**`SafeHTML.set(el, html, extraConfig?)`** — основной API. Если `DOMPurify` загружен: `el.innerHTML = DOMPurify.sanitize(...)`; иначе fallback на `el.textContent = ...` (безопасно — не raw HTML) с warn-once-логом.

**Конфигурация (`DEFAULT_CONFIG`, `sanitize.js:23-40`):**

- Дефолт-профиль (blocklist, используется чатом/diff-renderer): `USE_PROFILES: { html: true }` (SVG/MathML отключены), `FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button']`, `FORBID_ATTR` — полный список 60+ inline event-handlers (`onerror`, `onclick`, и т.п.).
- Профиль `'acts'` (strict allowlist, используется рендером текстблоков конструктора И rich-полей нарушений): `ALLOWED_TAGS`/`ALLOWED_ATTR`, зеркальные бэк-whitelist'у `html_sanitizer.py` (включая `s/strike/del` и data-атрибуты ссылок/сносок). Вызов: `SafeHTML.set(el, html, 'acts')`; основной sink rich-контента — обёртка `renderActContent(el, html)` (`sanitize.js:292`). Состав закреплён стражем `tests/js/sanitize-profiles.test.mjs`.
  - **Allowlist CSS-свойств для inline-`style`.** Профиль `'acts'` дополнительно фильтрует атрибут `style`, оставляя только свойства из `ACTS_CSS_PROPERTIES` (`font-size`, `color`, `background-color`, `font-weight`, `font-style`, `text-decoration`, `text-decoration-line`, `text-align`) — **зеркало бэкендового allowlist'а**. Реализация — хук `afterSanitizeAttributes` + модульная переменная активного allowlist'а, выставляемая на время синхронного `DOMPurify.sanitize` (реентрантности нет; кастомный ключ конфига в хук-арг DOMPurify надёжно не пробрасывается). Без этого превью показывало бы инлайн-CSS (`font-family`/`position`/`display`/…), который бэк потом срезает → расхождение превью ↔ сохранённого акта/экспорта.
  - **Рантайм-синхронизация с бэком**: хардкод-списки (`ACTS_CSS_PROPERTIES`, `sanitize.js:49`) — фолбэк на время до ответа сервера и офлайн; источник истины — `applyActsAllowlist(cfg)` (`sanitize.js:91`) по данным `GET /acts/limits` (секция sanitizer, из `ACTS__SANITIZER__*`), с диагностикой дрейфа `_warnIfDrift`. Известное расхождение: DOMPurify не умеет per-tag политику style (у бэка div/p несут только `text-align`) — превью может показать `font-size` на `div`, который бэк снимет на save.

**Потребители**: `textblock-editor.js`, `violation-core.js`, `violation-field-surface.js`, `preview-violation-renderer.js`, `preview-textblock-renderer.js`, `diff-renderer.js`, `formalizer-popover.js`, `chat-renderer.js`. Все `innerHTML`-sink'и в коде обязаны идти через `SafeHTML.set`/`renderActContent` или (если HTML заведомо безопасен) через `textContent` напрямую.

### 11.2 bleach + nh3 (backend)

Defense in depth: на бэке HTML-поля акта проходят повторную санитизацию перед записью в БД — даже если фронтовый SafeHTML обойдут, script-tag не сохранится. С PR #37 движка два (`app/domains/acts/utils/html_sanitizer.py`): `sanitize_html` (bleach) — `textBlocks[*].content` и узлы дерева; `sanitize_rich_html` (nh3) — rich-поля нарушений, состав по флагу `rich` реестра `violation_fields.py`. Allowlist общий (`ACTS__SANITIZER__*`). Ячейки таблиц — verbatim (Фаза 2 не реализована). Детали — §9.3 в [`textblock-editor-architecture.md`](textblock-editor-architecture.md) и §13 в [`data-model-acts.md`](data-model-acts.md).

### 11.3 Security headers (CSP enforce + nonce)

Класс `SecurityHeadersMiddleware` в `app/core/middleware.py` (единый модуль, не директория) подключает 5 заголовков в **enforce-режиме** (`csp_report_only=False`) + 6-й (`Strict-Transport-Security`) условно при HTTPS:

- `Content-Security-Policy` — enforce. `script-src 'self' 'nonce-{nonce}'` **без** `'unsafe-inline'`: на каждый http-запрос middleware генерит свежий `secrets.token_urlsafe(16)`, кладёт в `scope["state"]["csp_nonce"]` (шаблоны читают через `request.state.csp_nonce`) и подставляет в плейсхолдер `{nonce}` директивы `script-src` при сборке заголовка. Один и тот же nonce уходит в заголовок и в state → совпадение по построению. Инъектированные inline-скрипты блокируются, легитимные init-блоки с верным `nonce`-атрибутом исполняются.
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: ...`
- `X-Frame-Options: SAMEORIGIN`
- `Strict-Transport-Security` — только при HTTPS-соединении (условный 6-й).

**Inline-скрипты под nonce** — единственные исполняемые inline-блоки: init-`<script type="module">` в page-шаблонах (`base_constructor.html`, `acts_manager.html`, `admin.html`, `_ck_layout.html`, `landing.html`, `profile.html`, `sqlagent/embed.html`), каждый импортирует page-модуль через `url_for('static', path=...) | versioned`. Подход «nonce, а не вынос в .js» выбран сознательно: он сохраняет версионируемые (cache-busting, §13.7) import-пути, которые собирает Jinja — при выносе в отдельный `.js` фильтр `versioned` к пути импорта уже не применить. Внешние `<script src>` (DOMPurify, entry-модули) покрыты `'self'` — nonce не требуют. Inline-обработчиков `onclick/onchange` в шаблонах нет (0).

**`style-src 'self' 'unsafe-inline'` оставлен осознанно** — вынос inline-стилей отдельный несоизмеримый объём (follow-up). Деталь решения — `docs/reports/2026-06-12-constructor-backlog-решения-тимлида.md` (раздел CSP).

### 11.4 Error boundary

`shared/error-boundary.js` (133 строки). Перехватывает:

- `window.addEventListener('error', ...)` — синхронные ошибки.
- `window.addEventListener('unhandledrejection', ...)` — неперехваченные Promise rejection'ы.

На каждую ошибку:

1. `console.error('[GlobalError]'|'[UnhandledPromise]', ...)`.
2. `Notifications.error('Произошла непредвиденная ошибка. Обновите страницу.')` (если уже загружен).
3. `POST /api/v1/system/client-error` с rate-limit 5s (`REPORT_INTERVAL_MS = 5000`, `:26`) и `keepalive: true` (`:88`) — отчёт уйдёт даже при закрытии вкладки.

Импортируется в entry-модулях (`portal-common.js`, `constructor.js`) **сразу** после `notifications.js`, чтобы успеть поймать ошибки инициализации остальных модулей.

### 11.5 Fetch timeout

`shared/api.js:1243-1270` — `_fetchWithTimeout(url, opts, timeoutMs=30000)`:

```js
const controller = new AbortController();
const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
try {
    return await fetch(url, {...opts, signal: controller.signal});
} catch (err) {
    if (timedOut && (err?.name === 'AbortError' || err?.code === 20)) {
        throw this._createError(408, 'Превышено время ожидания ответа сервера');
    }
    throw err;
} finally { clearTimeout(timer); }
```

Default 30s; уважает пользовательский `signal` (если уже передан — не оборачивает). **Поллинг-вызовы с долгим горизонтом ожидания** (опрос готовности ответа из шины) **не должны** использовать этот wrapper — у них свой `AbortController` с более длинным таймаутом.

### 11.6 Envelope `{detail, code, extra}`

`shared/api.js:1217` (`_createError`) — единый формат ошибок API:

```js
static _createError(status, detail, code = null, extra = null) {
    const error = new Error(detail);
    error.status = status;
    error.code = code;
    error.extra = extra;
    return error;
}
```

Бэк бросает `AppError`, `to_envelope()` сериализует в `{detail, code, extra?}` (см. dev-guide). На фронте:

- `code` — машинный код kebab-case (например, `'act-locked'`, `'chat-limit-reached'`).
- `extra` — словарь дополнительных полей (например, `{locked_by: 'username'}`).

Текущие потребители `extra`:

- `constructor/lock-manager.js:202-203` — `error.code === 'act-locked'` + `error.extra?.locked_by` (envelope `ActLockError` несёт ещё `locked_until`).

Других чтений `extra` нет — паттерн пока используется только LockManager'ом.

### 11.7 FastAPI 422 нормализация

`api.js:1293` — `detail` от pydantic-валидаторов приходит как массив `[{loc, msg, type, ...}, ...]`. Без нормализации в UI прилетал `"[object Object]"`. Складываем в строку через `; ` (msg уже на русском).

### 11.8 PaginatedResponse

Бэк (`app/core/responses.py:14-27`) возвращает `{items, total, limit, offset}` для пагинированных эндпоинтов. Конвенция query-параметра — `limit: int = Query(50, ge=1, le=200)` (диапазон `1..200`, дефолт `50`; `acts/api/audit_log.py:42`, `admin/api/roles.py:35`, и т.д.). Потребители на фронте: `dialog-audit-log.js`, `admin-audit-log.js`, `admin-roles.js`, ЦК-страницы.

---

## 12. Accessibility и i18n

### 12.1 i18n

Весь user-facing текст — **на русском**. `<html lang="ru">` в обоих `base_*.html`. Серверный pluralizer для минут — `AppConfig.lock._pluralizeMinutes(n)` (склонения «минуту/минуты/минут»).

### 12.2 ARIA tree (treeitem pattern)

`tree-renderer.js` рендерит `#tree` как `role="tree"` (шаблон), каждый `<li>` — `role="treeitem"` с `aria-level=N`, `aria-expanded=true/false`, `aria-selected=...`. Поддерживаются клавиатурные сокращения ArrowUp/ArrowDown/Right/Left/Enter (открытие).

### 12.3 Dialog ARIA

`DialogBase._showDialog` (`dialog-base.js:115-...`) автоматически проставляет на overlay:

- `role="dialog"` (если не задан),
- `aria-modal="true"`,
- `aria-labelledby` на первый заголовок (`data-dialog-title` или h1..h4).

Focus-trap: Tab cycle (`_setupFocusTrap`, `:74-105`) работает только на верхнем диалоге стека.

При закрытии — фокус возвращается на `_previousFocus` (запоминается перед открытием).

### 12.4 Notifications ARIA live

`shared/notifications.js:38-46` — контейнер озвучивается screen reader'ом как ARIA live region:

```js
container.setAttribute('role', 'region');
container.setAttribute('aria-label', 'Уведомления');
```

Per-notification роль (`alert` для error/warning, `status` для info/success) — в `_buildNotificationElement`.

### 12.5 prefers-reduced-motion

Анимации в `static/css/base/animations.css` обёрнуты `@media (prefers-reduced-motion: reduce)` — для пользователей с включённой опцией ОС переходы отключены.

### 12.6 Contrast

Цветовая палитра в `static/css/base/variables.css` проверена на AAA-контраст для основного текста, AA — для тонкого UI-текста. Конкретные WCAG-aliases:

- `--text-primary`, `--text-secondary` — основной текст.
- `--text-tertiary` — приведён к AA-контрасту (Wave 3, HIGH#O).
- `--duration-fast`, `--duration-normal`, `--duration-slow` — алиасы durations для предсказуемой темизации.

### 12.7 Адаптивность

Constructor **не адаптивен** (0 media queries в `constructor/*`). Это **осознанное решение** — редактор актов является desktop-only продуктом (B2B-приложение для аудиторов внутри Сбербанка). Portal-страницы (acts-manager, admin, ck) — частично адаптивны (sidebar collapses), но критическая работа всё равно идёт в desktop-конструкторе.

---

## 13. CSS-архитектура

### 13.1 Entry points

Два корневых файла-агрегатора `@import`'ов:

- `static/css/entry/portal.css` — для всех portal-страниц (загружается в `base_portal.html`).
- `static/css/entry/constructor.css` — для редактора (загружается в `base_constructor.html`).

Третий entry `static/css/entry/shared.css` — реюзается `portal.css` через первый `@import './shared.css'`. Содержит базу (variables/reset/animations), shared-кнопки/уведомления/диалоги, shared-чат-стили.

### 13.2 Каскад constructor.css

```
@import './shared.css';
@import '../constructor/layout/*.css';                    # 7 файлов; первым —
                                                          #   density.css (§13.5)
@import '../shared/layout/settings-menu.css';             # 1
@import '../shared/notifications-center/notifications-center.css'; # 1 (reuse)
@import '../constructor/tree/*.css';                      # 5
@import '../constructor/table/*.css';                     # 4
@import '../constructor/violation/*.css';                 # 4
@import '../constructor/preview/*.css';                   # 7
@import '../constructor/help/*.css';                      # 3
@import '../constructor/items/*.css';                     # 4
@import '../constructor/textblock/*.css';                 # 3
@import '../constructor/search/find-bar.css';              # 1
@import '../constructor/context-menu/*.css';              # 2
@import '../constructor/dialog/dialog-invoice.css';       # 1
@import '../shared/dialog/acts-modal.css';                # 1
@import '../portal/acts-manager/team-member-search.css';  # 1 (reuse)
@import '../constructor/chat/chat-popup.css';             # 1
@import '../constructor/utilities/*.css';                 # 3
```

≈50 файлов через каскад.

### 13.3 Каскад portal.css

```
@import './shared.css';
├── portal/layout/density.css        # сразу после токенов, до всех потребителей
├── portal/layout/sidebar.css
├── portal/layout/user-avatar.css
├── shared/layout/settings-menu.css
├── shared/notifications-center/notifications-center.css
├── portal/landing/landing.css
├── portal/acts-manager/{acts-manager-base, acts-manager-cards,
│                        team-member-search, audit-log-dialog,
│                        version-preview}.css
├── shared/dialog/acts-modal.css
├── constructor/preview/{preview-base, preview-table,
│                        preview-typography, preview-violation}.css  # см. §10.5
├── portal/admin/{admin-page, admin-search,
│                 admin-roles, admin-add-user}.css
├── shared/datatable.css             # тулкит таблиц, используется ЦК
├── portal/ck/{ck-page, ck-table, ck-form, ck-process-picker,
│              ck-breakdown-editor}.css
├── portal/sqlagent/sqlagent.css
└── portal/profile/profile-page.css
```

### 13.4 Переменные

`static/css/base/variables.css` — агрегатор-файл с `@import` на 7 тематических подфайлов в `static/css/base/variables/`:

| Файл | Содержание |
|---|---|
| `colors.css` | Палитра, статусы, фоны, границы, тексты, кнопки, инпуты, оверлеи, градиенты, цвета таблиц/подсветок/ссылок/дерева/save-indicator/notifications/acts-states |
| `typography.css` | font-family, font-size, font-weight, line-height, letter-spacing |
| `spacing.css` | --spacing-*, --radius-*, --border-width-*, --translate-*, --opacity-*, scale-tokens |
| `shadows.css` | --shadow-*, --text-shadow-*, --focus-ring, --focus-outline, --modal-blur-background, --tooltip-arrow-size |
| `z-index.css` | Все --z-* (base, dropdown, sticky, modal, popover, tooltip, notification) включая `-elevated`-уровни |
| `motion.css` | --transition-*, --duration-*, --ease-*, --rotate-*, --animation-iterations, --bounce-* |
| `components.css` | Компонент-специфичные размеры (modal, preview, table, textblock, link-footnote, toolbar, acts-menu, save-indicator, tree, violation, settings-menu, theme-switch, help-modal, create-act-dialog, steps, status-tag, scrollbar, header, breakpoints, items, context-menu, dialog, button-sizes, icon-sizes) |

Все 581 переменная (§1.1) по-прежнему доступны под прежними именами — это пере-разбиение, не переименование. `@import` в CSS — runtime-каскад, порядок резолва значений не зависит от порядка @import.

### 13.5 Плотность интерфейса (rem-масштаб)

Корневой `font-size` — рычаг плотности: почти весь хром (кегли, отступы, кнопки, панели) задан rem-токенами и следует за корнем разом. Ступени у зон разные, каждая живёт в своём файле и входит **только** в свой entry — сразу после `shared.css`, до всех потребителей:

| Файл | Корень | Зона |
|---|---|---|
| `constructor/layout/density.css` | `html { font-size: 12px }` (75% от браузерных 16px) | конструктор |
| `portal/layout/density.css` | `html { font-size: 13px }` | портал (лендинг, `/acts`, admin, ЦК, профиль) |

Портальная ступень мягче намеренно: портал — смесь rem-зон и голых px (таблицы и формы ЦК, журнал изменений, предпросмотр версии). Плоские 75% сжали бы только обрамление, а ЦК не шелохнулся бы. Ориентир — кегль самого ЦК: корень 13px даёт основной текст 12px и подписи 11px, ровно как `.ck-table` (`--font-size-sm`) и `.ck-form__label` (`--font-size-xs`).

**Что от масштаба защищено** — иначе печатная точность уехала бы вместе с UI:

- **Лист предпросмотра** — геометрия и тело заданы в px/pt/mm (`preview-page.css`) и от rem не зависят. Заголовки листа (`.preview h1…h6`) — исключение, они считаются от токенов, поэтому зонные сжатия кегля на панель предпросмотра не вешают.
- **Тело текстблок-редактора** — `.textblock-editor` возвращает `--font-size-base/lg/xl` в печатные px (база 16px ≈ 12pt Word, EXP-2). Инвариант «16px → 12pt» из [`textblock-editor-architecture.md`](textblock-editor-architecture.md) держится этим переопределением, а не наследованием от корня: править корень конструктора, не проверив его, — прямой путь сбить кегль документа.
- **Мелкий кегль портала** — `--font-size-xs`/`--font-size-sm` прибиты в px (11/12px). При корне 13px формула дала бы 9.75 и 11.4px: первое ниже предела читаемости подписи, второе мельче тела соседних таблиц ЦК. `--font-size-sm` нагружен особо — это дефолт `body` из `reset.css`.
- **Полоса шапки конструктора** — `--header-height: 8vh` при поле `--header-min-height: 68px`. Пол именно в px: rem-ный уехал бы вместе с корнем, а содержимое полосы (кнопки 32px + подписи) в основном px-ное и не сжимается — кнопки упирались бы в края.

Рабочие зоны, наоборот, сжимаются сверх общего масштаба: `.items-container` (форма заполнения) опускает свою шкалу ещё на ступень — там счёт идёт на строки, влезающие в экран. Дерево в список не входит: высоту строки держат отступы, и мельчающий в них текст добавил бы пустоты при том же числе видимых строк.

### 13.6 Z-index map

Управляется через CSS-переменные (`--z-tooltip`, `--z-overlay`, `--z-modal`, `--z-popover`, `--z-modal-elevated`, `--z-popover-elevated`). Wave 3 ввёл `*-elevated`-уровни для вложенных диалогов поверх обычных модалок. Локальный `calc(var(--z-modal) + 1)` в нескольких CSS-файлах — потенциальная проблема пересечения с соседними layer'ами (известный технический долг, M-Z-CALC).

### 13.7 Cache-busting

Jinja-фильтр `versioned` (применяется ко всем `url_for('static', path='...')`) добавляет `?v={app_version}` к URL. Регистрируется в `app/core/templating.py:32`; значение берётся из `Settings.app_version`, а тот — из `__version__` в `app/__init__.py`. При смене версии браузер форсированно перезагружает статику.

### 13.8 `<meta name="app-version">`

`base_portal.html:8` / `base_constructor.html:8` — `<meta name="app-version" content="{{ app_version }}">` (глобал шаблонов, `templating.py:29`). Бейдж версии в topbar и admin-diagnostics tab читают это значение.

---

## 14. Чат

Полный гайд по чат-фронту — [`docs/architecture/chat-frontend-architecture.md`](chat-frontend-architecture.md) (13 модулей, транспорт polling по шине, режимы inline/modal/popup, forward к внешнему агенту, типы блоков, ClientActionsRegistry, status state machine).

Здесь — только load-bearing **точки сцепки** с остальным фронтом:

### 14.1 `AppConfig.chatEndpoints`

См. §3.3. Все URL чата — в `app-config.js:120-...`, callsite'ы обязаны брать оттуда (`AppConfig.api.getUrl(AppConfig.chatEndpoints.messages(cid))`).

### 14.2 `ChatEventBus` — общий event bus

Хотя модуль чатовский, конструктор использует его как cross-module шину (§7.6). Эмиттеры: `node:tb-changed`, `node:invoice-changed` (`constructor/state/state-tree.js:958, 997`). Подписчики: `tree-renderer.js:45-56`, `items-renderer.js:786-789`.

### 14.3 Новый тип блока чата — 3 места sync

1. `MessageBlock` union в `app/core/chat/blocks.py` (Python).
2. `_DiscriminatedBlock` в `app/core/chat/schemas.py` (Python).
3. Новый `case` в `switch (block.type)` внутри `ChatRenderer.renderBlock` (`static/js/shared/chat/chat-renderer.js:437-465`) **плюс** соответствующий метод `_renderX`.

Без бэка — `parse_message_blocks` не распознает. Без фронта — `renderBlock` упадёт в `default`-ветку с fallback-блоком («⚠ Блок неизвестного типа …»).

> **Не путать с `KNOWN_BLOCK_TYPES`.** Set в `chat-messages.js:21` рендером **не читается**: его единственные вхождения во всём `static/` — объявление (`:21`), реэкспорт свойством `ChatMessages` (`:36`) и `window.KNOWN_BLOCK_TYPES` (`:678`). Добавление типа туда ни на что не влияет; константа — кандидат на удаление из кода. Если тип должен печататься посимвольно, дополнительно правится `isStreamingBlockType` (`chat-renderer.js:275`).

### 14.4 `ChatPopupManager` в конструкторе

`constructor/header/chat-popup.js` (143 строки) — обёртка над `ChatManager` для всплывающего popup-чата в шапке конструктора. Static class, как и `ChatModalManager` на portal. Отличие от modal: **полный re-init/destroy `ChatManager` на каждое открытие/закрытие**; resize за угол и персистентность размера делегированы `shared/resizable-panel.js`, Escape — `shared/escape-stack.js`.

---

