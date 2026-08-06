import { listWorkspaces } from "@/lib/workspaces"

export async function GET() {
  const workspaces = (await listWorkspaces())
    .filter((workspace) => workspace.status === "active")
    .map(({ id, name, isDefault }) => ({ id, name, isDefault }))
  return Response.json({ workspaces }, { headers: { "cache-control": "public, max-age=5, s-maxage=5, stale-while-revalidate=30" } })
}
