import { execFileSync } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { MapSnapshot } from "../shared/map-pane.ts";
import { listenLocal } from "./phone-relay/testing/net.ts";
import { mapFileDiff, mapFiles, mapHead, mapDiffLines, mapWalkFiles, MAP_LINE_LIMIT } from "./map-git.ts";
import { createMapPane, type MapPaneRecord } from "./map-pane.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { watchMapPanes } from "./map-events.ts";
import { terminalReadGrant } from "./terminal-grant.ts";

const roots: string[] = [];
const servers: Server[] = [];
const streams: ServerResponse[] = [];
afterEach(async () => {
  for (const stream of streams.splice(0)) stream.end();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  for (const root of roots.splice(0)) await removeTempDir(root);
});

function repo() {
  const root = mkdtempSync(join(tmpdir(), "wink-map-test-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { windowsHide: true, encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(root, "file.ts"), "const before = 1;\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial");
  return { root, git, base: git("rev-parse", "HEAD") };
}

it("keeps committed, staged, unstaged and untracked edits against launch HEAD", async () => {
  const { root, git, base } = repo();
  writeFileSync(join(root, "file.ts"), "const after = 2;\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "edit");
  writeFileSync(join(root, "new.ts"), "new\nfile\n");
  const files = await mapFiles(root, base);
  expect(files).toEqual(expect.arrayContaining([{ path: "file.ts", added: 1, removed: 1, ranges: [[1, 1]] }, { path: "new.ts", added: 2, removed: 0, ranges: [[1, 2]] }]));
  expect((await mapFileDiff(root, base, files[0])).lines).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "remove", text: "const before = 1;" }),
    expect.objectContaining({ kind: "add", text: "const after = 2;" }),
  ]));
  writeFileSync(join(root, "file.ts"), "const staged = 3;\n");
  git("add", "file.ts");
  writeFileSync(join(root, "file.ts"), "const unstaged = 4;\n");
  expect((await mapFileDiff(root, base, files[0])).lines.some(line => line.text === "const unstaged = 4;")).toBe(true);
});

it("handles literal unusual paths, deleted files, binary files and large new files", async () => {
  const { root, git, base } = repo();
  git("rm", "-q", "file.ts");
  writeFileSync(join(root, "[hello] space.ts"), "one\ntwo");
  writeFileSync(join(root, "image.bin"), Buffer.from([0, 1, 2]));
  writeFileSync(join(root, "large.ts"), "x".repeat(2200) + "\n" + "line\n".repeat(1200));
  const files = await mapFiles(root, base);
  expect(files.find(file => file.path === "file.ts")).toMatchObject({ added: 0, removed: 1 });
  expect(files.find(file => file.path === "[hello] space.ts")?.added).toBe(2);
  expect(files.find(file => file.path === "large.ts")?.added).toBe(1201);
  expect(await mapFileDiff(root, base, files.find(file => file.path === "image.bin")!)).toEqual({ lines: [], binary: true });
  const large = await mapFileDiff(root, base, files.find(file => file.path === "large.ts")!);
  expect(large.capped).toBe(true);
  expect(large.lines).toHaveLength(MAP_LINE_LIMIT);
  expect(large.lines[0].text).toHaveLength(2000);
});

it("reads plain patches when user Git colors are always enabled", async () => {
  const { root, git, base } = repo();
  git("config", "color.ui", "always");
  git("config", "color.diff", "always");
  writeFileSync(join(root, "file.ts"), "const colored = 2;\n");
  const files = await mapFiles(root, base);
  expect((await mapFileDiff(root, base, files[0])).lines).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "remove", text: "const before = 1;" }),
    expect.objectContaining({ kind: "add", text: "const colored = 2;" }),
  ]));
});

it("keeps a deleted file diff separate from its replacement directory", async () => {
  const { root, git, base } = repo();
  git("rm", "-q", "file.ts");
  mkdirSync(join(root, "file.ts"));
  writeFileSync(join(root, "file.ts", "app.ts"), "new\n");
  git("add", ".");
  const files = await mapFiles(root, base);
  expect(files).toHaveLength(2);
  expect((await mapFileDiff(root, base, files.find(file => file.path === "file.ts")!)).lines).toEqual([
    { kind: "remove", text: "const before = 1;", line: 1 },
  ]);
  expect((await mapFileDiff(root, base, files.find(file => file.path === "file.ts/app.ts")!)).lines).toEqual([
    { kind: "add", text: "new", line: 1 },
  ]);
});

it("reads the whole file with its changes marked", async () => {
  const { root, git } = repo();
  const text = (six: string) => Array.from({ length: 12 }, (_, index) => index === 5 ? six : `line ${index + 1}`).join("\n") + "\n";
  writeFileSync(join(root, "file.ts"), text("line 6"));
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "long");
  writeFileSync(join(root, "file.ts"), text("line six"));
  const base = git("rev-parse", "HEAD");
  const [file] = await mapFiles(root, base);
  expect((await mapFileDiff(root, base, file)).lines.map(line => line.kind)).toEqual(["fold", ...Array(3).fill("context"), "remove", "add", ...Array(3).fill("context"), "fold"]);
  const whole = await mapFileDiff(root, base, file, true);
  expect(whole.lines.map(line => line.kind)).toEqual([...Array(5).fill("context"), "remove", "add", ...Array(6).fill("context")]);
  expect(whole.lines.at(-1)).toEqual({ kind: "context", text: "line 12", line: 12 });
});

