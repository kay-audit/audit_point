"""Фоновый поллер ответов из bus-таблицы chat_agent_messages_bus.

Один asyncio-task на процесс. Следит за draft-сообщениями (status='streaming',
agent_ref IS NOT NULL) и финализирует их, когда внешний агент заполнит reply_to
на строке-вопросе.

Таймауты — idle-семантика по двум фазам:
  pending   — вопрос ждёт взятия в работу; лимит claim_timeout_sec.
  processing — агент пишет ответ; лимит answer_timeout_sec.
Отсчёт в обеих фазах ведётся от последнего ПРИЗНАКА ЖИЗНИ агента:
смены фазы (в обе стороны — возврат вопроса в пул по истёкшему lease тоже
признак жизни), роста reasoning, изменения answer.updated_at (начиная со
второго наблюдения), уменьшения числа pending-вопросов впереди.

Adaptive backoff: при активности интервал сбрасывается в min_interval;
при пустом тике растёт × multiplier до max_interval.

Соединение БД тик НЕ удерживает: работа идёт через ``DbExecutor``, который
берёт соединение из пула на каждую SQL-операцию (или на явную транзакцию) и
сразу возвращает. Это принципиально: внутри тика есть await'ы, уходящие в
чужой код с собственными обращениями к БД (эмиссия уведомления о готовности
ответа, трансляция кнопок агента через ChatTool). Удерживай тик соединение —
эти обращения были бы повторным захватом пула в том же task'е (страж в
``get_db``), и уведомление с кнопкой молча терялись бы.
"""

from __future__ import annotations

import asyncio
import logging
import time as _time_module
from typing import Any, Callable

from app.domains.chat.settings import ChatDomainSettings

logger = logging.getLogger("audit_workstation.domains.chat.services.agent_channel_poller")

# Подряд идущих ошибок обработки ОДНОЙ подписки, после которых она снимается
# аварийно (с best-effort финализацией draft'а). Полный отказ БД сюда не
# доходит — он ловится в _run ещё на получении коннекта, счётчики не растут.
# Порог отлавливает «отравленные» подписки (например, сменившуюся структуру
# bus-таблицы), которые иначе ретраились бы вечно, оставляя draft в
# 'streaming' до рестарта. При backoff 2-10 сек порог ≈ 1-5 минут сбоев.
_MAX_CONSECUTIVE_ENTRY_ERRORS = 30

# Сколько раз возврат вопроса processing → pending (reclaim NanoBot при
# истёкшем lease) считается признаком жизни и возвращает claim-окно.
# = max_stuck_retries NanoBot; дальше фаза остаётся processing — защита от
# бесконечного продления флаппингом чужой таблицы.
_MAX_PENDING_REVERSIONS = 3


