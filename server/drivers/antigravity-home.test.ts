import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as auth from "./antigravity-auth.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { antigravityHelperHome } from "./antigravity-home.ts";
import { ensureDirs } from "../config.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-agy-cli.ts");
const roots: string[] = [];

const createSignIn = auth.antigravitySignIn;
beforeEach(() => {
  vi.spyOn(auth, "antigravitySignIn").mockImplementation(() => createSignIn(async () => true));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `omb-agy-home-${name}-`));
  roots.push(root);
  return root;
}

/** Path to a kind: "link", "dir", "hardlink" or the file's hash. */
function tree(dir: string) {
  const out: Record<string, string> = {};
  const walk = (current: string, rel: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const key = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) out[key] = "link";
      else if (stat.isDirectory()) {
        out[`${key}/`] = "dir";
        walk(path, key);
      } else out[key] = stat.nlink > 1 ? "hardlink" : createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(dir, "");
  return out;
}

/** A user's ~/.gemini as agy and the Gemini CLI leave it. */
function realHome(root: string) {
  const home = join(root, "home");
  const gemini = join(home, ".gemini");
  for (const dir of ["antigravity-cli/log", "antigravity-cli/conversations", "antigravity-cli/brain/abc", "antigravity-ide", "config", "history", "hooks", "tmp"]) mkdirSync(join(gemini, dir), { recursive: true });
  const put = (rel: string, body: string) => writeFileSync(join(gemini, rel), body);
  put("antigravity-cli/log/cli-1.log", "applyAuthResult: email=alice@example.test, authMethod=consumer,\n");
  put("antigravity-cli/conversations/c1.db", "conversation");
  put("antigravity-cli/brain/abc/note.md", "brain");
  put("antigravity-cli/settings.json", JSON.stringify({ trustedFolders: ["C:/x"] }));
  put("config/mcp_config.json", JSON.stringify({ mcpServers: { user: { command: "x" } } }));
  put("hooks/pre.cmd", "echo hook");
  put("GEMINI.md", "remember this");
  put("google_accounts.json", JSON.stringify({ active: "alice@example.test" }));
  put("projects.json", "{}");
  put("state.json", "{}");
  return { home, gemini };
}

const readIf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

