"use client"

import Link from "next/link"

import { dashboardApps } from "@/components/dashboard/dashboard-apps"
import { useToolGatewayStatus } from "@/components/dashboard/tool-gateway-status"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

type ToolGatewayPage = "overview" | "tools" | "connections" | "policies" | "activity" | "settings"

const pageCopy: Record<Exclude<ToolGatewayPage, "overview">, { title: string; description: string }> = {
  tools: {
    title: "Tools",
    description: "Tool inventory and configuration remain available through the Executor API; RawRoute does not expose a browser manager in this deployment.",
  },
  connections: {
    title: "Connections",
    description: "Connections and integrations are managed by Executor through its API. This dashboard does not create or edit them.",
  },
  policies: {
    title: "Policies",
    description: "Executor policy management is API-only here. No workspace-scoped policy controls are available in RawRoute.",
  },
  activity: {
    title: "Activity",
    description: "RawRoute does not query Executor for activity or logs, so this page intentionally shows no status or event data.",
  },
  settings: {
    title: "Settings",
    description: "Executor deployment settings are server configuration and are not displayed in the dashboard.",
  },
}

export function ToolGatewayView({ page }: { page: ToolGatewayPage }) {
  const { data, error } = useToolGatewayStatus()
  const state = error ? "unavailable" : data?.state
  const available = state === "available"
  const statusLabel = state === "available" ? "Available" : state === "disabled" ? "Not configured" : state === "unavailable" ? "Unavailable" : "Checking"
  const statusVariant = state === "available" ? "default" : state === "unavailable" ? "destructive" : "secondary"
  const statusDescription = state === "disabled"
    ? "Executor is not configured. Enable the optional Executor service and configure its server-side API key to use this gateway."
    : state === "unavailable"
      ? "Executor is configured but is not reachable. The Tool Gateway will remain disabled until the service becomes healthy."
      : "Checking the optional Executor service."
  const toolNavigation = dashboardApps[1].navigation[0].items

  return <main className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8">
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2"><CardTitle>Executor integration</CardTitle><Badge variant={statusVariant}>{statusLabel}</Badge><Badge variant="secondary">API-only</Badge><Badge variant="outline">Shared deployment</Badge></div>
          <CardDescription>RawRoute exposes Executor only through its authenticated public API proxy. Executor&apos;s browser UI, OAuth callbacks, and MCP endpoints are not available here.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {available ? <>
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-xs font-medium text-muted-foreground">Public proxy base</p>
              <code className="mt-1 block text-sm">/executor/api</code>
            </div>
            <p className="text-sm text-muted-foreground">This is a shared Executor deployment. Switching RawRoute workspaces does not isolate Executor tools, connections, integrations, policies, or activity.</p>
          </> : <div role="status" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{statusDescription}</div>}
        </CardContent>
      </Card>

      {available && (page === "overview" ? <Card>
        <CardHeader>
          <CardTitle>Tool Gateway overview</CardTitle>
          <CardDescription>Use the API proxy with a RawRoute gateway key. This dashboard provides deployment context only and does not report live Executor state.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {toolNavigation.filter((item) => item.href !== "/dashboard/tool-gateway").map((item) => <Link key={item.href} href={item.href} className="rounded-lg border bg-muted/20 p-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <div className="flex items-center gap-2 font-medium"><item.icon className="size-4" />{item.title}</div>
            <p className="mt-1 text-sm text-muted-foreground">View current API-only availability.</p>
          </Link>)}
        </CardContent>
      </Card> : <Card>
        <CardHeader>
          <CardTitle>{pageCopy[page].title}</CardTitle>
          <CardDescription>{pageCopy[page].description}</CardDescription>
        </CardHeader>
        <CardContent><div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No workspace-scoped Executor data is shown in RawRoute.</div></CardContent>
      </Card>)}
    </div>
  </main>
}
