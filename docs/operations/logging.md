# Логирование Audit Workstation

## 1. Введение

Этот документ — руководство по логам приложения Audit Workstation. Аудитория:

- **Разработчик** — понимает, как локально включить нужный формат, где смотреть
  логи, как добавить структурированное поле в свою запись.
- **On-call / администратор** — расследует инцидент в проде: ищет ошибки за час,
  трассирует конкретный запрос end-to-end, кросс-референсит логи с
  `admin_http_metrics`.

Основная единица логирования — корневой логгер `audit_workstation` и его
дочерние (`audit_workstation.middleware`, `audit_workstation.domains.<...>` и
т.д.). Все они настроены централизованно в `app/core/logging.py` и пишут в
один и тот же набор handler'ов (stdout + ротируемый файл).

Сквозная трассировка обеспечена `request_id`-полем, которое ставит middleware
и которое автоматически инжектируется во все записи логов внутри одного
HTTP-запроса.

## 2. Конфигурация

Переменные окружения (все читаются из `.env`):

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `SERVER__LOG_LEVEL` | `INFO` | Уровень корневого логгера приложения и uvicorn (`DEBUG` / `INFO` / `WARNING` / `ERROR` / `CRITICAL`). |
| `LOG_FORMAT` | `text` | Формат вывода: `text` (человекочитаемый, dev) или `json` (структурированный, prod / агрегаторы). |

Где это резолвится:

- `SERVER__LOG_LEVEL` — `app/core/config.py:29` (`ServerSettings.log_level`,
  `Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]`, валидируется через
  `field_validator` на `.upper()` — регистр не важен).
- `LOG_FORMAT` — `app/core/logging.py:73-75` (`_resolve_format`, читает
  `os.getenv("LOG_FORMAT", "text")`, нормализует `.strip().lower()`).
- Инициализация логгера происходит на module-level в `app/main.py:50-51`:
  `settings = get_settings(); logger = setup_logging(settings.server.log_level)`.
- Уровень uvicorn синхронизирован с `SERVER__LOG_LEVEL` при standalone-запуске
  (`python -m app.main`) — `app/main.py:501`
  (`log_level=settings.server.log_level.lower()`).

Защита от повторной настройки в дочерних воркерах uvicorn — `setup_logging`
возвращает уже сконфигурированный логгер, если у него есть handler'ы
(`app/core/logging.py:92-93`).

Значения в шаблонах окружения (`.env.prod:34-35` — ПРОМ, `.env.dev:34-35` — DEV):

```
# .env.prod
SERVER__LOG_LEVEL=INFO
LOG_FORMAT=json                      # прод / агрегаторы

# .env.dev
SERVER__LOG_LEVEL=INFO
LOG_FORMAT=text                      # разработка
```

## 3. Формат JSON-лога

JSON-формат включается через `LOG_FORMAT=json`. Используется
`python-json-logger` (`pythonjsonlogger.json.JsonFormatter`; в старой 2.x —
`pythonjsonlogger.jsonlogger`, поддерживаются обе ветки —
`app/core/logging.py:58-61`).

Базовый набор полей форматтера (`app/core/logging.py:64-71`):

```
"%(asctime)s %(levelname)s %(name)s %(message)s %(request_id)s"
rename_fields={"asctime": "timestamp", "levelname": "level"}
datefmt="%Y-%m-%dT%H:%M:%S"
```

Поля JSON-строки:

| Поле | Источник | Описание |
|---|---|---|
| `timestamp` | `asctime` → `rename_fields` | Метка времени, формат `YYYY-MM-DDTHH:MM:SS`. |
| `level` | `levelname` → `rename_fields` | `DEBUG` / `INFO` / `WARNING` / `ERROR` / `CRITICAL`. |
| `name` | `logger.name` | Иерархическое имя: `audit_workstation.<...>`. |
| `message` | `logger.<...>("...")` | Текст сообщения (после `%`-форматирования). |
| `request_id` | `request_id_var.get()` | Подставляется фильтром `RequestIdFilter` (`app/core/logging.py:32-37`). Вне HTTP-контекста — `"-"`. |

Любые дополнительные поля, переданные через `extra={...}`, попадают в JSON
автоматически как ключи верхнего уровня (свойство `python-json-logger`,
протестировано в `tests/test_logging.py:76-96`).

