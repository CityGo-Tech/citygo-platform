import eslint from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/.next/**",
      "**/coverage/**",
      "**/dist/**",
      "**/node_modules/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/web/**/*.{ts,tsx}", "apps/admin/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "@next/next": nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },
  {
    files: [
      "apps/api/**/*.ts",
      "apps/worker/**/*.ts",
      "packages/**/*.{js,mjs,ts}",
      "scripts/**/*.mjs",
      "e2e/**/*.ts",
      "playwright.config.ts",
    ],
    languageOptions: { globals: globals.node },
  },
);
