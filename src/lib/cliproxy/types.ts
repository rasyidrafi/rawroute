export interface AvailableVersions { latest: string; versions: Array<{ version: string; publishedAt: string | null }> }
export type CliproxyOperationName =
  | "initializing"
  | "installing"
  | "starting"
  | "stopping"
  | "restarting";

export interface CliproxyOperation {
  name: CliproxyOperationName;
  startedAt: string;
}

export interface CliproxyStatus {
  installed: boolean;
  version: string | null;
  pinnedVersion: string | null;
  desiredRunning: boolean;
  processRunning: boolean;
  healthy: boolean;
  conflict: boolean;
  operation: CliproxyOperation | null;
  restartAttempts: number;
  lastError: string | null;
}

export interface CliproxyVersions extends AvailableVersions {
  current: string | null;
  pinned: string | null;
}


export type CliproxyInstanceStatus = CliproxyStatus & { mode: "managed" | "external"; activeRequests: number };