class AgentChannelPoller:
    """Process-level поллер ответов агента через bus-таблицу chat_agent_messages_bus.

    Инжектируемые зависимости ``now`` и ``executor_factory`` упрощают
    тестирование без реального event loop и без реальной БД.
    """

    def __init__(
        self,
        settings: ChatDomainSettings,
        *,
        now: Callable[[], float] = _time_module.monotonic,
        executor_factory: Callable[[], Any] | None = None,
    ) -> None:
        """
        settings         — ChatDomainSettings (берёт agent_channel).
        now              — провайдер монотонного времени (для тестов).
        executor_factory — провайдер исполнителя БД; по умолчанию
                           ``get_executor`` (импортируется внутри, чтобы не
                           тащить зависимость на module-level и оставаться
                           патчабельным).
        """
        self._settings = settings
        self._now = now
        # Если None — лениво берём процесс-синглтон в _get_executor().
        self._executor_factory = executor_factory

        # Реестр подписок: uid вопроса → entry-словарь с idle-состоянием.
        self._subscriptions: dict[str, dict] = {}

        self._stop = False
        self._task: asyncio.Task | None = None
        # Текущий интервал backoff'а — для diagnostics-снимка (get_status).
        self._current_interval: float = settings.agent_channel.poll_min_interval_sec

    def get_status(self) -> dict:
        """Снимок состояния поллера для diagnostics-endpoint'а."""
        return {
            "name": "chat.agent_channel_poller",
            "running": self._task is not None and not self._task.done(),
            "active_subscriptions": len(self._subscriptions),
            "current_interval_sec": self._current_interval,
        }

    def _get_executor(self):
        """Возвращает исполнитель БД (соединение на операцию).

        Если фабрика не инжектирована — берёт процесс-синглтон
        ``get_executor``. Импорт внутри метода обеспечивает патчабельность
        в тестах.
        """
        if self._executor_factory is not None:
            return self._executor_factory()
        from app.db.executor import get_executor
        return get_executor()

    # ── Подписки ──────────────────────────────────────────────────────────────

    def subscribe(self, *, assistant_message_id: str, question_uid: str) -> None:
        """Идемпотентно регистрирует ожидание ответа агента.

        Повторный вызов с тем же question_uid — no-op.

        Entry хранит idle-состояние двухфазного таймаута:
          last_activity  — монотонный timestamp последнего признака жизни агента.
          phase          — 'pending' (ждём взятия в работу) или 'processing'
                           (агент пишет ответ). Лимиты: claim_timeout_sec /
                           answer_timeout_sec соответственно.
          last_reasoning_len   — последняя известная длина reasoning (рост = жив).
          last_queue_ahead     — число pending-вопросов впереди (уменьшение = жив).
          last_answer_updated_at — timestamp ответа при последнем наблюдении;
                           первое ненулевое значение — baseline (не activity),
                           каждое последующее изменение — activity.
          pending_reversions   — сколько раз фаза откатилась processing →
                           pending по reclaim'у агента (кап
                           _MAX_PENDING_REVERSIONS).
        """
        if question_uid in self._subscriptions:
            logger.debug(
                "agent_channel_poller: subscribe no-op, question_uid=%s уже в реестре",
                question_uid,
            )
            return
        self._subscriptions[question_uid] = {
            "assistant_message_id": assistant_message_id,
            # Idle-таймер: момент последнего ПРИЗНАКА ЖИЗНИ агента
            # (движение очереди, взятие в работу, рост reasoning).
            "last_activity": self._now(),
            # Фаза: 'pending' (ждём взятия в работу, лимит claim_timeout_sec)
            # либо 'processing' (ответ пишется, лимит answer_timeout_sec).
            "phase": "pending",
            "last_reasoning_len": 0,
            "last_queue_ahead": None,
            "last_answer_updated_at": None,
            # Ошибок обработки подряд; сбрасывается успешным тиком. По
            # достижении _MAX_CONSECUTIVE_ENTRY_ERRORS подписка снимается.
            "consecutive_errors": 0,
            # Сколько раз фаза откатывалась processing → pending (reclaim
            # NanoBot). Кап — _MAX_PENDING_REVERSIONS.
            "pending_reversions": 0,
        }
        logger.info(
            "agent_channel_poller: подписан question_uid=%s, message_id=%s (всего=%d)",
            question_uid,
            assistant_message_id,
            len(self._subscriptions),
        )

    def unsubscribe(self, question_uid: str) -> None:
        """Убирает подписку. Идемпотентно."""
        self._subscriptions.pop(question_uid, None)

    # ── Тик ───────────────────────────────────────────────────────────────────

    async def _tick(self, executor) -> int:
        """Обходит все подписки и финализирует готовые / таймаутит просроченные.

        ``executor`` — исполнитель БД (``DbExecutor``), а НЕ соединение:
        соединение берётся из пула на каждую операцию и сразу возвращается,
        поэтому await'ы внутри тика (уведомления, трансляция кнопок) идут
        при нулевом числе удерживаемых соединений.

        Возвращает количество завершённых (done + timeout) за тик.
        Не падает при ошибке одной подписки — оборачивает каждую в try/except.

        Liveness и idle-таймауты по фазам:
          Признаки жизни агента: смена фазы pending → processing, откат
          processing → pending по reclaim'у агента (не более
          _MAX_PENDING_REVERSIONS раз), рост reasoning_len, изменение
          answer_updated_at (начиная со второго наблюдения), уменьшение
          queue_ahead.
          Пока фаза 'pending' — лимит cfg.claim_timeout_sec от last_activity.
          Пока фаза 'processing' — лимит cfg.answer_timeout_sec от last_activity.
          Таймаут: mark_timeout(reason='claim'|'answer'), unsubscribe.
        """
        from app.domains.chat.services.agent_channel import (
            TIMEOUT_REASON_ANSWER,
            TIMEOUT_REASON_CLAIM,
            AgentChannelService,
        )

        cfg = self._settings.agent_channel
        now = self._now()
        done_count = 0

        # Снимок ключей, чтобы безопасно удалять из _subscriptions во время итерации.
        for question_uid in list(self._subscriptions):
            entry = self._subscriptions.get(question_uid)
            if entry is None:
                continue
            assistant_message_id = entry["assistant_message_id"]
            try:
                svc = AgentChannelService(executor, self._settings)
                res = await svc.poll_once(
                    assistant_message_id=assistant_message_id,
                    question_uid=question_uid,
                    last_reasoning_len=entry["last_reasoning_len"],
                    want_queue_position=(entry["phase"] == "pending"),
                )
                if res["outcome"] == "done":
                    self.unsubscribe(question_uid)
                    done_count += 1
                    logger.info(
                        "agent_channel_poller: финализирован question_uid=%s, message_id=%s",
                        question_uid, assistant_message_id,
                    )
                    continue

                # ── Признаки жизни агента ──
                alive = False
                # Прямой переход pending → processing.
                observed_processing = (
                    res["answer_exists"]
                    or res["question_status"] not in (None, "pending")
                )
                if entry["phase"] == "pending" and observed_processing:
                    entry["phase"] = "processing"
                    alive = True
                # Обратный переход processing → pending. Фаза больше НЕ
                # монотонна: NanoBot при истёкшем lease возвращает вопрос в пул
                # (status снова 'pending' либо 'error') и удаляет свою
                # строку-ответ — это reclaim, признак жизни, а не тишина.
                # Проверка идёт ПОСЛЕ прямого блока сознательно: сделай её до
                # него — прямой блок в том же тике увидел бы уже
                # откатившуюся фазу и при status='error' (observed_processing
                # истинно) немедленно вернул бы processing, съев откат.
                # Порядок «прямой → обратный» гарантирует, что тик
                # заканчивается фазой, соответствующей наблюдаемому статусу.
                # Откат ограничен _MAX_PENDING_REVERSIONS — иначе флаппинг
                # чужой таблицы продлевал бы ожидание вечно.
                if (
                    entry["phase"] == "processing"
                    and not res["answer_exists"]
                    and res["question_status"] in ("pending", "error")
                    and entry["pending_reversions"] < _MAX_PENDING_REVERSIONS
                ):
                    entry["pending_reversions"] += 1
                    entry["phase"] = "pending"
                    # Строка-ответ снесена: следующая будет новой, и старые
                    # baseline'ы к ней не относятся. Без сброса reasoning
                    # повторной попытки не доехал бы до черновика, пока не
                    # перерастёт длину прерванной (poll_once сравнивает с
                    # last_reasoning_len).
                    entry["last_answer_updated_at"] = None
                    entry["last_reasoning_len"] = 0
                    alive = True
                if res["reasoning_len"] > entry["last_reasoning_len"]:
                    entry["last_reasoning_len"] = res["reasoning_len"]
                    alive = True
                if res["answer_updated_at"] is not None:
                    # Первое наблюдение — baseline, не активность; исчезновение
                    # строки-ответа (None) активностью тем более не считается.
                    if (entry["last_answer_updated_at"] is not None
                            and res["answer_updated_at"] != entry["last_answer_updated_at"]):
                        alive = True
                    entry["last_answer_updated_at"] = res["answer_updated_at"]
                qa = res["queue_ahead"]
                if entry["phase"] == "pending" and qa is not None:
                    if entry["last_queue_ahead"] is not None and qa < entry["last_queue_ahead"]:
                        alive = True  # очередь движется — агент жив
                    entry["last_queue_ahead"] = qa
                if alive:
                    entry["last_activity"] = now

                limit_sec = (
                    cfg.claim_timeout_sec if entry["phase"] == "pending"
                    else cfg.answer_timeout_sec
                )
                if now - entry["last_activity"] >= limit_sec:
                    reason = (
                        TIMEOUT_REASON_CLAIM if entry["phase"] == "pending"
                        else TIMEOUT_REASON_ANSWER
                    )
                    await svc.mark_timeout(
                        assistant_message_id=assistant_message_id,
                        question_uid=question_uid,
                        reason=reason,
                    )
                    self.unsubscribe(question_uid)
                    done_count += 1
                    logger.info(
                        "agent_channel_poller: таймаут (%s) question_uid=%s, message_id=%s",
                        reason, question_uid, assistant_message_id,
                    )
                entry["consecutive_errors"] = 0
            except Exception:
                entry["consecutive_errors"] += 1
                if entry["consecutive_errors"] >= _MAX_CONSECUTIVE_ENTRY_ERRORS:
                    logger.exception(
                        "agent_channel_poller: %d ошибок подряд по question_uid=%s — "
                        "снимаем подписку аварийно",
                        entry["consecutive_errors"], question_uid,
                    )
                    await self._abandon_subscription(
                        executor,
                        question_uid=question_uid,
                        assistant_message_id=assistant_message_id,
                    )
                    done_count += 1
                else:
                    logger.exception(
                        "agent_channel_poller: ошибка при обработке question_uid=%s — пропускаем",
                        question_uid,
                    )

        return done_count

    async def _abandon_subscription(
        self, executor, *, question_uid: str, assistant_message_id: str,
    ) -> None:
        """Аварийно снимает подписку после серии ошибок подряд.

        Best-effort финализирует draft через mark_timeout (error-блок + статус
        в шине), чтобы сообщение не висело в 'streaming' до рестарта. Сбой
        финализации глотается: подписку снимаем в любом случае — застрявший
        draft подхватит reconcile при следующем старте.
        """
        from app.domains.chat.services.agent_channel import (
            TIMEOUT_REASON_ANSWER,
            AgentChannelService,
        )

        self.unsubscribe(question_uid)
        try:
            await AgentChannelService(executor, self._settings).mark_timeout(
                assistant_message_id=assistant_message_id,
                question_uid=question_uid,
                reason=TIMEOUT_REASON_ANSWER,
            )
        except Exception:
            logger.exception(
                "agent_channel_poller: не удалось финализировать draft %s "
                "при аварийном снятии подписки",
                assistant_message_id,
            )

    # ── Reconcile ─────────────────────────────────────────────────────────────

    async def reconcile(self) -> None:
        """При старте восстанавливает реестр из streaming-draft'ов с agent_ref.

        Защищает от потери подписок после рестарта uvicorn: все 'streaming'
        сообщения с непустым agent_ref снова попадают в реестр.

        После рестарта восстановленная подписка начинается с фазы 'pending' и
        last_activity=now(): монотонные часы не переживают рестарт, и wall-clock
        created_at draft'а к ним не привести. Idle-таймер отсчитывается заново
        с момента reconcile. Уже отвеченные за время простоя draft'ы
        финализируются на первом же тике (poll_once видит reply_to), так что
        лишнее idle-ожидание касается только реально зависших запросов.
        Фаза после reconcile — 'pending', но первый же тик re-derive'ит её из
        poll_once (строка-ответ существует → сразу 'processing' с answer-лимитом),
        поэтому транзиентная классификация безвредна.
        """
        from app.domains.chat.repositories.message_repository import MessageRepository

        drafts = await MessageRepository(self._get_executor()).get_streaming_drafts()

        restored = 0
        for draft in drafts:
            msg_id = draft.get("id")
            q_uid = draft.get("agent_ref")
            if msg_id and q_uid:
                self.subscribe(
                    assistant_message_id=msg_id,
                    question_uid=q_uid,
                )
                restored += 1

        logger.info(
            "agent_channel_poller: reconcile — восстановлено %d подписок",
            restored,
        )

    # ── Основной цикл ─────────────────────────────────────────────────────────

    async def _run(self) -> None:
        """Фоновый цикл с adaptive backoff. Не падает от одиночных ошибок."""
        cfg = self._settings.agent_channel
        interval = cfg.poll_min_interval_sec

        while not self._stop:
            try:
                if not self._subscriptions:
                    # Подписчиков нет — спим, к БД не ходим.
                    interval = cfg.poll_min_interval_sec
                    self._current_interval = interval
                    await asyncio.sleep(interval)
                    continue

                # Соединение НЕ удерживается на время тика: исполнитель берёт
                # его из пула на каждую операцию. Оборачивать тик в get_db()
                # нельзя — см. модульный docstring.
                n = await self._tick(self._get_executor())

                if n > 0:
                    interval = cfg.poll_min_interval_sec
                else:
                    interval = min(
                        interval * cfg.poll_backoff_multiplier,
                        cfg.poll_max_interval_sec,
                    )
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(
                    "agent_channel_poller: ошибка в основном цикле — продолжаем",
                )
                interval = cfg.poll_min_interval_sec

            self._current_interval = interval
            await asyncio.sleep(interval)

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def start(self) -> None:
        """Создаёт asyncio-задачу фонового цикла. Идемпотентно."""
        if self._task is not None and not self._task.done():
            return
        self._stop = False
        self._task = asyncio.create_task(
            self._run(), name="chat-agent-channel-poller",
        )
        logger.info("agent_channel_poller: запущен")

    async def stop(self) -> None:
        """Останавливает фоновый цикл и ждёт его завершения."""
        self._stop = True
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        logger.info("agent_channel_poller: остановлен")
