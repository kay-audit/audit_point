# Архитектура фронтенда Audit Workstation

> Единый документ по всему фронту проекта (зоны `shared/`, `portal/`, `constructor/`). Чат описан отдельно — см. главу 14 и [`docs/architecture/chat-frontend-architecture.md`](chat-frontend-architecture.md).
>
> Источник истины — код в `static/js/`, `static/css/`, `templates/`. Все ссылки `file:line` сверены grep'ом на момент написания. При расхождении документа и кода — источник истины код.

## Оглавление

1. [Обзор](#1-обзор)
2. [ES-модули и entry-файлы](#2-es-модули-и-entry-файлы)
3. [`AppConfig` и проксирование (JupyterHub)](#3-appconfig-и-проксирование-jupyterhub)
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
| Всего JS-файлов | приблизительно на момент написания: 183 (`static/js/**/*.js`) |
| `constructor/` (редактор актов) | приблизительно 106 файлов (включая `search/` и инфраструктуру поверхностей, §1.2) |
| `shared/` (cross-zone модули + чат) | приблизительно 42 файла (включая 13 модулей чата) |
| `portal/` (sidebar-страницы) | приблизительно 32 файла (включая профиль/карточку пользователя) |
| Всего CSS-файлов | 95 |
| `constructor/` CSS | 44 файла |
| `portal/` CSS | 19 файлов |
| `shared/` CSS | 17 файлов |
| `base/` CSS | 11 файлов |
| CSS-переменных | 580, `base/variables.css` — агрегатор, сами переменные в `base/variables/{colors,components,typography,spacing,shadows,motion,z-index}.css` |

### 1.2 Три зоны

```
static/js/
├── shared/      # Cross-zone: AppConfig, APIClient, AuthManager,
│   │            #   Notifications, SafeHTML, ErrorBoundary, DialogBase/Manager,
│   │            #   FilterEngine, ck/* (CkTable, CkForm, CkPagination, CkProcessPicker)
│   ├── dialog/  # DialogBase + DialogManager (confirm/alert)
│   ├── ck/      # Реюзаемые компоненты ЦК-страниц
│   └── chat/    # 13 модулей чата — реестр в docs/architecture/chat-frontend-architecture.md
│
├── portal/      # Sidebar-страницы: landing, acts-manager, admin, ck-fin-res, ck-client-exp
│   ├── acts-manager/   # ActsManagerPage, CreateActDialog, AuditLogDialog,
│   │                   #   VersionPreviewOverlay, DiffEngine/Renderer, ActsBroadcast
│   ├── admin/          # AdminPage (roles/diagnostics/audit-log)
│   ├── ck-fin-res/     # ЦК «финансовые результаты»
│   └── ck-client-exp/  # ЦК «клиентский опыт»
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
    ├── violation/    # ViolationManager (20 файлов, включая
    │                 #   violation-field-surface.js — rich-поверхности полей)
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

| URL | Шаблон | Что грузится |
|---|---|---|
| `/` | `landing/landing.html` (extends `base_portal.html`) | inline-чат |
| `/acts` | `acts-manager/acts_manager.html` | список актов |
| `/admin` | `admin/admin.html` | 3 таба |
| `/ck-fin-res`, `/ck-client-exp` | `ck/ck_*.html` (extends `_ck_layout.html`) | редактор записей ЦК |
| `/constructor?act_id={int}` | `constructor/constructor.html` (extends `base_constructor.html`) | редактор актов |

`/constructor` принимает обязательный `act_id: int` — обработчик в `app/domains/acts/routes/constructor.py` редиректит на `/acts` при невалидном значении.

### 1.4 Связанные документы

- [`docs/architecture/chat-frontend-architecture.md`](chat-frontend-architecture.md) — чат-фронт (13 модулей, транспорт polling по шине `chat_agent_messages_bus`).
- [`docs/architecture/textblock-editor-architecture.md`](textblock-editor-architecture.md) — редактор текстблоков: капсулы ссылок/сносок, caret-guard, целостность капсул, DOCX-экспорт.
- [`docs/guides/developer-guide.md`](../guides/developer-guide.md) §4 — высокоуровневый обзор фронта.
- [`docs/guides/developer-guide.md`](../guides/developer-guide.md) §10 — UX/persistence/lock.
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

- **`static/js/entries/portal-common.js`** — импортит `shared/` (app-config, auth, api, notifications, error-boundary, escape-stack, sanitize, dialog-base, dialog-confirm), `portal/portal-sidebar`, `portal/portal-settings`, 13 чат-модулей (chat-feedback подтягивается через граф chat-messages.js, не напрямую в entry). Подключается в `templates/portal/base_portal.html` одним тегом.

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
| `shared/resizable-panel.js` | `makeResizablePanel` | функция-фабрика |
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
| `constructor/violation/violation-field-surface.js` | `ViolationFieldSurface`, `ViolationContentItemSurface`, `ViolationListItemSurface`, `_createRichFieldEditor` (rich-поля нарушений) |
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

## 3. `AppConfig` и проксирование (JupyterHub)

> Актуальный деплой — SDP (доступ по IP:порту, без proxy-путей); `root_path` в
> приложении больше не выставляется, поэтому ветка JupyterHub-proxy в
> `getBaseUrl()` ниже сейчас не срабатывает и функция просто возвращает
> `origin`. Код и конвенция `AppConfig.api.getUrl()` оставлены как есть —
> недорогая страховка на случай будущего proxied-деплоя; regression-инвариант
> (§3.2) остаётся в силе.

### 3.1 Зачем нужен AppConfig

Single source of truth для констант, тайминговых магических чисел и URL-builder'а. Декларации:

| Секция | Что в ней |
|---|---|
| `AppConfig.api` | `getBaseUrl()`, `getUrl(endpoint)` — единственная точка построения URL под JupyterHub-proxy |
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

`app-config.js:147-154` — все load-bearing тайминги в одном месте; меняются здесь, не в callsite'ах.

### 3.2 `AppConfig.api.getUrl()` — единая точка

```js
getBaseUrl() {
    if (this._baseUrlCache !== null) return this._baseUrlCache;
    const origin = window.location.origin;
    const pathname = window.location.pathname;
    // JupyterHub-proxy формат: /user/{username}/proxy/{port}/...
    const proxyMatch = pathname.match(/^(\/user\/[^\/]+\/proxy\/\d+)/);
    this._baseUrlCache = proxyMatch ? `${origin}${proxyMatch[1]}` : origin;
    return this._baseUrlCache;
}

getUrl(endpoint) {
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
    return `${this.getBaseUrl()}/${cleanEndpoint}`;
}
```
(`shared/app-config.js:51-91`)

**Регрессионный инвариант:** все `fetch('/api/v1/...')` и навигационные `window.location.href = '/...'` обязаны идти через `AppConfig.api.getUrl()`. Прямой относительный URL под JupyterHub уходит на `/hub/api/...`, минуя `/user/{user}/proxy/{port}/` → 404. Текущий статус: `Grep "fetch\(\s*['\"\`]/api"` по `static/js/` → **0 совпадений**. `Grep "AppConfig.api.getUrl"` → **89 совпадений в 19 файлах**.

### 3.3 `chatEndpoints`

`app-config.js:112-133` — реестр URL для чата. Параметризованные — функции (`messages(cid)`), статические — строки. Полные URL получаются комбинацией: `AppConfig.api.getUrl(AppConfig.chatEndpoints.messages(cid))`. Магические строки `/api/v1/chat/...` в callsite'ах — рефакторинг-запах.

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

`AppState` объявлен как **object literal** в `constructor/state/state-core.js:8`. Поля:

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

- `state-tree.js:8` — `generateNumbering`, `addNode`, `deleteNode`, `moveNode`, `setNodeTb`, `setNodeInvoice`, и др.
- `state-content.js:9` — `addTableToNode`, `addTextBlockToNode`, `addViolationToNode`, `_updateMetricsTablesAfterRiskTableCreated`, и др.

Порядок загрузки `state-core → state-tree → state-content` обязателен (см. §2.4).

### 4.2 Deep-tracking через Proxy

`state-core.js:497-659` — модуль рекурсивно оборачивает `trackedProperties` в `Proxy`, чтобы любая мутация (включая `AppState.tables[id].cells[r][c] = ...` или `node.children.push(...)`) триггерила `StorageManager.markAsUnsaved()`.

Реализация — функция `_wrapDeep(value)` (`state-core.js:526-565`): trap'ы `get` (lazy-wrap на первом обращении), `set` (вызывает `_notifyDirty` при реальной смене значения), `deleteProperty`. Кэш через `_stateProxyCache: WeakMap` для стабильности ссылок. Детали — см. state-core.js:526-565.

**Гарантии:**

- `_isTrackable` (`:505-513`) исключает `Node`, `Date`, `RegExp`, `Map`, `Set`, `WeakMap`, `WeakSet` — у них собственная семантика.
- `_stateProxyCache: WeakMap` обеспечивает стабильность ссылок (повторный `get` той же ветки возвращает тот же proxy).
- `_stateProxyOriginals: WeakSet` ловит повторную обёртку proxy → proxy.

### 4.3 Bootstrap-race

`_initStateTracking` (`state-core.js:639-659`) вызывается на `DOMContentLoaded` через `setTimeout(..., 0)` — это ставит обёртку в очередь после всех module-level `Object.assign(AppState, ...)`. Гарантия: к моменту обёртки `AppState` уже содержит все методы.

Но bootstrap-структура дерева (создание дефолтных секций 1–5 в `app.js`) выполняется до загрузки данных акта и тоже триггерит `markAsUnsaved`. Поэтому `App.init()` (`app.js:61`) **первым делом** вызывает `StorageManager.disableTracking()`; tracking повторно включается после `loadActContent` + `markAsSyncedWithDB()` с задержкой `AppConfig.timings.enableTrackingAfterLoad=500ms`.

### 4.4 Pinned tables (metrics/risk)

В дереве конструктора некоторые таблицы **закреплены** вверху children-массива:

Подвид таблицы — единое enum-поле `node.kind` (`table-kind.js`, 7 значений), а не набор boolean-флагов `is*Table` (убраны в kind-рефакторе):

- Metrics-таблицы: `kind='metrics'` (метрики пункта `5.X`), `kind='mainMetrics'` (сводная раздела 5).
- Risk-таблицы: `kind ∈ {'regularRisk', 'operationalRisk', 'taxRisk', 'otherRisk'}`.
- `kind='regular'` (или отсутствие поля) — обычная таблица, не закреплена.

API:

| Метод | Где | Что делает |
|---|---|---|
| `TreeUtils.isPinnedTable(node)` | `tree/tree-utils.js:313-315` | Делегирует `table-kind.js`: `node.type==='table' && node.kind !== 'regular'` |
| `AppState._getFirstNonPinnedIndex(parent)` | `state/state-tree.js:739-745` | Возвращает индекс первого нон-pinned ребёнка (точка вставки) |
| `TreeUtils.findRiskTables(node, {firstOnly})` | `tree/tree-utils.js:330-351` | Единая утилита; учитывает **все 4 риск-подвида** (`regularRisk`/`operationalRisk`/`taxRisk`/`otherRisk`) через `table-kind.js::isRiskTable` — все полноправные риски (формируют/удерживают сводные, блокируются от перемещения за §5) |

**Защита от drag:** `tree-drag-drop.js:106-111` — при `dragstart` если `_hasRiskTablesInSubtree(node) && !isUnderSection5(node)` → `e.preventDefault()` + Notification. Drop **перед** pinned заблокирован (`tree-drag-drop.js:234-247`).

### 4.5 Protected nodes (секции 1–5)

Создаются через `_createProtectedSection(id, label)` (`state-core.js:70-79`) с `protected:true, deletable:false`.

| Барьер | Где |
|---|---|
| API-страховка удаления | `state-tree.js:228-232` (`deleteNode` ловит `node.protected \|\| node.deletable === false`) |
| Каскад-исключение | `_deleteNodeUnchecked` (`state-tree.js:248`) пропускает проверку для каскадного удаления |
| Move-валидация | `state-tree.js:454-456` |
| CSS-класс | `tree-renderer.js:120-122` — `li.classList.add('protected')` |

### 4.6 MetricsRiskCoordinator

`state/metrics-risk-coordinator.js:27-141` — фасад над каскадной логикой metrics ↔ risk. Принципиально:

1. Полная экстракция reconcile-логики из `state-content.js` / `state-tree.js` / `context-menu-tree.js` / `tree-drag-drop.js` признана **слишком рискованной без e2e-покрытия** — известный технический долг. Coordinator — единая точка входа в каскад, но реализация делегирована методам `AppState`.
2. **Snapshot/rollback safety**: каждый хук обёрнут в `_withSnapshot(name, fn)` (`:63-76`), который делает shallow JSON-копию §5 и `AppState.tables`, ловит исключение и откатывает.

Публичные хуки:

| Метод | Когда вызывается |
|---|---|
| `onRiskTableAdded(nodeId)` | Добавлена risk-таблица — создаёт metrics на 5.X (если risk на 5.X.Y+) и main metrics в §5 |
| `onSubtreeMoved(draggedNode, oldAncestor5x)` | Поддерево перемещено внутри §5 — пересчитывает metrics для старого и нового предка 5.X |
| `onRiskTableRemovedWithDeletion(deleteFn)` | Удаление риск-узла под единым snapshot'ом: snapshot §5 снимается ДО `deleteFn()`, поэтому откат при сбое reconcile восстанавливает и сам риск-узел (D1) |

Все callsite'ы каскада (`state-tree.deleteNode`, `state-tree.moveNode`, context-menu, drag-drop) обязаны идти через coordinator — раньше часть кода звала `AppState._...AfterRiskTableDeleted` напрямую, что порождало partial-state при exception'е.

---

## 5. `StorageManager` и persistence

`constructor/storage-manager.js` (699 строк) — менеджер двухуровневого хранилища: localStorage (быстро, локально) + БД через `APIClient.saveActContent` (медленно, надёжно).

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

Единое поле `_state ∈ {'saved'|'local-only'|'unsaved'}` (`storage-manager.js:33-45`). Зеркала `_hasUnsavedChanges` и `_isSyncedWithDB` (`:53, :61`) сохраняются только для backward-совместимости со старыми консьюмерами (beforeunload-warning, `hasUnsavedChanges()`); единая точка перехода — `_setState(newState)` (`:284-295`).

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

`_setupNavigationInterception()` (`storage-manager.js:183-273`) защищает от навигации с несохранёнными изменениями двумя слоями:

1. **`popstate`-страж** — `history.replaceState({_lockNavGuard:true}, ...)` плюс `history.pushState`. Перехватывает «Назад» в браузере и предлагает диалог сохранения.
2. **Click-handler на `<a href>` с внутренним hostname** — захватывает клик до навигации, показывает диалог.

`confirmNavigation(targetUrl, opts)` (`:653-669`) — публичный API: показать диалог «Сохранить и уйти / уйти без сохранения / отменить», вернуть Promise<bool>. Используется в `LockManager._lockAct` (на 409), `acts-menu.js` (при switch'е акта).

`allowUnload()` — снимает `_lockNavGuard`, разрешая `window.location.href = ...` без диалога. Вызывается в `LockManager._initiateExit` (`lock-manager.js:658-660`) — сессия завершается принудительно, диалог здесь блокировал бы автоэкзит.

### 5.4 ChangelogTracker

`constructor/changelog-tracker.js` (160 строк) — гранулярный аудит-лог локальных операций. Операции:

| Источник | Операции |
|---|---|
| `state-tree.js` | `add_node`, `delete_node`, `move_node`, `tb_change`, `invoice_set`, `invoice_remove` |
| `state-content.js` | `add_table` |

Persistence: `localStorage['act_changelog_{actId}']` (`:21`), debounce 1s (`:108-132`), MAX 500 entries (`:10, 48-50`).

**`flush()`** (`:83-102`) — собирает все pending записи, возвращает массив. Вызывается в `LockManager._initiateExit` (`lock-manager.js:682-687`) и прикрепляется к телу `PUT /content` (`data.changelog = changelog`) — серверная аудит-запись синхронна с фактическим сохранением, без отдельного запроса.

**`destroy()`** (`:139-156`) — полный сброс при switch'е акта. `acts-menu.js:377-380` делает `destroy() → init(actId)`.

### 5.5 LifecycleHelper

`constructor/lifecycle-helper.js` (58 строк) — единый реестр `beforeunload`-обработчиков (`Map<name, handler>`). Без него каждый менеджер вешал бы свой listener на `window.addEventListener('beforeunload', ...)`, что усложняет снятие.

API: `registerBeforeUnload(name, handler)`, `unregister(name)`, `list()`. Использует `lock-manager.js` (имя `'lock:manual-unlock'`) и `storage-manager.js` (имя `'storage:warn-unsaved'`).

---

## 6. `LockManager` и inactivity

`constructor/lock-manager.js` (646 строк) — клиентская часть оптимистичного блока актов. Слежение за бездействием вынесено в `InactivityWatchdog` (`constructor/inactivity-watchdog.js`), `LockManager` использует его композицией (§6.1). На бэке блокировка — ключ Redis `lock:act:{act_id}` с TTL, не поля `acts` (dev-guide §10.4). На фронте:

| Цикл | Что делает |
|---|---|
| **Init** | `_loadConfig` → `_lockAct` (POST /lock) → activity-tracker → heartbeat → beforeunload → visibilitychange |
| **Heartbeat** | Каждые `inactivityCheckIntervalSeconds` секунд (`setInterval` в `_startAutoExtension`), если активность была — `_extendLockSafely` (POST /extend-lock) |
| **Inactivity** | При превышении `inactivityTimeoutMinutes` минут без активности — диалог «Продолжить?» с countdown'ом; нет ответа → autoExit |
| **Exit** | `_initiateExit(action)` — save + unlock + redirect `/acts` |

### 6.1 Состояние

`lock-manager.js:9-29`. Все поля **static** (LockManager используется как singleton-class):

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

`_lockAct()` (`lock-manager.js`):

- 409 → 403/...: показать диалог с username владельца, `error.code === 'act-locked'` и `error.extra?.locked_by` (контракт envelope `{detail, code, extra}` из `api.js`); fallback на regex по `error.detail` для старых non-AppError ответов (`lock-manager.js:180-183`).
- После диалога — `confirmNavigation('/acts')` если StorageManager доступен, иначе жёсткий редирект (`lock-manager.js:196-202`).
- 5xx → диалог «Ошибка блокировки», редирект (`:206-225`).

### 6.3 Heartbeat с retry

`_extendLock` (`lock-manager.js:256-288`) делит ответы на два класса: 4xx — лок потерян, сразу выход; 5xx/network — transient, можно ретраить.

`_extendLockSafely` (`:295-314`) копит подряд-неудачи до `_MAX_EXTEND_FAILURES=3` (`:246`). Транзиентный DNS/proxy reset не выкидывает пользователя сразу — retry на следующем тике.

### 6.4 Inactivity-диалог с Date.now-countdown

`_handleInactivity(minutesInactive)` (`lock-manager.js:548-639`):

1. **Capture actId**: `const capturedActId = this._actId;` ДО `await dialogPromise`. Закрывает кейс «switch актов во время открытого диалога inactivity».
2. **Deadline по Date.now**: `const deadline = Date.now() + timeoutSeconds * 1000`. `setInterval(250ms)` обновляет UI countdown'а, решение об exit принимается по `Date.now() >= deadline` — устойчиво к Chrome background throttling (`setTimeout/setInterval` в фоне throttle'ятся до ~раза в минуту, decrement-counter разъезжается с реальностью).
3. **Orphan-protection**: после `await dialogPromise` проверяется `this._actId !== capturedActId || this._isExiting` — если за время ожидания состояние изменилось, ветка extend/exit не выполняется.
4. **Программный close**: handler `close` сохраняется в `_inactivityDialogClose` (через `onMount`), чтобы `_closeInactivityDialog()` мог программно закрыть overlay при autoExit'е — иначе диалог «висит» поверх редиректа.

### 6.5 visibilitychange

`_handleVisibilityChange()` (`lock-manager.js:487-518`) реагирует на возврат вкладки из фона:

- **Случай A**: диалог открыт и `Date.now() >= _inactivityDialogDeadline` → немедленный `_closeInactivityDialog()` + `_initiateExit('autoExit')`.
- **Случай B**: диалога нет, но `idleMs >= inactivityTimeoutMinutes*60*1000` → сразу autoExit без промежуточного диалога. Лок мог уже истечь сам по TTL (`lockDurationMinutes`, ключ Redis без отдельного снятия); спрашивать «остаться?» бессмысленно — extend упадёт 4xx → fatal → exit.

Никаких HTTP-запросов в visibility-handler'е не делается; решение принимается локально по `Date.now()`.

### 6.6 beforeunload и beacon-unlock

`_setupBeforeUnload()` (`lock-manager.js:391-416`):

- Регистрируется через `LifecycleHelper.registerBeforeUnload('lock:manual-unlock', ...)`.
- Игнорирует beacon при `_isExiting || _manualUnlockTriggered || !_actId` (избегаем дубликата с `_initiateExit`).
- `navigator.sendBeacon(unlockUrl, blob)` — гарантирует доставку даже при закрытии вкладки.
- В `finally` всегда вызывает `destroy()` — снимает 4 listener'а на document плюс активные интервалы (иначе при back-button оставались).

### 6.7 Идемпотентный exit с fallback

`_initiateExit(action)` (`lock-manager.js:645-758`) — единственная точка выхода из сессии. Сигнатура и ключевой инвариант:

```js
static async _initiateExit(action) {
    if (this._isExiting) return this._exitPromise;  // идемпотентность
    this._isExiting = true;
    this._closeInactivityDialog();  // ДО destroy, иначе handle обнулится
    // далее: destroy → allowUnload → save (+changelog flush) → unlock → жёсткий редирект
    // детали — см. lock-manager.js:645-758
}
```

Что важно помнить:

- **Идемпотентность**: повторный вызов отдаёт тот же promise.
- **Fallback на `window.currentActId`**: страхует, если `_actId` уже сброшен после `destroy()` (`:662`).
- **Save идёт с `ChangelogTracker.flush()`** — одной транзакцией на сервере (`:682-687`).
- **Редирект жёсткий, без `confirmNavigation`** — сессия закрывается принудительно. Если save упал (409 при чужом локе), `confirmNavigation` показал бы «Несохранённые изменения. Уйти?» и заблокировал бы выход. `allowUnload()` снимает страж явно (`:751`).
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

`constructor/tree/tree-core.js:449` — `const treeManager = new TreeManager('tree')` (top-level const, не `window`). Координирует `TreeRenderer`, `TreeDragDrop`, `TreeContextMenu`.

`TreeRenderer` (`tree/tree-renderer.js`):

- `render(node = AppState.treeData)` — полный rebuild контейнера `#tree`. Тяжёлая операция; вызывается из 5 точек (см. §7.5).
- **Точечные публичные API** (заменяют полный `render()`):
  - `updateInvoiceBadge(node)` (`tree-renderer.js:486-496`) — subscriber `node:invoice-changed`. Снимает старый бейдж, ставит новый.
  - `updateTbBadge(node)` (`:627-653`) — обновляет узел и всех родителей под §5 (computed TB вверх по дереву).

### 7.3 TreeUtils (object literal)

`tree/tree-utils.js:7` — `const TreeUtils = {...}`. Не класс, не singleton-instance — **plain object**. Ключевые функции:

| Метод | Назначение |
|---|---|
| `findNodeById(id, node?)` | Поиск узла, default root = `AppState.treeData` |
| `findParentNode(id)` | Родитель узла |
| `isUnderSection5(node)` | Проверка попадания узла под §5 (через путь номеров) |
| `isPinnedTable(node)` (`:313-315`) | Делегирует `table-kind.js`: `kind !== 'regular'` |
| `isTbLeaf(node)` | Узел может иметь чекбокс TB |
| `findRiskTables(node, {firstOnly})` (`:330-351`) | Единая утилита; учитывает **все 4 риск-подвида** (включая `otherRisk`) через `table-kind.js::isRiskTable` |

### 7.4 ItemsRenderer и `_domIndex`

`items/items-renderer.js` (987 строк). Static class, не имеет singleton-instance.

**`_domIndex: Map<string, HTMLElement>`** (`items-renderer.js:16`) — индекс адресуемых DOM-узлов, ключи вида `item:${nodeId}`, `table:${tableId}` и т.п. Заполняется в `_createItemContainer/renderTable`, очищается в начале `renderAll()` и при удалении узлов.

Per-node API (вместо полного `renderAll()`):

| Метод | Когда вызывать | Fallback |
|---|---|---|
| `updateItem(nodeId)` (`:47-71`) | После структурных изменений в пределах одного узла (add/delete child, move) | `renderAll()` если узел не в `_domIndex` или `AppState` |
| `updateTable(tableId)` (`:77-...`) | Только пересоздать table-section, сохраняя размеры колонок | `renderAll()` |
| `updateTextBlock(blockId)` | Пересоздать textblock | `renderAll()` |
| `updateViolation(violationId)` | Пересоздать violation-карточку | `renderAll()` |
| `updateNodeTitle(nodeId)` | Только заголовок узла | — |

Также:

- `_updateTbBadgeInItems(badge, node)` (`:553-567`) — апдейт чекбокса TB в шаге 2.
- `_updateParentTbInItems(node)` (`:574-...`) — каскад вверх.
- Обратной синхронизации DOM → AppState нет: ввод в ячейку таблицы пишется в состояние сразу (write-through, `table/cell-write-through.js`), текстблоки и rich-поля нарушений — через debounce/blur-коммит своей поверхности (`EditorController`/`finalizeEdit`, deep-dive §15 в `textblock-editor-architecture.md`).

### 7.5 `renderAll` — оставшиеся call-sites

Полный `treeManager.render()` (тяжёлый rebuild всего `#tree`):

| Точка | Контекст |
|---|---|
| `app.js:134` | Bootstrap при `App.init()` |
| `items/items-title-editing.js:114, 167, 295` | После inline-редактирования заголовков |
| `context-menu/context-menu-tree.js:481` | `updateTreeViews(scopeNodeId)` — fallback для каскадных операций (без `scopeNodeId`) |

Полный `ItemsRenderer.renderAll()` (`#itemsContainer`):

| Точка | Контекст |
|---|---|
| `app.js:301` | Bootstrap шага 2 |
| `items-renderer.js:809` | Внутренний rebuild при сложной операции |
| `context-menu/context-menu-tree.js:487` | Каскадный fallback |
| `tree/tree-drag-drop.js:355` | После DnD, если не удалось определить старого/нового родителя |

Прочее (`updateXxx`-методы внутри items-renderer.js, `table-core.js:57 renderAll`, `context-menu-cells.js:809 tableManager.renderAll`) — это локальные rebuilds, не полные.

### 7.6 Event-driven моменты

Конструктор почти не использует CustomEvent через `dispatchEvent`:

- `header/preview-menu.js:257, 269` — `preview-menu:opened` / `preview-menu:closed`. **Потребителей в конструкторе нет.**

Основная event-шина — `window.ChatEventBus` (опубликован модулем чата в `shared/`). Конструктор использует её **как общий event bus** — явно прокомментировано в `state-tree.js:884-885`:

**Эмиттеры:**

| File:Line | Событие | Контекст |
|---|---|---|
| `state/state-tree.js:886` | `node:tb-changed` | `AppState.setNodeTb(nodeId, abbr, checked)` |
| `state/state-tree.js:925` | `node:invoice-changed` | `AppState.setNodeInvoice(nodeId, invoiceData, opts)` |

Оба через `window.ChatEventBus?.emit?.(...)` (optional chaining — emit срабатывает даже если чат не загружен).

**Подписчики:**

| File:Line | Событие | Действие |
|---|---|---|
| `tree/tree-renderer.js:19-22` | `node:invoice-changed` | `this.updateInvoiceBadge(node)` |
| `tree/tree-renderer.js:25-28` | `node:tb-changed` | `this.updateTbBadge(node)` — обновляет бейдж текущего узла + всех родителей под §5 |
| `items/items-renderer.js` (module-level) | `node:tb-changed` | `ItemsRenderer._updateTbBadgeInItems` + `_updateParentTbInItems` — обновляет селектор ТБ на шаге 2 |

Подписчики ставятся на module-level при загрузке файлов. ChatEventBus используется как универсальная шина, optional chaining (`window.ChatEventBus?.on?.(...)`) защищает на случай, если шина не загружена. Callsite'ы (TB-чекбокс в дереве и в items) только дёргают `AppState.setNodeTb` — каскадное обновление badge'ей делают подписчики.

---

## 8. `PreviewManager`

`constructor/preview/preview.js` (356 строк) — рендер финальной версии акта в правую панель (шаг 1) или в overlay version-preview. Static class. Per-type renderer'ы (`preview-table-renderer.js`, `preview-textblock-renderer.js`, `preview-violation-renderer.js`) — рядом в той же папке.

### 8.1 RAF-дедупликация (`update`)

`preview.js:23-46`:

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

`preview.js:69-75`:

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

`update` и `scheduleTyping` — взаимозаменяемые для callsite'а: тяжёлая структурная операция (add/delete table) использует `update` (немедленный RAF), typing-flow — `scheduleTyping` (debounce).

---

## 9. Диалоги

### 9.1 DialogBase

`shared/dialog/dialog-base.js` (438 строк) — базовый класс модалок. Все диалоги в системе **обязаны** наследоваться от него, чтобы получить focus-trap, ARIA, ESC-handling и стек.

**Возможности (`shared/dialog/dialog-base.js`):**

| Что | Где |
|---|---|
| `_activeDialogs: HTMLElement[]` | `:16` — стек overlay'ев для вложенных диалогов |
| `_createOverlay()` | `:23-27` |
| `_FOCUSABLE_SELECTOR` | `:35-42` — `a[href]`, `button:not([disabled])`, input/textarea/select без disabled, `[tabindex]` без `-1` |
| `_setupFocusTrap(overlay)` | `:74-105` — Tab на последнем focusable → first; Shift+Tab на первом → last. Trap работает **только** на верхнем диалоге стека |
| `_setupEscapeHandler(overlay, onClose)` | `:255-...` — ESC закрывает топовый overlay (`_activeDialogs[length-1] === overlay`) |
| `_setupOverlayClickHandler(...)` | `:233-...` — клик по overlay вне dialog'а → close |
| `_lockBodyScroll() / _unlockBodyScroll()` | `:287-...` — `overflow:hidden` на `<body>` пока есть открытые диалоги |
| `_showDialog(overlay, dialog)` | `:115-...` — навешивает `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, focus-trap, сохраняет `_previousFocus` |
| `_hideDialog(overlay, delay=closeDelay)` | `:185-...` — снимает trap, восстанавливает фокус |
| `_createElement(tag, attrs, text)`, `_createButton(...)`, `_cloneTemplate(id)` | DOM-хелперы |
| `_fillField(...)` / `_fillFields(element, data)` | `:392-413` — заполнение полей по `data-field` атрибуту |
| `getActiveDialogsCount()` | `:419-421` |
| `closeAllDialogs()` | `:426-434` — копия `_activeDialogs` для безопасной итерации |

### 9.2 DialogManager (confirm/alert)

`shared/dialog/dialog-confirm.js` (296 строк) — `extends DialogBase`. Promise-based confirm/alert:

```js
const ok = await DialogManager.show({
    title, message, icon, type: 'warning'|'danger'|'info',
    confirmText, cancelText, hideCancel: bool,
    allowEscape: bool, allowOverlayClose: bool,
    onMount: ({overlay, close}) => { ... }
});
```

`onMount` хук используется `LockManager._handleInactivity` (`lock-manager.js:568-603`) для получения handle к программному `close()` диалога — чтобы при autoExit'е programmatically закрыть overlay без user-click'а.

### 9.3 Крупные диалоги конструктора

| Диалог | File | LOC | Особенности |
|---|---|---|---|
| `InvoiceDialog` | `constructor/dialog/dialog-invoice.js` | 773 | Кеши справочников (метрики, процессы, БП-таблицы), TTL 15min, AJAX-валидация. Виджет автодополнения вынесен в `InvoiceAutocomplete` |
| `InvoiceAutocomplete` | `constructor/dialog/invoice-autocomplete.js` | 359 | Вынесен из `InvoiceDialog` (§6 п.8 аудита): 4 searchable-dropdown (таблицы/метрики/процессы/подразделения). Состояние остаётся в `InvoiceDialog`, передаётся параметром — без generic-абстракции |
| `HelpManager` | `constructor/dialog/dialog-help.js` | 229 | extends DialogBase; параллельная иерархия (известный технический долг). Init на `DOMContentLoaded` (`:227-229`) — без него кнопка help не привяжется |

### 9.4 Крупные диалоги portal

| Диалог | File | LOC | Особенности |
|---|---|---|---|
| `CreateActDialog` | `portal/acts-manager/dialog-create-act.js` | 1735 | Сложная форма: КМ-валидация, секции из API, team-members с autocomplete, поручения |
| `AuditLogDialog` | `portal/acts-manager/dialog-audit-log.js` | 732 | Два таба (Лог/Версии), `FilterEngine` для фильтров, load-more 50/стр. |
| `VersionPreviewOverlay` | `portal/acts-manager/version-preview.js` | 337 | extends DialogBase; 3 режима (UI/JSON/Diff) через `DiffEngine` + `DiffRenderer` |
| `AdminAddUserDialog` | `portal/admin/admin-add-user-dialog.js` | 239 | Search → выбор → assign |
| `CkProcessPicker` | `shared/ck/ck-process-picker.js` | 173 | Popup выбора БП для CkForm |

### 9.5 HelpManager через DialogBase

`HelpManager` (extends DialogBase) показывает существующий в DOM `<div id="helpModal">` через `DialogBase._showDialog(modal, {appendToBody: false})`. Опция `appendToBody: false` сообщает DialogBase, что overlay уже в DOM и не нужно его добавлять/удалять — только показать/скрыть через классы `.visible`/`.hidden`. Это даёт HelpManager:

- Единый стек `_activeDialogs` (вложенность с другими диалогами работает корректно).
- `aria-modal`, `role="dialog"`, `aria-labelledby` автоматически.
- Focus-trap + восстановление `_previousFocus` при закрытии.
- ESC через общий `EscapeStack` (см. §6.7 EscapeStack).
- Lock body scroll.

Раньше HelpManager имел свой `_showModalHelp` / `_currentModal` — отдельная иерархия, без focus-trap. Теперь унифицирован.

---

## 10. Acts manager и кросс-доменная навигация

### 10.1 ActsManagerPage

`portal/acts-manager/acts-manager-page.js` (785 строк) — главная страница `/acts`. Координирует:

- Загрузку списка актов через `GET /api/v1/acts/list` (фильтрация по статусу/КМ/датам).
- Карточки актов из template'а `acts_card.html` (`_cloneTemplate` + `_fillFields` из DialogBase).
- Действия `open` / `edit` / `history` / `duplicate` / `delete` — с проверкой роли пользователя в команде акта.
- Cross-tab subscribe на `ActsBroadcast` — событиях `act:deleted/duplicated/updated` инвалидирует и перезагружает список.
- Перехват `CreateActDialog._closeDialog` через `safeClose` — обвязка, чтобы после успешного создания/редактирования сразу обновить список.

### 10.2 Role-checks (роль «Участник»)

`acts-manager-page.js:354-430` — кнопки `edit`/`delete` **скрываются** (`hidden = true`) для роли «Участник»:

```js
const canEdit = act.user_role !== 'Участник';
if (!canEdit) {
    if (editBtn) editBtn.hidden = true;
    if (deleteBtn) deleteBtn.hidden = true;
}
```

Дополнительно при клике (на случай гонок состояния) — `Notifications.warning('Редактирование недоступно для роли "Участник"')`.

- **Дублирование** — доступно всем; Участник станет Редактором в новом акте (`:408-409`).
- **История** — только Куратору/Руководителю (`:397`).

Серверная страховка — `require_domain_access('acts')` плюс role-check в `app/domains/acts/services/permissions.py`; UI-логика выше — UX-слой.

### 10.3 BroadcastChannel `'acts'`

`portal/acts-manager/acts-broadcast.js` (36 строк) — `ActsBroadcast.CHANNEL = 'acts'`. События `act:deleted`, `act:duplicated`, `act:updated`.

Использование:
- `acts-manager-page.js:619-620, 683-684, 731-737` — notify на duplicate/delete; subscribe → `loadActs()`.
- Сценарий: открыто две вкладки `/acts`, удалили акт в одной → вторая инвалидирует и перезагружается.

Подключается **и в конструкторе** через `acts-menu.js` (`base_constructor.html:163`) — бургер-меню актов в конструкторе тоже реагирует на cross-tab события.

Fallback: если `BroadcastChannel` недоступен (старый Safari), модуль логирует `console.warn` и работает no-op (`acts-broadcast.js:14`).

### 10.4 Cross-zone зависимость: portal → constructor

`templates/portal/acts-manager/acts_manager.html:46` подключает `static/js/constructor/lock-manager.js` — портальная страница использует constructor's `LockManager` для редактирования **метаданных** акта (через `CreateActDialog` в edit-режиме) без открытия конструктора. Сценарий:

1. Юзер на `/acts` нажимает «Редактировать» (карандаш).
2. `ActsManagerPage.editAct(actId, status)` — `LockManager.init(actId)` берёт лок.
3. Открывается `CreateActDialog` в edit-режиме (форма метаданных без contents).
4. На submit / close — `LockManager.manualUnlock()` снимает лок.

Это единственная cross-zone зависимость: `portal/` импортирует один файл из `constructor/`. Документируем явно — без неё рефакторинг папок может сломать edit-flow.

### 10.5 `portal.css` подсасывает `constructor/preview/*`

Аналогично — `static/css/entry/portal.css:22-25` импортит `constructor/preview/{preview-base, preview-table, preview-typography, preview-violation}.css` для `VersionPreviewOverlay`, который реюзает preview-renderer'ы конструктора.

### 10.6 Diff engine

`portal/acts-manager/diff-engine.js` (641 строка) — чистый utility без DOM. `DiffEngine.compute(oldData, newData)` возвращает `{tree, tables, textblocks, violations, invoices, hasChanges}`.

- `_diffTree` — flatten оба дерева в map по id, `node._diff = added/modified/unchanged`.
- `_diffTables` — cell-level (row × col matrix).
- `_diffTextBlocks` — word-level через LCS на `Uint16Array`, fallback на coarse-diff если `m*n > 250000`.
- `_diffViolations` — поле-за-полем (включая `descriptionList`/`additionalContent`).
- `_diffInvoices` — поле-за-полем по `INVOICE_DIFF_FIELD_KEYS` (`portal/acts-manager/invoice-diff-fields.js`, новый shared-модуль с списком полей и подписей — переиспользуется `diff-renderer.js` для `INVOICE_FIELD_LABELS`).

`portal/acts-manager/diff-renderer.js` (687 строк) — DOM-рендер с подсветкой.

---

## 11. Безопасность и санитизация

### 11.1 SafeHTML (frontend)

`shared/sanitize.js` (296 строк) — единый wrapper над `window.DOMPurify` (`static/vendor/dompurify/purify.min.js`):

```js
window.SafeHTML = { set, sanitize, escapeHtml };
```

**`SafeHTML.set(el, html, extraConfig?)`** — основной API. Если `DOMPurify` загружен: `el.innerHTML = DOMPurify.sanitize(...)`; иначе fallback на `el.textContent = ...` (безопасно — не raw HTML) с warn-once-логом.

**Конфигурация (`DEFAULT_CONFIG`, `sanitize.js:17-38`):**

- Дефолт-профиль (blocklist, используется чатом/diff-renderer): `USE_PROFILES: { html: true }` (SVG/MathML отключены), `FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button']`, `FORBID_ATTR` — полный список 60+ inline event-handlers (`onerror`, `onclick`, и т.п.).
- Профиль `'acts'` (strict allowlist, используется рендером текстблоков конструктора И rich-полей нарушений): `ALLOWED_TAGS`/`ALLOWED_ATTR`, зеркальные бэк-whitelist'у `html_sanitizer.py` (включая `s/strike/del` и data-атрибуты ссылок/сносок). Вызов: `SafeHTML.set(el, html, 'acts')`; основной sink rich-контента — обёртка `renderActContent(el, html)` (`sanitize.js:292`). Состав закреплён стражем `tests/js/sanitize-profiles.test.mjs`.
  - **Allowlist CSS-свойств для inline-`style`.** Профиль `'acts'` дополнительно фильтрует атрибут `style`, оставляя только свойства из `ACTS_CSS_PROPERTIES` (`font-size`, `color`, `background-color`, `font-weight`, `font-style`, `text-decoration`, `text-decoration-line`, `text-align`) — **зеркало бэкендового allowlist'а**. Реализация — хук `afterSanitizeAttributes` + модульная переменная активного allowlist'а, выставляемая на время синхронного `DOMPurify.sanitize` (реентрантности нет; кастомный ключ конфига в хук-арг DOMPurify надёжно не пробрасывается). Без этого превью показывало бы инлайн-CSS (`font-family`/`position`/`display`/…), который бэк потом срезает → расхождение превью ↔ сохранённого акта/экспорта.
  - **Рантайм-синхронизация с бэком**: хардкод-списки — фолбэк; источник истины — `applyActsAllowlist(cfg)` (`sanitize.js:91`) по данным `GET /acts/limits` (секция sanitizer, из `ACTS__SANITIZER__*`), с диагностикой дрейфа `_warnIfDrift`. Известное расхождение: DOMPurify не умеет per-tag политику style (у бэка div/p несут только `text-align`) — превью может показать `font-size` на `div`, который бэк снимет на save.

**Потребители**: `textblock-editor.js`, `violation-core.js`, `violation-field-surface.js`, `preview-violation-renderer.js`, `preview-textblock-renderer.js`, `diff-renderer.js`, `formalizer-popover.js`, `chat-renderer.js`. Все `innerHTML`-sink'и в коде обязаны идти через `SafeHTML.set`/`renderActContent` или (если HTML заведомо безопасен) через `textContent` напрямую.

### 11.2 bleach + nh3 (backend)

Defense in depth: на бэке HTML-поля акта проходят повторную санитизацию перед записью в БД — даже если фронтовый SafeHTML обойдут, script-tag не сохранится. С PR #37 движка два (`app/domains/acts/utils/html_sanitizer.py`): `sanitize_html` (bleach) — `textBlocks[*].content` и узлы дерева; `sanitize_rich_html` (nh3) — rich-поля нарушений, состав по флагу `rich` реестра `violation_fields.py`. Allowlist общий (`ACTS__SANITIZER__*`). Ячейки таблиц — verbatim (Фаза 2 не реализована). Детали — §9.3 в [`textblock-editor-architecture.md`](textblock-editor-architecture.md) и dev-guide §10.6a.

### 11.3 Security headers (CSP enforce + nonce)

Класс `SecurityHeadersMiddleware` в `app/core/middleware.py` (единый модуль, не директория) подключает 5 заголовков в **enforce-режиме** (`csp_report_only=False`) + 6-й (`Strict-Transport-Security`) условно при HTTPS:

- `Content-Security-Policy` — enforce. `script-src 'self' 'nonce-{nonce}'` **без** `'unsafe-inline'`: на каждый http-запрос middleware генерит свежий `secrets.token_urlsafe(16)`, кладёт в `scope["state"]["csp_nonce"]` (шаблоны читают через `request.state.csp_nonce`) и подставляет в плейсхолдер `{nonce}` директивы `script-src` при сборке заголовка. Один и тот же nonce уходит в заголовок и в state → совпадение по построению. Инъектированные inline-скрипты блокируются, легитимные init-блоки с верным `nonce`-атрибутом исполняются.
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: ...`
- `X-Frame-Options: SAMEORIGIN`
- `Strict-Transport-Security` — только при HTTPS-соединении (условный 6-й).

**Inline-скрипты под nonce** — единственные исполняемые inline-блоки: init-`<script type="module">` в 5 шаблонах (`base_constructor.html`, `acts_manager.html`, `admin.html`, `_ck_layout.html`, `landing.html`), каждый импортирует page-модуль через `url_for(...) | versioned`. Подход «nonce, а не вынос в .js» выбран сознательно — сохраняет proxy-aware версионируемые import-пути под JupyterHub-proxy (вынос потерял бы версионирование и рискнул бы 404). Внешние `<script src>` (DOMPurify, entry-модули) покрыты `'self'` — nonce не требуют. Inline-обработчиков `onclick/onchange` в шаблонах нет (0).

**`style-src 'self' 'unsafe-inline'` оставлен осознанно** — вынос inline-стилей отдельный несоизмеримый объём (follow-up). Деталь решения — `docs/reports/2026-06-12-constructor-backlog-решения-тимлида.md` (раздел CSP).

### 11.4 Error boundary

`shared/error-boundary.js` (121 строка). Перехватывает:

- `window.addEventListener('error', ...)` — синхронные ошибки.
- `window.addEventListener('unhandledrejection', ...)` — неперехваченные Promise rejection'ы.

На каждую ошибку:

1. `console.error('[GlobalError]'|'[UnhandledPromise]', ...)`.
2. `Notifications.error('Произошла непредвиденная ошибка. Обновите страницу.')` (если уже загружен).
3. `POST /api/v1/system/client-error` с rate-limit 5s (`REPORT_INTERVAL_MS = 5000`) и `keepalive: true` (отчёт уйдёт даже при закрытии вкладки).

Подключается через `<script defer>` **сразу** после `notifications.js` (`base_*.html`), чтобы успеть поймать ошибки инициализации остальных модулей.

### 11.5 Fetch timeout

`shared/api.js:889-914` — `_fetchWithTimeout(url, opts, timeoutMs=30000)`:

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

`shared/api.js:850-869, 921-955` — единый формат ошибок API:

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

- `constructor/lock-manager.js:181-182` — `error.code === 'act-locked'` + `error.extra?.locked_by`.

Других чтений `extra` нет — паттерн пока используется только LockManager'ом.

### 11.7 FastAPI 422 нормализация

`api.js:942-946` — `detail` от pydantic-валидаторов приходит как массив `[{loc, msg, type, ...}, ...]`. Без нормализации в UI прилетал `"[object Object]"`. Складываем в строку через `; ` (msg уже на русском).

### 11.8 PaginatedResponse

Бэк (`app/core/responses.py:14-27`) возвращает `{items, total, limit, offset}` для пагинированных эндпоинтов. Лимиты диапазоном `1..200`, дефолт `50`. Потребители на фронте: `dialog-audit-log.js`, `admin-audit-log.js`, `admin-roles.js`, ЦК-страницы.

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

- `static/css/entry/portal.css` — для всех portal-страниц (загружается в `base_portal.html:12`).
- `static/css/entry/constructor.css` — для редактора (загружается в `base_constructor.html:12`).

Третий entry `static/css/entry/shared.css` — реюзается `portal.css` через первый `@import './shared.css'`. Содержит базу (variables/reset/animations), shared-кнопки/уведомления/диалоги, shared-чат-стили.

### 13.2 Каскад constructor.css

```
@import './shared.css';
@import '../constructor/layout/*.css';                    # 6 файлов
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

≈49 файлов через каскад.

### 13.3 Каскад portal.css

```
@import './shared.css';
├── portal/layout/sidebar.css
├── shared/layout/settings-menu.css
├── portal/landing/landing.css
├── portal/acts-manager/{base, cards, team-member-search,
│                        audit-log-dialog, version-preview}.css
├── shared/dialog/acts-modal.css
├── constructor/preview/{preview-base, preview-table,
│                        preview-typography, preview-violation}.css  # см. §10.5
├── portal/admin/{admin-page, admin-search,
│                 admin-roles, admin-add-user}.css
└── portal/ck/{ck-page, ck-table, ck-form, ck-process-picker}.css
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

Все 580 переменных по-прежнему доступны под прежними именами — это пере-разбиение, не переименование. `@import` в CSS — runtime-каскад, порядок резолва значений не зависит от порядка @import.

### 13.5 Z-index map

Управляется через CSS-переменные (`--z-tooltip`, `--z-overlay`, `--z-modal`, `--z-popover`, `--z-modal-elevated`, `--z-popover-elevated`). Wave 3 ввёл `*-elevated`-уровни для вложенных диалогов поверх обычных модалок. Локальный `calc(var(--z-modal) + 1)` в нескольких CSS-файлах — потенциальная проблема пересечения с соседними layer'ами (известный технический долг, M-Z-CALC).

### 13.6 Cache-busting

Jinja-фильтр `versioned` (применяется ко всем `url_for('static', path='...')`) добавляет `?v={APP_VERSION}` к URL. `APP_VERSION` берётся из `app.core.config.Settings`. При смене версии браузер форсированно перезагружает статику.

### 13.7 `<meta name="app-version">`

`base_*.html:8` — `<meta name="app-version" content="{{ app_version }}">`. Бейдж версии в topbar и admin-diagnostics tab читают это значение.

---

## 14. Чат

Полный гайд по чат-фронту — [`docs/architecture/chat-frontend-architecture.md`](chat-frontend-architecture.md) (13 модулей, транспорт polling по шине, режимы inline/modal/popup, forward к внешнему агенту, типы блоков, ClientActionsRegistry, status state machine).

Здесь — только load-bearing **точки сцепки** с остальным фронтом:

### 14.1 `AppConfig.chatEndpoints`

См. §3.3. Все URL чата — в `app-config.js:112-133`, callsite'ы обязаны брать оттуда (`AppConfig.api.getUrl(AppConfig.chatEndpoints.messages(cid))`).

### 14.2 `ChatEventBus` — общий event bus

Хотя модуль чатовский, конструктор использует его как cross-module шину (§7.6). Эмиттеры: `node:invoice-changed`, `node:tb-changed` (`constructor/state/state-tree.js:886, 925`). Подписчики: `tree-renderer.js:19-22`.

### 14.3 `KNOWN_BLOCK_TYPES` — 3 места sync

Новый тип блока чата добавлять синхронно в **трёх** местах:

1. `MessageBlock` union в `app/core/chat/blocks.py` (Python).
2. `_DiscriminatedBlock` в `app/core/chat/schemas.py` (Python).
3. `KNOWN_BLOCK_TYPES` Set во фронте `static/js/shared/chat/chat-messages.js:17-27`.

Без бэка — `parse_message_blocks` не распознает. Без фронта — `ChatRenderer.renderBlock` упадёт на default-ветку с fallback-блоком («⚠ Блок неизвестного типа …»).

### 14.4 `ChatPopupManager` в конструкторе

`constructor/header/chat-popup.js` (219 строк) — lazy-init обёртка над `ChatManager` для всплывающего popup-чата в шапке конструктора. Static class. Не singleton-instance — отличие от popup'ов на portal (где `ChatModalManager`).

---

