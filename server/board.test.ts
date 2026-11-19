import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { BOARD_DIR, BOARD_USER, boardPostId, createBoard, errorSig, mergeBoardPosts, projectIdOf, type BoardPost } from "./board.ts";
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

  it("removing a reply still moves the replies under it up to its parent", () => {
    const { board } = home("pc-a");
    const stuck = board.post(STUCK);
    const reply = board.post({ author_bot_id: BOARD_USER, parent_id: stuck.id, kind: "tip", title: STUCK.title, body: "Thanks.", source_ref: "reply:r1" });
    const under = board.post({ author_bot_id: "carbon", parent_id: reply.id, kind: "tip", title: STUCK.title, body: "Welcome.", source_ref: "tool:tc:1" });
    board.remove(reply.id);
    expect(board.get(under.id)).toMatchObject({ parent_id: stuck.id });
  });
});
