import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { extractVerifiedBinary, fetchVerifiedBinary, normalizeVersion } from "./release";
import { isSymlink, type ServicePaths, writeAtomic } from "./store";

export const CLIPROXY_EXECUTABLE_NAME = "cli-proxy-api";

export function currentVersion(paths: ServicePaths): string | null {
  if (!fs.existsSync(paths.current) && !isSymlink(paths.current)) return null;
  const target = fs.readlinkSync(paths.current);
  const match = target.match(/^versions\/(.+)$/);
  if (!match) throw new Error("CLIProxy current link points outside its version directory");
  const version = normalizeVersion(match[1]);
  return isInstalledVersion(paths, version) ? version : null;
}

export function isInstalledVersion(paths: ServicePaths, version: string): boolean {
  try {
    const versionDir = path.join(paths.versions, version);
    const directory = fs.lstatSync(versionDir);
    const executable = fs.lstatSync(path.join(versionDir, CLIPROXY_EXECUTABLE_NAME));
    return directory.isDirectory() && !directory.isSymbolicLink() && executable.isFile();
  } catch {
    return false;
  }
}

export function setCurrentVersion(paths: ServicePaths, version: string): void {
  const normalized = normalizeVersion(version);
  if (!isInstalledVersion(paths, normalized)) throw new Error("CLIProxy version is not installed");
  if (fs.existsSync(paths.current) && !isSymlink(paths.current)) {
    throw new Error("CLIProxy current path exists and is not an owned symlink");
  }
  const temporary = path.join(paths.root, `current.${randomUUID()}`);
  fs.symlinkSync(path.join("versions", normalized), temporary);
  fs.renameSync(temporary, paths.current);
}

export function removeCurrentVersion(paths: ServicePaths, expectedVersion: string): void {
  if (!isSymlink(paths.current)) return;
  if (fs.readlinkSync(paths.current) === path.join("versions", expectedVersion)) {
    fs.unlinkSync(paths.current);
  }
}

export function cleanupStagingVersions(paths: ServicePaths): void {
  for (const entry of fs.readdirSync(paths.versions, { withFileTypes: true })) {
    if (!entry.name.startsWith(".staging-")) continue;
    const stagingPath = path.join(paths.versions, entry.name);
    const metadata = fs.lstatSync(stagingPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
    fs.chmodSync(stagingPath, 0o700);
    fs.rmSync(stagingPath, { recursive: true, force: true });
  }
}

export async function prepareVersion(paths: ServicePaths, version: string): Promise<void> {
  const finalDir = path.join(paths.versions, version);
  if (fs.existsSync(finalDir)) {
    if (!isInstalledVersion(paths, version)) throw new Error("Existing CLIProxy version directory is invalid");
    return;
  }

  const archive = await fetchVerifiedBinary(version);
  const stagingDir = path.join(paths.versions, `.staging-${version}-${randomUUID()}`);
  const extractDir = path.join(stagingDir, "extract");
  fs.mkdirSync(extractDir, { recursive: true, mode: 0o700 });
  try {
    await extractVerifiedBinary(archive, extractDir);
    const extractedBinary = path.join(extractDir, CLIPROXY_EXECUTABLE_NAME);
    const metadata = fs.lstatSync(extractedBinary);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
      throw new Error("CLIProxy archive did not produce a regular executable");
    }
    const stagedBinary = path.join(stagingDir, CLIPROXY_EXECUTABLE_NAME);
    fs.renameSync(extractedBinary, stagedBinary);
    fs.chmodSync(stagedBinary, 0o555);
    writeAtomic(path.join(stagingDir, ".version"), `${version}\n`, 0o444);
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.chmodSync(stagingDir, 0o555);
    fs.renameSync(stagingDir, finalDir);
  } catch (error) {
    fs.chmodSync(stagingDir, 0o700);
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}
