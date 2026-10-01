import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  areAllLoopbackListeners,
  CLIPROXY_LOCK_TIMING,
  CLIPROXY_HOST,
  CLIPROXY_PORT,
  getDataRoot,
  getStartupAction,
  parseListeningSockets,
  parseProcStartTime,
  renderConfig,
  shouldStartAfterInstall,
  validateLoopbackConfig,
} from "./service";

const FIXTURE_SCENARIO_TIMEOUT_MS = 30_000;
const FIXTURE_CLEANUP_TIMEOUT_MS = 5_000;
const FIXTURE_TEST_TIMEOUT_MS = 45_000;
const FIXTURE_TIMEOUT_REGRESSION_TEST_TIMEOUT_MS = 20_000;

function waitForSignal<T>(signal: Promise<T>, description: string, timeoutMs = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), timeoutMs);
    void signal.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function observeFileDuringWindow(
  filePath: string,
  durationMs: number
): Promise<"file-created" | "window-elapsed"> {
  return new Promise((resolve) => {
    const deadline = Date.now() + durationMs;
    const observe = () => {
      if (fs.existsSync(filePath)) {
        resolve("file-created");
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        resolve("window-elapsed");
        return;
      }
      setTimeout(observe, Math.min(25, remaining));
    };
    observe();
  });
}

function waitForProcessExit(
  child: Bun.Subprocess,
  description: string,
  timeoutMs: number
): Promise<number> {
  return waitForSignal(child.exited, description, timeoutMs);
}

async function terminateFixtureProcessGroup(child: Bun.Subprocess): Promise<void> {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The process group is already gone when the fixture cleaned up normally.
  }
  if (child.exitCode === null) {
    await waitForProcessExit(child, "fixture process group cleanup", FIXTURE_CLEANUP_TIMEOUT_MS);
  }
}

async function waitForFixturePortRelease(): Promise<void> {
  const deadline = Date.now() + FIXTURE_CLEANUP_TIMEOUT_MS;
  for (;;) {
    try {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: CLIPROXY_PORT,
        fetch: () => new Response("ok"),
      });
      server.stop();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function removeFixtureRoot(root: string): void {
  const makeDirectoriesWritable = (directory: string) => {
    fs.chmodSync(directory, 0o700);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        makeDirectoriesWritable(path.join(directory, entry.name));
      }
    }
  };
  makeDirectoriesWritable(root);
  fs.rmSync(root, { recursive: true, force: true });
}

let fixtureRoot: string | undefined;
let fixtureExecutable: string | undefined;
let failingFixtureExecutable: string | undefined;

function getFixtureExecutable(failing = false): string {
  const cached = failing ? failingFixtureExecutable : fixtureExecutable;
  if (cached) return cached;
  fixtureRoot ??= fs.mkdtempSync(path.join(os.tmpdir(), "cliproxy-transaction-fixture-"));
  const fixtureName = failing ? "failing-fixture" : "fixture";
  const sourcePath = path.join(fixtureRoot, `${fixtureName}.ts`);
  const executablePath = path.join(fixtureRoot, `cli-proxy-api-${fixtureName}`);
  fs.writeFileSync(
    sourcePath,
    `
      import * as fs from "node:fs";

      const signalPath = process.env.CLIPROXY_FIXTURE_SIGNAL_PATH;
      const readyPath = process.env.CLIPROXY_FIXTURE_READY_PATH;
      const observedCurrentPath = process.env.CLIPROXY_FIXTURE_OBSERVED_CURRENT_PATH;
      const launchDirectory = process.env.CLIPROXY_FIXTURE_LAUNCH_DIRECTORY;
      const healthRequestPath = process.env.CLIPROXY_FIXTURE_HEALTH_REQUEST_PATH;
      const failHealthAndRebind = process.env.CLIPROXY_FIXTURE_FAIL_HEALTH_AND_REBIND === "1";
      const exitAfterLaunch = Number.parseInt(
        process.env.CLIPROXY_FIXTURE_EXIT_AFTER_LAUNCH ?? "",
        10
      );
      const exitAfterHealthyMs = Number.parseInt(
        process.env.CLIPROXY_FIXTURE_EXIT_AFTER_HEALTHY_MS ?? "",
        10
      );
      let launchCount = 0;
      if (launchDirectory) {
        fs.mkdirSync(launchDirectory, { recursive: true });
        fs.writeFileSync(
          \`\${launchDirectory}/\${process.pid}-\${Date.now()}\`,
          "started"
        );
        launchCount = fs.readdirSync(launchDirectory).length;
      }
      if (Number.isSafeInteger(exitAfterLaunch) && launchCount > exitAfterLaunch) process.exit(1);
      let server: ReturnType<typeof Bun.serve>;
      const serve = (hostname: string) => Bun.serve({
        hostname,
        port: Number.parseInt(process.env.RAWROUTE_CLIPROXY_TEST_PORT ?? "", 10),
        fetch: (request) => {
          if (new URL(request.url).pathname === "/v1/models" && failHealthAndRebind) {
            if (healthRequestPath) fs.writeFileSync(healthRequestPath, "requested");
            setTimeout(() => {
              server.stop();
              server = serve("0.0.0.0");
            }, 0);
            return new Response("unhealthy", { status: 503 });
          }
          return Response.json({ data: [] });
        },
      });
       server = serve(${JSON.stringify(failing ? "0.0.0.0" : "127.0.0.1")});
       if (readyPath) fs.writeFileSync(readyPath, "ready");
       if (Number.isSafeInteger(exitAfterHealthyMs) && exitAfterHealthyMs >= 0) {
         setTimeout(() => {
           server.stop();
           process.exit(1);
         }, exitAfterHealthyMs);
       }
       process.on("SIGTERM", () => {
        if (signalPath) {
          let currentTarget = null;
          try {
            if (observedCurrentPath) currentTarget = fs.readlinkSync(observedCurrentPath);
          } catch {}
          fs.writeFileSync(signalPath, JSON.stringify({ signal: "SIGTERM", currentTarget }));
        }
        server.stop();
        process.exit(0);
      });
    `
  );
  const build = Bun.spawnSync(
    [process.execPath, "build", "--compile", sourcePath, "--outfile", executablePath],
    { stdout: "pipe", stderr: "pipe" }
  );
  if (build.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(build.stderr));
  }
  if (failing) failingFixtureExecutable = executablePath;
  else fixtureExecutable = executablePath;
  return executablePath;
}

function serviceFixturePrelude(dataRoot: string, executable: string): string {
  return `
    import * as fs from "node:fs";
    import * as path from "node:path";

    const dataRoot = ${JSON.stringify(dataRoot)};
    const serviceRoot = path.join(dataRoot, "cliproxy");
    const versionsRoot = path.join(serviceRoot, "versions");
    const currentPath = path.join(serviceRoot, "current");
    const statePath = path.join(serviceRoot, "state.json");
    const transactionPath = path.join(serviceRoot, "update-transaction.json");
    const cliproxyPort = Number.parseInt(process.env.RAWROUTE_CLIPROXY_TEST_PORT ?? "", 10);
    const fixtureExecutable = ${JSON.stringify(executable)};
    const installVersion = (version) => {
      const versionRoot = path.join(versionsRoot, version);
      fs.mkdirSync(versionRoot, { recursive: true });
      fs.copyFileSync(fixtureExecutable, path.join(versionRoot, "cli-proxy-api"));
      fs.chmodSync(path.join(versionRoot, "cli-proxy-api"), 0o555);
    };
    const writeState = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
    const readState = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
    const currentVersion = () => fs.readlinkSync(currentPath).slice("versions/".length);
    const setCurrent = (version) => fs.symlinkSync(path.join("versions", version), currentPath);
    const identityFor = (pid) => {
      const stat = fs.readFileSync(\`/proc/\${pid}/stat\`, "utf8");
      const startTime = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\\s+/)[19];
      return { startTime, executablePath: fs.realpathSync(\`/proc/\${pid}/exe\`) };
    };
    const waitForFile = async (filePath) => {
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(filePath)) {
        if (Date.now() >= deadline) throw new Error(\`Timed out waiting for \${filePath}\`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const waitForCondition = async (condition, description, timeoutMs = 5_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!condition()) {
        if (Date.now() >= deadline) throw new Error(\`Timed out waiting for \${description}\`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const waitForAsyncCondition = async (condition, description, timeoutMs = 5_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!(await condition())) {
        if (Date.now() >= deadline) throw new Error(\`Timed out waiting for \${description}\`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const noNewLaunches = async (directory, knownLaunches, durationMs) => {
      const deadline = Date.now() + durationMs;
      while (Date.now() < deadline) {
        if (fs.readdirSync(directory).length !== knownLaunches) return false;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return fs.readdirSync(directory).length === knownLaunches;
    };
    const spawnFixture = (version, readyPath, signalPath, observedCurrentPath) => Bun.spawn(
      [path.join(versionsRoot, version, "cli-proxy-api"), "-config", "ignored"],
      {
        env: {
          ...process.env,
          CLIPROXY_FIXTURE_READY_PATH: readyPath,
          CLIPROXY_FIXTURE_SIGNAL_PATH: signalPath,
          CLIPROXY_FIXTURE_OBSERVED_CURRENT_PATH: observedCurrentPath,
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }
    );
    const writeChildRecord = (child, version) => fs.writeFileSync(
      path.join(serviceRoot, "child.json"),
      JSON.stringify({
        pid: child.pid,
        ...identityFor(child.pid),
        version,
        managerPid: 0,
        managerStartTime: "",
        managerExecutablePath: "",
        startedAt: new Date().toISOString(),
      })
    );
    process.env.RAWROUTE_DATA_DIR = dataRoot;
  `;
}

