import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelSelection } from "./contracts.ts";

const fsPlan = vi.hoisted(() => ({ linksHandedToRm: [] as string[], lockedRenames: [] as string[], vanished: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const links = (path: string): string[] => {
    const stat = actual.lstatSync(path, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) return [path];
    return stat?.isDirectory() ? actual.readdirSync(path).flatMap((name) => links(join(path, name))) : [];
  };
  return {
    ...actual,
    // Electron's recursive rmSync empties a junction's target; vitest's Node does not, so the links it is handed are counted instead
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (args[1]?.recursive) fsPlan.linksHandedToRm.push(...links(String(args[0])));
      return actual.rmSync(...args);
    },
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      if (!fsPlan.vanished.includes(String(args[0]))) return actual.lstatSync(...args);
      if (args[1]?.throwIfNoEntry === false) return undefined;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (fsPlan.lockedRenames.includes(String(args[0]))) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      return actual.renameSync(...args);
    },
  };
});

// The test setup already loads these modules, so re-import them with the mocked fs.
vi.resetModules();
const { DATA_DIR } = await import("./config.ts");
const { closeMessageDb } = await import("./message-db.ts");
const { Store } = await import("./store.ts");
const { ensureWorkspace, workspaceDir, WORKSPACES_DIR } = await import("./workspace.ts");

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("Store file guards", () => {
  let project: string;
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    project = mkdtempSync(join(tmpdir(), "omb-linked-project-"));
    mkdirSync(join(project, "src"));
    writeFileSync(join(project, "src", "main.ts"), "export const answer = 42;");
    fsPlan.linksHandedToRm = [];
    fsPlan.lockedRenames = [];
    fsPlan.vanished = [];
  });
  afterEach(() => {
    closeMessageDb();
    rmSync(project, { recursive: true, force: true });
  });

  it("deleting a bot unlinks every link in its folder and leaves the targets", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Coder" }, { seedMessages: false });
    const workspace = ensureWorkspace(bot.id);
    mkdirSync(join(workspace, "apps", "web"), { recursive: true });
    symlinkSync(project, join(workspace, "project"), "junction");
    symlinkSync(project, join(workspace, "apps", "web", "node_modules"), "junction");

    expect(store.deleteBot(bot.id)).toBe(true);

    expect(fsPlan.linksHandedToRm).toEqual([]);
    expect(existsSync(workspace)).toBe(false);
    expect(readFileSync(join(project, "src", "main.ts"), "utf8")).toBe("export const answer = 42;");
  });

  it("deleting a bot still clears its folder when a file vanishes mid-walk", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Coder" }, { seedMessages: false });
    const workspace = ensureWorkspace(bot.id);
    writeFileSync(join(workspace, "a-temp.txt"), "x");
    symlinkSync(project, join(workspace, "project"), "junction");
    fsPlan.vanished = [join(workspace, "a-temp.txt")];

    expect(store.deleteBot(bot.id)).toBe(true);

    expect(fsPlan.linksHandedToRm).toEqual([]);
    expect(existsSync(workspace)).toBe(false);
    expect(readdirSync(project)).toEqual(["src"]);
  });

  it("deleting a bot whose folder is itself a link removes only the link", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Coder" }, { seedMessages: false });
    mkdirSync(WORKSPACES_DIR, { recursive: true });
    symlinkSync(project, workspaceDir(bot.id), "junction");

    expect(store.deleteBot(bot.id)).toBe(true);

    expect(fsPlan.linksHandedToRm).toEqual([]);
    expect(lstatSync(workspaceDir(bot.id), { throwIfNoEntry: false })).toBeUndefined();
    expect(readdirSync(project)).toEqual(["src"]);
  });

  it("refuses to save over an unreadable bots.json it could not set aside", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    const path = join(DATA_DIR, "bots.json");
    writeFileSync(path, '[{"id": "bot-1"');
    const store = new Store(selection);
    fsPlan.lockedRenames = [path];

    expect(() => store.createBot({ name: "First" }, { seedMessages: false })).toThrow("EBUSY");
    expect(readFileSync(path, "utf8")).toBe('[{"id": "bot-1"');

    fsPlan.lockedRenames = [];
    store.createBot({ name: "Second" }, { seedMessages: false });
    const kept = readdirSync(DATA_DIR).filter((name) => /^bots\.bad-\d+\.json$/.test(name));
    expect(kept.map((name) => readFileSync(join(DATA_DIR, name), "utf8"))).toEqual(['[{"id": "bot-1"']);
  });
});
