import { defineConfig } from '@playwright/test'

// Testes de navegador do Pulse. Rodam contra o BUILD de produção
// (vite build + vite preview), em modo local (sem Supabase: sem
// VITE_SUPABASE_*), portanto exercitam o LocalStorageAdapter e toda a
// UI real. Chromium vem de PLAYWRIGHT_BROWSERS_PATH (não baixa nada).
// Rode com: npm run test:e2e
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173/Pulse/',
    serviceWorkers: 'block',
    launchOptions: { args: ['--no-sandbox'] }
  },
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173/Pulse/',
    reuseExistingServer: true,
    timeout: 120_000,
    env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' }
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }]
})
