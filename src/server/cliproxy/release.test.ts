import { describe, expect, test } from "bun:test";
import {
  getLinuxAssetName,
  getLinuxReleaseArch,
  isSafeArchivePath,
  normalizeVersion,
  parseChecksums,
  versionFromTag,
} from "./release";

describe("CLIProxy release helpers", () => {
  test("normalizes only semantic versions", () => {
    expect(normalizeVersion("v7.3.15")).toBe("7.3.15");
    expect(normalizeVersion("7.3.15-rc.1+build.4")).toBe("7.3.15-rc.1+build.4");
    expect(versionFromTag("latest")).toBeNull();
    expect(() => normalizeVersion("../7.3.15")).toThrow("semantic version");
    expect(() => normalizeVersion("07.3.15")).toThrow("semantic version");
  });

  test("maps Linux architectures to upstream standard tarballs", () => {
    expect(getLinuxReleaseArch("x64")).toBe("amd64");
    expect(getLinuxReleaseArch("arm64")).toBe("aarch64");
    expect(getLinuxAssetName("7.3.15", "x64")).toBe(
      "CLIProxyAPI_7.3.15_linux_amd64.tar.gz"
    );
    expect(getLinuxAssetName("7.3.15", "arm64")).toBe(
      "CLIProxyAPI_7.3.15_linux_aarch64.tar.gz"
    );
    expect(() => getLinuxReleaseArch("ia32")).toThrow("Unsupported Linux architecture");
  });

  test("parses sha256sum and BSD-style checksum entries by exact filename", () => {
    const checksums = parseChecksums(
      `${"a".repeat(64)}  CLIProxyAPI_7.3.15_linux_amd64.tar.gz\n` +
        `${"B".repeat(64)} *CLIProxyAPI_7.3.15_linux_aarch64.tar.gz\n` +
        "not-a-checksum broken.tar.gz\n"
    );
    expect(checksums.get("CLIProxyAPI_7.3.15_linux_amd64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("CLIProxyAPI_7.3.15_linux_aarch64.tar.gz")).toBe("b".repeat(64));
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
