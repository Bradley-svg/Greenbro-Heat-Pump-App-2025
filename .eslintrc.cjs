const globals = require('globals');

module.exports = {
  root: true,
  env: {
    es2021: true,
  },
  ignorePatterns: ['dist/', 'node_modules/', 'apps/web/dist/', 'apps/web/public/'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: {
      jsx: true,
    },
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'off',
    'no-empty': 'off',
    'prefer-const': 'off',
  },
  overrides: [
    {
      files: ['src/**/*.{ts,tsx}'],
      env: {
        worker: true,
        es2021: true,
      },
      globals: {
        ...globals.worker,
        ...globals.serviceworker,
      },
    },
    {
      files: ['apps/web/src/**/*.{ts,tsx,js,jsx}'],
      env: {
        browser: true,
        es2021: true,
      },
      plugins: ['react-hooks'],
      extends: ['plugin:react-hooks/recommended'],
      globals: {
        ...globals.browser,
        ...globals.es2021,
      },
      rules: {
        'react-hooks/rules-of-hooks': 'warn',
        'react-hooks/exhaustive-deps': 'warn',
      },
    },
    {
      files: ['scripts/**/*.{ts,js}'],
      env: {
        node: true,
        es2021: true,
      },
      globals: {
        ...globals.node,
      },
    },
    {
      files: ['**/*.cjs'],
      parserOptions: {
        sourceType: 'script',
      },
    },
  ],
};
