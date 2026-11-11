import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createDevicePresence } from "./device-presence.ts";
import {
  DEVICE_DIR,
  DEVICE_STALE_MS,
  deviceDisplayName,
  listDevices,
  loadDeviceName,
  namedDevicePeers,
  pickerDevices,
  saveDeviceName,
  scanDevices,
  writeDeviceRecord,
} from "./device-sync.ts";
import { createTempDirs } from "./testing/cleanup.ts";

const temps = createTempDirs();
afterAll(() => temps.remove());

const NOW = 1_800_000_000_000;
const freshDir = () => temps.make(join(tmpdir(), "orbit-devices-"));
const rec = (id: string, host = `${id}.tail1234.ts.net`) => ({ deviceId: id, name: id, host });

describe("device sync", () => {
  it("keeps launch presence checking until its mirror record is known", () => {
    const folder = freshDir();
    for (const id of ["home", "laptop", "work"]) writeDeviceRecord(folder, rec(id), NOW - DEVICE_STALE_MS - 1);
    const items = listDevices(folder, "home", NOW, undefined, (id) => id === "laptop");
    expect(items.find((item) => item.deviceId === "home")).toMatchObject({ current: true, offline: false, checking: false });
    expect(items.find((item) => item.deviceId === "work")).toMatchObject({ offline: false, checking: true });
    expect(items.find((item) => item.deviceId === "laptop")).toMatchObject({ offline: true, checking: false });
  });

  it("uses Wink names for setup peers and keeps host names only as a fallback", () => {
    const peers = [rec("desktop"), rec("laptop"), rec("unknown")];
    const devices = [{ ...rec("desktop"), name: "Home" }, { ...rec("laptop"), name: "Work" }];
    expect(namedDevicePeers(peers, devices)).toEqual([
      { ...rec("desktop"), name: "Home" }, { ...rec("laptop"), name: "Work" }, rec("unknown"),
    ]);
    expect(namedDevicePeers(peers, [{ ...rec("desktop"), name: "  " }])[0]?.name).toBe("desktop");
  });

  it("writes name, host and time only, never a secret", () => {
    const folder = freshDir();
    writeDeviceRecord(folder, { ...rec("home"), key: "a".repeat(64), cookie: "orbit_remote=x" } as never, NOW);
    const text = readFileSync(join(folder, DEVICE_DIR, "home.json"), "utf8");
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["deviceId", "host", "lastSeen", "name"]);
    expect(text).not.toMatch(/key|cookie|orbit_remote|a{64}/);
  });

  it("keeps the laptop flag", () => {
    const folder = freshDir();
    writeDeviceRecord(folder, { ...rec("laptop"), laptop: true }, NOW);
    writeDeviceRecord(folder, rec("home"), NOW);
    expect(listDevices(folder, "home", NOW).map((d) => [d.deviceId, d.laptop])).toEqual([["home", undefined], ["laptop", true]]);
  });

  it("rejects a host that is not a plain hostname", () => {
    expect(() => writeDeviceRecord(freshDir(), rec("home", "evil.com/x?y"), NOW)).toThrow();
  });

  it("ignores corrupt, invalid and non-json files", () => {
    const folder = freshDir();
    writeDeviceRecord(folder, rec("home"), NOW);
    const dir = join(folder, DEVICE_DIR);
    writeFileSync(join(dir, "bad.json"), "{nope");
    writeFileSync(join(dir, "wrong.json"), JSON.stringify({ deviceId: "x", name: "x", host: "https://evil.com", lastSeen: NOW }));
    writeFileSync(join(dir, "notes.txt"), "hi");
    expect(listDevices(folder, "home", NOW).map((d) => d.deviceId)).toEqual(["home"]);
    expect(readdirSync(dir)).toHaveLength(4);
  });

  it("returns nothing when the folder has no records", () => {
    const folder = freshDir();
    expect(listDevices(folder, "home", NOW)).toEqual([]);
    mkdirSync(join(folder, DEVICE_DIR));
    expect(listDevices(folder, "home", NOW)).toEqual([]);
  });

  it("marks the current device", () => {
    const folder = freshDir();
    for (const id of ["home", "work", "laptop"]) writeDeviceRecord(folder, rec(id), NOW);
    const list = listDevices(folder, "work", NOW);
    expect(list.map((d) => [d.deviceId, d.current])).toEqual([["home", false], ["laptop", false], ["work", true]]);
  });

  it("marks a device offline once its record is stale", () => {
    const folder = freshDir();
    writeDeviceRecord(folder, rec("home"), NOW - DEVICE_STALE_MS - 1);
    writeDeviceRecord(folder, rec("work"), NOW - DEVICE_STALE_MS);
    const byId = Object.fromEntries(listDevices(folder, "x", NOW).map((d) => [d.deviceId, d.offline]));
    expect(byId).toEqual({ home: true, work: false });
  });

  it("saves a trimmed name that a fresh load reads back", () => {
    const dataDir = freshDir();
    expect(loadDeviceName(dataDir)).toBeNull();
    expect(saveDeviceName(dataDir, "  Home  ")).toBe("Home");
    expect(loadDeviceName(dataDir)).toBe("Home");
  });

  it("rejects an empty or over-64 name", () => {
    const dataDir = freshDir();
    expect(() => saveDeviceName(dataDir, "   ")).toThrow();
    expect(() => saveDeviceName(dataDir, "x".repeat(65))).toThrow();
    expect(saveDeviceName(dataDir, "x".repeat(64))).toHaveLength(64);
  });

  it("ignores a corrupt name file", () => {
    const dataDir = freshDir();
    writeFileSync(join(dataDir, "device-name.json"), "{nope");
    expect(loadDeviceName(dataDir)).toBeNull();
  });

  it("reports an unreadable root, a missing device directory, and bad records", () => {
    expect(scanDevices(join(freshDir(), "missing"))).toMatchObject({ rootError: true, records: [], unreadable: [] });
    const empty = freshDir();
    expect(scanDevices(empty)).toMatchObject({ rootError: false, dirError: "absent", records: [] });
    const folder = freshDir();
    writeDeviceRecord(folder, rec("home"), NOW);
    writeFileSync(join(folder, DEVICE_DIR, "work.json"), "{nope");
    writeFileSync(join(folder, DEVICE_DIR, "notes.txt"), "hi");
    const scan = scanDevices(folder);
    expect(scan.dirError).toBeNull();
    expect(scan.records.map((item) => item.deviceId)).toEqual(["home"]);
    expect(scan.unreadable.map((item) => item.stem)).toEqual(["work"]);
    expect(scan.unreadable[0]?.mtimeMs).toBeGreaterThan(0);
    expect(listDevices(folder, "home", NOW).map((item) => item.deviceId)).toEqual(["home"]);
  });

  it("prefers the saved name, then the env name, then the hostname", () => {
    expect(deviceDisplayName("Home", "Env", "EDWARD-PC")).toBe("Home");
    expect(deviceDisplayName(null, " Env ", "EDWARD-PC")).toBe("Env");
    expect(deviceDisplayName(null, "  ", "EDWARD-PC")).toBe("EDWARD-PC");
    expect(deviceDisplayName(null, undefined, "EDWARD-PC")).toBe("EDWARD-PC");
  });
});

