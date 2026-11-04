import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync, renameSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import type { UsageBoardEvent, UsageBoardSample } from "../src/lib/usage-board.ts";

const CAP = 256 * 1024;
const READ_CAP = 1024 * 1024;
const WRITE_INTERVAL = 30_000;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,96}$/).refine((value) => !["__proto__", "constructor", "prototype"].includes(value));
const percent = z.number().finite().nonnegative().max(1_000_000).nullable();
const sampleSchema = z.tuple([integer, percent, percent]);
const eventSchema = z.object({
  seq: integer,
  at: integer,
  kind: z.enum(["main", "auto", "limit", "reset", "moved"]),
  accountId: id.optional(),
  window: z.string().regex(/^[A-Za-z0-9_:-]{1,64}$/).optional(),
  from: id.optional(),
  to: id.optional(),
  paneId: id.optional(),
  label: z.string().regex(/^[^@\p{Cc}\p{Cf}\p{Cs}]*$/u).refine((value) => [...value].length <= 24).optional(),
}).strict();
const accountSchema = z.object({ generation: integer, fine: z.array(sampleSchema).max(288), coarse: z.array(sampleSchema).max(168) }).strict();
const stateSchema = z.object({
  version: z.literal(1),
  accounts: z.record(id, accountSchema),
  events: z.record(id, z.array(eventSchema).max(64)),
  seq: integer,
}).strict();
type State = z.infer<typeof stateSchema>;
type Options = { now?: () => number; schedule?: (callback: () => void, delayMs: number) => unknown };
type Bucket = { at: number; counter: number };
const empty = (): State => ({ version: 1, accounts: {}, events: {}, seq: 0 });
const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const names = (event: UsageBoardEvent, accountId: string) => [event.accountId, event.from, event.to].includes(accountId);
const rounded = (value: number | null) => value === null ? null : Math.round(value * 10) / 10;

