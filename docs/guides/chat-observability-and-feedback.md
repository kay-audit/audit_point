# Аналитика ответов ассистента: оценки и наблюдаемость

Как понять, насколько хорошо ИИ-ассистент отвечает пользователям: где лежат оценки 👍/👎, как отличить ответ из базы знаний (БЗ) от обычной болталки, и какие SQL запускать для разбора. Дополняет [`ai-assistant.md`](ai-assistant.md) — §7 (AI-ассистент) и §11 (Chat deep-dive).

## 1. Что собираем — в двух словах

Каждый ответ ассистента и реакция на него попадают в несколько журналов в БД:

- **Сообщения** — что спросили и что ответили (блоками).
- **Оценки** — 👍/👎 с причиной и комментарием.
- **Аудит-лог** — факты событий (сообщение отправлено, оценка поставлена).
- **Метрики инструментов** — время и ошибки вызовов ChatTool.
- **Шина агента** — переписка с внешним БЗ-агентом (этой таблицей владеет сторона агента).

## 2. Боевые таблицы

Схема в Greenplum — значение `DATABASE__GP__SCHEMA` (в шаблоне `.env.prod` это
**`s_grnplm_ld_audit_da_project_34`**; `CHAT__SCHEMA_NAME` пуст → таблицы чата живут в основной схеме адаптера).
Все таблицы приложения — со стандартным префиксом `t_db_oarb_audit_act_` (`DATABASE__TABLE_PREFIX`), **кроме шины агента**: её имя задаётся целиком настройкой `CHAT__AGENT_CHANNEL__TABLE_NAME`, без префикса (в `.env.prod` — `agent_conversation_messages`, дефолт в коде и `.env.dev` — `chat_agent_messages_bus`).

| Назначение | Боевое имя (схема + таблица) |
|---|---|
| Сообщения диалога | `s_grnplm_ld_audit_da_project_34.t_db_oarb_audit_act_chat_messages` |
| Оценки 👍/👎 | `s_grnplm_ld_audit_da_project_34.t_db_oarb_audit_act_chat_message_feedback` |
| Аудит-лог | `s_grnplm_ld_audit_da_project_34.t_db_oarb_audit_act_chat_audit_log` |
| Метрики инструментов | `s_grnplm_ld_audit_da_project_34.t_db_oarb_audit_act_chat_tool_metrics` |
| Шина внешнего агента | `s_grnplm_ld_audit_da_project_34.agent_conversation_messages` |

> ⚠️ Перед копированием SQL из раздела 6 **сверьте схему и имя шины со своим `.env`** (`DATABASE__GP__SCHEMA`, `DATABASE__TABLE_PREFIX`, `CHAT__AGENT_CHANNEL__TABLE_NAME`, `CHAT__AGENT_CHANNEL__SCHEMA_NAME`): шина может быть вынесена в отдельную integration-схему, а на локальном PostgreSQL имена короче (без схемы).

## 3. Ключевые поля и связи

**`…chat_messages`** — сырьё диалога:
`id`, `conversation_id`, `role` (`user`/`assistant`), `content` (блоки JSONB), `model`, `token_usage`, `status` (`streaming`/`complete`/`failed`), `agent_ref` (uid вопроса в шине, NULL если ответ локальный), `created_at`.

**`…chat_message_feedback`** — оценки:
PK `(message_id, user_id)`, `conversation_id`, `rating` (`up`/`down`), `reasons` (JSONB), `comment`, `source` (`user`/`auto`/`llm`, по умолчанию `user`), `route_type`, `agent_mode`, `model`, `created_at`, `updated_at`.

**`…chat_tool_metrics`** — вызовы ChatTool:
`id`, `tool_name` (каноническое имя, с точкой), `status` (`success`/`error`/`validation_error`), `latency_ms`, `username`, `conversation_id`, `error_message`, `created_at`.

**`agent_conversation_messages`** (шина) — обмен с внешним агентом:
`id` (uid сообщения), `chat_id` (тред), `user_id`, `role`, `content`, `media`/`buttons`/`metadata` (JSONB), `reply_to` (на ответе → id вопроса), `status` (`pending`/`processing`/`completed`/`failed`/`error`), `created_at`, `updated_at`.

**Как связать:**
- Ответ → его оценки: `chat_message_feedback.message_id = chat_messages.id`.
- Ответ-форвард → переписка с агентом: `chat_messages.agent_ref = agent_conversation_messages.id`; ответ агента — строка с `reply_to`, равным этому id.
- Срез по беседе — `conversation_id`, по пользователю — `username`/`user_id`.

