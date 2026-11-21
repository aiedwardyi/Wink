// Per-PC presence records in the sync folder so a phone can jump between PCs.
// Records carry only a name, a public tailnet or relay host and a timestamp: never a key or cookie.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname, platform, userInfo } from "node:os";
import { basename, join, resolve } from "node:path";

import { z } from "zod";

import { labelFromHost } from "../shared/relay-protocol.ts";
import { writeFileAtomic } from "./atomic.ts";

export const DEVICE_DIR = "devices";
export const DEVICE_HEARTBEAT_MS = 5 * 60_000;
export const DEVICE_STALE_MS = 15 * 60_000;
export const DEVICE_NAME_FILE = "device-name.json";
const MAX_DEVICE_FILES = 64;
const LEGACY_MACHINE_KEY_LENGTH = 16;

export const deviceNameSchema = z.string().trim().min(1).max(64);

const deviceSchema = z.object({
  deviceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/),
  name: deviceNameSchema,
  host: z.string().max(253).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/),
  /** `<label>.<base>` when this PC is enrolled with the phone relay. A relay-only PC repeats it as `host`. */
  relayHost: z.string().max(253).regex(/^[a-z2-7]{16}(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/).optional().catch(undefined),
  lastSeen: z.number().int().nonnegative(),
  laptop: z.boolean().optional(),
  chatSync: z.literal(2).optional(),
  machine: z.string().regex(/^(?:[0-9a-f]{16}|[0-9a-f]{32})$/).optional().catch(undefined),
  /** PCs this PC removed from the list, by id, with when; one shows again once it runs Wink after that. */
  removed: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/), z.number().int().nonnegative())
    .refine((value) => Object.keys(value).length <= MAX_DEVICE_FILES).optional().catch(undefined),
});

export type DeviceRecord = z.infer<typeof deviceSchema>;
export type DeviceListItem = DeviceRecord & { current: boolean; offline: boolean; checking?: boolean; unreachable?: boolean };

export function namedDevicePeers<T extends { name: string; host: string }>(peers: T[], devices: { name: string; host: string; relayHost?: string }[], teamBase: string | null = null): (T & { relayHost?: string })[] {
  const byHost = new Map(devices.map((device) => [device.host, device]));
  return peers.map((peer) => {
    const device = byHost.get(peer.host);
    const relayHost = teamBase !== null && device?.relayHost && labelFromHost(device.relayHost, teamBase) !== null ? device.relayHost : undefined;
    return { ...peer, name: device?.name.trim() || peer.name, ...(relayHost ? { relayHost } : {}) };
  });
}

export function writeDeviceRecord(folder: string, record: Omit<DeviceRecord, "lastSeen">, now: number): void {
  const parsed = deviceSchema.parse({ deviceId: record.deviceId, name: record.name, host: record.host, relayHost: record.relayHost, lastSeen: now, laptop: record.laptop, chatSync: record.chatSync, machine: record.machine, removed: record.removed && Object.keys(record.removed).length ? record.removed : undefined });
  const directory = join(folder, DEVICE_DIR);
  mkdirSync(directory, { recursive: true });
  writeFileAtomic(join(directory, `${parsed.deviceId}.json`), `${JSON.stringify(parsed, null, 2)}\n`);
}

/** A battery means a laptop, so the picker can show the right icon. */
export function detectLaptop(): Promise<boolean> {
  if (process.platform === "linux") {
    try {
      return Promise.resolve(readdirSync("/sys/class/power_supply").some((name) => name.startsWith("BAT")));
    } catch {
      return Promise.resolve(false);
    }
  }
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "@(Get-CimInstance Win32_Battery).Count"],
      { windowsHide: true, timeout: 15_000 },
      (error, stdout) => resolve(!error && Number(stdout.trim()) > 0),
    );
  });
}