Пример реальной строки (из `app/domains/chat/services/agent_loop.py`, лог LLM timeout):

```json
{
  "timestamp": "2026-05-19T14:23:11",
  "level": "WARNING",
  "name": "audit_workstation.domains.chat.agent_loop",
  "message": "LLM timeout",
  "request_id": "a3f9c1d2",
  "stage": "run",
  "model": "qwen2.5-coder-32b-instruct",
  "conversation_id": "b4e7..."
}
```

Поля `stage`, `model`, `conversation_id` пришли из `extra={...}` в коде
agent loop'а.

Ещё один пример с `error_id` (`app/domains/chat/services/tool_executor.py`):

```json
{
  "timestamp": "2026-05-19T14:24:02",
  "level": "ERROR",
  "name": "audit_workstation.domains.chat.tool_executor",
  "message": "Ошибка выполнения tool=acts.open_act_page error_id=7a2b9c4d",
  "request_id": "a3f9c1d2",
  "exc_info": "Traceback (most recent call last): ..."
}
```

`error_id` НЕ передан через `extra={}` — он зашит в `message` форматной
строкой. Это сделано осознанно: тот же id отдаётся в результат tool'а, чтобы
LLM мог передать его пользователю для трассировки администратором.

Поля `user`, `username` НЕ являются стандартными полями форматтера. Они
появятся в JSON только если конкретное место кода пробросит их через
`extra={"username": ...}` (так делает `chat_audit_service.py:77`).

Имена логгеров не всегда повторяют путь модуля: в `app/domains/chat/services/`
часть модулей регистрируется без сегмента `services`
(`...chat.agent_loop`, `...chat.tool_executor`, `...chat.llm_call`,
`...chat.orchestrator`), а `agent_channel.py` — под
`audit_workstation.domains.chat.service.agent_channel` (`service`, без «s»).
Грепать логи по имени модуля вслепую нельзя — сверяйся с `logging.getLogger(...)`
в самом файле.

## 4. Формат текстового лога

Текстовый формат (`LOG_FORMAT=text` или не задан) — `app/core/logging.py:39-45`:

```
"%(levelname)s:     [%(asctime)s] [%(request_id)s] %(name)s - %(message)s"
datefmt="%Y-%m-%d %H:%M:%S"
```

Пример строки:

```
WARNING:     [2026-05-19 14:23:11] [a3f9c1d2] audit_workstation.domains.chat.agent_loop - LLM timeout
```

Структура:

- `WARNING:` — уровень, пять пробелов после двоеточия для выравнивания с
  форматом uvicorn.
- `[2026-05-19 14:23:11]` — локальное время.
- `[a3f9c1d2]` — `request_id`. Вне HTTP-контекста (startup, shutdown,
  фоновые задачи) — `[-]`.
- `audit_workstation.<...>` — имя логгера.
- `LLM timeout` — текст сообщения.

В текстовом формате `extra={...}` НЕ выводится в строку лога (форматная
строка их не упоминает). Для dev это приемлемо, но в проде поля доступны
только при `LOG_FORMAT=json`.

## 5. Сквозная трассировка через `request_id`

`request_id` — короткий идентификатор, который сопровождает все логи и
метрики одного HTTP-запроса. Это единственный надёжный способ связать
строку из `logs/app.log` с записью в `admin_http_metrics`.

**Где живёт значение.** `request_id_var` — `contextvars.ContextVar[str]`
с дефолтом `"-"` (`app/core/logging.py`). `asyncio.Task` копирует контекст
при создании, поэтому значение автоматически наследуется всеми await'ами
внутри обработки одного запроса. Реэкспортируется из `app/core/config.py`
для обратной совместимости.

**Как генерируется.** `RequestIdMiddleware` (`app/core/middleware.py`) —
самый внешний middleware в цепочке. На входе он читает заголовок
`X-Request-ID` (для сквозной трассировки через внешние прокси), либо при
его отсутствии генерирует `uuid.uuid4().hex[:8]` (8-символьный hex).
Значение пишется в ContextVar `request_id_var.set(...)` и возвращается
клиенту в response-заголовке `X-Request-ID` — клиент видит id своего
запроса и может сообщить его в багрепорте.

