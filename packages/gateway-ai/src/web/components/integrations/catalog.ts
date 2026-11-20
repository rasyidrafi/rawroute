import type { ComponentType, SVGProps } from "react"
import { aiPagePaths as pagePaths } from "../../../contracts/pages"
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
    configHint: "Replace YOUR_MODEL_ID with a workspace model or alias that supports Chat Completions.",
    launchHint: "Replace the placeholder with your workspace key. Run the command, then launch OpenCode in the same terminal and select the RawRoute model.",
  },
  codex: {
    name: "Codex",
    icon: OpenAILogo,
    category: "Terminal",
    description: "Route your Codex sessions through RawRoute with a custom provider and a workspace gateway key.",
    configPath: "~/.codex/config.toml",
    configHint: "Replace PUT_TOKEN_HERE with your workspace key and choose a model that supports Responses. This example disables sandboxing and approval prompts; keep your existing security settings unless you intend to change them.",
    launchHint: "Save the file, then start a new Codex session to load the RawRoute provider.",
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