interface FixtureScenarioContext {
  dataRoot: string;
  root: string;
  executable: string;
  moduleUrl: string;
}

interface FixtureScenarioOptions {
  timeoutMs?: number;
}

async function runFixtureScenario(
  createScript: (context: FixtureScenarioContext) => string,
  { timeoutMs = FIXTURE_SCENARIO_TIMEOUT_MS }: FixtureScenarioOptions = {}
): Promise<Record<string, unknown>> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cliproxy-transaction-test-"));
  const context: FixtureScenarioContext = {
    root,
    dataRoot: path.join(root, "data"),
    executable: getFixtureExecutable(),
    moduleUrl: new URL("./service.ts", import.meta.url).href,
  };
  const child = Bun.spawn([process.execPath, "-e", createScript(context)], {
    cwd: process.cwd(),
    env: { ...process.env, RAWROUTE_DATA_DIR: context.dataRoot },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });

  let result: Record<string, unknown> | undefined;
  let scenarioError: unknown;
  let cleanupError: unknown;
  try {
    const exitCode = await waitForProcessExit(
      child,
      "fixture scenario",
      timeoutMs
    );
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr || `Fixture process exited with ${exitCode}`);
    result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
  } catch (error) {
    scenarioError = error;
  } finally {
    try {
      await terminateFixtureProcessGroup(child);
    } catch (error) {
      cleanupError = error;
    }
    try {
      removeFixtureRoot(root);
    } catch (error) {
      cleanupError = cleanupError
        ? new AggregateError([cleanupError, error], "Fixture process cleanup and root removal failed")
        : error;
    }
  }
  if (scenarioError && cleanupError) {
    throw new AggregateError(
      [scenarioError, cleanupError],
      "Fixture scenario failed and its process group could not be reaped"
    );
  }
  if (scenarioError) throw scenarioError;
  if (cleanupError) throw cleanupError;
  return result as Record<string, unknown>;
}

