import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  webServer: {
    command: 'npm run preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 90_000,
  },
  use: { baseURL: 'http://127.0.0.1:4173' },
  reporter: 'line',
});
