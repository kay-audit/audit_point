"""Разовая миграция: добавляет раздельные роли агентов и ЦК всем пользователям.

Зачем нужен:
- До этой миграции все агенты (ИОР, CRM, Документы, Источники данных,
  BackLog команд, Follow UP) разделяли одну общую роль «SQL-агент».
  Админ-панель не могла отдельно управлять доступом к каждому агенту.
- Эта миграция создаёт отдельные роли в БД и назначает их всем НЕ-удалённым
  пользователям. У админов остаётся неизменная роль «Администратор»
  (они и так имеют доступ ко всему), но для обычных пользователей теперь
  sidebar точно отражает, какие агенты им доступны.

Применяется вручную ОДИН РАЗ после обновления кода:
    python -m scripts.migrate_agent_roles

Безопасно запускать повторно — все операции идемпотентные (ON CONFLICT/NOT EXISTS).
"""
import asyncio
import logging

logger = logging.getLogger('audit_workstation.migration.agent_roles')
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')


# (название роли, domain_name в БД, описание)
NEW_AGENT_ROLES = [
    ('ИОР',               'sqlagent_ior',      'Доступ к агенту «ИОР» (анализ отклонений)'),
    ('CRM',               'sqlagent_crm',      'Доступ к агенту «CRM» (анализ клиентской базы)'),
    ('Документы',         'sqlagent_docs',     'Доступ к агенту «Документы» (анализ SberDocs)'),
    ('Источники данных',  'sqlagent_sources',  'Доступ к агенту «Источники данных» (метаданные)'),
    ('BackLog команд',    'sqlagent_jira',     'Доступ к агенту «BackLog команд» (Jira/Confluence)'),
    ('Follow UP',         'sqlagent_followup', 'Доступ к агенту «Follow UP» (контроль задач)'),
    ('AI-ассистент',      'chat_assistant',    'Доступ к боковой панели AI-ассистента'),
]

# Роли, которые уже есть (ЦК) — могут отсутствовать у части пользователей,
# поэтому добавляем если их нет.
CK_ROLES = [
    'ЦК финансовый результат',
    'ЦК клиентский опыт',
    'ЦК Code Mining',
    'ЦК Process Mining',
]


async def main() -> None:
    from pathlib import Path
    from app.core.domain_registry import discover_domains
    from app.core.config import get_settings
    from app.core.settings_registry import get as get_domain_settings
    from app.db.connection import init_db, get_db, get_adapter, close_db
    from app.domains.admin.settings import AdminSettings

    discover_domains(Path('app/domains').resolve())
    await init_db(get_settings())
    settings = get_domain_settings('admin', AdminSettings)
    adapter = get_adapter()
    user_table = adapter.qualify_table_name(
        settings.user_directory.table, settings.user_directory.schema_name,
    )
    roles_table = adapter.get_table_name('roles', settings.user_directory.schema_name)
    user_roles_table = adapter.get_table_name('user_roles', settings.user_directory.schema_name)

    async with get_db() as conn:
        # 1. Добавляем новые роли агентов (idempotent).
        logger.info('=== Шаг 1: создание ролей агентов ===')
        for name, domain, desc in NEW_AGENT_ROLES:
            existing = await conn.fetchval(
                f'SELECT id FROM {roles_table} WHERE name = $1', name,
            )
            if existing is not None:
                logger.info('  [SKIP] %s уже существует (id=%s)', name, existing)
                continue
            if adapter.supports_on_conflict():
                await conn.execute(
                    f'INSERT INTO {roles_table} (name, domain_name, description) '
                    f'VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING',
                    name, domain, desc,
                )
            else:
                # GP: используем WHERE NOT EXISTS.
                await conn.execute(
                    f"""INSERT INTO {roles_table} (name, domain_name, description)
                        SELECT $1::varchar, $2::varchar, $3::text
                        WHERE NOT EXISTS (
                            SELECT 1 FROM {roles_table} WHERE name = $1
                        )""",
                    name, domain, desc,
                )
            new_id = await conn.fetchval(
                f'SELECT id FROM {roles_table} WHERE name = $1', name,
            )
            logger.info('  [ADDED] %s (id=%s, domain=%s)', name, new_id, domain)

        # 2. Назначаем эти роли + роли ЦК всем активным пользователям.
        logger.info('=== Шаг 2: массовое назначение ролей ===')
        # Соберём id-шники целевых ролей.
        target_role_names = [r[0] for r in NEW_AGENT_ROLES] + CK_ROLES
        rows = await conn.fetch(
            f'SELECT id, name FROM {roles_table} WHERE name = ANY($1::text[])',
            target_role_names,
        )
        role_id_by_name = {r['name']: r['id'] for r in rows}
        if not role_id_by_name:
            logger.warning('  Ни одной из целевых ролей не нашлось в БД — выходим')
            await close_db()
            return
        logger.info('  Целевых ролей в БД: %d', len(role_id_by_name))

        # Все пользователи.
        users = await conn.fetch(
            f'SELECT username FROM {user_table} WHERE COALESCE(is_deleted, FALSE) = FALSE'
        )
        usernames = [u['username'] for u in users]
        logger.info('  Активных пользователей: %d', len(usernames))

        # Уже назначенные (для дедупликации).
        existing = await conn.fetch(
            f'SELECT username, role_id FROM {user_roles_table}'
        )
        existing_set = {(r['username'], r['role_id']) for r in existing}

        planned = 0
        for u in usernames:
            for role_id in role_id_by_name.values():
                if (u, role_id) not in existing_set:
                    planned += 1
        logger.info('  Будет вставлено назначений: %d', planned)

        if planned == 0:
            logger.info('  Все уже назначены — нечего делать.')
        else:
            ok = 0
            fails = 0
            async with conn.transaction():
                for username in usernames:
                    for role_id in role_id_by_name.values():
                        if (username, role_id) in existing_set:
                            continue
                        try:
                            if adapter.supports_on_conflict():
                                await conn.execute(
                                    f'INSERT INTO {user_roles_table} (username, role_id, assigned_by) '
                                    f'VALUES ($1, $2, $3) ON CONFLICT (username, role_id) DO NOTHING',
                                    username, role_id, 'migrate_agent_roles',
                                )
                            else:
                                await conn.execute(
                                    f"""INSERT INTO {user_roles_table} (username, role_id, assigned_by)
                                        SELECT $1::varchar, $2::bigint, $3::varchar
                                        WHERE NOT EXISTS (
                                            SELECT 1 FROM {user_roles_table}
                                            WHERE username = $1 AND role_id = $2
                                        )""",
                                    username, role_id, 'migrate_agent_roles',
                                )
                            ok += 1
                        except Exception as e:
                            fails += 1
                            logger.warning('  [FAIL] %s role_id=%s: %s', username, role_id, e)
            logger.info('  Готово: %d вставлено, %d ошибок', ok, fails)

        # 3. Сводка.
        logger.info('=== Шаг 3: проверка ===')
        summary = await conn.fetch(
            f'''SELECT r.name, COUNT(ur.username) AS cnt
                FROM {roles_table} r
                LEFT JOIN {user_roles_table} ur ON ur.role_id = r.id
                GROUP BY r.id, r.name
                ORDER BY r.id'''
        )
        print('\nРоль                              | Назначений')
        print('-' * 60)
        for r in summary:
            print(f'  {r["name"]:33s} | {r["cnt"]:>4}')

    await close_db()
    print('\n[OK] Миграция успешно завершена.')


if __name__ == '__main__':
    asyncio.run(main())
