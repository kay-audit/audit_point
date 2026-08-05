"""Репозиторий обратной связи по сообщениям ассистента (лайк/дизлайк).

Таблица ``chat_message_feedback`` идемпотентна по паре ``(message_id, user_id)``
(составной PRIMARY KEY). UPSERT реализован как read-modify-write в транзакции
(на Greenplum нет ``ON CONFLICT``). Конкурентные оценки одного пользователя
сериализуются в сервисе через per-user lock — гонки INSERT/INSERT не возникает.
"""

import json
import logging

from app.db.repositories.base import BaseRepository
from app.db.types import DbConn
from app.domains.chat.settings import resolve_chat_schema

logger = logging.getLogger("audit_workstation.domains.chat.repo.feedback")


class ChatMessageFeedbackRepository(BaseRepository):
    """CRUD обратной связи по сообщениям ассистента."""

    def __init__(self, conn: DbConn):
        super().__init__(conn)
        schema = resolve_chat_schema()
        self.table = self.adapter.get_table_name(
            "chat_message_feedback", schema=schema,
        )
        # Для join'а с текстом ответа в аналитике (list_feedback).
        self.msg_table = self.adapter.get_table_name(
            "chat_messages", schema=schema,
        )

    @staticmethod
    def _filters(
        *,
        prefix: str = "",
        rating: str | None = None,
        route_type: str | None = None,
        agent_mode: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        start_idx: int = 1,
    ) -> tuple[str, list, int]:
        """Строит WHERE-клаузу и параметры для аналитических выборок.

        ``prefix`` (например ``"f."``) квалифицирует колонки при join'е, где
        ``created_at`` неоднозначен. Даты кастуются ``::timestamp`` (принимаем
        строку YYYY-MM-DD). Возвращает (where_sql, params, next_idx)."""
        conds: list[str] = []
        params: list = []
        i = start_idx
        if rating is not None:
            conds.append(f"{prefix}rating = ${i}"); params.append(rating); i += 1
        if route_type is not None:
            conds.append(f"{prefix}route_type = ${i}"); params.append(route_type); i += 1
        if agent_mode is not None:
            conds.append(f"{prefix}agent_mode = ${i}"); params.append(agent_mode); i += 1
        if date_from is not None:
            conds.append(f"{prefix}created_at >= ${i}::timestamp"); params.append(date_from); i += 1
        if date_to is not None:
            conds.append(f"{prefix}created_at <= ${i}::timestamp"); params.append(date_to); i += 1
        where = ("WHERE " + " AND ".join(conds)) if conds else ""
        return where, params, i

    @staticmethod
    def _parse_row(row) -> dict:
        """Десериализует JSONB-поле ``reasons`` из строки в Python-список."""
        result = dict(row)
        val = result.get("reasons")
        if isinstance(val, str):
            try:
                result["reasons"] = json.loads(val)
            except json.JSONDecodeError:
                result["reasons"] = None
        return result

    async def upsert(
        self,
        *,
        conversation_id: str,
        message_id: str,
        user_id: str,
        rating: str,
        reasons: list[str] | None = None,
        comment: str | None = None,
        source: str = "user",
        route_type: str | None = None,
        agent_mode: str | None = None,
        model: str | None = None,
    ) -> dict:
        """Создаёт или обновляет оценку пользователя на сообщение.

        Read-modify-write в транзакции (GP-совместимо, без ``ON CONFLICT``).
        Вызывающий сервис обязан держать per-user lock, чтобы конкурентные
        оценки одного пользователя не привели к гонке INSERT/INSERT.
        """
        reasons_json = (
            json.dumps(reasons, ensure_ascii=False) if reasons else None
        )
        async with self.conn.transaction():
            existing = await self.conn.fetchrow(
                f"SELECT 1 FROM {self.table} "
                f"WHERE message_id = $1 AND user_id = $2",
                message_id,
                user_id,
            )
            if existing is None:
                row = await self.conn.fetchrow(
                    f"""
                    INSERT INTO {self.table}
                        (conversation_id, message_id, user_id, rating, reasons,
                         comment, source, route_type, agent_mode, model)
                    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
                    RETURNING *
                    """,
                    conversation_id,
                    message_id,
                    user_id,
                    rating,
                    reasons_json,
                    comment,
                    source,
                    route_type,
                    agent_mode,
                    model,
                )
            else:
                row = await self.conn.fetchrow(
                    f"""
                    UPDATE {self.table}
                    SET rating = $3,
                        reasons = $4::jsonb,
                        comment = $5,
                        source = $6,
                        route_type = $7,
                        agent_mode = $8,
                        model = $9,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE message_id = $1 AND user_id = $2
                    RETURNING *
                    """,
                    message_id,
                    user_id,
                    rating,
                    reasons_json,
                    comment,
                    source,
                    route_type,
                    agent_mode,
                    model,
                )
        return self._parse_row(row)

    async def clear(self, *, message_id: str, user_id: str) -> bool:
        """Удаляет оценку пользователя на сообщение. Идемпотентно.

        :returns: True, если строка была удалена; False, если её не было.
        """
        status = await self.conn.execute(
            f"DELETE FROM {self.table} WHERE message_id = $1 AND user_id = $2",
            message_id,
            user_id,
        )
        # asyncpg возвращает строку вида "DELETE <n>".
        try:
            return int(str(status).rsplit(" ", 1)[-1]) > 0
        except (ValueError, IndexError):
            return False

    async def get_for_message(
        self, *, message_id: str, user_id: str,
    ) -> dict | None:
        """Оценка конкретного пользователя на сообщение или None."""
        row = await self.conn.fetchrow(
            f"SELECT * FROM {self.table} "
            f"WHERE message_id = $1 AND user_id = $2",
            message_id,
            user_id,
        )
        return self._parse_row(row) if row else None

    async def get_map_for_conversation(
        self, *, conversation_id: str, user_id: str,
    ) -> dict[str, dict]:
        """Карта ``message_id -> оценка`` пользователя в рамках беседы.

        Используется для восстановления состояния кнопок при загрузке истории.
        """
        rows = await self.conn.fetch(
            f"SELECT * FROM {self.table} "
            f"WHERE conversation_id = $1 AND user_id = $2",
            conversation_id,
            user_id,
        )
        return {r["message_id"]: self._parse_row(r) for r in rows}

    # ── Аналитика (admin) ───────────────────────────────────────────────────

    async def get_all_for_conversation(
        self, conversation_id: str,
    ) -> dict[str, list[dict]]:
        """Все оценки беседы (всех пользователей), сгруппированные по message_id.

        Для инспектора диалога: админ видит оценки всех пользователей.
        """
        rows = await self.conn.fetch(
            f"SELECT * FROM {self.table} WHERE conversation_id = $1 "
            f"ORDER BY created_at",
            conversation_id,
        )
        out: dict[str, list[dict]] = {}
        for r in rows:
            out.setdefault(r["message_id"], []).append(self._parse_row(r))
        return out

    async def get_stats(
        self,
        *,
        route_type: str | None = None,
        agent_mode: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        reasons_sample_limit: int = 5000,
    ) -> dict:
        """Агрегаты обратной связи: всего/up/down/like_rate, срезы по маршруту,
        модели и причинам дизлайка.

        Все срезы — из ОДНОГО запроса с полным GROUP BY по (route_type, model,
        rating): обычный GROUP BY (GP-совместимо, без GROUPING SETS), один скан
        таблицы вместо трёх, агрегация в Python по ячейкам куба (кардинальность
        мала: маршруты × модели × 2 оценки). Причины (JSONB-массив) считаются
        в Python по ограниченной выборке дизлайков, чтобы не зависеть от
        set-returning функций в FROM на GP."""
        where, params, _ = self._filters(
            route_type=route_type, agent_mode=agent_mode,
            date_from=date_from, date_to=date_to,
        )

        cube_rows = await self.conn.fetch(
            f"SELECT route_type, model, rating, COUNT(*) AS cnt FROM {self.table} {where} "
            f"GROUP BY route_type, model, rating",
            *params,
        )
        by_rating: dict[str, int] = {}
        by_route: dict[str, dict[str, int]] = {}
        by_model: dict[str, dict[str, int]] = {}
        for r in cube_rows:
            rating_key = r["rating"]
            cnt = int(r["cnt"])
            by_rating[rating_key] = by_rating.get(rating_key, 0) + cnt
            route_key = r["route_type"] or "unknown"
            by_route.setdefault(route_key, {"up": 0, "down": 0})
            by_route[route_key][rating_key] = (
                by_route[route_key].get(rating_key, 0) + cnt
            )
            model_key = r["model"] or "unknown"
            by_model.setdefault(model_key, {"up": 0, "down": 0})
            by_model[model_key][rating_key] = (
                by_model[model_key].get(rating_key, 0) + cnt
            )
        up = by_rating.get("up", 0)
        down = by_rating.get("down", 0)
        total = up + down

        # Причины дизлайка — по ограниченной выборке (JSONB-массив, считаем в Python).
        rwhere, rparams, ridx = self._filters(
            rating="down", route_type=route_type, agent_mode=agent_mode,
            date_from=date_from, date_to=date_to,
        )
        reason_rows = await self.conn.fetch(
            f"SELECT reasons FROM {self.table} {rwhere} AND reasons IS NOT NULL "
            f"LIMIT ${ridx}",
            *rparams, int(reasons_sample_limit),
        )
        by_reason: dict[str, int] = {}
        for r in reason_rows:
            parsed = self._parse_row(r).get("reasons") or []
            if isinstance(parsed, list):
                for code in parsed:
                    by_reason[code] = by_reason.get(code, 0) + 1

        like_rate = round(up / total, 4) if total else None
        return {
            "total": total,
            "up": up,
            "down": down,
            "like_rate": like_rate,
            "by_route": by_route,
            "by_model": by_model,
            "by_reason": by_reason,
        }

    async def list_feedback(
        self,
        *,
        rating: str | None = None,
        route_type: str | None = None,
        agent_mode: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[dict], int]:
        """Пагинированный список оценок с контентом оцененного ответа.

        join к chat_messages даёт content ответа (для предпросмотра «что
        ответили»). Возвращает (items, total)."""
        where, params, idx = self._filters(
            prefix="f.", rating=rating, route_type=route_type,
            agent_mode=agent_mode, date_from=date_from, date_to=date_to,
        )
        # COUNT(*) OVER () считается до LIMIT/OFFSET — общее количество едет
        # вместе со страницей, без отдельного COUNT-запроса (оконные функции
        # есть и в GP 6). Пустая страница (offset за концом / нет совпадений)
        # окна не даёт — добираем количество отдельным COUNT ниже.
        rows = await self.conn.fetch(
            f"""
            SELECT f.message_id, f.conversation_id, f.user_id, f.rating,
                   f.reasons, f.comment, f.route_type, f.agent_mode, f.model,
                   f.created_at, f.updated_at,
                   m.content AS message_content, m.status AS message_status,
                   COUNT(*) OVER () AS total_count
            FROM {self.table} f
            LEFT JOIN {self.msg_table} m ON m.id = f.message_id
            {where}
            ORDER BY f.created_at DESC
            LIMIT ${idx} OFFSET ${idx + 1}
            """,
            *params, int(limit), int(offset),
        )
        if rows:
            total = int(rows[0]["total_count"])
        else:
            total = int(await self.conn.fetchval(
                f"SELECT COUNT(*) FROM {self.table} f {where}",
                *params,
            ) or 0)
        items = []
        for r in rows:
            item = self._parse_row(r)
            item.pop("total_count", None)
            mc = item.get("message_content")
            if isinstance(mc, str):
                try:
                    item["message_content"] = json.loads(mc)
                except json.JSONDecodeError:
                    item["message_content"] = None
            items.append(item)
        return items, total