**Как попадает в лог.** Любой `logger.<level>(...)` внутри запроса
автоматически получает `record.request_id = request_id_var.get()` через
`RequestIdFilter` (`app/core/logging.py`). Фильтр повешен на **handler**,
а не на logger: при propagation от дочерних логгеров Python вызывает
`callHandlers()` на родительском, минуя фильтры на logger; фильтр на
handler гарантированно отрабатывает перед `emit()`. Вне HTTP-контекста
(startup, shutdown, фоновые задачи без восстановления) — `"-"`.

**Как попадает в БД.** `HttpMetricsMiddleware`
(`app/core/middlewares/http_metrics.py`) на завершении запроса читает
`request_id_var.get()`, нормализует `"-"` → `None` и передаёт в
`HttpMetricsService.record(..., request_id=...)`. Дальше
`HttpMetricsRepository.record` делает `INSERT INTO {prefix}admin_http_metrics
(... request_id) VALUES (...)`. Поэтому SQL-запрос по `admin_http_metrics`
даёт список `request_id` под фильтром по пути / статусу / латентности.

**Форвард к внешнему агенту.** Запрос к базе знаний ОАРБ исполняется не
синхронно в рамках HTTP-запроса, а через шину `chat_agent_messages_bus`: POST создаёт
черновик ассистент-сообщения (`chat_messages.status='streaming'`) и кладёт
вопрос в шину, а фоновая задача `chat.agent_channel_poller`
(`app/domains/chat/services/agent_channel_poller.py`, `AgentChannelPoller`)
поллит шину уже вне HTTP-контекста. Логи поллера пишутся под `request_id = "-"`
(фоновая задача не восстанавливает id исходного запроса). Связать вопрос
форварда с ответом можно по `chat_messages.agent_ref` (ссылка на uid вопроса
в шине), а не по `request_id`.

## 6. Поиск по `request_id`

### JSON-логи (prod) — через `jq`

Все записи одного запроса:

```bash
cat logs/app.log | jq -c 'select(.request_id == "a3f9c1d2")'
```

Только ошибки этого запроса:

```bash
cat logs/app.log | jq -c 'select(.request_id == "a3f9c1d2" and .level == "ERROR")'
```

Все `request_id`, по которым были ошибки:

```bash
cat logs/app.log | jq -r 'select(.level == "ERROR") | .request_id' | sort -u
```

### Текстовые логи (dev) — через `grep`

`request_id` выводится в квадратных скобках сразу после времени:

```bash
grep '\[a3f9c1d2\]' logs/app.log
```

### Из `admin_http_metrics` → в лог

В БД есть таблица `{prefix}admin_http_metrics` с полями `method`, `path`,
`status_code`, `latency_ms`, `username`, `request_id`. Типичный сценарий —
найти медленные запросы и подтянуть детали из лога:

```sql
SELECT request_id, method, path, status_code, latency_ms, username
FROM t_db_oarb_audit_act_admin_http_metrics
WHERE latency_ms > 5000
ORDER BY ts DESC
LIMIT 50;
```

Затем по списку `request_id` ищем в логах:

```bash
for rid in a3f9c1d2 b4e7c2f1 c5f8d3a2; do
  echo "=== $rid ==="
  jq -c "select(.request_id == \"$rid\")" logs/app.log
done
```

## 7. Типовые задачи

### Найти все ошибки за последний час

JSON:

```bash
jq -c '
  select(.level == "ERROR" or .level == "CRITICAL")
  | select(.timestamp >= (now - 3600 | strftime("%Y-%m-%dT%H:%M:%S")))
' logs/app.log
```

Текст (грубо, по дате/часу):

```bash
grep -E '^(ERROR|CRITICAL):' logs/app.log | grep "$(date '+%Y-%m-%d %H')"
```

### Трассировать конкретный запрос end-to-end

```bash
# 1. Из заголовка ответа или из admin_http_metrics получили request_id = "a3f9c1d2"
jq -c 'select(.request_id == "a3f9c1d2")' logs/app.log
```

Если запрос форвардился на внешнего агента — фоновый поллер
(`chat.agent_channel_poller`) логирует уже вне HTTP-контекста под
`request_id = "-"`; связь с исходным вопросом — через
`chat_messages.agent_ref` → uid в шине `chat_agent_messages_bus` (см. раздел 5).

### Найти медленные запросы

