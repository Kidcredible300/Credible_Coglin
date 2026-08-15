import type { Bindings } from './types';

// `cloudflare:test` and `cloudflare:workers` both type their `env` export as
// `Cloudflare.Env`, so that is the namespace to augment. This is the same shape
// `wrangler types` would generate, written by hand to keep codegen out of CI.
declare global {
  namespace Cloudflare {
    interface Env extends Bindings {
      /** Test-only binding, injected by vitest.config.ts. */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
