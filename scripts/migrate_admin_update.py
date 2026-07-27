"""Разовая миграция: привести БД в актуальное состояние.

Зачем нужен:
- create_tables_if_not_exist выполняет schema.sql только если есть
  отсутствующие таблицы. Если все таблицы уже есть (existing deployment),
  schema.sql целиком пропускается — никакие ALTER TABLE / INSERT,
  добавленные в новой версии schema.sql, не применяются.
- Этот скрипт делает ТОЛЬКО ИЗМЕНЕНИЯ, которые должны пройти при апгрейде
  с прошлой версии на текущую. Каждое изменение идемпотентно.

Применяется вручную ОДИН РАЗ после обновления кода:
    python -m scripts.migrate_admin_update

Безопасно запускать повторно — все операции проверяют текущее состояние.
"""
import asyncio
import logging

logger = logging.getLogger("audit_workstation.migration.admin_update")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


async def main() -> None:
    # Инициализация: домены + БД
    from pathlib import Path
    from app.core.domain_registry import discover_domains
    from app.core.config import get_settings
    from app.core.settings_registry import get as get_domain_settings
    from app.db.connection import (
        init_db,
        get_db,
        get_adapter,
        close_db,
    )
    from app.domains.admin.settings import AdminSettings

    domains = discover_domains(Path("app/domains").resolve())
    await init_db(get_settings())

    settings = get_domain_settings("admin", AdminSettings)
    adapter = get_adapter()
    user_table = adapter.qualify_table_name(
        settings.user_directory.table, settings.user_directory.schema_name
    )
    roles_table = adapter.get_table_name(
        "roles", settings.user_directory.schema_name
    )
    user_roles_table = adapter.get_table_name(
        "user_roles", settings.user_directory.schema_name
    )

    async with get_db() as conn:
        # 1. ALTER TABLE — добавить колонки tb / is_deleted / deleted_at / deleted_by
        logger.info("=== Шаг 1: добавляем колонки в %s ===", user_table)
        for col_sql, col_name in [
            ("ADD COLUMN IF NOT EXISTS tb VARCHAR(16) NOT NULL DEFAULT ''", "tb"),
            ("ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE", "is_deleted"),
            ("ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP", "deleted_at"),
            ("ADD COLUMN IF NOT EXISTS deleted_by VARCHAR(50) NOT NULL DEFAULT ''", "deleted_by"),
        ]:
            sql = f"ALTER TABLE {user_table} {col_sql}"
            logger.info("  Выполняю: %s", sql)
            await conn.execute(sql)

        # 1b. Индексы
        logger.info("=== Шаг 1b: создаём индексы ===")
        await conn.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{settings.user_directory.table}_is_deleted "
            f"ON {user_table}(is_deleted) WHERE is_deleted = FALSE"
        )
        await conn.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{settings.user_directory.table}_tb "
            f"ON {user_table}(tb) WHERE tb <> ''"
        )

        # 2. INSERT новых ролей (ЦК Code Mining, ЦК Process Mining)
        logger.info("=== Шаг 2: добавляем новые роли ===")
        new_roles = [
            ("ЦК Code Mining", "ck_code_mining", "Доступ к ЦК Code Mining"),
            ("ЦК Process Mining", "ck_process_mining", "Доступ к ЦК Process Mining"),
        ]
        for name, domain, desc in new_roles:
            sql = (
                f"INSERT INTO {roles_table} (name, domain_name, description) "
                f"VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING"
            )
            await conn.execute(sql, name, domain, desc)
            logger.info("  Роль '%s' (домен %s)", name, domain)

        # 3. Роль «Администратор»: убедиться, что она существует.
        logger.info("=== Шаг 3: миграция «Админ» → «Администратор» ===")
        admin_row = await conn.fetchrow(
            f"SELECT id FROM {roles_table} WHERE name = 'Админ' LIMIT 1"
        )
        administrator_row = await conn.fetchrow(
            f"SELECT id FROM {roles_table} WHERE name = 'Администратор' LIMIT 1"
        )

        if admin_row and not administrator_row:
            # Случай (A): только «Админ» есть. Переименовываем.
            logger.info("  Случай A: переименовываем «Админ» → «Администратор»")
            await conn.execute(
                f"UPDATE {roles_table} SET name = 'Администратор', "
                f"description = 'Полный доступ ко всем доменам и функциям' "
                f"WHERE name = 'Админ'"
            )
        elif admin_row and administrator_row:
            # Случай (B): обе роли есть. Копируем связи user_roles и удаляем старую.
            admin_id = admin_row["id"]
            administrator_id = administrator_row["id"]
            if admin_id == administrator_id:
                # Дедупликация: одна и та же строка с обоими именами (теоретически)
                logger.info("  Случай C: дубль по id=%d — приводим к «Администратор»", admin_id)
                await conn.execute(
                    f"UPDATE {roles_table} SET name = 'Администратор' WHERE id = $1",
                    admin_id,
                )
            else:
                logger.info(
                    "  Случай B: копируем user_roles из «Админ» (id=%d) "
                    "в «Администратор» (id=%d) и удаляем старую роль",
                    admin_id, administrator_id,
                )
                # Копируем связи, ON CONFLICT защищает от дублей
                await conn.execute(
                    f"INSERT INTO {user_roles_table} (username, role_id, assigned_by) "
                    f"SELECT ur.username, $1, ur.assigned_by "
                    f"FROM {user_roles_table} ur "
                    f"WHERE ur.role_id = $2 "
                    f"ON CONFLICT (username, role_id) DO NOTHING",
                    administrator_id, admin_id,
                )
                # Удаляем старую роль (CASCADE удалит её user_roles)
                await conn.execute(
                    f"DELETE FROM {roles_table} WHERE id = $1", admin_id
                )
        elif administrator_row:
            logger.info("  Случай C: только «Администратор» — миграция не нужна")
        else:
            logger.warning("  Ни «Админ», ни «Администратор» не найдены — INSERT")
            await conn.execute(
                f"INSERT INTO {roles_table} (name, domain_name, description) "
                f"VALUES ('Администратор', NULL, 'Полный доступ ко всем доменам и функциям')"
            )

        # 4. Финальная проверка
        logger.info("=== Шаг 4: проверка результата ===")
        final_roles = await conn.fetch(
            f"SELECT id, name, domain_name FROM {roles_table} ORDER BY id"
        )
        for r in final_roles:
            print(f"  id={r['id']:3d}  name={r['name']:40s}  domain={r['domain_name']}")

        admin_row = await conn.fetchrow(
            f"SELECT id FROM {roles_table} WHERE name = 'Администратор'"
        )
        if admin_row:
            admin_users = await conn.fetch(
                f"SELECT username FROM {user_roles_table} WHERE role_id = $1 ORDER BY username",
                admin_row["id"],
            )
            print(f"\n  Пользователи с ролью «Администратор» ({len(admin_users)}):")
            for u in admin_users:
                print(f"    - {u['username']}")

    await close_db()
    print("\n[OK] Миграция успешно завершена.")


if __name__ == "__main__":
    asyncio.run(main())
