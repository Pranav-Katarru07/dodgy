import { defineConfig } from 'vitest/config';

// Enable Vitest globals (describe/it/expect) so test files need no imports,
// matching tsconfig `types: ["vitest/globals"]`.
export default defineConfig({
  test: {
    globals: true,
  },
});
