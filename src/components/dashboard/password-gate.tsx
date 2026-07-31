"use client"

import type { ReactNode } from "react"
import useSWR from "swr"
import { toast } from "sonner"

import { PasswordDialog } from "@/components/dashboard/password-dialog"
import { apiPost } from "@/components/dashboard/api"
import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"

type AccountResponse = { username: string; mustChangePassword: boolean }

export function DashboardPasswordGate({ children }: { children: ReactNode }) {
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

  if (!data && !error) return <DashboardContentSkeleton />

  return <>
    {children}
    {data?.mustChangePassword && <PasswordDialog open onSave={savePassword} />}
  </>
}
