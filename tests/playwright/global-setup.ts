import { spawn, spawnSync, ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Global setup для Playwright:
 * 1. Проверяет Redis и чистит его тестовую БД (Redis обязателен — без него
 *    приложение не стартует).
 * 2. Применяет seed-данные через `python tests/playwright/seed.py`.
 * 3. Запускает uvicorn на 127.0.0.1:8005 как detached-процесс.
 * 4. Polling-ом ждёт пока /api/v1/auth/me ответит 200 с authenticated=true (timeout 30s).
 *
 * PID сохраняется в `tests/playwright/.uvicorn.pid` для teardown.
 *
 * Использует env JUPYTERHUB_USER=test_22494524 (digits → 22494524).
 * Параметры БД берёт из родительского окружения (загружаются из .env самим pydantic).
 */
const ROOT = path.resolve(__dirname, '..', '..');
const PID_FILE = path.join(__dirname, '.uvicorn.pid');
const LOG_FILE = path.join(__dirname, '.uvicorn.log');

const BASE_URL = 'http://127.0.0.1:8005';
const READY_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 200;

// Отдельная БД Redis под e2e: ключи DEV-запуска (db 0) остаются нетронутыми,
// а FLUSHDB перед прогоном не рискует снести чью-то рабочую сессию.
const E2E_REDIS_DB = '15';
const REDIS_TIMEOUT_MS = 3000;
const REDIS_HELP = 'Поднимите Redis (WSL): docs/guides/redis-dev-wsl-guide.md';

function loadDotEnv(): Record<string, string> {
  const envPath = path.join(ROOT, '.env');
  const out: Record<string, string> = {};
  if (!fs.existsSync(envPath)) return out;
  const text = fs.readFileSync(envPath, 'utf-8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    out[key] = value;
  }
  return out;
}

/** Кодирует команду в RESP-массив: `*N\r\n$len\r\narg\r\n…`. */
function encodeCommand(args: string[]): string {
  const parts = args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`);
  return `*${args.length}\r\n${parts.join('')}`;
}

/**
 * Отправляет пачку команд одним соединением и возвращает строки-ответы.
 *
 * Свой мини-клиент на `node:net` вместо npm-зависимости или `wsl redis-cli`
 * (wsl есть в PATH не у всякого шелла). Все используемые команды отвечают
 * однострочным `+OK` / `+PONG` / `-ERR …`, поэтому ответы режутся по CRLF.
 */
function talkToRedis(
  host: string,
  port: number,
  commands: string[][]
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(REDIS_TIMEOUT_MS);

    let buffer = '';
    const replies: string[] = [];
    const fail = (message: string) => {
      socket.destroy();
      reject(new Error(message));
    };

    socket.on('connect', () => {
      socket.write(commands.map(encodeCommand).join(''));
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      let idx: number;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        replies.push(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
      if (replies.length >= commands.length) {
        socket.end();
        resolve(replies);
      }
    });
    socket.on('timeout', () =>
      fail(`Redis ${host}:${port} не ответил за ${REDIS_TIMEOUT_MS} мс. ${REDIS_HELP}`)
    );
    socket.on('error', (e: Error) =>
      fail(`Redis ${host}:${port} недоступен: ${e.message}. ${REDIS_HELP}`)
    );
  });
}

/**
 * Проверяет доступность Redis и очищает тестовую БД перед прогоном.
 *
 * FLUSHDB обязателен: блокировки актов живут ключами `lock:act:*` с TTL 15
 * минут, и остатки прошлого прогона иначе делают акт «занятым» для нового.
 */
async function prepareRedis(env: NodeJS.ProcessEnv): Promise<void> {
  const host = env.REDIS__HOST || '127.0.0.1';
  const port = parseInt(env.REDIS__PORT || '6379', 10);
  const password = env.REDIS__PASSWORD || '';

  const commands: string[][] = [];
  if (password) commands.push(['AUTH', password]);
  commands.push(['PING'], ['SELECT', E2E_REDIS_DB], ['FLUSHDB']);

  const replies = await talkToRedis(host, port, commands);
  const failed = replies.find((r) => r.startsWith('-'));
  if (failed) {
    throw new Error(
      `Redis ${host}:${port} ответил ошибкой на подготовку db ${E2E_REDIS_DB}: ` +
      `${failed}. ${REDIS_HELP}`
    );
  }
  // eslint-disable-next-line no-console
  console.log(`[playwright global-setup] Redis ${host}:${port} готов, db ${E2E_REDIS_DB} очищен`);
}

function runSeed(env: NodeJS.ProcessEnv): void {
  const seedScript = path.join(__dirname, 'seed.py');
  const result = spawnSync('python', [seedScript], {
    cwd: ROOT,
    env,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    const stderr = result.stderr || '';
    const stdout = result.stdout || '';
    throw new Error(
      `Seed-скрипт упал (exit=${result.status}):\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`
    );
  }
  // eslint-disable-next-line no-console
  console.log('[playwright global-setup] seed выполнен');
}

async function waitForServerReady(): Promise<void> {
  const start = Date.now();
  let lastErr: string = '';
  while (Date.now() - start < READY_TIMEOUT_MS) {
    try {
      const resp = await fetch(`${BASE_URL}/api/v1/auth/me`);
      if (resp.ok) {
        const body = (await resp.json()) as { authenticated?: boolean };
        if (body.authenticated === true) {
          // eslint-disable-next-line no-console
          console.log('[playwright global-setup] uvicorn готов');
          return;
        }
        lastErr = `authenticated=${body.authenticated}`;
      } else {
        lastErr = `HTTP ${resp.status}`;
      }
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `uvicorn не стартанул за ${READY_TIMEOUT_MS}ms (последняя ошибка: ${lastErr}). ` +
    `Лог: ${LOG_FILE}`
  );
}

function spawnUvicorn(env: NodeJS.ProcessEnv): ChildProcess {
  // Чистим старый лог чтобы при провале setup читать только текущую попытку.
  try { fs.unlinkSync(LOG_FILE); } catch {}
  const logFd = fs.openSync(LOG_FILE, 'a');
  const proc = spawn(
    'python',
    ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8005'],
    {
      cwd: ROOT,
      env,
      stdio: ['ignore', logFd, logFd],
      detached: false,
    }
  );
  if (proc.pid == null) {
    throw new Error('Не удалось запустить uvicorn (pid=null)');
  }
  fs.writeFileSync(PID_FILE, String(proc.pid));
  // eslint-disable-next-line no-console
  console.log(`[playwright global-setup] uvicorn PID=${proc.pid}, log=${LOG_FILE}`);
  return proc;
}

export default async function globalSetup(): Promise<void> {
  const dotenv = loadDotEnv();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...dotenv,
    // Тестовый username: digits → 22494524 (admin в .env). E2e гоняются в
    // тест-режиме (AUTH__ENABLED=false): resolve_env_username берёт split('_')[0]
    // и оставляет цифры. 'test_22494524' даст '' — нужен формат '<digits>_<остаток>'.
    JUPYTERHUB_USER: '22494524_e2e-test',
    AUTH__ENABLED: 'false',
    // Redis обязателен независимо от AUTH__ENABLED; своя БД под e2e (см. выше).
    REDIS__DB: E2E_REDIS_DB,
    PYTHONUNBUFFERED: '1',
    // Снимаем rate-limit для тестов: ~90 JS-файлов × N reload'ов уходят за
    // 1024 req/min из дефолтного .env, → 429 на /static/js/* → тесты падают.
    SECURITY__RATE_LIMIT_PER_MINUTE: '100000',
  };

  await prepareRedis(env);
  runSeed(env);
  spawnUvicorn(env);
  await waitForServerReady();
}
