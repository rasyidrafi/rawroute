import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { normalizeVersion } from "./release";
import { configMapping, parseConfig } from "./config";

export const CLIPROXY_HOST = "127.0.0.1";
const DEFAULT_CLIPROXY_PORT = 8317;

/**
 * Test fixtures may select an isolated loopback port before this module is
 * imported. Production deliberately has no environment override: CLIProxy is
 * always private on its documented port.
 */
function testCliproxyPort(): number | undefined {
  if (process.env.NODE_ENV !== "test") return undefined;
  const rawPort = process.env.RAWROUTE_CLIPROXY_TEST_PORT;
  if (rawPort === undefined) return undefined;
  if (!/^\d+$/.test(rawPort)) throw new Error("RAWROUTE_CLIPROXY_TEST_PORT must be a valid TCP port");
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("RAWROUTE_CLIPROXY_TEST_PORT must be a valid TCP port");
  }
  return port;
}

export const CLIPROXY_PORT = testCliproxyPort() ?? DEFAULT_CLIPROXY_PORT;

export interface PersistentState {
  schemaVersion: 1;
  desiredRunning: boolean;
  installedVersion: string | null;
  pinnedVersion: string | null;
}

export interface ServicePaths {
  root: string;
  versions: string;
  current: string;
  config: string;
  auth: string;
  apiKey: string;
  managementKey: string;
  state: string;
  process: string;
  manager: string;
  transaction: string;
  lock: string;
}

export function getDataRoot(rawRouteDataDir = process.env.RAWROUTE_DATA_DIR): string {
  return path.resolve(rawRouteDataDir || path.join(homedir(), ".local/share/rawroute"));
}

export function getServicePaths(root: string): ServicePaths {
  const serviceRoot = path.join(root, "cliproxy");
  return {
    root: serviceRoot,
    versions: path.join(serviceRoot, "versions"),
    current: path.join(serviceRoot, "current"),
    config: path.join(serviceRoot, "config.yaml"),
    auth: path.join(serviceRoot, "auth"),
    apiKey: path.join(serviceRoot, "secrets", "api-key"),
    managementKey: path.join(serviceRoot, "secrets", "management-key"),
    state: path.join(serviceRoot, "state.json"),
    process: path.join(serviceRoot, "child.json"),
    manager: path.join(serviceRoot, "manager.json"),
    transaction: path.join(serviceRoot, "update-transaction.json"),
    lock: path.join(serviceRoot, "lifecycle-lock"),
  };
}

export function renderConfig(apiKey: string, managementKey: string, authDir: string): string {
  const quote = (value: string) => JSON.stringify(value);
  return [
    "config-version: 8",
    "server:",
    `  host: ${quote(CLIPROXY_HOST)}`,
    `  port: ${CLIPROXY_PORT}`,
    "observability:",
    "  logs:",
    "    debug: false",
    "    logging-to-file: true",
    "    logs-max-total-size-mb: 100",
    "  usage:",
    "    usage-statistics-enabled: true",
    "plugins:",
    "  enabled: false",
    "routing:",
    "  strategy: fill-first",
    "  retry:",
    "    request-retry: 0",
    "    max-retry-credentials: 0",
    "    max-retry-interval: 0",
    "  cooldown:",
    "    disable-cooling: true",
    "    transient-error-cooldown-seconds: -1",
    "management:",
    "  allow-remote: false",
    `  secret-key: ${quote(managementKey)}`,
    "  disable-control-panel: true",
    "access:",
    "  api-keys:",
    `    - ${quote(apiKey)}`,
    "oauth:",
    `  auth-dir: ${quote(authDir)}`,
    "",
  ].join("\n");
}

