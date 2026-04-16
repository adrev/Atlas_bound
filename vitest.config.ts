import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'server/src/**/*.test.ts',
      'client/src/**/*.test.ts',
      'client/src/**/*.test.tsx',
      'shared/src/**/*.test.ts',
    ],
  },
});
