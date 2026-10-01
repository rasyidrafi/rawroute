import { snapshotConfiguration, restoreConfiguration, discardConfigurationBackup } from "./backup";
import { seedBundledVersion } from "./bootstrap";
import { childEnvironment } from "./child-environment";
import * as fs from "node:fs";
import { lifecycleLog } from "./logging";
import * as path from "node:path";
import * as lockfile from "proper-lockfile";
import {
  getAvailableVersions,
  normalizeVersion,
} from "./release";
import {
  CLIPROXY_HOST,
  CLIPROXY_PORT,
  defaultState,
  ensureConfig,
  ensureLayout,
  getDataRoot,
  getServicePaths,
  readJson,
  readSecret,
  readState,
  writeAtomic,
  writeState,
} from "./store";
import {
  listenerPortIsBusy as inspectListenerPortIsBusy,
  listenersLoopbackOnly as inspectListenersLoopbackOnly,
  listenersOwnedBy as inspectListenersOwnedBy,
  listenersSecurelyOwnedBy as inspectListenersSecurelyOwnedBy,
  processIdentityMatches,
  readPortListeners,
  readProcIdentity,
} from "./process-ownership";
import {
  CLIPROXY_EXECUTABLE_NAME,
  cleanupStagingVersions,
  currentVersion,
  isInstalledVersion,
  prepareVersion,
  removeCurrentVersion,
  setCurrentVersion,
} from "./version-store";

export {
  CLIPROXY_HOST,
  CLIPROXY_PORT,
  getDataRoot,
  renderConfig,
  validateLoopbackConfig,
} from "./store";
export { areAllLoopbackListeners, parseListeningSockets, parseProcStartTime } from "./process-ownership";

const TERM_TIMEOUT_MS = 5_000;
const STARTUP_TIMEOUT_MS = 30_000;
const MAX_RESTARTS = 5;
const RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
export const CLIPROXY_LOCK_TIMING = {
  staleMs: 120_000,
  updateMs: 10_000,
  retryIntervalMs: 500,
  recoveryMarginMs: 30_000,
  retryAttempts: 300,
} as const;

interface ProcessRecord {
  pid: number;
  startTime: string;
  executablePath: string;
  version: string;
  managerPid: number;
  managerStartTime: string;
  managerExecutablePath: string;
  startedAt: string;
}

interface ManagerRecord {
  pid: number;
  startTime: string;
  executablePath: string;
}

interface UpdateTransaction {
  fromVersion: string | null;
  toVersion: string;
  previousPin: string | null;
  previousDesiredRunning?: boolean;
}

import type { CliproxyOperationName, CliproxyOperation, CliproxyStatus, CliproxyVersions } from "@/lib/cliproxy/types";
export type { CliproxyOperationName, CliproxyStatus, CliproxyVersions } from "@/lib/cliproxy/types";

export type CliproxyStartupAction = "idle" | "start" | "missing-install";

type ChildProcess = Bun.Subprocess;

const dataRoot = getDataRoot();
const paths = getServicePaths(dataRoot);
let activeProcess: ChildProcess | undefined;
let activeRecord: ProcessRecord | undefined;
const operationQueue: CliproxyOperation[] = [];
let lastError: string | null = null;
let shuttingDown = false;
let restartAttempts = 0;
let restartGeneration = 0;
let restartTask: Promise<void> | undefined;
let pendingRestartBackoff:
  | { timer: ReturnType<typeof setTimeout>; resolve: () => void }
  | undefined;
let pendingRestart: { record: ProcessRecord; exitCode: number; generation: number } | undefined;
const intentionalExits = new Set<number>();
let recoveryReconciler: (() => Promise<void>) | undefined;

/** Registers the server-owned reconciliation job run after an automatic recovery start. */
export function registerCliproxyRecoveryReconciler(reconciler: (() => Promise<void>) | undefined): () => void {
  recoveryReconciler = reconciler;
  return () => {
    if (recoveryReconciler === reconciler) recoveryReconciler = undefined;
  };
}

