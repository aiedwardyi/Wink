import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs, { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { BOARD_DIR, BOARD_USER, boardPostId, createBoard, errorSig, mergeBoardPosts, projectIdOf, type Board, type BoardPost } from "./board.ts";
import { createBoardCalls, type BoardCalls } from "./board-calls.ts";
import { createBoardRoutes } from "./board-routes.ts";
import { createTempDirs } from "./testing/cleanup.ts";
import { CONFLICT_NOTICE_V2 } from "./thread-sync.ts";

const temps = createTempDirs();
afterAll(() => temps.remove());

const home = (pc: string, clock = { at: 1_000 }) => {
  const dir = join(temps.make(join(tmpdir(), "orbit-board-")), BOARD_DIR);
  return { board: createBoard({ dir, pcId: () => pc, now: () => clock.at }), dir, clock };
};

const STUCK = { author_bot_id: "scout", kind: "stuck" as const, title: "Codex is out of credit", body: "Codex is out of credit on Home.", source_ref: "call:t1:engine:Codex is out of credit" };

describe("board posts", () => {
  it("writes one file per post, named by the event, so a repeat is the same post", () => {
    const { board, dir, clock } = home("pc-a");
    const first = board.post(STUCK);
    clock.at = 2_000;
    const again = board.post(STUCK);
    expect(again.id).toBe(first.id);
    expect(first.id).toBe(boardPostId(STUCK.source_ref));
    expect(readdirSync(dir)).toEqual([`${first.id}.json`]);
    expect(JSON.parse(readFileSync(join(dir, `${first.id}.json`), "utf8"))).toEqual({
      id: first.id, parent_id: null, author_bot_id: "scout", project_id: "", kind: "stuck", title: STUCK.title, body: STUCK.body,
      error_sig: errorSig(`${STUCK.title}\n${STUCK.body}`), status: "open", fix: "", source_ref: STUCK.source_ref, helped_bot_ids: [],
      created_at: 1_000, updated_at: 2_000, pc_id: "pc-a",
    });
  });

  it("names a post by its stored ref, however long the event ref was", () => {
    const { board } = home("pc-a");
    const long = { ...STUCK, source_ref: `call:t1:0:engine:${"x".repeat(500)}` };
    const post = board.post(long);
    expect(post.source_ref).toHaveLength(300);
    expect(boardPostId(post.source_ref)).toBe(post.id);
    expect(board.post(long).id).toBe(post.id);
  });

  it("a fix post solves its parent with one change broadcast", () => {
    let changes = 0;
    const board = createBoard({ dir: join(temps.make(join(tmpdir(), "orbit-board-")), BOARD_DIR), pcId: () => "pc-a", changed: () => changes++ });
    const stuck = board.post(STUCK);
    changes = 0;
    board.post({ author_bot_id: "carbon", kind: "fix", parent_id: stuck.id, title: STUCK.title, body: "Use Claude.", fix: "Use Claude.", source_ref: "tool:tc:m1" });
    expect(changes).toBe(1);
    expect(board.get(stuck.id)).toMatchObject({ status: "solved", fix: "Use Claude." });
  });

  it("signs the same failure the same across folders, numbers and ids", () => {
    expect(errorSig("ENOENT: no such file C:\\Users\\a\\x.json (code 2) id 9f8e7d6c")).toBe(errorSig("enoent: no such file /home/b/y.json (code 17) id 0a1b2c3d"));
    expect(errorSig("Codex is out of credit")).not.toBe(errorSig("Claude is signed out"));
    expect(projectIdOf("D:\\wink\\wt\\Wink\\")).toBe("wink");
  });

  it("finds solved posts by words or signature, same project first", () => {
    const { board } = home("pc-a");
    const other = board.post({ ...STUCK, source_ref: "a", project_id: "site", title: "npm install fails with EACCES", body: "npm install fails with EACCES" });
    const local = board.post({ ...STUCK, source_ref: "b", project_id: "wink", title: "npm install fails with EACCES in wink", body: "npm install fails with EACCES" });
    board.post({ ...STUCK, source_ref: "c", project_id: "wink", title: "Gemini key missing", body: "Gemini key missing" });
    expect(board.search({ query: "EACCES npm install", projectId: "wink" }).map((post) => post.id)).toEqual([local.id, other.id]);
    expect(board.search({ query: "EACCES npm install", solvedOnly: true })).toEqual([]);
    board.solve(other.id, "Run the installer as the signed-in user.");
    expect(board.search({ query: "unrelated words", errorSig: other.error_sig, solvedOnly: true }).map((post) => post.id)).toEqual([other.id]);
    expect(board.search({ query: "npm fails somewhere else entirely", solvedOnly: true, minShare: 0.6 })).toEqual([]);
  });

  it("merges two copies: newer edit leads, solved stays solved, helped bots add up", () => {
    const base = { id: "p" + "0".repeat(24), parent_id: null, author_bot_id: "a", project_id: "", kind: "stuck", title: "t", body: "b", error_sig: "", status: "open", fix: "", source_ref: "s", helped_bot_ids: ["b1"], created_at: 5, updated_at: 10, pc_id: "pc-a" } satisfies BoardPost;
    const solved = { ...base, status: "solved" as const, fix: "do x", helped_bot_ids: [], updated_at: 20, pc_id: "pc-b" };
    const later = { ...base, title: "t2", helped_bot_ids: ["b2"], updated_at: 30 };
    expect(mergeBoardPosts(mergeBoardPosts(base, solved), later)).toMatchObject({ title: "t2", status: "solved", fix: "do x", helped_bot_ids: ["b1", "b2"], created_at: 5 });
  });
});

describe("board word sets", () => {
  const fixes = (board: ReturnType<typeof home>["board"], count: number) => {
    for (let i = 0; i < count; i++) board.post({ author_bot_id: "b", kind: "fix", title: `fix ${i} sprocket lathe`, body: `body ${i} inventory bench`, fix: `shelf ${i}`, source_ref: `ref:${i}` });
  };

  it("builds each post's words once, not on every search", () => {
    const { board } = home("pc-a");
    fixes(board, 20);
    const words = vi.spyOn(String.prototype, "normalize");
    try {
      board.search({ query: "sprocket lathe inventory bench" });
      const first = words.mock.calls.length;
      board.search({ query: "sprocket lathe inventory bench" });
      board.search({ query: "something else entirely here" });
      expect(words.mock.calls.length - first).toBe(2);
      expect(first).toBeLessThanOrEqual(21);
    } finally {
      words.mockRestore();
    }
  });

  it("an edited post matches its new words, not its old ones", () => {
    const { board } = home("pc-a");
    const ref = "ref:edit";
    board.post({ author_bot_id: "b", kind: "fix", title: "gearbox shim", body: "gearbox shim sizing", fix: "use the thin shim", source_ref: ref });
    expect(board.search({ query: "gearbox shim sizing", minShare: 1 })).toHaveLength(1);
    board.post({ author_bot_id: "b", kind: "fix", title: "bearing press", body: "bearing press tonnage", fix: "use the small press", source_ref: ref });
    expect(board.search({ query: "gearbox shim sizing", minShare: 1 })).toHaveLength(0);
    expect(board.search({ query: "bearing press tonnage", minShare: 1 })).toHaveLength(1);
  });

  it("a solved post matches the words of its fix", () => {
    const { board } = home("pc-a");
    const stuck = board.post({ ...STUCK, source_ref: "ref:solve" });
    expect(board.search({ query: "rotate credential", minShare: 1 })).toHaveLength(0);
    board.solve(stuck.id, "rotate credential");
    expect(board.search({ query: "rotate credential", minShare: 1 })).toHaveLength(1);
  });

  it("a removed post stops matching and a repost under its ref uses the new words", () => {
    const { board } = home("pc-a");
    const post = board.post({ author_bot_id: "b", kind: "fix", title: "kiln schedule", body: "kiln schedule slots", fix: "book early", source_ref: "ref:gone" });
    board.remove(post.id);
    expect(board.search({ query: "kiln schedule slots", minShare: 1 })).toHaveLength(0);
  });
});

describe("board Drive sync", () => {
  it("two PCs posting at once end with one copy of each post and no conflict copies", () => {
    const folder = temps.make(join(tmpdir(), "orbit-board-drive-"));
    const a = home("pc-a");
    const b = home("pc-b");
    // the same bot is "scout" on A and "s-b" on B; both carry sync id "g-scout"
    const idsA = { out: (id: string) => (id === "scout" ? "g-scout" : id), in: (id: string) => (id === "g-scout" ? "scout" : id) };
    const idsB = { out: (id: string) => (id === "s-b" ? "g-scout" : id), in: (id: string) => (id === "g-scout" ? "s-b" : id) };

    const sameA = a.board.post(STUCK);
    a.board.post({ ...STUCK, source_ref: "only-a", title: "A only" });
    b.clock.at = 1_500;
    const sameB = b.board.post({ ...STUCK, author_bot_id: "s-b" });
    b.board.post({ ...STUCK, author_bot_id: "s-b", source_ref: "only-b", title: "B only" });
    b.board.helped([sameB.id], "s-b");
    expect(sameB.id).toBe(sameA.id);

    a.board.sync(folder, idsA);
    const published = (pc: string) => Object.fromEntries(readdirSync(join(folder, BOARD_DIR, pc)).map((name) => [name, readFileSync(join(folder, BOARD_DIR, pc, name), "utf8")]));
    const aFiles = published("pc-a");
    b.board.sync(folder, idsB);
    a.board.sync(folder, idsA);
    b.board.sync(folder, idsB);

    for (const side of [a.board, b.board]) {
      const ids = side.list().map((post) => post.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(3);
    }
    expect(a.board.get(sameA.id)!.helped_bot_ids).toEqual(["scout"]);
    expect(b.board.get(sameA.id)!.helped_bot_ids).toEqual(["s-b"]);
    expect(a.board.list().find((post) => post.title === "B only")!.author_bot_id).toBe("scout");
    // each PC writes only its own folder, so Drive never sees one file from two PCs
    expect(readdirSync(join(folder, BOARD_DIR)).sort()).toEqual(["pc-a", "pc-b"]);
    expect(Object.keys(published("pc-a")).every((name) => /^p[0-9a-f]{24}\.json$/.test(name))).toBe(true);
    expect(Object.keys(published("pc-b")).every((name) => /^p[0-9a-f]{24}\.json$/.test(name))).toBe(true);
    for (const [name, text] of Object.entries(aFiles)) if (!text.includes(sameA.id)) expect(published("pc-a")[name]).toBe(text);
    expect(JSON.stringify(published("pc-a")) + JSON.stringify(published("pc-b"))).not.toContain(CONFLICT_NOTICE_V2);
    // a settled pass writes nothing
    expect(a.board.sync(folder, idsA)).toEqual({ pulled: 0, pushed: 0 });
    expect(b.board.sync(folder, idsB)).toEqual({ pulled: 0, pushed: 0 });
  });

  it("skips a copy Drive mangled instead of taking it", () => {
    const folder = temps.make(join(tmpdir(), "orbit-board-drive-"));
    const a = home("pc-a");
    const b = home("pc-b");
    const ids = { out: (id: string) => id, in: (id: string) => id };
    const post = a.board.post(STUCK);
    a.board.sync(folder, ids);
    writeFileSync(join(folder, BOARD_DIR, "pc-a", `${post.id} (1).json`), "{");
    writeFileSync(join(folder, BOARD_DIR, "pc-a", `${post.id}.json`), "{\"id\":");
    expect(b.board.sync(folder, ids).pulled).toBe(0);
    expect(b.board.list()).toEqual([]);
  });

  it("a deleted post leaves every PC and no sync brings it back", () => {
    const folder = temps.make(join(tmpdir(), "orbit-board-drive-"));
    const a = home("pc-a");
    const b = home("pc-b");
    const ids = { out: (id: string) => id, in: (id: string) => id };
    const stuck = a.board.post(STUCK);
    const reply = a.board.post({ author_bot_id: BOARD_USER, parent_id: stuck.id, kind: "tip", title: STUCK.title, body: "Thanks.", source_ref: "reply:r1" });
    a.board.sync(folder, ids);
    b.board.sync(folder, ids);
    expect(b.board.get(reply.id)).toBeDefined();
    expect(a.board.remove(reply.id)).toBe(true);
    for (let pass = 0; pass < 2; pass++) {
      a.board.sync(folder, ids);
      b.board.sync(folder, ids);
    }
    for (const side of [a, b]) expect(side.board.list().map((post) => post.id)).toEqual([stuck.id]);
    expect(createBoard({ dir: a.board.dir, pcId: () => "pc-a" }).get(reply.id)).toBeUndefined();
    expect(readdirSync(join(folder, BOARD_DIR, "pc-b"))).not.toContain(`${reply.id}.json`);
  });

  it("a deleted top-level post takes every reply under it, on every PC, and no stale copy brings it back", () => {
    const folder = temps.make(join(tmpdir(), "orbit-board-drive-"));
    const a = home("pc-a");
    const b = home("pc-b");
    const ids = { out: (id: string) => id, in: (id: string) => id };
    const keep = a.board.post({ ...STUCK, source_ref: "call:t2:engine:other" });
    const stuck = a.board.post(STUCK);
    const reply = a.board.post({ author_bot_id: BOARD_USER, parent_id: stuck.id, kind: "tip", title: STUCK.title, body: "Thanks.", source_ref: "reply:r1" });
    const deep = a.board.post({ author_bot_id: "carbon", parent_id: reply.id, kind: "tip", title: STUCK.title, body: "Welcome.", source_ref: "tool:tc:1" });
    a.board.sync(folder, ids);
    b.board.sync(folder, ids);
    expect(b.board.get(deep.id)).toBeDefined();
    expect(a.board.remove(stuck.id)).toBe(true);
    expect(a.board.list().map((post) => post.id)).toEqual([keep.id]);
    for (let pass = 0; pass < 2; pass++) {
      a.board.sync(folder, ids);
      b.board.sync(folder, ids);
    }
    for (const side of [a, b]) expect(side.board.list().map((post) => post.id)).toEqual([keep.id]);
    expect(createBoard({ dir: a.board.dir, pcId: () => "pc-a" }).list().map((post) => post.id)).toEqual([keep.id]);
  });

  it("a reply written before its post's delete arrives is dropped on every PC, never a standalone post", () => {
    const folder = temps.make(join(tmpdir(), "orbit-board-drive-"));
    const a = home("pc-a");
    const b = home("pc-b");
    const c = home("pc-c");
    const ids = { out: (id: string) => id, in: (id: string) => id };
    const stuck = a.board.post(STUCK);
    a.board.sync(folder, ids);
    b.board.sync(folder, ids);
    c.board.sync(folder, ids);
    const late = b.board.post({ author_bot_id: "carbon", parent_id: stuck.id, kind: "tip", title: STUCK.title, body: "Late.", source_ref: "tool:tc:late" });
    const deeper = b.board.post({ author_bot_id: "scout", parent_id: late.id, kind: "tip", title: STUCK.title, body: "Later.", source_ref: "tool:tc:later" });
    b.board.sync(folder, ids);
    a.board.remove(stuck.id);
    for (let pass = 0; pass < 2; pass++) for (const side of [a, c, b]) side.board.sync(folder, ids);
    for (const side of [a, b, c]) expect(side.board.list()).toEqual([]);
    for (const side of [a, b, c]) expect(createBoard({ dir: side.board.dir, pcId: () => "x" }).get(deeper.id)).toBeUndefined();
    expect(readdirSync(join(folder, BOARD_DIR, "pc-b"))).not.toContain(`${late.id}.json`);
  });

  it("a PC that wrote a reply offline drops it when it hears its post was deleted", () => {
    const folder = temps.make(join(tmpdir(), "orbit-board-drive-"));
    const a = home("pc-a");
    const b = home("pc-b");
    const ids = { out: (id: string) => id, in: (id: string) => id };
    const keep = a.board.post({ ...STUCK, source_ref: "call:t2:engine:other" });
    const stuck = a.board.post(STUCK);
    a.board.sync(folder, ids);
    b.board.sync(folder, ids);
    const late = b.board.post({ author_bot_id: "carbon", parent_id: stuck.id, kind: "tip", title: STUCK.title, body: "Late.", source_ref: "tool:tc:late" });
    b.board.post({ author_bot_id: "scout", parent_id: late.id, kind: "tip", title: STUCK.title, body: "Later.", source_ref: "tool:tc:later" });
    a.board.remove(stuck.id);
    for (let pass = 0; pass < 2; pass++) for (const side of [a, b]) side.board.sync(folder, ids);
    for (const side of [a, b]) expect(side.board.list().map((post) => post.id)).toEqual([keep.id]);
  });


  it("resumes dropping an offline reply and its child after the root tombstone is renamed into place", () => {
    const folder = temps.make(join(tmpdir(), "orbit-board-drive-"));
    const a = home("pc-a");
    const b = home("pc-b");
    const c = home("pc-c");
    const ids = { out: (id: string) => id, in: (id: string) => id };
    const stuck = a.board.post(STUCK);
    a.board.sync(folder, ids);
    b.board.sync(folder, ids);
    a.board.remove(stuck.id);
    a.board.sync(folder, ids);
    const late = b.board.post({ author_bot_id: "carbon", parent_id: stuck.id, kind: "tip", title: STUCK.title, body: "Late.", source_ref: "tool:tc:late" });
    b.board.post({ author_bot_id: "scout", parent_id: late.id, kind: "tip", title: STUCK.title, body: "Later.", source_ref: "tool:tc:later" });

    const tombstones = join(b.dir, "deleted.json");
    const rename = fs.renameSync;
    const interrupt = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (to === tombstones) throw new Error("restart after durable root tombstone");
    });
    syncBuiltinESMExports();
    try {
      expect(() => b.board.sync(folder, ids)).toThrow("restart after durable root tombstone");
    } finally {
      interrupt.mockRestore();
      syncBuiltinESMExports();
    }
    expect(JSON.parse(readFileSync(tombstones, "utf8"))).toEqual([stuck.id, { id: stuck.id, parent_id: null }]);
    const restarted = createBoard({ dir: b.dir, pcId: () => "pc-b" });
    for (let pass = 0; pass < 4; pass++) for (const board of [restarted, a.board, c.board]) board.sync(folder, ids);
    for (const board of [restarted, a.board, c.board]) expect(board.list()).toEqual([]);
  });

  it("drops an already stored grandchild when its missing ancestor arrives under a tombstoned post", () => {
    const folder = temps.make(join(tmpdir(), "orbit-board-drive-"));
    const partial = temps.make(join(tmpdir(), "orbit-board-drive-"));
    const a = home("pc-a");
    const b = home("pc-b");
    const c = home("pc-c");
    const ids = { out: (id: string) => id, in: (id: string) => id };
    const stuck = a.board.post(STUCK);
    a.board.sync(folder, ids);
    b.board.sync(folder, ids);
    const late = b.board.post({ author_bot_id: "carbon", parent_id: stuck.id, kind: "tip", title: STUCK.title, body: "Late.", source_ref: "tool:tc:late" });
    const deeper = b.board.post({ author_bot_id: "scout", parent_id: late.id, kind: "tip", title: STUCK.title, body: "Later.", source_ref: "tool:tc:later" });
    b.board.sync(folder, ids);
    a.board.remove(stuck.id);
    a.board.sync(partial, ids);

    const deliver = (pc: string, name: string) => {
      const dir = join(partial, BOARD_DIR, pc);
      mkdirSync(dir, { recursive: true });
      copyFileSync(join(folder, BOARD_DIR, pc, name), join(dir, name));
    };
    deliver("pc-b", `${deeper.id}.json`);
    c.board.sync(partial, ids);
    expect(c.board.get(deeper.id)?.parent_id).toBe(late.id);
    deliver("pc-b", `${late.id}.json`);
    deliver("pc-b", `${stuck.id}.json`);
    c.board.sync(partial, ids);
    expect(c.board.list()).toEqual([]);
  });

});

