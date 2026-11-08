import { mkdir, mkdtemp, opendir, realpath, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import { createVerifyAuto, scanVerifyWrites, type VerifyAutoTurn } from "./verify-auto.ts";
import { resolveVerifySite } from "./verify-site.ts";
import { VERIFY_LIMITS } from "../shared/live-verify.ts";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat), opendir: vi.fn(actual.opendir) };
});
vi.mock("./verify-site.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./verify-site.ts")>();
  return { ...actual, resolveVerifySite: vi.fn(actual.resolveVerifySite) };
});

let root: string;
let start: ReturnType<typeof vi.fn<(input: { botId: string; threadId: string; entry: string; episode: string }) => Promise<void>>>;
let scan: ReturnType<typeof vi.fn<typeof scanVerifyWrites>>;
let auto: ReturnType<typeof createVerifyAuto>;
let turn: VerifyAutoTurn;
const event = (fields: Partial<RuntimeEvent>) => ({ eventId: "e", provider: "claudeAgent", threadId: "thread", turnId: "turn", createdAt: new Date().toISOString(), ...fields }) as RuntimeEvent;
const shell = () => {
  auto.event(event({ type: "item.started", itemType: "tool", itemId: "shell", title: "Bash" }));
  auto.event(event({ type: "item.completed", itemType: "tool", itemId: "shell", ok: true }));
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "wink-verify-auto-")));
  await writeFile(join(root, "index.html"), "<h1>Hi</h1>");
  start = vi.fn().mockResolvedValue(undefined);
  scan = vi.fn(scanVerifyWrites);
  auto = createVerifyAuto({ enabled: () => true, freeMemory: () => 8 * 1024 ** 3, startAuto: start, scan, log: vi.fn() });
  turn = { botId: "bot", threadId: "thread", turnId: "turn", startedAt: Date.now(), roots: [root], depth: 0, ok: true, humanId: "human", humanText: "Build a page", reply: "" };
  vi.mocked(stat).mockClear();
  vi.mocked(opendir).mockClear();
});

it("does no filesystem work for a chat-only turn", async () => {
  await auto.settled(turn);
  expect(scan).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(stat).not.toHaveBeenCalled();
  expect(opendir).not.toHaveBeenCalled();
});