## 4. Как работает 👍/👎

- Под каждым завершённым ответом — ряд действий: «Копировать» · 👍 · 👎 (`static/js/shared/chat/chat-feedback.js`).
- **Лайк** ставится в один клик. **Дизлайк** сразу фиксируется и раскрывает необязательную форму: причины + свободный комментарий.
- Одна активная оценка на пару `(message_id, user_id)`. Повторный клик по той же кнопке — снятие, клик по противоположной — смена.
- При загрузке истории кнопки восстанавливают состояние (поле `feedback` в `GET …/messages`).
- В момент оценки бэкенд сохраняет «снимок маршрута»: `route_type`, `agent_mode` (позиция тумблера «База знаний ОАРБ») и `model` — для сегментации.
- Факт оценки пишется в аудит-лог (`feedback_submitted`/`feedback_cleared`), **без текста комментария** (PII).

**API (для пользователя):**
- `PUT /api/v1/chat/conversations/{cid}/messages/{mid}/feedback` — тело `{rating, reasons?, comment?, agent_mode?}`.
- `DELETE …/feedback` — снять оценку.

**Коды причин дизлайка** (`FEEDBACK_REASON_CODES` в `chat_feedback_service.py`):
`inaccurate` (ошибка), `not_relevant` (не по теме), `incomplete` (неполно), `not_from_kb` (выдумано/не из БЗ), `formatting` (оформление), `unsafe` (некорректно/небезопасно), `other`.

## 5. Откуда пришёл ответ: `route_type`

Главный вопрос анализа: ответ ушёл во внешнего БЗ-агента или ассистент ответил сам? Маршрут восстанавливается из сохранённого сообщения (`route_classifier.py`):

| route_type | Признак | Смысл |
|---|---|---|
| `kb_agent` | `agent_ref IS NOT NULL` | форвард во внешнего БЗ-агента через шину |
| `non_kb_llm` | в `content` есть блок `client_action`/`buttons` | локальная LLM вызвала action-tool (навигация/команда) |
| `smalltalk` | только текст | локальный ответ: болталка **или** вопрос не про БЗ без tool-вызова |
| `unknown` | не assistant-сообщение | — |

`outcome` = `error`, если `status='failed'` или в `content` есть блок `error`; иначе `ok`.

> **Ограничение:** «болталка» и «вопрос не про БЗ без tool-вызова» по сохранённым данным неотличимы (оба — текст). `agent_mode` хранится только на строке оценки, не на каждом сообщении.

## 6. Готовые SQL

Запросы под боевую схему. Подставьте свой `<bus>`, если имя шины отличается.

**Доля положительных оценок (like rate):**
```sql
SELECT COUNT(*) FILTER (WHERE rating='up')   AS up,
       COUNT(*) FILTER (WHERE rating='down') AS down,
       ROUND(COUNT(*) FILTER (WHERE rating='up')::numeric
             / NULLIF(COUNT(*),0), 3)        AS like_rate
FROM s_grnplm_ld_audit_da_project_34.t_db_oarb_audit_act_chat_message_feedback;
```

**Удовлетворённость по маршруту (БЗ-агент vs болталка) — главный срез:**
```sql
SELECT route_type,
       COUNT(*) FILTER (WHERE rating='up')   AS up,
       COUNT(*) FILTER (WHERE rating='down') AS down
FROM s_grnplm_ld_audit_da_project_34.t_db_oarb_audit_act_chat_message_feedback
GROUP BY route_type ORDER BY route_type;
```

**Топ причин дизлайка (приоритизация фиксов):**
```sql
SELECT reason, COUNT(*) AS cnt
FROM s_grnplm_ld_audit_da_project_34.t_db_oarb_audit_act_chat_message_feedback,
     jsonb_array_elements_text(reasons) AS reason
WHERE rating='down'
GROUP BY reason ORDER BY cnt DESC;
```

**Дизлайки с комментариями (качественный сигнал):**
```sql
SELECT created_at, conversation_id, message_id, route_type, reasons, comment
FROM s_grnplm_ld_audit_da_project_34.t_db_oarb_audit_act_chat_message_feedback
WHERE rating='down' AND comment IS NOT NULL
ORDER BY created_at DESC LIMIT 100;
```

