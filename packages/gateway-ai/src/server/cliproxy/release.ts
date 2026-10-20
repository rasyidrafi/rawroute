import { createHash } from "node:crypto";

const GITHUB_API = "https://api.github.com/repos/router-for-me/CLIProxyAPI";
const API_TIMEOUT_MS = 20_000;
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 128 * 1024;
export const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_EXPANDED_ARCHIVE_BYTES = 640 * 1024 * 1024;

const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface GitHubRelease {
  tag_name: string;
  published_at: string | null;
  assets: ReleaseAsset[];
}

export interface AvailableVersions {
  latest: string;
  versions: Array<{ version: string; publishedAt: string | null }>;
}

export function normalizeVersion(input: string): string {
  const version = input.startsWith("v") ? input.slice(1) : input;
  if (!VERSION_PATTERN.test(version)) {
    throw new Error("CLIProxy version must be a valid semantic version");
  }
  return version;
}

export function versionFromTag(tag: string): string | null {
  try {
    return normalizeVersion(tag);
  } catch {
    return null;
  }
}

export function getLinuxReleaseArch(arch = process.arch): "amd64" | "aarch64" {
  if (process.platform !== "linux") {
    throw new Error("CLIProxyAPI lifecycle supports Linux only");
  }
  if (arch === "x64") return "amd64";
  if (arch === "arm64") return "aarch64";
  throw new Error(`Unsupported Linux architecture: ${arch}`);
}

export function getLinuxAssetName(version: string, arch = process.arch): string {
  const normalized = normalizeVersion(version);
  return `CLIProxyAPI_${normalized}_linux_${getLinuxReleaseArch(arch)}.tar.gz`;
}

export function parseChecksums(contents: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^([a-f\d]{64})\s+\*?(.+?)\s*$/i);
    if (match) checksums.set(match[2], match[1].toLowerCase());
  }
  return checksums;
}

