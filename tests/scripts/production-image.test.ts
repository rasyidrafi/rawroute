import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

type Step = { name?: string; uses?: string; run?: string; if?: string }
type Workflow = {
  on: { push: { branches: string[] }; pull_request: { branches: string[]; "paths-ignore"?: string[] }; pull_request_target?: unknown }
  permissions: { contents: string }
  concurrency: { group: string; "cancel-in-progress": string }
  jobs: { build: { if?: string; steps: Step[] } }
}

const workflow = Bun.YAML.parse(readFileSync(new URL("../../.github/workflows/production-image.yml", import.meta.url), "utf8")) as Workflow

test("pull requests run complete checks without path-filtered pending checks", () => {
  expect(workflow.on.pull_request.branches).toContain("main")
  expect(workflow.on.pull_request["paths-ignore"]).toBeUndefined()
  expect(workflow.on.pull_request_target).toBeUndefined()
  expect(workflow.permissions.contents).toBe("read")
  expect(workflow.jobs.build.if).toBeUndefined()
  for (const command of ["bun run lint", "bun run test", "bun run typecheck", "bun run test:e2e"]) {
    const step = workflow.jobs.build.steps.find(step => step.run === command)
    expect(step).toBeDefined()
    expect(step?.if).toBeUndefined()
  }
})

test("registry credentials and image build/publication are restricted to non-PR main runs", () => {
  const steps = workflow.jobs.build.steps
  const login = steps.findIndex(step => step.uses === "docker/login-action@v3")
  const build = steps.findIndex(step => step.name === "Build production image")
  const publish = steps.findIndex(step => step.name === "Publish to Docker Hub")
  expect(login).toBeGreaterThan(steps.findIndex(step => step.run === "bun run test:e2e"))
  expect(build).toBeGreaterThan(login)
  expect(publish).toBeGreaterThan(build)
  for (const index of [login, build, publish]) {
    expect(steps[index]?.if).toBe("github.event_name != 'pull_request' && github.ref == 'refs/heads/main'")
  }
  expect(steps.filter(step => step.run?.includes("docker push"))).toHaveLength(1)
})

test("new PR runs supersede old PR checks without cancelling main image publication", () => {
  expect(workflow.concurrency.group).toContain("github.event.pull_request.number || github.ref")
  expect(workflow.concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}")
})
