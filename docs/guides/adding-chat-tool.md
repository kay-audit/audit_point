# Как добавить новый ChatTool

Пошаговый гайд для добавления инструмента (function calling) в AI-чат.

Существует два типа инструментов:

- **Обычный tool** — возвращает текст (или JSON), LLM использует его для
  формирования ответа. Пример: «получить список актов пользователя».
- **Action tool** — возвращает `ClientActionBlock` (`open_url`, `notify`,
  `trigger_sdk`). LLM не генерит «сводку» поверх — это **terminal-tool**
  (см. `agent_loop.py`). Пример: «открыть страницу акта».

Гайд покрывает оба сценария — отличия отмечены **🅐 Action-only**.

---

## Шаг 1. Константа имени в `app/core/chat/names.py`

Имена ChatTool централизованы. Добавь константу формата `<domain>.<verb>_<object>`:

```python
# app/core/chat/names.py

TOOL_GET_USER_ACTS: Final[str] = "acts.get_user_acts"
```

**Зачем централизация:** orchestrator, кнопочные транслейторы и тесты
ссылаются на имя — переименование в одном месте.

---

## Шаг 2. Handler инструмента в `app/domains/<domain>/integrations/`

Handler — `async`-функция, принимает `**kwargs` (или явные аргументы) и
возвращает `str`. Для action-тулов возвращай JSON-строку с
`ClientActionBlock`:

```python
# app/domains/acts/integrations/action_handlers.py
import json

async def get_user_acts_handler(*, username: str, limit: int = 10) -> str:
    """Возвращает JSON-список последних N актов пользователя."""
    from app.db.connection import get_db  # import внутри функции — для patch'а в тестах
    from app.domains.acts.repositories.acts_repository import ActsRepository

    async with get_db() as conn:
        repo = ActsRepository(conn)
        acts = await repo.list_recent_by_user(username, limit=limit)
    return json.dumps({"acts": [a.to_dict() for a in acts]}, ensure_ascii=False)


# 🅐 Action-only: handler возвращает JSON ClientActionBlock
from app.core.chat.names import ACTION_OPEN_URL

async def open_act_page_handler(*, km_number: str) -> str:
    return json.dumps({
        "type": "client_action",
        "action": ACTION_OPEN_URL,
        "params": {"url": f"/constructor?act_id=<int>"},
        "label": f"Открыть акт {km_number}",
    })
```

**Контракты handler'а:**

- Чисто `async def`, возвращает `str`. Если возвращаешь dict — оркестратор
  не будет парсить.
- Импорты `get_db` / `get_adapter` — **внутри функции**, а не на module-level:
  module-level импорт связывает имена при старте и обходит patch. Тесты
  патчат через `patch.multiple("app.db.connection", get_db=..., get_adapter=...)`.
- Для action-тулов возвращай валидный JSON `ClientActionBlock`:
  `{"type": "client_action", "action": ..., "params": {...}, "label": ...}`.
  Сервер припишет `block_id` детерминированно (`{message_id}:client_action:{i}`).
- При ошибке валидации параметров `raise ChatToolValidationError(...)` —
  оркестратор поймает и эмитит `tool_error` без падения чата.
  Импорт: `from app.domains.chat.exceptions import ChatToolValidationError`.

---

## Шаг 3. Регистрация ChatTool в `app/domains/<domain>/integrations/chat_tools.py`

```python
# app/domains/acts/integrations/chat_tools.py
from app.core.chat.names import TOOL_GET_USER_ACTS
from app.core.chat.tools import ChatTool, ChatToolParam
from app.domains.acts.integrations.action_handlers import get_user_acts_handler

_DOMAIN = "acts"


def get_chat_tools() -> list[ChatTool]:
    return [
        ChatTool(
            name=TOOL_GET_USER_ACTS,
            domain=_DOMAIN,
            description=(
                "Получить последние акты пользователя. "
                "Использовать когда пользователь спрашивает "
                "«какие у меня акты?» или «покажи мои последние акты»."
            ),
            parameters=[
                ChatToolParam(
                    name="username",
                    type="string",
                    description="Логин пользователя",
                    required=True,
                ),
                ChatToolParam(
                    name="limit",
                    type="integer",
                    description="Максимум актов (по умолчанию 10)",
                    required=False,
                    default=10,
                ),
            ],
            handler=get_user_acts_handler,
            category="query",
        ),
    ]
```