describe("a delete a restart cuts short", () => {
  const ids = { out: (id: string) => id, in: (id: string) => id };
  const listed = (board: Board) => board.list().map((post) => [post.id, post.parent_id]);
  const restart = (dir: string, pc = "pc-a") => createBoard({ dir, pcId: () => pc });
  // runs on a fresh copy once per rename or remove it makes, the process dying just before or just after that one
  const everyCut = <T>(build: () => T, run: (world: T) => void, check: (world: T, at: string) => void): number => {
    const rename = fs.renameSync;
    const remove = fs.rmSync;
    for (let step = 0, cuts = 0; ; step++) {
      for (const after of [false, true]) {
        const world = build();
        let seen = 0;
        const at = (real: () => void) => {
          const now = seen++;
          if (now === step && !after) throw new Error("restart");
          real();
          if (now === step) throw new Error("restart");
        };
        const spies = [
          vi.spyOn(fs, "renameSync").mockImplementation((from, to) => at(() => rename(from, to))),
          vi.spyOn(fs, "rmSync").mockImplementation((path, options) => at(() => remove(path, options))),
        ];
        syncBuiltinESMExports();
        try {
          run(world);
          return cuts;
        } catch (error) {
          if (!(error instanceof Error && error.message === "restart")) throw error;
        } finally {
          for (const spy of spies) spy.mockRestore();
          syncBuiltinESMExports();
        }
        check(world, `${after ? "after" : "before"} write ${step}`);
        cuts++;
      }
    }
  };

  it("a thread delete without Drive comes back whole or not at all: once its tombstone is on disk the restart finishes it", () => {
    const thread = () => {
      const pc = home("pc-a");
      const stuck = pc.board.post(STUCK);
      const answer = pc.board.post({ author_bot_id: "carbon", parent_id: stuck.id, kind: "tip", title: STUCK.title, body: "Top it up.", source_ref: "tool:tc:1" });
      pc.board.post({ author_bot_id: BOARD_USER, parent_id: answer.id, kind: "tip", title: STUCK.title, body: "Thanks.", source_ref: "reply:r1" });
      pc.board.post({ ...STUCK, title: "Pin node 22", body: "Pin node 22.", source_ref: "tool:tc:pin" });
      return { ...pc, stuck };
    };
    const kept = listed(thread().board);
    const done = thread();
    done.board.remove(done.stuck.id);
    const deleted = listed(restart(done.dir));
    const cuts = everyCut(thread, (t) => t.board.remove(t.stuck.id), (t, at) => {
      expect(listed(restart(t.dir)), at).toEqual(fs.existsSync(join(t.dir, "deleted.json")) ? deleted : kept);
    });
    expect(cuts).toBeGreaterThan(2);
  });

  it("a sync cut while it takes another PC's thread delete boots without Drive to that delete whole or not at all", () => {
    const pair = () => {
      const folder = temps.make(join(tmpdir(), "orbit-board-drive-"));
      const a = home("pc-a");
      const b = home("pc-b");
      const stuck = a.board.post(STUCK);
      const reply = a.board.post({ author_bot_id: BOARD_USER, parent_id: stuck.id, kind: "tip", title: STUCK.title, body: "Thanks.", source_ref: "reply:r1" });
      a.board.post({ author_bot_id: "carbon", parent_id: reply.id, kind: "tip", title: STUCK.title, body: "Welcome.", source_ref: "tool:tc:1" });
      const other = a.board.post({ ...STUCK, title: "Pin node 22", body: "Pin node 22.", source_ref: "tool:tc:pin" });
      for (const board of [a.board, b.board, a.board, b.board]) board.sync(folder, ids);
      // B answers offline while A deletes the thread
      b.board.post({ author_bot_id: "carbon", parent_id: reply.id, kind: "tip", title: STUCK.title, body: "Welcome again.", source_ref: "tool:tc:2" });
      a.board.remove(stuck.id);
      a.board.sync(folder, ids);
      return { folder, a, b, other };
    };
    const settled = (p: ReturnType<typeof pair>) => {
      const b = restart(p.b.dir, "pc-b");
      for (const board of [b, p.a.board, b, p.a.board]) board.sync(p.folder, ids);
      return [listed(p.a.board), listed(b)];
    };
    const kept = listed(restart(pair().b.dir, "pc-b"));
    expect(kept).toHaveLength(5);
    const whole = pair();
    whole.b.board.sync(whole.folder, ids);
    const deleted = listed(restart(whole.b.dir, "pc-b"));
    expect(deleted).toEqual([[whole.other.id, null]]);
    expect(settled(whole)).toEqual([deleted, deleted]);
    const cuts = everyCut(pair, (p) => p.b.board.sync(p.folder, ids), (p, at) => {
      const boot = listed(restart(p.b.dir, "pc-b"));
      expect([kept, deleted], at).toContainEqual(boot);
      expect(listed(restart(p.b.dir, "pc-b")), at).toEqual(boot);
      expect(settled(p), at).toEqual([deleted, deleted]);
    });
    expect(cuts).toBeGreaterThan(2);
  });
});