async function reconcileAfterAutomaticRecovery(): Promise<void> {
  if (!recoveryReconciler) return;
  try {
    await recoveryReconciler();
  } catch {
    // The provider job persists its own sanitised retry state. Keep the healthy
    // child running; a failed reconciliation is not a failed process restart.
    lifecycleLog("cliproxy.recovery.reconcile.failed", "ERROR");
  }
}

export function getStartupAction(
  desiredRunning: boolean,
  hasInstalledVersion: boolean
): CliproxyStartupAction {
  if (!desiredRunning) return "idle";
  return hasInstalledVersion ? "start" : "missing-install";
}

export function shouldStartAfterInstall(
  desiredRunning: boolean,
  previouslyInstalled: boolean
): boolean {
  return desiredRunning || !previouslyInstalled;
}

function getSelfIdentity(): ManagerRecord {
  const identity = readProcIdentity(process.pid);
  if (!identity) throw new Error("Unable to fingerprint the Bun process through /proc");
  return { pid: process.pid, ...identity };
}

function recordIdentityMatches(record: Pick<ProcessRecord, "pid" | "startTime" | "executablePath">): boolean {
  return processIdentityMatches(record.pid, record.startTime, record.executablePath);
}

function managerIsAlive(record: ManagerRecord): boolean {
  return recordIdentityMatches(record);
}

function isManagedBinaryPath(executablePath: string): boolean {
  const relative = path.relative(paths.versions, executablePath);
  const parts = relative.split(path.sep);
  if (parts.length !== 2 || parts[1] !== CLIPROXY_EXECUTABLE_NAME) return false;
  try {
    return normalizeVersion(parts[0]) === parts[0];
  } catch {
    return false;
  }
}

function listenersOwnedBy(record: ProcessRecord, listeners = readPortListeners()): boolean {
  return inspectListenersOwnedBy(record.pid, listeners);
}

function listenersLoopbackOnly(listeners = readPortListeners()): boolean {
  return inspectListenersLoopbackOnly(listeners);
}

function listenersSecurelyOwnedBy(record: ProcessRecord, listeners = readPortListeners()): boolean {
  return inspectListenersSecurelyOwnedBy(record.pid, listeners);
}

function listenerPortIsBusy(listeners = readPortListeners()): boolean {
  return inspectListenerPortIsBusy(listeners);
}

function readProcessRecord(): ProcessRecord | null {
  const record = readJson<ProcessRecord>(paths.process);
  if (record === null) return null;
  if (
    !Number.isSafeInteger(record.pid) ||
    typeof record.startTime !== "string" ||
    typeof record.executablePath !== "string" ||
    typeof record.version !== "string" ||
    !isManagedBinaryPath(record.executablePath)
  ) {
    throw new Error("CLIProxy child ownership record is invalid");
  }
  record.version = normalizeVersion(record.version);
  return record;
}

function readManagerRecord(): ManagerRecord | null {
  const record = readJson<ManagerRecord>(paths.manager);
  if (record === null) return null;
  if (
    !Number.isSafeInteger(record.pid) ||
    typeof record.startTime !== "string" ||
    typeof record.executablePath !== "string"
  ) {
    throw new Error("CLIProxy manager ownership record is invalid");
  }
  return record;
}

function removeProcessRecord(record: ProcessRecord): void {
  const latest = readProcessRecord();
  if (latest?.pid === record.pid && latest.startTime === record.startTime) {
    fs.rmSync(paths.process, { force: true });
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cancelRestartBackoff(): void {
  const backoff = pendingRestartBackoff;
  if (!backoff) return;
  pendingRestartBackoff = undefined;
  clearTimeout(backoff.timer);
  backoff.resolve();
}

function invalidateRestartGeneration(): void {
  restartGeneration++;
  cancelRestartBackoff();
}

function waitForRestartBackoff(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingRestartBackoff?.timer === timer) pendingRestartBackoff = undefined;
      resolve();
    }, milliseconds);
    pendingRestartBackoff = { timer, resolve };
  });
}

async function waitForPidExit(record: ProcessRecord, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!recordIdentityMatches(record)) return true;
    await delay(100);
  }
  return !recordIdentityMatches(record);
}