export function validateLoopbackConfig(contents: string): void {
  const config = parseConfig(contents);
  if (config["config-version"] !== 8 || "host" in config || "port" in config || "remote-management" in config || "auth-dir" in config || Array.isArray(config["api-keys"])) {
    throw new Error("CLIProxy requires canonical V8 configuration. Stop writers and run scripts/migrations/cliproxy.ts before upgrading.");
  }
  const server = configMapping(config.server);
  if (server.host !== CLIPROXY_HOST || server.port !== CLIPROXY_PORT) {
    throw new Error(`CLIProxy config must use server.host ${CLIPROXY_HOST} and server.port ${CLIPROXY_PORT}`);
  }
}

export function ensureLayout(paths: ServicePaths): void {
  for (const directory of [paths.root, paths.versions, path.dirname(paths.apiKey), paths.auth]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const metadata = fs.lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`CLIProxy state directory is not a private directory: ${path.basename(directory)}`);
    }
    fs.chmodSync(directory, 0o700);
  }
}

export function writeAtomic(filePath: string, contents: string, mode = 0o600): void {
  if (fs.existsSync(filePath) || isSymlink(filePath)) {
    const metadata = fs.lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Refusing to replace a non-regular CLIProxy state file: ${path.basename(filePath)}`);
    }
  }
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, contents, { encoding: "utf8", mode });
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, filePath);
}

export function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const metadata = fs.lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("not a regular file");
    }
    const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (value === null) throw new Error("null is not a valid state record");
    return value as T;
  } catch {
    throw new Error(`CLIProxy state file is invalid: ${path.basename(filePath)}`);
  }
}

export function defaultState(): PersistentState {
  return {
    schemaVersion: 1,
    desiredRunning: false,
    installedVersion: null,
    pinnedVersion: null,
  };
}

export function readState(paths: ServicePaths): PersistentState {
  const state = readJson<PersistentState>(paths.state);
  if (state === null) return defaultState();
  if (
    state.schemaVersion !== 1 ||
    typeof state.desiredRunning !== "boolean" ||
    !(state.installedVersion === null || typeof state.installedVersion === "string") ||
    !(state.pinnedVersion === null || typeof state.pinnedVersion === "string")
  ) {
    throw new Error("CLIProxy state file has an unsupported format");
  }
  if (state.installedVersion) state.installedVersion = normalizeVersion(state.installedVersion);
  if (state.pinnedVersion) state.pinnedVersion = normalizeVersion(state.pinnedVersion);
  return state;
}

export function writeState(paths: ServicePaths, state: PersistentState): void {
  writeAtomic(paths.state, `${JSON.stringify(state, null, 2)}\n`);
}

function createSecret(filePath: string): string {
  if (fs.existsSync(filePath)) {
    const metadata = fs.lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("CLIProxy secret path is not a regular file");
    }
    fs.chmodSync(filePath, 0o600);
    const secret = fs.readFileSync(filePath, "utf8").trim();
    if (secret.length < 32) throw new Error("CLIProxy persisted secret is invalid");
    return secret;
  }
  const secret = randomBytes(32).toString("base64url");
  writeAtomic(filePath, `${secret}\n`);
  return secret;
}

export function readSecret(filePath: string): string {
  const secret = fs.readFileSync(filePath, "utf8").trim();
  if (secret.length < 32) throw new Error("CLIProxy persisted secret is invalid");
  return secret;
}

export function ensureConfig(paths: ServicePaths): void {
  const configExists = fs.existsSync(paths.config);
  if (configExists) {
    const metadata = fs.lstatSync(paths.config);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("CLIProxy config path is not a regular file");
    }
  }
  const apiKeyExists = fs.existsSync(paths.apiKey);
  const managementKeyExists = fs.existsSync(paths.managementKey);
  if (configExists && (!apiKeyExists || !managementKeyExists)) {
    throw new Error("CLIProxy config exists but its persisted secrets are missing");
  }
  const apiKey = createSecret(paths.apiKey);
  const managementKey = createSecret(paths.managementKey);
  if (!configExists) {
    writeAtomic(paths.config, renderConfig(apiKey, managementKey, paths.auth));
  } else {
    fs.chmodSync(paths.config, 0o600);
  }
  validateLoopbackConfig(fs.readFileSync(paths.config, "utf8"));
}

export function isSymlink(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}
