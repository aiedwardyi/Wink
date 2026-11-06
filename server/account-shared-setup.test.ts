import * as fs from "node:fs";
import * as promises from "node:fs/promises";
import * as os from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { shareUserSetup } from "./account-shared-setup.ts";
import { DATA_DIR } from "./config.ts";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, promises: { ...fs.promises } };
});
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>() }));
vi.mock("node:os", async (original) => ({ ...await original<typeof import("node:os")>() }));

const actual = await vi.importActual<typeof fs>("node:fs");
let serial = 0;
const homes: string[] = [];
const forbidden: string[] = [];

beforeEach(() => {
  forbidden.length = 0;
  for (const target of [fs, fs.promises, promises]) {
    for (const key of target === fs ? ["readFileSync", "openSync", "readFile", "open"] : ["readFile", "open"]) {
      const object = target as any;
      const original = object[key];
      vi.spyOn(object, key).mockImplementation((...args: any[]) => {
        const path = resolve(String(args[0])).toLowerCase();
        if (homes.some((home) => path === home || path.startsWith(`${home}\\`) || path.startsWith(`${home}/`))) {
          forbidden.push(path);
          throw new Error("Forbidden account-home read/open");
        }
        return Reflect.apply(original, object, args);
      });
    }
  }
});

afterEach(() => {
  expect(forbidden).toEqual([]);
  vi.restoreAllMocks();
  homes.length = 0;
});

function fixture(baseName = "base") {
  const root = join(DATA_DIR, `shared-${++serial}`);
  const base = join(root, baseName);
  const home = join(root, "account");
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  homes.push(resolve(home).toLowerCase());
  const account = { id: `shared-${serial}`, of: "fixture", home, generation: 1 };
  const write = (path: string, text = "fixture") => { fs.mkdirSync(join(path, ".."), { recursive: true }); fs.writeFileSync(path, text); };
  return { root, base, home, account, write, record: join(DATA_DIR, "account-shared", `${account.id}.json`),
    share: (driver = "claudeAgent") => shareUserSetup(driver, account, base),
    read: (name: string) => actual.readFileSync(join(home, name), "utf8"),
    absent: (name: string) => expect(fs.lstatSync(join(home, name), { throwIfNoEntry: false })).toBeUndefined(),
  };
}

function tree(path: string): unknown {
  return actual.readdirSync(path).sort().map((name) => {
    const file = join(path, name);
    const stat = actual.lstatSync(file);
    return [name, stat.mtimeMs, stat.isSymbolicLink() ? actual.readlinkSync(file) : stat.isDirectory() ? tree(file) : actual.readFileSync(file, "utf8")];
  });
}