async function stopRecord(record: ProcessRecord, requirePortOwnership: boolean): Promise<void> {
  if (!recordIdentityMatches(record) || !isManagedBinaryPath(record.executablePath)) return;
  if (requirePortOwnership && !listenersOwnedBy(record)) {
    throw new Error("Refusing to stop a CLIProxy process without verified port ownership");
  }
  try {
    process.kill(record.pid, "SIGTERM");
  } catch (error) {
    if (!isMissingProcessError(error)) throw error;
  }
  if (await waitForPidExit(record, TERM_TIMEOUT_MS)) return;
  if (!recordIdentityMatches(record)) return;
  try {
    process.kill(record.pid, "SIGKILL");
  } catch (error) {
    if (!isMissingProcessError(error)) throw error;
  }
  if (!(await waitForPidExit(record, TERM_TIMEOUT_MS))) {
    throw new Error("CLIProxy process did not exit after SIGKILL");
  }
}

function isMissingProcessError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
}

async function reconcileStaleChild(): Promise<void> {
  const record = readProcessRecord();
  if (!record) return;
  if (!recordIdentityMatches(record)) {
    removeProcessRecord(record);
    return;
  }

  let listeners = readPortListeners();
  if (!listenersOwnedBy(record, listeners) && !listenerPortIsBusy(listeners)) {
    const settleUntil = Date.now() + 2_000;
    while (Date.now() < settleUntil && recordIdentityMatches(record)) {
      await delay(100);
      listeners = readPortListeners();
      if (listenersOwnedBy(record, listeners) || listenerPortIsBusy(listeners)) break;
    }
  }
  if (listenersOwnedBy(record, listeners)) {
    await stopRecord(record, true);
    removeProcessRecord(record);
    return;
  }
  if (listenerPortIsBusy(listeners)) {
    throw new Error("CLIProxy port 8317 is owned by another process; recorded child was not signaled");
  }
  throw new Error("A recorded CLIProxy process is alive but its port ownership is ambiguous");
}

function assertManagerIsSelf(): void {
  const manager = readManagerRecord();
  const self = getSelfIdentity();
  if (manager && managerIsAlive(manager) && manager.pid !== self.pid) {
    throw new Error("CLIProxy is managed by another live Bun process");
  }
  if (
    manager &&
    managerIsAlive(manager) &&
    manager.pid === self.pid &&
    manager.startTime !== self.startTime
  ) {
    throw new Error("CLIProxy manager PID fingerprint changed");
  }
}

function registerManager(): void {
  const self = getSelfIdentity();
  const manager = readManagerRecord();
  if (
    manager?.pid === self.pid &&
    manager.startTime === self.startTime &&
    manager.executablePath === self.executablePath
  ) {
    return;
  }
  if (manager && managerIsAlive(manager)) {
    throw new Error("CLIProxy is managed by another live Bun process");
  }
  writeAtomic(paths.manager, `${JSON.stringify(self, null, 2)}\n`);
}

async function withLifecycleLock<T>(callback: () => Promise<T>): Promise<T> {
  ensureLayout(paths);
  const release = await lockfile.lock(paths.root, {
    lockfilePath: paths.lock,
    stale: CLIPROXY_LOCK_TIMING.staleMs,
    update: CLIPROXY_LOCK_TIMING.updateMs,
    retries: {
      retries: CLIPROXY_LOCK_TIMING.retryAttempts,
      factor: 1,
      minTimeout: CLIPROXY_LOCK_TIMING.retryIntervalMs,
      maxTimeout: CLIPROXY_LOCK_TIMING.retryIntervalMs,
    },
  });
  try {
    return await callback();
  } finally {
    await release();
  }
}

/**
 * Serializes every private remote-management read/modify/write with lifecycle
 * operations. It intentionally exposes no paths or secrets to callers.
 */
export async function withCliproxyManagementLock<T>(callback: () => Promise<T>): Promise<T> {
  return await withLifecycleLock(callback);
}

function currentOperation(): CliproxyOperation | null {
  return operationQueue[0] ?? null;
}