describe("relay presence", () => {
  const BASE = "wink.test";
  const relay = (label: string) => `${label.padEnd(16, "a")}.${BASE}`;
  // The record schema shipped before relay presence, as older PCs still read it.
  const oldReader = z.object({
    deviceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/),
    name: z.string().trim().min(1).max(64),
    host: z.string().max(253).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/),
    lastSeen: z.number().int().nonnegative(),
    laptop: z.boolean().optional(),
    chatSync: z.literal(2).optional(),
  });

  it("keeps a relay host next to the tailnet host", () => {
    const folder = freshDir();
    writeDeviceRecord(folder, { ...rec("home"), relayHost: relay("home"), chatSync: 2 }, NOW);
    expect(listDevices(folder, "home", NOW)[0]).toMatchObject({ host: "home.tail1234.ts.net", relayHost: relay("home") });
  });

  it("stays readable by older PCs, including a relay-only record", () => {
    const folder = freshDir();
    writeDeviceRecord(folder, { ...rec("home"), relayHost: relay("home"), chatSync: 2 }, NOW);
    writeDeviceRecord(folder, { ...rec("cafe", relay("cafe")), relayHost: relay("cafe"), chatSync: 2 }, NOW);
    for (const id of ["home", "cafe"]) {
      expect(oldReader.safeParse(JSON.parse(readFileSync(join(folder, DEVICE_DIR, `${id}.json`), "utf8"))).success).toBe(true);
    }
    expect(scanDevices(folder).unreadable).toEqual([]);
  });

  it("reads old records and drops a relay host that is not a relay label", () => {
    const folder = freshDir();
    const dir = join(folder, DEVICE_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old.json"), JSON.stringify({ deviceId: "old", name: "Old", host: "old.tail1234.ts.net", lastSeen: NOW }));
    for (const [id, bad] of [["a", "evil.example"], ["b", "https://abcdefghijklmnop.wink.test"], ["c", "ABCDEFGHIJKLMNOP.wink.test"], ["d", 42]]) {
      writeFileSync(join(dir, `${id}.json`), JSON.stringify({ deviceId: id, name: id, host: `${id}.tail1234.ts.net`, relayHost: bad, lastSeen: NOW }));
    }
    const list = listDevices(folder, "old", NOW);
    expect(list.map((d) => [d.deviceId, d.relayHost])).toEqual([["a", undefined], ["b", undefined], ["c", undefined], ["d", undefined], ["old", undefined]]);
    expect(scanDevices(folder).unreadable).toEqual([]);
  });

  it("sends a relay phone only to relay hosts under this base", () => {
    const folder = freshDir();
    writeDeviceRecord(folder, { ...rec("home"), relayHost: relay("home") }, NOW);
    writeDeviceRecord(folder, { ...rec("cafe", relay("cafe")), relayHost: relay("cafe") }, NOW);
    writeDeviceRecord(folder, rec("work"), NOW);
    writeDeviceRecord(folder, { ...rec("lab"), relayHost: `${"l".padEnd(16, "a")}.other.test` }, NOW);
    const picked = pickerDevices(listDevices(folder, "home", NOW), BASE);
    expect(picked.map((d) => [d.deviceId, d.host, d.current])).toEqual([
      ["cafe", relay("cafe"), false],
      ["home", relay("home"), true],
    ]);
    expect(JSON.stringify(picked)).not.toContain("ts.net");
    expect(JSON.stringify(picked)).not.toContain("relayHost");
  });

  it("keeps the tailnet picker exactly as before", () => {
    const folder = freshDir();
    writeDeviceRecord(folder, { ...rec("home"), relayHost: relay("home") }, NOW);
    writeDeviceRecord(folder, { ...rec("cafe", relay("cafe")), relayHost: relay("cafe") }, NOW);
    writeDeviceRecord(folder, rec("work"), NOW);
    const picked = pickerDevices(listDevices(folder, "home", NOW), null);
    expect(picked).toEqual([
      { deviceId: "home", name: "home", host: "home.tail1234.ts.net", lastSeen: NOW, current: true, offline: false, checking: false },
      { deviceId: "work", name: "work", host: "work.tail1234.ts.net", lastSeen: NOW, current: false, offline: false, checking: false },
    ]);
  });

  it("pickerDevices keeps a relay-only PC on desktop with its relay host", () => {
    const folder = freshDir();
    const other = `${"l".padEnd(16, "a")}.other.test`;
    writeDeviceRecord(folder, rec("home"), NOW);
    writeDeviceRecord(folder, { ...rec("cafe", relay("cafe")), relayHost: relay("cafe") }, NOW);
    writeDeviceRecord(folder, { ...rec("lab", other), relayHost: other }, NOW);
    const picked = pickerDevices(listDevices(folder, "home", NOW), null, BASE, NOW);
    expect(picked.map((d) => [d.deviceId, d.host, d.offline])).toEqual([
      ["cafe", relay("cafe"), false],
      ["home", "home.tail1234.ts.net", false],
    ]);
    expect(JSON.stringify(picked)).not.toContain("relayHost");
  });

  it("gives a PC whose tailnet host does not answer its team relay host", () => {
    const folder = freshDir();
    writeDeviceRecord(folder, { ...rec("work"), relayHost: relay("work") }, NOW);
    const probed = listDevices(folder, "home", NOW).map((item) => ({ ...item, offline: true, checking: false }));
    expect(pickerDevices(probed, null, BASE, NOW)).toEqual([
      { deviceId: "work", name: "work", host: relay("work"), lastSeen: NOW, current: false, offline: false, checking: false },
    ]);
  });

  it.each([false, true])("keeps the first desktop pick on Tailscale before local host discovery (mirror known %s)", async (known) => {
    const folder = freshDir();
    writeDeviceRecord(folder, rec("home"), NOW);
    writeDeviceRecord(folder, { ...rec("work"), relayHost: relay("work") }, NOW - DEVICE_STALE_MS - 1);
    let answer!: (response: Response) => void;
    const request = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; }));
    const presence = createDevicePresence(request);
    const listed = listDevices(folder, "home", NOW, undefined, () => known);
    const pick = (host: string | undefined) => pickerDevices(presence(listed, host, true), null, BASE, NOW);
    expect(pick(undefined).find((item) => item.deviceId === "work")).toMatchObject({ host: "work.tail1234.ts.net", offline: false, checking: true });
    expect(request).not.toHaveBeenCalled();
    expect(pick("home.tail1234.ts.net").find((item) => item.deviceId === "work")).toMatchObject({ host: "work.tail1234.ts.net", offline: false, checking: true });
    answer(Response.json({ app: "openmausbot" }));
    await vi.waitFor(() => expect(pick("home.tail1234.ts.net").find((item) => item.deviceId === "work")).toMatchObject({ host: "work.tail1234.ts.net", offline: false, checking: false }));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("falls back to relay after a failed Tailscale probe following local host discovery", async () => {
    const folder = freshDir();
    writeDeviceRecord(folder, { ...rec("work"), relayHost: relay("work") }, NOW);
    const request = vi.fn().mockRejectedValue(new Error("offline"));
    const presence = createDevicePresence(request);
    const listed = listDevices(folder, "home", NOW);
    const pick = (host: string | undefined) => pickerDevices(presence(listed, host, true), null, BASE, NOW)[0];
    expect(pick(undefined)).toMatchObject({ host: "work.tail1234.ts.net", offline: false, checking: true });
    expect(request).not.toHaveBeenCalled();
    expect(pick("home.tail1234.ts.net")).toMatchObject({ host: "work.tail1234.ts.net", offline: false, checking: true });
    await vi.waitFor(() => expect(pick("home.tail1234.ts.net")).toMatchObject({ host: relay("work"), offline: false, checking: false }));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps relay fallback when local Tailscale discovery settles without a host", () => {
    const folder = freshDir();
    writeDeviceRecord(folder, { ...rec("work"), relayHost: relay("work") }, NOW - DEVICE_STALE_MS - 1);
    const request = vi.fn();
    const presence = createDevicePresence(request);
    const listed = listDevices(folder, "home", NOW);
    expect(pickerDevices(presence(listed, undefined, false), null, BASE, NOW)[0]).toMatchObject({ host: relay("work"), offline: true, checking: false });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps a PC whose tailnet host answers exactly as today", () => {
    const folder = freshDir();
    writeDeviceRecord(folder, { ...rec("home"), relayHost: relay("home") }, NOW);
    writeDeviceRecord(folder, { ...rec("work"), relayHost: relay("work") }, NOW);
    const listed = listDevices(folder, "home", NOW).map((item) => (item.current ? item : { ...item, checking: true }));
    expect(pickerDevices(listed, null, BASE, NOW)).toEqual(pickerDevices(listed, null));
    expect(pickerDevices(listed, null, BASE, NOW).map((d) => d.host)).toEqual(["home.tail1234.ts.net", "work.tail1234.ts.net"]);
  });

  it("no baked team relay keeps today's picker", () => {
    const folder = freshDir();
    writeDeviceRecord(folder, { ...rec("cafe", relay("cafe")), relayHost: relay("cafe") }, NOW);
    writeDeviceRecord(folder, { ...rec("work"), relayHost: relay("work") }, NOW);
    const listed = listDevices(folder, "home", NOW).map((item) => ({ ...item, offline: true }));
    expect(pickerDevices(listed, null, null, NOW).map((d) => [d.deviceId, d.host])).toEqual([["work", "work.tail1234.ts.net"]]);
  });

  it("takes a relay PC's presence on desktop from its record", () => {
    const folder = freshDir();
    writeDeviceRecord(folder, rec("home"), NOW);
    writeDeviceRecord(folder, { ...rec("cafe", relay("cafe")), relayHost: relay("cafe") }, NOW);
    writeDeviceRecord(folder, { ...rec("dorm", relay("dorm")), relayHost: relay("dorm") }, NOW - DEVICE_STALE_MS - 1);
    const request = vi.fn();
    const listed = createDevicePresence(request)(listDevices(folder, "home", NOW), "home.tail1234.ts.net");
    expect(pickerDevices(listed, null, BASE, NOW).map((d) => [d.deviceId, d.offline])).toEqual([["cafe", false], ["dorm", true], ["home", false]]);
    expect(request).not.toHaveBeenCalled();
  });
});
