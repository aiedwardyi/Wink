// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Page {
  hits: ReturnType<typeof hit>[];
  more: boolean;
}

const mock = vi.hoisted(() => ({ landed: new Array<string>(), asked: new Array<string>(), answers: new Array<(body: Page) => void>(), dispatch: () => {} }));

const hit = (messageId: string) => ({ threadId: "t", messageId, at: 1, role: "bot", kind: "text", snippet: "q", matchStart: 0, matchLength: 1, matches: 1 });

// oxlint-disable-next-line anti-slop/no-module-mocking -- the bar talks to the API and the store; this test answers each request by hand.
vi.mock("@/state/store", () => ({
  // the store's dispatch is stable, as useReducer's is
  useStore: () => ({ state: {}, dispatch: mock.dispatch }),
  api: (path: string) => {
    mock.asked.push(path);
    return new Promise<Page>((resolve) => { mock.answers.push(resolve); });
  },
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- landing scrolls the real transcript; only the call is recorded.
vi.mock("@/lib/focus-message", () => ({
  landOnSearchHit: async (found: { messageId: string }) => { mock.landed.push(found.messageId); },
  restoreChatChrome: () => {},
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- pins the default (chips) skin.
vi.mock("@/lib/skins", () => ({ useSkin: () => "precision", isTerminalSkin: () => false }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- keys and their values stand in for strings.
vi.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: (key: string, values?: { current: number; total: number | string }) => (values ? `${key} ${values.current}/${values.total}` : key) }) }));

import { ChatFindBar } from "./ChatFindBar";

let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await act(async () => root?.unmount());
  root = null;
  mock.landed.length = 0;
  mock.asked.length = 0;
  mock.answers.length = 0;
  document.body.innerHTML = "";
});

async function open(initialMessageId: string | null = null) {
  const host = document.body.appendChild(document.createElement("main"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(ChatFindBar, { threadId: "t", initialQuery: "q", initialMessageId, onClose: () => {} })));
  // the bar asks after its debounce
  await act(async () => vi.waitFor(() => expect(mock.asked).not.toHaveLength(0)));
  const label = () => host.querySelector("[data-chat-find] span")?.textContent;
  const answer = async (body: Page) => act(async () => mock.answers.shift()!(body));
  return { label, answer };
}

const rest = Array.from({ length: 99 }, (_, i) => hit(`m${i + 1}`));

describe("ChatFindBar first hit", () => {
  it("lands on the newest hit before the rest of the page, then counts the whole page", async () => {
    const { label, answer } = await open();
    expect(mock.asked).toEqual(["/api/search?q=q&limit=1&threadId=t&view=chips"]);
    await answer({ hits: [hit("m0")], more: true });
    expect(mock.landed).toEqual(["m0"]);
    expect(label()).toBe("find.searching");
    expect(mock.asked[1]).toBe("/api/search?q=q&limit=99&threadId=t&view=chips&before=m0");
    await answer({ hits: rest, more: true });
    expect(mock.landed).toEqual(["m0"]);
    expect(label()).toBe("find.of 1/100+");
  });

  it("asks once when the chat has one hit", async () => {
    const { label, answer } = await open();
    await answer({ hits: [hit("m0")], more: false });
    expect(mock.asked).toHaveLength(1);
    expect(mock.landed).toEqual(["m0"]);
    expect(label()).toBe("find.of 1/1");
  });

  it("waits for the rest of the page when the clicked row is further back", async () => {
    const { answer } = await open("m5");
    await answer({ hits: [hit("m0")], more: true });
    expect(mock.landed).toEqual([]);
    await answer({ hits: rest, more: false });
    expect(mock.landed).toEqual(["m5"]);
  });
});
