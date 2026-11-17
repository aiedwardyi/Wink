// The Board: posts bots leave when they get stuck, and the fixes that unstick them.
// One file per post; an id comes from the event that wrote it, so a repeat is the same post.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { redactSecretsInText } from "./redact.ts";

export const BOARD_DIR = "board";
export const BOARD_KINDS = ["stuck", "fix", "handoff", "tip"] as const;
export const BOARD_USER = "user";
/** A post written on a team room turn starts its source_ref with this: people outside this PC shaped it. */
export const ROOM_REF = "room:";
export const fromRoom = (post: Pick<BoardPost, "source_ref">) => post.source_ref.startsWith(ROOM_REF);

const LIMITS = { id: 160, title: 200, body: 4000, fix: 4000, ref: 300 } as const;

const idSchema = z.string().regex(/^p[0-9a-f]{24}$/);
/** The author as it looked when it posted, so another PC can show a bot it does not have. */
const authorSchema = z.object({ name: z.string().max(LIMITS.id), model: z.string().max(LIMITS.id), color: z.string().max(32), mascot_style: z.string().max(64) });
const postSchema = z.object({
  id: idSchema,
  parent_id: idSchema.nullable(),
  author_bot_id: z.string().max(LIMITS.id),
  project_id: z.string().max(LIMITS.id),
  kind: z.enum(BOARD_KINDS),
  title: z.string().max(LIMITS.title),
  body: z.string().max(LIMITS.body),
  error_sig: z.string().max(64),
  status: z.enum(["open", "solved"]),
  fix: z.string().max(LIMITS.fix),
  source_ref: z.string().max(LIMITS.ref),
  helped_bot_ids: z.array(z.string().max(LIMITS.id)),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  pc_id: z.string().max(LIMITS.id),
  author: authorSchema.optional(),
});

export type BoardAuthor = z.infer<typeof authorSchema>;
export type BoardPost = z.infer<typeof postSchema>;
export type BoardKind = BoardPost["kind"];
export type NewBoardPost = Pick<BoardPost, "author_bot_id" | "kind" | "title" | "body" | "source_ref"> & Partial<Pick<BoardPost, "parent_id" | "project_id" | "error_sig" | "status" | "fix">>;

const clean = (text: string, max: number) => redactSecretsInText(text.trim()).slice(0, max);

/** Hashes the ref as stored, so a long ref still names its post. */
export const boardPostId = (sourceRef: string) => `p${createHash("sha256").update(sourceRef.slice(0, LIMITS.ref)).digest("hex").slice(0, 24)}`;

/** Paths, numbers and ids drop out, so the same failure on another folder or day signs the same. */
export function errorSig(text: string): string {
  const shape = text.toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(?:[a-z]:)?[\\/][^\s"'`]+/g, " ")
    .replace(/\b[0-9a-f]{6,}\b/g, " ")
    .replace(/\d+/g, " ")
    .replace(/[^\p{L}\s]+/gu, " ")
    .split(/\s+/).filter(Boolean).slice(0, 16).join(" ");
  return shape ? createHash("sha256").update(shape).digest("hex").slice(0, 16) : "";
}

const STOP = new Set("the and for are but not you your with this that from have has had was were will can could would should into onto about when then than there their they them our out off its it's isn't can't don't didn't won't been being which what who how why all any some just also only very more most need needs".split(" "));

export function boardWords(text: string): string[] {
  const words = text.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}_]+/u).filter((word) => word.length >= 3 && !STOP.has(word) && !/^\d+$/.test(word));
  return [...new Set(words)];
}

export function projectIdOf(folder: string | undefined | null): string {
  return folder ? basename(folder.replace(/[\\/]+$/, "")).toLowerCase() : "";
}

/** Two copies of one post: the newer edit leads, solved never reopens, and every helped bot stays. */
export function mergeBoardPosts(left: BoardPost, right: BoardPost): BoardPost {
  const [older, newer] = left.updated_at <= right.updated_at ? [left, right] : [right, left];
  const solved = [newer, older].find((post) => post.status === "solved");
  return {
    ...newer,
    status: solved ? "solved" : "open",
    fix: solved?.fix || newer.fix || older.fix,
    helped_bot_ids: [...new Set([...older.helped_bot_ids, ...newer.helped_bot_ids])].sort(),
    created_at: Math.min(older.created_at, newer.created_at),
  };
}

