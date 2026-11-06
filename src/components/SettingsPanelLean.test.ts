// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { PRESENCE_EXIT_MS } from "@/lib/use-presence";
import type { Bot, Task, TaskResumePacket } from "@/state/store";

const { mockDispatch, mockConfig } = vi.hoisted(() => ({ mockDispatch: vi.fn(), mockConfig: { current: {} as { features?: { memoryNotes?: boolean } } } }));
const chrome = vi.hoisted(() => ({ voiceAndStartupSettings: false }));
const keepGoing = vi.hoisted(() => ({ request: 0 }));

vi.mock("@/lib/friends-chrome", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/friends-chrome")>()),
  showBotVoiceAndStartupSettings: () => chrome.voiceAndStartupSettings,
}));

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: {
        instances: [
          {
            instanceId: "claude",
            driverKind: "claudeAgent",
            displayName: "Claude",
            snapshot: { state: "available", authenticated: true, version: "1.0.13" },
            models: { default: "claude-3-5-sonnet", options: [{ id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet" }] },
            capabilities: {},
          },
        ],
        bots: [],
        config: mockConfig.current,
        mascotMotion: null,
        settingsKeepGoingRequest: keepGoing.request,
      },
      dispatch: mockDispatch,
      refreshInstances: async () => undefined,
    }),
  };
});

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({
    capabilities: {
      host: { platform: "other", homeDir: undefined },
      toasts: { available: false },
      localComputer: { available: false, support: "unsupported" },
    },
    ready: true,
  }),
}));

vi.mock("./VoiceSettings", () => ({
  VoiceSettings: () => null,
}));

vi.mock("./BotProfileAvatarCard", () => ({
  BotProfileAvatarCard: () => null,
}));

vi.mock("./LocalComputerAutoWarning", () => ({
  LocalComputerAutoWarning: ({ open }: { open: boolean }) => (open ? createElement("div", { "data-local-warning": "" }) : null),
}));

import { SettingsPanel } from "./SettingsPanel";

const claudeBot = {
  id: "bot-1",
  threadId: "t1",
  name: "Friend",
  title: "",
  description: "",
  notifications: false,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "claude", model: "claude-3-5-sonnet", mode: "automatic" },
  messages: [],
} as Bot;

const memoryRow = (host: HTMLElement) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")).find((button) => button.textContent?.includes("Memory File"))!;
const tab = (host: HTMLElement, label: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((button) => button.textContent === label)!;
const shown = (node: Element | null | undefined) => Boolean(node && !node.closest("[hidden]"));
const topicsRow = (host: HTMLElement) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")).find((button) => button.textContent?.startsWith("Topic Files"))!;

describe("SettingsPanel lean startup switch", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    mockDispatch.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    (window as any).ogb = {};
    chrome.voiceAndStartupSettings = true;
  });

  afterEach(() => {
    chrome.voiceAndStartupSettings = false;
    root.unmount();
    host.remove();
  });

  it("off saves leanStartup true", async () => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: claudeBot })));
    });
    const toggle = host.querySelector('button[aria-label="Load Skills & Plugins"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      (toggle as HTMLButtonElement)?.click();
    });
    expect(mockDispatch).toHaveBeenCalledWith({
      type: "updateBot",
      botId: "bot-1",
      patch: { leanStartup: true },
    });
  });

  it("on saves leanStartup false", async () => {
    await act(async () => {
      root.render(
        createElement(I18nProvider, null, createElement(SettingsPanel, { bot: { ...claudeBot, leanStartup: true } })),
      );
    });
    const toggle = host.querySelector('button[aria-label="Load Skills & Plugins"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      (toggle as HTMLButtonElement)?.click();
    });
    expect(mockDispatch).toHaveBeenCalledWith({
      type: "updateBot",
      botId: "bot-1",
      patch: { leanStartup: false },
    });
  });
});

describe("SettingsPanel approval pill", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const option = (label: string) =>
    Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Approval"] button')).find(
      (button) => button.textContent === label,
    )!;

  beforeEach(() => {
    mockDispatch.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    root.unmount();
    host.remove();
  });

  it("shows Ask for an unset bot outside Advanced and switches to Auto", async () => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: claudeBot })));
    });
    expect(option("Ask").getAttribute("aria-checked")).toBe("true");
    expect(option("Auto").getAttribute("aria-checked")).toBe("false");
    expect(host.querySelector('[aria-label="Auto mode"]')).toBeNull();
    await act(async () => option("Auto").click());
    expect(mockDispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "bot-1", patch: { autoApprove: true } });
  });

  it("switches an Auto bot back to Ask", async () => {
    await act(async () => {
      root.render(
        createElement(I18nProvider, null, createElement(SettingsPanel, { bot: { ...claudeBot, autoApprove: true } as Bot })),
      );
    });
    expect(option("Auto").getAttribute("aria-checked")).toBe("true");
    await act(async () => option("Ask").click());
    expect(mockDispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "bot-1", patch: { autoApprove: false } });
  });

  it("warns before Auto on a bot that drives this computer", async () => {
    await act(async () => {
      root.render(
        createElement(I18nProvider, null, createElement(SettingsPanel, { bot: { ...claudeBot, computer: "local" } as Bot })),
      );
    });
    await act(async () => option("Auto").click());
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(host.querySelector("[data-local-warning]")).not.toBeNull();
  });
});

