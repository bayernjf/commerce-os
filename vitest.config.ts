import { defineConfig } from 'vitest/config';

// node:sqlite is a built-in module newer than this Vite version's builtin
// allow-list; a pre-resolve plugin marks it external so the test runner
// loads it from Node instead of Vite trying (and failing) to bundle "sqlite".
const externalizeNodeSqlite = {
  name: 'externalize-node-sqlite',
  enforce: 'pre' as const,
  resolveId(source: string) {
    if (source === 'node:sqlite') return { id: 'node:sqlite', external: true };
    return null;
  },
};

export default defineConfig({
  plugins: [externalizeNodeSqlite],
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    pool: 'threads',
  },
});
