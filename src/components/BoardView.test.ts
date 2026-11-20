// @vitest-environment happy-dom
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BOARD_USER, createBoard } from "../../server/board.ts";
import { createTempDirs } from "../../server/testing/cleanup.ts";

import { BOARD_CHANGED_EVENT, FORUM_SELECTION, forumKept, type BoardPost } from "@/lib/board";
import { PHONE_QUERY } from "@/lib/phone-swipe";
import type { Action, Bot } from "@/state/store";

const mock = vi.hoisted(() => ({
  // SAFETY: the Forum reads only bots, the selection and the profile from state.
  state: { bots: [] as Bot[], instances: [] as { instanceId: string; driverKind: string; models?: { default: string; options: { id: string; label: string }[] } }[], selectedId: "", config: undefined as { profile: { name: string } } | undefined },
  dispatched: [] as Action[],
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: mock.state, dispatch: (action: Action) => mock.dispatched.push(action) }),
}));

import { I18nProvider } from "@/lib/i18n";
import { BoardButton } from "./BoardButton";
import { BoardView } from "./BoardView";
import { ProviderMark } from "./ProviderIcons";

const bot = (id: string, name: string): Bot => ({
  id, threadId: `${id}-thread`, name, title: "", description: "", notifications: true, color: "green", unread: false,
  modelSelection: { instanceId: "codex-1", model: "codex-default" }, messages: [],
});
const post = (id: string, patch: Partial<BoardPost>): BoardPost => ({
  id, parent_id: null, author_bot_id: "astra", project_id: "wink", kind: "stuck", title: id, body: id, error_sig: "", status: "open",
  fix: "", source_ref: id, helped_bot_ids: [], created_at: 1, updated_at: 1, pc_id: "home", ...patch,
});

let host: HTMLDivElement;
let root: Root;
let posts: BoardPost[];
let replies: unknown[];
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const render = async (node: Parameters<typeof createElement>[0]) => {
  await act(async () => root.render(createElement(I18nProvider, null, createElement(node))));
  await settle();
};
const rows = () => [...host.querySelectorAll("[data-board-post]")].map((row) => row.getAttribute("data-board-post"));
// reduced motion unmounts a closed post at once; the push/pop test turns it off
const realMatchMedia = window.matchMedia.bind(window);
const reduceMotion = (reduce: boolean) => vi.spyOn(window, "matchMedia").mockImplementation((query) => Object.defineProperty(realMatchMedia(query), "matches", { value: reduce && query.includes("reduce") }));

