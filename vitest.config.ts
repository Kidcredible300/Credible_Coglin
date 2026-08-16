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
        miniflare: {
          bindings: {
            // Test-only binding; the setup file replays these into each test
            // file's isolated database so tests run against the real schema.
            TEST_MIGRATIONS: migrations,
            // Auth secrets are per-environment secrets in real deployments;
            // tests need fixed values to sign up against.
            SESSION_PEPPER: 'test-pepper',
            ALPHA_SIGNUP_CODE: 'test-signup-code',
            APP_BASE_URL: 'http://coglin.test',
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ['./worker/test-setup.ts'],
  },
});
