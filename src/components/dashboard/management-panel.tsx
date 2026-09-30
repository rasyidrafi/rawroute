"use client"

import { RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { LoadingSpinner } from "@/components/loading-spinner"

export function sanitizeNonNegativeDraft(value: string) {
  return value.includes("-") ? "0" : value
}

export function Panel({ title, description, icon, refresh, loading, children }: { title: string; description: string; icon: React.ReactNode; refresh: () => void; loading?: boolean; children: React.ReactNode }) {
  return <main className="flex-1 bg-workspace p-4 dark:bg-background md:p-6 lg:p-8"><div className="mx-auto flex max-w-7xl flex-col gap-6"><Card><CardHeader><CardTitle variant="icon">{icon}{title}</CardTitle><CardDescription>{description}</CardDescription><CardAction><Button aria-busy={loading} variant="outline" onClick={refresh} disabled={loading}>{loading ? <LoadingSpinner /> : <RefreshCwIcon />}Refresh</Button></CardAction></CardHeader><CardContent spacing="stack">{children}</CardContent></Card></div></main>
}
