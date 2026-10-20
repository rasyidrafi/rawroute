import { expect, test } from "bun:test";

test("CLIProxy lifecycle fixture is isolated from the production listener", async () => {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("fixture port reservation"),
  });
  const port = reservation.port;
  reservation.stop();
  const child = Bun.spawn([process.execPath, "test", "./service.fixture.ts"], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      NODE_ENV: "test",
      RAWROUTE_CLIPROXY_TEST_PORT: String(port),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, `CLIProxy lifecycle fixture failed.\n${stdout}\n${stderr}`).toBe(0);
}, 90_000);
