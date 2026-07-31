"use client"

import { LockKeyholeIcon } from "lucide-react"
import { toast } from "sonner"

import { ChangePasswordForm } from "@/components/dashboard/change-password-form"
import { apiPost } from "@/components/dashboard/api"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export function SettingsView() {
  async function updatePassword(currentPassword: string, newPassword: string, confirmPassword: string) {
    try {
      await apiPost("/api/admin/account/password", { currentPassword, newPassword, confirmPassword })
      toast.success("Password updated")
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
      return false
    }
  }
  return <main className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8">
    <div className="mx-auto flex max-w-7xl flex-col gap-8">
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><LockKeyholeIcon className="size-5" />Admin password</CardTitle>
          <CardDescription>Confirm your current password before choosing a new one.</CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm onSave={updatePassword} />
        </CardContent>
      </Card>
    </div>
  </main>
}