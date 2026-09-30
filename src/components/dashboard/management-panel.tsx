"use client"

import { RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { LoadingSpinner } from "@/components/loading-spinner"

export function sanitizeNonNegativeDraft(value: string) {
  return value.includes("-") ? "0" : value
}

export function Panel({ title, description, icon, refresh, loading, children }: { title: string; description: string; icon: React.ReactNode; refresh: () => void; loading?: boolean; children: React.ReactNode }) {
  return <main className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8"><div className="mx-auto flex max-w-7xl flex-col gap-6"><Card><CardHeader><CardTitle className="flex items-center gap-2">{icon}{title}</CardTitle><CardDescription>{description}</CardDescription><CardAction><Button aria-busy={loading} variant="outline" onClick={refresh} disabled={loading}>{loading ? <LoadingSpinner /> : <RefreshCwIcon />}Refresh</Button></CardAction></CardHeader><CardContent className="space-y-4">{children}</CardContent></Card></div></main>
}