describe("a post written after its twin was deleted", () => {
  const ids = { out: (id: string) => id, in: (id: string) => id };
  const BLOCKER = { kind: "engine" as const, note: "pnpm install fails with EPERM on node_modules" };

  it.each(["Drive sync", "no sync"])("a repeat call lists as a new post on every PC with its fix saved (%s)", (mode) => {
    const folder = temps.make(join(tmpdir(), "orbit-board-drive-"));
    const a = home("pc-a");
    const b = home("pc-b");
    const sync = () => {
      if (mode === "Drive sync") for (const side of [a, b, a, b]) side.board.sync(folder, ids);
    };
    const calls = createBoardCalls({ board: a.board, projectOf: () => "wink", room: () => false });
    const first = calls.called("bot-1", "t1", BLOCKER)!;
    sync();
    a.board.remove(first.id);
    sync();
    const again = calls.called("bot-1", "t1", BLOCKER)!;
    expect(again.id).not.toBe(first.id);
    sync();
    expect(a.board.list().map((post) => post.id)).toEqual([again.id]);
    if (mode === "Drive sync") expect(b.board.list().map((post) => post.id)).toEqual([again.id]);
    expect(calls.cleared("t1", [BLOCKER], [], "ran the terminal as admin once")).toHaveLength(1);
    sync();
    for (const side of mode === "Drive sync" ? [a, b] : [a]) expect(side.board.get(again.id)).toMatchObject({ status: "solved", fix: "ran the terminal as admin once" });
    for (const side of [a, b]) expect(side.board.get(first.id)).toBeUndefined();
  });

  it("a repeat call while the post is live still joins it", () => {
    const { board } = home("pc-a");
    const calls = createBoardCalls({ board, projectOf: () => "wink", room: () => false });
    const first = calls.called("bot-1", "t1", BLOCKER)!;
    board.remove(first.id);
    const second = calls.called("bot-1", "t1", BLOCKER)!;
    expect(calls.called("bot-1", "t1", BLOCKER)!.id).toBe(second.id);
    expect(board.list()).toHaveLength(1);
  });

  it("the same event after its post was deleted writes nothing, here or on another PC", () => {
    const folder = temps.make(join(tmpdir(), "orbit-board-drive-"));
    const a = home("pc-a");
    const b = home("pc-b");
    const first = a.board.post(STUCK);
    a.board.remove(first.id);
    expect(a.board.post(STUCK).id).toBe(first.id);
    for (const side of [a, b, a, b]) side.board.sync(folder, ids);
    for (const side of [a, b]) expect(side.board.list()).toEqual([]);
    expect(createBoard({ dir: a.board.dir, pcId: () => "pc-a" }).list()).toEqual([]);
  });
});