function load(path: string): State {
  let fd: number | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > READ_CAP) throw new Error("Invalid usage history");
    fd = openSync(path, "r");
    const bytes = Buffer.alloc(READ_CAP + 1);
    let size = 0;
    for (;;) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      size += count;
      if (size > READ_CAP) throw new Error("Usage history too large");
      if (!count) break;
    }
    const state = stateSchema.parse(JSON.parse(bytes.subarray(0, size).toString("utf8")));
    for (const account of Object.values(state.accounts)) {
      for (const [key, step] of [["fine", 5], ["coarse", 60]] as const) {
        if (account[key].some((point, i, points) => point[0] % step !== 0 || (i > 0 && points[i - 1][0] >= point[0]))) throw new Error("Invalid usage buckets");
      }
    }
    const sequences = new Set<number>();
    for (const events of Object.values(state.events)) {
      for (const [i, event] of events.entries()) {
        if (event.seq > state.seq || sequences.has(event.seq) || (i > 0 && events[i - 1].seq >= event.seq)) throw new Error("Invalid usage events");
        sequences.add(event.seq);
      }
    }
    return state;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      if (fd !== undefined) { closeSync(fd); fd = undefined; }
      try { renameSync(path, `${path}.bad`); } catch { /* best effort */ }
    }
    return empty();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function createUsageHistory(dataDir: string, options: Options = {}) {
  const path = join(dataDir, "usage-history.json");
  const state = load(path);
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs).unref());
  const buckets = new Map<string, Map<number, Bucket>>();
  const eventsChanged = new Map<number, number>();
  let counter = 0;
  let bytes = byteLength(state);
  let dirty = false;
  let pending = false;
  let writing: Promise<void> | undefined;
  let lastWrite = -Infinity;

  function bucketMap(accountId: string, kind: "fine" | "coarse") {
    const key = `${accountId}:${kind}`;
    let map = buckets.get(key);
    if (!map) { map = new Map(); buckets.set(key, map); }
    return map;
  }

  function trim() {
    for (const kind of ["coarse", "events", "fine"] as const) {
      while (bytes > CAP) {
        const oldest = kind === "events"
          ? Object.entries(state.events).flatMap(([base, list]) => list.map((event) => [base, event] as const))
            .sort((a, b) => a[1].at - b[1].at || a[1].seq - b[1].seq)[0]
          : Object.entries(state.accounts).filter(([, account]) => account[kind].length).sort((a, b) => a[1][kind][0][0] - b[1][kind][0][0])[0];
        if (!oldest) break;
        const accountId = oldest[0];
        if (kind === "events") {
          const list = state.events[accountId];
          const before = byteLength(list);
          const index = list.findIndex((event) => event.seq === (oldest[1] as UsageBoardEvent).seq);
          eventsChanged.delete(list.splice(index, 1)[0].seq);
          bytes += byteLength(list) - before;
        } else {
          const account = state.accounts[accountId];
          const before = byteLength(account);
          account[kind].shift();
          bytes += byteLength(account) - before;
        }
      }
    }
    if (bytes > CAP) {
      for (const base of Object.keys(state.events)) {
        if (!state.events[base].length) delete state.events[base];
      }
      for (const accountId of Object.keys(state.accounts)) {
        const account = state.accounts[accountId];
        if (!account.fine.length && !account.coarse.length) {
          delete state.accounts[accountId];
          buckets.delete(`${accountId}:fine`);
          buckets.delete(`${accountId}:coarse`);
        }
      }
      bytes = byteLength(state);
    }
  }

  function queue() {
    if (!dirty || pending || writing) return;
    pending = true;
    schedule(() => { pending = false; void flush(); }, Math.max(0, lastWrite + WRITE_INTERVAL - now()));
  }

  function changed() {
    dirty = true;
    trim();
    queue();
  }

  async function flush(): Promise<void> {
    if (writing) return writing;
    if (!dirty) return;
    if (now() - lastWrite < WRITE_INTERVAL) { queue(); return; }
    lastWrite = now();
    dirty = false;
    const text = JSON.stringify(state);
    const temp = `${path}.tmp-${randomUUID()}`;
    writing = (async () => {
      let created = false;
      try {
        await mkdir(dataDir, { recursive: true });
        const file = await open(temp, "wx", 0o600);
        created = true;
        try { await file.writeFile(text, "utf8"); await file.sync(); } finally { await file.close(); }
        await rename(temp, path);
        created = false;
      } catch {
        dirty = true;
      } finally {
        if (created) { try { await unlink(temp); } catch { /* best effort */ } }
      }
    })();
    await writing;
    writing = undefined;
    queue();
  }

  function purge(accountId: string) {
    let removed = Object.hasOwn(state.accounts, accountId);
    delete state.accounts[accountId];
    buckets.delete(`${accountId}:fine`);
    buckets.delete(`${accountId}:coarse`);
    for (const [base, events] of Object.entries(state.events)) {
      state.events[base] = events.filter((event) => {
        if (!names(event, accountId)) return true;
        eventsChanged.delete(event.seq);
        removed = true;
        return false;
      });
    }
    if (!removed) return;
    counter++;
    bytes = byteLength(state);
    changed();
  }

  function record(accountId: string, generation: number, observedAt: number, session: number | null, week: number | null) {
    if (!id.safeParse(accountId).success || !integer.safeParse(generation).success || !integer.safeParse(observedAt).success
      || !percent.safeParse(session).success || !percent.safeParse(week).success) return;
    let account = Object.hasOwn(state.accounts, accountId) ? state.accounts[accountId] : undefined;
    if (account && generation < account.generation) return;
    if (account && account.generation !== generation) { purge(accountId); account = undefined; }
    const before = account && byteLength(account);
    const fresh = !account;
    if (!account) state.accounts[accountId] = account = { generation, fine: [], coarse: [] };
    let updated = fresh;
    for (const [kind, step, max] of [["fine", 5, 288], ["coarse", 60, 168]] as const) {
      const points = account[kind];
      const minute = Math.floor(observedAt / 60_000 / step) * step;
      const map = bucketMap(accountId, kind);
      const previous = map.get(minute);
      if (previous && observedAt <= previous.at) continue;
      const newest = Math.max(points.at(-1)?.[0] ?? minute, ...map.keys());
      if (minute <= newest - max * step) continue;
      const index = points.findIndex((point) => point[0] === minute);
      const point: UsageBoardSample = [minute, rounded(session), rounded(week)];
      if (index >= 0 && !previous && points[index][1] === point[1] && points[index][2] === point[2]) {
        map.set(minute, { at: observedAt, counter: 0 });
        continue;
      }
      if (index >= 0) points[index] = point;
      else { points.push(point); points.sort((a, b) => a[0] - b[0]); }
      map.set(minute, { at: observedAt, counter: counter + 1 });
      const cutoff = points.at(-1)![0] - (max - 1) * step;
      while (points.length && points[0][0] < cutoff) points.shift();
      for (const key of map.keys()) if (key < cutoff) map.delete(key);
      updated = true;
    }
    if (!updated) return;
    counter++;
    bytes = fresh ? byteLength(state) : bytes + byteLength(account) - before!;
    changed();
  }

  function event(base: string, input: Omit<UsageBoardEvent, "seq">) {
    const parsed = eventSchema.safeParse({
      seq: state.seq + 1, at: input.at, kind: input.kind, accountId: input.accountId,
      window: input.window, from: input.from, to: input.to, paneId: input.paneId, label: input.label,
    });
    if (!id.safeParse(base).success || !parsed.success) return;
    const next = parsed.data;
    if (!Object.hasOwn(state.events, base)) state.events[base] = [];
    const list = state.events[base];
    state.seq = next.seq;
    list.push(next);
    eventsChanged.set(next.seq, ++counter);
    while (list.length > 64) eventsChanged.delete(list.shift()!.seq);
    bytes = byteLength(state);
    changed();
    return { ...next };
  }

  function snapshot() { return { ...structuredClone(state), counter }; }

  function since(previous?: number) {
    if (previous === undefined || !Number.isSafeInteger(previous) || previous < 0 || previous > counter) return snapshot();
    const delta = empty();
    delta.seq = state.seq;
    for (const [accountId, account] of Object.entries(state.accounts)) {
      const fine = account.fine.filter(([minute]) => (bucketMap(accountId, "fine").get(minute)?.counter ?? 0) > previous);
      const coarse = account.coarse.filter(([minute]) => (bucketMap(accountId, "coarse").get(minute)?.counter ?? 0) > previous);
      if (fine.length || coarse.length) delta.accounts[accountId] = { generation: account.generation, fine, coarse };
    }
    for (const [base, events] of Object.entries(state.events)) {
      const changed = events.filter((event) => (eventsChanged.get(event.seq) ?? 0) > previous);
      if (changed.length) delta.events[base] = changed;
    }
    return { ...structuredClone(delta), counter };
  }

  if (bytes > CAP) { trim(); dirty = true; queue(); }
  return { record, event, purge, since, snapshot, flush };
}