async function withOperation<T>(name: CliproxyOperationName, callback: () => Promise<T>): Promise<T> {
  const operation: CliproxyOperation = { name, startedAt: new Date().toISOString() };
  lifecycleLog(`cliproxy.${name}.started`);
  operationQueue.push(operation);
  lastError = null;
  try {
    const result = await callback();
    lifecycleLog(`cliproxy.${name}.completed`);
    return result;
  } catch (error) {
    lifecycleLog(`cliproxy.${name}.failed`, "ERROR");
    lastError = error instanceof Error ? error.message : "CLIProxy operation failed";
    throw error;
  } finally {
    const index = operationQueue.indexOf(operation);
    if (index >= 0) operationQueue.splice(index, 1);
  }
}

function registerShutdownSignals(): void {
  const signalProcess = process as typeof process & { __rawrouteCliproxySignals?: boolean };
  if (signalProcess.__rawrouteCliproxySignals) return;
  signalProcess.__rawrouteCliproxySignals = true;
  const shutdownFor = (signal: "SIGINT" | "SIGTERM", exitCode: number) => {
    process.once(signal, () => {
      void shutdownCliproxy()
        .then(() => process.exit(exitCode))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "shutdown failed";
          process.stderr.write(`[cliproxy] ${message}\n`);
          process.exit(1);
        });
    });
  };
  shutdownFor("SIGINT", 130);
  shutdownFor("SIGTERM", 143);
}

function readTransaction(): UpdateTransaction | null {
  const transaction = readJson<UpdateTransaction>(paths.transaction);
  if (transaction === null) return null;
  if (
    !(transaction.fromVersion === null || typeof transaction.fromVersion === "string") ||
    typeof transaction.toVersion !== "string" ||
    !(transaction.previousPin === null || typeof transaction.previousPin === "string") ||
    !(transaction.previousDesiredRunning === undefined ||
      typeof transaction.previousDesiredRunning === "boolean")
  ) {
    throw new Error("CLIProxy update recovery marker is invalid");
  }
  if (transaction.fromVersion) transaction.fromVersion = normalizeVersion(transaction.fromVersion);
  transaction.toVersion = normalizeVersion(transaction.toVersion);
  if (transaction.previousPin) transaction.previousPin = normalizeVersion(transaction.previousPin);
  return transaction;
}

async function recoverInterruptedUpdate(): Promise<void> {
  const transaction = readTransaction();
  if (!transaction) return;
  await stopActiveChild();
  await reconcileStaleChild();
  restoreConfiguration(paths);
  if (transaction.fromVersion) {
    if (!isInstalledVersion(paths, transaction.fromVersion)) {
      throw new Error("CLIProxy recovery version is missing; refusing to discard the update marker");
    }
    setCurrentVersion(paths, transaction.fromVersion);
  } else {
    removeCurrentVersion(paths, transaction.toVersion);
  }
  const state = readState(paths);
  state.installedVersion = transaction.fromVersion;
  state.pinnedVersion = transaction.previousPin;
  state.desiredRunning = transaction.previousDesiredRunning ?? state.desiredRunning;
  writeState(paths, state);
  fs.rmSync(paths.transaction, { force: true });
  discardConfigurationBackup(paths);
}

async function probeApiHealth(): Promise<boolean> {
  try {
    const response = await fetch(`http://${CLIPROXY_HOST}:${CLIPROXY_PORT}/v1/models`, {
      headers: { Authorization: `Bearer ${readSecret(paths.apiKey)}` },
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as { data?: unknown };
    return Array.isArray(payload.data);
  } catch {
    return false;
  }
}

async function waitUntilHealthy(record: ProcessRecord, timeoutMs = STARTUP_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!recordIdentityMatches(record)) throw new Error("CLIProxy exited before becoming healthy");
    const listeners = readPortListeners();
    if (listenersSecurelyOwnedBy(record, listeners) && (await probeApiHealth())) {
      const confirmedListeners = readPortListeners();
      if (listenersSecurelyOwnedBy(record, confirmedListeners)) return;
      if (listenerPortIsBusy(confirmedListeners)) {
        throw new Error(`CLIProxy listener is not exclusively bound to ${CLIPROXY_HOST}:${CLIPROXY_PORT}`);
      }
    }
    if (listenerPortIsBusy(listeners) && !listenersSecurelyOwnedBy(record, listeners)) {
      throw new Error(`CLIProxy listener is not exclusively bound to ${CLIPROXY_HOST}:${CLIPROXY_PORT}`);
    }
    await delay(250);
  }
  throw new Error("CLIProxy did not pass its authenticated health check before timeout");
}

