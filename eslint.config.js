import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import globals from "globals";

export default [
  { ignores: ["**/dist/**","**/build/**",".wrangler/**","**/.output/**","**/.next/**","**/node_modules/**"] },
  {
    files: ["**/*.{ts,tsx,js,jsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parser: tsParser,
      globals: {
        ...globals.es2021,
        console: "readonly",
      },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...js.configs.recommended.rules,
      "no-console": ["warn", { allow: ["warn","error","info"] }],
      "no-unused-vars": "off",
      "no-undef": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  { // Browser globals for SPA
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        JSX: "readonly",
      },
    },
  },
  { // Worker globals
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.serviceworker,
        fetch: "readonly",
        Response: "readonly",
        Request: "readonly",
        Headers: "readonly",
        URL: "readonly",
        crypto: "readonly",
        TextEncoder: "readonly",
        D1Database: "readonly",
        KVNamespace: "readonly",
        R2Bucket: "readonly",
        Queue: "readonly",
        DurableObjectNamespace: "readonly",
        DurableObjectState: "readonly",
        MessageBatch: "readonly",
        ExecutionContext: "readonly",
      },
    },
  },
];
