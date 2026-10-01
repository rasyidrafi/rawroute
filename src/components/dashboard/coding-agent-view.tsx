import { useSyncExternalStore } from "react"
import { CopyIcon } from "lucide-react"
import { useDashboardClipboard } from "@/hooks/use-dashboard-clipboard"

import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

const subscribe = () => () => {}
const getOrigin = () => window.location.origin
const getServerOrigin = () => "[DETECT GATEWAY BASE URL]"

export function CodingAgentView({ agent }: { agent: "Codex" | "Opencode" | "Claude Code" }) {
  const copy = useDashboardClipboard()
  const origin = useSyncExternalStore(subscribe, getOrigin, getServerOrigin)
  const config = `model_provider = "rawroute"
model = "gpt-6-luna"
model_reasoning_effort = "xhigh"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.rawroute]
name = "Rawroute"
base_url = "${origin}/v1"
wire_api = "responses"
experimental_bearer_token="PUT_TOKEN_HERE"

[agents]
enabled = false`

  async function copyConfig() {
    await copy(config, "Codex configuration copied")
  }

  return <div className="flex flex-1 flex-col gap-4 p-4 lg:p-6">
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>{agent}</CardTitle>
        <CardDescription>{agent === "Codex" ? <>Add this to <code>~/.codex/config.toml</code> and replace <code>PUT_TOKEN_HERE</code> with your gateway API key.</> : "Under Construction"}</CardDescription>
        {agent === "Codex" && <CardAction><Button variant="outline" size="sm" onClick={copyConfig}><CopyIcon />Copy configuration</Button></CardAction>}
      </CardHeader>
      {agent === "Codex" && <CardContent><pre className="overflow-x-auto rounded-lg border bg-muted/30 p-4 text-sm leading-relaxed"><code>{config}</code></pre></CardContent>}
    </Card>
  </div>
}