it("keeps each changed file's launch line ranges for clash checks", async () => {
  const { root, git } = repo();
  const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
  writeFileSync(join(root, "file.ts"), lines.join("\n") + "\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "long");
  const base = git("rev-parse", "HEAD");
  const edited = lines.toSpliced(18, 0, "inserted").toSpliced(10, 2).with(2, "three");
  writeFileSync(join(root, "file.ts"), edited.join("\n") + "\n");
  writeFileSync(join(root, "new.ts"), "a\nb\n");
  const files = await mapFiles(root, base);
  expect(files.find(file => file.path === "file.ts")?.ranges).toEqual([[3, 3], [11, 12], [18, 18]]);
  expect(files.find(file => file.path === "new.ts")?.ranges).toEqual([[1, 2]]);
});

it("walks a folder without Git for its file names, skipping dependencies and capping entries", async () => {
  const folder = mkdtempSync(join(tmpdir(), "wink-map-plain-"));
  roots.push(folder);
  for (const dir of ["notes", "node_modules/pkg", ".git"]) mkdirSync(join(folder, dir), { recursive: true });
  for (const file of ["b.txt", "a.txt", "notes/c.md", "node_modules/pkg/index.js", ".git/HEAD"]) writeFileSync(join(folder, file), "x\n");
  const feature = createMapPane({ panes: async () => [{ sessionId: "pane-a", cwd: folder, label: "SCRIPT" }], subscribe: () => () => {} });
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (url.pathname === "/live") streams.push(res);
    void feature.handle(req, res, "bot", url.pathname.slice(1), url);
  });
  servers.push(server);
  const url = `http://127.0.0.1:${await listenLocal(server)}`;
  const abort = new AbortController();
  const reader = (await fetch(`${url}/live`, { signal: abort.signal })).body!.getReader();
  let text = "";
  while (!text.includes("SCRIPT")) text += new TextDecoder().decode((await reader.read()).value);
  expect(JSON.parse(text.slice(6, text.indexOf("\n\n"))).workers[0]).toMatchObject({ git: false, files: [] });
  const listed = await fetch(`${url}/repo?worker=pane-a`).then(res => res.json());
  abort.abort();
  expect(listed).toEqual({ name: expect.stringMatching(/^wink-map-plain-/), paths: ["a.txt", "b.txt", "notes/c.md"] });
  expect(await mapWalkFiles(folder, 3)).toEqual(["a.txt", "b.txt"]);
});

it("shows the whole file when only its mode changed", async () => {
  const { root, git, base } = repo();
  git("update-index", "--chmod=+x", "file.ts");
  const [file] = await mapFiles(root, base);
  expect(file).toEqual({ path: "file.ts", added: 0, removed: 0 });
  expect((await mapFileDiff(root, base, file, true)).lines).toEqual([{ kind: "context", text: "const before = 1;", line: 1 }]);
});

it("folds unchanged runs between unified hunks and caps rendered lines", () => {
  const diff = mapDiffLines("@@ -20,1 +20,1 @@\n-old\n+new\n@@ -50,1 +50,1 @@\n-next\n+last\n");
  expect(diff.lines.filter(line => line.kind === "fold").map(line => [line.line, line.count])).toEqual([[1, 19], [21, 29]]);
  expect(mapDiffLines("@@ -1,0 +1,1000 @@\n" + "+x\n".repeat(1000))).toMatchObject({ capped: true });
});

it.each([1999, 2000, 2001])("caps tracked content at 2000 characters (%s)", length => {
  const diff = mapDiffLines(`@@ -0,0 +1,1 @@\n+${"x".repeat(length)}\n`);
  expect(diff.lines[0].text).toHaveLength(Math.min(length, 2000));
  expect(diff.capped).toBe(length > 2000);
});

it("never shows the bot's thread title as a worker's task", async () => {
  const { root } = repo();
  const deps = { panes: async (): Promise<MapPaneRecord[]> => [{ sessionId: "pane-a", cwd: root, label: "ENGINE-ROWS | opus" }, { sessionId: "pane-b", cwd: root, label: "BIG-PIC | sonnet" }], title: () => "Initialize as my Orbit teacher", subscribe: () => () => {} };
  const feature = createMapPane(deps);
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    streams.push(res);
    void feature.handle(req, res, "bot", "live", url);
  });
  servers.push(server);
  const abort = new AbortController();
  const reader = (await fetch(`http://127.0.0.1:${await listenLocal(server)}/live`, { signal: abort.signal })).body!.getReader();
  let text = "";
  while (!text.includes("BIG-PIC")) text += new TextDecoder().decode((await reader.read()).value);
  abort.abort();
  const { workers }: MapSnapshot = JSON.parse(text.slice(text.lastIndexOf("data: ") + 6).trim());
  expect(workers.map(worker => worker.nick)).toEqual(["ENGINE-ROWS", "BIG-PIC"]);
  expect(text).not.toContain("Initialize as my Orbit teacher");
});

