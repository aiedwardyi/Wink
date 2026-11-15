import { execFileSync } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { MapSnapshot } from "../shared/map-pane.ts";
import { listenLocal } from "./phone-relay/testing/net.ts";
import { createMapPane, type MapPaneRecord } from "./map-pane.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const roots: string[] = [];
const servers: Server[] = [];
const streams: ServerResponse[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const stream of streams.splice(0)) stream.end();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  for (const root of roots.splice(0)) await removeTempDir(root);
});

const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
const watchers = () => process.getActiveResourcesInfo().filter(type => type === "FSEventWrap").length;

function repo() {
  const root = mkdtempSync(join(tmpdir(), "wink-map-test-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { windowsHide: true, encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(root, "file.ts"), "const before = 1;\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial");
  return { root, base: git("rev-parse", "HEAD") };
}

async function open(workers: MapPaneRecord[], reason?: () => string | undefined) {
  let listener = () => {};
  const feature = createMapPane({ panes: async () => workers, reason, subscribe: (_bot, next) => { listener = next; return () => {}; } });
  const server = createServer((req, res) => {
    streams.push(res);
    void feature.handle(req, res, "bot", "live", new URL(req.url!, "http://localhost"));
  });
  servers.push(server);
  const abort = new AbortController();
  const reader = (await fetch(`http://127.0.0.1:${await listenLocal(server)}/live`, { signal: abort.signal })).body!.getReader();
  const seen: MapSnapshot[] = [];
  let buffered = "";
  async function until(check: (data: MapSnapshot) => boolean): Promise<MapSnapshot> {
    for (;;) {
      const end = buffered.indexOf("\n\n");
      if (end >= 0) {
        const data: MapSnapshot = JSON.parse(buffered.slice(6, end));
        buffered = buffered.slice(end + 2);
        seen.push(data);
        if (check(data)) return data;
      } else {
        const { value, done } = await reader.read();
        // A closed stream reads as done forever: without this a failed wait spins.
        if (done) throw new Error("Map stream ended");
        buffered += new TextDecoder().decode(value);
      }
    }
  }
  return { seen, until, chat: () => listener(), close: () => abort.abort() };
}

it("runs no git for idle workers on chat events and still sends a changed reason line", async () => {
  const workers = ["pane-a", "pane-b", "pane-c"].map(sessionId => { const { root, base } = repo(); return { sessionId, cwd: root, label: sessionId, baseHead: base }; });
  let reason: string | undefined;
  const trace = join(mkdtempSync(join(tmpdir(), "wink-map-trace-")), "git.jsonl");
  roots.push(join(trace, ".."));
  // Git logs each of its own runs here, so the count needs no stand-in for git.
  vi.stubEnv("GIT_TRACE2_EVENT", trace);
  const gitRuns = () => readFileSync(trace, "utf8").split("\n").filter(line => line.includes('"event":"start"')).length;
  const map = await open(workers, () => reason);
  await map.until(data => data.workers.length === 3);
  const runs = gitRuns();
  for (let event = 0; event < 10; event++) { map.chat(); await pause(20); }
  reason = "Fix the layout";
  map.chat();
  await map.until(data => data.workers.every(worker => worker.reason === "Fix the layout"));
  await pause(300);
  map.close();
  expect(gitRuns()).toBe(runs);
  expect(map.seen).toHaveLength(2);
});

it("caps a worker's new files so three such workers still open in one snapshot", async () => {
  const { root, base } = repo();
  const dir = "d".repeat(120);
  mkdirSync(join(root, dir));
  for (let i = 0; i < 5000; i++) writeFileSync(join(root, dir, `f${i}.ts`), "");
  const map = await open(["pane-a", "pane-b", "pane-c"].map(sessionId => ({ sessionId, cwd: root, label: sessionId, baseHead: base })));
  const first = await map.until(() => true);
  map.close();
  expect(first.error).toBeUndefined();
  expect(first.workers.map(worker => [worker.files.length, worker.more, worker.error])).toEqual(Array(3).fill([200, 4800, undefined]));
  expect(JSON.stringify(first).length).toBeLessThan(1024 * 1024);
}, 60_000);

it.skipIf(process.platform !== "win32")("closes the watcher of a removed folder on its first event and marks only that worker", async () => {
  const gone = repo();
  const kept = repo();
  const map = await open([{ sessionId: "pane-a", cwd: gone.root, label: "GONE", baseHead: gone.base }, { sessionId: "pane-b", cwd: kept.root, label: "KEPT", baseHead: kept.base }]);
  await map.until(data => data.workers.length === 2);
  const watching = watchers();
  const timers = vi.spyOn(globalThis, "setTimeout");
  rmSync(gone.root, { recursive: true, force: true });
  await pause(500);
  expect(timers.mock.calls.filter(([, ms]) => ms === 65).length).toBeLessThan(5);
  expect(watchers()).toBe(watching - 1);
  const failed = await map.until(data => data.workers[0].error === true);
  map.close();
  expect(failed.error).toBeUndefined();
  expect(failed.workers[1].error).toBeUndefined();
});