function writeProcessRecord(record: ProcessRecord): void {
  writeAtomic(paths.process, `${JSON.stringify(record, null, 2)}\n`);
}

async function stopActiveChild(): Promise<void> {
  const child = activeProcess;
  const record = activeRecord;
  if (!child || !record) return;
  intentionalExits.add(child.pid);
  if (child.exitCode === null) child.kill("SIGTERM");
  const exited = await Promise.race([
    child.exited.then(() => true),
    delay(TERM_TIMEOUT_MS).then(() => false),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    const killed = await Promise.race([
      child.exited.then(() => true),
      delay(TERM_TIMEOUT_MS).then(() => false),
    ]);
    if (!killed) throw new Error("CLIProxy process did not exit after SIGKILL");
  }
  if (activeProcess === child) activeProcess = undefined;
  if (activeRecord === record) activeRecord = undefined;
  removeProcessRecord(record);
}

function monitorChild(child: ChildProcess, record: ProcessRecord): void {
  const generation = restartGeneration;
  void child.exited.then((exitCode) => {
    if (activeProcess === child) activeProcess = undefined;
    if (activeRecord === record) activeRecord = undefined;
    let recordWasCurrent = false;
    try {
      const latest = readProcessRecord();
      recordWasCurrent = latest?.pid === record.pid && latest.startTime === record.startTime;
      removeProcessRecord(record);
    } catch (error) {
      lastError = error instanceof Error ? error.message : "CLIProxy process record could not be cleared";
    }
    const wasIntentional = intentionalExits.delete(child.pid);
    if (!recordWasCurrent || wasIntentional || shuttingDown) return;
    try {
      if (!readState(paths).desiredRunning || generation !== restartGeneration) return;
      void scheduleRestart(record, exitCode, generation);
    } catch (error) {
      lastError = error instanceof Error ? error.message : "CLIProxy state could not be read";
    }
  });
}

async function scheduleRestart(
  exitedRecord: ProcessRecord,
  exitCode: number,
  generation: number
): Promise<void> {
  if (shuttingDown) return;
  if (generation !== restartGeneration) return;
  if (restartTask) {
    pendingRestart = { record: exitedRecord, exitCode, generation };
    return;
  }
  const operation: CliproxyOperation = { name: "restarting", startedAt: new Date().toISOString() };
  lifecycleLog("cliproxy.process.exited", "WARN", { exitCode });
  operationQueue.push(operation);
  restartTask = (async () => {
    const uptime = Date.now() - Date.parse(exitedRecord.startedAt);
    if (uptime >= 60_000) restartAttempts = 0;
    while (restartAttempts < MAX_RESTARTS && !shuttingDown && generation === restartGeneration) {
      await waitForRestartBackoff(RESTART_BACKOFF_MS[restartAttempts++]);
      let desiredRunning = false;
      try {
        desiredRunning = readState(paths).desiredRunning;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "CLIProxy state could not be read";
        return;
      }
      if (shuttingDown || generation !== restartGeneration || !desiredRunning) return;
      try {
        let attemptedStart = false;
        await withLifecycleLock(async () => {
          assertManagerIsSelf();
          if (activeProcess || !readState(paths).desiredRunning || shuttingDown) return;
          const listeners = readPortListeners();
          if (listenerPortIsBusy(listeners)) {
            throw new Error("CLIProxy port 8317 is owned by another process");
          }
          attemptedStart = true;
          await startCurrentVersion();
        });
        if (activeProcess) {
          lifecycleLog("cliproxy.recovery.completed");
          // This runs after the lifecycle lock was released, so provider sync
          // can take the same lock for its private management RMW safely.
          await reconcileAfterAutomaticRecovery();
          return;
        }
        if (!attemptedStart) return;
      } catch (error) {
        lifecycleLog("cliproxy.recovery.failed", "ERROR", { attempt: restartAttempts });
        lastError = error instanceof Error ? error.message : "CLIProxy restart failed";
      }
    }
    if (restartAttempts >= MAX_RESTARTS && !activeProcess) {
      lifecycleLog("cliproxy.recovery.exhausted", "ERROR");
      lastError = `CLIProxy exited with code ${exitCode}; restart limit reached`;
    }
  })().finally(() => {
    const operationIndex = operationQueue.indexOf(operation);
    if (operationIndex >= 0) operationQueue.splice(operationIndex, 1);
    restartTask = undefined;
    const next = pendingRestart;
    pendingRestart = undefined;
    if (next) void scheduleRestart(next.record, next.exitCode, next.generation);
  });
  await restartTask;
}

async function startCurrentVersion(): Promise<void> {
  const version = currentVersion(paths);
  if (!version) throw new Error("No valid CLIProxy version is installed");
  ensureConfig(paths);
  const listeners = readPortListeners();
  if (listenerPortIsBusy(listeners)) {
    throw new Error("CLIProxy port 8317 is owned by another process");
  }

  const executablePath = fs.realpathSync(path.join(paths.current, CLIPROXY_EXECUTABLE_NAME));
  const manager = getSelfIdentity();
  const child = Bun.spawn([executablePath, "-config", paths.config, ...(process.env.CLIPROXY_LOCAL_MODELS === "true" ? ["-local-model"] : [])], {
    cwd: paths.root,
    env: childEnvironment(paths.root),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });

  // /proc can briefly still describe the pre-exec child immediately after spawn.
  // Wait for the owned executable rather than treating that scheduling race as a failure.
  let identity = readProcIdentity(child.pid);
  const identityDeadline = Date.now() + 1_000;
  while (identity?.executablePath !== executablePath && child.exitCode === null && Date.now() < identityDeadline) {
    await delay(5);
    identity = readProcIdentity(child.pid);
  }
  if (!identity || identity.executablePath !== executablePath) {
    child.kill("SIGKILL");
    throw new Error("Unable to verify the spawned CLIProxy executable identity");
  }
  const record: ProcessRecord = {
    pid: child.pid,
    ...identity,
    version,
    managerPid: manager.pid,
    managerStartTime: manager.startTime,
    managerExecutablePath: manager.executablePath,
    startedAt: new Date().toISOString(),
  };
  try {
    writeProcessRecord(record);
  } catch (error) {
    child.kill("SIGTERM");
    await Promise.race([child.exited, delay(TERM_TIMEOUT_MS)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    throw error;
  }
  activeProcess = child;
  activeRecord = record;
  monitorChild(child, record);

  try {
    await waitUntilHealthy(record);
    lastError = null;
  } catch (error) {
    await stopActiveChild();
    throw error;
  }
}

async function installLocked(input: string): Promise<string> {
  const desiredVersion = input === "latest" ? (await getAvailableVersions()).latest : normalizeVersion(input);
  const state = readState(paths);
  const oldVersion = currentVersion(paths);
  if (oldVersion === desiredVersion) {
    state.installedVersion = oldVersion;
    state.pinnedVersion = input === "latest" ? null : desiredVersion;
    writeState(paths, state);
    if (state.desiredRunning && !activeProcess) {
      await reconcileStaleChild();
      await startCurrentVersion();
    }
    return desiredVersion;
  }

  const previouslyInstalled = Boolean(oldVersion || state.installedVersion);
  const runAfterInstall = shouldStartAfterInstall(state.desiredRunning, previouslyInstalled);
  await prepareVersion(paths, desiredVersion);
  const transaction: UpdateTransaction = {
    fromVersion: oldVersion,
    toVersion: desiredVersion,
    previousPin: state.pinnedVersion,
    previousDesiredRunning: state.desiredRunning,
  };
  writeAtomic(paths.transaction, `${JSON.stringify(transaction, null, 2)}\n`);

  try {
    await stopActiveChild();
    if (!activeProcess) await reconcileStaleChild();
    snapshotConfiguration(paths);
    setCurrentVersion(paths, desiredVersion);
    if (runAfterInstall) {
      if (!state.desiredRunning) {
        const startingState = readState(paths);
        startingState.desiredRunning = true;
        writeState(paths, startingState);
      }
      await startCurrentVersion();
    }

    const committed = readState(paths);
    committed.installedVersion = desiredVersion;
    committed.pinnedVersion = input === "latest" ? null : desiredVersion;
    committed.desiredRunning = runAfterInstall;
    writeState(paths, committed);
    fs.rmSync(paths.transaction, { force: true });
    discardConfigurationBackup(paths);
    return desiredVersion;
  } catch (error) {
    let rollbackError: unknown;
    try {
      await stopActiveChild();
      restoreConfiguration(paths);
      if (oldVersion) setCurrentVersion(paths, oldVersion);
      else removeCurrentVersion(paths, desiredVersion);
      const restored = readState(paths);
      restored.installedVersion = oldVersion;
      restored.pinnedVersion = transaction.previousPin;
      restored.desiredRunning = transaction.previousDesiredRunning ?? state.desiredRunning;
      writeState(paths, restored);
      if (restored.desiredRunning && oldVersion) await startCurrentVersion();
      fs.rmSync(paths.transaction, { force: true });
      discardConfigurationBackup(paths);
    } catch (failure) {
      rollbackError = failure;
    }
    if (rollbackError) {
      throw new Error(
        `CLIProxy update failed and rollback needs startup recovery: ${
          error instanceof Error ? error.message : "unknown update error"
        }`
      );
    }
    throw error;
  }
}

export async function initCliproxy(): Promise<void> {
  await withOperation("initializing", () =>
    withLifecycleLock(async () => {
      ensureLayout(paths);
      cleanupStagingVersions(paths);
      seedBundledVersion();
      const initialState = readState(paths);
      if (!fs.existsSync(paths.state)) writeState(paths, initialState);
      assertManagerIsSelf();
      await recoverInterruptedUpdate();
      if (
        !activeProcess ||
        !activeRecord ||
        !recordIdentityMatches(activeRecord) ||
        !listenersSecurelyOwnedBy(activeRecord)
      ) {
        await reconcileStaleChild();
      }
      ensureConfig(paths);
      registerManager();
      shuttingDown = false;
      invalidateRestartGeneration();
      registerShutdownSignals();

      const state = readState(paths);
      const startupAction = getStartupAction(state.desiredRunning, currentVersion(paths) !== null);
      if (startupAction === "start") {
        if (activeProcess && activeRecord) await waitUntilHealthy(activeRecord);
        else await startCurrentVersion();
      } else if (startupAction === "missing-install") {
        lastError = "CLIProxy is marked to run but no version is installed; install a version manually";
      }
    })
  );
}

export async function shutdownCliproxy(): Promise<void> {
  shuttingDown = true;
  invalidateRestartGeneration();
  if (restartTask) await restartTask;
  await withLifecycleLock(async () => {
    assertManagerIsSelf();
    await recoverInterruptedUpdate();
    await stopActiveChild();
    await reconcileStaleChild();
    const manager = readManagerRecord();
    const self = getSelfIdentity();
    if (manager?.pid === self.pid && manager.startTime === self.startTime) {
      fs.rmSync(paths.manager, { force: true });
    }
  });
}

export async function getStatus(): Promise<CliproxyStatus> {
  let state = defaultState();
  let processRecord: ProcessRecord | null = null;
  let version: string | null = null;
  let statusError = lastError;
  try {
    state = readState(paths);
    processRecord = readProcessRecord();
    version = currentVersion(paths);
  } catch (error) {
    statusError = error instanceof Error ? error.message : "CLIProxy status could not be read";
  }

  let listeners = readPortListeners();
  let processRunning = Boolean(
    processRecord &&
      recordIdentityMatches(processRecord) &&
      listenersOwnedBy(processRecord, listeners)
  );
  let loopbackOnly = listenersLoopbackOnly(listeners);
  let conflict = listenerPortIsBusy(listeners) && (!processRunning || !loopbackOnly);
  let healthy = false;
  if (processRunning && loopbackOnly && (await probeApiHealth())) {
    listeners = readPortListeners();
    processRunning = Boolean(
      processRecord &&
        recordIdentityMatches(processRecord) &&
        listenersOwnedBy(processRecord, listeners)
    );
    loopbackOnly = listenersLoopbackOnly(listeners);
    conflict = listenerPortIsBusy(listeners) && (!processRunning || !loopbackOnly);
    healthy = processRunning && loopbackOnly;
  }
  const installed = Boolean(version && isInstalledVersion(paths, version));
  return {
    installed,
    version,
    pinnedVersion: state.pinnedVersion,
    desiredRunning: state.desiredRunning,
    processRunning,
    healthy,
    conflict,
    operation: currentOperation(),
    restartAttempts,
    lastError: statusError,
  };
}

export async function getVersions(): Promise<CliproxyVersions> {
  const available = await getAvailableVersions();
  let state = defaultState();
  let current: string | null = null;
  try {
    state = readState(paths);
    current = currentVersion(paths);
  } catch {
    // Release discovery remains useful even if local state needs repair.
  }
  return { ...available, current, pinned: state.pinnedVersion };
}

export async function install(version: string): Promise<string> {
  const normalizedInput = version === "latest" ? version : normalizeVersion(version);
  return withOperation("installing", () =>
    withLifecycleLock(async () => {
      assertManagerIsSelf();
      await recoverInterruptedUpdate();
      const state = readState(paths);
      if (!fs.existsSync(paths.state)) writeState(paths, state);
      ensureConfig(paths);
      registerManager();
      return installLocked(normalizedInput);
    })
  );
}

export async function start(): Promise<void> {
  await withOperation("starting", () =>
    withLifecycleLock(async () => {
      assertManagerIsSelf();
      await recoverInterruptedUpdate();
      if (!currentVersion(paths)) {
        throw new Error("No CLIProxy version is installed; install a version before starting");
      }
      registerManager();
      const state = readState(paths);
      state.desiredRunning = true;
      writeState(paths, state);
      shuttingDown = false;
      invalidateRestartGeneration();
      restartAttempts = 0;
      if (activeProcess) {
        if (
          activeRecord &&
          recordIdentityMatches(activeRecord) &&
          listenersSecurelyOwnedBy(activeRecord)
        ) {
          await waitUntilHealthy(activeRecord);
          return;
        }
        await stopActiveChild();
      } else {
        await reconcileStaleChild();
      }
      await startCurrentVersion();
    })
  );
}

export async function stop(): Promise<void> {
  await withOperation("stopping", () =>
    withLifecycleLock(async () => {
      assertManagerIsSelf();
      await recoverInterruptedUpdate();
      const state = readState(paths);
      state.desiredRunning = false;
      writeState(paths, state);
      invalidateRestartGeneration();
      restartAttempts = 0;
      if (activeProcess) {
        await stopActiveChild();
      } else {
        const record = readProcessRecord();
        if (record && recordIdentityMatches(record) && listenersOwnedBy(record)) {
          await stopRecord(record, true);
          removeProcessRecord(record);
        }
      }
    })
  );
}

export async function restart(): Promise<void> {
  await withOperation("restarting", () =>
    withLifecycleLock(async () => {
      assertManagerIsSelf();
      await recoverInterruptedUpdate();
      if (!currentVersion(paths)) {
        throw new Error("No CLIProxy version is installed; install a version before restarting");
      }
      registerManager();
      const state = readState(paths);
      state.desiredRunning = true;
      writeState(paths, state);
      invalidateRestartGeneration();
      restartAttempts = 0;
      shuttingDown = false;
      await stopActiveChild();
      await reconcileStaleChild();
      await startCurrentVersion();
    })
  );
}

export function getApiKey(): string {
  return readSecret(paths.apiKey);
}