**Подсказки по `description`:** LLM выбирает tool по описанию.
Полезно явно указать «использовать когда X» и «не использовать когда Y» —
это снижает ложные срабатывания.

**Типы параметров (`ChatToolParam.type`):** `string`, `integer`, `boolean`,
`array`, `object`, `date`. Для `array` — `items_type` указывает тип элементов.
Для `enum` — список разрешённых значений.

---

## Шаг 4. Регистрация в DomainDescriptor

Подключи `get_chat_tools()` в `__init__.py` домена:

```python
# app/domains/acts/__init__.py
from app.core.domain_registry import DomainDescriptor

def _build_domain() -> DomainDescriptor:
    from app.domains.acts.integrations.chat_tools import get_chat_tools
    # ... остальная сборка ...
    return DomainDescriptor(
        name="acts",
        chat_tools=get_chat_tools(),
        # ... остальные поля ...
    )
```

`domain_registry.discover_domains()` в `app/main.py` lifespan
автоматически вызовет `register_tools()` со всем списком при старте.

---

## 🅐 Шаг 5 (только для action-тулов): добавить action в whitelist

Если возвращаемый `ClientActionBlock.action` — **новый** (не существует в
`ACTION_OPEN_URL`/`ACTION_NOTIFY`/`ACTION_TRIGGER_SDK`):

### 5.1. Python whitelist

```python
# app/core/chat/names.py
ACTION_MY_NEW_ACTION: Final[str] = "my_new_action"

# app/core/chat/blocks.py
from app.core.chat.names import ACTION_MY_NEW_ACTION
ALLOWED_CLIENT_ACTIONS: frozenset[str] = frozenset({
    ACTION_OPEN_URL,
    ACTION_NOTIFY,
    ACTION_TRIGGER_SDK,
    ACTION_MY_NEW_ACTION,  # <-- добавь сюда
})
```

`ALLOWED_CLIENT_ACTIONS` — валидатор `ClientActionBlock`. Без записи в
whitelist Pydantic отвергнет блок при парсинге, action не дойдёт до фронта.

### 5.2. Frontend whitelist (`static/js/shared/chat/chat-client-actions.js`)

Фронт держит свой реестр обработчиков action'ов. **Импорт из Python
невозможен** (vanilla JS, без бандлера) — синхронизируй вручную:

```javascript
// static/js/shared/chat/chat-client-actions.js
ClientActionsRegistry.register('my_new_action', (params) => {
    // обработчик: открыть модалку, показать тост, redirect, etc.
});
```

**Грабли:**

- НЕ зови `ClientActionsRegistry.execute(...)` напрямую — потеряешь
  идемпотентность по `block_id`. Используй `executeBlock({action, params, block_id})`.
- Для action с навигацией (`open_url` и аналоги) пропускай URL через
  `AppConfig.api.getUrl(url)`. Конвенция сохраняется как страховка на случай
  proxied-деплоя (исторически — под JupyterHub-proxy без нее ловили 404 на
  `/hub/...` минуя `/user/{user}/proxy/{port}/`); на актуальном SDP-деплое
  proxy-путей нет.

---

## Шаг 6. Тесты

### 6.1. Unit на handler

