import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.e2e-live.test.ts'],
    globals: true,
    testTimeout: 300_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    sequence: { concurrent: false },
    retry: 0,
  },
});
