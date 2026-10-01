export type CliproxyInstallAction = {
  type: "install";
  version: string;
  requestVersion: string;
  downgrade: boolean;
};

function compareVersions(left: string, right: string): number {
  const parse = (version: string) => {
    const release = version.split("+", 1)[0] ?? version;
    const prereleaseSeparator = release.indexOf("-");
    const numeric = prereleaseSeparator < 0 ? release : release.slice(0, prereleaseSeparator);
    const prerelease = prereleaseSeparator < 0 ? undefined : release.slice(prereleaseSeparator + 1);
    return {
      numbers: numeric.split(".").map(Number),
      prerelease: prerelease?.split(".") ?? [],
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index++) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return a.prerelease.length === b.prerelease.length
      ? 0
      : a.prerelease.length
        ? -1
        : 1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) {
      return Math.sign(leftNumber - rightNumber);
    }
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function createInstallAction(
  requestVersion: string,
  latestVersion: string | null,
  currentVersion: string | null,
): CliproxyInstallAction {
  const version = requestVersion === "latest" ? latestVersion ?? "latest" : requestVersion;
  return {
    type: "install",
    version,
    requestVersion,
    downgrade: Boolean(
      version !== "latest" &&
        currentVersion &&
        compareVersions(version, currentVersion) < 0,
    ),
  };
}

export function statusPollInterval(operationPending: boolean): number {
  return operationPending ? 1_500 : 5_000;
}

export function lifecycleControlsBlocked({
  hasStatus,
  operationPending,
  actionBusy,
  statusRefreshing,
  conflict,
}: {
  hasStatus: boolean;
  operationPending: boolean;
  actionBusy: boolean;
  statusRefreshing: boolean;
  conflict: boolean;
}): boolean {
  return !hasStatus || operationPending || actionBusy || statusRefreshing || conflict;
}

export function releaseControlsBlocked(
  lifecycleBlocked: boolean,
  versionsAvailable: boolean,
  versionsRefreshing: boolean,
): boolean {
  return lifecycleBlocked || !versionsAvailable || versionsRefreshing;
}

export function canInstallExactRelease(
  selectedVersion: string | null,
  currentVersion: string | null,
  pinnedVersion: string | null,
): boolean {
  return Boolean(
    selectedVersion &&
      !(selectedVersion === currentVersion && selectedVersion === pinnedVersion),
  );
}

export function releaseCatalogPresentation(
  latestVersion: string | null,
  error: string | null,
): { summary: string; staleError: string | null } {
  if (latestVersion) {
    return {
      summary: `Latest available: ${latestVersion}${error ? " · showing cached catalog" : ""}`,
      staleError: error ? `Could not refresh releases. ${error}` : null,
    };
  }
  return { summary: error ?? "Release catalog unavailable.", staleError: null };
}
