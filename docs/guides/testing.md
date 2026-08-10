# Тестирование

> Часть гайд-бука разработчика Audit Workstation. Точка входа и навигация по всем частям — [`developer-guide.md`](developer-guide.md).

Стек, структура тестов, фикстуры сброса реестров, паттерны тестирования сервисов и эндпоинтов.
Нумерация разделов (§8) сохранена от единого гайд-бука.


## Оглавление

- [8. Тестирование](#8-тестирование)
  - [8.1 Стек и структура](#81-стек-и-структура)
  - [8.2 Фикстуры: сброс реестров](#82-фикстуры-сброс-реестров)
  - [8.3 (раздел удалён)](#83-раздел-удалён)
  - [8.4 Тестирование сервисов и репозиториев](#84-тестирование-сервисов-и-репозиториев)
  - [8.5 Пример: тест для нового эндпоинта](#85-пример-тест-для-нового-эндпоинта)

---

## 8. Тестирование

### 8.1 Стек и структура

| Инструмент | Назначение |
|-----------|-----------|
| pytest | Фреймворк (несколько тысяч backend-тестов; точное число — `pytest --collect-only`) |
| pytest-asyncio | Async-тесты |
| httpx / TestClient | API-тесты (через `dependency_overrides`) |
| unittest.mock (AsyncMock, MagicMock) | Моки репозиториев и сервисов |
| node:test (`*.test.mjs`) | JS-юнит-тесты фронта (~1750 тестов; точное число — `npm run test:js`) |
| Playwright (`*.spec.*`) | E2E-сценарии конструктора (требуют поднятого сервера + seed). Два проекта — см. ниже |

**Playwright: два проекта в `playwright.config.ts`.** Обычный `chromium` и `chromium-scrollbars` (`ignoreDefaultArgs: ['--hide-scrollbars']`). Второй нужен спеке `27-preview-fit-stability`: она воспроизводит петлю «скроллбар ↔ fit-масштаб», а headless Chromium по умолчанию стартует с `--hide-scrollbars`, скроллбар не занимает места в layout и петля физически не возникает — спека проходила бы вхолостую. Разведены жёстко: `chromium` игнорирует спеку 27 (`testIgnore`), `chromium-scrollbars` берёт только её (`testMatch`). `npm run e2e` без аргументов гоняет оба проекта; запуск с `--project=chromium` молча пропустит спеку 27.

**Иерархия тестов** (backend — см. `pytest --collect-only`; фронт — `npm run test:js`):

```
tests/
├── conftest.py                       — общие фикстуры (fake_redis + strict_acquire_guard autouse,
│                                        mock_conn, mock_adapter)
├── core/                             — тесты ядра: DomainDescriptor, chat blocks, block_id generator,
│                                        observability/metrics-batcher registry, notifications-emit,
│                                        Redis-адаптер (7 файлов)
├── db/                               — адаптеры PG/GP, DbExecutor (connection-per-operation), init_db (3 файла)
├── domains/
│   ├── acts/                         — lock/audit-log/export/restructure/invoice + e2e API (31 файл;
│   │                                    + formatters/docx/ — DOCX-рендеринг, 19 файлов; + golden/ — parity-снимки экспорта)
│   ├── admin/                        — http_metrics repository/service, db_pool_monitor, access_denied_audit (5 файлов)
│   ├── chat/                         — 48 файлов: orchestrator, agent_channel, redis-bridge,
│   │                                   GigaChat adapter, retry, circuit breaker, LLM fallback,
│   │                                   audit-log, tool-метрики, rate-limit, блоки сообщений
│   ├── ua_data/                      — dictionary service + e2e API (3 файла)
│   ├── ck_fin_res/                   — group search/settings (см. также test_ck_fin_res/)
│   ├── ck_client_exp/                — search/settings (см. также test_ck_client_exp/)
│   └── notifications/                — repository/service + e2e API (4 файла)
├── test_admin/                       — admin repository/service, audit-log, user_directory/avatars (5 файлов)
├── test_ck_fin_res/, test_ck_client_exp/, test_ua_data/  — ЦК-домены и UA-справочники
└── (на верхнем уровне)               — горизонтальные: auth (7 файлов), middleware, navigation,
                                        settings, schemas, arch reliability, GP compatibility,
                                        connection budget ratchet (`test_connection_budget.py`),
                                        CHECK constraints, no cross-domain imports, role deps,
                                        per-domain health, singleton lock, metrics batcher,
                                        logging, http_metrics middleware
```

По составу тесты делятся на: backend unit (репозитории/сервисы через `mock_conn`/`mock_adapter`) — основная масса; e2e API через `dependency_overrides`; GP compatibility и прочие архитектурные lint'ы (no cross-domain imports, connection budget ratchet и т.п.); россыпь тестов utils/schemas/exceptions. Точных долей не приводим — не измеряли, а на глаз можно ошибиться.

Каждая категория — по 1-2 строки. Полный список ищите через `Glob: tests/**/*.py` — фактическое количество файлов меняется быстрее, чем этот документ.

### 8.2 Фикстуры: сброс реестров

Доменная система использует глобальное состояние. Между тестами его нужно сбрасывать. **Паттерн**: каждый тест-файл определяет свою `autouse`-фикстуру, сбрасывающую **только** используемые реестры — не «всё на всякий случай», иначе тесты становятся медленнее и теряют изоляцию причин.

```python
# Пример: в тест-файле chat tools
from app.core.chat.tools import reset as reset_chat_tools

@pytest.fixture(autouse=True)
def clean():
    reset_chat_tools()
    yield
    reset_chat_tools()
```

Доступные точки сброса:
- `domain_registry.reset_registry()` — для тестов доменов и навигации
- `settings_registry.reset()` — для тестов настроек
- `app.core.chat.tools.reset()` — для тестов chat tools
- `_user_locks.clear()` (`app/domains/chat/services/conversation_service.py`) — для тестов сервисов с in-process `asyncio.Lock`; сбрасывается через autouse-фикстуру в тест-файлах, использующих этот сервис (см. `tests/domains/chat/test_chat_race_conditions.py`, `tests/domains/chat/test_chat_feedback_service.py`) — иначе `asyncio.Lock` из закрытого event loop переиспользуется в новом тесте и ловится flaky «got Future attached to a different loop»
- `get_settings.cache_clear()` — обязательно, если тест меняет env: `get_settings()` помечен `@lru_cache` (см. `app/core/config.py`), без сброса soak'нется значение от предыдущего теста

`register_fake_push_factory()` (`tests/conftest.py`) — хелпер, а не фикстура: регистрирует фейковую фабрику `notifications.push` в `domain_registry` для тестов-продьюсеров уведомлений (acts, chat, core), раньше побайтово копировался в трёх тест-файлах. Сам ничего не откатывает — сброс на вызывающем тест-файле через `domain_registry.reset_registry()`.

Общие фикстуры в `tests/conftest.py`, обе — **autouse**.

`fake_redis`: Redis обязателен во всех окружениях, включая pytest (см. §9.5 в [`deploy-and-configuration.md`](deploy-and-configuration.md)), поэтому `get_redis()` не отдаёт None, а бросает `RuntimeError`. Фикстура играет роль startup-хука, подставляя fakeredis в модульный синглтон; свежий инстанс на каждый тест изолирует ключи (иначе блокировка акта из одного теста жила бы 15 минут и ломала соседний). Lua-скрипты исполняются по-настоящему — за это отвечает `lupa`.

`strict_acquire_guard`: форсит строгий режим стража повторного захвата соединения (`DATABASE__STRICT_ACQUIRE_GUARD`, см. `app/db/connection.py::get_db`) на каждом тесте — вложенный `get_db()` в одном task падает `RuntimeError`, а не тихим WARNING. Патчит и `app.db.connection._strict_acquire_guard` напрямую, и env-переменную (`init_db()` перезаписывает первое вторым), плюс сбрасывает `get_settings.cache_clear()` до и после — без этого `setenv` не подействовал бы на уже закэшированный `Settings`. Тесты, которые намеренно проверяют warning-режим (не строгий), локально возвращают `False` через `monkeypatch` — см. `tests/db/test_executor.py::test_nested_get_db_warns_by_default`.

```python
import fakeredis.aioredis
import pytest
from unittest.mock import AsyncMock, MagicMock

from app.core import redis as redis_module
from app.core.config import RedisSettings
from app.core.redis import RedisAdapter

@pytest.fixture(autouse=True)
def fake_redis():
    """Подставляет fakeredis в app.core.redis._adapter на каждый тест."""
    adapter = RedisAdapter(RedisSettings())
    adapter._client = fakeredis.aioredis.FakeRedis(decode_responses=True)
    redis_module._adapter = adapter
    yield adapter
    redis_module._adapter = None

@pytest.fixture(autouse=True)
def strict_acquire_guard(monkeypatch):
    """Форсит строгий режим стража повторного захвата get_db() на каждом тесте."""
    import app.db.connection as dbconn
    from app.core.config import get_settings

    monkeypatch.setattr(dbconn, "_strict_acquire_guard", True)
    monkeypatch.setenv("DATABASE__STRICT_ACQUIRE_GUARD", "true")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()

@pytest.fixture
def mock_conn():
    """Mock asyncpg.Connection для unit-тестов репозиториев."""
    conn = AsyncMock()
    conn.fetchrow = AsyncMock()
    conn.fetchval = AsyncMock()
    conn.fetch = AsyncMock()
    conn.execute = AsyncMock()
    conn.executemany = AsyncMock()

    # Mock менеджера транзакций
    tx = AsyncMock()
    tx.__aenter__ = AsyncMock(return_value=tx)
    tx.__aexit__ = AsyncMock(return_value=False)
    conn.transaction = MagicMock(return_value=tx)

    return conn

@pytest.fixture
def mock_adapter():
    """Mock DatabaseAdapter для unit-тестов."""
    adapter = MagicMock()
    adapter.get_table_name = lambda name, schema="": name
    adapter.qualify_table_name = lambda name, schema="": name
    adapter.supports_on_conflict = MagicMock(return_value=True)
    return adapter
```

### 8.3 (раздел удалён)

### 8.4 Тестирование сервисов и репозиториев

**Базовый паттерн репозитория** (`mock_conn` + autouse-патч `get_adapter`):

```python
import pytest
from unittest.mock import patch
from app.domains.acts.repositories.act_crud import ActCrudRepository

@pytest.fixture(autouse=True)
def _patch_adapter(mock_adapter):
    with patch("app.db.repositories.base.get_adapter", return_value=mock_adapter):
        yield

@pytest.mark.asyncio
async def test_check_km_exists(mock_conn):
    mock_conn.fetchrow.return_value = {
        "total_count": 1, "max_part_no_sn": 1, "with_service_notes": 0,
    }
    repo = ActCrudRepository(mock_conn)
    result = await repo.check_km_exists("КМ-24-12345")
    assert result["exists"] is True
```

Реального `db_conn` нет — integration-фикстуры с поднятой БД отсутствуют. Integration-тесты делаются через мокирование БД и LLM (см. `tests/domains/chat/test_forward_tool_factory.py` и forward-сценарии в `tests/domains/chat/test_chat_api_e2e.py`).

**Важные правила:**

- **Новый метод в `*Repository`** — обновить `_make_mock_repo_with_conn()` (или эквивалентную фабрику mock-репо) в тест-файлах, прописав явный `mock.<new_method>.return_value = <sensible_default>`. Иначе `AsyncMock` вернёт truthy-объект и сломает существующие тесты, которые ожидают `None`/`False` от нового метода. См. `tests/domains/chat/test_chat_services.py` как образец.

- **Handler-функции с `get_db`/`get_adapter`** (например, action-handlers) — импортируй их **внутри функции**, не на module-level. Module-level импорт связывает имена при старте модуля и обходит `patch.multiple("app.db.connection", get_db=..., get_adapter=...)` — патч заменяет атрибуты в `app.db.connection`, но handler уже держит свои локальные ссылки.

  ```python
  # Нельзя — module-level импорт обойдёт patch:
  from app.db.connection import get_db, get_adapter

  async def handle_open_act_page(args, user_id):
      async with get_db() as conn:   # эта ссылка зафиксирована при импорте
          ...

  # Нужно — импорт внутри функции, patch.multiple срабатывает:
  async def handle_open_act_page(args, user_id):
      from app.db.connection import get_db, get_adapter
      async with get_db() as conn:
          ...
  ```

- **Тесты доменных Settings (`*DomainSettings`)** — НЕ через `_load_from_env` для проверки дефолтов: pydantic-settings подсасывает реальный `.env` пользователя, и тест зависит от конфига разработчика. Инстанцируй модель напрямую: `ChatDomainSettings(api_base="...", api_key="...", model="...")`. `_load_from_env` оставь только для nested env-override (`CHAT__RETRY__ON_429` и т.п.) с `monkeypatch.setenv`.

- **`@pytest.mark.xfail(strict=False)` запрещён** для известных багов. Маркер проходит и когда тест падает (XFAIL), и когда внезапно начинает проходить (XPASS) — регрессия в обе стороны не ловится. Используй `strict=True` (XPASS становится ошибкой и сигнализирует, что баг исправлен и пора убирать маркер) либо фикси баг и переводи тест в обычный pass.

  ```python
  # Нельзя — XPASS пройдёт молча, регрессия не заметна:
  @pytest.mark.xfail(strict=False, reason="GigaChat 422 на arguments=string")
  def test_translate_messages_assistant_tool_calls():
      ...

  # Нужно — либо strict=True:
  @pytest.mark.xfail(strict=True, reason="GigaChat 422 на arguments=string")
  def test_translate_messages_assistant_tool_calls():
      ...

  # Либо фикс бага + обычный тест без маркера:
  def test_translate_messages_assistant_tool_calls():
      ...
  ```

- **Тесты могут фиксировать БАГ как ожидаемое поведение.** Прошлый автор мог зашить текущее (багованное) поведение как «должно быть». При фиксе бага проверяй, что тест ассертит **правильную** семантику — обновляй старые ассерты, а не только добавляй новые сценарии. Пример: `test_translate_messages_assistant_tool_calls_to_function_call` ожидал `arguments` как JSON-string (был баг → 422 GigaChat); при фиксе обновлён на DICT.

- **Парсинг SQL-схем в тестах — через `DatabaseAdapter._split_sql_statements()`**, не `split(';')`. Наивный split по `;` не учитывает `;` внутри строковых литералов, line-комментариев и dollar-quoting → statement бьётся на куски и regex-поиск констрейнтов даёт false-positive матчи. Дополнительно перед regex-поиском вырезай line-комментарии (`re.sub(r'--[^\n]*', '', stmt)`) — иначе документация вида `-- DISTRIBUTED BY (col)` шадовит реальный clause.

  ```python
  # Нельзя — split(';') рвёт dollar-quoted body и не убирает комментарии:
  with open(schema_path) as f:
      statements = f.read().split(";")
  for stmt in statements:
      if re.search(r"DISTRIBUTED BY \((\w+)\)", stmt):
          ...

  # Нужно — split через адаптер + вырезание комментариев перед regex:
  from app.db.adapters.base import DatabaseAdapter

  with open(schema_path) as f:
      sql = f.read()
  for stmt in DatabaseAdapter._split_sql_statements(sql):
      clean = re.sub(r"--[^\n]*", "", stmt)
      if re.search(r"DISTRIBUTED BY \((\w+)\)", clean):
          ...
  ```

**Тестирование ChatTool реестра:**

```python
from app.core.chat.tools import ChatTool, ChatToolParam, register_tools, get_tool, reset

@pytest.fixture(autouse=True)
def clean():
    reset()
    yield
    reset()

def test_register_and_get():
    tool = ChatTool(name="test_tool", description="desc")
    register_tools([tool])
    assert get_tool("test_tool") is tool
```

### 8.5 Пример: тест для нового эндпоинта

> **Не используйте** прямой `from app.main import app` + `TestClient(app)` в новых тестах: это тянет реальный `lifespan` (БД, LLM, миграции) и ломает CI. Если встретили такой паттерн в legacy-тестах — перепишите на минимальный `FastAPI()` ниже.

Тесты эндпоинтов в проекте **НЕ** используют `app.main.create_app()` / `app.main.app` напрямую — это тянет `lifespan` с реальной БД и LLM. Вместо этого собирают **минимальный** `FastAPI()`, подключают нужные роутеры и переопределяют зависимости через `app.dependency_overrides`.

```python
import pytest
from unittest.mock import AsyncMock, MagicMock
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.deps.auth_deps import get_username
from app.api.v1.deps.role_deps import get_user_roles
from app.domains.acts.api.management import router as acts_router
from app.domains.acts.deps import get_crud_service


@pytest.fixture
def test_app():
    app = FastAPI()
    app.include_router(acts_router, prefix="/api/v1/acts")

    mock_service = AsyncMock()
    mock_service.list_acts.return_value = [
        {"id": 1, "km_number": "КМ-24-12345"}
    ]

    app.dependency_overrides[get_username] = lambda: "12345678"
    app.dependency_overrides[get_user_roles] = lambda: [{"role_id": "admin"}]
    app.dependency_overrides[get_crud_service] = lambda: mock_service

    yield app, mock_service

    app.dependency_overrides.clear()


def test_list_acts_returns_data(test_app):
    app, mock_service = test_app
    client = TestClient(app)

    response = client.get("/api/v1/acts/")

    assert response.status_code == 200
    assert response.json()[0]["km_number"] == "КМ-24-12345"
    mock_service.list_acts.assert_called_once()
```

**Сообщения чата (POST + polling)** — POST отдаёт `{message_id}`, затем `GET /messages/{message_id}` опрашивается до терминального статуса:

```python
def test_chat_message_returns_id_then_completes(test_app):
    app, mock_orchestrator = test_app

    client = TestClient(app)
    resp = client.post(
        "/api/v1/chat/conversations/c1/messages",
        data={"message": "Привет", "agent_mode": "off"},
    )
    assert resp.status_code == 200
    message_id = resp.json()["message_id"]

    got = client.get(f"/api/v1/chat/conversations/c1/messages/{message_id}")
    assert got.json()["status"] in {"complete", "failed", "streaming"}
```

Реальные примеры паттерна:
- `tests/domains/chat/test_chat_api_e2e.py` — чат-эндпоинты, polling сообщений, `dependency_overrides` для сервисов
- `tests/domains/acts/test_acts_api_e2e.py` — CRUD актов
- `tests/domains/acts/test_content_api_e2e.py` — контент акта (auth + service override)
- `tests/domains/ua_data/test_ua_data_api_e2e.py` — справочники

**Доменные исключения чата** — сервисы кидают `ChatLimitError`/`ChatFileValidationError`/`ConversationNotFoundError`/`ChatFileNotFoundError` (`app/domains/chat/exceptions.py`, наследники `AppError` со зашитым `status_code`), **НЕ** `fastapi.HTTPException`. Тестируется через `pytest.raises(ChatLimitError)` + проверка `exc.status_code` и `str(exc)`:

```python
from app.domains.chat.exceptions import ChatLimitError

@pytest.mark.asyncio
async def test_message_limit_exceeded(service):
    with pytest.raises(ChatLimitError) as exc_info:
        await service.send_message(user_id="u1", text="...")
    assert exc_info.value.status_code == 422
    assert "лимит" in str(exc_info.value).lower()
```

---
