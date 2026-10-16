import type { ComponentType, SVGProps } from "react"
import { pagePaths } from "@/lib/dashboard/routes"
import { AnthropicLogo, ContinueLogo, CursorLogo, OpenAILogo, OpenCodeLogo } from "./logos"

export type Integration = {
  name: string
  category: string
  description: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
  href?: string
}

export const integrations: Integration[] = [
  { name: "OpenCode", category: "Terminal & editor", description: "Bring your workspace models into an open-source coding agent with a custom provider.", icon: OpenCodeLogo, href: pagePaths.integrationOpencode },
  { name: "Codex", category: "Terminal", description: "Connect OpenAI’s coding agent to RawRoute through the Responses API.", icon: OpenAILogo, href: pagePaths.integrationCodex },
  { name: "Claude Code", category: "Terminal", description: "Use your gateway with Claude Code’s Anthropic-compatible connection settings.", icon: AnthropicLogo },
  { name: "Cursor", category: "Editor", description: "Configure a custom OpenAI-compatible base URL for your coding workflow.", icon: CursorLogo },
  { name: "Continue", category: "Editor", description: "Connect your editor assistant to models available through your workspace.", icon: ContinueLogo },
  { name: "OpenAI-compatible apps", category: "Universal", description: "Use a shared base URL and gateway key with compatible clients and SDKs.", icon: OpenAILogo },
]

export type IntegrationGuideId = "opencode" | "codex"

export const integrationGuides = {
  opencode: {
    name: "OpenCode",
    icon: OpenCodeLogo,
    category: "Terminal & editor",
    description: "One custom provider for your workspace models. Configure OpenCode, choose a model, and start a coding session.",
    configPath: "~/.config/opencode/opencode.json",
    protocol: "Chat Completions",
    steps: [
      { title: "Get a workspace key", description: "Create or copy a gateway key from Endpoint & Key in the workspace you want to use." },
      { title: "Add the RawRoute provider", description: "Merge the provider configuration into your OpenCode config, keeping your existing settings." },
      { title: "Choose your model", description: "Replace YOUR_MODEL_ID with a model or alias from Model routing that supports Chat Completions." },
      { title: "Set your key and launch", description: "Export RAWROUTE_API_KEY in your terminal, then open OpenCode and select the RawRoute model." },
    ],
  },
  codex: {
    name: "Codex",
    icon: OpenAILogo,
    category: "Terminal",
    description: "Route your Codex sessions through RawRoute with a custom provider and a workspace gateway key.",
    configPath: "~/.codex/config.toml",
    protocol: "Responses",
    steps: [
      { title: "Get a workspace key", description: "Create or copy a gateway key from Endpoint & Key in the workspace you want to use." },
      { title: "Define your provider", description: "Merge the RawRoute provider into config.toml and select it as your model provider." },
      { title: "Check your model", description: "The configuration uses gpt-6-luna with xhigh reasoning. Make sure this model is available in your workspace routing." },
      { title: "Set your key and launch", description: "Replace PUT_TOKEN_HERE in config.toml with your workspace gateway key, then start a new Codex session." },
    ],
  },
} as const

export function integrationSnippets(id: IntegrationGuideId, baseUrl: string) {
  const config = id === "opencode"
    ? JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "rawroute/workspace-model",
      providers: {
        rawroute: {
          env: ["RAWROUTE_API_KEY"],
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: baseUrl },
          models: { "workspace-model": { modelID: "YOUR_MODEL_ID" } },
        },
      },
    }, null, 2)
    : `model_provider = "rawroute"
model = "gpt-6-luna"
model_reasoning_effort = "xhigh"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.rawroute]
name = "Rawroute"
base_url = ${JSON.stringify(baseUrl)}
wire_api = "responses"
experimental_bearer_token="PUT_TOKEN_HERE"

[agents]
enabled = false`

  if (id === "codex") return [
    { title: "Provider configuration", filename: "config.toml", language: "TOML", description: "Add this to ~/.codex/config.toml and replace PUT_TOKEN_HERE with your gateway API key.", code: config },
  ]

  return [
    { title: "Provider configuration", filename: "opencode.json", language: "JSON", description: "Merge this example into your config and replace YOUR_MODEL_ID with your gateway model ID.", code: config },
    { title: "Workspace API key", filename: "Terminal", language: "Shell", description: "Replace the placeholder with your workspace gateway key. Run in the same terminal as your client.", code: 'export RAWROUTE_API_KEY="YOUR_WORKSPACE_API_KEY"' },
  ]
}
