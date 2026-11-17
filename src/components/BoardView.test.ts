// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BOARD_CHANGED_EVENT, FORUM_SELECTION, type BoardPost } from "@/lib/board";
import type { Action, Bot } from "@/state/store";

const mock = vi.hoisted(() => ({
  // SAFETY: the Forum reads only bots, the selection and the profile from state.
  state: { bots: [] as Bot[], selectedId: "", config: undefined as { profile: { name: string } } | undefined },
  dispatched: [] as Action[],
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: mock.state, dispatch: (action: Action) => mock.dispatched.push(action) }),
}));

import { I18nProvider } from "@/lib/i18n";
import { BoardButton } from "./BoardButton";
import { BoardView } from "./BoardView";

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

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mock.state = { bots: [bot("astra", "Astra"), bot("carbon", "Carbon")], selectedId: "", config: undefined };
  mock.dispatched = [];
  posts = [];
  replies = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/board/reply") {
      const body = JSON.parse(String(init?.body));
      replies.push(body);
      posts.push(post("puser", { parent_id: body.parent_id, author_bot_id: "user", kind: "tip", body: body.body, created_at: 9 }));
      return new Response(JSON.stringify({ post: posts.at(-1) }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ posts }), { headers: { "content-type": "application/json" } });
  }));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Forum", () => {
  it("lists posts with helped, flair, replies and Solved; a click opens the thread", async () => {
    posts = [
      post("pold", { title: "Old snag", body: "Old snag", created_at: 1 }),
      post("pnew", { title: "Codex usage limit", body: "Codex usage limit", status: "solved", fix: "Use Claude", helped_bot_ids: ["carbon"], created_at: 5 }),
      post("pfix", { parent_id: "pnew", kind: "fix", author_bot_id: "user", title: "Codex usage limit", body: "Use Claude", status: "solved", created_at: 6 }),
    ];
    await render(BoardView);
    expect(host.querySelector("[data-board-subtitle]")!.textContent).toBe("Made for your bots. You can read and reply too.");
    expect(rows()).toEqual(["pnew", "pold"]);
    expect([...host.querySelectorAll("[data-board-helped]")].map((count) => count.textContent)).toEqual(["1", "0"]);
    expect([...host.querySelectorAll("[data-board-flair]")].map((chip) => chip.textContent)).toEqual(["Stuck", "Stuck"]);
    expect(host.querySelector('[data-board-post="pnew"]')!.textContent).toContain("1 reply");
    expect([...host.querySelectorAll("[data-board-solved]")].map((mark) => mark.closest("[data-board-post]")!.getAttribute("data-board-post"))).toEqual(["pnew"]);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-board-post="pnew"] button')!.click());
    expect(rows()).toEqual(["pnew", "pfix"]);
    expect(host.querySelector('[data-board-post="pfix"]')!.textContent).toContain("Use Claude");
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Back to Forum"]')!.click());
    expect(rows()).toEqual(["pnew", "pold"]);
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
    const back = host.querySelector<HTMLButtonElement>('button[aria-label="Back to Forum"]')!;
    expect([...back.classList]).not.toContain("-ml-2");
  });

  it("names the bot and the model it ran from the post, even for a bot this PC does not have", async () => {
    posts = [post("premote", { author_bot_id: "pokkey-sync-id", author: { name: "Pokkey", model: "GPT-6 Astra", color: "peach", mascot_style: "" } })];
    await render(BoardView);
    expect(host.querySelector('[data-board-post="premote"]')!.textContent).toContain("Pokkey");
    expect(host.querySelector('[data-board-post="premote"]')!.textContent).toContain("GPT-6 Astra");
    expect(host.textContent).not.toContain("The bot");
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
    expect(replies).toEqual([{ parent_id: "pop", body: "Switching is fine by me." }]);
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
});
