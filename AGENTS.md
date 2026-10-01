# Bun full-stack React

The server entry is `src/index.ts`; `src/index.html` loads `src/frontend.tsx` and
`src/App.tsx`. Use native Bun routing and HTML bundling. Keep browser code free
of server imports and secrets. API routes must declare their access policy in
`src/server/routes.ts`; workspace handlers execute inside `runInWorkspace`.

Declare dashboard page scope in `src/lib/dashboard/routes.ts`. Workspace UI code
uses `useDashboardApi()`; standalone dashboard API exports are global clients.
Record server events through `src/server/logging/recorder.ts` and its event catalog.
See `docs/scopes-and-logging.md` for scope, cache and logging conventions.

CLIProxy lifecycle lives in `src/server/cliproxy/`; use its shared connection
and mutation boundaries instead of reading transport secrets or spawning a child
from feature handlers. See `docs/managed-cliproxy.md` for migration and ownership.

Consult `.agents/skills/ask-bun/SKILL.md` and its script for Bun-specific guidance.
`bun run build` bundles the app; TypeScript checks run separately with
`bun run typecheck`.

After making changes, run `bun run lint` and fix all errors and warnings.
Fix violations in source; do not disable rules, add suppressions, or broaden allowances to make lint pass.
