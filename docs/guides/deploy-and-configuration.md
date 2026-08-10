# Деплой и конфигурация

> Часть гайд-бука разработчика Audit Workstation. Точка входа и навигация по всем частям — [`developer-guide.md`](developer-guide.md).

Запуск, авторизация, `.env` и Pydantic Settings, полный реестр переменных окружения, observability.
Нумерация разделов (§9) сохранена от единого гайд-бука — ссылки вида «§9.4» остаются валидными.


## Оглавление

- [9. Деплой и инфраструктура](#9-деплой-и-инфраструктура)
  - [9.1 Standalone (uvicorn)](#91-standalone-uvicorn)
  - [9.2 Деплой SDP (ПРОМ)](#92-деплой-sdp-пром)
  - [9.3 За reverse proxy (HTTPS)](#93-за-reverse-proxy-https)
  - [9.3a Авторизация (ОТП/JWT)](#93a-авторизация-отпjwt)
  - [9.4 Конфигурация: .env и Pydantic Settings](#94-конфигурация-env-и-pydantic-settings)
  - [9.5 Полная таблица переменных окружения](#95-полная-таблица-переменных-окружения)
  - [9.5a Observability: HTTP metrics и MetricsBatcher](#95a-observability-http-metrics-и-metricsbatcher)
  - [9.5b Diagnostics endpoint и `observability_registry`](#95b-diagnostics-endpoint-и-observability_registry)
  - [9.5c Audit-лог отказов доступа (`access_denied_audit`)](#95c-audit-лог-отказов-доступа-access_denied_audit)
  - [9.6 Retention bus-таблицы chat_agent_messages_bus](#96-retention-bus-таблицы-chat_agent_messages_bus)

---

## 9. Деплой и инфраструктура

### 9.1 Standalone (uvicorn)

Для локальной разработки:

```bash
# Способ 1: запуск как модуль (горячая перезагрузка; host/port/log_level
# берутся из SERVER__*, reload включён жёстко — app/main.py:486-500)
python -m app.main

# Способ 2: uvicorn напрямую
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Для production (без перезагрузки, **только один воркер**; порт — из `SERVER__PORT`,
на ПРОМе `8484`):

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8484 --workers 1
```

**Важно:** приложение разработано под single-worker деплой. На старте
lifespan захватывает singleton-блокировку в таблице
`{PREFIX}app_singleton_lock` (см. `app/core/singleton_lock.py`):
второй воркер этого же сервиса упадёт с понятным сообщением. Это
сознательное ограничение — process-level состояние
(`AgentChannelPoller` реестр подписок,
in-process locks сервисов) безопасно только при одном
процессе. Stale-lock (после kill -9) автоматически перезахватывается
через TTL=60с.

### 9.2 Деплой SDP (ПРОМ)

Текущий ПРОМ — SDP-кластер: приложение слушает свой порт, пользователи заходят
**по IP:порту напрямую** (пример: `http://10.110.10.38:8484`). Никакого
proxy-префикса нет — `root_path` приложение не вычисляет и не выставляет
(`grep -rn "root_path" app/` пусто), все пути живут от корня (`/api/v1/...`,
`/constructor`, `/admin`).

Соединение — **обычный HTTP, не HTTPS**: TLS-терминирующего прокси перед
приложением нет. Отсюда обязательное `AUTH__COOKIE_SECURE=false` (подробнее —
§9.3a, подраздел «Cookie и HTTP на SDP»).

**База — Greenplum, авторизация в БД по Kerberos.** Перед запуском нужен
валидный тикет; пользователь GP берётся из `JUPYTERHUB_USER` (только цифры до
первого `_`, `app/db/connection.py:213-218` — имя переменной историческое):

```bash
kinit            # ввести пароль
python -m app.main
```

**Ключевые строки `.env` на ПРОМе** (полный шаблон — `.env.prod` в корне репозитория):

```env
SERVER__HOST=0.0.0.0
SERVER__PORT=8484
LOG_FORMAT=json

DATABASE__TYPE=greenplum
DATABASE__GP__HOST=gp_dns_pkap1123_audit.gp.df.sbrf.ru
DATABASE__GP__PORT=5432
DATABASE__GP__DATABASE=capgp3
DATABASE__GP__SCHEMA=s_grnplm_ld_audit_da_project_34
DATABASE__TABLE_PREFIX=t_db_oarb_audit_act_

REDIS__HOST=10.110.10.38
REDIS__PORT=7474

AUTH__ENABLED=true
AUTH__COOKIE_SECURE=false
```

**Две схемы GP на ПРОМе — это норма, а не рассинхрон.** `DATABASE__GP__SCHEMA` =
`s_grnplm_ld_audit_da_project_34` — там живут **собственные таблицы приложения**
(acts, chat, admin, шина агента). Внешние по отношению к приложению данные лежат
в `s_grnplm_ld_audit_da_project_4` и адресуются своими настройками:
`UA_DATA__SCHEMA_NAME` (справочники UA), `CK_FIN_RES__SCHEMA_NAME` /
`CK_CLIENT_EXP__SCHEMA_NAME` (таблицы и вью ЦК),
`ACTS__INVOICE__HIVE_REGISTRY_SCHEMA` (реестр Hive-таблиц фактур),
`ADMIN__USER_DIRECTORY__SCHEMA` (каталог пользователей). «Выравнивать» `_project_34`
под `_project_4` (или наоборот) нельзя — сломается либо доступ к своим таблицам,
либо к справочникам.

**LLM на ПРОМе** — через Redis-мост (`CHAT__PROFILE=redis-bridge,gigachat`): с SDP
нет прямого сетевого доступа к площадке, где стоит модель, поэтому запросы
уходят воркеру через Redis. См. §9.4.1 и
[`../integrations/redis-llm-bridge.md`](../integrations/redis-llm-bridge.md).

### 9.3 За reverse proxy (HTTPS)

> На SDP такого прокси нет (см. §9.2) — раздел про сценарий, когда приложение
> ставят за TLS-терминирующий nginx.

`HTTPSRedirectMiddleware` (`app/core/middleware.py:30-49`, подключается в
`app/main.py:345`) переписывает `scope["scheme"]` в `https`, если пришёл
заголовок `x-forwarded-proto: https` или `x-scheme: https` — иначе `url_for()`
генерировал бы `http`-ссылки. Плюс к этому `SecurityHeadersMiddleware` добавляет
HSTS только на HTTPS-ответы (`SECURITY__HSTS_*`).

При таком деплое `AUTH__COOKIE_SECURE` нужно переключить в `true`.

**Nginx конфигурация:**

```nginx
server {
    listen 443 ssl http2;
    server_name audit.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:8484;  # SERVER__PORT приложения
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;  # для HTTPSRedirectMiddleware
        proxy_set_header X-Scheme https;
        proxy_buffering off;
    }
}
```

### 9.3a Авторизация (ОТП/JWT)

Модуль `app/auth/` — shared-инфраструктура, не домен (см. docstring `app/auth/__init__.py`): API-роутер подключается в `app/api/v1/routes.py` отдельным импортом (`from app.auth.router import router as auth_router`, а не через `app/api/v1/endpoints/`), HTML-страницы входа — через `app.auth.portal_router` в `create_app`, lifespan-hooks — через `register_lifespan_hooks()`.

| Файл | Роль |
|---|---|
| `router.py` | API `/api/v1/auth/*`: `POST request-otp`, `POST verify-otp`, `POST refresh`, `POST logout`, `GET me`, плюс аватар — `POST avatar`, `DELETE avatar`, `GET avatar/{username}` |
| `middleware.py` | `AuthMiddleware` — проверка JWT-cookie на каждый запрос, прозрачный refresh |
| `jwt_handler.py` | `JWTTokenHandler` — выпуск/валидация access+refresh токенов (PyJWT) |
| `user_repository.py` | `AuthUserRepository` — поиск пользователя по email в справочнике `admin.user_directory`, подгрузка ролей для профиля |
| `context.py` | `ContextVar` с username текущего запроса; читают батчеры метрик/аудита (`app/core/middlewares/http_metrics.py`) без похода в JWT/scope |
| `portal_router.py` | HTML: `GET /auth/login`, `GET /auth/logout`, `GET /profile` |
| `lifecycle.py` | `register_lifespan_hooks()` — поднимает/закрывает Redis-подключение (`app/core/redis.py`, общий слой — §9.5 «Redis») при старте/остановке. Безусловно, независимо от `AUTH__ENABLED`: Redis — общая инфраструктура, модуль auth лишь исторический владелец хука |

**Два режима (`AUTH__ENABLED`):**

- **`false` (тест-режим, дефолт).** Авторизации нет: username берётся из окружения (`JUPYTERHUB_USER`, имя переменной историческое) через `resolve_env_username()` (`app/auth/context.py:18-37`) — цифры из части до первого `_`, длина 5–20 цифр, иначе окружение считается некорректным (`None`). Используется в pytest/Playwright и локальной отладке без почты. Redis при этом всё равно обязателен — он не auth-специфичен (см. §9.5).
- **`true` (ОТП, прод и DEV с реальным входом).** Username = `sub` из JWT в `request.scope["state"]["user"]`, которое кладёт `AuthMiddleware` — похода в БД на каждый обычный запрос нет (только `/auth/me` и HTML-страница `/profile` тянут полный профиль).

**Поток входа:**

1. `POST /auth/request-otp {email}` — ищет пользователя по email в `admin.user_directory`, генерирует `AUTH__OTP_LENGTH`-значный код, кладёт в Redis (`otp:{user}`, TTL `AUTH__OTP_TTL`). Ответ всегда `success=true`, даже если email не найден — не палим факт существования адреса.
2. Отправка кода — через фабрику `notifications.email` (см. `NOTIFICATIONS__EMAIL__*`). Строка `DEV-режим: ОТП-код для <email> = <code>` пишется в лог только когда почта выключена или домен уведомлений не зарегистрирован. При включённой почте несостоявшаяся отправка идёт в error-лог без кода, а клиент получает тот же success=true (иначе ответ стал бы оракулом существования email).
3. `POST /auth/verify-otp {email, otp}` — сверяет код, при успехе удаляет его из Redis (одноразовый), выпускает пару JWT и ставит cookie `access_token` / `refresh_token` (`set_auth_cookies`, `app/auth/middleware.py:23-55`): `httponly=True`, `samesite=lax`, `path=/`, `secure` = `AUTH__COOKIE_SECURE`, `domain` — только если задан `AUTH__COOKIE_DOMAIN`. `max_age` каждой cookie равен TTL её токена (`AUTH__JWT_ACCESS_TTL` / `AUTH__JWT_REFRESH_TTL`) — без него обе cookie были бы сессионными и умирали вместе с окном браузера.
4. Дальше на каждый запрос — `AuthMiddleware`: валиден access → пропускает; access истёк, но refresh жив → тихо перевыпускает пару и подставляет новые cookie в ответ (сессия живёт, пока жив refresh, дефолт 7 дней, фронт про TTL не знает). Ни access, ни refresh не валидны → HTML уходит редиректом на `/auth/login` (с `?expired=1`, если cookie вообще были), API получает 401 JSON.

**Лимиты безопасности (Redis):** `otp_att:{user}` — счётчик неверных попыток ввода кода; по достижении `AUTH__OTP_MAX_ATTEMPTS` код инвалидируется досрочно (нужен новый запрос). `otp_req:{email}` (email в нижнем регистре) — счётчик запросов кода на email за минуту; при превышении `AUTH__OTP_REQUEST_MAX_PER_MINUTE` — 429 ещё до похода в БД (защита и от перебора email, и от флуда SMTP). При `AUTH__ENABLED=true` пустой, дефолтный (`your-secret-key`) либо короче 32 символов `AUTH__JWT_SECRET` — фатальная ошибка валидации настроек при старте (см. `AuthSettings.validate_jwt_secret`; 32 — минимум HMAC-ключа HS256 по RFC 7518).

**Env-переменные** (`AUTH__*`; полный список с дефолтами — `.env.prod`, машиночитаемая таблица — §9.5 «Auth»):

| Переменная | Дефолт | Назначение |
|---|---|---|
| `AUTH__ENABLED` | `false` | Режим (см. выше) |
| `AUTH__JWT_SECRET` | `your-secret-key` | Обязателен, не-дефолтен и ≥32 символов при `enabled=true` |
| `AUTH__JWT_ACCESS_TTL` / `AUTH__JWT_REFRESH_TTL` | `900` / `604800` | TTL токенов, сек |
| `AUTH__COOKIE_SECURE` / `AUTH__COOKIE_DOMAIN` | `false` / (пусто) | `Secure`-флаг и домен cookie |
| `AUTH__OTP_LENGTH` / `AUTH__OTP_TTL` | `6` / `300` | Длина кода (цифр) / время жизни, сек |
| `AUTH__OTP_MAX_ATTEMPTS` | `5` | Неверных попыток до инвалидации кода |
| `AUTH__OTP_REQUEST_MAX_PER_MINUTE` | `3` | Запросов кода на email в минуту |

Подключение к Redis (используется для OTP-кодов и лимитов) — общий корневой блок `REDIS__*` (§9.5 «Redis»), не часть `AUTH__*`.

**DEV-запуск с реальным ОТП-входом** (`AUTH__ENABLED=true` локально):

1. Redis в WSL Ubuntu-24.04 (systemd в дистро включён, юнит `redis-server` автостартует; пошаговая инструкция — [`redis-dev-wsl-guide.md`](redis-dev-wsl-guide.md)):
   - Установка: `wsl -d Ubuntu-24.04 -u root -- apt-get install -y redis-server` (root в WSL — без пароля).
   - Windows→WSL по `localhost` в NAT-режиме нестабилен (особенно с системным localhost-прокси) — в `%USERPROFILE%\.wslconfig` включить `[wsl2] networkingMode=mirrored`, `dnsTunneling=true`, `autoProxy=true`, затем `wsl --shutdown`; в mirrored-режиме сервис должен слушать `0.0.0.0` (`/etc/redis/redis.conf`: `bind 0.0.0.0 -::1`, `protected-mode yes` оставить — Redis без пароля отвергает клиентов с не-loopback адресов, это защита от внешней сети).
   - WSL глушит VM через ~минуту после последней `wsl.exe`-команды — держать якорь фоном: `wsl -d Ubuntu-24.04 --exec sleep infinity` (например, автостартом при входе в Windows).
   - Приложение подключается по `REDIS__HOST=127.0.0.1` (дефолт), не `localhost` — IPv6-ловушка на Windows (§9.5 «Redis»).
2. `NOTIFICATIONS__EMAIL__ENABLED=false` — почту не поднимаем, ОТП-код забираем из лога сервера (строка `DEV-режим: ОТП-код для ... = ...`).
3. `AUTH__JWT_SECRET` — строка не короче 32 символов: `python -c "import secrets; print(secrets.token_urlsafe(48))"`.

**Cookie и HTTP на SDP.** ПРОМ отдаётся по обычному HTTP (см. §9.2), поэтому `AUTH__COOKIE_SECURE=false` — обязательное значение, а не «ослабленная настройка». `true` без HTTPS — не «более безопасный дефолт», а тихая поломка входа: браузер отбрасывает `Secure`-cookie на HTTP-соединении, `verify-otp` отвечает 200, но токены не сохраняются, и следующий же запрос уходит редиректом обратно на `/auth/login` без единой ошибки в логах (наступали на это на актуализации `.env.prod` под ПРОМ). Появится TLS-терминирующий прокси — см. §9.3 и переключить на `true`.

### 9.4 Конфигурация: .env и Pydantic Settings

Конфигурация управляется через `.env` файл и загружается Pydantic Settings (`app/core/config.py`).
Шаблоны в корне репозитория: **`.env.prod`** (ПРОМ, SDP) и **`.env.dev`** (локальная разработка).
Единого `.env.example` больше нет — копируется нужный шаблон в `.env`.

**Иерархия настроек:**

```
Settings (BaseSettings) — корневой, загружается из .env
├── server: ServerSettings (BaseModel)
├── database: DatabaseSettings (BaseModel)
│   └── gp: GreenplumSettings (BaseModel)
├── redis: RedisSettings (BaseModel)
├── security: SecuritySettings (BaseModel)
├── observability: ObservabilitySettings (BaseModel)
└── auth: AuthSettings (BaseModel)
   (+ плоские поля корня: APP_TITLE, APP_VERSION, JUPYTERHUB_USER,
    AUDIT_ID_SERVICE_URL, AUDIT_ID_SERVICE_TIMEOUT)

+ Доменные настройки (через settings_registry):
ChatDomainSettings (BaseModel) — префикс CHAT__ (app/domains/chat/settings.py)
├── retry: RetryPolicy (CHAT__RETRY__*)
├── agent_channel: AgentChannelSettings (CHAT__AGENT_CHANNEL__*)
├── redis_bridge: RedisBridgeSettings (CHAT__REDIS_BRIDGE__*)
├── health_probe: LLMHealthProbeSettings (CHAT__HEALTH_PROBE__*)
└── text_actions: TextActionsSettings (CHAT__TEXT_ACTIONS__* — «Корректор» и формализация нарушения)

ActsSettings (BaseModel) — префикс ACTS__
├── lock: LockSettings
├── autosave: AutosaveSettings (ACTS__AUTOSAVE__* — дебаунс черновика в localStorage)
├── formatting: FormattingSettings
├── resource: ResourceSettings
├── invoice: InvoiceSettings
├── audit_log: AuditLogSettings
├── images: ImagesSettings (ACTS__IMAGES__* — лимиты картинок нарушений; фронт читает их через GET /api/v1/acts/limits вместе с границами таблиц/текстблоков)
├── tables: TablesSettings (ACTS__TABLES__* — max_rows/max_cols/min_col_width_px/per_node; источник истины лимитов таблиц для UI-гейта, /limits и Pydantic-валидаторов схемы)
├── textblocks: TextblocksSettings (ACTS__TEXTBLOCKS__* — font_size_min/max/default, per_node; источник истины границ шрифта текстблоков)
├── violations: ViolationsSettings (ACTS__VIOLATIONS__PER_NODE — серверный гейт числа нарушений у узла)
└── sanitizer: SanitizerSettings (ACTS__SANITIZER__* — единый allowlist для bleach и фронтового DOMPurify)
   (+ плоское поле ACTS__EDITOR_TELEMETRY_ENABLED)
```

**Правила:**
- Корневой `Settings` — единственный `BaseSettings`; вложенные модели — `BaseModel`
- Разделитель для вложенных полей: `__` (например, `DATABASE__HOST`)
- Регистронезависимые переменные окружения
- Неизвестные переменные игнорируются (`extra="ignore"`)
- Поле `schema_name` в GreenplumSettings использует `alias="schema"` (в .env: `DATABASE__GP__SCHEMA`)

**Использование:**

```python
from app.core.config import get_settings
settings = get_settings()

settings.app_title                    # "Audit Workstation"
settings.database.type                # "postgresql"
settings.server.host                  # "0.0.0.0"
settings.security.max_request_size    # 10485760
# Доменные настройки чата (через settings_registry)
from app.core.settings_registry import get as get_domain_settings
from app.domains.chat.settings import ChatDomainSettings
chat_settings = get_domain_settings("chat", ChatDomainSettings)
chat_settings.api_key.get_secret_value()  # безопасное получение ключа
```

**Пример .env** (минимальный DEV-набор; полный — `.env.dev`):

```env
JUPYTERHUB_USER=22494524_omega-sbrf-ru

SERVER__HOST=0.0.0.0
SERVER__PORT=8000
SERVER__LOG_LEVEL=INFO
LOG_FORMAT=text

DATABASE__TYPE=postgresql
DATABASE__HOST=localhost
DATABASE__PORT=5432
DATABASE__NAME=act_constructor
DATABASE__USER=postgres
DATABASE__PASSWORD=secret_password

# Redis обязателен во всех окружениях (см. §9.5 «Redis»)
REDIS__HOST=127.0.0.1
REDIS__PORT=6379

SECURITY__MAX_REQUEST_SIZE=10485760
SECURITY__RATE_LIMIT_PER_MINUTE=1024

# AI-чат (опционально)
# CHAT__PROFILE=openai
# CHAT__API_BASE=https://api.openai.com/v1
# CHAT__API_KEY=sk-...

ACTS__LOCK__DURATION_MINUTES=15
ACTS__LOCK__INACTIVITY_TIMEOUT_MINUTES=5
ACTS__FORMATTING__DOCX_IMAGE_WIDTH=4.0
ACTS__RESOURCE__MAX_TREE_DEPTH=50
ACTS__AUDIT_LOG__RETENTION_DAYS=365
```

#### 9.4.1 Примеры .env для LLM-маршрутов

`CHAT__PROFILE` — строка-маршрут, а не имя площадки. Валидных значений четыре (разбирает `parse_route` в `app/domains/chat/settings.py:84-108`): `openai`, `gigachat`, `redis-bridge,openai`, `redis-bridge,gigachat`. Часть до запятой — транспорт (`http` напрямую либо `redis-bridge` через воркер), часть после — проводной формат тела запроса. Прежние значения `sglang` / `openrouter` **упразднены**: какой сервер стоит за целью `openai` (sglang, vLLM, OpenRouter, cloud.ru), маршрут не различает — это просто OpenAI-совместимый API. Мусор в `CHAT__PROFILE` валит валидацию настроек на старте с перечислением допустимых маршрутов.

Все четыре маршрута используют один и тот же оркестратор; различия инкапсулированы в фабрике клиента, адаптере GigaChat и (для `redis-bridge,*`) в `redis_bridge_adapter.py` (см. §7.1a в [`ai-assistant.md`](ai-assistant.md)). Ниже — минимальные блоки, которые достаточно дописать в `.env` поверх дефолтов.

**`openai` — напрямую в OpenAI-совместимый сервер (sglang, vLLM, openrouter и т.п., dev/площадка с прямым доступом):**

```env
CHAT__PROFILE=openai
CHAT__API_BASE=http://127.0.0.1:30000/v1            # БЕЗ /chat/completions; для openrouter — https://openrouter.ai/api/v1
CHAT__API_KEY=local-test-key
CHAT__MODEL=/home/datalab/nfs/llm/Qwen-8B
CHAT__RETRY__ON_429=false                           # локальный sglang не rate-limit'ит; для openrouter — true
```

**`gigachat` — напрямую в корпоративный proxy (когда есть прямой сетевой доступ, например запуск с DataLab):**

```env
CHAT__PROFILE=gigachat
CHAT__API_BASE=http://liveaccess/v1/gc              # БЕЗ /chat/completions
CHAT__API_KEY=${JPY_API_TOKEN}                      # внутренний токен из окружения DataLab
CHAT__MODEL=GigaChat-3-Ultra
```

GigaChat-proxy частично OpenAI-совместим. Различия (`tools[]`↔`functions[]`, `tool_calls[]`↔singular `function_call`, dict-args↔JSON-args, отсутствие streaming) изолированы в `app/domains/chat/services/gigachat_adapter.py`. Ограничение: 1 function_call за раунд (оркестратор и так работает по одному tool за итерацию). Подробности и матрица «симптом → причина → решение» — §7.1a в [`ai-assistant.md`](ai-assistant.md).

**`redis-bridge,gigachat` / `redis-bridge,openai` — через Redis-воркер на Jupyter DataLab (ПРОМ SDP, где прямого сетевого доступа к площадке модели нет):**

```env
CHAT__PROFILE=redis-bridge,gigachat                 # или redis-bridge,openai
CHAT__MODEL=GigaChat-3-Ultra
CHAT__REQUEST_TIMEOUT=180                           # дедлайн общий для очереди в Redis + вызова LLM
CHAT__REDIS_BRIDGE__KEY_PREFIX=llm:bridge:          # дефолт, менять не нужно
```

`CHAT__API_BASE`/`CHAT__API_KEY` для `redis-bridge,*` не нужны — реальный URL и токен цели знает только воркер (`scripts/llm_redis_worker.ipynb`, переменные `GIGACHAT_API_URL`/`JPY_API_TOKEN` или `OPENAI_API_URL`/`OPENAI_API_KEY` на стороне DataLab). Подключение к Redis у моста — общий блок `REDIS__*` приложения, отдельного адреса у моста нет; `CHAT__REDIS_BRIDGE__KEY_PREFIX` задаёт только префикс ключей (`{prefix}requests`, `{prefix}resp:{id}`, `{prefix}worker:alive`). Протокол, запуск воркера и smoke-чеклист — [`../integrations/redis-llm-bridge.md`](../integrations/redis-llm-bridge.md).

**Fallback-маршрут.** `CHAT__FALLBACK_PROFILE` принимает те же четыре значения; **пустое значение (или отсутствие переменной) = fallback выключен** — валидатор `_validate_fallback_profile` приводит `""` к `None` (`app/domains/chat/settings.py:200-208`). Fallback-маршрут может отличаться от primary по транспорту и по формату — на ПРОМе primary `redis-bridge,gigachat`, fallback `redis-bridge,openai`:

```env
CHAT__FALLBACK_PROFILE=redis-bridge,openai
CHAT__FALLBACK_MODEL=Qwen3-8B
# CHAT__FALLBACK_API_BASE= / CHAT__FALLBACK_API_KEY= — нужны только HTTP-маршрутам
```

Поведение circuit breaker и фоновой перепроверки primary (`CHAT__HEALTH_PROBE__*`) от маршрута не зависит — см. §7.4a в [`ai-assistant.md`](ai-assistant.md).

**Ссылка на переменную окружения вместо ключа (`${VAR}`).** В примере GigaChat выше `CHAT__API_KEY=${JPY_API_TOKEN}` — это не литерал, а **ссылка**: `.env` читается через python-dotenv (под `pydantic-settings`), у которого интерполяция `${VAR}` включена по умолчанию и резолвится из переменных окружения процесса (в JupyterHub `JPY_API_TOKEN` уже экспортирован). Так секрет не попадает в файл — в `.env` лежит только имя переменной. Приём работает для любого `CHAT__*`-поля, в т.ч. `CHAT__FALLBACK_API_KEY`. Если переменной в окружении нет — подставится пустая строка (чат уйдёт в заглушку); чтобы это было явно, можно дать дефолт: `${JPY_API_TOKEN:-}`.

**Типичные ошибки:**

- `CHAT__API_BASE` с хвостом `/chat/completions` → 404 (SDK добавляет путь сам).
- Пустой `CHAT__API_BASE` **или** `CHAT__API_KEY` при HTTP-маршруте (`gigachat`/`openai`) → чат молча уходит в режим заглушки: вместо ответа модели приходит эхо запроса и текст «AI-ассистент работает в режиме заглушки» (`agent_loop.py:222-228`). Отдельного health-эндпоинта у чата нет — `/api/v1/system/health` про LLM ничего не знает, диагноз ставится по этому тексту в ответе. Для `redis-bridge,*` пустые `API_BASE`/`API_KEY` — норма, гард на них не срабатывает (транспорт живёт на общем Redis).
- `${JPY_API_TOKEN}` подставился пустым → переменной нет в окружении процесса (а не в `.env`-файле): проверь `echo $JPY_API_TOKEN` в той же сессии, откуда стартует AW (или воркер, если токен нужен ему).

#### 9.4.2 MIME-типы файлов чата (дефолт)

`CHAT__ALLOWED_MIME_TYPES` валидируется как whitelist точных значений — подстановки `*` запрещены. Если переменная не задана, разрешены:

| Категория | MIME-типы |
|---|---|
| Текст | `text/plain`, `text/csv`, `text/markdown` |
| Документы | `application/pdf`, `application/json`, `application/xml` |
| Office | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (xlsx), `application/vnd.ms-excel` (xls), `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (docx) |
| Изображения | `image/jpeg`, `image/png`, `image/gif`, `image/webp` |

Источник истины — `ChatDomainSettings.allowed_mime_types` в `app/domains/chat/settings.py`. Чтобы сузить список (например, оставить только PDF и PNG):

```env
CHAT__ALLOWED_MIME_TYPES=["application/pdf","image/png"]
```

#### 9.4.3 Settings-архитектура по доменам

> Механизм загрузки settings — §5.4 в [`architecture-and-backend.md`](architecture-and-backend.md).

##### Доменные префиксы env-vars

| Домен | Класс настроек | Префикс |
|---|---|---|
| `acts` | `ActsSettings` (`app/domains/acts/settings.py`) | `ACTS__` |
| `chat` | `ChatDomainSettings` (`app/domains/chat/settings.py`) | `CHAT__` |
| `admin` | `AdminSettings` (`app/domains/admin/settings.py`) | `ADMIN__` |
| `ck_fin_res` | `CkFinResSettings` | `CK_FIN_RES__` |
| `ck_client_exp` | `CkClientExpSettings` | `CK_CLIENT_EXP__` |
| `ua_data` | `UaDataSettings` | `UA_DATA__` |
| `notifications` | `NotificationsSettings` (`app/domains/notifications/settings.py`) | `NOTIFICATIONS__` |
| `sqlagent` | `SQLAgentSettings` (`app/domains/sqlagent/settings.py`) | `SQLAGENT__` |

##### Особые случаи

- **`DATABASE__GP__SCHEMA`** — поле в `GreenplumSettings` называется `schema_name` (Python keyword `schema` нельзя использовать как имя поля). Привязка к env-var — через `alias="schema"`:

  ```python
  class GreenplumSettings(BaseModel):
      schema_name: str = Field(default="...", alias="schema")
  ```

  Доступ из кода: `settings.database.gp.schema_name` (НЕ `.schema`).

- **`DATABASE__TABLE_PREFIX`** — общий для всех доменов префикс таблиц приложения (acts, chat, admin). Поле в `DatabaseSettings`, **не** в `GreenplumSettings` — действует и в PG, и в GP, чтобы имена таблиц совпадали. Дефолт — `t_db_oarb_audit_act_`.

##### Маршруты LLM

Маршруты `gigachat` / `openai` / `redis-bridge,gigachat` / `redis-bridge,openai` управляются через `CHAT__PROFILE` и связанные `CHAT__API_BASE` / `CHAT__API_KEY` / `CHAT__MODEL` (для `redis-bridge,*` два первых не нужны — транспорт на Redis, ключи моста — `CHAT__REDIS_BRIDGE__KEY_PREFIX`). Детальные различия (транспорт, streaming, tool-calling форматы, quirks) — §7.1a в [`ai-assistant.md`](ai-assistant.md). Примеры `.env` — §9.4.1. Протокол моста — [`../integrations/redis-llm-bridge.md`](../integrations/redis-llm-bridge.md).

##### Тесты доменных Settings

Не используйте `_load_from_env` для проверки дефолтов: pydantic-settings подсасывает реальный `.env` пользователя, и тест начинает зависеть от конфига разработчика. Инстанцируйте модель напрямую:

```python
def test_chat_settings_defaults():
    s = ChatDomainSettings(api_base="x", api_key="y", model="z")
    assert s.temperature == 0.1
    assert s.retry.on_429 is True
```

`_load_from_env` оставляйте для проверки nested env-override (`monkeypatch.setenv("CHAT__RETRY__ON_429", "false")` и т.п.) — там monkeypatch перекрывает `.env`.

##### При добавлении новой переменной

1. Добавить поле в соответствующий `*Settings`-класс.
2. Дописать в `.env.dev` и `.env.prod` (с комментарием по-русски, дефолтное значение, рамки допустимых).
3. Если поле управляет именем таблицы / справочника — может потребоваться `migration_substitutions` в `DomainDescriptor` (см. §6.5 в [`database.md`](database.md)).
4. Обновить таблицу в §9.5.
5. Тесты домена — `_load_from_env` с `monkeypatch.setenv` для проверки парсинга.

#### 9.4.4 Метаданные приложения: название и версия

Название и номер версии живут **в одном месте** — `__title__` и `__version__` в `app/__init__.py`.
Оттуда их читает `Settings` (`app/core/config.py`, импорт
`from app import __title__ as APP_TITLE, __version__ as APP_VERSION`), а дальше значения расходятся
по потребителям сами:

| Потребитель | Что показывает |
|---|---|
| `/api/v1/system/health` и остальные health-эндпоинты | поля `service` и `version` |
| OpenAPI-схема (`app/main.py`) | название и версия API в `/docs` |
| Jinja-фильтр `versioned` (`app/core/templating.py`) | `?v=<версия>` на всей статике — cache-busting |
| Глобал шаблонов `app_version` | `<meta name="app-version">`, бейдж версии в интерфейсе |

Переменные окружения `APP_TITLE` и `APP_VERSION` остаются рабочими override'ами (поля обычные,
pydantic-settings их подхватывает), но в `.env.dev` / `.env.prod` они **закомментированы намеренно**:
это свойства кода, а не среды. Для версии цена ошибки выше всего: задать её в `.env` и забыть обновить
при релизе — значит не только отрапортовать старую версию, но и оставить фильтру `versioned` старый
`?v=`, из-за чего браузеры останутся на закэшированных JS/CSS предыдущего релиза. Отказ молчаливый,
выглядит как «фронт не обновился».

Порядок бампа и что ещё правится — раздел «Как поднимать версию» в `CHANGELOG.md`; согласованность
`__version__` ↔ `Settings.app_version` ↔ `CHANGELOG.md` проверяет `tests/test_version_consistency.py`.

### 9.5 Полная таблица переменных окружения

Разбито на тематические блоки. Все nested-переменные используют делимитер `__` (см. §9.4).

#### Метаданные приложения

| Переменная | Тип | По умолчанию | Описание |
|-----------|-----|-------------|----------|
| `APP_TITLE` | str | из `app/__init__.py` | Название приложения (`__title__`). В шаблонах `.env` закомментировано, см. §9.4.4 |
| `APP_VERSION` | str | из `app/__init__.py` | Версия. В шаблонах `.env` закомментирована: единственный источник — `__version__` в `app/__init__.py`, откуда её берёт `Settings.app_version`. Env-override остался рабочим, но использовать его в норме не нужно (§9.4.4) |
| `JUPYTERHUB_USER` | str | `unknown_user` | Username (цифры): тест-режим авторизации (`AUTH__ENABLED=false`, §9.3a) и/или Kerberos-логин для Greenplum (`app/db/connection.py:213-218`). Имя — историческое, к JupyterHub/DataLab деплою больше не привязано |
| `AUDIT_ID_SERVICE_URL` | str | `""` | URL планируемого внешнего сервиса генерации ID для связи актов и фактур. Заглушка — сервис ещё не подключён |
| `AUDIT_ID_SERVICE_TIMEOUT` | int | `10` | Таймаут обращения к сервису ID (сек). Заглушка |

#### Server

| Переменная | Тип | По умолчанию | Описание |
|-----------|-----|-------------|----------|
| `SERVER__HOST` | str | `0.0.0.0` | IP для привязки |
| `SERVER__PORT` | int | `8000` | TCP порт (1-65535). `.env.dev` — `8000`, `.env.prod` (SDP) — `8484`; Swagger по `http://<host>:<port>/docs` |
| `SERVER__API_V1_PREFIX` | str | `/api/v1` | Префикс API |
| `SERVER__LOG_LEVEL` | str | `INFO` | Уровень логирования (`DEBUG`/`INFO`/`WARNING`/`ERROR`/`CRITICAL`; нормализуется к верхнему регистру) |
| `LOG_FORMAT` | str | `text` | `text` (разработка) или `json` (для агрегаторов). Читается напрямую через `os.getenv`, а не через `Settings` (`app/core/logging.py:76`) — в `Settings` поля нет |

#### Database

| Переменная | Тип | По умолчанию | Описание |
|-----------|-----|-------------|----------|
| `DATABASE__TYPE` | str | `postgresql` | `postgresql` или `greenplum` |
| `DATABASE__HOST` | str | `localhost` | Хост |
| `DATABASE__PORT` | int | `5432` | Порт |
| `DATABASE__NAME` | str | `audit_workstation` | Имя БД |
| `DATABASE__USER` | str | `postgres` | Пользователь |
| `DATABASE__PASSWORD` | str | (пусто) | Пароль |
| `DATABASE__POOL_MIN_SIZE` | int | `1` | Мин. соединений. Единый дефолт для DEV и ПРОМа |
| `DATABASE__POOL_MAX_SIZE` | int | `2` | Макс. соединений. У ПРОМ-учётки GP лимит ~5 соединений; горячие пути унесены на Redis, поэтому пул минимальный (см. [troubleshooting](../operations/troubleshooting.md) №17) |
| `DATABASE__COMMAND_TIMEOUT` | int | `60` | Timeout команд (сек) |
| `DATABASE__ACQUIRE_TIMEOUT` | float | `10.0` | Таймаут ожидания свободного соединения из пула (сек). При исчерпании пула `get_db` отдаёт 503 (`ServiceUnavailableError`) вместо бессрочного зависания запроса |
| `DATABASE__STRICT_ACQUIRE_GUARD` | bool | `False` | Повторный захват соединения в одном task: `true` — `RuntimeError` (dev; в `.env.dev` включён, в тестах — безусловно), `false` — WARNING со стеком (ПРОМ). См. §6.3a в [`database.md`](database.md) |
| `DATABASE__POOL_WARMUP_ENABLED` | bool | `True` | Прогрев пула при старте |
| `DATABASE__TABLE_PREFIX` | str | `t_db_oarb_audit_act_` | Общий префикс таблиц приложения (PG и GP) |
| `DATABASE__GP__HOST` | str | `gp_dns_pkap1123_audit.gp.df.sbrf.ru` | Хост GP |
| `DATABASE__GP__PORT` | int | `5432` | Порт GP |
| `DATABASE__GP__DATABASE` | str | `capgp3` | Имя БД GP |
| `DATABASE__GP__SCHEMA` | str | `s_grnplm_ld_audit_da_project_4` | Схема GP для **собственных таблиц приложения** (alias для поля `schema_name`). На ПРОМе — `s_grnplm_ld_audit_da_project_34`; это не опечатка: справочники UA/ЦК, реестр фактур и каталог пользователей живут в `_project_4` и задаются своими переменными (`UA_DATA__SCHEMA_NAME`, `CK_*__SCHEMA_NAME`, `ACTS__INVOICE__HIVE_REGISTRY_SCHEMA`, `ADMIN__USER_DIRECTORY__SCHEMA`). См. §9.2 |

#### Redis

Общий слой `app/core/redis.py` (`RedisAdapter` + модульные `init_redis`/`close_redis`/`get_redis() -> RedisAdapter`). **Redis обязателен во всех окружениях** — ПРОМ, DEV, pytest, Playwright — и поднимается на старте безусловно, независимо от `AUTH__ENABLED`; без него приложение не стартует (fail-fast в хуке, см. §9.3a `lifecycle.py`). `get_redis()` не возвращает None, а бросает `RuntimeError`, если `init_redis` не вызывали: конфигурационных развилок «а если Redis нет» в потребителях не осталось. В pytest адаптер подставляет autouse-фикстура `fake_redis` (`tests/conftest.py`, свежий fakeredis на тест); e2e ходят в живой Redis на отдельную БД 15 (`tests/playwright/global-setup.ts` перед прогоном делает PING + FLUSHDB).

Текущие потребители: OTP-коды/лимиты модуля `app.auth` (см. §9.3a), кэш unread-счётчика уведомлений, кэш ролей и пользовательского контекста (L2 поверх in-process TTLCache), блокировки актов (TTL-ключ, см. §10 в [`../architecture/data-model-acts.md`](../architecture/data-model-acts.md)) и транспорт LLM-моста для маршрутов `redis-bridge,*` (§9.4.1). Обрабатывается только **рантайм-сбой** уже работающего Redis, и это авария, а не режим: кэши молча идут мимо него прямо в БД (warning в лог), мутации лока (захват/продление/снятие) отдают 5xx (fail-closed), чтение состояния лока при обогащении списка актов — fail-open (акт считается свободным).

| Переменная | Тип | По умолчанию | Описание |
|-----------|-----|-------------|----------|
| `REDIS__HOST` | str | `127.0.0.1` | Хост Redis. Именно IPv4-адрес, не `localhost` — на Windows `localhost` резолвится в IPv6 `::1` первым, redis-py не фолбэкает на IPv4 (connection refused/timeout) |
| `REDIS__PORT` | int | `6379` | Порт Redis. На ПРОМе нестандартный — `.env.prod`: `10.110.10.38:7474` |
| `REDIS__DB` | int | `0` | Индекс БД Redis (0-15). БД `15` занята e2e-прогоном: `global-setup.ts` делает на ней FLUSHDB перед стартом сервера |
| `REDIS__PASSWORD` | SecretStr | (пусто) | Пароль Redis |
| `REDIS__MAX_CONNECTIONS` | int | `10` | Максимум соединений в пуле клиента Redis |
| `REDIS__SOCKET_TIMEOUT` | float | `5.0` | Таймаут операций сокета Redis, сек |

#### Security

| Переменная | Тип | По умолчанию | Описание |
|-----------|-----|-------------|----------|
| `SECURITY__MAX_REQUEST_SIZE` | int | `10485760` | Макс. размер запроса (байт) |
| `SECURITY__RATE_LIMIT_PER_MINUTE` | int | `1024` | Лимит запросов/мин на IP |
| `SECURITY__MAX_TRACKED_IPS` | int | `100` | Макс. отслеживаемых IP |
| `SECURITY__RATE_LIMIT_TTL` | int | `120` | TTL метрик (сек) |

#### Security: response headers

`SecurityHeadersMiddleware` (`app/core/middleware.py`). CSP работает в enforce-режиме с per-request nonce: middleware подставляет его в плейсхолдер `{nonce}` директивы `script-src` и кладёт в `request.state.csp_nonce`, inline-блоки `<script type="module">` в шаблонах проставляют этот nonce атрибутом. `style-src` сохраняет `'unsafe-inline'` осознанно.

| Переменная | Тип | По умолчанию | Описание |
|-----------|-----|-------------|----------|
| `SECURITY__CSP_ENABLED` | bool | `True` | Отдавать заголовок CSP |
| `SECURITY__CSP_REPORT_ONLY` | bool | `False` | `true` — `Content-Security-Policy-Report-Only` (наблюдение без блокировок). `.env.dev` — `true`, `.env.prod` — `false` |
| `SECURITY__CSP_POLICY` | str | `default-src 'self'; script-src 'self' 'nonce-{nonce}'; …` | Сама политика; плейсхолдер `{nonce}` обязателен, иначе inline-модули шаблонов перестанут исполняться. Полное значение — `app/core/config.py:132-143` |
| `SECURITY__HSTS_ENABLED` | bool | `True` | Отдавать `Strict-Transport-Security`. Добавляется **только на HTTPS-ответы** (`scope.scheme == 'https'` либо `X-Forwarded-Proto`), поэтому на HTTP-ПРОМе не проявляется |
| `SECURITY__HSTS_MAX_AGE` | int | `31536000` | `max-age` HSTS (сек, 1 год) |
| `SECURITY__HSTS_INCLUDE_SUBDOMAINS` | bool | `True` | Добавлять `includeSubDomains` |
| `SECURITY__FRAME_OPTIONS` | str | `SAMEORIGIN` | `X-Frame-Options`: только `DENY` или `SAMEORIGIN` (Literal) |
| `SECURITY__REFERRER_POLICY` | str | `strict-origin-when-cross-origin` | Значение `Referrer-Policy` |
| `SECURITY__PERMISSIONS_POLICY` | str | `camera=(), microphone=(), …` | Значение `Permissions-Policy`; по умолчанию всё запрещено. В шаблонах `.env` не вынесен |

#### Auth (ОТП/JWT)

Модуль `app/auth/`, не домен. Архитектура и поток входа — §9.3a.

| Переменная | Тип | По умолчанию | Описание |
|-----------|-----|-------------|----------|
| `AUTH__ENABLED` | bool | `False` | `true` — ОТП-авторизация, `false` — тест-режим (username из `JUPYTERHUB_USER`). Дефолт кода — `false`, но оба шаблона `.env` ставят `true` |
| `AUTH__JWT_SECRET` | SecretStr | `your-secret-key` | Обязателен, не-дефолтен и ≥32 символов при `enabled=true` |
| `AUTH__JWT_ALGORITHM` | str | `HS256` | Алгоритм подписи JWT |
| `AUTH__JWT_ACCESS_TTL` | int | `900` | TTL access-токена (сек) |
| `AUTH__JWT_REFRESH_TTL` | int | `604800` | TTL refresh-токена (сек) — фактическая длина сессии |
| `AUTH__COOKIE_SECURE` | bool | `False` | `Secure`-флаг cookie. На SDP-ПРОМе обязан оставаться `false` — приложение отдаётся по HTTP, с `true` вход зацикливается без ошибок в логах (§9.3a) |
| `AUTH__COOKIE_DOMAIN` | str | (пусто) | Домен cookie, пусто — текущий host |
| `AUTH__OTP_LENGTH` | int | `6` | Длина ОТП-кода (цифр) |
| `AUTH__OTP_TTL` | int | `300` | Время жизни ОТП-кода (сек) |
| `AUTH__OTP_MAX_ATTEMPTS` | int | `5` | Неверных попыток ввода кода до инвалидации |
| `AUTH__OTP_REQUEST_MAX_PER_MINUTE` | int | `3` | Запросов кода на email в минуту |

#### Chat: LLM

| Переменная | Тип | По умолчанию | Описание |
|-----------|-----|-------------|----------|
| `CHAT__SCHEMA_NAME` | str | `""` | Схема БД для собственных таблиц чата (conversations, messages, files, tool_metrics, audit_log). Пусто → основная схема GP / без квалификатора PG. Учитывается при создании (миграции через `{CHAT_SCHEMA_Q}`) и доступе (`get_table_name(schema=…)`). Bus-таблица — отдельным `CHAT__AGENT_CHANNEL__SCHEMA_NAME` |
| `CHAT__PROFILE` | str | `openai` | Маршрут LLM: `gigachat` \| `openai` \| `redis-bridge,gigachat` \| `redis-bridge,openai` (валидируется `parse_route`). `.env.prod` — `redis-bridge,gigachat`, `.env.dev` — `redis-bridge,openai`. См. §9.4.1 и §7.1a в [`ai-assistant.md`](ai-assistant.md) |
| `CHAT__API_BASE` | str | (пусто) | Базовый URL LLM API (без `/chat/completions` — SDK добавит сам). Не нужен для маршрутов `redis-bridge,*` |
| `CHAT__API_KEY` | SecretStr | (пусто) | API-ключ. Не нужен для маршрутов `redis-bridge,*` |
| `CHAT__MODEL` | str | `gpt-4o` | Модель |
| `CHAT__TEMPERATURE` | float | `0.1` | Температура (0-2) |
| `CHAT__MAX_TOOL_ROUNDS` | int | `5` | Макс. раундов tool-calling |
| `CHAT__REQUEST_TIMEOUT` | int | `60` | Timeout запроса к LLM (сек) |
| `CHAT__TOOL_EXECUTION_TIMEOUT` | int | `30` | Timeout инструмента (сек) |
| `CHAT__SMALLTALK_MODE` | str | `local` | `local` — отвечает локальный LLM; `forward` — пробрасывать всё агенту |
| `CHAT__SYSTEM_PROMPT` | str | `Ты — AI-ассистент...` | Системный промпт |
| `CHAT__MAX_HISTORY_LENGTH` | int | `50` | Макс. сообщений в истории |
| `CHAT__MAX_MESSAGE_CONTENT_LENGTH` | int | `10000` | Макс. длина сообщения |
| `CHAT__HISTORY_FULL_CONTEXT_DEPTH` | int | `5` | Сообщений с полным контентом (file/image-блоки); старые получают placeholder |
| `CHAT__EXTRA_HEADERS` | JSON | `{}` | Доп. заголовки для primary-провайдера. OpenRouter принимает `HTTP-Referer`/`X-Title` |

#### Chat: Retry / Fallback / Circuit breaker

См. §7.4a в [`ai-assistant.md`](ai-assistant.md) — описание поведения каждого слоя.

| Переменная | Тип | По умолчанию | Описание |
|-----------|-----|-------------|----------|
| `CHAT__RETRY__ON_429` | bool | `True` | Повторять при 429 (rate-limit) |
| `CHAT__RETRY__ON_5XX` | bool | `True` | Повторять при 5xx |
| `CHAT__RETRY__MAX_ATTEMPTS` | int | `5` | Макс. попыток |
| `CHAT__RETRY__BACKOFF_BASE_SEC` | float | `2.0` | База экспоненциального backoff (сек) |
| `CHAT__RETRY__CONNECT_MAX_ATTEMPTS` | int | `2` | Отдельный кап для обрывов соединения (`ConnectError`/`APIConnectionError`/`PoolTimeout`): сервер лёг — быстро падаем на fallback, не выбирая полный `MAX_ATTEMPTS`. `APITimeoutError` («сервер медленный») сюда не относится |
| `CHAT__FALLBACK_PROFILE` | str | (пусто) | Маршрут fallback-провайдера (тот же формат, что `CHAT__PROFILE`); **пусто = fallback отключён**. ПРОМ — `redis-bridge,openai` |
| `CHAT__FALLBACK_API_BASE` | str | (пусто) | Base URL fallback-провайдера. Не нужен для маршрутов `redis-bridge,*` |
| `CHAT__FALLBACK_API_KEY` | SecretStr | (пусто) | API-ключ fallback-провайдера. Не нужен для маршрутов `redis-bridge,*` |
| `CHAT__FALLBACK_MODEL` | str | (пусто) | Модель fallback |
| `CHAT__FALLBACK_EXTRA_HEADERS` | JSON | `{}` | Доп. заголовки для fallback |
| `CHAT__CIRCUIT_BREAKER_FAILURE_THRESHOLD` | int | `2` | Подряд ошибок primary до размыкания circuit (≥1) |
| `CHAT__CIRCUIT_BREAKER_RECOVERY_TIMEOUT_SEC` | int | `60` | Сек до пробного запроса в primary (half-open; ≥10) |

#### Chat: health-probe primary-LLM

Фоновая задача `chat.llm_health_probe` (`app/domains/chat/services/llm_health_probe.py`): пока circuit breaker разомкнут, запросы пользователей мгновенно уходят на fallback, а probe пингует primary с adaptive-backoff и закрывает breaker, как только primary ответил. Так «проба живым запросом» уходит с пути пользователя. Статус виден в `GET /api/v1/admin/diagnostics` (§9.5b).

| Переменная | Тип | По умолчанию | Описание |
|-----------|-----|-------------|----------|
| `CHAT__HEALTH_PROBE__ENABLED` | bool | `True` | Запускать фоновый probe. `false` → задача не создаётся, breaker закрывается только пробным запросом пользователя |
| `CHAT__HEALTH_PROBE__POLL_MIN_INTERVAL_SEC` | float | `2.0` | Начальный интервал пингов |
| `CHAT__HEALTH_PROBE__POLL_MAX_INTERVAL_SEC` | float | `30.0` | Потолок интервала при длительном простое primary |
| `CHAT__HEALTH_PROBE__POLL_BACKOFF_MULTIPLIER` | float | `1.5` | Шаг роста интервала (> 1.0) |
| `CHAT__HEALTH_PROBE__TIMEOUT_SEC` | float | `5.0` | Таймаут одного пинга |

#### Chat: text_actions («Корректор» и формализация нарушения)

Правка выделенного текста (`fix` — орфография/пунктуация, `readability` — читаемость/структура) и извлечение полей нарушения. `*_model = None` → берётся основная модель профиля чата (`CHAT__MODEL`). В шаблонах `.env` эти переменные не вынесены — работают на дефолтах.

| Переменная | Тип | По умолчанию | Описание |
|-----------|-----|-------------|----------|
| `CHAT__TEXT_ACTIONS__CORRECTOR_MODEL` | str \| null | (не задана) | Модель корректора; пусто → `CHAT__MODEL` |
| `CHAT__TEXT_ACTIONS__CORRECTOR_TEMPERATURE` | float | `0.1` | Температура режима `fix` (детерминированность правок) |
| `CHAT__TEXT_ACTIONS__READABILITY_TEMPERATURE` | float | `0.3` | Температура режима «улучшение читаемости» |
| `CHAT__TEXT_ACTIONS__FORMALIZER_MODEL` | str \| null | (не задана) | Модель формализатора нарушения; пусто → `CHAT__MODEL` |
| `CHAT__TEXT_ACTIONS__FORMALIZER_TEMPERATURE` | float | `0.01` | Температура извлечения полей (почти детерминированно) |
| `CHAT__TEXT_ACTIONS__PER_CALL_TIMEOUT_SEC` | float | `60.0` | Таймаут одного вызова |
| `CHAT__TEXT_ACTIONS__MAX_INPUT_CHARS` | int | `20000` | Потолок длины входного текста |

#### Chat: Redis-мост LLM (redis-bridge-маршруты)

Транспорт для `CHAT__PROFILE`/`CHAT__FALLBACK_PROFILE` вида `redis-bridge,<цель>`. Протокол, запуск воркера на DataLab и smoke-чеклист — [`../integrations/redis-llm-bridge.md`](../integrations/redis-llm-bridge.md). Таймаут заявки — общий `CHAT__REQUEST_TIMEOUT` (он покрывает и ожидание в очереди Redis, и сам вызов LLM; отдельной переменной под мост не заводилось). Адрес Redis у моста тот же, что у приложения — блок `REDIS__*`.

| Переменная | Тип | По умолчанию | Описание |
|-----------|-----|-------------|----------|
| `CHAT__REDIS_BRIDGE__KEY_PREFIX` | str | `llm:bridge:` | Префикс ключей LLM-моста в Redis (`{prefix}requests`, `{prefix}resp:{id}`, `{prefix}worker:alive`). Адрес/БД самого Redis — блок «Redis» выше в этой таблице; префикс менять не нужно (он обязан совпадать с настройкой воркера) |

#### Chat: agent_channel (внешний ИИ-агент)

Канал к внешнему агенту через bus-таблицу `chat_agent_messages_bus` (env-префикс `CHAT__AGENT_CHANNEL__`). См. §7.8 и §11.5–§11.7 в [`ai-assistant.md`](ai-assistant.md).

| Переменная | Тип | По умолчанию | Описание |
|-----------|-----|-------------|----------|
| `CHAT__AGENT_CHANNEL__TABLE_NAME` | str | `chat_agent_messages_bus` | Имя bus-таблицы **целиком**, без `DATABASE__TABLE_PREFIX` (шина общая с внешним агентом — app-префикс к ней не клеится). Нужен префикс — вписать его прямо в значение. В миграцию подставляется как `{BUS_TABLE}`; репозиторий квалифицирует через `qualify_table_name` (схема без префикса). На ПРОМе имя переопределено: `.env.prod` задаёт `agent_conversation_messages` (в `.env.dev` — дефолтное) |
| `CHAT__AGENT_CHANNEL__SCHEMA_NAME` | str | `""` | Схема bus-таблицы. Пусто → fallback на `CHAT__SCHEMA_NAME`, затем на основную схему адаптера. Учитывается при создании и доступе. Позволяет вынести шину в общую integration-схему с внешним агентом независимо от остальных таблиц чата |
| `CHAT__AGENT_CHANNEL__POLL_MIN_INTERVAL_SEC` | float | `2.0` | Минимальный интервал polling `AgentChannelPoller` (при активности). Снизить можно ради отзывчивости чата, цена — больше SELECT'ов к GP |
| `CHAT__AGENT_CHANNEL__POLL_MAX_INTERVAL_SEC` | float | `10.0` | Максимальный интервал polling (при тишине от агента) |
| `CHAT__AGENT_CHANNEL__POLL_BACKOFF_MULTIPLIER` | float | `1.5` | Шаг роста интервала при пустом тике (> 1.0) |
| `CHAT__AGENT_CHANNEL__CLAIM_TIMEOUT_SEC` | int | `1800` | Idle-таймаут фазы `pending` (агент ещё не взял вопрос в работу); по истечении `mark_timeout(reason='claim')` |
| `CHAT__AGENT_CHANNEL__ANSWER_TIMEOUT_SEC` | int | `600` | Idle-таймаут фазы `processing` (агент взял, но ответ не пришёл); по истечении `mark_timeout(reason='answer')` |
| `CHAT__AGENT_CHANNEL__MAX_BLOCK_TEXT_SIZE` | int | `262144` | Лимит размера текста блока (`reasoning`/`text`) от агента в UTF-8 байт. Превышение → блок обрезается с маркером `…[обрезано]` + WARNING-лог. Защищает БД / фронт от malicious-агента |

> **Удалён** прежний неймспейс `CHAT__AGENT_BRIDGE__*` (старая 3-табличная шина). Если переменные остались в `.env` — игнорируются без ошибки (модели Settings используют `extra="ignore"`).

#### Chat: rate-limit, лимиты запросов, файлы, хранение

| Переменная | Тип | По умолчанию | Описание |
|-----------|-----|-------------|----------|
| `CHAT__RATE_LIMIT_MESSAGES_PER_MINUTE_PER_USER` | int | `10` | Лимит POST `/messages` на пользователя в минуту (sliding window 60 сек) |
| `CHAT__MAX_PARALLEL_STREAMS_PER_USER` | int | `3` | Макс. одновременных запросов к внешнему агенту на пользователя. При превышении `submit` бросает `ChatLimitError` → HTTP 422 |
| `CHAT__MAX_FILE_SIZE` | int | `10485760` | Макс. размер файла (байт) |
| `CHAT__MAX_FILES_PER_MESSAGE` | int | `5` | Макс. файлов в сообщении |
| `CHAT__MAX_TOTAL_FILE_SIZE` | int | `31457280` | Макс. суммарный размер файлов в сообщении (байт) |
| `CHAT__ALLOWED_MIME_TYPES` | JSON-list | (см. §9.4.2) | Whitelist точных MIME-типов; подстановки `*` запрещены |
| `CHAT__MAX_CONVERSATIONS_PER_USER` | int | `100` | Макс. разговоров на пользователя |
| `CHAT__MAX_MESSAGES_PER_CONVERSATION` | int | `500` | Макс. сообщений в разговоре |

#### Acts

| Переменная | Тип | По умолчанию | Описание |
|-----------|-----|-------------|----------|
| `ACTS__LOCK__DURATION_MINUTES` | int | `15` | Длительность блокировки |
| `ACTS__LOCK__INACTIVITY_TIMEOUT_MINUTES` | float | `5.0` | Timeout неактивности |
| `ACTS__LOCK__INACTIVITY_CHECK_INTERVAL_SECONDS` | int | `30` | Интервал проверки |
| `ACTS__LOCK__MIN_EXTENSION_INTERVAL_MINUTES` | float | `5.0` | Мин. интервал продления (антифлуд) |
| `ACTS__LOCK__INACTIVITY_DIALOG_TIMEOUT_SECONDS` | int | `15` | Timeout диалога |
| `ACTS__AUTOSAVE__PERIOD_SECONDS` | int | `3` | Дебаунс автосохранения черновика акта в localStorage (сек) |
| `ACTS__FORMATTING__MAX_IMAGE_SIZE_MB` | float | `10.0` | Макс. размер изображения |
| `ACTS__FORMATTING__DOCX_IMAGE_WIDTH` | float | `4.0` | Ширина изображения (дюймы) |
| `ACTS__FORMATTING__DOCX_CAPTION_FONT_SIZE` | int | `10` | Размер шрифта подписей |
| `ACTS__FORMATTING__DOCX_MAX_HEADING_LEVEL` | int | `9` | Макс. уровень заголовков |
| `ACTS__FORMATTING__TEXT_HEADER_WIDTH` | int | `80` | Ширина заголовка |
| `ACTS__FORMATTING__TEXT_INDENT_SIZE` | int | `2` | Отступ в тексте |
| `ACTS__FORMATTING__MARKDOWN_MAX_HEADING_LEVEL` | int | `6` | Макс. уровень в MD |
| `ACTS__FORMATTING__HTML_PARSE_TIMEOUT` | int | `30` | Timeout парсинга HTML |
| `ACTS__FORMATTING__MAX_HTML_DEPTH` | int | `100` | Макс. глубина HTML |
| `ACTS__FORMATTING__HTML_PARSE_CHUNK_SIZE` | int | `1000` | Размер чанка |
| `ACTS__FORMATTING__MAX_RETRIES` | int | `3` | Макс. попыток |
| `ACTS__FORMATTING__RETRY_DELAY` | float | `0.5` | Задержка retry |
| `ACTS__RESOURCE__MAX_CONCURRENT_FILE_OPERATIONS` | int | `100` | Макс. файловых операций |
| `ACTS__RESOURCE__SAVE_OPERATION_TIMEOUT` | int | `300` | Timeout сохранения |
| `ACTS__RESOURCE__SAVE_ACT_TIMEOUT` | int | `300` | Timeout сохранения акта |
| `ACTS__RESOURCE__MAX_TREE_DEPTH` | int | `50` | Макс. глубина дерева |
| `ACTS__INVOICE__HIVE_SCHEMA` | str | `team_sva_oarb_3` | Hive-схема |
| `ACTS__INVOICE__GP_SCHEMA` | str | `s_grnplm_ld_audit_da_sandbox_oarb` | GP-схема для списка таблиц |
| `ACTS__INVOICE__HIVE_REGISTRY_SCHEMA` | str | `s_grnplm_ld_audit_project_4` | Схема реестра Hive. Дефолт кода **без** `da_`; оба шаблона `.env` задают `s_grnplm_ld_audit_da_project_4` — на дефолт кода полагаться нельзя |
| `ACTS__INVOICE__HIVE_REGISTRY_TABLE` | str | `t_db_oarb_ua_hadoop_tables` | Таблица реестра Hive |
| `ACTS__AUDIT_LOG__RETENTION_DAYS` | int | `365` | Дни хранения лога |
| `ACTS__AUDIT_LOG__MAX_CONTENT_VERSIONS` | int | `50` | Макс. версий содержимого |
| `ACTS__AUDIT_LOG__MAX_DIFF_ELEMENTS` | int | `20` | Макс. элементов в diff |
| `ACTS__AUDIT_LOG__MAX_DIFF_CELLS_PER_TABLE` | int | `50` | Макс. ячеек diff на таблицу |
| `ACTS__IMAGES__MAX_FILE_SIZE` | int | `4194304` | Макс. размер картинки нарушения (сырые байты; согласован с лимитом HTTP-запроса по base64) |
| `ACTS__IMAGES__MAX_TOTAL_SIZE_PER_ACT` | int | `5242880` | Суммарный размер картинок на акт (сырые байты) |
| `ACTS__IMAGES__ALLOWED_MIME_TYPES` | list | `jpeg/png/gif` | Whitelist MIME картинок (без SVG; без webp — python-docx не встраивает его в DOCX) |
| `ACTS__IMAGES__MAX_ITEMS_PER_VIOLATION` | int | `50` | Макс. элементов additionalContent на нарушение |
| `ACTS__IMAGES__IMAGE_MAX_HEIGHT_PERCENT` | int | `40` | Макс. высота картинки нарушения (% листа A4) — превью и DOCX |
| `ACTS__TABLES__MAX_ROWS` | int | `64` | Макс. строк таблицы |
| `ACTS__TABLES__MAX_COLS` | int | `16` | Макс. колонок таблицы |
| `ACTS__TABLES__MIN_COL_WIDTH_PX` | int | `80` | Мин. ширина колонки (px) |
| `ACTS__TABLES__PER_NODE` | int | `10` | Макс. таблиц-детей одного узла (серверный гейт, включая закреплённые metrics/risk) |
| `ACTS__TEXTBLOCKS__FONT_SIZE_MIN` | int | `8` | Мин. размер шрифта текстблока |
| `ACTS__TEXTBLOCKS__FONT_SIZE_MAX` | int | `72` | Макс. размер шрифта текстблока |
| `ACTS__TEXTBLOCKS__FONT_SIZE_DEFAULT` | int | `16` | Базовый экранный размер текстблока (px; 16px → 12pt в DOCX) |
| `ACTS__TEXTBLOCKS__PER_NODE` | int | `10` | Макс. текстблоков-детей одного узла (серверный гейт) |
| `ACTS__VIOLATIONS__PER_NODE` | int | `10` | Макс. нарушений-детей одного узла (серверный гейт) |
| `ACTS__SANITIZER__ALLOWED_TAGS` | list | `p/br/b/…/div` (22 тега) | Allowlist HTML-тегов санитайзера контента (bleach + nh3, единый источник с фронтовым DOMPurify через `/acts/limits`) |
| `ACTS__SANITIZER__ALLOWED_CSS_PROPERTIES` | list | `font-size/…/text-align` (8 свойств) | Allowlist CSS-свойств inline-`style` |
| `ACTS__SANITIZER__ALLOWED_DATA_ATTRS` | list | `data-footnote-*`, `data-link-*` | Data-атрибуты капсул ссылок/сносок |
| `ACTS__EDITOR_TELEMETRY_ENABLED` | bool | `True` | Kill-switch телеметрии здоровья редактора: `false` → `POST /acts/editor-telemetry` отвечает 204 без записи, а фронт (получив флаг через `GET /acts/limits`) перестаёт слать батчи |

Лимиты картинок и жёсткие границы таблиц/текстблоков фронт получает через `GET /api/v1/acts/limits` (образец — chat `GET /limits`). Эти настройки — **единый источник истины** end-to-end: и UI-гейты, и `/limits`, и Pydantic-валидаторы схемы (`grid`/`colWidths`/`colSpan`/`rowSpan`/`fontSize`, число элементов нарушения, whitelist MIME картинок) читают их в рантайме. Статические константы в `schemas/act_content.py` (`VIOLATION_CONTENT_ITEMS_MAX`, `IMAGE_DATA_URL_PATTERN`, и т.п.) остаются только как фолбэк на импорт-тайм/тесты; whitelist-регекс MIME выводится из `ACTS__IMAGES__ALLOWED_MIME_TYPES` (с сохранённым алиасом `jpe?g` для `image/jpg`).

#### Admin и Observability

См. §9.5a о потоках метрик.

| Переменная | Тип | По умолчанию | Описание |
|-----------|-----|-------------|----------|
| `ADMIN__USER_DIRECTORY__SCHEMA` | str | `""` | Схема справочника пользователей (пустая — основная GP) |
| `ADMIN__USER_DIRECTORY__TABLE` | str | `t_db_oarb_ua_user` | Таблица пользователей |
| `ADMIN__USER_DIRECTORY__BRANCH_FILTER` | str | `Отдел аудита...` | Фильтр отделения |
| `ADMIN__USER_DIRECTORY__DEFAULT_ADMIN` | str | `22494524` | Админ по умолчанию |
| `ADMIN__HTTP_METRICS_ENABLED` | bool | `False` | Запись HTTP-метрик в БД (через MetricsBatcher) |
| `ADMIN__DB_POOL_MONITOR__ENABLED` | bool | `True` | Фоновая задача `admin.db_pool_monitor`: раз в интервал снимает `pool.get_size()`/`get_idle_size()` и пишет WARNING при перегрузке пула. Своей таблицы нет — только логи |
| `ADMIN__DB_POOL_MONITOR__CHECK_INTERVAL_SEC` | float | `30.0` | Интервал замеров (≥5.0) |
| `ADMIN__DB_POOL_MONITOR__WARN_RATIO` | float | `0.9` | Доля от `DATABASE__POOL_MAX_SIZE`, выше которой эмитится WARNING (0 < ratio ≤ 1) |
| `OBSERVABILITY__METRICS_BATCH_SIZE` | int | `100` | Размер пакета для flush в БД (триггер 1) |
| `OBSERVABILITY__METRICS_FLUSH_INTERVAL_SEC` | float | `5.0` | Принудительный flush раз в N сек (триггер 2) |
| `OBSERVABILITY__METRICS_MAX_BUFFER_SIZE` | int | `10000` | Защитный потолок буфера; переполнение — drop старых записей |
| `SECURITY__SINGLETON_LOCK_STALE_TTL_SEC` | int | `60` | TTL «stale» строки в `app_singleton_lock`. После него повторный старт перезапишет lock и стартанёт даже если предыдущий процесс не успел DELETE'нуть строку (kill -9, OOM). См. §2.2 в [`architecture-and-backend.md`](architecture-and-backend.md) и [troubleshooting](../operations/troubleshooting.md) №20 |

#### UA-справочники и ЦК-домены

| Переменная | Тип | По умолчанию | Описание |
|-----------|-----|-------------|----------|
| `UA_DATA__SCHEMA_NAME` | str | `""` | Схема UA-справочников (пустая — основная GP) |
| `UA_DATA__PROCESS_DICT` | str | `t_db_oarb_ua_process_dict` | Справочник процессов |
| `UA_DATA__TERBANK_DICT` | str | `t_db_oarb_ua_terbank_dict` | Справочник территориальных банков |
| `UA_DATA__VIOLATION_METRIC_DICT` | str | `t_db_oarb_ua_violation_metric_dict` | Справочник метрик нарушений |
| `UA_DATA__DEPARTMENTS` | str | `t_db_oarb_ua_departments` | Справочник подразделений |
| `UA_DATA__GOSB_DICT` | str | `t_db_oarb_ua_gosb_dict` | Справочник ГОСБов |
| `UA_DATA__VSP_DICT` | str | `t_db_oarb_ua_vsp_dict` | Справочник ВСП |
| `UA_DATA__CHANNEL_DICT` | str | `t_db_oarb_ua_channel_dict` | Справочник каналов |
| `UA_DATA__PRODUCT_DICT` | str | `t_db_oarb_ua_product_dict` | Справочник продуктов |
| `UA_DATA__TEAM_DICT` | str | `t_db_oarb_ua_team_dict` | Справочник команд аудита |
| `UA_DATA__SUBSIDIARY_DICT` | str | `t_db_oarb_ua_subsidiary_dict` | Справочник дочерних организаций |
| `UA_DATA__VIOLATION_RISK_TYPE_DICT` | str | `t_db_oarb_ua_violation_risk_type_dict` | Справочник типов риска (ЦК Фин.Рез.) |
| `CK_FIN_RES__SCHEMA_NAME` | str | `""` | Схема таблиц ЦК Фин.Рез. (пустая — основная GP) |
| `CK_FIN_RES__FR_VALIDATION_TABLE` | str | `t_db_oarb_ck_fr_validation` | Таблица валидации фин. результатов |
| `CK_FIN_RES__FR_VALIDATION_VIEW` | str | `v_db_oarb_ck_fr_validation` | Представление валидации фин. результатов |
| `CK_CLIENT_EXP__SCHEMA_NAME` | str | `""` | Схема таблиц ЦК Клиентский опыт (пустая — основная GP) |
| `CK_CLIENT_EXP__CS_VALIDATION_TABLE` | str | `t_db_oarb_ck_cs_validation` | Таблица валидации клиентского опыта |
| `CK_CLIENT_EXP__CS_VALIDATION_VIEW` | str | `v_db_oarb_ck_cs_validation` | Представление валидации клиентского опыта |
| `CK_FIN_RES__WORKING_SET_CAP` | int | `1000` | Порог рабочего набора таблицы ЦКФР (client-mode ↔ server-mode) и потолок limit поиска |
| `CK_CLIENT_EXP__WORKING_SET_CAP` | int | `1000` | Порог рабочего набора таблицы ЦК КО (client-mode ↔ server-mode) и потолок limit поиска |

#### Центр уведомлений и почта

`NotificationsSettings` (`app/domains/notifications/settings.py`). SMTP-фабрика `notifications.email` используется не только уведомлениями, но и доставкой ОТП-кодов (§9.3a).

| Переменная | Тип | По умолчанию | Описание |
|-----------|-----|-------------|----------|
| `NOTIFICATIONS__LIST_LIMIT` | int | `50` | Лимит по умолчанию для `GET /api/v1/notifications?limit=` |
| `NOTIFICATIONS__RETENTION_DAYS` | int | `90` | Срок хранения уведомлений (дни). Параметр заведён, фоновая очистка **не реализована** |
| `NOTIFICATIONS__POLL_INTERVAL_SECONDS` | int | `30` | Частота опроса персистентных уведомлений фронтом (отдаётся через `GET /config`) |
| `NOTIFICATIONS__EMAIL__ENABLED` | bool | `False` | Включить отправку email. `false` → ОТП-код пишется в лог сервера (`.env.dev`), `true` на ПРОМе |
| `NOTIFICATIONS__EMAIL__SMTP_HOST` | str | `smtp.company.com` | SMTP-сервер (ПРОМ: `SMTP.OMEGA.SBRF.RU`) |
| `NOTIFICATIONS__EMAIL__SMTP_PORT` | int | `587` | Порт SMTP (1-65535; ПРОМ: `2525`) |
| `NOTIFICATIONS__EMAIL__SMTP_USER` | str | `""` | Логин SMTP |
| `NOTIFICATIONS__EMAIL__SMTP_PASSWORD` | str | `""` | Пароль SMTP. Обычный `str`, **не** `SecretStr` — в логах маскирования нет |
| `NOTIFICATIONS__EMAIL__DEFAULT_FROM` | str | `noreply@company.com` | Адрес в поле From |

#### SQL-агент (Text-to-SQL)

`SQLAgentSettings` (`app/domains/sqlagent/settings.py`). SQLAgent работает отдельным uvicorn-процессом, приложение встраивает его UI в iframe.

| Переменная | Тип | По умолчанию | Описание |
|-----------|-----|-------------|----------|
| `SQLAGENT__ENABLED` | bool | `True` | Включён ли домен SQL-агента |
| `SQLAGENT__SIDECAR_PORT` | int | `8005` | Порт sidecar-процесса SQLAgent на localhost |
| `SQLAGENT__PUBLIC_URL` | str | `""` | Публичный URL UI для iframe (на SDP — адрес sidecar-порта того же хоста). Пусто → фолбэк `http://localhost:{sidecar_port}/` |

### 9.5a Observability: HTTP metrics и MetricsBatcher

Приложение собирает несколько независимых потоков метрик и аудита и пишет их в БД через единый асинхронный батчер. Сделано так, чтобы запись не блокировала горячий путь HTTP-запроса.

**MetricsBatcher** (`app/core/metrics_batcher.py`) — общий буфер с двумя триггерами flush:

| Триггер | Когда срабатывает | Настройка |
|---|---|---|
| По размеру пакета | Накоплено N записей | `OBSERVABILITY__METRICS_BATCH_SIZE` (default 100) |
| По времени | Прошло N секунд от последнего flush | `OBSERVABILITY__METRICS_FLUSH_INTERVAL_SEC` (default 5.0) |

Защитный потолок — `OBSERVABILITY__METRICS_MAX_BUFFER_SIZE` (10000). При переполнении старые записи дропаются (защита от OOM, если БД недоступна).

**Пять источников, использующих батчер** (все управляются через единые lifespan hooks — см. §2.2 в [`architecture-and-backend.md`](architecture-and-backend.md)):

| Источник | Файл | Hook | Что пишет | Куда |
|---|---|---|---|---|
| HTTP-запросы | `app/core/middlewares/http_metrics.py` | `admin.http_metrics_batcher` | path, method, status, latency_ms, user, request_id | `http_metrics` |
| Отказы доступа | `require_domain_access` (`app/api/v1/deps/role_deps.py`) | `admin.access_denied_audit_batcher` | username, domain, path, method, reason | `access_denied_audit` (см. §9.5c) |
| Chat tool-метрики | `ChatAuditService` (`app/domains/chat/services/chat_audit_service.py`) | `chat.tool_metrics_batcher` | tool_name, user, latency, success, error | `chat_tool_metrics` |
| Chat audit-log | `ChatAuditService` (`app/domains/chat/services/chat_audit_service.py`) + `chat_audit_log_repository.py` | `chat.audit_log_batcher` | event_type, conversation_id, user, payload | `chat_audit_log` |
| Acts audit-log | `ActAuditLogBatcher` (`app/domains/acts/services/audit_log_batcher.py`) | `acts.audit_log_batcher` | act_id, action, details (JSONB), user | `audit_log` |

HTTP metrics middleware **выключен по умолчанию** (в обоих шаблонах `.env` тоже `false`) — включить через `ADMIN__HTTP_METRICS_ENABLED=true`. Нагрузка на приложение низкая, и запись метрики на каждый запрос — overkill; включается точечно для расследований latency/троттлинга.

**Сервис чтения** — `app/domains/admin/services/http_metrics_service.py` — отдаёт агрегаты для админ-панели (top-N медленных эндпоинтов, частота ошибок 5xx и т.п.).

**Дополнительные фоновые сервисы (без отдельных метрик, только логи + статус в diagnostics):**

- `AgentChannelPoller` (`chat.agent_channel_poller`) — INFO на start/stop, exception-логи при сбоях тика. Полезно для отладки «почему ответ агента не появляется».
- `LLMHealthProbe` (`chat.llm_health_probe`) — пингует primary-LLM при разомкнутом circuit breaker (`CHAT__HEALTH_PROBE__*`).
- `DbPoolMonitor` (`admin.db_pool_monitor`) — WARNING при загрузке пула выше `ADMIN__DB_POOL_MONITOR__WARN_RATIO`.

**Полный список startup-хуков** (`register_startup_hook`): `auth.redis` (fail-fast поднятие Redis), `acts.audit_log_batcher`, `admin.http_metrics_batcher`, `admin.access_denied_audit_batcher`, `admin.db_pool_monitor`, `chat.tool_metrics_batcher`, `chat.audit_log_batcher`, `chat.agent_channel_poller`, `chat.llm_health_probe`, `notifications.email_init`. Задачи `acts.expired_locks_cleanup` больше нет — локи актов живут на Redis-TTL и истекают сами.

**Параметры `ActAuditLogBatcher`** (`acts.audit_log_batcher`) отличаются от общих `OBSERVABILITY__*`:
- `batch_size=50` (а не 100 — операций пользователей в среднем меньше, чем HTTP-запросов).
- `flush_interval_sec=30.0` (а не 5.0 — допустимо потерять до 50 записей при крэше; типичная сессия в редакторе длиннее flush-интервала).
- `max_buffer_size=5000`.

Эти значения зашиты в коде батчера (`audit_log_batcher.py`) — менять через env пока не требуется.

### 9.5b Diagnostics endpoint и `observability_registry`

`observability_registry` (`app/core/observability_registry.py`) — процесс-локальный реестр всех `MetricsBatcher`'ов и фоновых задач, у которых есть `get_status() -> dict`. Endpoint `GET /api/v1/admin/diagnostics` отдаёт снимок всего реестра в виде:

```json
{
  "batchers": {
    "admin.http_metrics_batcher": {"name": "...", "buffer_size": 3, "max_buffer_size": 10000,
      "max_batch_size": 100, "flush_interval_sec": 5.0, "dropped_count": 0,
      "last_flush_ago_sec": 4.7, "last_error": null, "running": true},
    "admin.access_denied_audit_batcher": {...},
    "chat.tool_metrics_batcher": {...},
    "chat.audit_log_batcher": {...},
    "acts.audit_log_batcher": {...}
  },
  "background_tasks": {
    "admin.db_pool_monitor": {"name": "...", "running": true, ...},
    "chat.agent_channel_poller": {...},
    "chat.llm_health_probe": {"name": "...", "running": true, "breaker_state": "closed",
      "current_interval_sec": 2.0, "last_ping_ok": true}
  }
}
```

**Защита.** Endpoint требует роль `Админ` через `Depends(require_domain_access("admin"))`. Дефолтного админа задаёт `ADMIN__USER_DIRECTORY__DEFAULT_ADMIN`.

**API реестра** (`observability_registry.py`):

| Функция | Назначение |
|---|---|
| `register_batcher(name, obj)` | Регистрирует объект с методом `get_status() -> dict` (проверка через runtime-протокол `HasGetStatus`). Повторный вызов с тем же именем перезаписывает запись |
| `register_background_task(name, status_fn)` | Регистрирует фоновую задачу — `status_fn` вызывается без аргументов, должен вернуть dict с минимум `name` и `running` |
| `unregister_batcher(name)` / `unregister_background_task(name)` | Идемпотентное удаление |
| `get_all_statuses() -> dict` | Снимок всего реестра. Изоляция ошибок: если у одного компонента `get_status()` упадёт — в ответе будет `{"name": ..., "error": "TypeError: ..."}` вместо валидного status, остальные компоненты вернутся корректно |
| `reset()` | Полная очистка (только для тестов) |

**Регистрация.** Каждый домен поднимает свои batcher'ы / фоновые задачи в startup-hook (`_lifecycle.py` для acts/admin, `__init__.py` для chat) и регистрирует их в `observability_registry` сразу после `start()`. На shutdown — симметричное `unregister_*`. Полный список:

| Имя в реестре | Что | Где регистрируется |
|---|---|---|
| `acts.audit_log_batcher` | `MetricsBatcher` | `app/domains/acts/_lifecycle.py:37` |
| `admin.http_metrics_batcher` | `MetricsBatcher` | `app/domains/admin/_lifecycle.py:148` |
| `admin.access_denied_audit_batcher` | `MetricsBatcher` | `app/domains/admin/_lifecycle.py:195` |
| `admin.db_pool_monitor` | background-task | `app/domains/admin/_lifecycle.py:236` |
| `chat.tool_metrics_batcher` | `MetricsBatcher` | `app/domains/chat/__init__.py:115` |
| `chat.audit_log_batcher` | `MetricsBatcher` | `app/domains/chat/__init__.py:154` |
| `chat.agent_channel_poller` | background-task | `app/domains/chat/__init__.py:186` |
| `chat.llm_health_probe` | background-task | `app/domains/chat/__init__.py:226` |

**`MetricsBatcher.get_status()` поля.** См. `app/core/metrics_batcher.py:313-343`. Самое важное на эксплуатации:

- `dropped_count` — суммарно потеряно записей за всё время жизни процесса. `> 0` означает либо переполнение буфера (поток событий быстрее, чем GP принимает), либо стабильный fail flush'ей.
- `last_error` — текст последнего исключения flush'а (`type(e).__name__: message`); обнуляется при следующем успешном flush'е.
- `last_flush_ago_sec` — секунд с последнего успешного flush'а (`None`, если flush'ей ещё не было).
- `running` — жива ли фоновая задача `_run_periodic`. Если `false` при ожидании активности — серьёзный сигнал.

Связано с [troubleshooting](../operations/troubleshooting.md) №21 («Записи пропадают в батчерах»).

### 9.5c Audit-лог отказов доступа (`access_denied_audit`)

Append-only журнал случаев, когда `require_domain_access(domain)` (`app/api/v1/deps/role_deps.py:155-178`) вернул 403. Появился в Wave 1 backend-hardening — на closed-network инциденте «кто-то ломился в админку» / «юзер пытался открыть чужой ЦК-домен» теперь видно, что и куда.

**Таблица** `{SCHEMA}.{PREFIX}access_denied_audit`:

| Колонка | Тип | Назначение |
|---|---|---|
| `id` | BIGSERIAL / sequence | PK, DISTRIBUTED BY (id) |
| `username` | varchar | Пользователь, которому отказано |
| `domain` | varchar | Запрошенный домен (`acts`, `chat`, `ck_fin_res`, ...) |
| `path` | varchar | HTTP-путь запроса |
| `method` | varchar | HTTP-метод |
| `reason` | varchar (nullable) | Краткий контекст (`roles=[...], missing domain_name=...`) |
| `created_at` | timestamp | Время отказа |

Индексы: `(username, created_at DESC)`, `(domain, created_at DESC)` — типовые срезы по пользователю и по домену. Схемы — `app/domains/admin/migrations/{postgresql,greenplum}/schema.sql`.

**Pipeline записи.** `require_domain_access` при 403 вызывает `_log_access_denied(...)` (тот же файл, строки 181-222) — формирует `AccessDeniedRecord` (frozen dataclass, `app/domains/admin/repositories/access_denied_audit.py:18-26`) и кладёт его в `_access_denied_audit_batcher` (singleton-обёртка над `MetricsBatcher`, `app/domains/admin/deps.py:37-67`). Сам флаш — `AccessDeniedAuditRepository.log_many(records)` (bulk `executemany` в транзакции).

**Failure-safe.** 403-ответ пользователю никогда не задерживается ожиданием БД и не падает из-за поломки батчера: если батчер не поднят (например, в тестах) — пишется WARNING-лог `Отказ доступа username=... (батчер аудита не поднят — запись пропущена)`. Если `batcher.add(...)` бросает — `exception` ловится и тоже логируется, ответ 403 уходит как обычно.

**Параметры батчера** общие observability: `OBSERVABILITY__METRICS_BATCH_SIZE` (100), `OBSERVABILITY__METRICS_FLUSH_INTERVAL_SEC` (5.0), `OBSERVABILITY__METRICS_MAX_BUFFER_SIZE` (10000). Регистрируется в `observability_registry` под именем `admin.access_denied_audit_batcher` (см. §9.5b).

**Чтение для расследования инцидента:**

```sql
-- Кто и куда ломился за последние сутки
SELECT username, domain, path, method, reason, created_at
FROM {SCHEMA}.{PREFIX}access_denied_audit
WHERE created_at > now() - interval '24 hours'
ORDER BY created_at DESC
LIMIT 100;

-- Топ-юзеров по числу отказов
SELECT username, count(*) AS denied_count
FROM {SCHEMA}.{PREFIX}access_denied_audit
WHERE created_at > now() - interval '7 days'
GROUP BY username
ORDER BY denied_count DESC
LIMIT 20;
```

### 9.6 Retention bus-таблицы chat_agent_messages_bus

Канал к внешнему ИИ-агенту использует **одну** bus-таблицу `chat_agent_messages_bus` (см. §7.8 и §11.5 в [`ai-assistant.md`](ai-assistant.md)) в основной БД. Кода ретеншена в приложении НЕТ — очистка задача администратора БД (сознательное решение: на проде GP таблицы партиционируются, а DELETE под нагрузкой дороже `DROP PARTITION`).

**Ключевое утверждение**: ответы внешнего агента маппятся в блоки (`map_answer_to_blocks`) и сохраняются в `chat_messages.content` (JSONB). Очистка `chat_agent_messages_bus` **НЕ удаляет** видимую пользователю историю чата: пользователь читает `chat_messages`. `chat_agent_messages_bus` нужна только во время обработки запроса + изредка для разбора инцидентов.

**Правила безопасной очистки:**

1. Удалять только записи в терминальном статусе (`status IN ('completed', 'failed')`).
2. И только старше N дней (`created_at < now() - INTERVAL 'N days'`, рекомендация: 30 дней).
3. **Не трогать** `pending` / `processing` — это активные запросы; `AgentChannelPoller` подхватит их (или переведёт draft в `failed` по `CLAIM_TIMEOUT_SEC` / `ANSWER_TIMEOUT_SEC`).

**Рекомендация по частоте**: cron раз в неделю в окне низкой нагрузки; после массовой чистки — `VACUUM ANALYZE` (PG). На GP `chat_agent_messages_bus` имеет смысл партиционировать по `created_at` (RANGE month) — `DROP PARTITION` на порядок быстрее DELETE и не лочит таблицу. Плейсхолдеры `{SCHEMA}`/`{PREFIX}` подставляются вручную перед запуском.

---
