import { applyD1Migrations, env } from 'cloudflare:test';

// Storage is isolated per test file, so the schema is applied per test file.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