**Что спрашивали и что ответили (по конкретной беседе):**
```sql
SELECT role, status, created_at, content
FROM s_grnplm_ld_audit_da_project_34.t_db_oarb_audit_act_chat_messages
WHERE conversation_id = $1
ORDER BY created_at;
```

**Ошибки ответов (почему «не получилось»):**
```sql
-- доля failed-ответов
SELECT COUNT(*) FILTER (WHERE status='failed')::numeric / NULLIF(COUNT(*),0) AS fail_rate
FROM s_grnplm_ld_audit_da_project_34.t_db_oarb_audit_act_chat_messages
WHERE role='assistant';

-- ошибки внешнего БЗ-агента
SELECT COUNT(*) AS failed_count
FROM s_grnplm_ld_audit_da_project_34.agent_conversation_messages
WHERE status='failed';

-- ошибки инструментов
SELECT tool_name, status, COUNT(*), AVG(latency_ms)
FROM s_grnplm_ld_audit_da_project_34.t_db_oarb_audit_act_chat_tool_metrics
WHERE status IN ('error','validation_error')
GROUP BY tool_name, status ORDER BY 3 DESC;
```

**Время ожидания ответа БЗ-агента:**
```sql
SELECT PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (updated_at-created_at))) AS p50_sec,
       PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (updated_at-created_at))) AS p95_sec
FROM s_grnplm_ld_audit_da_project_34.agent_conversation_messages
WHERE status='completed';
```

> `jsonb_array_elements_text` и `PERCENTILE_CONT` есть в PG 9.4+/GP 6. Если на стенде их нет — те же агрегаты считает admin-API (раздел 7).

## 7. Admin API (только чтение, под `require_admin()`)

- `GET /api/v1/chat/admin/feedback/stats` `?route_type&agent_mode&from&to`
  → `{total, up, down, like_rate, by_route, by_model, by_reason}`.
- `GET /api/v1/chat/admin/feedback` `?rating&route_type&agent_mode&from&to&limit&offset`
  → список оценок с превью ответа, причинами и комментарием. Полезно фильтровать `rating=down`.
- `GET /api/v1/chat/admin/conversations/{cid}/inspect`
  → весь диалог: каждое сообщение с `content`, для ответов — `route_type`/`outcome`/`token_usage`/`model` и оценки всех пользователей. Длинные блоки усекаются (`content_truncated`).

## 8. Как читать метрики

- **Не оптимизируйте по одному like rate** — он про вовлечённость, не про качество (довольные молчат, дизлайкают недовольные). Главный actionable-сигнал — **дизлайки и их причины**.
- **Сегментируйте по `route_type`.** Общий агрегат смешивает быструю болталку и медленные БЗ-ответы и вводит в заблуждение.
- **Покрытие фидбэка мало** (обычно <5–10%) — метрики шумны; дополняйте ручным разбором диалогов (инспектор) и анализом ошибок/таймаутов.
- **Latency** — перцентили (p50/p95), не среднее; для БЗ-ветки отдельно меряйте ожидание агента из шины.
- **Задержка записи:** метрики и аудит пишутся фоновыми батчерами — между событием и строкой в таблице несколько секунд.

## 9. Для разработчиков

- **Таблица оценок:** PK `(message_id, user_id)`, GP `DISTRIBUTED BY (message_id)`; без FK на `chat_messages` (оценка переживает удаление беседы). UPSERT — read-modify-write (на GP нет upsert). CHECK на `rating`/`source` — в `CHECK_CONSTRAINT_MESSAGES`.
- **Surfacing:** `MessageResponse.feedback` наполняется только в `GET …/messages`; poll-эндпоинт одиночного сообщения — нет.
- **Фронт:** запросы через `AppConfig.api.getUrl` (базовый префикс приложения вычисляется из адреса страницы — обязательная конвенция для всех `fetch`); фидбэк — UI-элемент, **не** блок сообщения. Словарь причин синхронизируется вручную: `FEEDBACK_REASON_CODES` (Python) ↔ `REASONS` (`chat-feedback.js`).
- **Новый tool-invoking блок** — добавьте его в `_TOOL_BLOCK_TYPES` (`route_classifier.py`), иначе ответы с ним молча уйдут в `smalltalk`.

**Что можно улучшить:** персист `route_type`/`agent_mode`/`finish_reason` на каждое сообщение (точная сегментация по всем ответам); авто-эвалы (LLM-as-judge, groundedness БЗ-ответов — поле `source` уже предусматривает `auto`/`llm`); графический дашборд поверх API; implicit-сигналы (copy-rate, regenerate-rate).