describe("SettingsPanel memory and order", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ text: "likes tea", truncated: false, topics: [] }))),
    );
  });

  afterEach(() => {
    root.unmount();
    host.remove();
    vi.unstubAllGlobals();
  });

  it("loads memory on mount and shows the editor on tap", async () => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: claudeBot })));
    });
    expect(host.textContent).toContain("1 line");
    await act(async () => memoryRow(host).click());
    const box = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Memory"]');
    expect(box?.value).toBe("likes tea");
  });

  it("shows Auto notes in the memory card, on by default, and saves it on the bot", async () => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: claudeBot })));
    });
    const toggle = host.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Auto Notes"]')!;
    expect(host.textContent).toContain("Saves facts from chat to Memory.");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(shown(toggle)).toBe(false);
    await act(async () => tab(host, "Memory").click());
    expect(shown(toggle)).toBe(true);
    await act(async () => toggle.click());
    expect(mockDispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "bot-1", patch: { memoryNotes: false } });
  });

  it("follows the global switch until the bot has its own", async () => {
    mockConfig.current = { features: { memoryNotes: false } };
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: claudeBot })));
      });
      const toggle = () => host.querySelector('button[aria-label="Auto Notes"]')!;
      expect(toggle().getAttribute("aria-checked")).toBe("false");
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: { ...claudeBot, memoryNotes: true } })));
      });
      expect(toggle().getAttribute("aria-checked")).toBe("true");
    } finally {
      mockConfig.current = {};
    }
  });

  it("labels Auto notes in Korean", async () => {
    localStorage.setItem("omb-locale", "ko");
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: claudeBot })));
      });
      expect(host.querySelector('button[role="switch"][aria-label="자동 메모"]')).not.toBeNull();
      expect(host.textContent).toContain("채팅 속 사실을 메모리에 저장해요.");
    } finally {
      localStorage.removeItem("omb-locale");
    }
  });

  it("orders the detail rows down to the terminal share", async () => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: { ...claudeBot, shareTerminalWithChat: true } })));
    });
    const text = host.textContent ?? "";
    const order = ["Title", "Description", "Project Folder", "Approval", "Notifications", "Terminal Access", "Off for chat-only bots."];
    const at = order.map((label) => text.indexOf(label));
    expect(at).not.toContain(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("uses the Settings switch for every switch in both tabs", async () => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: { ...claudeBot, shareTerminalWithChat: true } })));
    });
    const switches = Array.from(host.querySelectorAll('[role="switch"]'));
    expect(switches.map((each) => each.getAttribute("aria-label"))).toEqual(["Bot Notifications", "Terminal Access", "Agentic Mode", "Auto Notes"]);
    for (const each of switches) expect(each.className).toContain("h-6 w-11");
  });
});