/** This PC's saved name, local only; null when unset or invalid. */
export function loadDeviceName(dataDir: string): string | null {
  try {
    const parsed = deviceNameSchema.safeParse(JSON.parse(readFileSync(join(dataDir, DEVICE_NAME_FILE), "utf8")).name);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveDeviceName(dataDir: string, name: string): string {
  const parsed = deviceNameSchema.parse(name);
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(join(dataDir, DEVICE_NAME_FILE), `${JSON.stringify({ name: parsed }, null, 2)}
`);
  return parsed;
}

export function deviceDisplayName(saved: string | null, envName: string | undefined, hostname: string): string {
  return saved || envName?.trim() || hostname;
}

/** Valid records by name; a mirror still catching up leaves peer presence unknown. */
export function listDevices(folder: string, currentId: string, now: number, limit = MAX_DEVICE_FILES, known: (deviceId: string) => boolean = () => true): DeviceListItem[] {
  const directory = join(folder, DEVICE_DIR);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const items: DeviceListItem[] = [];
  for (const name of names.filter((value) => value.endsWith(".json")).sort().slice(0, limit)) {
    try {
      const parsed = deviceSchema.safeParse(JSON.parse(readFileSync(join(directory, basename(name)), "utf8")));
      if (!parsed.success) continue;
      const current = parsed.data.deviceId === currentId;
      const checking = !current && !known(parsed.data.deviceId);
      items.push({ ...parsed.data, current, offline: !current && !checking && now - parsed.data.lastSeen > DEVICE_STALE_MS, checking });
    } catch {}
  }
  const removedAt = new Map<string, number>();
  for (const item of items) for (const [id, at] of Object.entries(item.removed ?? {})) removedAt.set(id, Math.max(at, removedAt.get(id) ?? 0));
  // A PC whose ~/.orbit was wiped comes back under a new id; only its newest record shows.
  const outranks = (a: DeviceListItem, b: DeviceListItem) => a.current || (!b.current && (a.lastSeen > b.lastSeen || (a.lastSeen === b.lastSeen && a.deviceId > b.deviceId)));
  return items
    .filter((item) => !items.some((other) => other !== item && samePc(item, other) && outranks(other, item)))
    .filter((item) => item.current || item.lastSeen > (removedAt.get(item.deviceId) ?? -1))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function samePc(a: DeviceRecord, b: DeviceRecord): boolean {
  if (a.machine && b.machine) {
    if (a.machine.length === b.machine.length) return a.machine === b.machine;
    // A pre-upgrade key needs the same tailnet host to disambiguate matching names and paths.
    if (a.machine.slice(0, LEGACY_MACHINE_KEY_LENGTH) !== b.machine.slice(0, LEGACY_MACHINE_KEY_LENGTH)) return false;
  }
  // A relay host is per install.
  return a.host !== a.relayHost && a.host === b.host;
}

function readOsMachineId(): string | undefined {
  const options = { encoding: "utf8", stdio: "pipe", timeout: 1_000 } as const;
  let value: string | undefined;
  try {
    switch (platform()) {
      case "win32":
        value = execFileSync("reg.exe", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"], { ...options, windowsHide: true })
          .match(/\bMachineGuid\s+REG_SZ\s+(\S+)/i)?.[1];
        break;
      case "darwin":
        value = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { ...options, windowsHide: true })
          .match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1];
        break;
      case "linux":
        value = readFileSync("/etc/machine-id", "utf8").trim();
        break;
    }
  } catch {
    return undefined;
  }
  const id = value?.replaceAll("-", "").toLowerCase();
  return id && /^[0-9a-f]{32}$/.test(id) && !/^0+$/.test(id) ? id : undefined;
}

/** Stable across a reinstall on one PC; different on a PC that got a copied ~/.orbit, or for a second data dir on one PC. */
export function machineKey(dataDir: string): string | undefined {
  const id = readOsMachineId();
  if (!id) return undefined;
  let user = "";
  try {
    user = userInfo().username;
  } catch {}
  const local = ["wink-device", hostname(), user, homedir(), resolve(dataDir)].join("\0");
  const legacy = createHash("sha256").update(local).digest("hex").slice(0, LEGACY_MACHINE_KEY_LENGTH);
  const machine = createHash("sha256").update(`${local}\0${id}`).digest("hex").slice(0, LEGACY_MACHINE_KEY_LENGTH);
  return legacy + machine;
}

/** Removals still in force: one whose PC ran Wink again, or whose record is gone, drops out. */
export function heldRemovals(folder: string, removed: Record<string, number>): Record<string, number> {
  const seen = new Map(scanDevices(folder).records.map((record) => [record.deviceId, record.lastSeen]));
  return Object.fromEntries(Object.entries(removed).filter(([id, at]) => (seen.get(id) ?? Infinity) <= at).slice(-MAX_DEVICE_FILES));
}

/**
 * What the picker may navigate to: relay hosts under this PC's base for a relay phone, tailnet hosts otherwise.
 * A desktop gets a PC's relay host under the baked team base while its tailnet host does not answer.
 * This PC's own app also gets the trusted relay host of a PC it opens on the tailnet, for that window's pairing page.
 */
export function pickerDevices(items: DeviceListItem[], relayBase: string | null, teamBase: string | null = null, now = Date.now(), localDesktop = false): Omit<DeviceListItem, "unreachable">[] {
  return items.flatMap(({ relayHost, unreachable, ...item }) => {
    if (relayBase === null) {
      const team = teamBase !== null && relayHost !== undefined && labelFromHost(relayHost, teamBase) !== null;
      if (item.host === relayHost) return team ? [item] : [];
      // A failed tailnet probe says nothing about the relay, so the record's own freshness decides.
      if (team && (item.offline || unreachable)) return [{ ...item, host: relayHost, offline: !item.current && now - item.lastSeen > DEVICE_STALE_MS, checking: false }];
      return [team && localDesktop && !item.current ? { ...item, relayHost } : item];
    }
    return relayHost && labelFromHost(relayHost, relayBase) ? [{ ...item, host: relayHost }] : [];
  });
}

export interface DeviceScan {
  rootError: boolean;
  dirError: "absent" | "unreadable" | null;
  records: DeviceRecord[];
  unreadable: { stem: string; mtimeMs: number | null }[];
}

/** Presence scan for cutover. Read failures stay visible; the phone picker still uses listDevices. */
export function scanDevices(folder: string): DeviceScan {
  const empty = { records: [], unreadable: [] };
  try {
    if (!statSync(folder).isDirectory()) return { rootError: true, dirError: null, ...empty };
  } catch {
    return { rootError: true, dirError: null, ...empty };
  }
  let names: string[];
  try {
    names = readdirSync(join(folder, DEVICE_DIR));
  } catch (error) {
    // SAFETY: Filesystem failures expose Node's errno code.
    const code = (error as NodeJS.ErrnoException).code;
    return { rootError: false, dirError: code === "ENOENT" ? "absent" : "unreadable", ...empty };
  }
  const records: DeviceRecord[] = [];
  const unreadable: DeviceScan["unreadable"] = [];
  for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
    const path = join(folder, DEVICE_DIR, basename(name));
    let mtimeMs: number | null;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      mtimeMs = null;
    }
    try {
      const parsed = deviceSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (!parsed.success) unreadable.push({ stem: basename(name, ".json"), mtimeMs });
      else records.push(parsed.data);
    } catch {
      unreadable.push({ stem: basename(name, ".json"), mtimeMs });
    }
  }
  return { rootError: false, dirError: null, records, unreadable };
}
