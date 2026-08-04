import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright-конфиг для Audit Workstation E2E.
 *
 * Сервер uvicorn поднимается в global-setup и останавливается в global-teardown
 * (не через `webServer:` — нужен контроль над env/seed-данными).
 */
export default defineConfig({
  testDir: './tests/playwright/specs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 5000 },
  reporter: 'list',
  globalSetup: './tests/playwright/global-setup.ts',
  globalTeardown: './tests/playwright/global-teardown.ts',
  use: {
    baseURL: 'http://127.0.0.1:8005',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /27-preview-fit-stability/,
    },
    {
      // Спеку петли «скроллбар ↔ fit-масштаб» нужен нативный скроллбар,
      // занимающий место в layout: headless Chromium по умолчанию стартует
      // с --hide-scrollbars, и петля физически не воспроизводится.
      name: 'chromium-scrollbars',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] },
      },
      testMatch: /27-preview-fit-stability/,
    },
  ],
});