function readPost(path: string): BoardPost | null {
  try {
    const parsed = postSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function readPosts(dir: string): BoardPost[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith(".json")).flatMap((name) => {
    const post = readPost(join(dir, name));
    return post && `${post.id}.json` === name ? [post] : [];
  });
}

const same = (left: BoardPost, right: BoardPost) => JSON.stringify(left) === JSON.stringify(right);

export interface BoardSearch {
  query: string;
  projectId?: string;
  errorSig?: string;
  solvedOnly?: boolean;
  /** Share of the query's words a post must hold; a matching error_sig always passes. */
  minShare?: number;
  limit?: number;
  withoutRoom?: boolean;
}

export interface BoardOptions {
  dir: string;
  pcId: () => string;
  now?: () => number;
  changed?: () => void;
  author?: (botId: string) => BoardAuthor | undefined;
}

export function createBoard(options: BoardOptions) {
  const now = options.now ?? Date.now;
  let cache: Map<string, BoardPost> | null = null;
  const posts = () => (cache ??= new Map(readPosts(options.dir).map((post) => [post.id, post])));

  const write = (post: BoardPost) => {
    mkdirSync(options.dir, { recursive: true });
    writeFileAtomic(join(options.dir, `${post.id}.json`), `${JSON.stringify(post, null, 2)}\n`);
    posts().set(post.id, post);
  };

  /** Keeps a copy another PC wrote; returns whether this PC's copy changed. */
  const take = (incoming: BoardPost): boolean => {
    const held = posts().get(incoming.id);
    const next = held ? mergeBoardPosts(held, incoming) : incoming;
    if (held && same(held, next)) return false;
    write(next);
    return true;
  };

  const solved = (held: BoardPost, fix: string, at: number): BoardPost => {
    const next = { ...held, status: "solved" as const, fix: clean(fix, LIMITS.fix), updated_at: at, pc_id: options.pcId() };
    write(next);
    return next;
  };

  const board = {
    dir: options.dir,
    list(): BoardPost[] {
      return [...posts().values()].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
    },
    get(id: string): BoardPost | undefined {
      return posts().get(id);
    },
    /** Writes the post the event names; the same event again updates that post. A fix also solves its parent. */
    post(input: NewBoardPost): BoardPost {
      const id = boardPostId(input.source_ref);
      const at = now();
      const held = posts().get(id);
      const title = clean(input.title, LIMITS.title);
      const body = clean(input.body, LIMITS.body);
      const fix = clean(input.fix ?? held?.fix ?? "", LIMITS.fix);
      const looked = input.author_bot_id === BOARD_USER ? undefined : held?.author ?? options.author?.(input.author_bot_id);
      // cut to the schema's limits, or a long name would make the post unreadable after a restart
      const author = looked && { name: looked.name.slice(0, LIMITS.id), model: looked.model.slice(0, LIMITS.id), color: looked.color.slice(0, 32), mascot_style: looked.mascot_style.slice(0, 64) };
      const next: BoardPost = {
        id,
        parent_id: input.parent_id ?? held?.parent_id ?? null,
        author_bot_id: input.author_bot_id,
        project_id: input.project_id ?? held?.project_id ?? "",
        kind: input.kind,
        title,
        body,
        error_sig: input.error_sig ?? held?.error_sig ?? errorSig(`${title}\n${body}`),
        status: held?.status === "solved" ? "solved" : input.status ?? (input.kind === "fix" ? "solved" : "open"),
        fix,
        source_ref: input.source_ref.slice(0, LIMITS.ref),
        helped_bot_ids: held?.helped_bot_ids ?? [],
        created_at: held?.created_at ?? at,
        updated_at: at,
        pc_id: options.pcId(),
      };
      if (author) next.author = author;
      write(next);
      // a room's fix stays a note; it never solves a post a call would be held on
      const parent = next.kind === "fix" && next.parent_id && !fromRoom(next) ? posts().get(next.parent_id) : undefined;
      if (parent) solved(parent, next.fix || next.body, at);
      options.changed?.();
      return next;
    },
    solve(id: string, fix: string): BoardPost | undefined {
      const held = posts().get(id);
      if (!held) return undefined;
      const next = solved(held, fix, now());
      options.changed?.();
      return next;
    },
    helped(ids: readonly string[], botId: string): void {
      let changed = false;
      for (const id of ids) {
        const held = posts().get(id);
        if (!held || held.helped_bot_ids.includes(botId)) continue;
        write({ ...held, helped_bot_ids: [...held.helped_bot_ids, botId].sort(), updated_at: now(), pc_id: options.pcId() });
        changed = true;
      }
      if (changed) options.changed?.();
    },
    search(input: BoardSearch): BoardPost[] {
      const words = boardWords(input.query);
      const minShare = input.minShare ?? 0;
      const scored = board.list().flatMap((post) => {
        if ((input.solvedOnly && (post.status !== "solved" || !post.fix)) || (input.withoutRoom && fromRoom(post))) return [];
        const sig = Boolean(input.errorSig && post.error_sig === input.errorSig);
        const held = new Set(boardWords(`${post.title} ${post.body} ${post.fix}`));
        const hits = words.filter((word) => held.has(word)).length;
        const share = words.length ? hits / words.length : 0;
        if (!sig && (!hits || share < minShare)) return [];
        return [{ post, score: (sig ? 1 : 0) + share, local: Boolean(input.projectId && post.project_id === input.projectId) }];
      });
      scored.sort((a, b) => Number(b.local) - Number(a.local) || b.score - a.score || b.post.updated_at - a.post.updated_at);
      return scored.slice(0, input.limit ?? 5).map((entry) => entry.post);
    },
    /**
     * Drive sync. Each PC writes only its own folder, so two PCs posting at once never
     * write one file; bot ids cross as sync ids.
     */
    sync(folder: string, ids: { out(localId: string): string; in(syncId: string): string }): { pulled: number; pushed: number } {
      const root = join(folder, BOARD_DIR);
      const mine = options.pcId();
      const mapPost = (post: BoardPost, map: (id: string) => string): BoardPost => ({
        ...post,
        author_bot_id: post.author_bot_id === BOARD_USER ? BOARD_USER : map(post.author_bot_id),
        helped_bot_ids: [...new Set(post.helped_bot_ids.map(map))].sort(),
      });
      let pcs: string[];
      try {
        pcs = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== mine).map((entry) => entry.name);
      } catch {
        pcs = [];
      }
      let pulled = 0;
      for (const pc of pcs) {
        for (const post of readPosts(join(root, pc))) if (take(mapPost(post, ids.in))) pulled++;
      }
      const ownDir = join(root, mine);
      const published = new Map(readPosts(ownDir).map((post) => [post.id, post]));
      let pushed = 0;
      for (const post of posts().values()) {
        const out = mapPost(post, ids.out);
        const held = published.get(post.id);
        if (held && same(held, out)) continue;
        mkdirSync(ownDir, { recursive: true });
        writeFileAtomic(join(ownDir, `${post.id}.json`), `${JSON.stringify(out, null, 2)}\n`);
        pushed++;
      }
      if (pulled) options.changed?.();
      return { pulled, pushed };
    },
  };
  return board;
}

export type Board = ReturnType<typeof createBoard>;

/** What a bot sees of a post: a few hundred characters, never the whole thread. */
export function boardLine(post: BoardPost, max = 300): string {
  const cut = (text: string) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  const fix = post.fix ? `\nFix: ${cut(post.fix)}` : "";
  return `[${post.id}] ${post.kind}, ${post.status}${fromRoom(post) ? ", from a team room" : ""}${post.project_id ? `, ${post.project_id}` : ""}: ${cut(post.title)}${post.body && post.body !== post.title ? `\n${cut(post.body)}` : ""}${fix}`;
}
