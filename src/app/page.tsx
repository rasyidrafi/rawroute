import Link from "next/link"

import { UsageView } from "@/components/dashboard/usage-view"

export default function Home() {
  return <><header className="border-b bg-background/90 px-4 py-3"><div className="mx-auto flex max-w-7xl items-center justify-between"><div><div className="font-semibold">RawRoute</div><div className="text-xs text-muted-foreground">Public gateway analytics</div></div><Link className="text-sm font-medium underline-offset-4 hover:underline" href="/login">Admin login</Link></div></header><UsageView publicView /></>
}
