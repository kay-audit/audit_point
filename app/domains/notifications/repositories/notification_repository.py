"""Репозиторий центра уведомлений."""

from app.db.repositories.base import BaseRepository
from app.db.types import DbConn
from app.domains.notifications.exceptions import NotificationNotFoundError


class NotificationRepository(BaseRepository):
    """CRUD-операции с уведомлениями и состоянием их прочтения.

    Состояние (``notification_state``) создаётся лениво при первом
    read/dismiss. UPSERT через ``ON CONFLICT`` недоступен (GP = PG 9.4):
    делаем «UPDATE; если 0 строк — INSERT». Все UPDATE состояния явно
    ставят ``updated_at = CURRENT_TIMESTAMP`` (триггеров в проекте нет).
    """

    def __init__(self, conn: DbConn):
        super().__init__(conn)
        # Стандартный домен: схему не указываем — PG public / основная схема GP.
        self.notifications = self.adapter.get_table_name("notifications")
        self.state = self.adapter.get_table_name("notification_state")

    @staticmethod
    def _visible_clause(param: int, *, alias: str = "", cast: str = "") -> str:
        """Единый предикат видимости: адресное пользователю ИЛИ broadcast.

        Broadcast — ``recipient_user_id IS NULL``. ``alias`` — префикс таблицы
        (``"n"`` в list/count/mark_all_read; пусто в ``_is_visible_to_user``),
        ``param`` — номер позиционного параметра ($1 vs $2), ``cast`` —
        приведение типа (``"::varchar"`` в ``_is_visible_to_user``).
        """
        col = f"{alias}.recipient_user_id" if alias else "recipient_user_id"
        return f"({col} = ${param}{cast} OR {col} IS NULL)"

    async def list_for_user(self, user_id: str, *, limit: int = 50) -> list[dict]:
        """Возвращает видимые пользователю уведомления (адресные + broadcast).

        Исключает скрытые (``is_dismissed = TRUE``). ``is_read`` — COALESCE
        со state (нет строки → FALSE). Сортировка по дате создания DESC.
        """
        rows = await self.conn.fetch(
            f"""
            SELECT n.id, n.source, n.severity, n.title, n.body,
                   n.link, n.element_ref, n.created_at,
                   COALESCE(s.is_read, FALSE) AS is_read
            FROM {self.notifications} n
            LEFT JOIN {self.state} s
                ON s.notification_id = n.id AND s.user_id = $1
            WHERE {self._visible_clause(1, alias="n")}
              AND COALESCE(s.is_dismissed, FALSE) = FALSE
            ORDER BY n.created_at DESC
            LIMIT $2
            """,
            user_id,
            limit,
        )
        return [dict(r) for r in rows]

    # Ранжир критичности для max-severity бейджа: error самый высокий, далее
    # warning, info; success (и прочее) — низший (0/None), чтобы не красить
    # бейдж ложно. Набор severity — из CHECK check_notifications_severity.
    _SEV_RANK_TO_STR = {3: "error", 2: "warning", 1: "info"}

    async def unread_summary(self, user_id: str) -> dict:
        """Число непрочитанных видимых уведомлений и их максимальная критичность.

        Непрочитанные = state нет ИЛИ is_read=FALSE, и при этом не скрытые.
        Возвращает ``{"count": int, "severity": "error"|"warning"|"info"|None}``;
        ``severity`` = максимальная критичность среди непрочитанных (или None,
        если непрочитанных нет / только success). Считается одним запросом.
        """
        row = await self.conn.fetchrow(
            f"""
            SELECT COUNT(*) AS count,
                   MAX(CASE n.severity
                           WHEN 'error' THEN 3
                           WHEN 'warning' THEN 2
                           WHEN 'info' THEN 1
                           ELSE 0
                       END) AS sev_rank
            FROM {self.notifications} n
            LEFT JOIN {self.state} s
                ON s.notification_id = n.id AND s.user_id = $1
            WHERE {self._visible_clause(1, alias="n")}
              AND COALESCE(s.is_dismissed, FALSE) = FALSE
              AND COALESCE(s.is_read, FALSE) = FALSE
            """,
            user_id,
        )
        count = (row["count"] if row else 0) or 0
        sev_rank = row["sev_rank"] if row else None
        return {
            "count": count,
            "severity": self._SEV_RANK_TO_STR.get(sev_rank),
        }

    async def _is_visible_to_user(self, notification_id: str, user_id: str) -> bool:
        """Существует ли видимое пользователю уведомление с таким id.

        Видимое = адресное пользователю ИЛИ broadcast (``recipient_user_id
        IS NULL``). Приведение ``$2::varchar`` — превентивно от
        ``AmbiguousParameterError`` на GP (как в ``mark_all_read``).
        """
        return await self.conn.fetchval(
            f"""
            SELECT EXISTS(
                SELECT 1 FROM {self.notifications}
                WHERE id = $1
                  AND {self._visible_clause(2, cast="::varchar")}
            )
            """,
            notification_id,
            user_id,
        )

    async def mark_read(self, notification_id: str, user_id: str) -> None:
        """Помечает уведомление прочитанным (lazy upsert state)."""
        result = await self.conn.execute(
            f"""
            UPDATE {self.state}
            SET is_read = TRUE, updated_at = CURRENT_TIMESTAMP
            WHERE notification_id = $1 AND user_id = $2
            """,
            notification_id,
            user_id,
        )
        if result == "UPDATE 0":
            if not await self._is_visible_to_user(notification_id, user_id):
                raise NotificationNotFoundError("Уведомление не найдено")
            await self.conn.execute(
                f"""
                INSERT INTO {self.state}
                    (notification_id, user_id, is_read, is_dismissed)
                VALUES ($1, $2, TRUE, FALSE)
                """,
                notification_id,
                user_id,
            )

    async def mark_unread(self, notification_id: str, user_id: str) -> None:
        """Возвращает уведомление в непрочитанное (lazy upsert state).

        Зеркало ``mark_read``: ставит ``is_read = FALSE``. Если state-строки нет
        — уведомление и так непрочитано (COALESCE FALSE), но создаём явную строку
        для консистентности с mark_read/dismiss и проверки видимости.
        """
        result = await self.conn.execute(
            f"""
            UPDATE {self.state}
            SET is_read = FALSE, updated_at = CURRENT_TIMESTAMP
            WHERE notification_id = $1 AND user_id = $2
            """,
            notification_id,
            user_id,
        )
        if result == "UPDATE 0":
            if not await self._is_visible_to_user(notification_id, user_id):
                raise NotificationNotFoundError("Уведомление не найдено")
            await self.conn.execute(
                f"""
                INSERT INTO {self.state}
                    (notification_id, user_id, is_read, is_dismissed)
                VALUES ($1, $2, FALSE, FALSE)
                """,
                notification_id,
                user_id,
            )

    async def mark_all_read(self, user_id: str) -> None:
        """Помечает все видимые уведомления пользователя прочитанными.

        Для уведомлений без state — создаёт state с is_read=TRUE; для
        существующих (включая broadcast с уже созданным state) — UPDATE.
        Скрытые (is_dismissed) не трогаем.
        """
        # 1. Обновляем уже существующие непрочитанные state-строки.
        await self.conn.execute(
            f"""
            UPDATE {self.state}
            SET is_read = TRUE, updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $1 AND is_read = FALSE AND is_dismissed = FALSE
            """,
            user_id,
        )
        # 2. Создаём state для видимых уведомлений, у которых его ещё нет.
        #    $1::varchar обязателен: в списке SELECT голый $1 выводится как text,
        #    а в сравнениях ниже (recipient_user_id = $1, s.user_id = $1) — как
        #    varchar из колонок; без явного приведения типы параметра конфликтуют
        #    (AmbiguousParameterError: text и character varying).
        await self.conn.execute(
            f"""
            INSERT INTO {self.state}
                (notification_id, user_id, is_read, is_dismissed)
            SELECT n.id, $1::varchar, TRUE, FALSE
            FROM {self.notifications} n
            WHERE {self._visible_clause(1, alias="n")}
              AND NOT EXISTS (
                  SELECT 1 FROM {self.state} s
                  WHERE s.notification_id = n.id AND s.user_id = $1
              )
            """,
            user_id,
        )

    async def dismiss(self, notification_id: str, user_id: str) -> None:
        """Скрывает уведомление для пользователя (lazy upsert state)."""
        result = await self.conn.execute(
            f"""
            UPDATE {self.state}
            SET is_dismissed = TRUE, updated_at = CURRENT_TIMESTAMP
            WHERE notification_id = $1 AND user_id = $2
            """,
            notification_id,
            user_id,
        )
        if result == "UPDATE 0":
            if not await self._is_visible_to_user(notification_id, user_id):
                raise NotificationNotFoundError("Уведомление не найдено")
            await self.conn.execute(
                f"""
                INSERT INTO {self.state}
                    (notification_id, user_id, is_read, is_dismissed)
                VALUES ($1, $2, FALSE, TRUE)
                """,
                notification_id,
                user_id,
            )

    async def create(
        self,
        *,
        id: str,
        source: str,
        title: str,
        severity: str = "info",
        body: str | None = None,
        link: str | None = None,
        element_ref: str | None = None,
        recipient_user_id: str | None = None,
        created_by: str = "system",
    ) -> str:
        """Создаёт уведомление и возвращает его id."""
        return await self.conn.fetchval(
            f"""
            INSERT INTO {self.notifications}
                (id, recipient_user_id, source, severity, title, body,
                 link, element_ref, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id
            """,
            id,
            recipient_user_id,
            source,
            severity,
            title,
            body,
            link,
            element_ref,
            created_by,
        )
