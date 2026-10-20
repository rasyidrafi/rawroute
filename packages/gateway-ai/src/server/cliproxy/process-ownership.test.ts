import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  listenersSecurelyOwnedBy,
  processIdentityMatches,
  readPortListeners,
  readProcIdentity,
} from "./process-ownership";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("CLIProxy process ownership inspection", () => {
  test("reads a synthetic proc snapshot with an exclusively owned loopback listener", () => {
    const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cliproxy-proc-test-"));
    temporaryRoots.push(procRoot);
    const pid = 42;
    const startTime = "987654";
    fs.mkdirSync(path.join(procRoot, "net"), { recursive: true });
    fs.mkdirSync(path.join(procRoot, String(pid), "fd"), { recursive: true });
    fs.writeFileSync(
      path.join(procRoot, "net", "tcp"),
      [
        "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
        "   0: 0100007F:207D 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 43210",
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(procRoot, String(pid), "stat"),
      "42 (bun (worker) name) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20"
    );
    fs.symlinkSync(process.execPath, path.join(procRoot, String(pid), "exe"));
    fs.symlinkSync("socket:[43210]", path.join(procRoot, String(pid), "fd", "0"));

    const identity = readProcIdentity(pid, procRoot);
    const listeners = readPortListeners(8317, procRoot);

    expect(identity).toEqual({ startTime, executablePath: path.resolve(process.execPath) });
    expect(processIdentityMatches(pid, startTime, process.execPath, procRoot)).toBe(true);
    expect(processIdentityMatches(pid, "reused", process.execPath, procRoot)).toBe(false);
    expect(listenersSecurelyOwnedBy(pid, listeners)).toBe(true);
  });
});
