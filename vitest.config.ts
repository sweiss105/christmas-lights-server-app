import { defineConfig } from 'vitest/config';
// "source" export condition: tests import workspace packages straight from TypeScript, no build step needed.
export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: { include: ['packages/*/test/**/*.test.ts'] },
});