export function isSafeArchivePath(name: string): boolean {
  if (!name || name.includes("\\") || name.startsWith("/")) return false;
  if (/^[a-z]:/i.test(name)) return false;
  const segments = name.split("/");
  return segments.every((segment) => segment !== ".." && segment !== "");
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`GitHub request failed with HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("GitHub response exceeded the allowed size");
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new Error("GitHub response exceeded the allowed size");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchBytes(url: string, maxBytes: number): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "rawroute",
    },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  return readBoundedResponse(response, maxBytes);
}

async function fetchRelease(url: string): Promise<GitHubRelease> {
  const bytes = await fetchBytes(url, MAX_JSON_BYTES);
  let release: GitHubRelease;
  try {
    release = JSON.parse(new TextDecoder().decode(bytes)) as GitHubRelease;
  } catch {
    throw new Error("GitHub returned invalid release metadata");
  }
  if (!release || typeof release.tag_name !== "string" || !Array.isArray(release.assets)) {
    throw new Error("GitHub returned incomplete release metadata");
  }
  return release;
}

function hasStandardLinuxAsset(release: GitHubRelease, version: string): boolean {
  const assetNames = new Set(release.assets.map((asset) => asset.name));
  return (
    assetNames.has(`CLIProxyAPI_${version}_linux_amd64.tar.gz`) &&
    assetNames.has(`CLIProxyAPI_${version}_linux_aarch64.tar.gz`) &&
    assetNames.has("checksums.txt")
  );
}

export async function getAvailableVersions(): Promise<AvailableVersions> {
  // A compiled E2E process may provide only reviewed semver strings. This
  // keeps the browser lifecycle panel from contacting GitHub during a private
  // transport fixture; production never reads the override.
  if (process.env.NODE_ENV === "test" && process.env.RAWROUTE_CLIPROXY_TEST_VERSIONS) {
    const versions = process.env.RAWROUTE_CLIPROXY_TEST_VERSIONS.split(",").map((item) => normalizeVersion(item.trim()));
    if (!versions.length) throw new Error("RAWROUTE_CLIPROXY_TEST_VERSIONS must contain a version");
    return { latest: versions[0]!, versions: versions.map((version) => ({ version, publishedAt: null })) };
  }
  const [latestRelease, listBytes] = await Promise.all([
    fetchRelease(`${GITHUB_API}/releases/latest`),
    fetchBytes(`${GITHUB_API}/releases?per_page=100&page=1`, MAX_JSON_BYTES),
  ]);
  let releases: GitHubRelease[];
  try {
    releases = JSON.parse(new TextDecoder().decode(listBytes)) as GitHubRelease[];
  } catch {
    throw new Error("GitHub returned an invalid release list");
  }
  if (!Array.isArray(releases)) throw new Error("GitHub returned an invalid release list");

  const latest = versionFromTag(latestRelease.tag_name);
  if (!latest) throw new Error("GitHub latest release has an invalid version tag");
  const unique = new Map<string, string | null>();
  for (const release of [latestRelease, ...releases]) {
    const version = versionFromTag(release.tag_name);
    if (version && hasStandardLinuxAsset(release, version)) {
      unique.set(version, release.published_at ?? null);
    }
  }
  return {
    latest,
    versions: [...unique].map(([version, publishedAt]) => ({ version, publishedAt })),
  };
}

async function getExactRelease(version: string): Promise<GitHubRelease> {
  const release = await fetchRelease(`${GITHUB_API}/releases/tags/v${version}`);
  if (versionFromTag(release.tag_name) !== version) {
    throw new Error("GitHub returned a release with an unexpected version tag");
  }
  return release;
}

async function fetchAsset(release: GitHubRelease, name: string, maxBytes: number): Promise<Uint8Array> {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (!asset) throw new Error(`CLIProxy release is missing ${name}`);
  const url = new URL(asset.browser_download_url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.pathname !==
      `/router-for-me/CLIProxyAPI/releases/download/${release.tag_name}/${name}`
  ) {
    throw new Error("CLIProxy release contains an invalid asset URL");
  }
  return fetchBytes(url.toString(), maxBytes);
}

export async function fetchVerifiedBinary(version: string): Promise<Uint8Array> {
  const normalized = normalizeVersion(version);
  const release = await getExactRelease(normalized);
  const assetName = getLinuxAssetName(normalized);
  const [archive, checksumFile] = await Promise.all([
    fetchAsset(release, assetName, MAX_ARCHIVE_BYTES),
    fetchAsset(release, "checksums.txt", MAX_CHECKSUM_BYTES),
  ]);
  const expected = parseChecksums(new TextDecoder().decode(checksumFile)).get(assetName);
  if (!expected) throw new Error(`CLIProxy checksums.txt does not contain ${assetName}`);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) throw new Error(`SHA-256 verification failed for ${assetName}`);

  const packageArchive = new Bun.Archive(archive);
  const files = await packageArchive.files();
  const executable = files.get("cli-proxy-api");
  if (!executable || executable.size <= 0 || executable.size > MAX_EXECUTABLE_BYTES) {
    throw new Error("CLIProxy archive is missing a valid cli-proxy-api executable");
  }
  let expandedBytes = 0;
  for (const [archivePath] of files) {
    if (!isSafeArchivePath(archivePath)) {
      throw new Error("CLIProxy archive contains an unsafe file path");
    }
  }
  for (const file of files.values()) {
    expandedBytes += file.size;
    if (expandedBytes > MAX_EXPANDED_ARCHIVE_BYTES) {
      throw new Error("CLIProxy archive exceeds the allowed extracted size");
    }
  }

  return archive;
}

export async function extractVerifiedBinary(archiveBytes: Uint8Array, destination: string): Promise<void> {
  const archive = new Bun.Archive(archiveBytes);
  const files = await archive.files();
  const executable = files.get("cli-proxy-api");
  if (!executable || executable.size <= 0 || executable.size > MAX_EXECUTABLE_BYTES) {
    throw new Error("CLIProxy archive is missing a valid cli-proxy-api executable");
  }
  let expandedBytes = 0;
  for (const [archivePath, file] of files) {
    if (!isSafeArchivePath(archivePath)) {
      throw new Error("CLIProxy archive contains an unsafe file path");
    }
    expandedBytes += file.size;
    if (expandedBytes > MAX_EXPANDED_ARCHIVE_BYTES) {
      throw new Error("CLIProxy archive exceeds the allowed extracted size");
    }
  }
  await archive.extract(destination, { glob: "cli-proxy-api" });
}
