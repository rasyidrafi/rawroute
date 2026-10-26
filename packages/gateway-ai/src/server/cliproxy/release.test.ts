import { describe, expect, test } from "bun:test";
import {
  getLinuxAssetName,
  getLinuxReleaseArch,
  isSafeArchivePath,
  normalizeVersion,
  parseChecksums,
  versionFromTag,
  supportedVersion,
} from "./release";

describe("CLIProxy release helpers", () => {
  test("only maintained V8 releases can be selected for this integration", () => {
    expect(supportedVersion("v8.0.43")).toBe("8.0.43");
    expect(supportedVersion("8.1.0")).toBe("8.1.0");
    for (const version of ["7.3.4", "8.0.42", "9.0.0", "8.0.43-rc.1"]) expect(() => supportedVersion(version)).toThrow("requires CLIProxyAPI V8");
  });
  test("normalizes only semantic versions", () => {
    expect(normalizeVersion("v8.0.43")).toBe("8.0.43");
    expect(normalizeVersion("8.0.43-rc.1+build.4")).toBe("8.0.43-rc.1+build.4");
    expect(versionFromTag("latest")).toBeNull();
    expect(() => normalizeVersion("../8.0.43")).toThrow("semantic version");
    expect(() => normalizeVersion("08.0.43")).toThrow("semantic version");
  });

  test("maps Linux architectures to upstream standard tarballs", () => {
    expect(getLinuxReleaseArch("x64")).toBe("amd64");
    expect(getLinuxReleaseArch("arm64")).toBe("aarch64");
    expect(getLinuxAssetName("8.0.43", "x64")).toBe(
      "CLIProxyAPI_8.0.43_linux_amd64.tar.gz"
    );
    expect(getLinuxAssetName("8.0.43", "arm64")).toBe(
      "CLIProxyAPI_8.0.43_linux_aarch64.tar.gz"
    );
    expect(() => getLinuxReleaseArch("ia32")).toThrow("Unsupported Linux architecture");
  });

  test("parses sha256sum and BSD-style checksum entries by exact filename", () => {
    const checksums = parseChecksums(
      `${"a".repeat(64)}  CLIProxyAPI_8.0.43_linux_amd64.tar.gz\n` +
        `${"B".repeat(64)} *CLIProxyAPI_8.0.43_linux_aarch64.tar.gz\n` +
        "not-a-checksum broken.tar.gz\n"
    );
    expect(checksums.get("CLIProxyAPI_8.0.43_linux_amd64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("CLIProxyAPI_8.0.43_linux_aarch64.tar.gz")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  test("rejects absolute, traversal, and platform-ambiguous archive paths", () => {
    expect(isSafeArchivePath("cli-proxy-api")).toBe(true);
    expect(isSafeArchivePath("docs/README.md")).toBe(true);
    expect(isSafeArchivePath("../outside")).toBe(false);
    expect(isSafeArchivePath("docs/../../outside")).toBe(false);
    expect(isSafeArchivePath("/etc/passwd")).toBe(false);
    expect(isSafeArchivePath("C:\\Windows\\file")).toBe(false);
    expect(isSafeArchivePath("docs\\file")).toBe(false);
  });
});