afterAll(() => {
  if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("CLIProxy service helpers", () => {
  test("uses the configured persistent data root and the home default", () => {
    expect(getDataRoot("/data")).toBe("/data");
    expect(getDataRoot("")).toContain("/.local/share/rawroute");
  });

  test("renders the private loopback-only API and management config", () => {
    const config = renderConfig("api-secret-value", "management-secret-value", "/data/cliproxy/auth");
    expect(config).toContain(`host: "${CLIPROXY_HOST}"`);
    expect(config).toContain(`port: ${CLIPROXY_PORT}`);
    expect(config).toContain('  allow-remote: false');
    expect(config).toContain('  disable-control-panel: true');
    expect(config).toContain('  secret-key: "management-secret-value"');
    expect(config).toContain('  - "api-secret-value"');
    expect(config).toContain('auth-dir: "/data/cliproxy/auth"');
    expect(() => validateLoopbackConfig(config)).not.toThrow();
  });

  test("rejects persisted configs with a missing, duplicate, or non-loopback host", () => {
    expect(() => validateLoopbackConfig('host: "127.0.0.1" # safe\nport: 8317')).not.toThrow();
    expect(() => validateLoopbackConfig("host: 127.0.0.1\nport: 8317")).not.toThrow();
    expect(() => validateLoopbackConfig('host: "0.0.0.0"\nport: 8317')).toThrow(
      `host must be ${CLIPROXY_HOST}`
    );
    expect(() => validateLoopbackConfig("port: 8317")).toThrow("exactly one root host");
    expect(() =>
      validateLoopbackConfig('host: "127.0.0.1"\nhost: "0.0.0.0"\nport: 8317')
    ).toThrow("exactly one root host");
    expect(() =>
      validateLoopbackConfig('host: "127.0.0.1"\n"host": "0.0.0.0"\nport: 8317')
    ).toThrow("exactly one root host");
    expect(() => validateLoopbackConfig('"host": "0.0.0.0"\nport: 8317')).toThrow(
      `host must be ${CLIPROXY_HOST}`
    );
  });

  test("lock retries extend beyond stale recovery while heartbeat remains active", () => {
    const retryBudgetMs =
      CLIPROXY_LOCK_TIMING.retryAttempts * CLIPROXY_LOCK_TIMING.retryIntervalMs;
    expect(retryBudgetMs).toBeGreaterThanOrEqual(
      CLIPROXY_LOCK_TIMING.staleMs + CLIPROXY_LOCK_TIMING.recoveryMarginMs
    );
    expect(CLIPROXY_LOCK_TIMING.updateMs).toBeLessThanOrEqual(
      CLIPROXY_LOCK_TIMING.staleMs / 2
    );
  });

  test("fresh boot skips release fetching and reports an installed-but-missing desired service", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cliproxy-init-test-"));
    const moduleUrl = new URL("./service.ts", import.meta.url).href;
    const freshRoot = path.join(testRoot, "fresh");
    const script = `
      import * as fs from "node:fs";
      import * as path from "node:path";
      let fetchCalls = 0;
      globalThis.fetch = async () => { fetchCalls += 1; throw new Error("unexpected release fetch"); };
      const moduleUrl = ${JSON.stringify(moduleUrl)};
      process.env.RAWROUTE_DATA_DIR = ${JSON.stringify(freshRoot)};
      const service = await import(moduleUrl);
      await service.initCliproxy();
      const freshStatus = await service.getStatus();
      let startError = "";
      let restartError = "";
      try { await service.start(); } catch (error) { startError = error.message; }
      try { await service.restart(); } catch (error) { restartError = error.message; }
      const afterStartRestart = await service.getStatus();
      await service.shutdownCliproxy();

      fs.writeFileSync(path.join(${JSON.stringify(freshRoot)}, "cliproxy", "state.json"), JSON.stringify({
        schemaVersion: 1,
        desiredRunning: true,
        installedVersion: null,
        pinnedVersion: null,
      }));
      await service.initCliproxy();
      const missingStatus = await service.getStatus();
      await service.shutdownCliproxy();
      console.log(JSON.stringify({
        fetchCalls,
        fresh: {
          installed: freshStatus.installed,
          desiredRunning: freshStatus.desiredRunning,
          lastError: freshStatus.lastError,
        },
        startError,
        restartError,
        afterStartRestart: {
          installed: afterStartRestart.installed,
          desiredRunning: afterStartRestart.desiredRunning,
        },
        missing: {
          installed: missingStatus.installed,
          desiredRunning: missingStatus.desiredRunning,
          lastError: missingStatus.lastError,
        },
      }));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, RAWROUTE_DATA_DIR: freshRoot },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode, stderr).toBe(0);
      const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(result.fetchCalls).toBe(0);
      expect(result.fresh).toEqual({ installed: false, desiredRunning: false, lastError: null });
      expect(result.startError).toContain("install a version before starting");
      expect(result.restartError).toContain("install a version before restarting");
      expect(result.afterStartRestart).toEqual({ installed: false, desiredRunning: false });
      expect(result.missing.installed).toBe(false);
      expect(result.missing.desiredRunning).toBe(true);
      expect(result.missing.lastError).toContain("no version is installed");
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test("reaps a timed-out fixture process group before returning the timeout", async () => {
    await expect(
      runFixtureScenario(
        ({ dataRoot, executable, root }) => `
          ${serviceFixturePrelude(dataRoot, executable)}
          installVersion("1.2.3");
          const readyPath = path.join(${JSON.stringify(root)}, "hung-child-ready");
          spawnFixture("1.2.3", readyPath, "", currentPath);
          await waitForFile(readyPath);
          await new Promise(() => {});
        `,
        { timeoutMs: 1_000 }
      )
    ).rejects.toThrow("Timed out waiting for fixture scenario");

    await waitForFixturePortRelease();
  }, FIXTURE_TIMEOUT_REGRESSION_TEST_TIMEOUT_MS);

  test("commits initial install and update transactions without a release download", async () => {
    const result = await runFixtureScenario(({ dataRoot, executable, moduleUrl }) => `
      ${serviceFixturePrelude(dataRoot, executable)}
      installVersion("1.2.3");
      installVersion("1.2.4");
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith("http://127.0.0.1:" + cliproxyPort + "/")) {
          throw new Error("unexpected release download");
        }
        return nativeFetch(input, init);
      };
      const service = await import(${JSON.stringify(moduleUrl)});
      const initialVersion = await service.install("1.2.3");
      const initial = {
        version: currentVersion(),
        state: readState(),
        markerPresent: fs.existsSync(transactionPath),
      };
      const updatedVersion = await service.install("1.2.4");
      const updatedStatus = await service.getStatus();
      const updated = {
        version: currentVersion(),
        state: readState(),
        markerPresent: fs.existsSync(transactionPath),
        childVersion: JSON.parse(fs.readFileSync(path.join(serviceRoot, "child.json"), "utf8")).version,
        healthy: updatedStatus.healthy,
      };
      await service.shutdownCliproxy();
      console.log(JSON.stringify({ initialVersion, initial, updatedVersion, updated }));
    `);

    expect(result.initialVersion).toBe("1.2.3");
    expect(result.initial).toEqual({
      version: "1.2.3",
      state: {
        schemaVersion: 1,
        desiredRunning: true,
        installedVersion: "1.2.3",
        pinnedVersion: "1.2.3",
      },
      markerPresent: false,
    });
    expect(result.updatedVersion).toBe("1.2.4");
    expect(result.updated).toEqual({
      version: "1.2.4",
      state: {
        schemaVersion: 1,
        desiredRunning: true,
        installedVersion: "1.2.4",
        pinnedVersion: "1.2.4",
      },
      markerPresent: false,
      childVersion: "1.2.4",
      healthy: true,
    });
  }, FIXTURE_TEST_TIMEOUT_MS);

  test("stages a verified fixture archive and preserves the committed version on archive failure", async () => {
    const result = await runFixtureScenario(({ dataRoot, executable, moduleUrl }) => `
      ${serviceFixturePrelude(dataRoot, executable)}
      const { createHash } = await import("node:crypto");
      const arch = process.arch === "x64" ? "amd64" : "aarch64";
      const releaseUrl = "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/tags/";
      const downloadUrl = "https://github.com/router-for-me/CLIProxyAPI/releases/download/";
      const archiveFor = async (files) => new Bun.Archive(files, { compress: "gzip" }).bytes();
      const validArchive = await archiveFor({ "cli-proxy-api": new Uint8Array([1, 2, 3]) });
      const invalidArchive = await archiveFor({ "README.md": "missing executable" });
      const releaseFor = (version, archive) => {
        const assetName = \`CLIProxyAPI_\${version}_linux_\${arch}.tar.gz\`;
        const base = \`\${downloadUrl}v\${version}/\`;
        return {
          tag_name: \`v\${version}\`,
          published_at: null,
          assets: [
            { name: assetName, browser_download_url: base + assetName, size: archive.byteLength },
            { name: "checksums.txt", browser_download_url: base + "checksums.txt", size: 100 },
          ],
        };
      };
      const versions = new Map([
        ["1.2.4", { archive: validArchive, release: releaseFor("1.2.4", validArchive) }],
        ["1.2.5", { archive: invalidArchive, release: releaseFor("1.2.5", invalidArchive) }],
      ]);
      const fetchedUrls = [];
      globalThis.fetch = async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        fetchedUrls.push(url);
        const tag = url.startsWith(releaseUrl) ? url.slice(releaseUrl.length).replace(/^v/, "") : null;
        if (tag) return Response.json(versions.get(tag).release);
        for (const [version, fixture] of versions) {
          const assetName = \`CLIProxyAPI_\${version}_linux_\${arch}.tar.gz\`;
          const base = \`\${downloadUrl}v\${version}/\`;
          if (url === base + assetName) return new Response(fixture.archive);
          if (url === base + "checksums.txt") {
            const checksum = createHash("sha256").update(fixture.archive).digest("hex");
            return new Response(\`\${checksum}  \${assetName}\\n\`);
          }
        }
        throw new Error(\`unexpected network request: \${url}\`);
      };
      installVersion("1.2.3");
      setCurrent("1.2.3");
      writeState({
        schemaVersion: 1,
        desiredRunning: false,
        installedVersion: "1.2.3",
        pinnedVersion: "1.2.3",
      });
      const service = await import(${JSON.stringify(moduleUrl)});
      const installedVersion = await service.install("1.2.4");
      let archiveError = "";
      try {
        await service.install("1.2.5");
      } catch (error) {
        archiveError = error instanceof Error ? error.message : String(error);
      }
      const result = {
        installedVersion,
        archiveError,
        version: currentVersion(),
        state: readState(),
        markerPresent: fs.existsSync(transactionPath),
        stagedDirectories: fs.readdirSync(versionsRoot).filter((entry) => entry.startsWith(".staging-")),
        validBinary: Array.from(fs.readFileSync(path.join(versionsRoot, "1.2.4", "cli-proxy-api"))),
        invalidVersionCreated: fs.existsSync(path.join(versionsRoot, "1.2.5")),
        fetchedUrls: fetchedUrls.sort(),
      };
      await service.shutdownCliproxy();
      console.log(JSON.stringify(result));
    `);

    expect(result.installedVersion).toBe("1.2.4");
    expect(result.archiveError).toContain("archive is missing a valid cli-proxy-api executable");
    expect(result.version).toBe("1.2.4");
    expect(result.state).toEqual({
      schemaVersion: 1,
      desiredRunning: false,
      installedVersion: "1.2.4",
      pinnedVersion: "1.2.4",
    });
    expect(result.markerPresent).toBe(false);
    expect(result.stagedDirectories).toEqual([]);
    expect(result.validBinary).toEqual([1, 2, 3]);
    expect(result.invalidVersionCreated).toBe(false);
    expect(result.fetchedUrls).toHaveLength(6);
  }, FIXTURE_TEST_TIMEOUT_MS);

  test("rolls back a failed post-switch startup to the prior desired-running version", async () => {
    const failingExecutable = getFixtureExecutable(true);
    const result = await runFixtureScenario(({ dataRoot, executable, moduleUrl }) => `
      ${serviceFixturePrelude(dataRoot, executable)}
      installVersion("1.0.0");
      installVersion("2.0.0");
      fs.chmodSync(path.join(versionsRoot, "2.0.0", "cli-proxy-api"), 0o700);
      fs.copyFileSync(${JSON.stringify(failingExecutable)}, path.join(versionsRoot, "2.0.0", "cli-proxy-api"));
      fs.chmodSync(path.join(versionsRoot, "2.0.0", "cli-proxy-api"), 0o555);
      const service = await import(${JSON.stringify(moduleUrl)});
      await service.install("1.0.0");
      let installError = "";
      try {
        await service.install("2.0.0");
      } catch (error) {
        installError = error instanceof Error ? error.message : String(error);
      }
      const status = await service.getStatus();
      const rollback = {
        version: currentVersion(),
        state: readState(),
        markerPresent: fs.existsSync(transactionPath),
        processRunning: status.processRunning,
        healthy: status.healthy,
        statusVersion: status.version,
        lastError: status.lastError,
      };
      await service.shutdownCliproxy();
      console.log(JSON.stringify({ installError, rollback }));
    `);

    expect(result.installError).toContain("not exclusively bound");
    expect(result.rollback).toEqual({
      version: "1.0.0",
      state: {
        schemaVersion: 1,
        desiredRunning: true,
        installedVersion: "1.0.0",
        pinnedVersion: "1.0.0",
      },
      markerPresent: false,
      processRunning: true,
      healthy: true,
      statusVersion: "1.0.0",
      lastError: result.installError,
    });
  }, FIXTURE_TEST_TIMEOUT_MS);

  test("recovers a marker written before the current link switches", async () => {
    const result = await runFixtureScenario(({ dataRoot, executable, moduleUrl, root }) => `
      ${serviceFixturePrelude(dataRoot, executable)}
      installVersion("1.2.3");
      installVersion("1.2.4");
      setCurrent("1.2.3");
      writeState({
        schemaVersion: 1,
        desiredRunning: true,
        installedVersion: "1.2.3",
        pinnedVersion: "1.2.3",
      });
      fs.writeFileSync(transactionPath, JSON.stringify({
        fromVersion: "1.2.3",
        toVersion: "1.2.4",
        previousPin: "1.2.3",
        previousDesiredRunning: true,
      }));
      const readyPath = path.join(${JSON.stringify(root)}, "old-child-ready");
      const signalPath = path.join(${JSON.stringify(root)}, "old-child-signaled");
      const oldChild = spawnFixture("1.2.3", readyPath, signalPath, currentPath);
      await waitForFile(readyPath);
      writeChildRecord(oldChild, "1.2.3");
      const service = await import(${JSON.stringify(moduleUrl)});
      await service.initCliproxy();
      const recovered = {
        version: currentVersion(),
        state: readState(),
        markerPresent: fs.existsSync(transactionPath),
        oldChildCurrentTargetAtStop: JSON.parse(fs.readFileSync(signalPath, "utf8")).currentTarget,
        childVersion: JSON.parse(fs.readFileSync(path.join(serviceRoot, "child.json"), "utf8")).version,
      };
      await service.shutdownCliproxy();
      console.log(JSON.stringify(recovered));
    `);

    expect(result).toEqual({
      version: "1.2.3",
      state: {
        schemaVersion: 1,
        desiredRunning: true,
        installedVersion: "1.2.3",
        pinnedVersion: "1.2.3",
      },
      markerPresent: false,
      oldChildCurrentTargetAtStop: "versions/1.2.3",
      childVersion: "1.2.3",
    });
  }, FIXTURE_TEST_TIMEOUT_MS);

  test("recovers a switched link whose state commit was interrupted", async () => {
    const result = await runFixtureScenario(({ dataRoot, executable, moduleUrl, root }) => `
      ${serviceFixturePrelude(dataRoot, executable)}
      installVersion("1.2.3");
      installVersion("1.2.4");
      setCurrent("1.2.4");
      writeState({
        schemaVersion: 1,
        desiredRunning: true,
        installedVersion: "1.2.3",
        pinnedVersion: "1.2.3",
      });
      fs.writeFileSync(transactionPath, JSON.stringify({
        fromVersion: "1.2.3",
        toVersion: "1.2.4",
        previousPin: "1.2.3",
        previousDesiredRunning: true,
      }));
      const readyPath = path.join(${JSON.stringify(root)}, "old-child-ready");
      const signalPath = path.join(${JSON.stringify(root)}, "old-child-signaled");
      const oldChild = spawnFixture("1.2.3", readyPath, signalPath, currentPath);
      await waitForFile(readyPath);
      writeChildRecord(oldChild, "1.2.3");
      const service = await import(${JSON.stringify(moduleUrl)});
      await service.initCliproxy();
      const recovered = {
        version: currentVersion(),
        state: readState(),
        markerPresent: fs.existsSync(transactionPath),
        oldChildCurrentTargetAtStop: JSON.parse(fs.readFileSync(signalPath, "utf8")).currentTarget,
        childVersion: JSON.parse(fs.readFileSync(path.join(serviceRoot, "child.json"), "utf8")).version,
      };
      await service.shutdownCliproxy();
      console.log(JSON.stringify(recovered));
    `);

    expect(result).toEqual({
      version: "1.2.3",
      state: {
        schemaVersion: 1,
        desiredRunning: true,
        installedVersion: "1.2.3",
        pinnedVersion: "1.2.3",
      },
      markerPresent: false,
      oldChildCurrentTargetAtStop: "versions/1.2.4",
      childVersion: "1.2.3",
    });
  }, FIXTURE_TEST_TIMEOUT_MS);

  test("rolls back a committed state when its transaction marker was not removed", async () => {
    const result = await runFixtureScenario(({ dataRoot, executable, moduleUrl }) => `
      ${serviceFixturePrelude(dataRoot, executable)}
      installVersion("1.2.3");
      installVersion("1.2.4");
      setCurrent("1.2.4");
      writeState({
        schemaVersion: 1,
        desiredRunning: true,
        installedVersion: "1.2.4",
        pinnedVersion: "1.2.4",
      });
      fs.writeFileSync(transactionPath, JSON.stringify({
        fromVersion: "1.2.3",
        toVersion: "1.2.4",
        previousPin: "1.2.3",
        previousDesiredRunning: true,
      }));
      const service = await import(${JSON.stringify(moduleUrl)});
      await service.initCliproxy();
      const markerRemovedAfterFirstRecovery = !fs.existsSync(transactionPath);
      await service.initCliproxy();
      const status = await service.getStatus();
      const recovered = {
        version: currentVersion(),
        state: readState(),
        markerPresent: fs.existsSync(transactionPath),
        markerRemovedAfterFirstRecovery,
        childVersion: JSON.parse(fs.readFileSync(path.join(serviceRoot, "child.json"), "utf8")).version,
        healthy: status.healthy,
      };
      await service.shutdownCliproxy();
      console.log(JSON.stringify(recovered));
    `);

    expect(result).toEqual({
      version: "1.2.3",
      state: {
        schemaVersion: 1,
        desiredRunning: true,
        installedVersion: "1.2.3",
        pinnedVersion: "1.2.3",
      },
      markerPresent: false,
      markerRemovedAfterFirstRecovery: true,
      childVersion: "1.2.3",
      healthy: true,
    });
  }, FIXTURE_TEST_TIMEOUT_MS);

  test("recovers an interrupted started update by stopping its new child before restoring", async () => {
    const result = await runFixtureScenario(({ dataRoot, executable, moduleUrl, root }) => `
      ${serviceFixturePrelude(dataRoot, executable)}
      installVersion("1.2.3");
      installVersion("1.2.4");
      setCurrent("1.2.4");
      writeState({
        schemaVersion: 1,
        desiredRunning: true,
        installedVersion: "1.2.3",
        pinnedVersion: "1.2.3",
      });
      fs.writeFileSync(transactionPath, JSON.stringify({
        fromVersion: "1.2.3",
        toVersion: "1.2.4",
        previousPin: "1.2.3",
        previousDesiredRunning: true,
      }));
      const readyPath = path.join(${JSON.stringify(root)}, "new-child-ready");
      const signalPath = path.join(${JSON.stringify(root)}, "new-child-signaled");
      const newChild = spawnFixture("1.2.4", readyPath, signalPath, currentPath);
      await waitForFile(readyPath);
      writeChildRecord(newChild, "1.2.4");
      const service = await import(${JSON.stringify(moduleUrl)});
      await service.initCliproxy();
      const status = await service.getStatus();
      const recovered = {
        version: currentVersion(),
        state: readState(),
        markerPresent: fs.existsSync(transactionPath),
        newChildWasStopped: fs.existsSync(signalPath),
        newChildCurrentTargetAtStop: JSON.parse(fs.readFileSync(signalPath, "utf8")).currentTarget,
        childVersion: JSON.parse(fs.readFileSync(path.join(serviceRoot, "child.json"), "utf8")).version,
        healthy: status.healthy,
      };
      await service.shutdownCliproxy();
      console.log(JSON.stringify(recovered));
    `);

    expect(result).toEqual({
      version: "1.2.3",
      state: {
        schemaVersion: 1,
        desiredRunning: true,
        installedVersion: "1.2.3",
        pinnedVersion: "1.2.3",
      },
      markerPresent: false,
      newChildWasStopped: true,
      newChildCurrentTargetAtStop: "versions/1.2.4",
      childVersion: "1.2.3",
      healthy: true,
    });
  }, FIXTURE_TEST_TIMEOUT_MS);

  test("preserves the recovery marker and known-good version when restore cannot replace current", async () => {
    const result = await runFixtureScenario(({ dataRoot, executable, moduleUrl }) => `
      ${serviceFixturePrelude(dataRoot, executable)}
      installVersion("1.2.3");
      installVersion("1.2.4");
      fs.mkdirSync(currentPath);
      writeState({
        schemaVersion: 1,
        desiredRunning: false,
        installedVersion: "1.2.3",
        pinnedVersion: "1.2.3",
      });
      const marker = JSON.stringify({
        fromVersion: "1.2.3",
        toVersion: "1.2.4",
        previousPin: "1.2.3",
        previousDesiredRunning: false,
      });
      fs.writeFileSync(transactionPath, marker);
      const service = await import(${JSON.stringify(moduleUrl)});
      let recoveryError = "";
      try {
        await service.initCliproxy();
      } catch (error) {
        recoveryError = error instanceof Error ? error.message : String(error);
      }
      console.log(JSON.stringify({
        recoveryError,
        markerWasPreserved: fs.readFileSync(transactionPath, "utf8") === marker,
        knownGoodVersionWasPreserved: fs.existsSync(path.join(versionsRoot, "1.2.3", "cli-proxy-api")),
      }));
    `);

    expect(result.recoveryError).toContain("current path exists and is not an owned symlink");
    expect(result.markerWasPreserved).toBe(true);
    expect(result.knownGoodVersionWasPreserved).toBe(true);
  }, FIXTURE_TEST_TIMEOUT_MS);

  test("restart re-registers its manager after shutdown before spawning a child", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cliproxy-restart-test-"));
    const moduleUrl = new URL("./service.ts", import.meta.url).href;
    const dataRoot = path.join(testRoot, "data");
    const script = `
      import * as fs from "node:fs";
      import * as path from "node:path";
      const dataRoot = ${JSON.stringify(dataRoot)};
      const serviceRoot = path.join(dataRoot, "cliproxy");
      const version = "1.2.3";
      const versionRoot = path.join(serviceRoot, "versions", version);
      const executablePath = path.join(versionRoot, "cli-proxy-api");
      const serverSource = path.join(${JSON.stringify(testRoot)}, "fake-cliproxy.ts");
      fs.mkdirSync(versionRoot, { recursive: true });
      fs.writeFileSync(serverSource, \`
        Bun.serve({
          hostname: "127.0.0.1",
          port: Number.parseInt(process.env.RAWROUTE_CLIPROXY_TEST_PORT ?? "", 10),
          fetch(request) {
            if (new URL(request.url).pathname === "/v1/models") {
              return Response.json({ data: [] });
            }
            return new Response("not found", { status: 404 });
          },
        });
      \`);
      const build = Bun.spawnSync([
        process.execPath,
        "build",
        "--compile",
        serverSource,
        "--outfile",
        executablePath,
      ], { stdout: "pipe", stderr: "pipe" });
      if (build.exitCode !== 0) {
        throw new Error(new TextDecoder().decode(build.stderr));
      }
      fs.symlinkSync(path.join("versions", version), path.join(serviceRoot, "current"));
      fs.writeFileSync(path.join(serviceRoot, "state.json"), JSON.stringify({
        schemaVersion: 1,
        desiredRunning: false,
        installedVersion: version,
        pinnedVersion: null,
      }));
      process.env.RAWROUTE_DATA_DIR = dataRoot;
      const service = await import(${JSON.stringify(moduleUrl)});
      await service.initCliproxy();
      await service.shutdownCliproxy();
      const managerPath = path.join(serviceRoot, "manager.json");
      const managerWasRemoved = !fs.existsSync(managerPath);
      await service.restart();
      const manager = JSON.parse(fs.readFileSync(managerPath, "utf8"));
      const child = JSON.parse(fs.readFileSync(path.join(serviceRoot, "child.json"), "utf8"));
      await service.shutdownCliproxy();
      console.log(JSON.stringify({
        managerWasRemoved,
        managerMatchesSelf:
          manager.pid === process.pid &&
          typeof manager.startTime === "string" &&
          manager.startTime.length > 0 &&
          typeof manager.executablePath === "string" &&
          manager.executablePath.length > 0,
        childRecordsManager:
          child.managerPid === manager.pid &&
          child.managerStartTime === manager.startTime &&
          child.managerExecutablePath === manager.executablePath,
      }));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, RAWROUTE_DATA_DIR: dataRoot },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode, stderr).toBe(0);
      const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(result).toEqual({
        managerWasRemoved: true,
        managerMatchesSelf: true,
        childRecordsManager: true,
      });
    } finally {
      await terminateFixtureProcessGroup(child);
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("rejects present null state and update recovery markers", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cliproxy-json-test-"));
    const moduleUrl = new URL("./service.ts", import.meta.url).href;
    const dataRoot = path.join(testRoot, "data");
    const script = `
      import * as fs from "node:fs";
      import * as path from "node:path";
      const dataRoot = ${JSON.stringify(dataRoot)};
      const serviceRoot = path.join(dataRoot, "cliproxy");
      const statePath = path.join(serviceRoot, "state.json");
      const transactionPath = path.join(serviceRoot, "update-transaction.json");
      fs.mkdirSync(serviceRoot, { recursive: true });
      fs.writeFileSync(statePath, "null");
      process.env.RAWROUTE_DATA_DIR = dataRoot;
      const service = await import(${JSON.stringify(moduleUrl)});
      let stateError = "";
      try {
        await service.initCliproxy();
      } catch (error) {
        stateError = error instanceof Error ? error.message : String(error);
      }
      const stateWasPreserved = fs.readFileSync(statePath, "utf8") === "null";
      fs.writeFileSync(statePath, JSON.stringify({
        schemaVersion: 1,
        desiredRunning: false,
        installedVersion: null,
        pinnedVersion: null,
      }));
      await service.initCliproxy();
      await service.shutdownCliproxy();
      fs.writeFileSync(transactionPath, "null");
      let transactionError = "";
      try {
        await service.start();
      } catch (error) {
        transactionError = error instanceof Error ? error.message : String(error);
      }
      console.log(JSON.stringify({
        stateError,
        stateWasPreserved,
        transactionError,
        transactionWasPreserved: fs.readFileSync(transactionPath, "utf8") === "null",
      }));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, RAWROUTE_DATA_DIR: dataRoot },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode, stderr).toBe(0);
      const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(result.stateError).toContain("CLIProxy state file is invalid: state.json");
      expect(result.stateWasPreserved).toBe(true);
      expect(result.transactionError).toContain(
        "CLIProxy state file is invalid: update-transaction.json"
      );
      expect(result.transactionWasPreserved).toBe(true);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test("serializes a public lifecycle operation behind a lock held by another process", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cliproxy-lock-test-"));
    const dataRoot = path.join(testRoot, "data");
    const serviceRoot = path.join(dataRoot, "cliproxy");
    const moduleUrl = new URL("./service.ts", import.meta.url).href;
    let holderLocked: (() => void) | undefined;
    let contenderStarted: (() => void) | undefined;
    let contenderCompleted: (() => void) | undefined;
    const locked = new Promise<void>((resolve) => {
      holderLocked = resolve;
    });
    const started = new Promise<void>((resolve) => {
      contenderStarted = resolve;
    });
    const completed = new Promise<void>((resolve) => {
      contenderCompleted = resolve;
    });
    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
          import * as fs from "node:fs";
          import * as lockfile from "proper-lockfile";
          const root = ${JSON.stringify(serviceRoot)};
          fs.mkdirSync(root, { recursive: true });
          const release = await lockfile.lock(root, {
            lockfilePath: root + "/lifecycle-lock",
            stale: 120_000,
            update: 10_000,
          });
          process.send?.("locked");
          process.on("message", async (message) => {
            if (message !== "release") return;
            await release();
            process.exit(0);
          });
        `,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, RAWROUTE_DATA_DIR: dataRoot },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        ipc(message) {
          if (message === "locked") holderLocked?.();
        },
      }
    );

    let contender: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
    try {
      await waitForSignal(locked, "the lock holder");
      contender = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
            process.env.RAWROUTE_DATA_DIR = ${JSON.stringify(dataRoot)};
            const service = await import(${JSON.stringify(moduleUrl)});
            const initializing = service.initCliproxy();
            // initCliproxy has invoked withLifecycleLock before this promise is returned.
            process.send?.("started");
            await initializing;
            process.send?.("completed");
            await service.shutdownCliproxy();
          `,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, RAWROUTE_DATA_DIR: dataRoot },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
          ipc(message) {
            if (message === "started") contenderStarted?.();
            if (message === "completed") contenderCompleted?.();
          },
        }
      );
      await waitForSignal(started, "the contender lock request");

      // An unlocked init completes and creates state well within this bounded observation window.
      const contentionOutcome = await Promise.race([
        completed.then(() => "operation-completed" as const),
        observeFileDuringWindow(path.join(serviceRoot, "state.json"), 2_000),
      ]);
      expect(contentionOutcome).toBe("window-elapsed");
      holder.send("release");
      const holderExit = await holder.exited;
      expect(holderExit).toBe(0);
      await waitForSignal(completed, "the contender lifecycle operation");
      const contenderStderr = await new Response(contender.stderr).text();
      expect(await contender.exited, contenderStderr).toBe(0);
      expect(fs.existsSync(path.join(serviceRoot, "state.json"))).toBe(true);
    } finally {
      for (const child of [holder, contender]) {
        if (child?.exitCode === null) {
          child.kill("SIGKILL");
          await child.exited;
        }
      }
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test("does not signal a recorded child when another process owns the CLIProxy listener", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cliproxy-listener-owner-test-"));
    const moduleUrl = new URL("./service.ts", import.meta.url).href;
    const dataRoot = path.join(testRoot, "data");
    const script = `
      import * as fs from "node:fs";
      import * as path from "node:path";
      const dataRoot = ${JSON.stringify(dataRoot)};
      const serviceRoot = path.join(dataRoot, "cliproxy");
      const versionRoot = path.join(serviceRoot, "versions", "1.2.3");
      const executablePath = path.join(versionRoot, "cli-proxy-api");
      const workerPath = path.join(${JSON.stringify(testRoot)}, "worker.ts");
      fs.mkdirSync(versionRoot, { recursive: true });
      fs.copyFileSync(process.execPath, executablePath);
      fs.chmodSync(executablePath, 0o755);
      fs.writeFileSync(workerPath, \`
        import * as fs from "node:fs";
        const [role, readyPath, signalPath] = process.argv.slice(2);
        process.on("SIGTERM", () => fs.writeFileSync(signalPath, "SIGTERM"));
        if (role === "listener") {
          Bun.serve({ hostname: "127.0.0.1", port: Number.parseInt(process.env.RAWROUTE_CLIPROXY_TEST_PORT ?? "", 10), fetch: () => new Response("ok") });
        }
        fs.writeFileSync(readyPath, "ready");
        setInterval(() => {}, 1_000);
      \`);
      const waitForFile = async (filePath) => {
        const deadline = Date.now() + 5_000;
        while (!fs.existsSync(filePath)) {
          if (Date.now() >= deadline) throw new Error("worker did not become ready");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      const identityFor = (pid) => {
        const stat = fs.readFileSync(\`/proc/\${pid}/stat\`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\\s+/);
        return { startTime: fields[19], executablePath: fs.realpathSync(\`/proc/\${pid}/exe\`) };
      };
      const idleSignal = path.join(${JSON.stringify(testRoot)}, "idle-signal");
      const listenerSignal = path.join(${JSON.stringify(testRoot)}, "listener-signal");
      const idleReady = path.join(${JSON.stringify(testRoot)}, "idle-ready");
      const listenerReady = path.join(${JSON.stringify(testRoot)}, "listener-ready");
      const idle = Bun.spawn([executablePath, workerPath, "idle", idleReady, idleSignal], {
        stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
      const listener = Bun.spawn([executablePath, workerPath, "listener", listenerReady, listenerSignal], {
        stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
      try {
        await waitForFile(idleReady);
        await waitForFile(listenerReady);
        const identity = identityFor(idle.pid);
        fs.writeFileSync(path.join(serviceRoot, "state.json"), JSON.stringify({
          schemaVersion: 1, desiredRunning: true, installedVersion: null, pinnedVersion: null,
        }));
        fs.writeFileSync(path.join(serviceRoot, "child.json"), JSON.stringify({
          pid: idle.pid,
          ...identity,
          version: "1.2.3",
          managerPid: 0,
          managerStartTime: "",
          managerExecutablePath: "",
          startedAt: new Date().toISOString(),
        }));
        process.env.RAWROUTE_DATA_DIR = dataRoot;
        const service = await import(${JSON.stringify(moduleUrl)});
        let initError = "";
        try { await service.initCliproxy(); } catch (error) { initError = error.message; }
        await service.stop();
        process.kill(idle.pid, 0);
        process.kill(listener.pid, 0);
        console.log(JSON.stringify({
          initError,
          idleWasSignaled: fs.existsSync(idleSignal),
          listenerWasSignaled: fs.existsSync(listenerSignal),
          childRecordWasPreserved: fs.existsSync(path.join(serviceRoot, "child.json")),
        }));
      } finally {
        for (const child of [idle, listener]) {
          if (child.exitCode === null) {
            child.kill("SIGKILL");
            await child.exited;
          }
        }
      }
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, RAWROUTE_DATA_DIR: dataRoot },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode, stderr).toBe(0);
      const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(result.initError).toContain("recorded child was not signaled");
      expect(result.idleWasSignaled).toBe(false);
      expect(result.listenerWasSignaled).toBe(false);
      expect(result.childRecordWasPreserved).toBe(true);
    } finally {
      await terminateFixtureProcessGroup(child);
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test("treats a PID start-time mismatch as stale without signaling the live process", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cliproxy-stale-pid-test-"));
    const moduleUrl = new URL("./service.ts", import.meta.url).href;
    const dataRoot = path.join(testRoot, "data");
    const script = `
      import * as fs from "node:fs";
      import * as path from "node:path";
      const dataRoot = ${JSON.stringify(dataRoot)};
      const serviceRoot = path.join(dataRoot, "cliproxy");
      const versionRoot = path.join(serviceRoot, "versions", "1.2.3");
      const executablePath = path.join(versionRoot, "cli-proxy-api");
      const workerPath = path.join(${JSON.stringify(testRoot)}, "worker.ts");
      const readyPath = path.join(${JSON.stringify(testRoot)}, "ready");
      const signalPath = path.join(${JSON.stringify(testRoot)}, "signal");
      fs.mkdirSync(versionRoot, { recursive: true });
      fs.copyFileSync(process.execPath, executablePath);
      fs.chmodSync(executablePath, 0o755);
      fs.writeFileSync(workerPath, \`
        import * as fs from "node:fs";
        process.on("SIGTERM", () => fs.writeFileSync(process.argv[3], "SIGTERM"));
        fs.writeFileSync(process.argv[2], "ready");
        setInterval(() => {}, 1_000);
      \`);
      const worker = Bun.spawn([executablePath, workerPath, readyPath, signalPath], {
        stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
      try {
        const deadline = Date.now() + 5_000;
        while (!fs.existsSync(readyPath)) {
          if (Date.now() >= deadline) throw new Error("worker did not become ready");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const stat = fs.readFileSync(\`/proc/\${worker.pid}/stat\`, "utf8");
        const startTime = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\\s+/)[19];
        fs.writeFileSync(path.join(serviceRoot, "state.json"), JSON.stringify({
          schemaVersion: 1, desiredRunning: false, installedVersion: null, pinnedVersion: null,
        }));
        fs.writeFileSync(path.join(serviceRoot, "child.json"), JSON.stringify({
          pid: worker.pid,
          startTime: startTime + "-reused",
          executablePath: fs.realpathSync(\`/proc/\${worker.pid}/exe\`),
          version: "1.2.3",
          managerPid: 0,
          managerStartTime: "",
          managerExecutablePath: "",
          startedAt: new Date().toISOString(),
        }));
        process.env.RAWROUTE_DATA_DIR = dataRoot;
        const service = await import(${JSON.stringify(moduleUrl)});
        await service.initCliproxy();
        process.kill(worker.pid, 0);
        console.log(JSON.stringify({
          workerWasSignaled: fs.existsSync(signalPath),
          staleRecordWasRemoved: !fs.existsSync(path.join(serviceRoot, "child.json")),
        }));
        await service.shutdownCliproxy();
      } finally {
        if (worker.exitCode === null) {
          worker.kill("SIGKILL");
          await worker.exited;
        }
      }
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, RAWROUTE_DATA_DIR: dataRoot },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode, stderr).toBe(0);
      const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(result).toEqual({ workerWasSignaled: false, staleRecordWasRemoved: true });
    } finally {
      await terminateFixtureProcessGroup(child);
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test("rejects a live foreign manager record and takes over only after it is stale", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cliproxy-manager-handoff-test-"));
    const moduleUrl = new URL("./service.ts", import.meta.url).href;
    const dataRoot = path.join(testRoot, "data");
    const script = `
      import * as fs from "node:fs";
      import * as path from "node:path";
      const dataRoot = ${JSON.stringify(dataRoot)};
      const serviceRoot = path.join(dataRoot, "cliproxy");
      fs.mkdirSync(serviceRoot, { recursive: true });
      fs.writeFileSync(path.join(serviceRoot, "state.json"), JSON.stringify({
        schemaVersion: 1, desiredRunning: false, installedVersion: null, pinnedVersion: null,
      }));
      const foreign = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
        stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
      try {
        const stat = fs.readFileSync(\`/proc/\${foreign.pid}/stat\`, "utf8");
        const foreignManager = {
          pid: foreign.pid,
          startTime: stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\\s+/)[19],
          executablePath: fs.realpathSync(\`/proc/\${foreign.pid}/exe\`),
        };
        const managerPath = path.join(serviceRoot, "manager.json");
        fs.writeFileSync(managerPath, JSON.stringify(foreignManager));
        process.env.RAWROUTE_DATA_DIR = dataRoot;
        const service = await import(${JSON.stringify(moduleUrl)});
        let error = "";
        try { await service.initCliproxy(); } catch (failure) { error = failure.message; }
        const foreignRecordWasPreserved = fs.readFileSync(managerPath, "utf8") === JSON.stringify(foreignManager);
        foreign.kill("SIGKILL");
        await foreign.exited;
        await service.initCliproxy();
        const replacement = JSON.parse(fs.readFileSync(managerPath, "utf8"));
        await service.shutdownCliproxy();
        console.log(JSON.stringify({
          error,
          foreignRecordWasPreserved,
          replacementBelongsToSelf:
            replacement.pid === process.pid &&
            typeof replacement.startTime === "string" &&
            replacement.startTime.length > 0,
        }));
      } finally {
        if (foreign.exitCode === null) {
          foreign.kill("SIGKILL");
          await foreign.exited;
        }
      }
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, RAWROUTE_DATA_DIR: dataRoot },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode, stderr).toBe(0);
      const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(result.error).toContain("managed by another live Bun process");
      expect(result.foreignRecordWasPreserved).toBe(true);
      expect(result.replacementBelongsToSelf).toBe(true);
    } finally {
      await terminateFixtureProcessGroup(child);
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test("rejects and preserves null or malformed manager and child ownership records", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cliproxy-ownership-json-test-"));
    const moduleUrl = new URL("./service.ts", import.meta.url).href;
    const cases = [
      {
        file: "manager.json",
        contents: "null",
        expectedError: "CLIProxy state file is invalid: manager.json",
      },
      {
        file: "manager.json",
        contents: "{}",
        expectedError: "CLIProxy manager ownership record is invalid",
      },
      {
        file: "child.json",
        contents: "null",
        expectedError: "CLIProxy state file is invalid: child.json",
      },
      {
        file: "child.json",
        contents: "{}",
        expectedError: "CLIProxy child ownership record is invalid",
      },
    ];

    try {
      for (const [index, fixture] of cases.entries()) {
        const dataRoot = path.join(testRoot, String(index));
        const script = `
          import * as fs from "node:fs";
          import * as path from "node:path";
          const dataRoot = ${JSON.stringify(dataRoot)};
          const serviceRoot = path.join(dataRoot, "cliproxy");
          const recordPath = path.join(serviceRoot, ${JSON.stringify(fixture.file)});
          fs.mkdirSync(serviceRoot, { recursive: true });
          fs.writeFileSync(path.join(serviceRoot, "state.json"), JSON.stringify({
            schemaVersion: 1, desiredRunning: false, installedVersion: null, pinnedVersion: null,
          }));
          fs.writeFileSync(recordPath, ${JSON.stringify(fixture.contents)});
          process.env.RAWROUTE_DATA_DIR = dataRoot;
          const service = await import(${JSON.stringify(moduleUrl)});
          let error = "";
          try { await service.initCliproxy(); } catch (failure) { error = failure.message; }
          console.log(JSON.stringify({ error, preserved: fs.readFileSync(recordPath, "utf8") === ${JSON.stringify(fixture.contents)} }));
        `;
        const child = Bun.spawn([process.execPath, "-e", script], {
          cwd: process.cwd(),
          env: { ...process.env, RAWROUTE_DATA_DIR: dataRoot },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        try {
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          expect(exitCode, stderr).toBe(0);
          const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
          expect(result.error).toContain(fixture.expectedError);
          expect(result.preserved).toBe(true);
        } finally {
          if (child.exitCode === null) {
            child.kill("SIGKILL");
            await child.exited;
          }
        }
      }
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test("restarts an unexpected exit after backoff and stop invalidates its scheduled restart", async () => {
    const result = await runFixtureScenario(({ dataRoot, executable, moduleUrl, root }) => `
      ${serviceFixturePrelude(dataRoot, executable)}
      const launchDirectory = path.join(${JSON.stringify(root)}, "launches");
      process.env.CLIPROXY_FIXTURE_LAUNCH_DIRECTORY = launchDirectory;
      installVersion("1.2.3");
      setCurrent("1.2.3");
      writeState({
        schemaVersion: 1,
        desiredRunning: false,
        installedVersion: "1.2.3",
        pinnedVersion: null,
      });
      const service = await import(${JSON.stringify(moduleUrl)});
      await service.initCliproxy();
      await service.start();
      const initialLaunches = fs.readdirSync(launchDirectory).length;
      const firstRecord = JSON.parse(fs.readFileSync(path.join(serviceRoot, "child.json"), "utf8"));
      const firstExitAt = Date.now();
      process.kill(firstRecord.pid, "SIGKILL");
      await waitForAsyncCondition(
        async () => (await service.getStatus()).operation?.name === "restarting",
        "the first scheduled restart"
      );
      await waitForCondition(
        () => fs.readdirSync(launchDirectory).length === initialLaunches + 1,
        "the backoff restart launch",
        5_000
      );
      const firstRestartElapsedMs = Date.now() - firstExitAt;
      await waitForAsyncCondition(
        async () => (await service.getStatus()).processRunning,
        "the restarted child to become healthy"
      );

      const secondRecord = JSON.parse(fs.readFileSync(path.join(serviceRoot, "child.json"), "utf8"));
      process.kill(secondRecord.pid, "SIGKILL");
      await waitForAsyncCondition(
        async () => (await service.getStatus()).operation?.name === "restarting",
        "the second scheduled restart"
      );
      await service.stop();
      const launchesAfterStop = fs.readdirSync(launchDirectory).length;
      const staleRestartWasSuppressed = await noNewLaunches(launchDirectory, launchesAfterStop, 1_300);
      const stoppedStatus = await service.getStatus();
      await service.shutdownCliproxy();
      console.log(JSON.stringify({
        initialLaunches,
        firstRestartElapsedMs,
        launchesAfterStop,
        staleRestartWasSuppressed,
        stoppedDesiredRunning: stoppedStatus.desiredRunning,
        stoppedProcessRunning: stoppedStatus.processRunning,
      }));
    `);

    expect(result.initialLaunches).toBe(1);
    // The initial production backoff is one second; leave scheduler headroom without masking it.
    expect(result.firstRestartElapsedMs).toBeGreaterThanOrEqual(850);
    expect(result.launchesAfterStop).toBe(2);
    expect(result.staleRestartWasSuppressed).toBe(true);
    expect(result.stoppedDesiredRunning).toBe(false);
    expect(result.stoppedProcessRunning).toBe(false);
  }, FIXTURE_TEST_TIMEOUT_MS);

  test("keeps restart attempts across healthy children that crash before stable uptime", async () => {
    const result = await runFixtureScenario(({ dataRoot, executable, moduleUrl, root }) => `
      ${serviceFixturePrelude(dataRoot, executable)}
      const launchDirectory = path.join(${JSON.stringify(root)}, "launches");
      process.env.CLIPROXY_FIXTURE_LAUNCH_DIRECTORY = launchDirectory;
      process.env.CLIPROXY_FIXTURE_EXIT_AFTER_HEALTHY_MS = "500";
      installVersion("1.2.3");
      setCurrent("1.2.3");
      writeState({
        schemaVersion: 1,
        desiredRunning: false,
        installedVersion: "1.2.3",
        pinnedVersion: null,
      });
      const nativeSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = (callback, milliseconds, ...args) =>
        [1_000, 2_000, 4_000, 8_000, 16_000].includes(Number(milliseconds))
          ? nativeSetTimeout(callback, 0, ...args)
          : nativeSetTimeout(callback, milliseconds, ...args);
      try {
        const service = await import(${JSON.stringify(moduleUrl)});
        await service.initCliproxy();
        await service.start();
        await waitForAsyncCondition(
          async () => (await service.getStatus()).lastError?.includes("restart limit reached") === true,
          "the automatic restart limit",
          10_000,
        );
        const status = await service.getStatus();
        const launchesAtLimit = fs.readdirSync(launchDirectory).length;
        const noFurtherLaunches = await noNewLaunches(launchDirectory, launchesAtLimit, 700);
        await service.shutdownCliproxy();
        console.log(JSON.stringify({
          launchesAtLimit,
          noFurtherLaunches,
          restartAttempts: status.restartAttempts,
          processRunning: status.processRunning,
          lastError: status.lastError,
        }));
      } finally {
        globalThis.setTimeout = nativeSetTimeout;
      }
    `);

    expect(result.launchesAtLimit).toBe(6);
    expect(result.noFurtherLaunches).toBe(true);
    expect(result.restartAttempts).toBe(5);
    expect(result.processRunning).toBe(false);
    expect(result.lastError).toContain("restart limit reached");
  }, FIXTURE_TEST_TIMEOUT_MS);

  test("shutdown drains a pending restart without recreating child or manager records", async () => {
    const result = await runFixtureScenario(({ dataRoot, executable, moduleUrl, root }) => `
      ${serviceFixturePrelude(dataRoot, executable)}
      const launchDirectory = path.join(${JSON.stringify(root)}, "launches");
      process.env.CLIPROXY_FIXTURE_LAUNCH_DIRECTORY = launchDirectory;
      installVersion("1.2.3");
      setCurrent("1.2.3");
      writeState({
        schemaVersion: 1,
        desiredRunning: false,
        installedVersion: "1.2.3",
        pinnedVersion: null,
      });
      const service = await import(${JSON.stringify(moduleUrl)});
      await service.initCliproxy();
      await service.start();
      const record = JSON.parse(fs.readFileSync(path.join(serviceRoot, "child.json"), "utf8"));
      process.kill(record.pid, "SIGKILL");
      await waitForAsyncCondition(
        async () => (await service.getStatus()).operation?.name === "restarting",
        "the scheduled restart before shutdown"
      );
      const launchesBeforeShutdown = fs.readdirSync(launchDirectory).length;
      await service.shutdownCliproxy();
      const statusAfterShutdown = await service.getStatus();
      const noLaterRestart = await noNewLaunches(launchDirectory, launchesBeforeShutdown, 1_300);
      console.log(JSON.stringify({
        launchesBeforeShutdown,
        noLaterRestart,
        operationAfterShutdown: statusAfterShutdown.operation,
        childRecordPresent: fs.existsSync(path.join(serviceRoot, "child.json")),
        managerRecordPresent: fs.existsSync(path.join(serviceRoot, "manager.json")),
        processRunning: statusAfterShutdown.processRunning,
      }));
    `);

    expect(result.launchesBeforeShutdown).toBe(1);
    expect(result.noLaterRestart).toBe(true);
    expect(result.operationAfterShutdown).toBeNull();
    expect(result.childRecordPresent).toBe(false);
    expect(result.managerRecordPresent).toBe(false);
    expect(result.processRunning).toBe(false);
  }, FIXTURE_TEST_TIMEOUT_MS);

  test("shutdown cancels and drains the 16-second restart backoff promptly", async () => {
    const result = await runFixtureScenario(({ dataRoot, executable, moduleUrl, root }) => `
      ${serviceFixturePrelude(dataRoot, executable)}
      const launchDirectory = path.join(${JSON.stringify(root)}, "launches");
      const longBackoffPath = path.join(${JSON.stringify(root)}, "16-second-backoff-pending");
      process.env.CLIPROXY_FIXTURE_LAUNCH_DIRECTORY = launchDirectory;
      process.env.CLIPROXY_FIXTURE_EXIT_AFTER_LAUNCH = "1";
      installVersion("1.2.3");
      setCurrent("1.2.3");
      writeState({
        schemaVersion: 1,
        desiredRunning: false,
        installedVersion: "1.2.3",
        pinnedVersion: null,
      });

      const nativeSetTimeout = globalThis.setTimeout;
      const nativeClearTimeout = globalThis.clearTimeout;
      globalThis.setTimeout = (callback, milliseconds, ...args) => {
        const delayMs = Number(milliseconds);
        if ([1_000, 2_000, 4_000, 8_000].includes(delayMs)) {
          return nativeSetTimeout(callback, 0, ...args);
        }
        if (delayMs === 16_000) {
          fs.writeFileSync(longBackoffPath, "pending");
          // A broken cancellation path still fails the prompt-shutdown race below quickly.
          return nativeSetTimeout(callback, 3_000, ...args);
        }
        return nativeSetTimeout(callback, milliseconds, ...args);
      };

      let shutdownTimeout;
      try {
        const service = await import(${JSON.stringify(moduleUrl)});
        await service.initCliproxy();
        await service.start();
        const record = JSON.parse(fs.readFileSync(path.join(serviceRoot, "child.json"), "utf8"));
        process.kill(record.pid, "SIGKILL");
        await waitForFile(longBackoffPath);
        const launchesAtLongBackoff = fs.readdirSync(launchDirectory).length;
        const shutdownStartedAt = Date.now();
        const shutdownOutcome = await Promise.race([
          service.shutdownCliproxy().then(() => "shutdown"),
          new Promise((resolve) => {
            shutdownTimeout = nativeSetTimeout(() => resolve("timeout"), 2_000);
          }),
        ]);
        nativeClearTimeout(shutdownTimeout);
        if (shutdownOutcome !== "shutdown") {
          throw new Error("shutdown did not cancel the pending long restart backoff promptly");
        }
        const shutdownElapsedMs = Date.now() - shutdownStartedAt;
        globalThis.setTimeout = nativeSetTimeout;
        const status = await service.getStatus();
        const noLaterRestart = await noNewLaunches(launchDirectory, launchesAtLongBackoff, 300);
        console.log(JSON.stringify({
          launchesAtLongBackoff,
          shutdownElapsedMs,
          noLaterRestart,
          operationAfterShutdown: status.operation,
          childRecordPresent: fs.existsSync(path.join(serviceRoot, "child.json")),
          managerRecordPresent: fs.existsSync(path.join(serviceRoot, "manager.json")),
          processRunning: status.processRunning,
        }));
      } finally {
        if (shutdownTimeout) nativeClearTimeout(shutdownTimeout);
        globalThis.setTimeout = nativeSetTimeout;
      }
    `);

    expect(result.launchesAtLongBackoff).toBe(5);
    expect(result.shutdownElapsedMs).toBeLessThan(1_000);
    expect(result.noLaterRestart).toBe(true);
    expect(result.operationAfterShutdown).toBeNull();
    expect(result.childRecordPresent).toBe(false);
    expect(result.managerRecordPresent).toBe(false);
    expect(result.processRunning).toBe(false);
  }, FIXTURE_TEST_TIMEOUT_MS);

  test("reaps a child when child-record persistence fails and leaves status safe", async () => {
    const result = await runFixtureScenario(({ dataRoot, executable, moduleUrl }) => `
      ${serviceFixturePrelude(dataRoot, executable)}
      installVersion("1.2.3");
      setCurrent("1.2.3");
      writeState({
        schemaVersion: 1,
        desiredRunning: false,
        installedVersion: "1.2.3",
        pinnedVersion: null,
      });
      const service = await import(${JSON.stringify(moduleUrl)});
      await service.initCliproxy();
      const childRecordPath = path.join(serviceRoot, "child.json");
      fs.symlinkSync("missing-child-record", childRecordPath);
      let startError = "";
      try {
        await service.start();
      } catch (error) {
        startError = error instanceof Error ? error.message : String(error);
      }
      const status = await service.getStatus();
      const managedExecutable = fs.realpathSync(path.join(versionsRoot, "1.2.3", "cli-proxy-api"));
      const orphanedPids = fs.readdirSync("/proc", { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\\d+$/.test(entry.name))
        .map((entry) => Number(entry.name))
        .filter((pid) => {
          try {
            return fs.realpathSync(\`/proc/\${pid}/exe\`) === managedExecutable;
          } catch {
            return false;
          }
        });
      const recordPathWasPreserved = fs.lstatSync(childRecordPath).isSymbolicLink();
      fs.rmSync(childRecordPath, { force: true });
      await service.shutdownCliproxy();
      console.log(JSON.stringify({
        startError,
        orphanedPids,
        recordPathWasPreserved,
        statusProcessRunning: status.processRunning,
        statusHealthy: status.healthy,
        statusError: status.lastError,
        managerRemovedAfterShutdown: !fs.existsSync(path.join(serviceRoot, "manager.json")),
      }));
    `);

    expect(result.startError).toContain("Refusing to replace a non-regular CLIProxy state file: child.json");
    expect(result.orphanedPids).toEqual([]);
    expect(result.recordPathWasPreserved).toBe(true);
    expect(result.statusProcessRunning).toBe(false);
    expect(result.statusHealthy).toBe(false);
    expect(result.statusError).toContain("Refusing to replace a non-regular CLIProxy state file: child.json");
    expect(result.managerRemovedAfterShutdown).toBe(true);
  }, FIXTURE_TEST_TIMEOUT_MS);

  test("reaps a child and clears its record when its authenticated health check fails", async () => {
    const result = await runFixtureScenario(({ dataRoot, executable, moduleUrl, root }) => `
      ${serviceFixturePrelude(dataRoot, executable)}
      const healthRequestPath = path.join(${JSON.stringify(root)}, "health-requested");
      const signalPath = path.join(${JSON.stringify(root)}, "health-failure-child-stopped");
      process.env.CLIPROXY_FIXTURE_HEALTH_REQUEST_PATH = healthRequestPath;
      process.env.CLIPROXY_FIXTURE_FAIL_HEALTH_AND_REBIND = "1";
      process.env.CLIPROXY_FIXTURE_SIGNAL_PATH = signalPath;
      installVersion("1.2.3");
      setCurrent("1.2.3");
      writeState({
        schemaVersion: 1,
        desiredRunning: false,
        installedVersion: "1.2.3",
        pinnedVersion: null,
      });
      const service = await import(${JSON.stringify(moduleUrl)});
      await service.initCliproxy();
      let startError = "";
      try {
        await service.start();
      } catch (error) {
        startError = error instanceof Error ? error.message : String(error);
      }
      await waitForFile(healthRequestPath);
      await waitForFile(signalPath);
      const status = await service.getStatus();
      const childRecordWasCleared = !fs.existsSync(path.join(serviceRoot, "child.json"));
      await service.shutdownCliproxy();
      console.log(JSON.stringify({
        startError,
        healthWasProbed: fs.existsSync(healthRequestPath),
        childWasStopped: fs.existsSync(signalPath),
        childRecordWasCleared,
        statusProcessRunning: status.processRunning,
        statusHealthy: status.healthy,
        managerRemovedAfterShutdown: !fs.existsSync(path.join(serviceRoot, "manager.json")),
      }));
    `);

    expect(result.startError).toContain("not exclusively bound");
    expect(result.healthWasProbed).toBe(true);
    expect(result.childWasStopped).toBe(true);
    expect(result.childRecordWasCleared).toBe(true);
    expect(result.statusProcessRunning).toBe(false);
    expect(result.statusHealthy).toBe(false);
    expect(result.managerRemovedAfterShutdown).toBe(true);
  }, FIXTURE_TEST_TIMEOUT_MS);

  test("startup resumes only an installed desired service and first manual install starts", () => {
    expect(getStartupAction(false, false)).toBe("idle");
    expect(getStartupAction(false, true)).toBe("idle");
    expect(getStartupAction(true, true)).toBe("start");
    expect(getStartupAction(true, false)).toBe("missing-install");

    expect(shouldStartAfterInstall(false, false)).toBe(true);
    expect(shouldStartAfterInstall(true, false)).toBe(true);
    expect(shouldStartAfterInstall(false, true)).toBe(false);
    expect(shouldStartAfterInstall(true, true)).toBe(true);
  });

  test("reads Linux proc start time despite closing parentheses in command names", () => {
    const stat = "42 (bun (worker) name) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20";
    expect(parseProcStartTime(stat)).toBe("987654");
    expect(parseProcStartTime("malformed")).toBeNull();
  });

  test("parses listener addresses and requires every socket to be IPv4 loopback", () => {
    const tcp = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:207D 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 43210",
      "   1: 0100007F:207D 00000000:0000 01 00000000:00000000 00:00000000 00000000 1000 0 43211",
      "   2: 0100007F:207E 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 43212",
      "   3: 00000000:207D 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 43213",
    ].join("\n");
    const listeners = parseListeningSockets(tcp, 8317, "ipv4");
    expect(listeners).toEqual([
      { inode: "43210", address: "127.0.0.1" },
      { inode: "43213", address: "0.0.0.0" },
    ]);
    expect(areAllLoopbackListeners(["127.0.0.1", "127.0.0.1"])).toBe(true);
    expect(areAllLoopbackListeners(["127.0.0.1", "0.0.0.0"])).toBe(false);
    const tcp6 = [
      "  sl  local_address                         rem_address                         st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 00000000000000000000000001000000:207D 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 43214",
    ].join("\n");
    const ipv6Listeners = parseListeningSockets(tcp6, 8317, "ipv6");
    expect(ipv6Listeners).toEqual([
      { inode: "43214", address: "ipv6:00000000000000000000000001000000" },
    ]);
    expect(areAllLoopbackListeners(ipv6Listeners.map((listener) => listener.address))).toBe(false);
  });
});
