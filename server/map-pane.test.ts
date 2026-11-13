import { execFileSync } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { MapSnapshot } from "../shared/map-pane.ts";
import { listenLocal } from "./phone-relay/testing/net.ts";
import { mapFileDiff, mapFiles, mapHead, mapDiffLines, MAP_LINE_LIMIT } from "./map-git.ts";
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
  expect(files).toEqual(expect.arrayContaining([{ path: "file.ts", added: 1, removed: 1 }, { path: "new.ts", added: 2, removed: 0 }]));
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

it("folds unchanged runs between unified hunks and caps rendered lines", () => {
  const diff = mapDiffLines("@@ -20,1 +20,1 @@\n-old\n+new\n@@ -50,1 +50,1 @@\n-next\n+last\n");
  expect(diff.lines.filter(line => line.kind === "fold").map(line => line.count)).toEqual([19, 29]);
  expect(mapDiffLines("@@ -1,0 +1,1000 @@\n" + "+x\n".repeat(1000))).toMatchObject({ capped: true });
});

it("does no work before opening, refreshes from real edit events, and stops on close", async () => {
  const { root, git } = repo();
  const read = vi.fn(async (): Promise<MapPaneRecord[]> => [{ sessionId: "pane-a", cwd: root, label: "ALPHA | script", main: false, exited: false }]);
  let listener: (() => void) | undefined;
  const unsub = vi.fn();
  const feature = createMapPane({ panes: read, title: () => "Fix layout", subscribe: (_bot, next) => { listener = next; return unsub; } });
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
  expect(JSON.parse(first.split("\n\n")[0].slice(6)).workers[0].files).toEqual([{ path: "file.ts", added: 1, removed: 1 }]);
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