describe("antigravityHelperHome", () => {
  it("signs note helpers in with a phone sign-in's token file, and drops it after sign-out", () => {
    const home = scratch("token");
    const data = scratch("token-data");
    const token = join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
    mkdirSync(dirname(token), { recursive: true });
    writeFileSync(token, "token-fixture");
    const copy = join(antigravityHelperHome({ HOME: home }, data), ".gemini", "antigravity-cli", "antigravity-oauth-token");
    expect(readFileSync(copy, "utf8")).toBe("token-fixture");
    rmSync(token);
    antigravityHelperHome({ HOME: home }, data);
    expect(existsSync(copy)).toBe(false);
  });

  it("holds only Wink's empty MCP config: no link, hard link or copy of the real ~/.gemini", () => {
    const root = scratch("shape");
    const { home, gemini } = realHome(root);
    const data = join(root, "data");
    const before = tree(gemini);
    const helper = antigravityHelperHome({ HOME: home }, data);
    expect(antigravityHelperHome({ HOME: home }, data)).toBe(helper);
    const owned = tree(data);
    expect(Object.entries(owned).filter(([, kind]) => kind === "link" || kind === "hardlink")).toEqual([]);
    expect(Object.keys(tree(join(helper, ".gemini")))).toEqual(["config/", "config/mcp_config.json"]);
    expect(JSON.parse(readFileSync(join(helper, ".gemini", "config", "mcp_config.json"), "utf8"))).toEqual({ mcpServers: {} });
    expect(tree(gemini)).toEqual(before);
  });

  it("never shows a helper an account the real home no longer has", () => {
    const root = scratch("signin");
    const { home, gemini } = realHome(root);
    const data = join(root, "data");
    const accounts = join(gemini, "google_accounts.json");
    const seen = () => readIf(join(antigravityHelperHome({ HOME: home }, data), ".gemini", "google_accounts.json"));
    const steps: Array<() => void> = [
      () => {},
      () => writeFileSync(accounts, JSON.stringify({ active: "bravo@example.test" })),
      () => unlinkSync(accounts),
      () => {
        writeFileSync(accounts, JSON.stringify({ active: "carol@example.test" }));
        const old = new Date("2020-01-01T00:00:00Z");
        utimesSync(accounts, old, old);
      },
    ];
    for (const step of steps) {
      step();
      expect([undefined, readIf(accounts)]).toContain(seen());
    }
  });

  it("keeps the MCP config Wink's: restores an edit, leaves a matching file alone", () => {
    const root = scratch("config");
    const { home } = realHome(root);
    const data = join(root, "data");
    const config = join(antigravityHelperHome({ HOME: home }, data), ".gemini", "config", "mcp_config.json");
    const first = statSync(config);
    antigravityHelperHome({ HOME: home }, data);
    expect(statSync(config).ino).toBe(first.ino);
    writeFileSync(config, JSON.stringify({ mcpServers: { box: { env: { OGB_BOX_TOKEN: "box-tok" } } } }));
    antigravityHelperHome({ HOME: home }, data);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ mcpServers: {} });
    expect(readdirSync(dirname(config))).toEqual(["mcp_config.json"]);
  });

  it("unlinks an older helper home's junctions without touching what they point at", () => {
    const root = scratch("legacy");
    const { home, gemini } = realHome(root);
    const data = join(root, "data");
    const old = join(data, "agy-helper", "0123456789abcdef", ".gemini");
    mkdirSync(old, { recursive: true });
    symlinkSync(join(gemini, "antigravity-cli"), join(old, "antigravity-cli"), "junction");
    writeFileSync(join(old, "google_accounts.json"), "stale");
    const before = tree(gemini);
    antigravityHelperHome({ HOME: home }, data);
    expect(existsSync(join(data, "agy-helper"))).toBe(false);
    expect(Object.values(tree(data))).not.toContain("link");
    expect(tree(gemini)).toEqual(before);
  });

  it("leaves the real home byte-same through every remover and a folder or file swapped in the real home", async () => {
    const { requestStartFresh, applyStartFresh } = await import("../../electron/start-fresh.mjs");
    const root = scratch("removers");
    const { home, gemini } = realHome(root);
    const removers = {
      "rmSync data": (data) => rmSync(data, { recursive: true, force: true }),
      "rmSync agy-home": (data) => rmSync(join(data, "agy-home"), { recursive: true, force: true }),
      "start fresh, then delete the backup": async (data) => {
        requestStartFresh({ dataDir: data });
        const result = await applyStartFresh({ dataDir: data, userData: join(data, "desktop"), clearUiState: async () => {} });
        expect(result.status).toBe("reset");
        rmSync(result.backup!, { recursive: true, force: true });
      },
    } satisfies Record<string, (data: string) => Promise<void> | void>;
    for (const [name, remove] of Object.entries(removers)) {
      const data = join(root, name.replace(/\W+/g, "-"));
      antigravityHelperHome({ HOME: home }, data);
      const before = tree(gemini);
      await remove(data);
      expect(tree(gemini), name).toEqual(before);
    }
    const data = join(root, "flip");
    antigravityHelperHome({ HOME: home }, data);
    rmSync(join(gemini, "hooks"), { recursive: true });
    writeFileSync(join(gemini, "hooks"), "now a file");
    unlinkSync(join(gemini, "projects.json"));
    mkdirSync(join(gemini, "projects.json"));
    const flipped = tree(gemini);
    antigravityHelperHome({ HOME: home }, data);
    expect(tree(gemini)).toEqual(flipped);
  });

  it("keeps a helper run's own writes in the helper home, the real home byte-same", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const root = scratch("writes");
    const { home, gemini } = realHome(root);
    const helper = await AntigravityDriver.create({
      instanceId: "agy-home-writes",
      displayName: undefined,
      environment: { HOME: home, USERPROFILE: home, FAKE_AGY_WRITE_HOME: "1" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const before = tree(gemini);
    try {
      expect(await helper.generateText!("notes")).toBe("done from fake agy");
    } finally {
      await helper.dispose();
    }
    expect(tree(gemini)).toEqual(before);
    const own = tree(join(antigravityHelperHome({ HOME: home, USERPROFILE: home }), ".gemini"));
    expect(Object.keys(own)).toEqual(expect.arrayContaining(["antigravity-cli/conversations/", "antigravity-cli/settings.json", "state.json", "trustedFolders.json"]));
    expect(Object.values(own)).not.toContain("link");
  });
});
