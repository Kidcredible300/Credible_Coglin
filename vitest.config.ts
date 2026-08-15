import path from 'node:path';
import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: the Cloudflare *Vite* plugin cannot
// run under vitest's own dev server. Tests instead run inside a real workerd
// runtime, which is what makes the tenancy-isolation tests in Phase 1
// meaningful — they exercise the actual D1 binding, not a mock.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(
        path.join(import.meta.dirname, 'migrations'),
      );

      return {
        wrangler: { configPath: './wrangler.jsonc' },
        // Test-only binding; the setup file replays these into each test
        // file's isolated database so tests run against the real schema.
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      };
    }),
  ],
  test: {
    setupFiles: ['./worker/test-setup.ts'],
  },
});
