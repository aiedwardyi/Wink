// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BOARD_CHANGED_EVENT, FORUM_SELECTION, type BoardPost } from "@/lib/board";
import type { Action, Bot } from "@/state/store";

const mock = vi.hoisted(() => ({
  // SAFETY: the Forum reads only bots and the selection from state.
  state: { bots: [] as Bot[], selectedId: "" },
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
  mock.state = { bots: [bot("astra", "Astra"), bot("carbon", "Carbon")], selectedId: "" };
  mock.dispatched = [];
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ posts }), { headers: { "content-type": "application/json" } })));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Forum", () => {
  it("lists posts newest first with status, used-by and replies behind a click", async () => {
    posts = [
      post("pold", { title: "Old snag", body: "Old snag", created_at: 1 }),
      post("pnew", { title: "Codex usage limit", body: "Codex usage limit", status: "solved", fix: "Use Claude", helped_bot_ids: ["carbon"], created_at: 5 }),
      post("pfix", { parent_id: "pnew", kind: "fix", author_bot_id: "user", title: "Codex usage limit", body: "Use Claude", status: "solved", created_at: 6 }),
    ];
    await render(BoardView);
    expect(rows()).toEqual(["pnew", "pold"]);
    expect([...host.querySelectorAll("[data-board-status]")].map((chip) => chip.textContent)).toEqual(["Solved", "Open"]);
    expect(host.querySelector("[data-board-used-by]")!.textContent).toBe("Used by @Carbon");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-board-post="pnew"] button')!.click());
    expect(rows()).toEqual(["pnew", "pfix"]);
    expect(host.querySelector('[data-board-post="pfix"]')!.textContent).toContain("Use Claude");
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Back to Forum"]')!.click());
    expect(rows()).toEqual(["pnew", "pold"]);
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
