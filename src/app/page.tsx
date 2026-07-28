"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

import { LoadingSpinner } from "@/components/loading-spinner"

export default function Home() {
  const router = useRouter()
  useEffect(() => {
    void fetch("/api/admin/state", { cache: "no-store" })
      .then((response) => router.replace(response.ok ? "/dashboard" : "/login"))
      .catch(() => router.replace("/login"))
  }, [router])
  return <main className="grid min-h-svh place-items-center" aria-label="Loading application"><LoadingSpinner className="size-6" /></main>
}
