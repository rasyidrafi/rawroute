import * as fs from "node:fs";
import * as path from "node:path";
import { CLIPROXY_HOST, CLIPROXY_PORT } from "./store";

export interface ProcessIdentity {
  startTime: string;
  executablePath: string;
}

export interface PortListeners {
  ownersByInode: Map<string, Set<number>>;
  addressesByInode: Map<string, Set<string>>;
}

export function parseProcStartTime(statContents: string): string | null {
  const closingParen = statContents.lastIndexOf(")");
  if (closingParen < 0) return null;
  const fieldsAfterCommand = statContents.slice(closingParen + 1).trim().split(/\s+/);
  return fieldsAfterCommand[19] || null;
}

export function parseListeningSockets(
  contents: string,
  port: number,
  family: "ipv4" | "ipv6"
): Array<{ inode: string; address: string }> {
  const listeners: Array<{ inode: string; address: string }> = [];
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  for (const line of contents.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== "0A") continue;
    const separator = fields[1].lastIndexOf(":");
    const addressHex = fields[1].slice(0, separator).toUpperCase();
    const localPort = fields[1].slice(separator + 1).toUpperCase();
    if (localPort !== portHex || !/^\d+$/.test(fields[9])) continue;
    const address = family === "ipv4" ? decodeProcIpv4Address(addressHex) : `ipv6:${addressHex}`;
    listeners.push({ inode: fields[9], address });
  }
  return listeners;
}

export function areAllLoopbackListeners(
  addresses: Iterable<string>,
  expectedHost = CLIPROXY_HOST
): boolean {
  const listenerAddresses = [...addresses];
  return listenerAddresses.length > 0 && listenerAddresses.every((address) => address === expectedHost);
}

export function readProcIdentity(pid: number, procRoot = "/proc"): ProcessIdentity | null {
  try {
    const startTime = parseProcStartTime(fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8"));
    const executablePath = fs.readlinkSync(path.join(procRoot, String(pid), "exe"));
    if (!startTime || executablePath.endsWith(" (deleted)")) return null;
    return { startTime, executablePath: path.resolve(executablePath) };
  } catch {
    return null;
  }
}

export function processIdentityMatches(
  pid: number,
  expectedStartTime: string,
  expectedExecutablePath: string,
  procRoot = "/proc"
): boolean {
  const actual = readProcIdentity(pid, procRoot);
  return Boolean(
    actual &&
      actual.startTime === expectedStartTime &&
      actual.executablePath === path.resolve(expectedExecutablePath)
  );
}

export function readPortListeners(port = CLIPROXY_PORT, procRoot = "/proc"): PortListeners {
  const addressesByInode = new Map<string, Set<string>>();
  for (const [table, family] of [
    ["tcp", "ipv4"],
    ["tcp6", "ipv6"],
  ] as const) {
    try {
      const contents = fs.readFileSync(path.join(procRoot, "net", table), "utf8");
      for (const listener of parseListeningSockets(contents, port, family)) {
        const addresses = addressesByInode.get(listener.inode) ?? new Set<string>();
        addresses.add(listener.address);
        addressesByInode.set(listener.inode, addresses);
      }
    } catch {
      continue;
    }
  }

  const ownersByInode = new Map<string, Set<number>>(
    [...addressesByInode.keys()].map((inode) => [inode, new Set<number>()])
  );
  if (addressesByInode.size === 0) return { ownersByInode, addressesByInode };

  let processEntries: fs.Dirent[];
  try {
    processEntries = fs.readdirSync(procRoot, { withFileTypes: true });
  } catch {
    return { ownersByInode, addressesByInode };
  }
  for (const entry of processEntries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    let descriptors: string[];
    try {
      descriptors = fs.readdirSync(path.join(procRoot, entry.name, "fd"));
    } catch {
      continue;
    }
    for (const descriptor of descriptors) {
      try {
        const target = fs.readlinkSync(path.join(procRoot, entry.name, "fd", descriptor));
        const match = target.match(/^socket:\[(\d+)\]$/);
        const owners = match ? ownersByInode.get(match[1]) : undefined;
        owners?.add(pid);
      } catch {
        continue;
      }
    }
  }
  return { ownersByInode, addressesByInode };
}

export function listenersOwnedBy(pid: number, listeners: PortListeners): boolean {
  const inodes = [...listeners.ownersByInode.entries()];
  return inodes.length > 0 && inodes.every((entry) => entry[1].size === 1 && entry[1].has(pid));
}

export function listenersLoopbackOnly(
  listeners: PortListeners,
  expectedHost = CLIPROXY_HOST
): boolean {
  const addresses = [...listeners.addressesByInode.entries()];
  return (
    addresses.length > 0 &&
    addresses.every(
      (entry) => entry[1].size === 1 && areAllLoopbackListeners(entry[1], expectedHost)
    )
  );
}

export function listenersSecurelyOwnedBy(
  pid: number,
  listeners: PortListeners,
  expectedHost = CLIPROXY_HOST
): boolean {
  return listenersOwnedBy(pid, listeners) && listenersLoopbackOnly(listeners, expectedHost);
}

export function listenerPortIsBusy(listeners: PortListeners): boolean {
  return listeners.ownersByInode.size > 0;
}

function decodeProcIpv4Address(addressHex: string): string {
  if (!/^[a-f\d]{8}$/i.test(addressHex)) return `invalid:${addressHex}`;
  const bytes = addressHex.match(/../g);
  return bytes ? bytes.reverse().map((byte) => Number.parseInt(byte, 16)).join(".") : "invalid";
}