describe("every delete case: nothing deleted that should live, nothing live that was deleted", () => {
  const ids = { out: (id: string) => id, in: (id: string) => id };
  const ISSUE = { kind: "engine" as const, note: "pnpm install fails with EPERM on node_modules" };
  type Pc = { name: string; dir: string; board: Board; calls: BoardCalls; routes: ReturnType<typeof createBoardRoutes> };
  const world = (drive: boolean) => {
    const folder = temps.make(join(tmpdir(), "orbit-board-drive-"));
    const pcs: Pc[] = [];
    let tick = 1_000;
    const skews = new Map<string, number>();
    const open = (name: string, dir: string): Pc => {
      const board = createBoard({ dir, pcId: () => name, now: () => ++tick + (skews.get(name) ?? 0) });
      const routes = createBoardRoutes({ board, caller: () => ({ botId: "carbon", threadId: "tc" }), known: () => true, projectOf: () => "wink", roomTurn: () => null });
      return { name, dir, board, calls: createBoardCalls({ board, projectOf: () => "wink", room: () => false }), routes };
    };
    return {
      drive,
      folder,
      pcs,
      boot: (name: string, skew = 0) => {
        skews.set(name, skew);
        const pc = open(name, join(temps.make(join(tmpdir(), "orbit-board-")), BOARD_DIR));
        pcs.push(pc);
        return pc;
      },
      restart: (pc: Pc) => {
        const fresh = open(pc.name, pc.dir);
        pcs[pcs.indexOf(pc)] = fresh;
        return fresh;
      },
      sync: (...order: Pc[]) => {
        if (drive) for (const pc of order) pc.board.sync(folder, ids);
      },
    };
  };
  type World = ReturnType<typeof world>;
  type Outcome = { live: Partial<BoardPost>[]; dead: string[]; on?: Pc[] };
  const tip = (pc: Pc, title: string, parent?: BoardPost, author = "carbon") =>
    pc.board.post({ author_bot_id: author, kind: "tip", title, body: title, parent_id: parent?.id ?? null, source_ref: `${author === BOARD_USER ? "reply:" : "tool:tc:"}${title}` });
  const call = (pc: Pc) => pc.calls.called("bot-1", "t1", ISSUE)!;
  const clear = (pc: Pc, note: string) => pc.calls.cleared("t1", [ISSUE], [], note).map((post) => post.id);
  // a call as builds before the digest ref wrote it, the whole note in its ref
  const oldCall = (pc: Pc, episode: number) =>
    pc.board.post({ author_bot_id: "bot-1", project_id: "wink", kind: "stuck", title: ISSUE.note, body: ISSUE.note, source_ref: `call:t1:${episode}:${ISSUE.kind}:${ISSUE.note}` });
  // what the original release keeps: bare ids, no parents
  const oldTombstones = (dir: string, ...gone: string[]) => writeFileSync(join(dir, "deleted.json"), JSON.stringify(gone));
  const send = async (route: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>, body: unknown) => {
    let status = 0;
    let reply = "";
    // SAFETY: the routes call only writeHead, end and the request's headers and data events.
    const res = { writeHead(code: number) { status = code; }, end(text: string) { reply = text; } } as unknown as ServerResponse;
    // SAFETY: as above.
    const req = new EventEmitter() as IncomingMessage;
    req.headers = { authorization: "Bearer tok" };
    const pending = route(req, res);
    req.emit("data", JSON.stringify(body));
    req.emit("end");
    await pending;
    return { status, body: JSON.parse(reply || "{}") };
  };
  const both = ["Drive", "no Drive"] as const;
  const cases: Array<[name: string, run: (w: World) => Outcome | Promise<Outcome>, modes?: readonly ("Drive" | "no Drive")[]]> = [
    ["A: a deleted post takes every reply under it", (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const keep = tip(a, "keep");
      const stuck = tip(a, "stuck");
      const reply = tip(a, "reply", stuck, BOARD_USER);
      const deep = tip(a, "deep", reply);
      w.sync(a, b);
      a.board.remove(stuck.id);
      w.sync(a, b, a, b);
      return { live: [{ id: keep.id }], dead: [stuck.id, reply.id, deep.id] };
    }, both],
    ["B: replies written offline under a deleted post drop, nested ones too", (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const keep = tip(a, "keep");
      const stuck = tip(a, "stuck");
      w.sync(a, b);
      const late = tip(b, "late", stuck);
      const later = tip(b, "later", late);
      a.board.remove(stuck.id);
      w.sync(a, b, a, b);
      return { live: [{ id: keep.id }], dead: [stuck.id, late.id, later.id] };
    }],
    ["B: two PCs deleting two posts at once keep the third and its reply", (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const c = w.boot("pc-c");
      const left = tip(a, "left");
      const right = tip(a, "right");
      const keep = tip(a, "keep");
      const leftChild = tip(a, "left child", left);
      const rightChild = tip(a, "right child", right);
      const keepChild = tip(a, "keep child", keep);
      w.sync(a, b, c);
      a.board.remove(left.id);
      b.board.remove(right.id);
      w.sync(b, a, c, b, a);
      return { live: [{ id: keep.id }, { id: keepChild.id }], dead: [left.id, leftChild.id, right.id, rightChild.id] };
    }],
    ["B: a reply that arrives before its live parent is kept", (w) => {
      const b = w.boot("pc-b");
      const c = w.boot("pc-c");
      const p = tip(b, "live");
      const q = tip(b, "reply", p);
      w.sync(b);
      const file = join(w.folder, BOARD_DIR, "pc-b", `${p.id}.json`);
      const held = join(w.folder, "held.json");
      fs.renameSync(file, held);
      w.sync(c);
      fs.renameSync(held, file);
      w.sync(c, b, c);
      return { live: [{ id: p.id }, { id: q.id, parent_id: p.id }], dead: [] };
    }],
    ["B: a PC restarted halfway through a delete finishes it", (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const c = w.boot("pc-c");
      const stuck = tip(a, "stuck");
      w.sync(a, b);
      a.board.remove(stuck.id);
      w.sync(a);
      const late = tip(b, "late", stuck);
      const later = tip(b, "later", late);
      const tombstones = join(b.dir, "deleted.json");
      const rename = fs.renameSync;
      const interrupt = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        rename(from, to);
        if (to === tombstones) throw new Error("restart after durable root tombstone");
      });
      syncBuiltinESMExports();
      try {
        expect(() => b.board.sync(w.folder, ids)).toThrow("restart after durable root tombstone");
      } finally {
        interrupt.mockRestore();
        syncBuiltinESMExports();
      }
      const restarted = w.restart(b);
      w.sync(restarted, a, c, restarted, a, c);
      return { live: [], dead: [stuck.id, late.id, later.id] };
    }],
    ["B: a grandchild that arrives first drops once its ancestors arrive", (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const c = w.boot("pc-c");
      const partial = temps.make(join(tmpdir(), "orbit-board-drive-"));
      const stuck = tip(a, "stuck");
      w.sync(a, b);
      const late = tip(b, "late", stuck);
      const deeper = tip(b, "deeper", late);
      w.sync(b);
      a.board.remove(stuck.id);
      a.board.sync(partial, ids);
      const deliver = (name: string) => {
        const dir = join(partial, BOARD_DIR, "pc-b");
        mkdirSync(dir, { recursive: true });
        copyFileSync(join(w.folder, BOARD_DIR, "pc-b", name), join(dir, name));
      };
      deliver(`${deeper.id}.json`);
      c.board.sync(partial, ids);
      deliver(`${late.id}.json`);
      deliver(`${stuck.id}.json`);
      c.board.sync(partial, ids);
      return { live: [], dead: [stuck.id, late.id, deeper.id], on: [c] };
    }],
    ["B: helped marks survive a delete next to them", (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const live = tip(a, "live");
      const dead = tip(a, "dead");
      a.board.helped([live.id], "scout");
      w.sync(a, b);
      a.board.remove(dead.id);
      const good = tip(b, "good", live);
      w.sync(a, b, a, b);
      return { live: [{ id: live.id, helped_bot_ids: ["scout"] }, { id: good.id }], dead: [dead.id] };
    }],
    ["C: a repeat call after its post was deleted is a new post that keeps its fix", (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const first = call(a);
      w.sync(a, b);
      a.board.remove(first.id);
      w.sync(a, b, a, b);
      const again = call(a);
      expect(again.id).not.toBe(first.id);
      w.sync(a, b, a, b);
      expect(clear(w.drive ? b : a, "ran the terminal as admin once")).toEqual([again.id]);
      w.sync(a, b, a, b);
      return { live: [{ id: again.id, status: "solved", fix: "ran the terminal as admin once" }], dead: [first.id] };
    }, both],
    ["C: a bot posting the same words after a delete gets a new post", async (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const words = { kind: "tip", title: "Use pnpm 10", body: "Use pnpm 10." };
      const first = await send(a.routes.post, words);
      w.sync(a, b);
      expect((await send(a.routes.remove, { id: first.body.id })).status).toBe(200);
      w.sync(a, b, a, b);
      const again = await send(a.routes.post, words);
      expect(again.body.id).not.toBe(first.body.id);
      expect((await send(a.routes.post, words)).body.id).toBe(again.body.id);
      w.sync(a, b, a, b);
      return { live: [{ id: again.body.id, title: "Use pnpm 10" }], dead: [first.body.id] };
    }, both],
    ["D: a retried reply with the same client id stays deleted with its thread", async (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const other = tip(a, "other");
      const root = tip(a, "live parent");
      const reply = { parent_id: root.id, body: "Original reply", client_id: "saved-reply-1111" };
      const first = await send(a.routes.reply, reply);
      w.sync(a, b);
      expect((await send(a.routes.remove, { id: first.body.post.id })).status).toBe(403);
      expect((await send(a.routes.remove, { id: root.id })).status).toBe(200);
      w.sync(a, b, a, b);
      expect((await send(a.routes.reply, reply)).status).toBe(404);
      w.sync(a, b, a, b);
      return { live: [{ id: other.id }], dead: [root.id, first.body.post.id] };
    }, both],
    ["D: deleting an earlier solved call leaves one live call, and it takes the fix", (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const solved = call(a);
      expect(clear(a, "first fix")).toEqual([solved.id]);
      const open = call(a);
      w.sync(a, b, a, b);
      a.board.remove(solved.id);
      w.sync(a, b, a, b);
      const writers = w.drive ? [a, b] : [a];
      for (const pc of writers) expect(call(pc).id).toBe(open.id);
      w.sync(a, b, a, b);
      expect(clear(writers.at(-1)!, "second fix")).toEqual([open.id]);
      w.sync(a, b, a, b);
      return { live: [{ id: open.id, status: "solved", fix: "second fix" }], dead: [solved.id] };
    }, both],
    ["D: a call that reuses an episode before hearing of its delete goes with the episode", (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const first = call(a);
      w.sync(a, b);
      a.board.remove(first.id);
      w.sync(a, b, a, b);
      const older = call(b);
      b.board.remove(older.id);
      w.sync(b);
      const newer = call(a);
      expect(newer.id).toBe(older.id);
      expect(clear(a, "new fix after the older copy was deleted")).toEqual([newer.id]);
      w.sync(a, b, a, b);
      return { live: [], dead: [first.id, older.id] };
    }],
    ["D: a late old-format call whose note ends in #2 keeps its own identity", (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const legacy = (pc: Pc, note: string) => pc.board.post({ author_bot_id: "bot-1", project_id: "wink", kind: "stuck", title: note, body: note, source_ref: `call:t1:0:engine:${note}` });
      const original = legacy(a, ISSUE.note);
      const unrelated = legacy(b, `${ISSUE.note}#2`);
      a.board.remove(original.id);
      const replacement = call(a);
      w.sync(b, a, b, a);
      expect(clear(a, "fix for the call without the suffix")).toEqual([replacement.id]);
      w.sync(a, b, a, b);
      return { live: [{ id: replacement.id, fix: "fix for the call without the suffix" }, { id: unrelated.id, status: "open", fix: "" }], dead: [original.id] };
    }],
    ["D: an answer under a reply the original release deleted stays", (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const p = tip(a, "live");
      const other = tip(a, "other");
      const reply = tip(a, "user reply", p, BOARD_USER);
      const answer = tip(a, "answer", reply);
      // the original release left the reply's file gone, a bare id, and the answer still under it
      fs.rmSync(join(a.dir, `${reply.id}.json`));
      oldTombstones(a.dir, reply.id);
      const updated = w.restart(a);
      updated.board.remove(other.id);
      w.sync(updated, b, updated, b);
      return { live: [{ id: p.id }, { id: answer.id, parent_id: reply.id }], dead: [reply.id, other.id] };
    }, both],
    ["D: an answer that raced a reply delete on the original release stays after the update", (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const p = tip(a, "live");
      const reply = tip(a, "user reply", p, BOARD_USER);
      w.sync(a, b);
      const answer = tip(b, "answer", reply);
      // the original release deleted the reply alone: its file gone and a bare id
      fs.rmSync(join(a.dir, `${reply.id}.json`));
      oldTombstones(a.dir, reply.id);
      const updatedA = w.restart(a);
      w.sync(updatedA, b, updatedA, b);
      const updatedB = w.restart(b);
      w.sync(updatedA, updatedB, updatedA, updatedB);
      return { live: [{ id: p.id }, { id: answer.id, parent_id: reply.id }], dead: [reply.id] };
    }],
    ["D: a fresh PC that hears of a reply delete only from the original release keeps the answer", (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const c = w.boot("pc-c");
      const p = tip(a, "live");
      const reply = tip(a, "user reply", p, BOARD_USER);
      w.sync(a, b);
      const answer = tip(b, "late answer", reply);
      fs.rmSync(join(a.dir, `${reply.id}.json`));
      oldTombstones(a.dir, reply.id);
      const updated = w.restart(a);
      w.sync(updated, b, updated, b);
      const only = temps.make(join(tmpdir(), "orbit-board-drive-"));
      fs.cpSync(join(w.folder, BOARD_DIR, "pc-b"), join(only, BOARD_DIR, "pc-b"), { recursive: true });
      oldTombstones(join(only, BOARD_DIR, "pc-b"), reply.id);
      c.board.sync(only, ids);
      w.sync(c, updated, b, c, updated, b);
      return { live: [{ id: p.id }, { id: answer.id }], dead: [reply.id] };
    }],
    ["D: a thread delete the original release relays as a bare id still takes the thread", (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const keep = tip(a, "keep");
      const stuck = tip(a, "stuck");
      w.sync(a, b);
      const late = tip(b, "late", stuck);
      a.board.remove(stuck.id);
      w.sync(a);
      // B on the original release drops the post it hears of and keeps the answer it wrote
      fs.rmSync(join(b.dir, `${stuck.id}.json`));
      oldTombstones(b.dir, stuck.id);
      const updated = w.restart(b);
      w.sync(updated, a, updated, a);
      return { live: [{ id: keep.id }], dead: [stuck.id, late.id] };
    }],
    ["D: two PCs calling before they sync share one live call, delete after delete", (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const deleted: string[] = [];
      for (let round = 0; round < 3; round++) {
        const live = call(a);
        expect(call(b).id).toBe(live.id);
        expect(deleted).not.toContain(live.id);
        w.sync(a, b, a, b);
        a.board.remove(live.id);
        deleted.push(live.id);
        w.sync(a, b, a, b);
      }
      const last = call(b);
      w.sync(a, b, a, b);
      return { live: [{ id: last.id, status: "open" }], dead: deleted };
    }],
    ["E: deleting an earlier solved old-format call leaves the live call, and it takes the fix", (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const solved = oldCall(a, 0);
      a.board.solve(solved.id, "first fix");
      const open = call(a);
      w.sync(a, b, a, b);
      a.board.remove(solved.id);
      w.sync(a, b, a, b);
      const writers = w.drive ? [a, b] : [a];
      for (const pc of writers) expect(call(pc).id).toBe(open.id);
      w.sync(a, b, a, b);
      expect(clear(writers.at(-1)!, "second fix")).toEqual([open.id]);
      w.sync(a, b, a, b);
      return { live: [{ id: open.id, status: "solved", fix: "second fix" }], dead: [solved.id] };
    }, both],
    ["E: of two old-format calls, deleting the solved one leaves the open one live, and it takes the fix", (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const solved = oldCall(a, 0);
      a.board.solve(solved.id, "first fix");
      const open = oldCall(a, 1);
      w.sync(a, b, a, b);
      expect(call(a).id).toBe(open.id);
      a.board.remove(solved.id);
      w.sync(a, b, a, b);
      const writers = w.drive ? [a, b] : [a];
      for (const pc of writers) expect(call(pc).id).toBe(open.id);
      w.sync(a, b, a, b);
      expect(clear(writers.at(-1)!, "second fix")).toEqual([open.id]);
      w.sync(a, b, a, b);
      return { live: [{ id: open.id, status: "solved", fix: "second fix" }], dead: [solved.id] };
    }, both],
    ["E: a call after its old-format post was deleted is a new post that keeps its fix", (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const first = oldCall(a, 0);
      w.sync(a, b);
      a.board.remove(first.id);
      w.sync(a, b, a, b);
      const again = call(a);
      expect(again.id).not.toBe(first.id);
      w.sync(a, b, a, b);
      expect(clear(w.drive ? b : a, "fix after the delete")).toEqual([again.id]);
      w.sync(a, b, a, b);
      return { live: [{ id: again.id, status: "solved", fix: "fix after the delete" }], dead: [first.id] };
    }, both],
    ["E: deleting an old-format call leaves a current-format post of the same call as the live one", (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const old = oldCall(a, 0);
      const live = call(b);
      w.sync(a, b, a, b);
      a.board.remove(old.id);
      w.sync(a, b, a, b);
      for (const pc of [a, b]) expect(call(pc).id).toBe(live.id);
      w.sync(a, b, a, b);
      expect(clear(a, "fix for the live call")).toEqual([live.id]);
      w.sync(a, b, a, b);
      return { live: [{ id: live.id, status: "solved", fix: "fix for the live call" }], dead: [old.id] };
    }],
    ["E: the fix goes when a PC that missed it writes the same call again and deletes it", (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const first = call(a);
      w.sync(a, b);
      expect(clear(a, "fix saved before the other PC deleted")).toEqual([first.id]);
      expect(call(b).id).toBe(first.id);
      b.board.remove(first.id);
      w.sync(a, b, a, b);
      return { live: [], dead: [first.id] };
    }],
    ...(["bare id", "parent only", "fix digest"] as const).flatMap((format) =>
      (["abc", "acb", "bac", "bca", "cab", "cba"] as const).map((arrival): (typeof cases)[number] => [`H: an unseen fix goes with its thread (${format}, ${arrival})`, (w) => {
        const a = w.boot("pc-a");
        const b = w.boot("pc-b", -500);
        const c = w.boot("pc-c");
        const pcs = new Map([["a", a], ["b", b], ["c", c]]);
        const first = call(a);
        const keep = tip(a, "unrelated post");
        w.sync(a, b, c);
        expect(clear(b, "fix saved on the other PC")).toEqual([first.id]);
        if (arrival[0] !== "a") w.sync(b, c);
        expect(a.board.remove(first.id)).toBe(true);
        w.sync(a);
        const tombstones = join(w.folder, BOARD_DIR, a.name, "deleted.json");
        const root = { id: first.id, parent_id: null };
        writeFileSync(tombstones, JSON.stringify(format === "bare id" ? [first.id] : [
          first.id, format === "fix digest" ? { ...root, fix_sha: "" } : root,
        ]));
        const [online, peer, offline] = [...arrival].map((name) => pcs.get(name)!);
        w.sync(online!, peer!, online!, peer!);
        for (const pc of [online!, peer!]) expect(pc.board.list().map((post) => post.id), pc.name).toEqual([keep.id]);
        w.sync(offline!, online!, peer!, offline!, online!, peer!);
        return { live: [{ id: keep.id }], dead: [first.id] };
      }]),
    ),
    ["H: an older build's copied fix and its replies go with the deleted thread", (w) => {
      const a = w.boot("pc-a");
      let b = w.boot("pc-b");
      const first = call(a);
      w.sync(a, b);
      const fixed = b.board.solve(first.id, "saved fix")!;
      const sha = createHash("sha256").update(fixed.fix).digest("hex").slice(0, 16);
      const copy = { ...fixed, id: boardPostId(JSON.stringify([first.id, sha])) };
      writeFileSync(join(b.dir, `${copy.id}.json`), JSON.stringify(copy));
      b = w.restart(b);
      const reply = tip(b, "reply under the copied fix", copy, BOARD_USER);
      const keep = tip(b, fixed.fix);
      expect(a.board.remove(first.id)).toBe(true);
      w.sync(a, b, a, b);
      return { live: [{ id: keep.id }], dead: [first.id, copy.id, reply.id] };
    }],
    ["H: replacing a live fix writes no tombstones", (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const first = call(a);
      a.board.solve(first.id, "first fix");
      a.board.solve(first.id, "latest fix");
      w.sync(a, b);
      for (const pc of [a, b]) {
        expect(readdirSync(pc.dir)).toEqual([`${first.id}.json`]);
        expect(readdirSync(join(w.folder, BOARD_DIR, pc.name))).toEqual([`${first.id}.json`]);
      }
      return { live: [{ id: first.id, status: "solved", fix: "latest fix" }], dead: [] };
    }],
    ["H: an unseen fix stays gone after a restart as the deleted call's file goes", (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const first = call(a);
      w.sync(a, b);
      a.board.remove(first.id);
      w.sync(a);
      expect(clear(b, "fix that must survive a restart")).toEqual([first.id]);
      const gone = join(b.dir, `${first.id}.json`);
      const { rmSync } = fs;
      const interrupt = vi.spyOn(fs, "rmSync").mockImplementation((path, options) => {
        rmSync(path, options);
        if (path === gone) throw new Error("restart");
      });
      syncBuiltinESMExports();
      try {
        expect(() => b.board.sync(w.folder, ids)).toThrow("restart");
      } finally {
        interrupt.mockRestore();
        syncBuiltinESMExports();
      }
      const restarted = w.restart(b);
      w.sync(restarted, a, restarted, a);
      return { live: [], dead: [first.id] };
    }],
    ["E: one call deleted on two PCs, one of them showing its fix, stays gone", (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const first = call(a);
      w.sync(a, b);
      expect(clear(a, "fix the user saw when deleting")).toEqual([first.id]);
      w.sync(a);
      expect(call(b).id).toBe(first.id);
      b.board.remove(first.id);
      a.board.remove(first.id);
      w.sync(b, a, b, a);
      return { live: [], dead: [first.id] };
    }],
    ["E: a PC holding an older fix brings nothing back once the post is deleted with a newer one", async (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const c = w.boot("pc-c");
      const stuck = await send(a.routes.post, { kind: "stuck", title: "Build fails", body: "Build fails on CI" });
      await send(a.routes.post, { kind: "fix", title: "Fix 1", body: "first fix", parent_id: stuck.body.id });
      w.sync(a, b, c);
      await send(a.routes.post, { kind: "fix", title: "Fix 2", body: "second fix", parent_id: stuck.body.id });
      w.sync(a, b);
      b.board.remove(stuck.body.id);
      w.sync(b, a, c, b, a, c);
      return { live: [], dead: [stuck.body.id] };
    }],
    ["F: an off PC holding an older fix brings nothing back once the post is deleted with a newer one", async (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const c = w.boot("pc-c");
      const stuck = await send(a.routes.post, { kind: "stuck", title: "Build fails", body: "Build fails on CI" });
      await send(a.routes.post, { kind: "fix", title: "Fix 1", body: "first fix", parent_id: stuck.body.id });
      w.sync(a, b, c);
      await send(a.routes.post, { kind: "fix", title: "Fix 2", body: "second fix", parent_id: stuck.body.id });
      w.sync(a, b);
      b.board.remove(stuck.body.id);
      w.sync(b, a, b, a);
      return { live: [], dead: [stuck.body.id], on: [a, b] };
    }],
    ["F: a post one PC fixed twice and deleted stays gone while a PC that saw the first fix is off", async (w) => {
      const a = w.boot("pc-a");
      const b = w.boot("pc-b");
      const stuck = await send(b.routes.post, { kind: "stuck", title: "Build fails", body: "Build fails on CI" });
      await send(b.routes.post, { kind: "fix", title: "Fix 1", body: "first fix", parent_id: stuck.body.id });
      w.sync(b, a);
      await send(b.routes.post, { kind: "fix", title: "Fix 2", body: "second fix", parent_id: stuck.body.id });
      b.board.remove(stuck.body.id);
      w.sync(b, b);
      return { live: [], dead: [stuck.body.id], on: [b] };
    }],
    ...(["clear", "call"] as const).flatMap((then) =>
      (["pc-a", "pc-b"] as const).map((first): (typeof cases)[number] => [`M: an upgraded call history with no delete ends as the release does (${then}, ${first} syncing first)`, (w) => {
        const a = w.boot("pc-a");
        const b = w.boot("pc-b");
        const old = oldCall(a, 0);
        expect(clear(a, "First fix")).toEqual([old.id]);
        const modern = call(b);
        expect(modern.id).not.toBe(old.id);
        const order = first === "pc-a" ? [a, b, a, b] : [b, a, b, a];
        w.sync(...order);
        const live = [{ id: old.id, status: "solved" as const, fix: "First fix" }, { id: modern.id, status: "open" as const, fix: "" }];
        if (then === "clear") {
          expect(clear(b, "Second fix")).toEqual([]);
          w.sync(...order);
          return { live, dead: [] };
        }
        const again = call(b);
        expect([old.id, modern.id]).not.toContain(again.id);
        w.sync(...order);
        return { live: [...live, { id: again.id, status: "open" }], dead: [] };
      }]),
    ),
  ];

  it.each(cases.flatMap(([name, run, modes = ["Drive"]]) => modes.map((mode) => [`${name} (${mode})`, run, mode] as const)))("%s", async (_name, run, mode) => {
    const w = world(mode === "Drive");
    const { live, dead, on = w.drive ? w.pcs : w.pcs.slice(0, 1) } = await run(w);
    for (const pc of on) {
      for (const board of [pc.board, createBoard({ dir: pc.dir, pcId: () => pc.name })]) {
        const listed = board.list();
        // nothing deleted that should live
        for (const want of live) expect(listed, pc.name).toContainEqual(expect.objectContaining(want));
        // nothing live that was deleted, and no second copy of what lives
        for (const id of dead) expect(listed.map((post) => post.id), pc.name).not.toContain(id);
        expect(listed, pc.name).toHaveLength(live.length);
      }
    }
  });
});