describe("SettingsPanel memory groups", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const memory = [
    "# Memory",
    "- Ships to review-base, never main",
    "- Uses Windows (noted 2026-10-26)",
    "- Prefers pnpm (noted 2026-10-27)",
    "- Short answers (noted 2026-10-28)",
    "- Works late (noted 2026-10-29)",
    "- Likes Servo (noted 2026-10-30)",
    "- Lives in Seoul (noted 2026-11-01)",
  ].join("\n");
  const packet: TaskResumePacket = {
    v: 1,
    threadId: "t1",
    botId: "bot-1",
    goal: "Cut release 1.0.225",
    plan: [{ step: "Build", status: "done" }, { step: "Tag", status: "active" }, { step: "Publish", status: "pending" }],
    completed: [],
    evidence: [],
    artifacts: [],
    blockers: [],
    nextAction: "Tag the release",
    updatedAt: 0,
    updatedBy: "bot",
    flushReason: "turn-end",
    turnsAtWrite: 1,
  };
  const tasks: Task[] = [{ threadId: "t1", title: "Release", createdAt: 0, taskState: packet }];
  const render = async (value: Bot) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ text: memory, truncated: false, topics: [] }))));
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: value })));
    });
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    root.unmount();
    host.remove();
    localStorage.removeItem("omb-locale");
    vi.unstubAllGlobals();
  });

  it("puts noted facts first, then the task and the memory file", async () => {
    await render({ ...claudeBot, tasks });
    const text = host.textContent ?? "";
    const order = ["Lives in Seoul", "+1 more", "Auto Notes", "Current Task", "Memory File", "8 lines"];
    expect(text).not.toContain("From Your Chats");
    const at = order.map((label) => text.indexOf(label));
    expect(at).not.toContain(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toContain("Prefers pnpm");
    expect(text).not.toContain("Uses Windows");
    expect(text).toContain("1 of 3 steps done");
    expect(text).toContain("Next: Tag the release");
    expect(host.querySelector("textarea[aria-label=\"Memory\"]")).toBeNull();
  });

  it("opens the memory file on tap and closes it again", async () => {
    await render(claudeBot);
    const row = memoryRow(host);
    expect(row.getAttribute("aria-expanded")).toBe("false");
    await act(async () => row.click());
    expect(host.querySelector<HTMLTextAreaElement>("textarea[aria-label=\"Memory\"]")?.value).toBe(memory);
    expect(host.textContent).toContain("Loads at the start of every chat.");
    await act(async () => row.click());
    expect(row.getAttribute("aria-expanded")).toBe("false");
    // the file folds away on the shared motion, then unmounts
    await act(async () => { await new Promise((done) => setTimeout(done, PRESENCE_EXIT_MS + 40)); });
    expect(host.querySelector("textarea[aria-label=\"Memory\"]")).toBeNull();
  });

  it("hides the task when there is none", async () => {
    await render(claudeBot);
    const text = host.textContent ?? "";
    expect(text).toContain("Memory File");
    expect(text).not.toContain("Current Task");
  });

  it("opens on Settings and keeps memory in its own tab", async () => {
    await render({ ...claudeBot, tasks });
    const tabs = Array.from(host.querySelectorAll('[role="tab"]')).map((node) => [node.textContent, node.getAttribute("aria-selected")]);
    expect(tabs).toEqual([["Settings", "true"], ["Memory", "false"]]);
    const folder = Array.from(host.querySelectorAll("div")).find((node) => node.textContent === "Project Folder");
    expect(shown(folder)).toBe(true);
    expect(shown(memoryRow(host))).toBe(false);
    await act(async () => tab(host, "Memory").click());
    expect(tab(host, "Memory").getAttribute("aria-selected")).toBe("true");
    expect(shown(memoryRow(host))).toBe(true);
    expect(shown(folder)).toBe(false);
    expect(host.textContent).not.toContain("Memory fills in as you chat.");
  });

  it("shows one line under a brain for a bot with no memory yet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ text: "", truncated: false, topics: [] }))));
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: claudeBot })));
    });
    await act(async () => tab(host, "Memory").click());
    const empty = Array.from(host.querySelectorAll("div")).find((node) => node.textContent === "Memory fills in as you chat.");
    expect(shown(empty)).toBe(true);
    expect(empty?.querySelector("svg.lucide-brain")).not.toBeNull();
    expect(memoryRow(host).textContent).toBe("Memory FileLoads at the start of every chat.");
    expect(shown(host.querySelector('button[aria-label="Auto Notes"]'))).toBe(true);
    await act(async () => memoryRow(host).click());
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Memory"]')?.readOnly).toBe(false);
  });

  it("skips the empty state when a task or a topic file exists", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ text: "", truncated: false, topics: [] }))));
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: { ...claudeBot, tasks } })));
    });
    expect(host.textContent).toContain("Current Task");
    expect(host.textContent).not.toContain("Memory fills in as you chat.");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ text: "", truncated: false, topics: [{ name: "phone.md", bytes: 900 }] }))));
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { key: "topics", bot: claudeBot })));
    });
    expect(topicsRow(host).textContent).toContain("1 file");
    expect(host.textContent).not.toContain("Memory fills in as you chat.");
  });

  it("goes back to Settings when the Agentic Mode mark asks for its row", async () => {
    const scrolled: Element[] = [];
    const spy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    try {
      await render(claudeBot);
      await act(async () => tab(host, "Memory").click());
      keepGoing.request = 1;
      await render(claudeBot);
      expect(tab(host, "Settings").getAttribute("aria-selected")).toBe("true");
      const row = host.querySelector("[data-settings-keep-going]");
      expect(shown(row)).toBe(true);
      expect(scrolled).toEqual([row]);
    } finally {
      keepGoing.request = 0;
      spy.mockRestore();
    }
  });

  it("labels the tabs and the empty state in Korean", async () => {
    localStorage.setItem("omb-locale", "ko");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ text: "", truncated: false, topics: [] }))));
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: claudeBot })));
    });
    expect(Array.from(host.querySelectorAll('[role="tab"]')).map((node) => node.textContent)).toEqual(["설정", "메모리"]);
    expect(host.textContent).toContain("대화하면서 메모리가 채워져요.");
  });

  it("labels the groups in Korean", async () => {
    localStorage.setItem("omb-locale", "ko");
    await render({ ...claudeBot, tasks });
    const text = host.textContent ?? "";
    expect(text).not.toContain("채팅에서");
    for (const label of ["메모리 파일", "8줄", "+1개 더", "현재 작업", "3단계 중 1단계 완료", "다음: Tag the release"]) {
      expect(text).toContain(label);
    }
  });
});

interface Put {
  url: string;
  text: string;
  base?: string;
  keepalive?: boolean;
  response?: Response;
  resolve: (response: Response) => void;
}

