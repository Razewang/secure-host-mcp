import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "release/**", "coverage/**", ".trellis/**", ".agents/**", ".codex/**", "eslint.config.js", "scripts/*.mjs"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-namespace": "off",
      "@typescript-eslint/require-await": "off"
    }
  },
  {
    ...tseslint.configs.disableTypeChecked,
    files: ["web/**/*.js"],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        document: "readonly",
        navigator: "readonly",
        fetch: "readonly",
        setTimeout: "readonly"
      }
    }
  }
);
