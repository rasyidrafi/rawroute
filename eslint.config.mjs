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
    files: ["packages/ui/src/{alert-dialog,alert,avatar,badge,breadcrumb,button-group,button,calendar,card,chart,checkbox,command,dialog,drawer,dropdown-menu,empty-state,empty,field,input,label,popover,progress,scroll-area,select,separator,sheet,sidebar,skeleton,sonner,switch,table,tabs,textarea,toggle-group,toggle,tooltip}.tsx"],
    rules: {
      "shadcn/no-restyle": "off",
      "shadcn/no-arbitrary-values": "off",
      "shadcn/require-static-classes": "off",
    },
  },
  {
    files: ["packages/*/src/web/**", "packages/*/src/contracts/**", "packages/ui/src/**", "apps/console/src/frontend/**"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["@rawroute/*/server", "@rawroute/*/server/**", "bun", "bun:*", "node:*"], message: "Browser code must access server resources through HTTP APIs." },
        ],
      }],
    },
  },
  {
    files: ["packages/platform/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{ group: ["@rawroute/console", "@rawroute/gateway-*"], message: "Platform cannot depend on gateways or console composition." }],
      }],
    },
  },
  globalIgnores(["dist/**", "coverage/**", "playwright-report/**", "test-results/**"]),
])

export default eslintConfig