```python
# tests/domains/acts/test_get_user_acts_handler.py
import json
from unittest.mock import AsyncMock, patch
import pytest

@pytest.mark.asyncio
async def test_get_user_acts_returns_json(monkeypatch):
    fake_acts = [{"id": 1, "km_number": "КМ-09-12345"}]
    fake_repo = AsyncMock()
    fake_repo.list_recent_by_user = AsyncMock(return_value=fake_acts)

    with patch(
        "app.domains.acts.integrations.action_handlers.ActsRepository",
        return_value=fake_repo,
    ):
        from app.domains.acts.integrations.action_handlers import get_user_acts_handler
        result = await get_user_acts_handler(username="22494524", limit=5)

    data = json.loads(result)
    assert data["acts"] == fake_acts
    fake_repo.list_recent_by_user.assert_awaited_once_with("22494524", limit=5)
```

### 6.2. Integration через оркестратор

Минимальный шаблон — смотри `tests/domains/chat/test_orchestrator_action.py`.
Суть: подними минимальный `FastAPI()` с нужными роутерами и `dependency_overrides`
(`get_username`, `get_user_roles`, фабрики сервисов на `AsyncMock`); замокай
`_completions_create` оркестратора так, чтобы LLM вернул `tool_call` к твоему
tool'у, затем проверь, что handler был вызван и результат попал в финальный ответ.

### 6.3. Сброс реестра и моки репозитория в тестах

Доменная система использует глобальное состояние. В каждом тест-файле, где
тестируются инструменты:

```python
import pytest
from app.core.chat.tools import reset, register_tools

@pytest.fixture(autouse=True)
def _reset_tools():
    reset()
    yield
    reset()
```

Регистрируй tool через `register_tools([tool])`, не через `register(tool)`.

Если добавил новый метод в репозиторий, который вызывает handler, — обнови
мок-объект в `tests/domains/chat/test_chat_services.py` (и соседних файлах),
добавив явный `mock.<new_method>.return_value`. Иначе `AsyncMock` вернёт
truthy и сломает существующие тесты.

### 6.4. Проверка совместимости имён

Если изменил константу в `names.py` — пробеги по фронт-реестру и
тестам:

```bash
grep -r "TOOL_GET_USER_ACTS\|acts.get_user_acts" \
    app/ static/ tests/
```

Должны быть все имена в синхроне.

---

## Сводная таблица «куда смотреть»

| Что | Файл | Когда меняется |
|---|---|---|
| Имя tool'а | `app/core/chat/names.py` | Всегда |
| Handler | `app/domains/<domain>/integrations/action_handlers.py` (или соседний модуль) | Всегда |
| Регистрация tool'а | `app/domains/<domain>/integrations/chat_tools.py` | Всегда |
| Подключение в `DomainDescriptor` | `app/domains/<domain>/__init__.py` | Только при создании нового файла chat_tools.py |
| Whitelist action'ов | `app/core/chat/blocks.py` (`ALLOWED_CLIENT_ACTIONS`) | 🅐 Только для нового action-имени |
| Frontend handler action'а | `static/js/shared/chat/chat-client-actions.js` | 🅐 Только для нового action-имени |
| Button translator (опционально) | `app/domains/<domain>/integrations/action_handlers.py` | Если tool возвращается как кнопка от внешнего агента |

---

## Грабли

- **`name` не уникально между доменами** — `register_tools()` упадёт с
  `RuntimeError`. Используй формат `<domain>.<verb>_<object>`.
- **Handler возвращает не str** — оркестратор не парсит. Сделай
  `json.dumps(result, ensure_ascii=False)`.
- **Без `ensure_ascii=False`** — русский текст превратится в `\uXXXX`,
  LLM может не понять.
- **Forgot button_translator для tool'а, который агент возвращает как
  кнопку** — фронт получит кнопку с `action_id=acts.get_user_acts`, а
  ClientActionsRegistry такого имени не знает → кнопка не работает.
- **Action `open_url` с относительным URL без `getUrl`** — фронт под
  JupyterHub-proxy уходит на `/hub/...`, 404. См. [`developer-guide.md §9.2`](developer-guide.md#92-за-jupyterhub-proxy).
- **Не помечать terminal-tool** — оркестратор сам определит по типу
  возвращаемого значения (`client_action` / `blocks_list` / `buttons`).
  Никакого `terminal=True` флага в `ChatTool` нет.
