import { plugin as shadcn } from "@shadcn/lint"
import { defineConfig, globalIgnores } from "eslint/config"
import react from "eslint-plugin-react"
import hooks from "eslint-plugin-react-hooks"
import accessibility from "eslint-plugin-jsx-a11y"
import imports from "eslint-plugin-import"
import tseslint from "typescript-eslint"
import globals from "globals"

const eslintConfig = defineConfig([
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,jsx,mjs,ts,tsx}"],
    plugins: { react, "react-hooks": hooks, "jsx-a11y": accessibility, import: imports, shadcn },
    languageOptions: { globals: { ...globals.browser, ...globals.node, Bun: "readonly" } },
    settings: { react: { version: "detect" } },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs["jsx-runtime"].rules,
      ...hooks.configs.recommended.rules,
      "import/no-anonymous-default-export": "warn",
      "jsx-a11y/alt-text": "warn",
      "jsx-a11y/aria-props": "warn",
      "jsx-a11y/aria-proptypes": "warn",
      "jsx-a11y/aria-unsupported-elements": "warn",
      "jsx-a11y/role-has-required-aria-props": "warn",
      "jsx-a11y/role-supports-aria-props": "warn",
      "shadcn/no-restyle": ["error", { allow: ["layout"] }],
      "shadcn/no-raw-colors": "error",
      "shadcn/no-arbitrary-values": ["error", { allow: ["layout"] }],
      "shadcn/no-inline-styles": "error",
      "shadcn/require-static-classes": "error",
    },
  },
  {
    files: ["src/components/ui/**"],
    rules: {
      "shadcn/no-restyle": "off",
      "shadcn/no-arbitrary-values": "off",
      "shadcn/require-static-classes": "off",
    },
  },
  {
    files: ["src/components/**", "src/pages/**", "src/App.tsx", "src/frontend.tsx"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["@/server/**", "@/lib/auth", "@/lib/store", "@/lib/analytics", "@/lib/local-db", "@/lib/local-redis", "@/lib/credential-secrets", "@/lib/background-tasks", "bun", "node:*"], message: "Browser code must access server resources through HTTP APIs." },
        ],
      }],
    },
  },
  globalIgnores(["dist/**", "coverage/**", "playwright-report/**", "test-results/**"]),
])

export default eslintConfig
