import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { chunk, decodeChunks } from "../electron/verify-replay.mjs";
import { createReplay, pruneReplays } from "./verify-replay.ts";

const head = { v: 1, runId: "run-123456", site: "site/index.html", page: "index.html", startedAt: Date.now(), tiles: { desktop: [1280, 720], phone: [392, 800] } };
const end = { status: "completed", ms: 1000, issues: [], notChecked: [] };
const frame = (ms: number, tile = "desktop", size = 70_000) => chunk(1, { tile, ms, data: Buffer.alloc(size, 1) });

it("ships an encoded fixture with both JPEG tiles and a boxed problem", async () => {
  const bytes = await readFile(new URL("../scripts/fixtures/verify-replay/sample.lvr", import.meta.url));
  expect(bytes.length).toBeLessThan(300_000);
  expect(bytes.subarray(0, 4).toString()).toBe("LVR1");
  const rows: any[] = [], decoder = decodeChunks(row => rows.push(row));
  decoder.push(bytes.subarray(4)); decoder.end();
  expect(rows[0].value).toMatchObject({ v: 1, page: "index.html", tiles: { desktop: [1280, 720], phone: [392, 800] } });
  expect(rows.filter(row => row.kind === 1).map(row => row.tile)).toEqual(["desktop", "phone"]);
  for (const row of rows.filter(row => row.kind === 1)) expect([...row.data.subarray(0, 2)]).toEqual([255, 216]);
  expect(rows.at(-1).value.issues[0].box).toHaveLength(4);
  expect(rows.some(row => row.value.kind === "checks")).toBe(true);
});

it("thins under 3 MiB, preserving post-scroll and last frames and all marks", () => {
  const replay = createReplay(head);
  replay.add(chunk(2, { kind: "scroll", tile: "desktop", y: 200, ms: 1 }));
  replay.add(frame(2));
  for (let i = 3; i < 100; i++) replay.add(frame(i));
  replay.add(frame(100, "phone"));
  replay.finish(end);
  const bytes = replay.file(), rows: any[] = [], decoder = decodeChunks(row => rows.push(row));
  expect(bytes.length).toBeLessThanOrEqual(3 * 1024 * 1024);
  expect(bytes.subarray(0, 4).toString()).toBe("LVR1");
  decoder.push(bytes.subarray(4)); decoder.end();
  expect(rows.filter(r => r.kind === 1).length).toBeLessThan(99);
  expect(rows.filter(r => r.kind === 1).map(r => r.ms)).toEqual(expect.arrayContaining([2, 99, 100]));
  expect(rows.filter(r => r.kind === 2)).toHaveLength(1);
  expect(rows.at(-1)).toMatchObject({ kind: 3, ...end });
});

it("late live subscribers get head, latest tile frames, marks and end", () => {
  const replay = createReplay(head);
  replay.add(frame(1)); replay.add(frame(2)); replay.add(frame(3, "phone"));
  replay.add(chunk(2, { kind: "part", part: "links", ms: 4 }));
  const seen: Buffer[] = [], close = replay.subscribe(bytes => { seen.push(bytes); return true; });
  const second = replay.subscribe(() => true);
  expect(() => replay.subscribe(() => true)).toThrow("busy");
  replay.finish(end);
  const rows: any[] = [], decoder = decodeChunks(row => rows.push(row));
  decoder.push(Buffer.concat(seen)); decoder.end();
  expect(rows.map(r => r.kind)).toEqual([0, 1, 1, 2, 3]);
  expect(rows.filter(r => r.kind === 1).map(r => r.ms)).toEqual([2, 3]);
  close(); second();
});

it("makes room for marks by thinning frames before dropping a mark", () => {
  const replay = createReplay(head);
  for (let i = 0; i < 40; i++) replay.add(frame(i));
  replay.add(chunk(2, { kind: "hold", text: "x".repeat(180_000), ms: 50 }));
  replay.finish(end);
  const rows: any[] = [], decoder = decodeChunks(row => rows.push(row)); decoder.push(replay.file().subarray(4)); decoder.end();
  expect(replay.file().length).toBeLessThanOrEqual(3 * 1024 * 1024);
  expect(rows.some(row => row.kind === 2 && row.value.text.length === 180_000)).toBe(true);
});

it("writes with no disk work before save and prunes per card, age and total bytes", async () => {
  const scratch = join(tmpdir(), "wink-LV-WATCH-REC");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "prune-")), now = Date.now();
  for (let i = 0; i < 5; i++) {
    const replay = createReplay({ ...head, runId: `run-12345${i}` });
    replay.finish(end);
    await replay.save(root, "thread-1", "card-1");
  }
  const kept = await pruneReplays(root, now);
  expect(kept.get("thread-1/card-1")).toEqual(["run-123452", "run-123453", "run-123454"]);
  const file = join(root, "thread-1", "run-123452.lvr");
  expect((await readFile(file)).subarray(0, 4).toString()).toBe("LVR1");
  await utimes(file, new Date(now - 8 * 86400_000), new Date(now - 8 * 86400_000));
  expect((await pruneReplays(root, now)).get("thread-1/card-1")).not.toContain("run-123452");
  await mkdir(join(root, "thread-2"));
  await writeFile(join(root, "thread-2", "run-999999.lvr"), Buffer.alloc(100));
  expect([...(await pruneReplays(root, now, 50)).values()].flat()).toEqual([]);
});
