import { defineConfig } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = dirname(fileURLToPath(import.meta.url));
const webAppDir = join(workspaceRoot, '../apps/web');

export default defineConfig({
  testDir: '.',
  use: {
    baseURL: process.env.BASE_URL || 'http://127.0.0.1:4173',
  },
  reporter: 'line',
  webServer: {
    command: 'npm run preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 90000,
    cwd: webAppDir,
  },
});