it.each(["don't check", "do not verify", "don't test", "skip verification", "확인하지 마", "검사 빼고", "테스트 없이", "Make the page but don't check it", "build it and do not verify", "확인 안 해도 돼", "No testing please", "don't check this"])("skips task opt-out: %s", async humanText => {
  shell();
  await auto.settled({ ...turn, humanText });
  expect(scan).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

it("does not interpret hidden-window instructions as an opt-out", async () => {
  auto.event(event({ type: "item.completed", itemType: "tool", ok: true, writes: ["index.html"] }));
  await auto.settled({ ...turn, humanText: "Do not open windows" });
  expect(start).toHaveBeenCalledTimes(1);
});

it.each([{ depth: 1 }, { routine: true }, { interrupted: true }, { superseded: true }, { ok: false }])("skips ineligible turns: %o", async patch => {
  auto.event(event({ type: "item.completed", itemType: "tool", ok: true }));
  await auto.settled({ ...turn, ...patch });
  expect(scan).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

it.each(["switch", "ram"])("does no scan when blocked by %s", async guard => {
  auto = createVerifyAuto({ enabled: () => guard !== "switch", freeMemory: () => guard === "ram" ? VERIFY_LIMITS.autoFreeBytes - 1 : VERIFY_LIMITS.autoFreeBytes, startAuto: start, scan, log: vi.fn() });
  shell();
  await auto.settled(turn);
  expect(scan).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

it("skips a manual check after the last write and rechecks a later write", async () => {
  auto.event(event({ type: "item.completed", itemType: "tool", ok: true, writes: ["index.html"] }));
  auto.checkStarted("thread", "turn")();
  await auto.settled(turn);
  expect(start).not.toHaveBeenCalled();
  auto.event(event({ type: "item.completed", itemType: "tool", ok: true, writes: ["index.html"] }));
  const checked = auto.checkStarted("thread", "turn");
  auto.event(event({ type: "item.completed", itemType: "tool", ok: true, writes: ["index.html"] }));
  checked();
  await auto.settled(turn);
  expect(start).toHaveBeenCalledTimes(1);
});

it("scans once for an opaque shell alongside native writes", async () => {
  auto.event(event({ type: "item.completed", itemType: "tool", ok: true, writes: ["index.html"] }));
  shell();
  await auto.settled(turn);
  expect(scan).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledOnce();
});

it("does not use paths from a failed tool", async () => {
  auto.event(event({ type: "item.completed", itemType: "tool", ok: false, writes: ["index.html"] }));
  await auto.settled(turn);
  expect(start).not.toHaveBeenCalled();
});

it("chooses the nearest admitted static site and a non-index HTML entry", async () => {
  await mkdir(join(root, "site"));
  await writeFile(join(root, "site", "index.html"), "<h1>Nested</h1>");
  await writeFile(join(root, "site", "a.css"), "h1{color:red}");
  auto.event(event({ type: "item.completed", itemType: "tool", ok: true, writes: ["site/a.css"] }));
  await auto.settled(turn);
  expect(start.mock.calls[0]![0].entry).toBe(join(root, "site", "index.html"));
  await writeFile(join(root, "site", "about.html"), "<h1>About</h1>");
  auto.event(event({ type: "item.completed", itemType: "tool", ok: true, writes: ["site/about.html"] }));
  await auto.settled(turn);
  expect(start.mock.calls[1]![0].entry).toBe(join(root, "site", "about.html"));
});

it("does not treat a package root as a static site", async () => {
  await writeFile(join(root, "package.json"), "{}");
  auto.event(event({ type: "item.completed", itemType: "tool", ok: true, writes: ["index.html"] }));
  await auto.settled(turn);
  expect(start).not.toHaveBeenCalled();
});

it.each(["reply", "humanText"] as const)("uses a named loopback URL from %s for a package candidate", async source => {
  await writeFile(join(root, "package.json"), "{}");
  const server = createServer(socket => socket.end());
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    auto.event(event({ type: "item.completed", itemType: "tool", ok: true, writes: ["index.html"] }));
    await auto.settled({ ...turn, [source]: `Ready: ${url}` });
    expect(start.mock.calls[0]![0].entry).toBe(url);
  } finally { await new Promise<void>(done => server.close(() => done())); }
});

it("keeps the named localhost authority for a package candidate", async () => {
  await writeFile(join(root, "package.json"), "{}");
  const server = createServer(socket => socket.end());
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const url = `http://localhost:${(server.address() as { port: number }).port}/`;
    auto.event(event({ type: "item.completed", itemType: "tool", ok: true, writes: ["index.html"] }));
    await auto.settled({ ...turn, reply: `Ready: ${url}` });
    expect(start.mock.calls[0]![0].entry).toBe(url);
  } finally { await new Promise<void>(done => server.close(() => done())); }
});

it("probes a named loopback URL once per turn across package candidates", async () => {
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(join(root, "a.css"), "h1{color:red}");
  vi.mocked(resolveVerifySite).mockClear();
  vi.mocked(resolveVerifySite).mockImplementation(async (entry, roots) => {
    if (entry.startsWith("http")) throw Object.assign(new Error("down"), { code: "page-failed" });
    return (await vi.importActual<typeof import("./verify-site.ts")>("./verify-site.ts")).resolveVerifySite(entry, roots);
  });
  try {
    auto.event(event({ type: "item.completed", itemType: "tool", ok: true, writes: ["index.html", "a.css"] }));
    await auto.settled({ ...turn, reply: "Open http://localhost:5173/ (http://localhost:5173/)." });
    expect(vi.mocked(resolveVerifySite).mock.calls.filter(([entry]) => entry.startsWith("http"))).toHaveLength(1);
    expect(start).not.toHaveBeenCalled();
  } finally { vi.mocked(resolveVerifySite).mockReset(); }
});

it("tries older changed files when the newest has no static entry", async () => {
  const owned = join(root, "owned");
  await mkdir(join(owned, "site"), { recursive: true });
  await mkdir(join(owned, "scripts"));
  await writeFile(join(owned, "site", "index.html"), "<h1>Site</h1>");
  await writeFile(join(owned, "scripts", "helper.js"), "export {}");
  await utimes(join(owned, "site", "index.html"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  auto.event(event({ type: "item.completed", itemType: "tool", ok: true, writes: ["site/index.html", "scripts/helper.js"] }));
  await auto.settled({ ...turn, roots: [owned] });
  expect(start.mock.calls[0]![0].entry).toBe(join(owned, "site", "index.html"));
});

it("ignores URLs without a package candidate and ignores non-web writes", async () => {
  await writeFile(join(root, "notes.md"), "hi");
  auto.event(event({ type: "item.completed", itemType: "tool", ok: true, writes: ["notes.md"] }));
  await auto.settled({ ...turn, reply: "http://127.0.0.1:12345" });
  expect(start).not.toHaveBeenCalled();
});

it("replaces an older pending decision in the same thread", async () => {
  let finish!: (paths: string[]) => void;
  scan.mockImplementationOnce(() => new Promise(done => { finish = done; }));
  shell();
  const first = auto.settled(turn);
  auto.event(event({ turnId: "new", type: "item.completed", itemType: "tool", ok: true, writes: ["index.html"] }));
  await auto.settled({ ...turn, turnId: "new", humanId: "new-human" });
  finish(["index.html"]);
  await first;
  expect(start).toHaveBeenCalledOnce();
  expect(start.mock.calls[0]![0].episode).toContain("new-human");
});

it.each(["ancestor", "absolute", "relative", "sibling-prefix"])("never checks an unowned static %s", async kind => {
  const owned = join(root, "owned");
  await mkdir(owned);
  await writeFile(join(owned, "a.css"), "h1{color:red}");
  await mkdir(join(root, "owned-other"));
  await writeFile(join(root, "owned-other", "index.html"), "<h1>Other</h1>");
  const path = kind === "ancestor" ? "a.css" : kind === "relative" ? "../index.html" : kind === "sibling-prefix" ? join(root, "owned-other", "index.html") : join(root, "index.html");
  auto.event(event({ type: "item.completed", itemType: "tool", ok: true, writes: [path] }));
  await auto.settled({ ...turn, roots: [owned] });
  expect(start).not.toHaveBeenCalled();
});

it("does not use a package ancestor outside the owned root", async () => {
  await writeFile(join(root, "package.json"), "{}");
  const owned = join(root, "owned");
  await mkdir(owned);
  await writeFile(join(owned, "a.css"), "h1{color:red}");
  const local = createServer(socket => socket.end());
  await new Promise<void>(done => local.listen(0, "127.0.0.1", done));
  try {
    auto.event(event({ type: "item.completed", itemType: "tool", ok: true, writes: ["a.css"] }));
    await auto.settled({ ...turn, roots: [owned], reply: `http://127.0.0.1:${(local.address() as { port: number }).port}/` });
    expect(start).not.toHaveBeenCalled();
  } finally { await new Promise<void>(done => local.close(() => done())); }
});

it("does not use a linked package outside the owned root", async () => {
  const owned = join(root, "owned"), outside = join(root, "outside");
  await mkdir(owned);
  await mkdir(outside);
  await writeFile(join(outside, "package.json"), "{}");
  await writeFile(join(outside, "a.css"), "h1{color:red}");
  await symlink(outside, join(owned, "linked"), process.platform === "win32" ? "junction" : "dir");
  const local = createServer(socket => socket.end());
  await new Promise<void>(done => local.listen(0, "127.0.0.1", done));
  try {
    auto.event(event({ type: "item.completed", itemType: "tool", ok: true, writes: ["linked/a.css"] }));
    await auto.settled({ ...turn, roots: [owned], reply: `http://127.0.0.1:${(local.address() as { port: number }).port}/` });
    expect(start).not.toHaveBeenCalled();
  } finally { await new Promise<void>(done => local.close(() => done())); }
});

it.each([
  ...["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "TodoWrite", "verify_site", "mcp__react", "mcp__agents__update_task_state"].map(title => ({ provider: "claudeAgent", title })),
  { provider: "codex", title: "update_task_state" },
  { provider: "codex", title: "web_search", verb: "WebSearch" },
  ...["grokAgent", "museAgent"].flatMap(provider => ["Read", "Grep", "WebFetch"].map(verb => ({ provider, title: "index.html", verb }))),
  { provider: "antigravityAgent", title: "Read" },
])("does no scan or filesystem work for read-only %o", async fields => {
  auto.event(event({ ...fields, type: "item.started", itemType: "tool", itemId: "read" }));
  auto.event(event({ provider: fields.provider, type: "item.completed", itemType: "tool", itemId: "read", ok: true }));
  await auto.settled(turn);
  expect(scan).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(stat).not.toHaveBeenCalled();
  expect(opendir).not.toHaveBeenCalled();
});

it.each(["chat", "room-chat", "read-only"])("preserves a pending decision and queued check after %s", async kind => {
  const cancelQueued = vi.fn();
  auto = createVerifyAuto({ enabled: () => true, freeMemory: () => 8 * 1024 ** 3, startAuto: start, scan, cancelQueued, log: vi.fn() });
  let finish!: (paths: string[]) => void;
  scan.mockImplementationOnce(() => new Promise(done => { finish = done; }));
  shell();
  const first = auto.settled(turn);
  expect(cancelQueued).toHaveBeenCalledOnce();
  if (kind === "read-only") {
    auto.event(event({ turnId: "new", type: "item.started", itemType: "tool", itemId: "read", title: "Read" }));
    auto.event(event({ turnId: "new", type: "item.completed", itemType: "tool", itemId: "read", ok: true }));
  }
  await auto.settled({ ...turn, turnId: "new", botId: kind === "room-chat" ? "other-bot" : "bot" });
  finish(["index.html"]);
  await first;
  expect(cancelQueued).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledOnce();
});

it.each([
  { humanText: "don't check this" }, { ok: false }, { interrupted: true }, { superseded: true }, { routine: true },
].flatMap(patch => [false, true].map(opaque => ({ patch, opaque }))))("cancels a pending decision and queued check after an ineligible write: %o", async ({ patch, opaque }) => {
  const cancelQueued = vi.fn();
  auto = createVerifyAuto({ enabled: () => true, freeMemory: () => 8 * 1024 ** 3, startAuto: start, scan, cancelQueued, log: vi.fn() });
  let finish!: (paths: string[]) => void;
  scan.mockImplementationOnce(() => new Promise(done => { finish = done; }));
  shell();
  const first = auto.settled(turn);
  expect(cancelQueued).toHaveBeenCalledOnce();
  if (opaque) auto.event(event({ turnId: "new", type: "item.started", itemType: "tool", itemId: "shell", title: "Bash" }));
  auto.event(event({ turnId: "new", type: "item.completed", itemType: "tool", itemId: "shell", ok: true, ...(opaque ? {} : { writes: ["index.html"] }) }));
  await auto.settled({ ...turn, turnId: "new", ...patch });
  finish(["index.html"]);
  await first;
  expect(cancelQueued).toHaveBeenCalledTimes(2);
  expect(scan).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled();
});

it("logs one low-memory skip with free MiB and does no scan", async () => {
  const log = vi.fn();
  auto = createVerifyAuto({ enabled: () => true, freeMemory: () => 2_655 * 1024 ** 2, startAuto: start, scan, log });
  shell();
  await auto.settled(turn);
  expect(log).toHaveBeenCalledExactlyOnceWith("Live Verify: skipped, low memory 2655 MiB");
  expect(scan).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

it.each(["this repo has no tests yet", "I don't test on Safari", "I usually skip tests on CI"])("does not treat a statement as an opt-out: %s", async humanText => {
  auto.event(event({ type: "item.completed", itemType: "tool", ok: true, writes: ["index.html"] }));
  await auto.settled({ ...turn, humanText });
  expect(start).toHaveBeenCalledOnce();
});

it.each([
  { title: "Bash" }, { title: "Shell" }, { title: "exec_command" },
  { provider: "codex", title: "npm run build", verb: "Bash" },
  { provider: "grokAgent", title: "npm run build", verb: "Bash" },
])("scans successful shell tools: %o", async fields => {
  auto.event(event({ ...fields, type: "item.started", itemType: "tool", itemId: "exec" }));
  auto.event(event({ provider: fields.provider ?? "claudeAgent", type: "item.completed", itemType: "tool", itemId: "exec", ok: true }));
  await auto.settled(turn);
  expect(scan).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledOnce();
});

it.each([
  { provider: "claudeAgent", title: "unknown" },
  { provider: "codex", title: "edit", verb: "Edit" },
  ...["grokAgent", "museAgent"].flatMap(provider => [
    { provider, title: "move index.html" }, { provider, title: "other" }, { provider, title: "edit", verb: "Edit" },
  ]),
  { provider: "antigravityAgent", title: "replace_file_content" },
])("scans successful opaque tools without write paths: %o", async fields => {
  auto.event(event({ ...fields, type: "item.started", itemType: "tool", itemId: "opaque" }));
  auto.event(event({ provider: fields.provider, type: "item.completed", itemType: "tool", itemId: "opaque", ok: true }));
  await auto.settled(turn);
  expect(scan).toHaveBeenCalledExactlyOnceWith(root, turn.startedAt);
  expect(start).toHaveBeenCalledOnce();
});

it("scans recent web files in output folders but skips hidden, dependency, coverage and linked folders", async () => {
  for (const folder of ["dist", "build", "out", "node_modules", ".git", ".next", ".nuxt", ".svelte-kit", ".turbo", "coverage", ".private"]) {
    await mkdir(join(root, folder));
    await writeFile(join(root, folder, "page.html"), "<h1>Page</h1>");
  }
  await symlink(join(root, "dist"), join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(join(root, "old.html"), "old");
  const old = new Date(turn.startedAt - 10_000);
  await utimes(join(root, "old.html"), old, old);
  const paths = await scanVerifyWrites(root, turn.startedAt);
  expect(paths.sort()).toEqual(["index.html", "dist/page.html", "build/page.html", "out/page.html"].map(path => resolvePath(path)).sort());
});

const resolvePath = (path: string) => join(root, ...path.split("/"));

it("caps directory entries even when they are not web files", async () => {
  let seen = 0;
  vi.mocked(opendir).mockResolvedValueOnce({ async *[Symbol.asyncIterator]() {
    for (let i = 0; i < VERIFY_LIMITS.scanEntries + 20; i++) {
      seen++;
      yield { name: `${i}.txt`, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true };
    }
  } } as Awaited<ReturnType<typeof opendir>>);
  await scanVerifyWrites(root, turn.startedAt);
  expect(seen).toBe(VERIFY_LIMITS.scanEntries + 1);
  expect(stat).not.toHaveBeenCalled();
});

it("returns within the time cap when directory I/O stalls", async () => {
  vi.mocked(opendir).mockImplementationOnce(() => new Promise(() => {}));
  const started = performance.now();
  expect(await scanVerifyWrites(root, turn.startedAt)).toEqual([]);
  expect(performance.now() - started).toBeLessThan(VERIFY_LIMITS.scanMs + 150);
});

it("scans an antigravityAgent edit tool without write events", async () => {
  auto.event(event({ provider: "antigravityAgent", type: "item.started", itemType: "tool", itemId: "edit", title: "replace_file_content" }));
  auto.event(event({ provider: "antigravityAgent", type: "item.completed", itemType: "tool", itemId: "edit", ok: true }));
  await auto.settled(turn);
  expect(scan).toHaveBeenCalledExactlyOnceWith(root, turn.startedAt);
  expect(start).toHaveBeenCalledOnce();
});

it.each(["claudeAgent", "codex", "grokAgent", "antigravityAgent", "museAgent"])("checks %s writes or opaque tools after settlement", async provider => {
  auto.event(event({ provider, type: "item.completed", itemType: "tool", ok: true, ...(["claudeAgent", "codex", "grokAgent"].includes(provider) ? { writes: [join(root, "index.html")] } : {}) }));
  await auto.settled(turn);
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ botId: "bot", threadId: "thread", entry: join(root, "index.html"), episode: expect.any(String) }));
  expect(scan).toHaveBeenCalledTimes(["antigravityAgent", "museAgent"].includes(provider) ? 1 : 0);
});
