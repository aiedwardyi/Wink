import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, instanceConfigs } from "./config.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import * as atomic from "./atomic.ts";

const core = await import("./accounts.ts").catch(() => null);
const bases: InstanceConfigMap = { claude: { driver: "claudeAgent" }, codex: { driver: "codex" }, grok: { driver: "grokAgent" } };
let next = 0;
function fixture() {
  expect(core, "account service exists").not.toBeNull();
  const dir = join(DATA_DIR, `accounts-test-${++next}`);
  mkdirSync(dir, { recursive: true });
  return { dir, service: new core!.AccountService(dir, () => bases) };
}

afterEach(() => vi.restoreAllMocks());

describe("PC-local accounts", () => {
  it("keeps the fleet first and appends three accounts in add order", async () => {
    const { service } = fixture();
    const added = await Promise.all([service.add("claude"), service.add("codex"), service.add("claude")]);
    expect(added.map((row) => row.id)).toEqual(service.snapshot.map((row) => row.id));
    const map = instanceConfigs({}, service.snapshot);
    expect(Object.keys(map).slice(0, 6)).toEqual(Object.keys(instanceConfigs({})));
    expect(Object.keys(map).slice(6)).toEqual(added.map((row) => row.id));
    expect(Object.values(map).find((entry) => entry.driver === "claudeAgent")?.account).toBeUndefined();
    expect(service.list().filter((row) => row.of === "claude").map((row) => row.id)).toEqual(["claude", added[0].id, added[2].id]);
  });

  it("counts the existing sign-in in the engine cap", async () => {
    const { service } = fixture();
    for (let i = 1; i < core!.MAX_ENGINE_ACCOUNTS; i++) await service.add("claude");
    await expect(service.add("claude")).rejects.toThrow(/8 accounts/);
    expect(service.snapshot).toHaveLength(7);
    await expect(service.add("codex")).resolves.toMatchObject({ of: "codex" });
  });

  it.each(["grok", "missing", "__proto__", "../claude", "constructor"])("refuses an unsupported base %s", async (of) => {
    await expect(fixture().service.add(of)).rejects.toThrow();
  });

  it("serializes concurrent writes and restores the ordered snapshot once", async () => {
    const { dir, service } = fixture();
    await Promise.all(Array.from({ length: 6 }, () => service.add("claude")));
    const disk = JSON.parse(readFileSync(join(dir, "accounts.json"), "utf8"));
    expect(disk.version).toBe(1);
    expect(disk.accounts).toHaveLength(6);
    const restored = new core!.AccountService(dir, () => bases);
    writeFileSync(join(dir, "accounts.json"), "corrupt after startup");
    expect(restored.snapshot.map((row) => row.id)).toEqual(service.snapshot.map((row) => row.id));
    expect(instanceConfigs({}, restored.snapshot)).toHaveProperty(service.snapshot[0].id);
  });

  it("allocates an opaque fresh id and home after retirement", async () => {
    const { service } = fixture();
    const first = await service.add("claude");
    await service.retire(first.id);
    const next = await service.add("claude");
    expect(next.id).not.toBe(first.id);
    expect(next.home).not.toBe(first.home);
    expect(next.id).not.toContain("claude");
    expect(existsSync(first.home)).toBe(true);
    expect(service.snapshot).toEqual([next]);
  });

  it("advances only the changed identity's generation", async () => {
    const { service } = fixture();
    const first = await service.add("claude");
    const second = await service.add("claude");
    const signedIn = await service.identify(first.id, "engine-identity-a");
    expect(signedIn.generation).toBeGreaterThan(first.generation);
    expect((await service.identify(first.id, "engine-identity-a")).generation).toBe(signedIn.generation);
    expect((await service.identify(first.id, "engine-identity-b")).generation).toBeGreaterThan(signedIn.generation);
    expect(service.snapshot.find((row) => row.id === second.id)?.generation).toBe(second.generation);
    expect((await service.identify(first.id, undefined)).generation).toBeGreaterThan(signedIn.generation);
  });

  it.each(["{", '{"version":9,"accounts":[]}', '{"version":1,"accounts":[{"id":"../escape","of":"claude","generation":1,"state":"pending"}],"retired":[]}'])("fails closed on corrupt state %s", async (content) => {
    const { dir } = fixture();
    writeFileSync(join(dir, "accounts.json"), content);
    const restored = new core!.AccountService(dir, () => bases);
    expect(restored.snapshot).toEqual([]);
    expect(restored.list()).toEqual([expect.objectContaining({ state: "stopped", error: expect.stringContaining("accounts.json") })]);
    await expect(restored.add("claude")).rejects.toThrow(/accounts.json/);
    expect(readFileSync(join(dir, "accounts.json"), "utf8")).toBe(content);
  });

  it.each(["missing", "disabled"])("starts with accounts off when their base is %s", async (reason) => {
    const { dir, service } = fixture();
    await service.add("claude");
    const before = readFileSync(join(dir, "accounts.json"), "utf8");
    const restoredBases: InstanceConfigMap = reason === "missing" ? { codex: bases.codex } : { ...bases, claude: { ...bases.claude, enabled: false } };
    const restored = new core!.AccountService(dir, () => restoredBases);
    expect(restored.snapshot).toEqual([]);
    expect(restored.list()).toEqual([expect.objectContaining({ state: "stopped", error: expect.stringContaining("accounts.json") })]);
    await expect(restored.add("codex")).rejects.toThrow(/accounts.json/);
    expect(readFileSync(join(dir, "accounts.json"), "utf8")).toBe(before);
  });

  it("refuses an account-root alias", async () => {
    const { dir, service } = fixture();
    const target = join(dir, "alias-target");
    mkdirSync(target);
    symlinkSync(target, join(dir, "accounts"), process.platform === "win32" ? "junction" : "dir");
    await expect(service.add("claude")).rejects.toThrow(/link|alias/i);
  });

  it("rejects a duplicate id and an account used as a parent", async () => {
    const { dir, service } = fixture();
    const added = await service.add("claude");
    await expect(service.add(added.id)).rejects.toThrow();
    const file = join(dir, "accounts.json");
    const disk = JSON.parse(readFileSync(file, "utf8"));
    disk.accounts.push(disk.accounts[0]);
    writeFileSync(file, JSON.stringify(disk));
    expect(new core!.AccountService(dir, () => bases).list()).toEqual([expect.objectContaining({ state: "stopped", error: expect.stringContaining("accounts.json") })]);
  });

  it("keeps the old snapshot and file after an atomic write fails", async () => {
    const { dir, service } = fixture();
    const first = await service.add("claude");
    const before = readFileSync(join(dir, "accounts.json"), "utf8");
    vi.spyOn(atomic, "writeFileAtomic").mockImplementationOnce(() => { throw new Error("fixture write failed"); });
    await expect(service.add("codex")).rejects.toThrow("fixture write failed");
    expect(service.snapshot).toEqual([first]);
    expect(readFileSync(join(dir, "accounts.json"), "utf8")).toBe(before);
    await expect(service.add("codex")).resolves.toMatchObject({ of: "codex" });
  });

  it("refuses disabled bases and configured-id collisions", async () => {
    const { dir, service } = fixture();
    const added = await service.add("claude");
    expect(new core!.AccountService(dir, () => ({ ...bases, [added.id]: { driver: "codex" } })).list()).toEqual([expect.objectContaining({ state: "stopped", error: expect.stringContaining("accounts.json") })]);
    const other = join(dir, "disabled");
    const disabled = new core!.AccountService(other, () => ({ claude: { driver: "claudeAgent", enabled: false } }));
    await expect(disabled.add("claude")).rejects.toThrow("enabled Claude or Codex");
  });
});