describe("a delete or a sync never rewrites a post it leaves", () => {
  const ids = { out: (id: string) => id, in: (id: string) => id };
  const world = () => {
    const folder = temps.make(join(tmpdir(), "orbit-board-drive-"));
    let tick = 1_000;
    const open = (name: string, dir = join(temps.make(join(tmpdir(), "orbit-board-")), BOARD_DIR)) => ({ name, dir, board: createBoard({ dir, pcId: () => name, now: () => ++tick }) });
    const pcs = { a: open("pc-a"), b: open("pc-b") };
    const put = (title: string, parent?: BoardPost, author = "carbon", kind: BoardPost["kind"] = "tip") =>
      pcs.a.board.post({ author_bot_id: author, kind, title, body: title, fix: kind === "fix" ? title : undefined, parent_id: parent?.id ?? null, source_ref: `${author === BOARD_USER ? "reply:" : "tool:tc:"}${title}` });
    const keep = put("keep");
    const keepReply = put("keep reply", keep, BOARD_USER);
    const stuck = put("stuck");
    const upper = put("upper", stuck, BOARD_USER);
    const side = put("side", upper);
    const lower = put("lower", upper, BOARD_USER);
    const answer = put("answer", lower);
    const fix = put("fix", answer, "carbon", "fix");
    const sync = (...order: (keyof typeof pcs)[]) => {
      for (const pc of order) pcs[pc].board.sync(folder, ids);
    };
    sync("a", "b", "a", "b");
    return {
      folder,
      pcs,
      sync,
      posts: { keep, keepReply, stuck, upper, side, lower, answer, fix },
      restart: (pc: keyof typeof pcs) => {
        pcs[pc] = open(pcs[pc].name, pcs[pc].dir);
      },
    };
  };
  type World = ReturnType<typeof world>;
  type Name = keyof World["posts"];
  // every file renamed into place or removed while run runs; die(file) ends the process right after the rename onto file
  const record = (run: (die: (file: string) => void) => void) => {
    const { renameSync, rmSync } = fs;
    const touched: Array<["rename" | "rm", string]> = [];
    let last: string | undefined;
    const spies = [
      vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        renameSync(from, to);
        touched.push(["rename", String(to)]);
        if (String(to) !== last) return;
        last = undefined;
        throw new Error("restart");
      }),
      vi.spyOn(fs, "rmSync").mockImplementation((path, options) => {
        rmSync(path, options);
        touched.push(["rm", String(path)]);
      }),
    ];
    syncBuiltinESMExports();
    try {
      run((file) => {
        last = file;
      });
    } finally {
      for (const spy of spies) spy.mockRestore();
      syncBuiltinESMExports();
    }
    return touched;
  };
  const THREAD: Name[] = ["stuck", "upper", "side", "lower", "answer", "fix"];
  const paths: Array<{ path: string; gone: Name[]; run: (w: World, die: (file: string) => void) => void; setup?: (w: World) => string[] }> = [
    { path: "this PC deletes a thread", gone: THREAD, run: (w) => w.pcs.a.board.remove(w.posts.stuck.id) },
    { path: "two PCs delete the same thread", gone: THREAD, run: (w) => {
      w.pcs.a.board.remove(w.posts.stuck.id);
      w.pcs.b.board.remove(w.posts.stuck.id);
    } },
    { path: "a sync takes a reply delete an older build kept as a bare id", gone: ["lower"], setup: (w) => {
      const old = join(w.folder, BOARD_DIR, "pc-old");
      mkdirSync(old, { recursive: true });
      writeFileSync(join(old, "deleted.json"), JSON.stringify([w.posts.lower.id]));
      return [];
    }, run: () => {} },
    { path: "a sync takes a thread delete and drops a reply the other PC wrote offline", gone: THREAD, setup: (w) => [
      w.pcs.b.board.post({ author_bot_id: "scout", kind: "tip", title: "late", body: "late", parent_id: w.posts.stuck.id, source_ref: "tool:tc:late" }).id,
    ], run: (w) => w.pcs.a.board.remove(w.posts.stuck.id) },
    { path: "a sync takes a thread delete and drops an older build's copy of its post", gone: THREAD, setup: (w) => {
      const copy = { ...w.posts.stuck, id: boardPostId(JSON.stringify([w.posts.stuck.id, "older build"])), status: "solved" as const, fix: "saved fix" };
      writeFileSync(join(w.pcs.b.dir, `${copy.id}.json`), JSON.stringify(copy));
      w.restart("b");
      return [copy.id];
    }, run: (w) => w.pcs.a.board.remove(w.posts.stuck.id) },
    { path: "a restart finishes a thread delete it cut short", gone: THREAD, run: (w, die) => {
      die(join(w.pcs.a.dir, "deleted.json"));
      expect(() => w.pcs.a.board.remove(w.posts.stuck.id)).toThrow("restart");
      w.restart("a");
    } },
    { path: "a restart finishes a pulled thread delete it cut short", gone: THREAD, run: (w, die) => {
      w.pcs.a.board.remove(w.posts.stuck.id);
      w.sync("a");
      die(join(w.pcs.b.dir, "deleted.json"));
      expect(() => w.sync("b")).toThrow("restart");
      w.restart("b");
    } },
  ];

  it.each(paths)("$path: only tombstones and the deleted posts' files change", ({ gone, run, setup }) => {
    const w = world();
    const dead = new Set([...gone.map((name) => w.posts[name].id), ...(setup?.(w) ?? [])]);
    const rows = (dir: string) => Object.fromEntries((fs.existsSync(dir) ? readdirSync(dir) : []).filter((name) => /^p[0-9a-f]{24}\.json$/.test(name)).map((name) => [name.slice(0, -5), readFileSync(join(dir, name), "utf8")]));
    const published = (pc: keyof World["pcs"]) => rows(join(w.folder, BOARD_DIR, w.pcs[pc].name));
    const left = <T>(held: Record<string, T>) => Object.fromEntries(Object.entries(held).filter(([id]) => !dead.has(id)));
    const state = () => ({ a: rows(w.pcs.a.dir), b: rows(w.pcs.b.dir), driveA: published("a"), driveB: published("b") });
    const before = state();
    const touched = record((die) => {
      run(w, die);
      w.sync("a", "b", "a", "b");
    });
    const local = [w.pcs.a.dir, w.pcs.b.dir];
    for (const [kind, file] of touched) {
      if (basename(file) === "deleted.json") continue;
      if (kind === "rm") expect([...dead], file).toContain(basename(file, ".json"));
      else expect(local, `rewrote ${file}`).not.toContain(dirname(file));
    }
    expect(state()).toEqual({ a: left(before.a), b: left(before.b), driveA: left(before.driveA), driveB: left(before.driveB) });
    const kept = Object.values(w.posts).filter((post) => !dead.has(post.id)).map((post) => post.id).sort();
    for (const pc of [w.pcs.a, w.pcs.b]) expect(pc.board.list().map((post) => post.id).sort(), pc.name).toEqual(kept);
  });
});
