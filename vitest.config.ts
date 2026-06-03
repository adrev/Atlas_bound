import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'server/src/**/*.test.ts',
      'client/src/**/*.test.ts',
      'client/src/**/*.test.tsx',
      'shared/src/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      all: true,
      include: [
        'server/src/socket/**/*.ts',
        'server/src/services/CombatService.ts',
        'server/src/services/DiceService.ts',
        'client/src/socket/**/*.ts',
        'shared/src/utils/dice-parser.ts',
      ],
      reporter: ['text-summary', 'json-summary', 'html'],
      thresholds: {
        statements: 38,
        branches: 34,
        functions: 31,
        lines: 42,
      },
    },
  },
});
