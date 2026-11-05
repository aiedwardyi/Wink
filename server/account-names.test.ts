import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAccountNames, type AccountNames } from "./account-names.ts";
import { AccountService } from "./accounts.ts";
import * as atomic from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import { drivePathRule } from "./drive-mirror.ts";

let serial = 0;
function fixture() {
  const dir = join(DATA_DIR, `account-names-${++serial}`);
  mkdirSync(dir, { recursive: true });
  const bases: InstanceConfigMap = { claude: { driver: "claudeAgent" }, codex: { driver: "codex" } };
  const accounts = new AccountService(dir, () => bases);
  const names = createAccountNames(dir);
  const file = join(dir, "account-names.json");
  const sync = () => names.sync(accounts.list());
  return { dir, file, bases, accounts, names, sync };
}

function code(names: AccountNames, id: string, value: string | null) {
  try { names.setNickname(id, value); }
  catch (error) { return error instanceof Error && "code" in error ? error.code : "unexpected"; }
  return null;
}

afterEach(() => vi.restoreAllMocks());

describe("account names", () => {
  it("preserves saved names when account storage reports an error", async () => {
    const f = fixture();
    const account = await f.accounts.add("claude");
    f.sync();
    f.names.setNickname(account.id, "Studio");
    const saved = readFileSync(f.file, "utf8");
    writeFileSync(join(f.dir, "accounts.json"), "{broken");
    const broken = new AccountService(f.dir, () => f.bases);
    expect(broken.list()[0].error).toBeTruthy();
    f.names.sync(broken.list());
    expect(readFileSync(f.file, "utf8")).toBe(saved);
    expect(createAccountNames(f.dir).get(account.id)).toMatchObject({ number: 2, nickname: "Studio" });
  });

  it("numbers the PC sign-in 1 and existing accounts in accounts.json order on first read", async () => {
    const f = fixture();
    const first = await f.accounts.add("claude");
    const second = await f.accounts.add("claude");
    const codex = await f.accounts.add("codex");
    f.sync();
    expect(f.names.get("claude")).toEqual({ id: "claude", engine: "claude", number: 1, nickname: null, name: "Claude 1" });
    expect(f.names.get("codex")?.name).toBe("Codex 1");
    expect([first, second, codex].map((row) => f.names.get(row.id)?.number)).toEqual([2, 3, 2]);
    expect(JSON.parse(readFileSync(f.file, "utf8"))).toEqual({ version: 1, accounts: {
      claude: { engine: "claude", number: 1, generation: 0 },
      [first.id]: { engine: "claude", number: 2, generation: 1 },
      [second.id]: { engine: "claude", number: 3, generation: 1 },
      codex: { engine: "codex", number: 1, generation: 0 },
      [codex.id]: { engine: "codex", number: 2, generation: 1 },
    } });
    const restored = createAccountNames(f.dir);
    expect(restored.get(second.id)).toEqual(f.names.get(second.id));
    expect(f.names.get("missing")).toBeNull();
    expect(f.names.nameOf("missing", "claude")).toBe("Claude (removed)");
    for (const engine of ["Grok", "Gemini", "Muse"]) expect(f.names.nameOf("missing", engine)).toBe(engine);
  });

  it("gives an added account the lowest free number from 2", async () => {
    const f = fixture();
    f.sync();
    const first = await f.accounts.add("claude");
    f.sync();
    const second = await f.accounts.add("claude");
    f.sync();
    expect([first, second].map((row) => f.names.get(row.id)?.number)).toEqual([2, 3]);
    const secondBase = { ...f.accounts.list()[0], id: "claude-work", of: "claude-work" };
    f.names.sync([...f.accounts.list(), secondBase]);
    expect(f.names.get(secondBase.id)?.number).toBe(4);
  });

  it("numbers enabled bases before managed rows of the same engine", async () => {
    const f = fixture();
    f.bases["claude-work"] = { driver: "claudeAgent" };
    f.bases["claude-off"] = { driver: "claudeAgent", enabled: false };
    const account = await f.accounts.add("claude");
    f.sync();
    expect(f.names.get("claude")?.number).toBe(1);
    expect(f.names.get("claude-work")?.number).toBe(2);
    expect(f.names.get(account.id)?.number).toBe(3);
    expect(f.names.get("claude-off")).toBeNull();
  });

  it("never renumbers on Main change, list order or another account's removal", async () => {
    const f = fixture();
    const first = await f.accounts.add("claude");
    const second = await f.accounts.add("claude");
    f.sync();
    f.names.setNickname(second.id, "Studio");
    const before = f.names.get(second.id);
    await f.accounts.identify(second.id, "fixture-identity");
    f.sync();
    f.names.setNickname(second.id, "Studio");
    const write = vi.spyOn(atomic, "writeFileAtomic");
    await f.accounts.setDefault("claude", second.id);
    write.mockClear();
    f.names.sync(f.accounts.list().reverse());
    expect(f.names.get(second.id)).toEqual(before);
    expect(write).not.toHaveBeenCalled();
    await f.accounts.retire(first.id);
    f.sync();
    expect(f.names.get(second.id)).toEqual(before);
    const restored = createAccountNames(f.dir);
    restored.sync(f.accounts.list());
    expect(restored.get(second.id)).toEqual(before);
  });

  it("frees a removed account's number", async () => {
    const f = fixture();
    const first = await f.accounts.add("codex");
    const second = await f.accounts.add("codex");
    f.sync();
    await f.accounts.retire(first.id);
    f.sync();
    expect(f.names.get(first.id)).toBeNull();
    expect(f.names.nameOf(first.id, "codex")).toBe("Codex (removed)");
    const added = await f.accounts.add("codex");
    f.sync();
    expect(f.names.get(added.id)?.number).toBe(2);
    expect(f.names.get(second.id)?.number).toBe(3);
  });

  it("keeps the number and nickname when the sign-in changes generation", async () => {
    const f = fixture();
    const account = await f.accounts.add("claude");
    f.sync();
    f.names.setNickname(account.id, "Studio");
    await f.accounts.identify(account.id, "fixture-identity");
    f.sync();
    expect(f.names.get(account.id)).toMatchObject({ number: 2, nickname: "Studio", name: "Studio" });
    f.names.setNickname("claude", "PC");
    f.names.sync(f.accounts.list().map((row) => row.id === "claude" ? { ...row, generation: 1 } : row));
    expect(f.names.get("claude")).toMatchObject({ number: 1, nickname: "PC", name: "PC" });
    expect(JSON.parse(readFileSync(f.file, "utf8")).accounts[account.id].generation).toBe(2);
    expect(createAccountNames(f.dir).get("claude")).toMatchObject({ number: 1, nickname: "PC", name: "PC" });
  });

  it("refuses too-long, control, format, @, colon and quote characters", () => {
    const f = fixture();
    f.sync();
    expect(code(f.names, "claude", "a".repeat(25))).toBe("too-long");
    for (const char of ["\u0000", "\n", "\u007f", "\u0085", "\u200b", "\u202e", "@", ":", "'", '"', "`"]) {
      expect(code(f.names, "claude", `A${char}B`)).toBe("invalid-character");
    }
    f.names.setNickname("claude", "  Cafe\u0301  ");
    expect(f.names.get("claude")?.nickname).toBe("Café");
    f.names.setNickname("claude", " 작업실 ");
    expect(f.names.get("claude")?.name).toBe("작업실");
    f.names.setNickname("claude", "🐱".repeat(24));
    expect([...f.names.get("claude")!.nickname!]).toHaveLength(24);
    f.names.setNickname("claude", " \t\n ");
    expect(f.names.get("claude")?.nickname).toBeNull();
    expect(code(f.names, "missing", "Studio")).toBe("unknown-account");
    expect(code(f.names, "grok", "Studio")).toBe("unknown-account");
  });

  it("refuses a nickname taken in the same engine ignoring case and allows it in the other engine", async () => {
    const f = fixture();
    const account = await f.accounts.add("claude");
    f.sync();
    f.names.setNickname("claude", "Café");
    expect(code(f.names, account.id, " CAFE\u0301 ")).toBe("taken");
    expect(code(f.names, "codex", "CAFÉ")).toBeNull();
    expect(code(f.names, "claude", "CAFÉ")).toBeNull();
  });

  it("refuses number-shaped and ? nicknames", () => {
    const f = fixture();
    f.sync();
    for (const value of ["?", "Claude 2", "CODEX   0001", "Grok 3", "Gemini 2", "Muse 9"]) expect(code(f.names, "claude", value)).toBe("reserved");
    expect(f.names.get("claude")?.nickname).toBeNull();
  });

  it("resolves the number form, a nickname and a canonical selector", async () => {
    const f = fixture();
    const account = await f.accounts.add("claude");
    f.sync();
    f.names.setNickname(account.id, "Café");
    for (const text of ["cLaUdE   2", " cafe\u0301 ", `claude:${account.id}`]) expect(f.names.resolve("claude", text)).toEqual({ kind: "account", id: account.id });
    expect(f.names.selectorOf("claude")).toBe("claude:base");
    expect(f.names.selectorOf(account.id)).toBe(`claude:${account.id}`);
    expect(f.names.selectorOf("missing")).toBeNull();
    expect(f.names.resolve("CLAUDE", "claude:base")).toEqual({ kind: "account", id: "claude" });
    expect(f.names.resolve("codex", "Claude 2")).toEqual({ kind: "unknown" });
    expect(f.names.resolve("grok", "Grok 1")).toEqual({ kind: "unknown" });
  });

  it("refuses ambiguous and unknown input without echoing it", async () => {
    const f = fixture();
    const account = await f.accounts.add("claude");
    f.sync();
    const saved = JSON.parse(readFileSync(f.file, "utf8"));
    saved.accounts.claude.nickname = "Studio";
    saved.accounts[account.id].nickname = "STUDIO";
    saved.accounts[account.id].number = 1;
    writeFileSync(f.file, JSON.stringify(saved));
    const names = createAccountNames(f.dir);
    names.sync(f.accounts.list());
    expect(names.resolve("claude", "studio")).toEqual({ kind: "ambiguous" });
    expect(names.resolve("claude", "Claude 1")).toEqual({ kind: "ambiguous" });
    expect(names.resolve("claude", "claude:base")).toEqual({ kind: "account", id: "claude" });
    for (const text of ["missing", "?", "constructor", "__proto__", "claude:missing", "Codex 1"]) expect(names.resolve("claude", text)).toEqual({ kind: "unknown" });
  });

  it("sets aside a corrupt or unknown-version file and renumbers", async () => {
    const f = fixture();
    const account = await f.accounts.add("claude");
    for (const content of ["{", '{"version":9,"accounts":{}}', '{"version":1,"accounts":{"claude":{"engine":"claude","number":0,"generation":0}}}']) {
      writeFileSync(f.file, content);
      const restored = createAccountNames(f.dir);
      expect(readFileSync(`${f.file}.bad`, "utf8")).toBe(content);
      restored.sync(f.accounts.list());
      expect(restored.get("claude")?.number).toBe(1);
      expect(restored.get(account.id)?.number).toBe(2);
    }
    expect(() => createAccountNames(join(f.dir, "missing"))).not.toThrow();
  });

  it("writes atomically and only on a change", () => {
    const f = fixture();
    const write = vi.spyOn(atomic, "writeFileAtomic");
    expect(existsSync(f.file)).toBe(false);
    f.names.get("claude");
    expect(write).not.toHaveBeenCalled();
    f.sync();
    expect(write).toHaveBeenCalledExactlyOnceWith(f.file, expect.any(String), { mode: 0o600 });
    f.names.setNickname("claude", "Studio");
    expect(write).toHaveBeenCalledTimes(2);
    const before = readFileSync(f.file, "utf8");
    const restored = createAccountNames(f.dir);
    writeFileSync(f.file, "changed after construction");
    expect(restored.get("claude")?.name).toBe("Studio");
    writeFileSync(f.file, before);
    f.names.setNickname("claude", " Studio ");
    f.names.get("claude"); f.names.nameOf("claude", "claude"); f.names.selectorOf("claude"); f.names.resolve("claude", "Studio");
    f.sync();
    expect(write).toHaveBeenCalledTimes(2);
    write.mockImplementationOnce(() => { throw new Error("fixture failure"); });
    expect(() => f.names.setNickname("claude", "New")).toThrow("Cannot save account names");
    expect(f.names.get("claude")?.name).toBe("Studio");
    expect(readFileSync(f.file, "utf8")).toBe(before);
    expect(readdirSync(f.dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps account-names.json and its temp and bad files off Drive", () => {
    const ids = { profileDeviceId: "pc", writerId: "writer", memoryDeviceId: "000000000001" };
    expect(drivePathRule("account-names.json", ids)).toBe("unknown");
    expect(drivePathRule("account-names.json.bad", ids)).toBe("unknown");
    expect(drivePathRule("account-names.json.123.fixture.tmp", ids)).toBe("ignore");
  });

  it("keeps a synthetic identity canary out of names, errors and diagnostics", async () => {
    const f = fixture();
    const local = ["synthetic", "identity"].join("-");
    const domain = ["canary", "invalid"].join(".");
    const identity = [local, domain].join("@");
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const pending = await f.accounts.add("claude");
    const account = await f.accounts.identify(pending.id, identity);
    f.names.sync(f.accounts.list().map((row) => ({ ...row, identity })));
    const errors: unknown[] = [];
    for (const id of [account.id, identity]) {
      try { f.names.setNickname(id, identity); }
      catch (error) { errors.push(error instanceof Error ? { ...error, message: error.message, stack: error.stack } : error); }
    }
    const output = JSON.stringify([f.names.get(account.id), f.names.nameOf(account.id, "claude"), f.names.nameOf(identity, "claude"), f.names.resolve("claude", identity), errors, logs.map((log) => log.mock.calls), readFileSync(f.file, "utf8")]);
    expect([identity, local, domain].filter((part) => output.includes(part)).length).toBe(0);
    expect(logs.flatMap((log) => log.mock.calls)).toHaveLength(0);
  });
});