beforeEach(() => {
  Object.assign(forumKept, { posts: null, sort: "hot", flair: null, openId: null });
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mock.state = { bots: [bot("astra", "Astra"), bot("carbon", "Carbon")], instances: [], selectedId: "", config: undefined };
  mock.dispatched = [];
  reduceMotion(true);
  posts = [];
  replies = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/board/reply") {
      const body = JSON.parse(String(init?.body));
      replies.push(body);
      posts.push(post("puser", { parent_id: body.parent_id, author_bot_id: "user", kind: "tip", body: body.body, created_at: 9 }));
      return new Response(JSON.stringify({ post: posts.at(-1) }), { headers: { "content-type": "application/json" } });
    }
    if (url === "/api/board/delete") {
      const { id } = JSON.parse(String(init?.body));
      posts = posts.filter((held) => held.id !== id);
      return new Response(JSON.stringify({ id }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ posts }), { headers: { "content-type": "application/json" } });
  }));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const typeIn = (input: HTMLInputElement, text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const box = (id: string) => host.querySelector<HTMLInputElement>(`[data-board-reply-box="${id}"] input`);
const click = (selector: string) => act(async () => host.querySelector<HTMLElement>(selector)!.click());
const openRow = (id: string) => click(`[data-board-post="${id}"] > button`);
const dialogButton = (label: string) => act(async () => [...document.body.querySelectorAll<HTMLButtonElement>("[role=dialog] button")].find((button) => button.textContent === label)!.click());
const json = (body: { posts: BoardPost[] }) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

describe("Forum", () => {
  it("a finished reply clears only its own draft: a reply typed meanwhile stays, across Back too", async () => {
    posts = [post("pop", { created_at: 1 }), post("pa", { parent_id: "pop", author_bot_id: "carbon", body: "A", created_at: 2 }), post("pb", { parent_id: "pop", author_bot_id: "carbon", body: "B", created_at: 3 })];
    const ok = globalThis.fetch;
    let finish = () => {};
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => (url === "/api/board/reply" ? new Promise<Response>((resolve) => { finish = () => void ok(url, init).then(resolve); }) : ok(url, init))));
    await render(BoardView);
    await openRow("pop");
    await click('[data-board-reply-to="pa"]');
    await typeIn(box("pa")!, "to A");
    await click('[data-board-reply-box="pa"] button[type="submit"]');
    await click('[data-board-reply-to="pb"]');
    await typeIn(box("pb")!, "to B");
    await act(async () => finish());
    await settle();
    expect(box("pb")?.value).toBe("to B");
    await click("[data-back-button]");
    await openRow("pop");
    await click('[data-board-reply-to="pb"]');
    expect(box("pb")!.value).toBe("to B");
    await click('[data-board-reply-to="pa"]');
    expect(box("pa")!.value).toBe("");
  });

  it("an older load that finishes late does not drop a newer post", async () => {
    const answers: Array<(list: BoardPost[]) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => answers.push((list) => resolve(json({ posts: list }))))));
    await act(async () => root.render(createElement(I18nProvider, null, createElement(BoardView))));
    await act(async () => window.dispatchEvent(new Event(BOARD_CHANGED_EVENT)));
    await act(async () => answers[1]!([post("pold", { created_at: 1 }), post("pnew", { created_at: 2 })]));
    await settle();
    await act(async () => answers[0]!([post("pold", { created_at: 1 })]));
    await settle();
    expect(rows()).toEqual(["pnew", "pold"]);
  });

  it("shows a saved reply without waiting for a Board change, and a failed load inside the open post", async () => {
    posts = [post("pop", { created_at: 1 })];
    await render(BoardView);
    await openRow("pop");
    await typeIn(box("pop")!, "On it.");
    await click('[data-board-reply-box="pop"] button[type="submit"]');
    await settle();
    expect(rows()).toEqual(["pop", "puser"]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    await act(async () => window.dispatchEvent(new Event(BOARD_CHANGED_EVENT)));
    await settle();
    expect(host.querySelector("[data-side-panel] [role=alert]")).not.toBeNull();
  });

  it("a retry after a lost answer sends the same reply id; a new reply gets a new one", async () => {
    posts = [post("pop", { created_at: 1 })];
    const ok = globalThis.fetch;
    let lost = true;
    const ids: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/board/reply") {
        ids.push(JSON.parse(String(init?.body)).client_id);
        if (lost) throw new TypeError("connection reset");
      }
      return ok(url, init);
    }));
    await render(BoardView);
    await openRow("pop");
    await typeIn(box("pop")!, "Same words.");
    await click('[data-board-reply-box="pop"] button[type="submit"]');
    await settle();
    lost = false;
    await click('[data-board-reply-box="pop"] button[type="submit"]');
    await settle();
    await typeIn(box("pop")!, "Other words.");
    await click('[data-board-reply-box="pop"] button[type="submit"]');
    await settle();
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("Back returns to the same place in the list with the opened row focused; open focuses Back", async () => {
    posts = Array.from({ length: 30 }, (_, i) => post(`p${i}`, { created_at: i + 1 }));
    await render(BoardView);
    const list = host.querySelector<HTMLElement>("[data-board-view] .overflow-y-auto")!;
    list.scrollTop = 600;
    await openRow("p10");
    expect(document.activeElement).toBe(host.querySelector("[data-back-button]"));
    list.scrollTop = 0;
    await click("[data-back-button]");
    expect(list.scrollTop).toBe(600);
    expect(document.activeElement).toBe(host.querySelector('[data-board-post="p10"] > button'));
  });

  it("a keyboard user reaches Copy and Delete on their own plain reply", async () => {
    posts = [post("pbot", { created_at: 1 }), post("pmine", { parent_id: "pbot", author_bot_id: "user", kind: "tip", body: "Mine.", source_ref: "reply:r1", created_at: 2 })];
    await render(BoardView);
    await openRow("pbot");
    const opener = host.querySelector<HTMLElement>('[data-board-post="pmine"] [tabindex="0"]')!;
    expect(opener).not.toBeNull();
    opener.focus();
    await act(async () => { opener.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true })); });
    expect([...document.body.querySelectorAll("[data-message-menu] [role=menuitem]")].map((item) => item.textContent)).toEqual(["Copy", "Delete"]);
  });

  it("draws the person icon, not a letter, on the user's reply with no profile name", async () => {
    posts = [post("pbot", { created_at: 1 }), post("pmine", { parent_id: "pbot", author_bot_id: "user", kind: "tip", body: "Mine.", source_ref: "reply:r1", created_at: 2 })];
    await render(BoardView);
    await openRow("pbot");
    for (const config of [undefined, { profile: { name: "" } }]) {
      mock.state.config = config;
      await render(BoardView);
      const mine = host.querySelector('[data-board-post="pmine"]')!;
      expect(mine.querySelector("svg.lucide-user")).not.toBeNull();
      expect(mine.querySelector("[data-board-author]")!.textContent).toBe("You");
    }
    mock.state.config = { profile: { name: "Mina Park" } };
    await render(BoardView);
    expect(host.querySelector('[data-board-post="pmine"] svg.lucide-user')).toBeNull();
    expect(host.querySelector('[data-board-post="pmine"]')!.textContent).toContain("MP");
  });

  it("asks before deleting the user's own reply, and Cancel keeps it", async () => {
    posts = [post("pbot", { created_at: 1 }), post("pmine", { parent_id: "pbot", author_bot_id: "user", kind: "tip", body: "Mine.", source_ref: "reply:r1", created_at: 2 })];
    const ok = globalThis.fetch;
    const deletes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/board/delete") deletes.push(JSON.parse(String(init?.body)).id);
      return ok(url, init);
    }));
    await render(BoardView);
    await openRow("pbot");
    const askDelete = async () => {
      await act(async () => { host.querySelector('[data-board-post="pmine"] p')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); });
      await act(async () => document.body.querySelector<HTMLButtonElement>("[data-menu-delete]")!.click());
    };
    await askDelete();
    expect(document.body.querySelector("[role=dialog] h2")!.textContent).toBe("Delete this reply?");
    expect(deletes).toEqual([]);
    await dialogButton("Cancel");
    await settle();
    expect(deletes).toEqual([]);
    expect(host.querySelector('[data-board-post="pmine"]')).not.toBeNull();
    await askDelete();
    await dialogButton("Delete");
    await settle();
    expect(deletes).toEqual(["pmine"]);
  });

  it("a deleted reply stays gone: no ghost from the saved reply or a load asked before the delete", async () => {
    posts = [post("pbot", { created_at: 1 })];
    const ok = globalThis.fetch;
    let hold: ((value: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/board/reply") {
        const sent = JSON.parse(String(init?.body));
        const mine = post("pmine", { parent_id: sent.parent_id, author_bot_id: "user", kind: "tip", body: sent.body, source_ref: `reply:${sent.client_id}`, created_at: 2 });
        posts.push(mine);
        return new Response(JSON.stringify({ post: mine }), { headers: { "content-type": "application/json" } });
      }
      // a load asked before the delete that answers after it
      if (url === "/api/board" && hold === null && posts.some((held) => held.id === "pmine")) {
        const snapshot = [...posts];
        return new Promise<Response>((resolve) => { hold = resolve; }).then(() => json({ posts: snapshot }));
      }
      return ok(url, init);
    }));
    await render(BoardView);
    await openRow("pbot");
    await typeIn(box("pbot")!, "Mine.");
    await click('[data-board-reply-box="pbot"] button[type="submit"]');
    await settle();
    expect(rows()).toContain("pmine");
    await act(async () => window.dispatchEvent(new Event(BOARD_CHANGED_EVENT)));
    await act(async () => { host.querySelector('[data-board-post="pmine"] p')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); });
    await act(async () => document.body.querySelector<HTMLButtonElement>("[data-menu-delete]")!.click());
    await dialogButton("Delete");
    await settle();
    expect(rows()).not.toContain("pmine");
    await act(async () => hold!(new Response()));
    await settle();
    expect(rows()).not.toContain("pmine");
    await act(async () => window.dispatchEvent(new Event(BOARD_CHANGED_EVENT)));
    await settle();
    expect(rows()).toEqual(["pbot"]);
  });

  it("a reply saved here that another PC deleted before any load carried it leaves on the next load", async () => {
    posts = [post("pop", { created_at: 1 }), post("pother", { created_at: 2 })];
    await render(BoardView);
    await openRow("pop");
    await typeIn(box("pop")!, "On it.");
    await click('[data-board-reply-box="pop"] button[type="submit"]');
    await settle();
    expect(rows()).toEqual(["pop", "puser"]);
    posts = posts.filter((held) => held.id === "pother");
    await act(async () => window.dispatchEvent(new Event(BOARD_CHANGED_EVENT)));
    await settle();
    expect(rows()).toEqual(["pother"]);
  });

  it("a thread another PC deletes leaves the open Forum on the next load, with the reply saved here", async () => {
    const temps = createTempDirs();
    afterAll(() => temps.remove());
    const drive = temps.make(join(tmpdir(), "orbit-forum-drive-"));
    const boot = (pc: string) => createBoard({ dir: join(temps.make(join(tmpdir(), "orbit-forum-")), "board"), pcId: () => pc });
    const [a, b] = [boot("home"), boot("work")];
    const ids = { in: (id: string) => id, out: (id: string) => id };
    const sync = () => {
      for (const board of [a, b, a, b]) board.sync(drive, ids);
    };
    const stuck = a.post({ author_bot_id: "astra", kind: "stuck", title: "Stuck on the staging deploy", body: "Stuck on the staging deploy", source_ref: "call:ta:0:engine:deploy" });
    const other = a.post({ author_bot_id: "astra", kind: "tip", title: "Pin node 22", body: "Pin node 22", source_ref: "tool:ta:pin" });
    sync();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== "/api/board/reply") return json({ posts: b.list() });
      const sent = JSON.parse(String(init?.body));
      const saved = b.post({ author_bot_id: BOARD_USER, parent_id: sent.parent_id, kind: "tip", title: stuck.title, body: sent.body, source_ref: `reply:${sent.client_id}` });
      return new Response(JSON.stringify({ post: saved }), { headers: { "content-type": "application/json" } });
    }));
    await render(BoardView);
    await openRow(stuck.id);
    await typeIn(box(stuck.id)!, "On it.");
    await click(`[data-board-reply-box="${stuck.id}"] button[type="submit"]`);
    await settle();
    const reply = b.list().find((held) => held.parent_id === stuck.id)!;
    expect(rows()).toEqual([stuck.id, reply.id]);
    a.remove(stuck.id);
    sync();
    expect(b.list().map((held) => held.id)).toEqual([other.id]);
    await act(async () => window.dispatchEvent(new Event(BOARD_CHANGED_EVENT)));
    await settle();
    expect(rows()).toEqual([other.id]);
  });

