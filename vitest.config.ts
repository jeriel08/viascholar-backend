import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // SWC transpiles TypeScript and emits the decorator metadata NestJS DI needs.
    swc.vite(),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['./test/setup.ts'],
    clearMocks: true,
    // Show each spec, describe block, and it(...) scenario name in the terminal.
    reporters: ['tree'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/main.ts',
        'src/**/*.module.ts',
        'src/**/*.dto.ts',
        'src/**/index.ts',
        'src/generated/**',
        'src/types/**',
      ],
    },
  },
});
