import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Flat ESLint config for the Omakei ledger editor. */
export default tseslint.config(
  {
    // `.claude/worktrees/` holds whole checkouts of this repo, so linting it
    // reports every problem a second time, against files nobody is editing.
    ignores: ["dist/**", "node_modules/**", ".claude/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // Every panel exports `meta` alongside its component: that pairing is the
    // panel contract, so the fast-refresh rule can never be satisfied here.
    files: ["src/panels/*.tsx"],
    rules: { "react-refresh/only-export-components": "off" },
  },
  {
    // Loaded by the QML JS engine, not by a bundler. Every function here is
    // reached from QML, so unused-symbol analysis reports only noise.
    files: ["Model.js"],
    languageOptions: { ecmaVersion: 5, sourceType: "script", globals: {} },
    rules: { "@typescript-eslint/no-unused-vars": "off" },
  },
  prettier,
);
