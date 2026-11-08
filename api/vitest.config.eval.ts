import { defineConfig } from 'vitest/config';

// Only for `npm run eval`. It calls the real AI, so it is kept out of `npm test`.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['eval/**/*.eval.ts'],
    testTimeout: 3 * 60 * 60 * 1000,
  },
});
