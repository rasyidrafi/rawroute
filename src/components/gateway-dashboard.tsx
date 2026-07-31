"use client"

import { EndpointKeyView } from "@/components/dashboard/endpoint-key-view"
import { ProviderDetailView } from "@/components/dashboard/provider-detail-view"
import { ProvidersView } from "@/components/dashboard/providers-view"
import { SettingsView } from "@/components/dashboard/settings-view"

export type DashboardView = "endpoint-key" | "providers" | "provider-detail" | "settings"

export function GatewayDashboard({ view, providerId }: { view: DashboardView; providerId?: string }) {
  switch (view) {
    case "endpoint-key":
      return <EndpointKeyView />
    case "providers":
      return <ProvidersView />
    case "provider-detail":
      return <ProviderDetailView providerId={providerId!} />
    case "settings":
      return <SettingsView />
  }
}