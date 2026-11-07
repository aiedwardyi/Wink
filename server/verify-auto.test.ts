import { mkdir, mkdtemp, opendir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import { createVerifyAuto, scanVerifyWrites, type VerifyAutoTurn } from "./verify-auto.ts";
import { VERIFY_LIMITS } from "../shared/live-verify.ts";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat), opendir: vi.fn(actual.opendir) };
});

let root: string;
let start: ReturnType<typeof vi.fn<(input: { botId: string; threadId: string; entry: string; episode: string }) => Promise<void>>>;
let scan: ReturnType<typeof vi.fn<typeof scanVerifyWrites>>;
let auto: ReturnType<typeof createVerifyAuto>;
let turn: VerifyAutoTurn;
const event = (fields: Partial<RuntimeEvent>) => ({ eventId: "e", provider: "claude", threadId: "thread", turnId: "turn", createdAt: new Date().toISOString(), ...fields }) as RuntimeEvent;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wink-verify-auto-"));
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

it.each(["don't check", "do not verify", "don't test", "skip verification", "확인하지 마", "검사 빼고", "테스트 없이"])("skips task opt-out: %s", async humanText => {
  auto.event(event({ type: "item.completed", itemType: "tool", ok: true }));
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
  auto.event(event({ type: "item.completed", itemType: "tool", ok: true }));
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
  auto.event(event({ type: "item.completed", itemType: "tool", ok: true }));
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

it("ignores URLs without a package candidate and ignores non-web writes", async () => {
  await writeFile(join(root, "notes.md"), "hi");
  auto.event(event({ type: "item.completed", itemType: "tool", ok: true, writes: ["notes.md"] }));
  await auto.settled({ ...turn, reply: "http://127.0.0.1:12345" });
  expect(start).not.toHaveBeenCalled();
});

it("replaces an older pending decision in the same thread", async () => {
  let finish!: (paths: string[]) => void;
  scan.mockImplementationOnce(() => new Promise(done => { finish = done; }));
  auto.event(event({ type: "item.completed", itemType: "tool", ok: true }));
  const first = auto.settled(turn);
  auto.event(event({ turnId: "new", type: "item.completed", itemType: "tool", ok: true, writes: ["index.html"] }));
  await auto.settled({ ...turn, turnId: "new", humanId: "new-human" });
  finish(["index.html"]);
  await first;
  expect(start).toHaveBeenCalledOnce();
  expect(start.mock.calls[0]![0].episode).toContain("new-human");
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

it.each(["claude", "codex", "grok", "antigravity", "muse"])("checks %s writes or opaque tools after settlement", async provider => {
  auto.event(event({ provider, type: "item.completed", itemType: "tool", ok: true, ...(["claude", "codex", "grok"].includes(provider) ? { writes: [join(root, "index.html")] } : {}) }));
  await auto.settled(turn);
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ botId: "bot", threadId: "thread", entry: join(root, "index.html"), episode: expect.any(String) }));
  expect(scan).toHaveBeenCalledTimes(["antigravity", "muse"].includes(provider) ? 1 : 0);
});