Текущий формат лога **не содержит поля `duration_ms`** для HTTP-запросов —
оно живёт только в `admin_http_metrics.latency_ms` (см. SQL выше). Кросс-
референс через `request_id`:

```sql
SELECT request_id, path, latency_ms
FROM t_db_oarb_audit_act_admin_http_metrics
WHERE latency_ms > 1000 AND ts >= NOW() - INTERVAL '1 hour'
ORDER BY latency_ms DESC;
```

Чисто по логу медленные запросы найти нельзя — это требует доработки
(`HttpMetricsMiddleware` мог бы дополнительно эмитить `logger.info` с
`extra={"latency_ms": ..., "path": ...}` после порога).

### Найти ошибки конкретного пользователя

В большинстве записей логов поля `username` нет — оно не входит в
форматтер. Путь — через `admin_http_metrics`:

```sql
SELECT request_id, method, path, status_code, latency_ms
FROM t_db_oarb_audit_act_admin_http_metrics
WHERE username = '12345' AND status_code >= 400
ORDER BY ts DESC
LIMIT 100;
```

Затем по `request_id` подтянуть лог-строки. **Требует доработки**, если
хочется фильтровать пользователя сразу в `jq` — нужно либо унести username
в `request_id_var`-аналог через ContextVar и инжектить фильтром, либо
систематически добавлять `extra={"username": ...}` в `logger.<...>` вызовы
(сейчас это делают только `chat_audit_service.py:80` и единичные другие
места).

## 8. Уровни логирования

Корневой логгер `audit_workstation` настраивается на уровень из
`SERVER__LOG_LEVEL`. По уровням сейчас в коде используется примерно так:

- **DEBUG** — диагностика инициализации (например, `logger.debug("База
  данных инициализирована")`). На проде шумно, выключено дефолтом.
- **INFO** — жизненный цикл приложения: старт/стоп, число доменов,
  reconcile polling-задач, инициализация rate-limit'а, размер пула.
- **WARNING** — ожидаемые, но потенциально проблемные события: rate-limit
  превышен, запрос отклонён по размеру, Kerberos-токен протух во время
  запроса, `UniqueViolationError` / `CheckViolationError` из БД, LLM
  timeout (в `agent_loop`), таймаут ответа из шины
  `chat_agent_messages_bus`, блок ответа усечён по `MAX_BLOCK_TEXT_SIZE`.
- **ERROR / `logger.exception`** — `logger.exception(...)` пишет traceback
  автоматически. Используется для всех необработанных исключений в
  request-обработчике, откатов lifespan-hooks и доменов, ошибок
  tool-вызовов с `error_id`, падений сохранения сообщений ассистента.
- **CRITICAL** — невосстановимые состояния на старте: Kerberos в lifespan
  startup, `PostgresError` на инициализации пула, не захватили
  singleton-lock, любая необработанная ошибка lifespan.

## 9. PII и безопасность

В логи **намеренно не попадают**:

- **Содержимое сообщений пользователя в чате.** На INFO
  (`app/domains/chat/api/messages.py:71`) пишутся только метаданные —
  `conversation`, `message_len`, `files`, `agent_mode`. Сам текст уходит в лог
  только на **DEBUG** (`:75`, `Тело запроса (truncated): message=%r, domains=%r`)
  и обрезается до 500 символов. При штатном `SERVER__LOG_LEVEL=INFO` текста
  сообщений в логах нет вообще.
- **Tool-аргументы.** В `agent_loop.py` `args_str` обрезается до 200 символов
  перед эмитом в лог:
  `args_str[:200] + "..." if len(args_str) > 200 else args_str`.
- **Tool-вывод.** В `tool_executor.py` превью аналогично режется до 200
  символов.
- **Stack traces в ответе LLM.** Полный traceback exception'а tool'а пишется
  в лог под `error_id`, а LLM получает только нейтральное сообщение
  `f"Инструмент завершился с ошибкой. error_id={error_id}. Сообщите
  администратору."` (формируется в `tool_executor.py`). Имена БД,
  SQL-фрагменты и прочие чувствительные данные не утекают в чат.