it("does no work before opening, refreshes from real edit events, and stops on close", async () => {
  const { root, git } = repo();
  const read = vi.fn(async (): Promise<MapPaneRecord[]> => [{ sessionId: "pane-a", cwd: root, label: "ALPHA | script", main: false, exited: false }]);
  let listener: (() => void) | undefined;
  const unsub = vi.fn();
  const feature = createMapPane({ panes: read, subscribe: (_bot, next) => { listener = next; return unsub; } });
  expect(read).not.toHaveBeenCalled();
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (url.pathname === "/live") streams.push(res);
    void feature.handle(req, res, "bot", url.pathname.slice(1), url);
  });
  servers.push(server);
  const url = `http://127.0.0.1:${await listenLocal(server)}`;
  const abort = new AbortController();
  const response = await fetch(`${url}/live`, { signal: abort.signal });
  const reader = response.body!.getReader();
  let buffered = "";
  async function until(check: (data: MapSnapshot) => boolean): Promise<MapSnapshot> {
    for (;;) {
      const end = buffered.indexOf("\n\n");
      if (end >= 0) {
        const data: MapSnapshot = JSON.parse(buffered.slice(6, end));
        buffered = buffered.slice(end + 2);
        if (check(data)) return data;
      } else buffered += new TextDecoder().decode((await reader.read()).value);
    }
  }
  await until(data => data.workers.length === 1);
  writeFileSync(join(root, "file.ts"), "const realEdit = 7;\n");
  const changed = await until(data => data.workers[0]?.files.length === 1);
  expect(changed.workers[0]).toMatchObject({ path: "file.ts", nick: "ALPHA" });
  const diff = await fetch(`${url}/file?worker=pane-a&path=file.ts`).then(res => res.json());
  expect(diff).toMatchObject({ lines: expect.arrayContaining([expect.objectContaining({ text: "const realEdit = 7;" })]) });
  expect((await fetch(`${url}/file?worker=pane-a&path=../outside`)).status).toBe(404);
  writeFileSync(join(root, ".git", "info", "exclude"), "ignored.log\n");
  writeFileSync(join(root, "ignored.log"), "noise\n");
  const listed = await fetch(`${url}/repo?worker=pane-a`).then(res => res.json() as Promise<{ name: string; paths: string[] }>);
  expect(listed.paths).toEqual(["file.ts"]);
  expect(listed.name).toMatch(/^wink-map-test-/);
  expect((await fetch(`${url}/repo?worker=pane-b`)).status).toBe(404);
  abort.abort();
  await vi.waitFor(() => expect(unsub).toHaveBeenCalledOnce());
  const count = read.mock.calls.length;
  writeFileSync(join(root, "file.ts"), "closed\n");
  listener?.();
  await new Promise(done => setTimeout(done, 200));
  expect(read).toHaveBeenCalledTimes(count);
  expect((await fetch(`${url}/file?worker=pane-a&path=file.ts`)).status).toBe(404);
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "worker commit");
  const againAbort = new AbortController();
  const again = await fetch(`${url}/live`, { signal: againAbort.signal });
  const first = new TextDecoder().decode((await again.body!.getReader().read()).value);
  expect(JSON.parse(first.split("\n\n")[0].slice(6)).workers[0].files).toEqual([{ path: "file.ts", added: 1, removed: 1, ranges: [[1, 1]] }]);
  againAbort.abort();
});

it("recognizes non-git folders", async () => {
  const folder = mkdtempSync(join(tmpdir(), "wink-map-plain-"));
  roots.push(folder);
  expect(await mapHead(folder)).toBeNull();
});

it("subscribes to authorized lifecycle events and disconnects when Map closes", async () => {
  const listener = vi.fn();
  let response: ServerResponse | undefined;
  let closed = false;
  const server = createServer((req, res) => {
    expect(req.url).toBe("/v1/bots/bot/terminal/map-events");
    expect(req.headers.authorization).toBe(`Bearer ${terminalReadGrant("secret", "bot")}`);
    response = res;
    streams.push(res);
    res.once("close", () => { closed = true; });
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write("{}\n");
  });
  servers.push(server);
  const stop = watchMapPanes({ url: `http://127.0.0.1:${await listenLocal(server)}`, token: "secret" }, "bot", listener);
  await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
  response!.write("{}\n");
  await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
  stop();
  await vi.waitFor(() => expect(closed).toBe(true));
});

it("disconnects when the lifecycle bridge rejects the request", async () => {
  const server = createServer((_req, res) => { res.writeHead(503); res.end(); });
  servers.push(server);
  const disconnected = vi.fn();
  const stop = watchMapPanes({ url: `http://127.0.0.1:${await listenLocal(server)}`, token: "secret" }, "bot", vi.fn(), disconnected);
  try { await vi.waitFor(() => expect(disconnected).toHaveBeenCalledOnce()); }
  finally { stop(); }
});
