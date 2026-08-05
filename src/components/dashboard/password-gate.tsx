"use client"

import type { ReactNode } from "react"
import { usePathname } from "next/navigation"
import useSWR from "swr"
import { toast } from "sonner"

import { PasswordDialog } from "@/components/dashboard/password-dialog"
import { apiPost } from "@/components/dashboard/api"
import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"

type AccountResponse = { username: string; mustChangePassword: boolean }

function loadingVariant(pathname: string) {
  if (pathname === "/dashboard/providers") return "providers" as const
  if (pathname.startsWith("/dashboard/providers/")) return "provider-detail" as const
  if (pathname === "/dashboard/aliases") return "aliases" as const
  if (pathname === "/dashboard/usage") return "usage" as const
  if (pathname === "/dashboard/budgets") return "budgets" as const
  if (pathname === "/dashboard/model-pricing") return "model-pricing" as const
  if (pathname === "/dashboard/logs") return "console-log" as const
  if (pathname === "/dashboard/settings") return "settings" as const
  return "endpoint-key" as const
}

export function DashboardPasswordGate({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const { data, error, mutate } = useSWR<AccountResponse>("/api/admin/account")

  async function savePassword(password: string) {
    try {
      await apiPost("/api/admin/account/password", { password })
      await mutate()
      toast.success("Password changed")
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to change password")
      return false
    }
  }

  if (!data && !error) {
    return <DashboardContentSkeleton variant={loadingVariant(pathname)} />
  }

  return <>
    {children}
    {data?.mustChangePassword && <PasswordDialog open onSave={savePassword} />}
  </>
}
