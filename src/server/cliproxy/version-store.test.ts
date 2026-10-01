import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureLayout, getServicePaths } from "./store";
import {
  CLIPROXY_EXECUTABLE_NAME,
  cleanupStagingVersions,
  currentVersion,
  isInstalledVersion,
  removeCurrentVersion,
  setCurrentVersion,
} from "./version-store";

const temporaryRoots: string[] = [];

function createPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cliproxy-version-store-test-"));
  temporaryRoots.push(root);
  const paths = getServicePaths(root);
  ensureLayout(paths);
  return paths;
}

function installVersion(paths: ReturnType<typeof createPaths>, version: string): void {
  const versionDir = path.join(paths.versions, version);
  fs.mkdirSync(versionDir, { mode: 0o700 });
  fs.writeFileSync(path.join(versionDir, CLIPROXY_EXECUTABLE_NAME), "binary", { mode: 0o555 });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("CLIProxy version store", () => {
  test("atomically replaces current with a relative link to an installed version", () => {
    const paths = createPaths();
    installVersion(paths, "1.2.3");
    installVersion(paths, "1.2.4");

    setCurrentVersion(paths, "1.2.3");
    setCurrentVersion(paths, "1.2.4");

    expect(fs.lstatSync(paths.current).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(paths.current)).toBe(path.join("versions", "1.2.4"));
    expect(currentVersion(paths)).toBe("1.2.4");
    expect(fs.readdirSync(paths.root).filter((entry) => entry.startsWith("current."))).toEqual([]);
  });

  test("does not replace a non-symlink current path or remove a different current version", () => {
    const paths = createPaths();
    installVersion(paths, "1.2.3");
    fs.mkdirSync(paths.current);

    expect(() => setCurrentVersion(paths, "1.2.3")).toThrow("current path exists and is not an owned symlink");

    fs.rmSync(paths.current, { recursive: true });
    setCurrentVersion(paths, "1.2.3");
    removeCurrentVersion(paths, "1.2.4");
    expect(currentVersion(paths)).toBe("1.2.3");
    removeCurrentVersion(paths, "1.2.3");
    expect(currentVersion(paths)).toBeNull();
  });

  test("removes only stale real staging directories", () => {
    const paths = createPaths();
    installVersion(paths, "1.2.3");
    installVersion(paths, "1.2.4");
    setCurrentVersion(paths, "1.2.4");
    fs.mkdirSync(path.join(paths.versions, ".staging-interrupted"));
    fs.symlinkSync("1.2.3", path.join(paths.versions, ".staging-linked"));

    cleanupStagingVersions(paths);

    expect(fs.existsSync(path.join(paths.versions, ".staging-interrupted"))).toBe(false);
    expect(fs.lstatSync(path.join(paths.versions, ".staging-linked")).isSymbolicLink()).toBe(true);
    expect(isInstalledVersion(paths, "1.2.3")).toBe(true);
    expect(currentVersion(paths)).toBe("1.2.4");
  });
});