describe("Claude user setup", () => {
  it("writes the default pointer using the mocked home", () => {
    const f = fixture("profile/.claude");
    vi.spyOn(os, "homedir").mockReturnValue(join(f.root, "profile"));
    f.write(join(f.base, "CLAUDE.md"));
    f.share();
    expect(f.read("CLAUDE.md")).toBe("@~/.claude/CLAUDE.md\n");
  });

  it("escapes spaces in an absolute Korean pointer", () => {
    const f = fixture("홍 길동");
    f.write(join(f.base, "CLAUDE.md"));
    f.share();
    expect(f.read("CLAUDE.md")).toBe(`@${f.base.replace(/\\/g, "/").replace(/ /g, "\\ ")}/CLAUDE.md\n`);
  });

  it.each(["hash#base", "full　width"])("skips an unsupported pointer at %s while linking folders", (name) => {
    const f = fixture(name);
    f.write(join(f.base, "CLAUDE.md"));
    f.write(join(f.base, "rules/r1.md"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    f.share();
    f.absent("CLAUDE.md");
    expect(warn).toHaveBeenCalledExactlyOnceWith("Cannot include user setup:", "CLAUDE.md");
    expect(fs.lstatSync(join(f.home, "rules")).isSymbolicLink()).toBe(true);
  });

  it("preserves an existing pointer without reading or writing it", () => {
    const f = fixture();
    f.write(join(f.base, "CLAUDE.md"));
    f.write(join(f.home, "CLAUDE.md"), "user rules");
    const before = fs.lstatSync(join(f.home, "CLAUDE.md"));
    const write = vi.spyOn(fs, "writeFileSync");
    f.share();
    expect(f.read("CLAUDE.md")).toBe("user rules");
    expect(fs.lstatSync(join(f.home, "CLAUDE.md")).mtimeMs).toBe(before.mtimeMs);
    expect(write).not.toHaveBeenCalled();
  });

  it("waits for a source that appears on a later launch", () => {
    const f = fixture();
    f.share();
    expect(actual.readdirSync(f.home)).toEqual([]);
    f.write(join(f.base, "CLAUDE.md"));
    f.share();
    expect(f.read("CLAUDE.md")).toContain("/CLAUDE.md\n");
  });

  it("preserves real folders and dangling links and exposes later source files", () => {
    const f = fixture();
    for (const name of ["rules", "agents", "commands", "output-styles"]) f.write(join(f.base, name, "first.md"));
    f.write(join(f.home, "agents/own.md"), "user agent");
    fs.symlinkSync(join(f.root, "missing"), join(f.home, "commands"), "junction");
    f.share();
    expect(fs.lstatSync(join(f.home, "rules")).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(join(f.home, "output-styles")).isSymbolicLink()).toBe(true);
    expect(f.read("agents/own.md")).toBe("user agent");
    expect(actual.readdirSync(join(f.home, "agents"))).toEqual(["own.md"]);
    expect(actual.readlinkSync(join(f.home, "commands"))).toContain("missing");
    f.write(join(f.base, "rules/later.md"), "later rule");
    expect(f.read("rules/later.md")).toBe("later rule");
  });

  it("continues after a junction failure and never throws", () => {
    const f = fixture();
    f.write(join(f.base, "rules/r1.md"));
    f.write(join(f.base, "agents/a1.md"));
    f.write(join(f.base, "skills/my-skill/SKILL.md"));
    const link = vi.spyOn(fs, "symlinkSync").mockImplementationOnce(() => { throw new Error("fixture secret"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => f.share()).not.toThrow();
    expect(link).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledExactlyOnceWith("Could not share user setup:", "rules");
    expect(fs.lstatSync(join(f.home, "agents")).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(join(f.home, "skills/my-skill")).isSymbolicLink()).toBe(true);
  });
});

describe.each(["claudeAgent", "codex"])("%s setup safety", (driver) => {
  it("skips unchanged skill scans and rescans after source or destination changes", () => {
    const f = fixture();
    const source = join(f.base, "skills");
    const destination = join(f.home, "skills");
    f.write(join(source, "first/SKILL.md"));
    f.share(driver);
    const scan = vi.spyOn(fs, "readdirSync");
    f.share(driver);
    expect(scan).not.toHaveBeenCalled();
    f.write(join(source, "later/SKILL.md"));
    fs.utimesSync(source, new Date(1000), new Date(1000));
    f.share(driver);
    expect(scan).toHaveBeenCalledExactlyOnceWith(source);
    expect(fs.lstatSync(join(destination, "later")).isSymbolicLink()).toBe(true);
    scan.mockClear();
    fs.rmSync(join(destination, "first"));
    fs.utimesSync(destination, new Date(2000), new Date(2000));
    f.share(driver);
    expect(scan).toHaveBeenCalledExactlyOnceWith(source);
    expect(fs.lstatSync(join(destination, "first")).isSymbolicLink()).toBe(true);
    scan.mockClear();
    f.share(driver);
    expect(scan).not.toHaveBeenCalled();
  });

  it("retries a failed skill link on the next launch", () => {
    const f = fixture();
    f.write(join(f.base, "skills/first/SKILL.md"));
    f.write(join(f.base, "skills/second/SKILL.md"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const link = vi.spyOn(fs, "symlinkSync").mockImplementationOnce(() => { throw new Error("fixture"); });
    f.share(driver);
    f.absent("skills/first");
    link.mockClear();
    f.share(driver);
    expect(link).toHaveBeenCalledExactlyOnceWith(resolve(join(f.base, "skills/first")), join(f.home, "skills/first"), "junction");
  });

  it("links individual skills including linked sources and picks up new entries", () => {
    const f = fixture();
    for (const name of ["synced", ".hidden", ".system", "mine", "own"]) f.write(join(f.base, "skills", name, "SKILL.md"));
    f.write(join(f.base, "skills/plain-file"));
    f.write(join(f.base, "linked-source/SKILL.md"), "linked skill");
    fs.symlinkSync(join(f.base, "linked-source"), join(f.base, "skills/linked"), "junction");
    f.write(join(f.home, "skills/own/SKILL.md"), "own skill");
    f.share(driver);
    for (const name of ["synced", ".hidden", ".system", "plain-file"]) f.absent(`skills/${name}`);
    for (const name of ["mine", "linked"]) expect(fs.lstatSync(join(f.home, "skills", name)).isSymbolicLink()).toBe(true);
    expect(f.read("skills/linked/SKILL.md")).toBe("linked skill");
    expect(f.read("skills/own/SKILL.md")).toBe("own skill");
    f.write(join(f.base, "skills/later/SKILL.md"));
    f.share(driver);
    expect(fs.lstatSync(join(f.home, "skills/later")).isSymbolicLink()).toBe(true);
  });

  it("preserves the base tree, is idempotent and leaves targets after account removal", () => {
    const f = fixture();
    f.write(join(f.base, driver === "codex" ? "AGENTS.md" : "CLAUDE.md"));
    f.write(join(f.base, "rules/r1.md"));
    f.write(join(f.base, "skills/my-skill/SKILL.md"));
    const before = tree(f.base);
    f.share(driver);
    const first = tree(f.home);
    const writes = ["mkdirSync", "writeFileSync", "symlinkSync", "copyFileSync", "renameSync", "rmSync"] as const;
    const spies = writes.map((key) => vi.spyOn(fs, key));
    f.share(driver);
    expect(tree(f.home)).toEqual(first);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    fs.rmSync(f.home, { recursive: true });
    expect(tree(f.base)).toEqual(before);
  });

  it("does nothing when the base is the account home", () => {
    const f = fixture();
    f.write(join(f.home, driver === "codex" ? "AGENTS.md" : "CLAUDE.md"));
    f.write(join(f.home, "skills/my-skill/SKILL.md"));
    const before = tree(f.home);
    const write = vi.spyOn(fs, "writeFileSync");
    shareUserSetup(driver, f.account, process.platform === "win32" ? f.home.toUpperCase() : f.home);
    expect(write).not.toHaveBeenCalled();
    expect(tree(f.home)).toEqual(before);
  });
});

describe("Codex global rules", () => {
  it.each([
    { source: true, destination: false, record: "none", copy: true },
    { source: true, destination: false, record: "owned", copy: true },
    { source: true, destination: true, record: "owned", copy: false },
    { source: true, destination: true, record: "changed", copy: true },
    { source: true, destination: true, record: "edited", copy: false },
    { source: true, destination: true, record: "none", copy: false },
    { source: false, destination: true, record: "owned", copy: false },
    { source: false, destination: true, record: "edited", copy: false },
    { source: false, destination: true, record: "none", copy: false },
    { source: false, destination: false, record: "owned", copy: false },
    { source: false, destination: false, record: "none", copy: false },
  ])("handles source $source, destination $destination, record $record", ({ source, destination, record, copy }) => {
    const f = fixture();
    const src = join(f.base, "AGENTS.md");
    const dst = join(f.home, "AGENTS.md");
    f.write(src, "original rules");
    if (record !== "none") f.share("codex");
    if (!source) fs.rmSync(src);
    else if (record === "changed") f.write(src, "changed source rules");
    if (!destination) fs.rmSync(dst, { force: true });
    else if (record === "none" || record === "edited") f.write(dst, "user rules");
    const copies = vi.spyOn(fs, "copyFileSync");
    const renames = vi.spyOn(fs, "renameSync");
    f.share("codex");
    expect(copies).toHaveBeenCalledTimes(copy ? 1 : 0);
    expect(renames).toHaveBeenCalledTimes(copy ? 1 : 0);
    const removed = !source && record === "owned";
    if (removed || (!source && !destination)) f.absent("AGENTS.md");
    else expect(f.read("AGENTS.md")).toBe(record === "none" && destination || record === "edited" ? "user rules" : record === "changed" ? "changed source rules" : "original rules");
    if (copy || source && record !== "none") {
      expect(fs.existsSync(f.record)).toBe(true);
      const saved = JSON.parse(actual.readFileSync(f.record, "utf8"));
      if (copy) expect(saved.destination).toEqual(expect.objectContaining({ size: fs.lstatSync(dst).size, mtimeMs: fs.lstatSync(dst).mtimeMs }));
    } else if (!source && (removed || !destination)) expect(fs.existsSync(f.record)).toBe(false);
    expect(actual.readdirSync(f.home).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(f.record.startsWith(f.home)).toBe(false);
  });

  it("refreshes after editor replacement and prefers the override", () => {
    const f = fixture();
    f.write(join(f.base, "AGENTS.md"), "ordinary rules");
    f.write(join(f.base, "AGENTS.override.md"), "override rules");
    f.share("codex");
    expect(f.read("AGENTS.md")).toBe("override rules");
    f.write(join(f.base, "replacement"), "editor replacement rules");
    fs.renameSync(join(f.base, "replacement"), join(f.base, "AGENTS.override.md"));
    f.share("codex");
    expect(f.read("AGENTS.md")).toBe("editor replacement rules");
    fs.rmSync(join(f.base, "AGENTS.override.md"));
    f.share("codex");
    expect(f.read("AGENTS.md")).toBe("ordinary rules");
  });

  it("preserves user rules after a malformed ownership record", () => {
    const f = fixture();
    f.write(join(f.base, "AGENTS.md"));
    f.write(join(f.home, "AGENTS.md"), "user rules");
    f.write(f.record, "malformed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => f.share("codex")).not.toThrow();
    expect(f.read("AGENTS.md")).toBe("user rules");
    expect(warn).toHaveBeenCalledExactlyOnceWith("Could not read user setup record:", "AGENTS.md");
  });
});
