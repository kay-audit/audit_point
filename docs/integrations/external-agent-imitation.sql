-- ============================================================================
--  external-agent-imitation.sql
--  Хелпер-сниппеты для ручной имитации внешнего ИИ-агента (nanobot) в AuditWorkstation
--  (используется при разработке/тестировании канала chat_agent_messages_bus)
--
--  Место: docs/integrations/external-agent-imitation.sql (НЕ часть продакшен-кода)
--  Целевая БД: PostgreSQL (dev) и Greenplum (prod) — все запросы GP-совместимы
--  Связанная документация: docs/guides/ai-assistant.md (Chat domain deep-dive §11)
--
--  ВАЖНО — имена таблиц:
--    Bus-таблица канала — БЕЗ app-префикса: её имя задаётся настройкой
--    `CHAT__AGENT_CHANNEL__TABLE_NAME` целиком (дефолт `chat_agent_messages_bus`,
--    `DATABASE__TABLE_PREFIX` к ней НЕ приклеивается — шина общая с внешним
--    агентом). Остальные таблицы приложения (chat_files и др.) используют общий
--    префикс `t_db_oarb_audit_act_` (env `DATABASE__TABLE_PREFIX`, одинаков для
--    PG и GP). В сниппетах ниже:
--      • chat_agent_messages_bus            (шина — без префикса)
--      • t_db_oarb_audit_act_chat_files     (обычная таблица — с префиксом)
--    Если имя шины / префикс в .env другие — замени глобально.
--    На GP к имени дополнительно прибавляется схема: `{SCHEMA}.<table>`.
--
--  ВАЖНО — семантика колонок chat_agent_messages_bus
--  (структуру задаёт сторона агента — владелец таблицы; отдельной колонки
--   conversation_id в шине НЕТ):
--    • id       (uuid) = uid одного СООБЩЕНИЯ шины — уникальный идентификатор
--                        данной строки. Его же хранит chat_messages.agent_ref
--    • chat_id  (text) = uid треда (= chat_conversations.id,
--                        он же chat_messages.conversation_id)
--    • reply_to (uuid) = ссылка на id ВОПРОСА; проставляется агентом
--                        НА СТРОКЕ-ОТВЕТЕ — наличие ответа с
--                        reply_to=<id вопроса> и есть сигнал «ответ готов»
--    • role            = 'user' (вопрос от AW) | 'assistant' (ответ агента)
--                        | 'system' | 'tool' (служебные сообщения цикла агента)
--    • metadata        = JSONB: у вопроса ключи {mode, kb} (mode = agent_mode
--                        запроса: 'adaptive' | 'always'; kb по умолчанию 'oarb');
--                        у ответа ключ
--                        {reasoning} — рассуждения агента (стримятся дельтами,
--                        пока пишется ответ; legacy-ключ {thinking} AW тоже
--                        понимает)
--    • buttons         = JSONB: массив [{action_id, label, params}]
--    • media           = JSONB: [{file_id, filename, mime_type, file_size}];
--                        file_id — либо id строки в chat_files, либо инлайн
--                        data-URL `data:<mime>;base64,<...>` (так отдаёт
--                        nanobot); filename необязателен, см. сценарий 3
--    • status          = pending | processing | completed | error | failed
--                        (словарь NanoBot 2.3; 'timeout' ЗАПРЕЩЁН — записи
--                        статуса от AW best-effort). 'error' — ПОВТОРЯЕМАЯ
--                        ошибка: агент вернёт вопрос в пул и переобработает
--                        его, удалив свою строку-ответ. Терминален только
--                        'failed'
--    У владельца на колонках есть DEFAULT'ы (id, status, таймстемпы, JSONB),
--    но AW на них не полагается и передаёт значения явно.
--
--  ВАЖНО — поток данных (подтверждённая спека агента):
--    1. AW INSERT'ит строку-вопрос (role='user', status='pending').
--    2. Агент claim'ит вопрос: UPDATE SET status='processing'.
--    3. Агент INSERT'ит строку-ответа (role='assistant', новый id,
--       reply_to=<id вопроса>) с пустым content и status='processing',
--       затем дописывает reasoning-дельты в metadata.reasoning (UPDATE … updated_at=now()),
--       потом пишет финальный content и status='completed' (или 'failed').
--    4. Агент UPDATE строки-вопроса: SET status='completed' (или 'failed').
--    5. AW поллит строку-ответ по reply_to=<id вопроса> (role='assistant');
--       финализирует, когда статус ответа терминальный.
--    Пока вопрос pending AW показывает позицию очереди:
--       «В очереди: впереди N запросов» — N = число pending-вопросов всех пользователей (включая свои) с created_at раньше.
--    Признаки жизни, продлевающие claim-таймер (30 мин idle для pending):
--       уменьшение N, переход pending→processing.
--    Признаки жизни, продлевающие answer-таймер (30 мин idle для processing):
--       рост metadata.reasoning на строке-ответа, изменение её updated_at,
--       возврат вопроса в 'pending'/'error' с удалением ответа (reclaim,
--       не более 3 ЭПИЗОДОВ; залипший статус кап не расходует).
--    Сообщения одного chat_id агент НЕ обрабатывает параллельно — ждёт
--    завершения активного, затем берёт следующее из той же беседы.
--    Повторяемая ошибка и reclaim: при сбое агент ставит вопросу
--    status='error' (retry_count/error в metadata) и удаляет строку-ответ —
--    через error_retry_delay задача вернётся в пул. Если у воркера истёк
--    lease (public.agent_worker_claims, см. раздел 12), вопрос точно так же
--    возвращается в 'pending' с удалением ответа. Для AW и то и другое —
--    признак жизни: подписка живёт, idle-таймер сбрасывается (откат фазы
--    processing → pending засчитывается не более 3 ЭПИЗОДОВ — на смене
--    статуса, а не каждый тик залипшего 'error').
--    Idle-таймауты двухфазные, отсчёт от последнего признака жизни:
--    30 мин для pending (CHAT__AGENT_CHANNEL__CLAIM_TIMEOUT_SEC=1800) и
--    30 мин для processing (CHAT__AGENT_CHANNEL__ANSWER_TIMEOUT_SEC=1800 —
--    покрывает 3 ретрая NanoBot с backoff'ом);
--    по истечении AW сам закрывает зависший draft в chat_messages и
--    best-effort ставит вопросу status='failed'.
--
--  СТРУКТУРА ФАЙЛА:
--    0. ПОДГОТОВКА          — просмотр активных вопросов, копирование <QUESTION_ID>
--    1. Успешный ответ       — нормальный поток: вопрос → ответ
--    2. Ответ с кнопками     — поле buttons с action_id/label/params
--    3. Ответ с файлом/медиа — поле media: 3 — заливка файла в chat_files,
--                              3Б — инлайн data-URL в file_id (формат nanobot)
--    4. Ошибка               — status='failed' на вопросе и/или ответе
--    5. Агент думает         — UPDATE вопроса до processing (простой индикатор)
--    6. ДИАГНОСТИКА          — счётчики, старые pending, пара вопрос–ответ
--    7. ОЧИСТКА ПО TTL       — удаление завершённых строк, ручное закрытие зависших
--    8. ОЧЕРЕДЬ              — второй pending-вопрос раньше, фронт показывает
--                              «впереди N запросов»; движение очереди (completed/DELETE)
--    9. ЗАДЕРЖКА ВЗЯТИЯ В РАБОТУ — pending держится N минут, затем → processing
--   10. ПОРЦИОННЫЙ REASONING — строка-ответ с пустым content, 4 UPDATE дописывают
--                              metadata.reasoning, фронт допечатывает дельты; финализация
--   11. ВИТРИНА MARKDOWN   — ответ со всеми основными md-элементами (заголовки,
--                              списки, таблица, код, цитата) для проверки рендера
--   12. АРЕНДА ЗАДАЧ        — DDL public.agent_worker_claims и имитация reclaim'а
--                              по истёкшему lease (вопрос возвращается в pending)
--
--  ВАЖНО — GP-ограничения (Greenplum 6.x = PostgreSQL 9.4):
--    БЕЗ ON CONFLICT DO UPDATE, БЕЗ gen_random_uuid(), БЕЗ jsonb_set,
--    БЕЗ CREATE INDEX IF NOT EXISTS. UUID генерируем через
--    md5(random()::text || clock_timestamp()::text)::uuid
--    (32 hex-символа без дефисов — валидный ввод для типа uuid).
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 0. ПОДГОТОВКА: посмотреть свежие вопросы от AW (ещё не обработаны)
-- ────────────────────────────────────────────────────────────────────────────

-- Активные вопросы, ждущие ответа от агента.
-- ┌────────────────────────────────────────────────────────────────────────┐
-- │ СКОПИРУЙ значение колонки `id` строки с role='user'.                     │
-- │ Именно его нужно подставить в <QUESTION_ID> ниже во всех сценариях 1–5.  │
-- │ Это uid сообщения-вопроса (его же хранит chat_messages.agent_ref).       │
-- └────────────────────────────────────────────────────────────────────────┘
SELECT id,   -- ← ЭТО копируем в <QUESTION_ID>
       chat_id, user_id,
       content, metadata, status, created_at
FROM chat_agent_messages_bus
WHERE role = 'user'
  AND status = 'pending'
ORDER BY created_at DESC
LIMIT 20;

-- СТАДИИ status на строке-вопросе (CHECK владельца):
--   pending     — вопрос вставлен AW, агент ещё не взял.
--   processing  — агент claim'ит вопрос и работает над ответом.
--   completed   — агент вставил ответ (reply_to=<id вопроса> НА ОТВЕТЕ) и закрыл вопрос.
--   error       — ПОВТОРЯЕМАЯ ошибка: агент снёс свою строку-ответ и вернёт
--                 задачу в пул через error_retry_delay (metadata.retry_count /
--                 metadata.error). AW НЕ закрывает draft — продолжает ждать.
--   failed      — терминальная ошибка (retry_count исчерпан); этим же статусом
--                 AW best-effort закрывает вопрос по таймауту (слот лимита
--                 дополнительно страхует отсечка по возрасту в
--                 count_active_for_user).
--
-- Для наблюдения «всё, что в работе» ('error' тоже в работе — агент повторит):
SELECT id, chat_id, content, status, created_at
FROM chat_agent_messages_bus
WHERE role = 'user'
  AND status IN ('pending', 'processing', 'error')
ORDER BY created_at DESC
LIMIT 20;

-- Полная строка одного вопроса (metadata содержит mode и kb):
SELECT id, chat_id, user_id, content, metadata, status, created_at
FROM chat_agent_messages_bus
WHERE id = '<QUESTION_ID>';


-- ────────────────────────────────────────────────────────────────────────────
-- 1. СЦЕНАРИЙ "успешный ответ агента" (нормальный поток)
-- ────────────────────────────────────────────────────────────────────────────
--
-- Единый самодостаточный блок. Замени ТОЛЬКО <QUESTION_ID>
-- (значение id строки-вопроса из запроса 0). Всё остальное —
-- id строки-ответа, chat_id, user_id — вычисляется автоматически
-- и связывается внутри блока.
--
-- PL/pgSQL DO-блок работает и в PostgreSQL, и в Greenplum 6.x.

DO $$
DECLARE
    q_id    uuid := '<QUESTION_ID>';                                       -- ← подставь сюда
    a_id    uuid := md5(random()::text || clock_timestamp()::text)::uuid;  -- id ответа (авто)
    v_chat  text;
    v_user  text;
BEGIN
    -- Берём chat_id/user_id из строки-вопроса по её id:
    SELECT chat_id, user_id INTO v_chat, v_user
    FROM chat_agent_messages_bus
    WHERE id = q_id;

    -- Строка-ответ ассистента (reply_to = id ВОПРОСА — на ответе):
    INSERT INTO chat_agent_messages_bus
        (id, chat_id, user_id, role,
         content, metadata, reply_to, status, created_at, updated_at)
    VALUES (a_id, v_chat, v_user, 'assistant',
            'КСО — корпоративная социальная ответственность. По регламенту 2024 года...',
            '{"reasoning": "Понимаю вопрос про КСО. Нашёл 3 релевантных документа, формирую ответ."}'::jsonb,
            q_id, 'completed', now(), now());

    -- Закрываем строку-вопрос:
    UPDATE chat_agent_messages_bus
    SET status     = 'completed',
        updated_at = now()
    WHERE id = q_id;
END$$;

-- После блока: AW найдёт строку-ответ по reply_to = id вопроса
-- и отрендерит content + metadata.reasoning.


-- ────────────────────────────────────────────────────────────────────────────
-- 2. СЦЕНАРИЙ "ответ с кнопками"
-- ────────────────────────────────────────────────────────────────────────────
--
-- buttons — массив [{action_id, label, params}]. Сейчас поддерживается
-- action_id 'acts.open_act_page' (params: km_number и/или sz_number).
-- Кнопки рендерятся под текстом ответа как интерактивные элементы.
-- Трансляция: button_translator ресолвит КМ/СЗ в URL /constructor?act_id=<id>
-- и переписывает кнопку в клиентский action open_url. Если акта с таким
-- номером в БД НЕТ, клик выдаст уведомление «Акт <номер> не найден» —
-- для проверки навигации подставь km_number реально существующего акта.
--
-- Замени ТОЛЬКО <QUESTION_ID> (id строки-вопроса из запроса 0).

DO $$
DECLARE
    q_id    uuid := '<QUESTION_ID>';                                       -- ← подставь сюда
    a_id    uuid := md5(random()::text || clock_timestamp()::text)::uuid;  -- id ответа (авто)
    v_chat  text;
    v_user  text;
BEGIN
    SELECT chat_id, user_id INTO v_chat, v_user
    FROM chat_agent_messages_bus
    WHERE id = q_id;

    INSERT INTO chat_agent_messages_bus
        (id, chat_id, user_id, role,
         content, metadata, buttons, reply_to, status, created_at, updated_at)
    VALUES (a_id, v_chat, v_user, 'assistant',
            'Найдены 2 связанных акта:',
            '{"reasoning": "Нашёл акты, формирую кнопки для навигации."}'::jsonb,
            '[{"action_id":"acts.open_act_page","label":"Открыть 11-11111","params":{"km_number":"11-11111"}},{"action_id":"acts.open_act_page","label":"Открыть 22-22222","params":{"km_number":"22-22222"}}]'::jsonb,
            q_id, 'completed', now(), now());

    UPDATE chat_agent_messages_bus
    SET status     = 'completed',
        updated_at = now()
    WHERE id = q_id;
END$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 3. СЦЕНАРИЙ "ответ с файлом/медиа"
-- ────────────────────────────────────────────────────────────────────────────
--
-- media — массив [{file_id, filename, mime_type, file_size}]. AW определяет
-- превью по mime_type: image/* — встроенное изображение; остальные — иконка
-- + кнопка «Скачать».
--
-- file_id поддерживает ДВА формата:
--   А. id строки в chat_files — с корректным conversation_id = chat_id треда,
--      иначе GET /api/v1/chat/files/{file_id} вернёт 404. Вариант для файлов,
--      которые агент действительно кладёт в хранилище (блок ниже).
--   Б. инлайн data-URL `data:<mime>;base64,<payload>` — так отдаёт файлы
--      nanobot. В chat_files ничего не пишется, AW подставляет data-URL в
--      href/src напрямую и в files-эндпоинт не ходит (вариант 3Б в конце
--      раздела).
--
-- filename НЕобязателен. Если его нет, AW восстанавливает имя по цепочке:
-- имя файла, упомянутое в тексте ответа (сопоставление с media по порядку
-- следования) → mime_type → mime из самого data-URL → «Файл» без расширения.
--
-- ВНИМАНИЕ, два ограничения распознавания имени из текста:
--   • только ЛАТИНИЦА и цифры — регулярка построена на \w без флага `u`,
--     кириллическое «отчёт.txt» в тексте НЕ распознаётся;
--   • работает только для истории (перезагрузка страницы). В живом ответе
--     блоки печатаются через typeOutBlocks/typeOutSingleBlock, куда подсказка
--     имени не передаётся — там имя берётся сразу из mime_type.
-- Практический вывод для агента: если имя важно (особенно кириллическое) —
-- передавай filename в media явно, не рассчитывай на текст.
--
-- Замени ТОЛЬКО <QUESTION_ID> (id строки-вопроса из запроса 0).
-- Блок сам заливает реально скачиваемый TXT-файл в chat_files и связывает его
-- с ответом через media.

DO $$
DECLARE
    q_id     uuid := '<QUESTION_ID>';                                       -- ← подставь сюда
    a_id     uuid := md5(random()::text || clock_timestamp()::text)::uuid;  -- id ответа (авто)
    f_id     text := md5(random()::text || clock_timestamp()::text);        -- file_id (авто)
    f_name   text := 'отчёт.txt';
    f_mime   text := 'text/plain; charset=utf-8';
    f_body   bytea := convert_to(
                  'Сводный отчёт по КМ-12-32141.' || E'\n' ||
                  'Документ сформирован агентом базы знаний.', 'UTF8');
    v_chat   text;
    v_user   text;
BEGIN
    SELECT chat_id, user_id INTO v_chat, v_user
    FROM chat_agent_messages_bus
    WHERE id = q_id;

    -- Файл в chat_files (conversation_id в chat_files = chat_id треда;
    -- message_id NULL: у ответа агента ещё нет id chat-сообщения):
    INSERT INTO t_db_oarb_audit_act_chat_files
        (id, conversation_id, message_id, filename,
         mime_type, file_size, file_data, created_at)
    VALUES (f_id, v_chat, NULL, f_name, f_mime,
            octet_length(f_body), f_body, now());

    -- Строка-ответ с media, ссылающимся на свежий file_id:
    INSERT INTO chat_agent_messages_bus
        (id, chat_id, user_id, role,
         content, media, reply_to, status, created_at, updated_at)
    VALUES (a_id, v_chat, v_user, 'assistant',
            'Сформировал отчёт, прикладываю файл:',
            jsonb_build_array(
                jsonb_build_object(
                    'file_id',   f_id,
                    'filename',  f_name,
                    'mime_type', f_mime,
                    'file_size', octet_length(f_body)
                )
            ),
            q_id, 'completed', now(), now());

    UPDATE chat_agent_messages_bus
    SET status     = 'completed',
        updated_at = now()
    WHERE id = q_id;
END$$;

-- Другие типы файлов — замени f_mime/f_name и f_body на decode(...):
-- PDF:  f_body := decode('255044462D312E340A25E2E3CFD30A', 'hex'); -- "%PDF-1.4\n%...\n"
-- XLSX: f_body := decode('504B0304140000000000', 'hex');          -- "PK\x03\x04..." (ZIP)
-- (сигнатуры достаточно для иконки и скачивания; для открытия нужен полный файл).


-- ── 3Б. Тот же сценарий, но файл инлайном в data-URL (формат nanobot) ───────
--
-- Ничего не пишется в chat_files: содержимое едет прямо в file_id. Здесь же
-- проверяется восстановление имени — filename в media НЕ передан, имя
-- «report.txt» AW возьмёт из текста ответа. Имя латиницей намеренно: см.
-- ограничения распознавания выше.
-- Замени ТОЛЬКО <QUESTION_ID>.

DO $$
DECLARE
    q_id     uuid := '<QUESTION_ID>';                                       -- ← подставь сюда
    a_id     uuid := md5(random()::text || clock_timestamp()::text)::uuid;
    -- Без пробела после ';' — data-URL не допускает пробелов в заголовке.
    f_mime   text := 'text/plain;charset=utf-8';
    f_body   bytea := convert_to(
                  'Сводный отчёт по КМ-12-32141.' || E'\n' ||
                  'Файл доставлен инлайном, без chat_files.', 'UTF8');
    v_chat   text;
    v_user   text;
BEGIN
    SELECT chat_id, user_id INTO v_chat, v_user
    FROM chat_agent_messages_bus
    WHERE id = q_id;

    INSERT INTO chat_agent_messages_bus
        (id, chat_id, user_id, role,
         content, media, reply_to, status, created_at, updated_at)
    VALUES (a_id, v_chat, v_user, 'assistant',
            'Сформировал отчёт, прикладываю report.txt:',
            jsonb_build_array(
                jsonb_build_object(
                    -- replace(): encode() в PG переносит строку каждые 76
                    -- символов, в data-URL переносы не нужны
                    'file_id',   'data:' || f_mime || ';base64,'
                                 || replace(encode(f_body, 'base64'), E'\n', ''),
                    'mime_type', f_mime,
                    'file_size', octet_length(f_body)
                )
            ),
            q_id, 'completed', now(), now());

    UPDATE chat_agent_messages_bus
    SET status     = 'completed',
        updated_at = now()
    WHERE id = q_id;
END$$;

-- Проверка в UI: иконка текстового документа, «Скачать» отдаёт файл без
-- обращения к /api/v1/chat/files/. Имя карточки: в живом ответе «file.txt»
-- (из mime_type), после перезагрузки страницы — «report.txt» (из текста).


-- ────────────────────────────────────────────────────────────────────────────
-- 4. СЦЕНАРИЙ "ошибка" (агент не смог получить ответ)
-- ────────────────────────────────────────────────────────────────────────────
--
-- Можно вставить строку-ответ со status='failed' и текстом ошибки, либо просто
-- закрыть вопрос со status='failed' без ответа — AW в обоих случаях покажет
-- error-блок (во втором — стандартный текст «Внешний агент вернул ошибку»).
-- ВНИМАНИЕ: терминален только 'failed'. Для ПОВТОРЯЕМОЙ ошибки — вариант В.
-- Замени ТОЛЬКО <QUESTION_ID> (id строки-вопроса из запроса 0).

-- Вариант А — только закрыть вопрос (AW покажет стандартное сообщение об ошибке):
UPDATE chat_agent_messages_bus
SET status     = 'failed',
    updated_at = now()
WHERE id = '<QUESTION_ID>';

-- Вариант Б — вставить строку-ответ со status='failed' и текстом ошибки:
DO $$
DECLARE
    q_id    uuid := '<QUESTION_ID>';                                       -- ← подставь сюда
    a_id    uuid := md5(random()::text || clock_timestamp()::text)::uuid;  -- id ответа (авто)
    v_chat  text;
    v_user  text;
BEGIN
    SELECT chat_id, user_id INTO v_chat, v_user
    FROM chat_agent_messages_bus
    WHERE id = q_id;

    INSERT INTO chat_agent_messages_bus
        (id, chat_id, user_id, role,
         content, reply_to, status, created_at, updated_at)
    VALUES (a_id, v_chat, v_user, 'assistant',
            'Не удалось получить ответ: база знаний acts_default недоступна. Попробуйте позже.',
            q_id, 'failed', now(), now());

    UPDATE chat_agent_messages_bus
    SET status     = 'failed',
        updated_at = now()
    WHERE id = q_id;
END$$;


-- Вариант В — ПОВТОРЯЕМАЯ ошибка (status='error'): агент сносит свою
-- строку-ответ и вернёт задачу в пул через error_retry_delay. AW черновик НЕ
-- закрывает — подписка живёт, idle-таймер сбрасывается, в логах появляется
-- «вопрос … в состоянии 'error' … ждём повторной обработки агентом».
-- Проверка: после этого блока завершить сценарием 1 — ответ доедет до UI.
DO $$
DECLARE
    q_id  uuid := '<QUESTION_ID>';   -- ← подставь сюда
    v_try int;
BEGIN
    -- Агент удаляет свою строку-ответ (если успел её создать).
    DELETE FROM chat_agent_messages_bus WHERE reply_to = q_id AND role = 'assistant';

    SELECT COALESCE((metadata->>'retry_count')::int, 0) + 1 INTO v_try
    FROM chat_agent_messages_bus WHERE id = q_id;

    -- jsonb_set и оператор `jsonb || jsonb` — PG 9.5+, в GP 6.x их нет:
    -- пересобираем metadata вопроса целиком из текстового литерала.
    UPDATE chat_agent_messages_bus
    SET status     = 'error',
        metadata   = ('{"mode": "'  || COALESCE(metadata->>'mode', 'always')
                   || '", "kb": "'  || COALESCE(metadata->>'kb', 'oarb')
                   || '", "retry_count": ' || v_try
                   || ', "error": "dispatch_error"}')::jsonb,
        updated_at = now()
    WHERE id = q_id;
END$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 5. СЦЕНАРИЙ "агент думает" (промежуточный статус)
-- ────────────────────────────────────────────────────────────────────────────
--
-- Если хочется увидеть индикатор «думает...» в UI — просто поставь processing
-- (агент claim'ит вопрос этим статусом). AW показывает typing-индикатор, пока
-- нет строки-ответа (role='assistant' с reply_to = id вопроса) с терминальным
-- статусом.
-- Замени ТОЛЬКО <QUESTION_ID> (id строки-вопроса из запроса 0).

UPDATE chat_agent_messages_bus
SET status     = 'processing',
    updated_at = now()
WHERE id = '<QUESTION_ID>'
  AND status = 'pending';

-- Затем в любой момент завершить через сценарии 1, 2, 3 или 4.


-- ────────────────────────────────────────────────────────────────────────────
-- 6. ДИАГНОСТИКА
-- ────────────────────────────────────────────────────────────────────────────

-- Счётчики по role + status:
SELECT role, status, COUNT(*)
FROM chat_agent_messages_bus
GROUP BY role, status
ORDER BY role, status;

-- Самые старые незавершённые вопросы (потенциально зависшие):
SELECT id, chat_id, user_id, content, status,
       now() - created_at AS age,
       created_at
FROM chat_agent_messages_bus
WHERE role = 'user'
  AND status IN ('pending', 'processing', 'error')
ORDER BY created_at ASC
LIMIT 20;

-- Полная пара вопрос–ответ по id вопроса (<QUESTION_ID>):
-- (ответ ищется по reply_to НА ОТВЕТЕ — он ссылается на id вопроса)
SELECT am.id, am.role, am.status, am.reply_to,
       am.content,
       am.metadata,
       am.buttons,
       am.media,
       am.created_at
FROM chat_agent_messages_bus am
WHERE am.id = '<QUESTION_ID>'
   OR am.reply_to = '<QUESTION_ID>'
ORDER BY am.created_at;

-- Все сообщения одного треда (chat_id):
SELECT id, role, status, reply_to,
       content, created_at
FROM chat_agent_messages_bus
WHERE chat_id = '<chat_id>'
ORDER BY created_at;

-- Проверить, что chat_files принадлежит нужному треду:
SELECT id, conversation_id, filename, mime_type, file_size, created_at
FROM t_db_oarb_audit_act_chat_files
WHERE conversation_id = '<chat_id>'
ORDER BY created_at DESC
LIMIT 10;


-- ────────────────────────────────────────────────────────────────────────────
-- 7. ОЧИСТКА ПО TTL (для админов)
-- ────────────────────────────────────────────────────────────────────────────
--
-- Удаляем только завершённые строки: completed / failed.
-- pending и processing НЕ ТРОГАТЬ — это активные диалоги.
-- Видимая пользователю история чата живёт в chat_messages и НЕ затрагивается.
--
-- Рекомендуемые сроки хранения:
--   completed / failed  — 180 дней
-- Подстройте под свои аудит-требования.

-- Для продакшен-очистки с плейсхолдерами ({SCHEMA}.{BUS_TABLE}) см.
-- docs/integrations/agent-channel-cleanup.sql
DELETE FROM chat_agent_messages_bus
WHERE status IN ('completed', 'failed')
  AND updated_at < now() - INTERVAL '180 days';

-- На Greenplum после массивных DELETE'ов полезен VACUUM ANALYZE
-- (PG обычно справляется автовакуумом, но не помешает):
-- VACUUM ANALYZE chat_agent_messages_bus;

-- Зависшие pending/processing/error дольше 2 часов — ручное закрытие:
-- (AW закрывает draft в chat_messages сам по idle-таймауту —
-- 30 мин для pending (CHAT__AGENT_CHANNEL__CLAIM_TIMEOUT_SEC=1800),
-- 30 мин для processing (CHAT__AGENT_CHANNEL__ANSWER_TIMEOUT_SEC=1800) —
-- и best-effort ставит вопросу 'failed';
-- если запись не прошла, строки остаются в исходном статусе —
-- закрываем вручную 'failed' из словаря владельца.
-- 'error' в фильтре обязателен: он НЕ терминальный (агент собирался повторить
-- задачу), поэтому залипшие error-строки без него остались бы невидимы для
-- ручной уборки и висели бы в шине вечно.)
UPDATE chat_agent_messages_bus
SET status     = 'failed',
    updated_at = now()
WHERE role = 'user'
  AND status IN ('pending', 'processing', 'error')
  AND created_at < now() - INTERVAL '2 hours';


-- ────────────────────────────────────────────────────────────────────────────
-- 8. СЦЕНАРИЙ "очередь" (другой пользователь стоит впереди)
-- ────────────────────────────────────────────────────────────────────────────
--
-- Цель: фронт AW должен показать «В очереди: впереди 1 запрос» рядом с
-- индикатором ожидания ответа на ВАШ вопрос (<QUESTION_ID>).
--
-- Механика: позиция = число pending-вопросов всех пользователей (включая свои,
-- role='user', status='pending') с created_at РАНЬШЕ, чем у вашего вопроса.
-- Поллер продлевает claim-таймер
-- (30 мин idle) при уменьшении этого числа — движение очереди тоже считается
-- «признаком жизни».
--
-- ШАГ 1 — Вставить «чужой» pending-вопрос с более ранним временем.
-- Замени ТОЛЬКО <QUESTION_ID> (id строки-вопроса из запроса 0).
-- (chat_id/user_id чужого вопроса намеренно другие, чтобы имитировать
--  другого пользователя; user_id 'other_user_42' — просто заглушка.)

DO $$
DECLARE
    q_id     uuid := '<QUESTION_ID>';   -- ← id ВАШЕГО вопроса из запроса 0
    other_id uuid := md5(random()::text || clock_timestamp()::text)::uuid;
    v_chat   text;
BEGIN
    SELECT chat_id INTO v_chat
    FROM chat_agent_messages_bus
    WHERE id = q_id;

    -- Вставляем вопрос другого пользователя, датированный на 1 минуту раньше.
    -- Его created_at < created_at вашего вопроса → позиция вашего = 1.
    INSERT INTO chat_agent_messages_bus
        (id, chat_id, user_id, role,
         content, metadata, status, created_at, updated_at)
    VALUES (other_id,
            'other-chat-' || left(other_id::text, 8),  -- другой chat_id
            'other_user_42',                            -- другой пользователь
            'user',
            'Другой пользователь: что такое КМ-99-00001?',
            '{"mode": "adaptive", "kb": "oarb"}'::jsonb,   -- как пишет AW: mode из agent_mode, kb по умолчанию 'oarb'
            'pending',
            now() - INTERVAL '1 minute',               -- РАНЬШЕ вашего вопроса
            now() - INTERVAL '1 minute');

    RAISE NOTICE 'Вставлен чужой pending id=%; ваш вопрос встал в очередь за ним', other_id;
END$$;

-- Проверить позицию вашего вопроса в очереди (должно быть 1):
SELECT COUNT(*) AS ahead_count
FROM chat_agent_messages_bus
WHERE role = 'user'
  AND status = 'pending'
  AND created_at < (SELECT created_at FROM chat_agent_messages_bus WHERE id = '<QUESTION_ID>');

-- ── Фронт должен показать «В очереди: впереди 1 запрос». ──
-- Подожди несколько секунд и выполни ШАГ 2.

-- ШАГ 2 — Продвинуть очередь: завершить чужой вопрос (статус completed).
-- После этого ahead_count станет 0, фронт обновит строку статуса.
-- Можно также DELETE вместо UPDATE completed — результат для AW одинаков.
UPDATE chat_agent_messages_bus
SET status     = 'completed',
    updated_at = now()
WHERE user_id  = 'other_user_42'
  AND role     = 'user'
  AND status   = 'pending';

-- Проверить: впереди должно стать 0.
-- (Тот же запрос, что и выше: очередь глобальная, фильтра по user_id в
--  AgentMessageRepository.count_pending_before НЕТ — свои вопросы тоже считаются.)
SELECT COUNT(*) AS ahead_count
FROM chat_agent_messages_bus
WHERE role = 'user'
  AND status = 'pending'
  AND created_at < (SELECT created_at FROM chat_agent_messages_bus WHERE id = '<QUESTION_ID>');

-- ── Фронт должен сменить строку статуса на «В очереди: вы следующий»
-- ── (ahead_count = 0). Поллер продлил claim-таймер, зафиксировав движение очереди.
-- ── Далее — сценарий 9 (взятие в работу) или 1/2/3 (сразу завершить ваш вопрос).


-- ────────────────────────────────────────────────────────────────────────────
-- 9. СЦЕНАРИЙ "задержка взятия в работу"
-- ────────────────────────────────────────────────────────────────────────────
--
-- Цель: наблюдать, что фронт продолжает показывать «В очереди: вы следующий»
-- (текст для ahead_count = 0) пока вопрос остаётся pending — даже без чужих запросов.
-- Claim-таймер AW — 30 мин idle для pending; пока вопрос живой (обновляется
-- или уменьшается очередь) — таймер не истечёт.
--
-- ШАГ 1 — Просто НЕ ДЕЛАЙ ничего с вопросом N минут.
--   Фронт будет показывать статус ожидания. Поллер продолжает проверять позицию.
--   Это не требует SQL — просто подожди.
--
-- ШАГ 2 — Когда будешь готов «взять вопрос в работу», выполни:
-- Замени ТОЛЬКО <QUESTION_ID> (id строки-вопроса из запроса 0).

UPDATE chat_agent_messages_bus
SET status     = 'processing',
    updated_at = now()
WHERE id     = '<QUESTION_ID>'
  AND role   = 'user'
  AND status = 'pending';

-- ── После этого UPDATE фронт покажет «Агент работает над ответом…»
-- ── вместо строки с позицией в очереди. Поллер зафиксировал переход
-- ── pending→processing как признак жизни и продлил answer-таймер (30 мин idle).
-- ── Далее — сценарий 10 (порционный reasoning) или 1/2/3 (сразу ответить).


-- ────────────────────────────────────────────────────────────────────────────
-- 10. СЦЕНАРИЙ "порционный reasoning" (агент стримит рассуждения)
-- ────────────────────────────────────────────────────────────────────────────
--
-- Цель: наблюдать, как фронт допечатывает рассуждения агента по мере их роста.
-- AW поллит строку-ответ (role='assistant', reply_to=<id вопроса>) и при каждом
-- обновлении updated_at / росте metadata.reasoning отображает новый фрагмент.
-- Изменение updated_at — признак жизни, продлевающий answer-таймер (30 мин idle).
--
-- ВАЖНО: сценарий рассчитан на PostgreSQL (dev-имитация). jsonb_set() недоступен
-- в Greenplum 6.x — но шина в проде принадлежит агенту и это не нужно там руками.
--
-- Предполагается, что вопрос уже в статусе processing (выполнен сценарий 9
-- или сценарий 5). Замени ТОЛЬКО <QUESTION_ID>.

-- ШАГ 1 — Создать строку-ответ с пустым content и начальным reasoning.
-- Статус 'processing' означает «агент ещё пишет», AW показывает typing-индикатор
-- и начинает отображать reasoning по мере роста.

DO $$
DECLARE
    q_id    uuid := '<QUESTION_ID>';                                        -- ← подставь сюда
    a_id    uuid := md5(random()::text || clock_timestamp()::text)::uuid;   -- id ответа (авто)
    v_chat  text;
    v_user  text;
BEGIN
    SELECT chat_id, user_id INTO v_chat, v_user
    FROM chat_agent_messages_bus
    WHERE id = q_id;

    INSERT INTO chat_agent_messages_bus
        (id, chat_id, user_id, role,
         content, metadata, reply_to, status, created_at, updated_at)
    VALUES (a_id, v_chat, v_user, 'assistant',
            '',   -- content пустой: агент ещё не сформулировал итоговый текст
            '{"reasoning": "Шаг 1: Разбираю вопрос пользователя."}'::jsonb,
            q_id, 'processing', now(), now());

    RAISE NOTICE 'Строка-ответ создана с id=%; copy для ШАГОВ 2–5', a_id;
END$$;

-- После ШАГА 1 скопируй id строки-ответа из NOTICE выше
-- и подставь в <ANSWER_ID> в шагах 2–4.

-- ── Фронт увидел строку-ответа, начал показывать reasoning «Шаг 1: …».
-- ── Подожди 3–5 секунд, затем выполни ШАГ 2.

-- ШАГ 2 — Дописать следующий фрагмент reasoning.
-- jsonb_set конкатенирует новый текст к существующему reasoning.
-- Изменение updated_at продлевает answer-таймер поллера.
UPDATE chat_agent_messages_bus
SET metadata   = jsonb_set(
                     metadata,
                     '{reasoning}',
                     to_jsonb(coalesce(metadata->>'reasoning', '') ||
                              ' Шаг 2: Ищу релевантные документы в базе знаний.')
                 ),
    updated_at = now()
WHERE id = '<ANSWER_ID>';   -- ← id строки-ответа из NOTICE шага 1

-- ── Подожди 3–5 секунд, затем выполни ШАГ 3.

-- ШАГ 3 — Дописать ещё фрагмент.
UPDATE chat_agent_messages_bus
SET metadata   = jsonb_set(
                     metadata,
                     '{reasoning}',
                     to_jsonb(coalesce(metadata->>'reasoning', '') ||
                              ' Шаг 3: Нашёл 4 документа, выбираю наиболее релевантные.')
                 ),
    updated_at = now()
WHERE id = '<ANSWER_ID>';

-- ── Подожди 3–5 секунд (или дольше — каждый UPDATE продлевает answer-таймер),
-- ── фронт допечатает дельту. Затем — ШАГ 4.

-- ШАГ 4 — Финальный фрагмент reasoning перед формированием ответа.
UPDATE chat_agent_messages_bus
SET metadata   = jsonb_set(
                     metadata,
                     '{reasoning}',
                     to_jsonb(coalesce(metadata->>'reasoning', '') ||
                              ' Шаг 4: Формирую итоговый ответ на основе найденных источников.')
                 ),
    updated_at = now()
WHERE id = '<ANSWER_ID>';

-- ── Подожди 3–5 секунд, затем выполни ШАГ 5 — финализацию.

-- ШАГ 5 — Финализация: записать итоговый content и закрыть оба статуса.
-- После этого AW финализирует черновик chat_messages и рендерит
-- готовый ответ (content + полный reasoning) с декоративным эффектом печати.
DO $$
DECLARE
    q_id uuid := '<QUESTION_ID>';   -- ← id вопроса
    a_id uuid := '<ANSWER_ID>';     -- ← id строки-ответа из NOTICE шага 1
BEGIN
    -- Финальный content + закрываем строку-ответ:
    UPDATE chat_agent_messages_bus
    SET content    = 'Согласно регламенту 2024 года, КСО охватывает три направления: '
                     'социальную политику, экологические инициативы и корпоративное управление. '
                     'Подробнее — в разделе 4.2 документа «Политика КСО».',
        status     = 'completed',
        updated_at = now()
    WHERE id = a_id;

    -- Закрываем строку-вопрос:
    UPDATE chat_agent_messages_bus
    SET status     = 'completed',
        updated_at = now()
    WHERE id = q_id;
END$$;

-- ── AW поллер найдёт status='completed' на строке-ответа, прочитает итоговый
-- ── content и накопленный metadata.reasoning, финализирует chat_messages.
-- ── Фронт допечатает только недостающий хвост: уже показанные рассуждения
-- ── не переанимируются (в т.ч. после reload/переключения беседы).
-- ── Панель реакций (лайк/дизлайк) появляется ПОД финальным ответом.


-- ────────────────────────────────────────────────────────────────────────────
-- 11. СЦЕНАРИЙ "витрина markdown" (проверка рендера ответа)
-- ────────────────────────────────────────────────────────────────────────────
--
-- Цель: один ответ со всеми основными markdown-элементами — заголовки,
-- жирный/курсив/зачёркнутый, inline-код и код-блок с подсветкой, ссылки,
-- списки (включая task-list ☑/☐), таблица, цитата, горизонтальная линия.
-- Фронт рендерит content через marked + DOMPurify (класс .chat-md);
-- reasoning тоже поддерживает markdown.
--
-- Замени ТОЛЬКО <QUESTION_ID> (id строки-вопроса из запроса 0).
-- Текст ответа задан dollar-quoted строкой $md$...$md$ — кавычки и
-- переводы строк внутри неё экранировать не нужно.

DO $$
DECLARE
    q_id    uuid := '<QUESTION_ID>';                                       -- ← подставь сюда
    a_id    uuid := md5(random()::text || clock_timestamp()::text)::uuid;  -- id ответа (авто)
    v_chat  text;
    v_user  text;
    v_md    text;
BEGIN
    SELECT chat_id, user_id INTO v_chat, v_user
    FROM chat_agent_messages_bus
    WHERE id = q_id;

    v_md := $md$## Витрина markdown

**Жирный**, *курсив*, ~~зачёркнутый~~, `inline-код` и [ссылка на регламент](https://example.com/policy).

### Списки

- Маркированный пункт
- Ещё пункт
  - Вложенный подпункт

1. Первый шаг
2. Второй шаг

- [x] Проверка выполнена
- [ ] Ожидает подтверждения

### Таблица

| КМ-номер    | Статус    | Сумма, тыс. |
|-------------|-----------|------------:|
| КМ-11-11111 | Завершён  |       1 200 |
| КМ-22-22222 | В работе  |         340 |

### Код

```python
def check_km(km_number: str) -> bool:
    """Проверяет формат КМ-номера."""
    return km_number.startswith("КМ-")
```

> Цитата: блок-квота с **вложенным** форматированием и `кодом`.

---

Текст после горизонтальной линии.$md$;

    INSERT INTO chat_agent_messages_bus
        (id, chat_id, user_id, role,
         content, metadata, reply_to, status, created_at, updated_at)
    VALUES (a_id, v_chat, v_user, 'assistant',
            v_md,
            '{"reasoning": "Готовлю **витрину** markdown: списки, таблица, `код`, цитата."}'::jsonb,
            q_id, 'completed', now(), now());

    UPDATE chat_agent_messages_bus
    SET status     = 'completed',
        updated_at = now()
    WHERE id = q_id;
END$$;

-- ── Ожидаемый рендер: заголовки, форматирование, ссылка (target=_blank),
-- ── чекбоксы ☑/☐, таблица в пузыре, fenced-код с цветной подсветкой hljs
-- ── (кнопки «Копировать» нет — это код внутри text-блока, а не отдельный
-- ── code-блок), цитата, линия. Reasoning над ответом — тоже с markdown.


-- ────────────────────────────────────────────────────────────────────────────
-- 12. АРЕНДА ЗАДАЧ ВОРКЕРАМИ (public.agent_worker_claims) и reclaim
-- ────────────────────────────────────────────────────────────────────────────
--
-- Таблица принадлежит стороне агента (NanoBot, класс PostgresChannel) и
-- приложением НЕ создаётся и НЕ читается — она лежит здесь, чтобы дев-стенд
-- можно было поднять целиком и воспроизвести reclaim по истёкшему lease.
-- Схема в DDL ниже — `public` (как у владельца); на GP подставь схему
-- имитации (значение DATABASE__GP__SCHEMA, в .env.dev —
-- s_grnplm_ld_audit_da_project_4).
--
-- Инвариант: задача обрабатывается воркером (status='processing')  ⇔
--            существует ровно одна claim-запись для task_id (с живым lease).
-- PK (task_id) — жёсткая гарантия эксклюзивности: два INSERT'а с одним
-- task_id невозможны (второй падает на unique-индексе), поэтому одна задача
-- физически не может быть захвачена двумя воркерами.
-- Индексов сверх PK НЕТ сознательно (решение владельца — в долг).

CREATE TABLE IF NOT EXISTS public.agent_worker_claims (
    task_id     UUID NOT NULL PRIMARY KEY,   -- = chat_agent_messages_bus.id
    worker_id   TEXT NOT NULL,               -- идентификатор воркера ({host}:{pid}:{rand})
    claimed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_until TIMESTAMPTZ NOT NULL,        -- продлевается heartbeat'ом воркера
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
-- Клауза только для Greenplum; на PostgreSQL строку ниже удалить,
-- а точку с запятой перенести на закрывающую скобку.
DISTRIBUTED BY (task_id);

COMMENT ON TABLE  public.agent_worker_claims IS 'Аренда задач воркерами PostgresChannel. PK(task_id) гарантирует, что одна задача обрабатывается ровно одним воркером; lease_until продлевается heartbeat воркера и по истечении возвращает задачу в пул.';
COMMENT ON COLUMN public.agent_worker_claims.task_id     IS 'PK — ID задачи (= chat_agent_messages_bus.id). Два INSERT с одним task_id невозможны.';
COMMENT ON COLUMN public.agent_worker_claims.worker_id   IS 'Идентификатор воркера, держащего аренду ({hostname}:{pid}:{rand8}).';
COMMENT ON COLUMN public.agent_worker_claims.claimed_at  IS 'Момент захвата аренды.';
COMMENT ON COLUMN public.agent_worker_claims.lease_until IS 'Срок жизни аренды; продлевается heartbeat воркера; после истечения задача возвращается в пул (reclaim).';
COMMENT ON COLUMN public.agent_worker_claims.created_at  IS 'Время создания записи аренды.';

-- ── Имитация claim'а: воркер взял вопрос в работу на 5 минут.
-- Замени ТОЛЬКО <QUESTION_ID> (id строки-вопроса из запроса 0).
INSERT INTO public.agent_worker_claims (task_id, worker_id, claimed_at, lease_until, created_at)
VALUES ('<QUESTION_ID>', 'devhost:1234:ab12cd34', now(), now() + interval '5 minutes', now());

UPDATE chat_agent_messages_bus
SET status     = 'processing',
    updated_at = now()
WHERE id = '<QUESTION_ID>';

-- ── Имитация RECLAIM'а: lease истёк, воркер не отозвался. NanoBot удаляет
-- ── claim-запись и свою строку-ответ, возвращая вопрос в пул ('pending').
-- ── Для AW это ПРИЗНАК ЖИЗНИ: подписка живёт, фаза откатывается
-- ── processing → pending, idle-таймер сбрасывается. Засчитывается не более
-- ── 3 ЭПИЗОДОВ (_MAX_PENDING_REVERSIONS в agent_channel_poller.py) —
-- ── защита от бесконечного продления флаппингом чужой таблицы.
DO $$
DECLARE
    q_id uuid := '<QUESTION_ID>';   -- ← подставь сюда
BEGIN
    DELETE FROM public.agent_worker_claims WHERE task_id = q_id;
    DELETE FROM chat_agent_messages_bus WHERE reply_to = q_id AND role = 'assistant';

    UPDATE chat_agent_messages_bus
    SET status     = 'pending',
        updated_at = now()
    WHERE id = q_id;
END$$;

-- ── Диагностика аренд: кто что держит и не протух ли lease.
SELECT c.task_id, c.worker_id, c.claimed_at, c.lease_until,
       (c.lease_until < now()) AS lease_expired,
       b.status AS question_status
FROM public.agent_worker_claims c
LEFT JOIN chat_agent_messages_bus b ON b.id = c.task_id
ORDER BY c.claimed_at DESC
LIMIT 50;