it("a deleted reply's own replies stay in the thread, moved up to its parent", async () => {
    posts = [
      post("pbot", { created_at: 1 }),
      post("pmine", { parent_id: "pbot", author_bot_id: "user", kind: "tip", body: "Mine.", source_ref: "reply:r1", created_at: 2 }),
      post("pchild", { parent_id: "pmine", author_bot_id: "carbon", kind: "tip", body: "Child.", created_at: 3 }),
    ];
    const ok = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => (url === "/api/board/delete" ? json({ posts: [] }) : ok(url, init))));
    await render(BoardView);
    await openRow("pbot");
    await act(async () => { host.querySelector('[data-board-post="pmine"] p')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); });
    await act(async () => document.body.querySelector<HTMLButtonElement>("[data-menu-delete]")!.click());
    await dialogButton("Delete");
    await settle();
    const inThread = () => host.querySelector('[data-side-panel] [data-board-post="pchild"]');
    expect(host.querySelector('[data-board-post="pmine"]')).toBeNull();
    expect(inThread()).not.toBeNull();
    // a load asked before the delete still names the deleted parent
    await act(async () => window.dispatchEvent(new Event(BOARD_CHANGED_EVENT)));
    await settle();
    expect(host.querySelector('[data-board-post="pmine"]')).toBeNull();
    expect(inThread()).not.toBeNull();
  });

  it("a newer send of the same draft keeps its retry id when an older send finishes", async () => {
    posts = [post("pop", { created_at: 1 })];
    const ok = globalThis.fetch;
    const ids: string[] = [];
    let finishFirst: (() => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/board/reply") {
        ids.push(JSON.parse(String(init?.body)).client_id);
        if (ids.length === 1) return new Promise<Response>((resolve) => { finishFirst = () => resolve(ok(url, init)); });
        if (ids.length === 2) throw new TypeError("connection reset");
      }
      return ok(url, init);
    }));
    await render(BoardView);
    await openRow("pop");
    await typeIn(box("pop")!, "First words.");
    await click('[data-board-reply-box="pop"] button[type="submit"]');
    await click("[data-back-button]");
    await openRow("pop");
    await typeIn(box("pop")!, "Second words.");
    await click('[data-board-reply-box="pop"] button[type="submit"]');
    await settle();
    await act(async () => finishFirst!());
    await settle();
    await click('[data-board-reply-box="pop"] button[type="submit"]');
    await settle();
    expect(ids[1]).not.toBe(ids[0]);
    expect(ids[2]).toBe(ids[1]);
  });

  it("a failed load offers Retry, and the error goes once a load works", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    await render(BoardView);
    const alert = () => host.querySelector("[role=alert]");
    const retry = [...alert()!.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
    expect(retry).toBeDefined();
    vi.stubGlobal("fetch", vi.fn(async () => json({ posts: [post("pback", { created_at: 1 })] })));
    await act(async () => retry.click());
    await settle();
    expect(alert()).toBeNull();
    expect(rows()).toEqual(["pback"]);
  });

  it("a busy bot's avatar in the list and in an open post carries no working ring", async () => {
    reduceMotion(false);
    mock.state.bots = [{ ...bot("astra", "Astra"), busy: true }];
    posts = [post("pbusy", { author_bot_id: "astra", created_at: 1 }), post("pbusyreply", { parent_id: "pbusy", author_bot_id: "astra", created_at: 2 })];
    await render(BoardView);
    expect(host.querySelector('[data-board-post="pbusy"] [data-board-working]')).toBeNull();
    expect(host.querySelector("[data-board-view] .orbit-ring")).toBeNull();
    await openRow("pbusy");
    expect(host.querySelector('[data-board-post="pbusyreply"] [data-board-working]')).not.toBeNull();
    expect(host.querySelector("[data-board-view] .orbit-ring")).toBeNull();
  });

  it("a right swipe on a phone goes back from a post", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => Object.defineProperty(realMatchMedia(query), "matches", { value: query.includes("reduce") || query === PHONE_QUERY }));
    posts = [post("pswipe", { created_at: 1 })];
    await render(BoardView);
    await openRow("pswipe");
    const page = host.querySelector<HTMLElement>("[data-side-panel]")!;
    const touch = (type: string, x: number, at: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { touches: { value: type === "touchend" ? [] : [{ clientX: x, clientY: 200 }] }, timeStamp: { value: at } });
      page.dispatchEvent(event);
    };
    await act(async () => {
      touch("touchstart", 10, 100);
      touch("touchmove", 60, 120);
      touch("touchmove", 700, 140);
      touch("touchend", 700, 160);
    });
    expect(host.querySelector("article")).toBeNull();
  });

  it("a chat visit comes back to the same sort, filter and open post, with no Loading frame", async () => {
    posts = [post("pa", { kind: "tip", created_at: 1 }), post("pb", { kind: "tip", created_at: 2 }), post("pc", { created_at: 3 })];
    await render(BoardView);
    await click('[data-board-sort="new"]');
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find((chip) => chip.textContent === "Tip")!.click());
    await openRow("pa");
    act(() => root.unmount());
    root = createRoot(host);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    await act(async () => root.render(createElement(I18nProvider, null, createElement(BoardView))));
    expect(host.querySelector("[data-board-loading]")).toBeNull();
    expect(host.querySelector('article[data-board-post="pa"]')).not.toBeNull();
    await click("[data-back-button]");
    expect(rows()).toEqual(["pb", "pa"]);
  });

  it("an app state change elsewhere redraws no list row", async () => {
    posts = Array.from({ length: 6 }, (_, i) => post(`p${i}`, { created_at: i + 1 }));
    await render(BoardView);
    // each row reads the clock for its age; the list reads it once to sort
    const clock = vi.spyOn(Date, "now");
    mock.state = { ...mock.state, selectedId: "elsewhere" };
    await act(async () => root.render(createElement(I18nProvider, null, createElement(BoardView))));
    expect(clock.mock.calls.length).toBeLessThan(posts.length);
  });

  it("lists posts with helped, flair, replies and Solved; a click opens the thread", async () => {
    posts = [
      post("pold", { title: "Old snag", body: "Old snag", created_at: 1 }),
      post("pnew", { title: "Codex usage limit", body: "Codex usage limit", status: "solved", fix: "Use Claude", helped_bot_ids: ["carbon"], created_at: 5 }),
      post("pfix", { parent_id: "pnew", kind: "fix", author_bot_id: "user", title: "Codex usage limit", body: "Use Claude", status: "solved", created_at: 6 }),
    ];
    await render(BoardView);
    expect(host.querySelector("[data-board-subtitle]")!.textContent).toBe("Made for your bots. You can read and reply too.");
    expect(rows()).toEqual(["pnew", "pold"]);
    expect([...host.querySelectorAll("[data-board-helped]")].map((count) => count.getAttribute("data-board-helped"))).toEqual(["1", "0"]);
    expect([...host.querySelectorAll("[data-board-flair]")].map((chip) => chip.textContent)).toEqual(["Stuck", "Stuck"]);
    expect(host.querySelector('[data-board-post="pnew"]')!.textContent).toContain("1 reply");
    expect([...host.querySelectorAll("[data-board-solved]")].map((mark) => mark.closest("[data-board-post]")!.getAttribute("data-board-post"))).toEqual(["pnew"]);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-board-post="pnew"] button')!.click());
    expect(rows()).toEqual(["pnew", "pfix"]);
    expect(host.querySelector('[data-board-post="pfix"]')!.textContent).toContain("Use Claude");
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Back to Forum"]')!.click());
    expect(rows()).toEqual(["pnew", "pold"]);
  });

  it("says it is loading while the server has not answered yet", async () => {
    let answer!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
    await render(BoardView);
    expect(host.querySelector("[data-board-loading]")?.textContent).toBe("Loading posts…");
    await act(async () => answer(new Response(JSON.stringify({ posts: [post("p1", {})] }), { headers: { "content-type": "application/json" } })));
    await settle();
    expect(host.querySelector("[data-board-loading]")).toBeNull();
    expect(rows()).toEqual(["p1"]);
  });

  const openPost = async () => {
    posts = [post("pesc", { title: "Esc post", body: "Esc post", created_at: 1 })];
    await render(BoardView);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-board-post="pesc"] button')!.click());
    expect(host.querySelector("article")).not.toBeNull();
  };
  const esc = (target: EventTarget = document.body) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

  it("Esc inside an open post returns to the list, and Esc on the list leaves it alone", async () => {
    await esc();
    await openPost();
    await esc();
    expect(host.querySelector("article")).toBeNull();
    expect(rows()).toEqual(["pesc"]);
    await esc();
    expect(rows()).toEqual(["pesc"]);
    expect(host.querySelector("[data-board-view]")).not.toBeNull();
  });

  it("Esc keeps the post open while a reply is being typed", async () => {
    await openPost();
    const input = host.querySelector<HTMLInputElement>('[data-board-reply-box="pesc"] input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "half a thought");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await esc(input);
    expect(host.querySelector("article")).not.toBeNull();
    await esc();
    expect(host.querySelector("article")).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await esc();
    expect(host.querySelector("article")).toBeNull();
  });

  it("the back button sits clear of the phone menu badge: no negative margin below md", async () => {
    await openPost();
    const header = host.querySelector("[data-board-view] > div")!;
    const classes: string[] = [];
    for (let node: Element | null = host.querySelector('button[aria-label="Back to Forum"]'); node && node !== header; node = node.parentElement) classes.push(...node.classList);
    expect(classes.filter((name) => name.startsWith("-m"))).toEqual([]);
  });

  it("marks the top reply box while it has focus, like the inline box", async () => {
    await openPost();
    expect(host.querySelector('[data-board-reply-box="pesc"]')!.className).toContain("focus-within:border-accent-border");
  });

  it("an open post's back reads ‹ Forum on the shared back button", async () => {
    await openPost();
    const back = host.querySelector<HTMLButtonElement>("[data-back-button]")!;
    expect(back.textContent).toBe("Forum");
    expect(back.getAttribute("aria-label")).toBe("Back to Forum");
    expect(host.querySelector("h1")).toBeNull();
  });

  it("a post pushes in and pops out like a side panel", async () => {
    reduceMotion(false);
    await openPost();
    const page = host.querySelector<HTMLElement>("[data-side-panel]")!;
    expect(page.contains(host.querySelector("article"))).toBe(true);
    expect([...page.classList]).toEqual(expect.arrayContaining(["max-md:animate-panel-in", "md:animate-panel-slide", "md:*:animate-fade-in"]));
    await act(async () => host.querySelector<HTMLButtonElement>("[data-back-button]")!.click());
    expect(page.hasAttribute("data-closing")).toBe(true);
    expect(host.querySelector('[role="list"] [data-board-post="pesc"]')).not.toBeNull();
    await vi.waitFor(() => expect(host.querySelector("[data-side-panel]")).toBeNull());
    expect(host.querySelector("article")).toBeNull();
  });

  it("slides in from the left like the bot list fold and leaves toward the left", async () => {
    reduceMotion(false);
    await render(BoardView);
    const view = host.querySelector<HTMLElement>("[data-board-view]")!;
    expect([...view.classList]).toEqual(expect.arrayContaining(["md:animate-panel-slide", "[--panel-dx:-28px]"]));
    expect(view.hasAttribute("data-closing")).toBe(false);
    await act(async () => root.render(createElement(I18nProvider, null, createElement(BoardView, { closing: true }))));
    expect(view.hasAttribute("data-closing")).toBe(true);
    expect(view.hasAttribute("inert")).toBe(true);
  });

  it("names the bot and the model it ran from the post, even for a bot this PC does not have", async () => {
    posts = [post("premote", { author_bot_id: "pokkey-sync-id", author: { name: "Pokkey", model: "GPT-6 Astra", color: "peach", mascot_style: "" } })];
    await render(BoardView);
    expect(host.querySelector('[data-board-post="premote"]')!.textContent).toContain("Pokkey");
    expect(host.querySelector('[data-board-post="premote"]')!.textContent).toContain("GPT-6 Astra");
    expect(host.textContent).not.toContain("The bot");
  });

  it("takes the engine mark from the model the post ran, not the engine the bot runs today", async () => {
    mock.state.instances = [
      { instanceId: "codex-1", driverKind: "codex", models: { default: "gpt-6", options: [{ id: "gpt-6", label: "GPT-6" }] } },
      { instanceId: "claude-1", driverKind: "claudeAgent", models: { default: "claude-opus-5-5", options: [{ id: "claude-opus-5-5", label: "Claude Opus 5.5" }] } },
    ];
    posts = [post("pold", { author: { name: "Astra", model: "Claude Opus 5.5", color: "green", mascot_style: "" } })];
    await render(BoardView);
    const mark = (driverKind: string) => {
      const div = document.createElement("div");
      const other = createRoot(div);
      act(() => other.render(createElement(ProviderMark, { driverKind, size: 13 })));
      const html = div.innerHTML;
      act(() => other.unmount());
      return html;
    };
    const shown = host.querySelector('[data-board-post="pold"] [data-board-model] svg')!.outerHTML;
    expect(shown).toBe(mark("claudeAgent"));
    expect(shown).not.toBe(mark("codex"));
  });

  it("sorts by Hot, New and Top", async () => {
    posts = [
      post("pa", { helped_bot_ids: ["astra"], created_at: 3 }),
      post("pb", { helped_bot_ids: ["astra", "carbon", "b3", "b4", "b5"], created_at: 1 }),
      post("pc", { created_at: 2 }),
      ...["r1", "r2", "r3"].map((id, n) => post(id, { parent_id: "pc", created_at: 4 + n })),
    ];
    await render(BoardView);
    expect([...host.querySelectorAll("[data-board-sort]")].map((tab) => tab.textContent)).toEqual(["Hot", "New", "Top"]);
    expect(rows()).toEqual(["pb", "pc", "pa"]);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-board-sort="new"]')!.click());
    expect(rows()).toEqual(["pa", "pc", "pb"]);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-board-sort="top"]')!.click());
    expect(rows()).toEqual(["pb", "pa", "pc"]);
  });

  it("Left and Right move between Hot, New and Top, one tab stop on the chosen one", async () => {
    posts = [post("pa", { created_at: 1 })];
    await render(BoardView);
    const tab = (id: string) => host.querySelector<HTMLButtonElement>(`[data-board-sort="${id}"]`)!;
    const stops = () => [...host.querySelectorAll<HTMLButtonElement>("[data-board-sort]")].map((each) => each.tabIndex);
    expect(stops()).toEqual([0, -1, -1]);
    const press = (key: string) => act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
    tab("hot").focus();
    await press("ArrowRight");
    expect(document.activeElement).toBe(tab("new"));
    expect(tab("new").getAttribute("aria-selected")).toBe("true");
    expect(stops()).toEqual([-1, 0, -1]);
    await press("ArrowLeft");
    await press("ArrowLeft");
    expect(document.activeElement).toBe(tab("top"));
    expect(stops()).toEqual([-1, -1, 0]);
  });

  it("filters by flair and All brings every post back", async () => {
    posts = [post("pfix", { kind: "fix", status: "solved", created_at: 3 }), post("ptip", { kind: "tip", created_at: 2 }), post("pstuck", { created_at: 1 })];
    await render(BoardView);
    const chips = () => [...host.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")];
    expect(chips().map((chip) => chip.textContent)).toEqual(["All", "Fix", "Tip", "Stuck", "Handoff"]);
    const chip = (name: string) => chips().find((button) => button.textContent === name)!;
    await act(async () => chip("Tip").click());
    expect(rows()).toEqual(["ptip"]);
    await act(async () => chip("Handoff").click());
    expect(rows()).toEqual([]);
    await act(async () => chip("All").click());
    expect(rows()).toEqual(["pfix", "ptip", "pstuck"]);
  });

  it("shows a solved post's fix when no reply carries it", async () => {
    posts = [post("pso", { status: "solved", fix: "Run the seed first.", created_at: 1 })];
    await render(BoardView);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-board-post="pso"] button')!.click());
    expect(host.querySelector("[data-board-fix]")!.textContent).toContain("Run the seed first.");
  });

  it("threads a reply to a reply under the reply it answers", async () => {
    posts = [
      post("pop", { kind: "fix", status: "solved", created_at: 1 }),
      post("pr1", { parent_id: "pop", author_bot_id: "carbon", kind: "tip", body: "Commit first.", helped_bot_ids: ["astra"], created_at: 2 }),
      post("pr2", { parent_id: "pr1", kind: "tip", body: "Good call.", created_at: 3 }),
      post("pr3", { parent_id: "pop", kind: "tip", body: "Check the reset time.", created_at: 4 }),
    ];
    await render(BoardView);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-board-post="pop"] button')!.click());
    const reply = (id: string) => host.querySelector(`[data-board-post="${id}"]`)!;
    expect(reply("pr1").contains(reply("pr2"))).toBe(true);
    expect(reply("pr1").contains(reply("pr3"))).toBe(false);
    expect(reply("pr1").textContent).toContain("1 helped");
    expect(reply("pr1").textContent).toContain("Carbon");
  });

  it("chains a reply to its own replies down one thread line, says whom it helped and who is working", async () => {
    mock.state.bots = [{ ...bot("astra", "Astra"), busy: true }, bot("carbon", "Carbon")];
    posts = [
      post("pop", { kind: "stuck", created_at: 1 }),
      post("pr1", { parent_id: "pop", author_bot_id: "carbon", kind: "fix", body: "Commit first.", helped_bot_ids: ["astra"], created_at: 2 }),
      post("pr2", { parent_id: "pr1", kind: "tip", body: "Good call.", created_at: 3 }),
      post("pr3", { parent_id: "pop", author_bot_id: "carbon", kind: "tip", body: "Check the reset time.", created_at: 4 }),
    ];
    await render(BoardView);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-board-post="pop"] button')!.click());
    const chained = (id: string) => host.querySelector(`[data-board-post="${id}"] > div [data-board-chain]`) !== null;
    expect(["pr1", "pr2", "pr3"].map(chained)).toEqual([true, false, false]);
    expect(host.querySelector('[data-board-post="pr1"] [data-board-helped-chip]')!.textContent).toBe("Helped Astra");
    expect(host.querySelector('[data-board-post="pr3"] [data-board-helped-chip]')).toBeNull();
    expect([...host.querySelectorAll("[data-board-flair]")].map((chip) => chip.closest("[data-board-post]")!.getAttribute("data-board-post"))).toEqual(["pop", "pr1"]);
    expect(host.querySelector('[data-board-post="pr2"] [data-board-working]')!.textContent).toBe("Working");
    expect(host.querySelector('[data-board-post="pr3"] [data-board-working]')).toBeNull();
    expect(host.querySelector<HTMLInputElement>('[data-board-reply-box="pop"] input')!.placeholder).toBe("Reply to Astra…");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-board-reply-to="pr3"]')!.click());
    expect(host.querySelector<HTMLInputElement>('[data-board-reply-box="pr3"] input')!.placeholder).toBe("Reply to Carbon…");
  });

  it("fades the replies in one after another down the line, from the motion token", async () => {
    posts = [post("pop", { created_at: 1 }), ...[1, 2, 3, 4, 5, 6].map((n) => post(`pr${n}`, { parent_id: "pop", body: `reply ${n}`, created_at: 1 + n }))];
    await render(BoardView);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-board-post="pop"] button')!.click());
    const delays = [...host.querySelectorAll<HTMLElement>('[role="list"] [data-board-post] > div')].map((row) => row.style.animationDelay);
    expect(delays).toEqual(["", ...[1, 2, 3, 4, 4].map((n) => `calc(var(--motion-fast) * ${n})`)]);
  });

  it("goes back with a plain accent ‹ Forum, no box behind it", async () => {
    posts = [post("pesc", {})];
    await render(BoardView);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-board-post="pesc"] button')!.click());
    const back = host.querySelector<HTMLButtonElement>("[data-back-button]")!;
    expect(back.textContent).toBe("Forum");
    expect(back.className).toContain("text-accent");
    expect(back.className).not.toMatch(/(^|\s)(hover:)?bg-|rounded/);
    expect(back.className).toContain("hover:text-ink");
    expect(back.className).not.toContain("accent-border");
  });

  it("saves the user's reply and shows it as an ordinary row with their name", async () => {
    mock.state.config = { profile: { name: "Edward" } };
    posts = [post("pop", { kind: "tip", created_at: 1 })];
    await render(BoardView);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-board-post="pop"] button')!.click());
    const input = host.querySelector<HTMLInputElement>('[data-board-reply-box="pop"] input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Switching is fine by me.");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLButtonElement>('[data-board-reply-box="pop"] button[type="submit"]')!.click());
    await settle();
    expect(replies).toEqual([{ parent_id: "pop", body: "Switching is fine by me.", client_id: expect.any(String) }]);
    expect(input.value).toBe("");
    await act(async () => window.dispatchEvent(new Event(BOARD_CHANGED_EVENT)));
    await settle();
    expect(rows()).toEqual(["pop", "puser"]);
    expect(host.querySelector('[data-board-post="puser"]')!.textContent).toContain("Edward");
  });

  it("keeps a reply to a reply in its thread", async () => {
    posts = [
      post("phand", { kind: "handoff", title: "Map tests half done", body: "Map tests half done", created_at: 1 }),
      post("pstuck", { parent_id: "phand", author_bot_id: "carbon", title: "Fixture is missing", body: "Fixture is missing", created_at: 2 }),
      post("pfix", { parent_id: "pstuck", kind: "fix", author_bot_id: "user", title: "Fixture is missing", body: "Run seed first", status: "solved", created_at: 3 }),
    ];
    await render(BoardView);
    expect(rows()).toEqual(["phand"]);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-board-post="phand"] button')!.click());
    expect(rows()).toEqual(["phand", "pstuck", "pfix"]);
  });

  it("the user shows nowhere in the Forum from chat copied in: list, post, replies, helped", async () => {
    mock.state.config = { profile: { name: "Edward Yi" } };
    const temps = createTempDirs();
    const board = createBoard({ dir: join(temps.make(join(tmpdir(), "orbit-forum-")), "board"), pcId: () => "home" });
    const stuck = board.post({ author_bot_id: "astra", kind: "stuck", title: "Stuck on the staging deploy", body: "Stuck on the staging deploy", source_ref: "call:ta:0:engine:deploy" });
    board.post({ author_bot_id: BOARD_USER, parent_id: stuck.id, kind: "fix", title: stuck.title, body: "coool it worked", fix: "coool it worked", source_ref: `answer:m1:${stuck.id}` });
    board.post({ author_bot_id: BOARD_USER, kind: "fix", title: "Push the branch", body: "push it to staging now", source_ref: "answer:m2:p0" });
    board.helped([stuck.id], BOARD_USER);
    posts = board.list();
    afterAll(() => temps.remove());
    await render(BoardView);
    expect(rows()).toEqual([stuck.id]);
    expect(host.querySelector("[data-board-helped]")!.getAttribute("data-board-helped")).toBe("0");
    expect(host.textContent).toContain("0 replies");
    await act(async () => host.querySelector<HTMLButtonElement>(`[data-board-post="${stuck.id}"] button`)!.click());
    expect(rows()).toEqual([stuck.id]);
    expect(host.querySelector("[data-board-fix]")).toBeNull();
    // the reply box shows the user's own face; nothing they said in chat shows
    expect([...host.querySelectorAll("article, [role=list]")].map((part) => part.textContent).join(" ")).not.toMatch(/Edward|EY|coool|push it/);
  });

  it("right-click opens the chat's menu: Copy on bot replies, Copy and Delete on any top-level post and the user's own reply", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    posts = [
      post("pbot", { title: "Codex usage limit", body: "Codex usage limit", created_at: 1 }),
      post("pcarbon", { parent_id: "pbot", author_bot_id: "carbon", kind: "tip", body: "Use Claude.", created_at: 2 }),
      post("pmine", { parent_id: "pbot", author_bot_id: "user", kind: "tip", body: "Thanks, worked.", source_ref: "reply:r1", created_at: 3 }),
    ];
    await render(BoardView);
    const menuFor = async (selector: string) => {
      await act(async () => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
      await act(async () => { host.querySelector(selector)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); });
      return [...document.body.querySelectorAll("[data-message-menu] [role=menuitem]")].map((item) => item.textContent);
    };
    expect(await menuFor('[data-board-post="pbot"] button')).toEqual(["Copy", "Delete"]);
    await act(async () => document.body.querySelector<HTMLButtonElement>("[data-menu-copy]")!.click());
    expect(writeText).toHaveBeenCalledWith("Codex usage limit");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-board-post="pbot"] button')!.click());
    expect(await menuFor("article")).toEqual(["Copy", "Delete"]);
    expect(await menuFor('[data-board-post="pcarbon"] [data-board-author]')).toEqual(["Copy"]);
    expect(await menuFor('[data-board-post="pmine"] p')).toEqual(["Copy", "Delete"]);
    await act(async () => document.body.querySelector<HTMLButtonElement>("[data-menu-delete]")!.click());
    await dialogButton("Delete");
    await settle();
    await act(async () => window.dispatchEvent(new Event(BOARD_CHANGED_EVENT)));
    await settle();
    expect(rows()).toEqual(["pbot", "pcarbon"]);
    expect(host.querySelector("article")!.textContent).toContain("1 reply");
    // Escape takes the menu, not the open post
    await menuFor("article");
    await esc();
    expect(host.querySelector("article")).not.toBeNull();
  });

  it("deleting the open post closes it back to the list and takes its replies, even from a stale load", async () => {
    posts = [
      post("pbot", { created_at: 1 }),
      post("pother", { created_at: 2 }),
      post("pmine", { parent_id: "pbot", author_bot_id: "user", kind: "tip", body: "Mine.", source_ref: "reply:r1", created_at: 3 }),
      post("pchild", { parent_id: "pmine", author_bot_id: "carbon", kind: "tip", body: "Child.", created_at: 4 }),
    ];
    const stale = [...posts];
    const ok = globalThis.fetch;
    const deletes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/board/delete") {
        deletes.push(JSON.parse(String(init?.body)).id);
        return json({ posts: [] });
      }
      if (url === "/api/board" && deletes.length) return json({ posts: stale });
      return ok(url, init);
    }));
    await render(BoardView);
    await openRow("pbot");
    expect(host.querySelector("article")).not.toBeNull();
    await act(async () => { host.querySelector("article")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); });
    await act(async () => document.body.querySelector<HTMLButtonElement>("[data-menu-delete]")!.click());
    expect(document.body.querySelector("[role=dialog] h2")!.textContent).toBe("Delete this post?");
    expect(document.body.querySelector("[role=dialog]")!.textContent).toContain("replies");
    await dialogButton("Delete");
    await settle();
    expect(deletes).toEqual(["pbot"]);
    expect(host.querySelector("article")).toBeNull();
    expect(forumKept.openId).toBeNull();
    expect(rows()).toEqual(["pother"]);
    await act(async () => window.dispatchEvent(new Event(BOARD_CHANGED_EVENT)));
    await settle();
    expect(rows()).toEqual(["pother"]);
  });

  it("says so when a delete fails and keeps the reply", async () => {
    posts = [post("pbot", { created_at: 1 }), post("pmine", { parent_id: "pbot", author_bot_id: "user", kind: "tip", body: "Mine.", source_ref: "reply:r1", created_at: 2 })];
    const ok = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => (url === "/api/board/delete" ? new Response("{}", { status: 500 }) : ok(url, init))));
    await render(BoardView);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-board-post="pbot"] button')!.click());
    await act(async () => { host.querySelector('[data-board-post="pmine"] p')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); });
    await act(async () => document.body.querySelector<HTMLButtonElement>("[data-menu-delete]")!.click());
    await dialogButton("Delete");
    await settle();
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("Wink couldn't finish that. Try again.");
    expect(rows()).toEqual(["pbot", "pmine"]);
  });

  it("shows the five engine marks above a friendly line when empty", async () => {
    await render(BoardView);
    const empty = host.querySelector("[data-board-empty]")!;
    expect([...empty.querySelectorAll("[data-board-mark]")].map((mark) => mark.getAttribute("data-board-mark")))
      .toEqual(["claudeAgent", "codex", "grokAgent", "geminiAgent", "museAgent"]);
    expect(empty.querySelectorAll("[data-board-mark] svg")).toHaveLength(5);
    expect(empty.textContent).toBe("Nothing here yet. Your bots post here when they're stuck or find something worth sharing.");
  });

  it("reloads when the Board changes and says so when empty", async () => {
    await render(BoardView);
    expect(host.querySelector("[data-board-empty]")).not.toBeNull();
    posts = [post("pone", {})];
    await act(async () => window.dispatchEvent(new Event(BOARD_CHANGED_EVENT)));
    await settle();
    expect(rows()).toEqual(["pone"]);
  });

  it("the header button opens the Forum with its tooltip", async () => {
    await render(BoardButton);
    const button = host.querySelector<HTMLButtonElement>("[data-board-button]")!;
    expect(button.title).toBe("Forum");
    await act(async () => button.click());
    expect(mock.dispatched).toEqual([{ type: "select", id: FORUM_SELECTION, reveal: true }]);
  });

  it("the header button pressed again closes the Forum and returns to the chat it came from", async () => {
    const press = async () => {
      await render(BoardButton);
      await act(async () => host.querySelector<HTMLButtonElement>("[data-board-button]")!.click());
      // SAFETY: the button dispatches only select actions.
      mock.state.selectedId = (mock.dispatched.at(-1) as { id: string }).id;
    };
    mock.state.selectedId = "carbon";
    await press();
    expect(mock.state.selectedId).toBe(FORUM_SELECTION);
    await press();
    expect(mock.dispatched).toEqual([{ type: "select", id: FORUM_SELECTION, reveal: true }, { type: "select", id: "carbon", reveal: true }]);
    // a Forum restored at launch has no chat behind it: the first bot
    mock.state.selectedId = FORUM_SELECTION;
    await press();
    expect(mock.state.selectedId).toBe("astra");
  });
});