- **Пароли и секреты.** `DatabaseSettings.password: SecretStr`
  (`app/core/config.py:78`), `GreenplumSettings.password` (`:204`),
  `CHAT__API_KEY` / `CHAT__FALLBACK_API_KEY` (`SecretStr` в
  `app/domains/chat/settings.py`). Pydantic `SecretStr` при `repr()` отдаёт
  `**********` — не попадает ни в логи, ни в трейсы исключений pydantic.
  Отдельно: `AUTH__JWT_SECRET` и SMTP-пароль в логи не пишутся, но лежат
  открытым текстом в `.env` — файл не коммитится.
- **ОТП-коды.** При `NOTIFICATIONS__EMAIL__ENABLED=false` (или незарегистрированном
  домене уведомлений) код пишется в лог открытым текстом — ветка dev-режима
  `logger.info("DEV-режим: ОТП-код для %s = %s", ...)` (`app/auth/router.py:199`).
  На ПРОМе почта обязана быть включена и настроена: там доступ к логам иначе
  равен доступу к чужим ОТП. Если почта включена, но отправка сорвалась, код в
  лог **не** пишется — только ERROR «код пользователю не доставлен»
  (`app/auth/router.py:192-195`). Отдельный риск: при
  `NOTIFICATIONS__EMAIL__ENABLED=true` с пустым `SMTP_PASSWORD` хук
  `notifications.email_init` не инициализирует SMTP-клиент и пишет WARNING
  (`app/domains/notifications/_lifecycle.py:90-94`) — письма не уходят, коды
  недоступны никому.
- **Generic exception handler** возвращает клиенту только
  `{"detail": "Внутренняя ошибка сервера", "code": "internal-server-error"}`,
  а полный traceback пишет в лог через `logger.exception(...)`
  (`app/main.py:447-459`).

Если вы добавляете новое место логирования с пользовательским контентом —
проверьте, что обрезаете его до разумного размера (паттерн `[:200]`) и не
кладёте в `message`, если поле может содержать секрет.

## 10. Где лежат логи

### Файловый handler

`RotatingFileHandler` (`app/core/logging.py:110-118`):

- **Директория:** `<project_root>/logs/` — путь резолвится как
  `Path(__file__).resolve().parent.parent.parent / "logs"`, то есть
  относительно `app/core/logging.py` это `<repo>/logs/`. Создаётся при
  старте (`log_dir.mkdir(exist_ok=True)`, `app/core/logging.py:111`).
- **Файл:** `logs/app.log` — активный лог.
- **Ротация:** `maxBytes=10 * 1024 * 1024` (10 МБ на файл),
  `backupCount=5`. Когда `app.log` достигает 10 МБ, он ротируется в
  `app.log.1`, старый `.1` сдвигается в `.2`, и так до `.5` — `.6`-й
  удаляется. Итого на диске максимум ~60 МБ.
- **Кодировка:** UTF-8.

### Консоль

`StreamHandler(sys.stdout)` — все записи дублируются в stdout. Куда попадёт
stdout, решает то, чем запущен процесс: терминал, `nohup`/`tee`-файл или
журнал системного супервизора. В самом приложении этот путь не
сконфигурирован.

### На ПРОМе (SDP, Greenplum)

Файл — `<repo>/logs/app.log` в каталоге развёрнутого проекта, доступ по SSH к
хосту приложения. Формат — `json` (`.env.prod`), поэтому разбирать удобнее
через `jq` (см. §6). Stdout уходит туда, куда его направил запускающий скрипт.

### Локально (DEV, PostgreSQL)

При запуске через `python -m app.main` или `uvicorn app.main:create_app --factory`
stdout печатает в текущий терминал, файл — `<repo>/logs/app.log`. Формат —
`text` (`.env.dev`), поиск по `grep` (см. §6).

### Логи воркера LLM-моста

Воркер `scripts/datalab/llm_redis_worker.ipynb` живёт **вне** этого приложения —
в Jupyter DataLab, и в `logs/app.log` не пишет. Его вывод виден только в
ячейке ноутбука; со стороны приложения о его состоянии судят по heartbeat
`llm:bridge:worker:alive` в Redis (troubleshooting №7).

Внешние агрегаторы (Loki / ELK / ClickHouse) в коде проекта не
сконфигурированы — это уровень инфраструктуры. Для отправки в агрегатор
включается `LOG_FORMAT=json` и stdout пайпится сторонним коллектором
(filebeat / promtail / fluent-bit).
