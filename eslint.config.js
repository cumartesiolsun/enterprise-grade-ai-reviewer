// @ts-check
import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['dist/', 'node_modules/', 'coverage/', 'build/']),
  {
    files: ['**/*.ts'],
    extends: [eslint.configs.recommended, tseslint.configs.recommended],
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      // Tests stub Octokit and API responses with loose shapes.
      '@typescript-eslint/no-explicit-any': 'off',
      // Warn (not error) on unused imports/vars in tests: helpers like `vi`
      // are often imported ahead of use while specs are being written.
      '@typescript-eslint/no-unused-vars': 'warn',
    },
  }
);