describe("SettingsPanel memory autosave", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let puts: Put[];
  let held: boolean;
  let served: Record<string, string>;

  const ok = (text: string) => new Response(JSON.stringify({ ok: true, truncated: false, revision: `r:${text}` }));
  const render = async (id: string) => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: { ...claudeBot, id, threadId: `t-${id}` } })));
    });
    // the memory file opens collapsed; a conflict opens it on its own
    if (!host.querySelector("textarea[aria-label=\"Memory\"]")) {
      await act(async () => memoryRow(host).click());
    }
  };
  const box = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Memory"]')!;
  const status = () => box().closest(".relative.flex.flex-col.gap-3")?.querySelector('[role="status"]')?.textContent ?? "";
  const notice = () => host.querySelector('[role="alert"]')?.firstElementChild?.textContent ?? "";
  const button = (label: string) => Array.from(host.querySelectorAll("button")).find((each) => each.textContent === label)!;
  const topic = (name: string) => host.querySelector<HTMLButtonElement>(`button[data-topic="${name}"]`)!;
  const stored = (id: string) => JSON.parse(localStorage.getItem(`omb-memory-draft:${id}`) ?? "null");
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box(), value);
      box().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const wait = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const land = async (put: Put, response = put.response ?? ok(put.text)) => {
    await act(async () => {
      put.resolve(response);
      await vi.advanceTimersByTimeAsync(0);
    });
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mockDispatch.mockClear();
    puts = [];
    held = false;
    served = {};
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          const { text, baseRevision } = JSON.parse(String(init.body));
          return new Promise<Response>((resolve) => {
            const put = { url, text, base: baseRevision, keepalive: init.keepalive, resolve };
            puts.push(put);
            if (!held) resolve(ok(text));
          });
        }
        if (url.includes("/memory/topics/")) return new Response(JSON.stringify({ name: "prefs.md", text: "tea" }));
        const id = url.split("/")[3];
        const text = served[id] ?? `notes for ${id}`;
        return new Response(JSON.stringify({ text, truncated: false, revision: `r:${text}`, topics: [{ name: "prefs.md", bytes: 3 }] }));
      }),
    );
  });

  afterEach(async () => {
    act(() => root.unmount());
    // drafts and saves outlive a panel, so settle them before the next test
    for (let i = 0; i < puts.length; i++) await land(puts[i]);
    localStorage.clear();
    host.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("has no Save button under the memory editor", async () => {
    await render("bot-1");
    const buttons = Array.from(box().parentElement!.querySelectorAll("button"));
    expect(buttons.map((button) => button.textContent)).not.toContain("Save");
  });

  it("puts the latest text once after typing pauses", async () => {
    await render("bot-1");
    await type("likes tea");
    await wait(500);
    await type("likes tea and jazz");
    await wait(799);
    expect(puts).toHaveLength(0);
    await wait(1);
    expect(puts.map((put) => [put.url, put.text])).toEqual([["/api/bots/bot-1/memory", "likes tea and jazz"]]);
    await wait(5000);
    expect(puts).toHaveLength(1);
  });

  it("saves at once on blur", async () => {
    await render("bot-1");
    await type("likes tea");
    await act(async () => {
      box().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(puts.map((put) => put.text)).toEqual(["likes tea"]);
  });

  it("saves at once when the page hides", async () => {
    await render("bot-1");
    await type("likes tea");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(puts.map((put) => put.text)).toEqual(["likes tea"]);
  });

  it("saves to its own bot when unmounted mid-pause", async () => {
    await render("bot-1");
    await type("likes tea");
    act(() => root.unmount());
    expect(puts.map((put) => [put.url, put.text])).toEqual([["/api/bots/bot-1/memory", "likes tea"]]);
    root = createRoot(host);
  });

  it("never writes one bot's text into another bot on a switch", async () => {
    await render("bot-1");
    await type("bot one notes");
    await render("bot-2");
    expect(box().value).toBe("notes for bot-2");
    await wait(5000);
    expect(puts.map((put) => [put.url, put.text])).toEqual([["/api/bots/bot-1/memory", "bot one notes"]]);
  });

  it("writes nothing without an edit", async () => {
    await render("bot-1");
    await act(async () => {
      box().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await act(async () => topicsRow(host).click());
    await act(async () => topic("prefs.md").click());
    expect(topic("prefs.md").parentElement?.textContent).toContain("tea");
    await act(async () => topic("prefs.md").click());
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await render("bot-2");
    await wait(5000);
    act(() => root.unmount());
    root = createRoot(host);
    expect(puts).toHaveLength(0);
  });

  it("keeps the editor and the topic list while a topic file is open", async () => {
    await render("bot-1");
    await act(async () => topicsRow(host).click());
    expect(topicsRow(host).getAttribute("aria-expanded")).toBe("true");
    await act(async () => topic("prefs.md").click());
    expect(topic("prefs.md").getAttribute("aria-expanded")).toBe("true");
    expect(topic("prefs.md").parentElement?.textContent).toContain("tea");
    expect(box().value).toBe("notes for bot-1");
    expect(Array.from(host.querySelectorAll("button")).map((each) => each.textContent)).not.toContain("Back");
    await act(async () => topic("prefs.md").click());
    expect(topic("prefs.md").getAttribute("aria-expanded")).toBe("false");
    expect(topic("prefs.md").parentElement?.textContent).not.toContain("tea");
  });

  it.each([false, true])("ignores stale topic responses and errors (error: %s)", async (fail) => {
    const serve = vi.mocked(fetch).getMockImplementation()!;
    const pending: Array<(response: Response) => void> = [];
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes("/memory/topics/")) return new Promise<Response>((resolve) => pending.push(resolve));
      const response = await serve(url, init);
      const memory = await response.json();
      return Response.json({ ...memory, topics: [{ name: "prefs.md", bytes: 3 }, { name: "work.md", bytes: 4 }] });
    });
    await render("bot-1");
    await act(async () => topicsRow(host).click());
    await act(async () => topic("prefs.md").click());
    await act(async () => topic("work.md").click());
    await act(async () => pending[1](Response.json({ name: "work.md", text: "code" })));
    const stale = () => fail ? Response.json({ error: "old topic failed" }, { status: 500 }) : Response.json({ name: "prefs.md", text: "tea" });
    await act(async () => pending[0](stale()));
    expect(topic("work.md").getAttribute("aria-expanded")).toBe("true");
    expect(topic("work.md").parentElement?.textContent).toContain("code");
    expect(topic("prefs.md").getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector(".text-danger")).toBeNull();
    await act(async () => topic("prefs.md").click());
    await act(async () => topic("work.md").click());
    await act(async () => pending[2](stale()));
    expect(topic("work.md").getAttribute("aria-expanded")).toBe("false");
    expect(topic("prefs.md").getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector(".text-danger")).toBeNull();
  });

  it("brings a topic file into view when it opens", async () => {
    const scrolled: Element[] = [];
    const spy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    try {
      await render("bot-1");
      await act(async () => topicsRow(host).click());
      expect(scrolled).toEqual([]);
      await act(async () => topic("prefs.md").click());
      expect(scrolled).toEqual([topic("prefs.md").parentElement]);
      expect(scrolled[0]?.textContent).toContain("tea");
    } finally {
      spy.mockRestore();
    }
  });

  it("brings the Memory File back into view when it closes", async () => {
    const scrolled: Element[] = [];
    const spy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    try {
      await render("bot-1");
      expect(scrolled).toEqual([]);
      await act(async () => memoryRow(host).click());
      expect(memoryRow(host).getAttribute("aria-expanded")).toBe("false");
      // its header, which stays put while the file folds away below it
      expect(scrolled).toEqual([memoryRow(host).parentElement]);
    } finally {
      spy.mockRestore();
    }
  });

  it("grows the editor to its text instead of scrolling inside it", async () => {
    const owner = (name: string) => {
      let proto: object | null = HTMLTextAreaElement.prototype;
      while (proto && !Object.getOwnPropertyDescriptor(proto, name)) proto = Object.getPrototypeOf(proto);
      return proto as HTMLTextAreaElement;
    };
    const width = vi.spyOn(owner("clientWidth"), "clientWidth", "get").mockReturnValue(320);
    const height = vi.spyOn(owner("scrollHeight"), "scrollHeight", "get").mockReturnValue(900);
    try {
      await render("bot-1");
      expect(box().style.height).toBe("900px");
      expect(box().className).toContain("overflow-hidden");
      expect(box().className).toContain("resize-none");
      const description = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Description"]')!;
      expect(description.style.height).toBe("900px");
    } finally {
      width.mockRestore();
      height.mockRestore();
    }
  });

  it("refits Description after a post-open font override", async () => {
    let contentHeight = 185;
    const width = vi.spyOn(HTMLTextAreaElement.prototype, "clientWidth", "get").mockReturnValue(323);
    const height = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(() => contentHeight);
    const ready = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", { configurable: true, value: Object.assign(new EventTarget(), { ready: Promise.resolve() }) });
    try {
      const description = "Quarterly Research Synthesis Assistant 분기별 리서치 종합 도우미 " + "X".repeat(80) + " Research 한국어 메모. ".repeat(8);
      await act(async () => root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: { ...claudeBot, description } }))));
      const area = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Description"]')!;
      expect(area.style.height).toBe("185px");
      contentHeight = 206;
      await act(async () => {
        area.style.fontFamily = "Verdana";
        window.dispatchEvent(new Event("resize"));
      });
      expect(area.style.height).toBe("206px");
      expect(area.className).toContain("overflow-hidden");
    } finally {
      width.mockRestore();
      height.mockRestore();
      if (ready) Object.defineProperty(document, "fonts", ready);
      else Reflect.deleteProperty(document, "fonts");
    }
  });

  it("keeps newer text unsaved when an older write lands", async () => {
    held = true;
    await render("bot-1");
    await type("likes tea");
    await wait(800);
    expect(puts.map((put) => put.text)).toEqual(["likes tea"]);
    await type("likes tea and jazz");
    await land(puts[0]);
    expect(status()).toBe("Saving…");
    await wait(800);
    expect(puts.map((put) => put.text)).toEqual(["likes tea", "likes tea and jazz"]);
    await land(puts[1]);
    expect(status()).toBe("Saved");
  });

  it("sends text typed during a write in the next write", async () => {
    held = true;
    await render("bot-1");
    await type("likes tea");
    await wait(800);
    await type("likes tea and jazz");
    await wait(800);
    expect(puts).toHaveLength(1);
    await land(puts[0]);
    expect(puts.map((put) => put.text)).toEqual(["likes tea", "likes tea and jazz"]);
  });

  it("keeps the text and shows the message when a write fails", async () => {
    held = true;
    await render("bot-cap");
    await type("x".repeat(40));
    await wait(800);
    await land(puts[0], new Response(JSON.stringify({ error: "memory is capped at 256KB" }), { status: 400 }));
    expect(box().value).toBe("x".repeat(40));
    expect(host.querySelector(".text-danger")?.textContent).toBe("Memory is full. Move some notes into separate memory files.");
    expect(status()).toBe("");
    await type("x".repeat(20));
    await wait(800);
    expect(puts.map((put) => put.text)).toEqual(["x".repeat(40), "x".repeat(20)]);
  });

  it("retries a failed write on the next blur and on close", async () => {
    held = true;
    const down = () => new Response(JSON.stringify({ error: "offline" }), { status: 503 });
    await render("bot-retry");
    await type("likes tea");
    await wait(800);
    await land(puts[0], down());
    await wait(5000);
    expect(puts).toHaveLength(1);
    await act(async () => {
      box().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(puts.map((put) => put.text)).toEqual(["likes tea", "likes tea"]);
    await land(puts[1], down());
    act(() => root.unmount());
    root = createRoot(host);
    expect(puts.map((put) => put.text)).toEqual(["likes tea", "likes tea", "likes tea"]);
  });

  it("saves on pagehide with a write that outlives the page", async () => {
    await render("bot-1");
    await type("likes tea");
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(puts.map((put) => [put.text, put.keepalive])).toEqual([["likes tea", true]]);
  });

  it("drops keepalive for memory over 64 KB", async () => {
    await render("bot-1");
    await type("메".repeat(22_000));
    await wait(800);
    expect(puts.map((put) => put.keepalive)).toEqual([false]);
  });

  it("reports a write that fails after the panel closed", async () => {
    held = true;
    await render("bot-closed");
    await type("likes tea");
    act(() => root.unmount());
    root = createRoot(host);
    await land(puts[0], new Response(JSON.stringify({ error: "disk full" }), { status: 500 }));
    expect(mockDispatch).toHaveBeenCalledWith({ type: "error", message: "disk full" });
  });

  it("brings back a write that failed after the panel closed and saves it", async () => {
    held = true;
    await render("bot-reopen");
    await type("likes tea");
    act(() => root.unmount());
    root = createRoot(host);
    await land(puts[0], new Response(JSON.stringify({ error: "offline" }), { status: 503 }));
    await render("bot-reopen");
    expect(box().value).toBe("likes tea");
    expect(status()).toBe("Saving…");
    await wait(800);
    expect(puts.map((put) => [put.url, put.text])).toEqual([
      ["/api/bots/bot-reopen/memory", "likes tea"],
      ["/api/bots/bot-reopen/memory", "likes tea"],
    ]);
    await land(puts[1]);
    expect(status()).toBe("Saved");
    act(() => root.unmount());
    root = createRoot(host);
    await render("bot-reopen");
    expect(box().value).toBe("notes for bot-reopen");
  });

  it("brings back a failed write only to its own bot after a switch", async () => {
    held = true;
    await render("bot-away");
    await type("likes tea");
    await render("bot-2");
    await land(puts[0], new Response(JSON.stringify({ error: "offline" }), { status: 503 }));
    expect(box().value).toBe("notes for bot-2");
    await render("bot-away");
    expect(box().value).toBe("likes tea");
    await wait(800);
    expect(puts.map((put) => [put.url, put.text])).toEqual([
      ["/api/bots/bot-away/memory", "likes tea"],
      ["/api/bots/bot-away/memory", "likes tea"],
    ]);
    await land(puts[1]);
  });

  it("shows the conflict for a failed write when the memory changed since", async () => {
    held = true;
    const down = () => new Response(JSON.stringify({ error: "offline" }), { status: 503 });
    await render("bot-moved");
    await type("likes tea");
    act(() => root.unmount());
    root = createRoot(host);
    await land(puts[0], down());
    served["bot-moved"] = "likes coffee";
    await render("bot-moved");
    expect(box().value).toBe("likes tea");
    expect(notice()).toBe("This memory changed somewhere else.");
    expect(status()).toBe("");
    await wait(5000);
    expect(puts).toHaveLength(1);
    await act(async () => button("Load Latest").click());
    expect(box().value).toBe("likes coffee");
    await type("likes coffee and jazz");
    act(() => root.unmount());
    root = createRoot(host);
    await land(puts[1], down());
    await render("bot-moved");
    expect(box().value).toBe("likes coffee and jazz");
    await wait(800);
    await land(puts[2]);
    expect(puts.map((put) => [put.text, put.base])).toEqual([
      ["likes tea", "r:notes for bot-moved"],
      ["likes coffee and jazz", "r:likes coffee"],
      ["likes coffee and jazz", "r:likes coffee"],
    ]);
  });

  it("shows Saving then Saved then nothing", async () => {
    held = true;
    await render("bot-1");
    expect(status()).toBe("");
    await type("likes tea");
    expect(status()).toBe("Saving…");
    await wait(800);
    expect(status()).toBe("Saving…");
    await land(puts[0]);
    expect(status()).toBe("Saved");
    await wait(2000);
    expect(status()).toBe("");
  });

  // the server's own MEMORY.md read and compare-and-write behind fetch; a held save has already written
  const files = async () => {
    const workspace = await import("../../server/workspace.ts");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const id = url.split("/")[3];
        if (init?.method !== "PUT") return new Response(JSON.stringify({ ...workspace.readMemoryFile(id), topics: [] }));
        const { text, baseRevision } = JSON.parse(String(init.body));
        const saved = workspace.saveMemoryFile(id, text, baseRevision);
        const response = saved.conflict
          ? new Response(JSON.stringify({ error: "conflict", text: saved.text, revision: saved.revision }), { status: 409 })
          : new Response(JSON.stringify({ ok: true, truncated: saved.truncated, revision: saved.revision }));
        return new Promise<Response>((resolve) => {
          puts.push({ url, text, base: baseRevision, keepalive: init.keepalive, response, resolve });
          if (!held) resolve(response);
        });
      }),
    );
    return workspace;
  };

  it("refuses a save over memory that changed on disk and keeps the edit", async () => {
    const { readMemoryFile, writeMemoryFile } = await files();
    writeMemoryFile("bot-remote", "base memory");
    await render("bot-remote");
    writeMemoryFile("bot-remote", "newer remote memory");
    await type("base memory plus local edit");
    await wait(800);
    expect(readMemoryFile("bot-remote").text).toBe("newer remote memory");
    expect(box().value).toBe("base memory plus local edit");
    expect(notice()).toBe("This memory changed somewhere else.");
    expect(status()).toBe("");
    await type("base memory plus more");
    await wait(5000);
    expect(puts).toHaveLength(1);
  });

  it("never lets a closed panel's queued save overwrite a newer edit after reopening", async () => {
    held = true;
    const { readMemoryFile, writeMemoryFile } = await files();
    writeMemoryFile("bot-requeue", "base memory");
    await render("bot-requeue");
    await type("old in flight");
    await wait(800);
    await type("old queued");
    act(() => root.unmount());
    root = createRoot(host);
    await render("bot-requeue");
    await type("newer edit after reopen");
    await wait(800);
    await land(puts[0]);
    await land(puts[1]);
    expect(readMemoryFile("bot-requeue").text).toBe("newer edit after reopen");
    expect(box().value).toBe("newer edit after reopen");
    expect(status()).toBe("Saved");
    expect(puts.map((put) => put.text)).toEqual(["old in flight", "newer edit after reopen"]);
  });

  it("keeps the latest edit stored when the page closes during a save", async () => {
    held = true;
    await render("bot-pagehide");
    await type("old in flight");
    await wait(800);
    await type("latest draft");
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(puts.map((put) => put.text)).toEqual(["old in flight"]);
    expect(stored("bot-pagehide")).toEqual({ text: "latest draft", base: "r:notes for bot-pagehide" });
    await land(puts[0]);
    expect(stored("bot-pagehide")).toEqual({ text: "latest draft", base: "r:old in flight" });
  });

  it("saves a stored draft quietly after a reload when the memory is unchanged", async () => {
    held = true;
    localStorage.setItem("omb-memory-draft:bot-reload", JSON.stringify({ text: "likes tea", base: "r:notes for bot-reload" }));
    await render("bot-reload");
    expect(box().value).toBe("likes tea");
    expect(status()).toBe("Saving…");
    expect(notice()).toBe("");
    expect(puts.map((put) => [put.text, put.base])).toEqual([["likes tea", "r:notes for bot-reload"]]);
    await land(puts[0]);
    expect(status()).toBe("Saved");
    expect(stored("bot-reload")).toBeNull();
  });

  it("shows the conflict for a stored draft made from older memory", async () => {
    localStorage.setItem("omb-memory-draft:bot-stale", JSON.stringify({ text: "likes tea", base: "r:older notes" }));
    await render("bot-stale");
    expect(box().value).toBe("likes tea");
    expect(notice()).toBe("This memory changed somewhere else.");
    expect(status()).toBe("");
    await wait(5000);
    expect(puts).toHaveLength(0);
    expect(stored("bot-stale")).toEqual({ text: "likes tea", base: "r:older notes" });
  });

  it("Load latest drops the edit and shows the file", async () => {
    const { readMemoryFile, writeMemoryFile } = await files();
    writeMemoryFile("bot-latest", "base memory");
    await render("bot-latest");
    writeMemoryFile("bot-latest", "newer remote memory");
    await type("my edit");
    await wait(800);
    await act(async () => button("Load Latest").click());
    expect(box().value).toBe("newer remote memory");
    expect(notice()).toBe("");
    expect(stored("bot-latest")).toBeNull();
    expect(readMemoryFile("bot-latest").text).toBe("newer remote memory");
    await type("newer remote memory plus mine");
    await wait(800);
    expect(readMemoryFile("bot-latest").text).toBe("newer remote memory plus mine");
    expect(status()).toBe("Saved");
  });

  it("Keep mine saves the edit over the file", async () => {
    const { readMemoryFile, writeMemoryFile } = await files();
    writeMemoryFile("bot-mine", "base memory");
    await render("bot-mine");
    writeMemoryFile("bot-mine", "newer remote memory");
    await type("my edit");
    await wait(800);
    await act(async () => button("Keep Mine").click());
    expect(readMemoryFile("bot-mine").text).toBe("my edit");
    expect(box().value).toBe("my edit");
    expect(notice()).toBe("");
    expect(status()).toBe("Saved");
    expect(stored("bot-mine")).toBeNull();
  });

  it("re-reads memory on focus or return with nothing unsaved", async () => {
    await render("bot-fresh");
    served["bot-fresh"] = "written by the bot";
    await act(async () => {
      box().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(box().value).toBe("written by the bot");
    served["bot-fresh"] = "synced from the other PC";
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(box().value).toBe("synced from the other PC");
    await type("my edit");
    served["bot-fresh"] = "newest";
    await act(async () => {
      box().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(box().value).toBe("my edit");
    await wait(800);
    expect(puts.map((put) => [put.text, put.base])).toEqual([["my edit", "r:synced from the other PC"]]);
  });

  it("ignores a focus read that a save overtook", async () => {
    const { readMemoryFile, writeMemoryFile } = await files();
    writeMemoryFile("bot-overtaken", "base notes");
    await render("bot-overtaken");
    const before = { ...readMemoryFile("bot-overtaken"), topics: [] };
    let reply: (response: Response) => void = () => undefined;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((resolve) => (reply = resolve)));
    await act(async () => {
      box().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    await type("base notes plus saved edit");
    await wait(800);
    expect(status()).toBe("Saved");
    await act(async () => reply(new Response(JSON.stringify(before))));
    expect(box().value).toBe("base notes plus saved edit");
    await type("base notes plus another edit");
    await wait(800);
    expect(notice()).toBe("");
    expect(readMemoryFile("bot-overtaken").text).toBe("base notes plus another edit");
  });

  it("keeps the editor read-only until memory loads, with a Retry", async () => {
    const { readMemoryFile, writeMemoryFile } = await files();
    writeMemoryFile("bot-offline", "important synced notes");
    const serve = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async () => {
      throw new Error("offline");
    });
    await render("bot-offline");
    expect(box().readOnly).toBe(true);
    expect(host.querySelector(".text-danger")?.firstChild?.textContent).toBe("Couldn't load memory.");
    vi.mocked(fetch).mockImplementation(serve);
    await act(async () => button("Retry").click());
    expect(box().readOnly).toBe(false);
    expect(box().value).toBe("important synced notes");
    expect(host.querySelector(".text-danger")).toBeNull();
    expect(readMemoryFile("bot-offline").text).toBe("important synced notes");
  });

  it("treats a 409 without the latest memory as a failed write", async () => {
    held = true;
    await render("bot-bad-409");
    await type("likes tea");
    await wait(800);
    await land(puts[0], new Response(JSON.stringify({ error: "conflict" }), { status: 409 }));
    expect(box().value).toBe("likes tea");
    expect(host.querySelector(".text-danger")?.textContent).toBe("conflict");
    expect(notice()).toBe("");
    expect(stored("bot-bad-409")).toEqual({ text: "likes tea", base: "r:notes for bot-bad-409" });
    await type("likes tea and jazz");
    await wait(800);
    expect(puts.map((put) => [put.text, put.base])).toEqual([
      ["likes tea", "r:notes for bot-bad-409"],
      ["likes tea and jazz", "r:notes for bot-bad-409"],
    ]);
  });

  it("Load latest reads the file again, or uses the conflict's copy when that read fails", async () => {
    const { writeMemoryFile } = await files();
    writeMemoryFile("bot-moving", "base memory");
    await render("bot-moving");
    writeMemoryFile("bot-moving", "newer remote memory");
    await type("my edit");
    await wait(800);
    writeMemoryFile("bot-moving", "newest remote memory");
    await act(async () => button("Load Latest").click());
    expect(box().value).toBe("newest remote memory");
    writeMemoryFile("bot-moving", "remote again");
    await type("my second edit");
    await wait(800);
    const serve = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (init?.method !== "PUT") throw new Error("offline");
      return serve(url, init);
    });
    await act(async () => button("Load Latest").click());
    expect(box().value).toBe("remote again");
    expect(notice()).toBe("");
  });
});
