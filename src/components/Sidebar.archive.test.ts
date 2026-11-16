import "./ProfileFields.test-dom.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { en, ko } from "@/lib/i18n-catalog";
import * as chrome from "@/lib/friends-chrome";
import * as phone from "@/lib/phone-swipe";
import { PRESENCE_EXIT_MS } from "@/lib/use-presence";
import type { Bot, Group } from "@/state/store";

const here = dirname(fileURLToPath(import.meta.url));
const sidebar = ["Sidebar.tsx", "SidebarConversations.tsx"]
  .map((file) => readFileSync(join(here, file), "utf8"))
  .join("\n");

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });

type ApiResult = {
  configured?: boolean;
  syncChats?: boolean;
  folder?: string | null;
  bot?: Partial<Bot> & { id: string; name: string };
  bots?: TrashRow[];
  emptied?: number;
  devices?: [];
};

type TrashRow = { id: string; name: string; color: "green"; daysLeft: number };

type ApiCall = { path: string; method: string; body: string };

const calls: ApiCall[] = [];
let sync = { configured: false, syncChats: false };
let syncAnswer: Promise<void> | null = null;
let bots: Bot[] = [];
let groups: Group[] = [];
let trash: TrashRow[] = [];
const dispatched: Array<{ type: string; botId?: string; id?: string; patch?: unknown }> = [];

function bot(id: string, name: string, hidden: boolean): Bot {
  return {
    id,
    threadId: `t-${id}`,
    name,
    title: "",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "claude", model: "claude", mode: "automatic" },
    messages: [],
    hidden,
  };
}

function textBody(body: BodyInit | null | undefined): string {
  if (body == null || body instanceof Blob || body instanceof FormData || body instanceof URLSearchParams) return "";
  return String(body);
}

// oxlint-disable-next-line anti-slop/no-module-mocking -- The sidebar reads the shared store; this harness only varies bots and profile sync.
vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStoreDispatch: () => () => undefined,
    api: async (path: string, init?: RequestInit): Promise<ApiResult> => {
      calls.push({ path, method: init?.method ?? "GET", body: textBody(init?.body) });
      if (path === "/api/profile-sync") await syncAnswer;
      if (path === "/api/profile-sync") return { configured: sync.configured, syncChats: sync.syncChats, folder: sync.configured ? "D:/Orbit" : null };
      if (path === "/api/devices") return { devices: [] };
      if (path.startsWith("/api/bots/") && init?.method === "PATCH") return { bot: { id: "bo", hidden: false, name: "Bo" } };
      if (path === "/api/bot-trash") return { bots: trash };
      const restored = path.match(/^\/api\/bot-trash\/([\w-]+)\/restore$/);
      if (restored && init?.method === "POST") {
        const row = trash.find((candidate) => candidate.id === restored[1]);
        trash = trash.filter((candidate) => candidate.id !== restored[1]);
        return { bot: bot(restored[1]!, row?.name ?? restored[1]!, false) };
      }
      if (path === "/api/bot-trash/empty" && init?.method === "POST") {
        const emptied = trash.length;
        trash = [];
        return { emptied };
      }
      return {};
    },
    useStore: () => ({
      state: {
        bots,
        groups,
        selectedId: "ada",
        instances: [],
        routineRuns: [],
        terminalAttention: {},
        terminalPanes: {},
        config: {
          composio: { configured: false },
          box: { configured: false },
          vps: { configured: false, sshAlias: "" },
          rooms: { turnTimeoutMinutes: 5 },
          localVm: { mode: "shared", maxInstances: 1 },
          profile: { name: "Eddie", email: "" },
        },
        mascotMotion: null,
      },
      dispatch: (action: (typeof dispatched)[number]) => dispatched.push(action),
      refreshInstances: async () => undefined,
    }),
  };
});

// oxlint-disable-next-line anti-slop/no-module-mocking -- The update banner needs a desktop bridge this test does not open.
vi.mock("@/lib/updater", () => ({
  useUpdaterState: () => null,
  useManualCheck: () => ({ acknowledged: true, check: () => undefined }),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- Desktop capability probes need a packaged host.
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({
    capabilities: {
      host: { platform: "win32", homeDir: "C:/Users/eddie" },
      toasts: { available: false },
      localComputer: { available: false, support: "unsupported" },
    },
    ready: true,
  }),
}));

import { Sidebar } from "./Sidebar";

function buttonByText(label: string, root: ParentNode = document): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((node) => {
    const text = node.textContent?.trim() ?? "";
    return text === label || text.startsWith(label) || node.getAttribute("aria-label") === label;
  });
  if (!(found instanceof HTMLButtonElement)) throw new Error(`button "${label}" missing`);
  return found;
}

async function renderSidebar() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(Sidebar, { open: true, onClose: () => undefined })));
  });
  return { host, root };
}

async function openMenu(name: string) {
  const row = [...document.querySelectorAll("[role='button']")].find((node) => node.textContent?.includes(name));
  if (!(row instanceof HTMLElement)) throw new Error(`row ${name} missing`);
  await act(async () => {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 }));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  calls.length = 0;
  dispatched.length = 0;
  sync = { configured: false, syncChats: false };
  syncAnswer = null;
  bots = [];
  groups = [];
  trash = [];
  localStorage.setItem("omb-locale", "en");
});

describe("decluttered sidebar menus", () => {
  it.each([[false, false, true], [true, false, false], [true, true, true]])("shows the collapse control with phone=%s and restore=%s: %s", async (isPhone, restore, visible) => {
    vi.spyOn(phone, "isPhone").mockReturnValue(isPhone);
    vi.spyOn(chrome, "showPhoneDrawerCollapse").mockReturnValue(restore);
    const { host, root } = await renderSidebar();
    try {
      expect(Boolean(host.querySelector('button[title="Collapse sidebar to avatars"]'))).toBe(visible);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each([false, true])("renders bot, group and New menus with visibility flags %s", async (visible) => {
    vi.spyOn(chrome, "showBotMenuCopy").mockReturnValue(visible);
    vi.spyOn(chrome, "showNewMenuExport").mockReturnValue(visible);
    bots = [{ ...bot("ada", "Ada", false), pinned: true, chiefOfStaff: true }];
    groups = [{ id: "team", threadId: "team-thread", name: "Team", memberIds: ["ada"], defaultResponder: { kind: "member", botId: "ada" }, bulletin: "", createdAt: 0, messages: [], unread: false }];
    const { root } = await renderSidebar();
    try {
      await openMenu("Ada");
      const menu = document.querySelector("[data-bot-menu]")!;
      const labels = [...menu.querySelectorAll("button")].map((node) => node.textContent);
      expect(labels).toEqual(visible
        ? ["Unpin", "Remove Chief of Staff", "Move to section", "Mark as Unread", "Edit Profile", "Make a copy", "Archive", "Delete"]
        : ["Unpin", "Remove Chief of Staff", "Move to section", "Mark as Unread", "Edit Profile", "Archive", "Delete"]);
      await act(async () => buttonByText("New or share").click());
      expect(document.body.textContent?.includes("Export all bots")).toBe(visible);
      expect(document.body.textContent?.includes("Teams")).toBe(false);
      expect(buttonByText("New bot")).not.toBeNull();
      expect(buttonByText("New group")).not.toBeNull();
      await act(async () => {
        document.querySelector('[data-sidebar-row-id="team"] button')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 60, clientY: 60 }));
      });
      const room = document.querySelector("[data-room-menu]")!;
      expect([...room.querySelectorAll("button")].map((node) => node.textContent)).toEqual(["Pin", "Rename Team", "Move to section", "Delete group"]);
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("New menu with the phone drawer", () => {
  it("is closed after the drawer closes and opens again", async () => {
    const { host, root } = await renderSidebar();
    const draw = (open: boolean) =>
      act(async () => {
        root.render(createElement(I18nProvider, null, createElement(Sidebar, { open, onClose: () => undefined })));
      });
    const settle = () => act(() => new Promise<void>((done) => setTimeout(done, PRESENCE_EXIT_MS + 60)));
    try {
      expect(en["chrome.newBot"]).toBe("New bot");
      expect(ko["chrome.newBot"]).toBe("새 봇");
      await act(async () => buttonByText("New or share").click());
      expect(buttonByText("New group", host)).toBeDefined();
      await draw(false);
      await settle();
      await draw(true);
      expect([...host.querySelectorAll("button")].some((node) => node.textContent === "New group")).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("stays open while the desktop sidebar is shown without a drawer", async () => {
    const { host, root } = await renderSidebar();
    try {
      await act(async () => root.render(createElement(I18nProvider, null, createElement(Sidebar, { open: false, onClose: () => undefined }))));
      await act(async () => buttonByText("New or share").click());
      await act(() => new Promise<void>((done) => setTimeout(done, PRESENCE_EXIT_MS + 60)));
      expect(buttonByText("New group", host)).toBeDefined();
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("bot archive from its menu", () => {
  it("offers Archive in the menu and keeps restore behind the archived entry", () => {
    expect(en["chrome.deleteBotBody"]).toBe(
      "{name} moves to Recently deleted with its chats, memory and files. You can restore it for 30 days. After that it is deleted for good.",
    );
    expect(en["chrome.deleteBotBodyAllPcs"]).toBe(
      "{name} moves to Recently deleted on all your PCs, with its chats, memory and files. You can restore it for 30 days. After that it is deleted for good.",
    );
    expect(ko["chrome.deleteBotBody"]).toBe("{name} 봇을 대화, 메모리, 파일과 함께 '최근 삭제한 봇'으로 옮깁니다. 30일 동안 복원할 수 있고, 그 뒤에는 완전히 삭제됩니다.");
    expect(ko["chrome.deleteBotBodyAllPcs"]).toBe(
      "{name} 봇을 대화, 메모리, 파일과 함께 모든 PC에서 '최근 삭제한 봇'으로 옮깁니다. 30일 동안 복원할 수 있고, 그 뒤에는 완전히 삭제됩니다.",
    );
    expect(sidebar).toContain('t("chrome.archive")');
    expect(ko["chrome.archive"]).toBe("보관");
    expect(sidebar).toContain("archivedBots.length > 0");
    expect(sidebar).toContain("JSON.stringify({ hidden: false })");
    expect(sidebar).toContain('deleteReach === "every-pc" ? "chrome.deleteBotBodyAllPcs" : "chrome.deleteBotBody"');
  });

  it("hides Archived bots at zero, shows it at one, and restore unhides that bot", async () => {
    bots = [bot("ada", "Ada", false), bot("bo", "Bo", true)];
    const { root } = await renderSidebar();
    try {
      expect(document.querySelector('[aria-label="Archive Ada"]')).toBeNull();
      await openMenu("Ada");
      const menu = document.querySelector("[data-bot-menu]");
      if (!(menu instanceof HTMLElement)) throw new Error("menu missing");
      expect(buttonByText("Archive", menu)).toBeTruthy();
      expect(buttonByText("Delete", menu)).toBeTruthy();

      await act(async () => {
        buttonByText("New or share").click();
      });
      await act(async () => {
        buttonByText("Archived bots").click();
      });
      await act(async () => {
        buttonByText("Restore").click();
      });
      expect(calls.some((call) => call.path === "/api/bots/bo" && call.method === "PATCH" && call.body.includes('"hidden":false'))).toBe(true);

      bots = [bot("ada", "Ada", false)];
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(Sidebar, { open: true, onClose: () => undefined })));
      });
      await act(async () => {
        buttonByText("New or share").click();
      });
      expect([...document.querySelectorAll("button")].some((node) => node.textContent?.includes("Archived bots"))).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("archives the open bot with the hidden patch and opens the next one", async () => {
    bots = [bot("ada", "Ada", false), bot("bo", "Bo", false)];
    const { root } = await renderSidebar();
    try {
      await openMenu("Ada");
      await act(async () => buttonByText("Archive", document.querySelector("[data-bot-menu]")!).click());
      expect(dispatched).toEqual([
        { type: "updateBot", botId: "ada", patch: { hidden: true } },
        { type: "select", id: "bo" },
      ]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("blocks Archive for the Chief of Staff and for the last active bot", async () => {
    bots = [{ ...bot("ada", "Ada", false), chiefOfStaff: true }, bot("bo", "Bo", false)];
    const { root } = await renderSidebar();
    try {
      await openMenu("Ada");
      expect(buttonByText("Archive", document.querySelector("[data-bot-menu]")!).disabled).toBe(true);
      await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      await act(() => new Promise<void>((done) => setTimeout(done, PRESENCE_EXIT_MS + 60)));
      bots = [bot("ada", "Ada", false)];
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(Sidebar, { open: true, onClose: () => undefined })));
      });
      await openMenu("Ada");
      expect(buttonByText("Archive", document.querySelector("[data-bot-menu]")!).disabled).toBe(true);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps the bot menu closed after it fades out", async () => {
    bots = [bot("ada", "Ada", false)];
    const { root } = await renderSidebar();
    try {
      await openMenu("Ada");
      expect(document.querySelector("[data-bot-menu]")).not.toBeNull();
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      await act(() => new Promise<void>((done) => setTimeout(done, PRESENCE_EXIT_MS + 60)));
      expect(document.querySelector("[data-bot-menu]")).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("says a delete reaches every PC only when profile sync is on", async () => {
    bots = [bot("ada", "Ada", false)];
    sync = { configured: true, syncChats: true };
    const first = await renderSidebar();
    try {
      await openMenu("Ada");
      await act(async () => {
        buttonByText("Delete", document.querySelector("[data-bot-menu]") ?? document).click();
      });
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("on all your PCs");
      });
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });

      sync = { configured: true, syncChats: false };
      await openMenu("Ada");
      await act(async () => {
        buttonByText("Delete", document.querySelector("[data-bot-menu]") ?? document).click();
      });
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Ada moves to Recently deleted with its chats, memory and files.");
      });
      expect(document.body.textContent).not.toContain("on all your PCs");
    } finally {
      await act(async () => first.root.unmount());
    }

    localStorage.setItem("omb-locale", "ko");
    sync = { configured: true, syncChats: true };
    const second = await renderSidebar();
    try {
      await openMenu("Ada");
      await act(async () => {
        buttonByText("삭제", document.querySelector("[data-bot-menu]") ?? document).click();
      });
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Ada 봇을 대화, 메모리, 파일과 함께 모든 PC에서 '최근 삭제한 봇'으로 옮깁니다.");
      });
    } finally {
      await act(async () => second.root.unmount());
    }
  });

  it("opens the delete confirm before the sync check answers", async () => {
    bots = [bot("ada", "Ada", false)];
    sync = { configured: true, syncChats: true };
    let answer: (() => void) | undefined;
    syncAnswer = new Promise((resolve) => {
      answer = resolve;
    });
    const view = await renderSidebar();
    try {
      await openMenu("Ada");
      await act(async () => {
        buttonByText("Delete", document.querySelector("[data-bot-menu]") ?? document).click();
      });
      expect(document.body.textContent).toContain("Ada moves to Recently deleted with its chats, memory and files.");
      await act(async () => answer?.());
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("on all your PCs");
      });
    } finally {
      await act(async () => view.root.unmount());
    }
  });
});

const trashRow = (id: string, name: string, daysLeft: number): TrashRow => ({ id, name, color: "green", daysLeft });
const dialog = () => document.querySelector("[role='dialog']") as HTMLElement;

async function openRecentlyDeleted() {
  await act(async () => buttonByText("New or share").click());
  await vi.waitFor(() => expect(buttonByText("Recently deleted")).toBeTruthy());
  await act(async () => buttonByText("Recently deleted").click());
  await vi.waitFor(() => expect(dialog()?.textContent).toContain("Bots stay here for 30 days."));
}

describe("Recently deleted", () => {
  it("pins the trash strings in en and ko", () => {
    expect([en["chrome.recentlyDeleted"], ko["chrome.recentlyDeleted"]]).toEqual(["Recently deleted", "최근 삭제한 봇"]);
    expect([en["chrome.botTrashed"], ko["chrome.botTrashed"]]).toEqual(["{name} moved to Recently deleted", "{name} 최근 삭제한 봇으로 이동됨"]);
    expect([en["chrome.emptyNow"], ko["chrome.emptyNow"]]).toEqual(["Empty now", "지금 비우기"]);
    expect([en["chrome.deleteForGood"], ko["chrome.deleteForGood"]]).toEqual(["Delete for good", "완전히 삭제"]);
    expect([en["chrome.trashDaysLeftOne"], ko["chrome.trashDaysLeftOne"]]).toEqual(["1 day left", "1일 남음"]);
  });

  it("hides the row at zero and shows it with its count under Archived bots", async () => {
    bots = [bot("ada", "Ada", false), bot("bo", "Bo", true)];
    trash = [trashRow("atlas", "Atlas", 23)];
    const first = await renderSidebar();
    try {
      await act(async () => buttonByText("New or share").click());
      await vi.waitFor(() => expect(buttonByText("Recently deleted").textContent).toBe("Recently deleted1"));
      const labels = [...document.querySelectorAll("button")].map((node) => node.textContent ?? "");
      expect(labels.findIndex((text) => text.startsWith("Recently deleted"))).toBe(labels.findIndex((text) => text.startsWith("Archived bots")) + 1);
    } finally {
      await act(async () => first.root.unmount());
    }
    trash = [];
    const second = await renderSidebar();
    try {
      await act(async () => buttonByText("New or share").click());
      await act(() => new Promise<void>((done) => setTimeout(done, 20)));
      expect([...document.querySelectorAll("button")].some((node) => node.textContent?.includes("Recently deleted"))).toBe(false);
    } finally {
      await act(async () => second.root.unmount());
    }
  });

  it("lists twelve bots with days left, shortens a long name and keeps every Restore", async () => {
    bots = [bot("ada", "Ada", false)];
    const long = "A bot with a very long name that cannot fit on one phone line at all";
    trash = [trashRow("b0", long, 23), trashRow("b1", "Nova", 1), ...Array.from({ length: 10 }, (_, i) => trashRow(`c${i}`, `Bot ${i}`, 30))];
    const view = await renderSidebar();
    try {
      await openRecentlyDeleted();
      const panel = dialog();
      expect(panel.textContent).toContain("12 deleted");
      expect(panel.textContent).toContain("23 days left");
      expect(panel.textContent).toContain("1 day left");
      expect([...panel.querySelectorAll("button")].filter((node) => node.textContent === "Restore")).toHaveLength(12);
      const name = [...panel.querySelectorAll("div")].find((node) => node.textContent === long)!;
      expect(name.className).toContain("truncate");
    } finally {
      await act(async () => view.root.unmount());
    }
  });

  it("restores one bot, selects it and says it is restored", async () => {
    bots = [bot("ada", "Ada", false)];
    trash = [trashRow("atlas", "Atlas", 23), trashRow("nova", "Nova", 1)];
    const view = await renderSidebar();
    try {
      await openRecentlyDeleted();
      await act(async () => buttonByText("Restore", dialog()).click());
      expect(calls.some((call) => call.path === "/api/bot-trash/atlas/restore" && call.method === "POST")).toBe(true);
      expect(dispatched).toContainEqual(expect.objectContaining({ type: "botPatched" }));
      expect(dispatched).toContainEqual({ type: "select", id: "atlas" });
      await vi.waitFor(() => expect(document.body.textContent).toContain("Atlas restored"));
      await vi.waitFor(() => expect(dialog()?.textContent).toContain("1 deleted"));
    } finally {
      await act(async () => view.root.unmount());
    }
  });

  it("asks before Empty now with Cancel focused, then empties and closes", async () => {
    bots = [bot("ada", "Ada", false)];
    trash = [trashRow("atlas", "Atlas", 23), trashRow("nova", "Nova", 1)];
    const view = await renderSidebar();
    try {
      await openRecentlyDeleted();
      await act(async () => buttonByText("Empty now", dialog()).click());
      await vi.waitFor(() => expect(document.body.textContent).toContain("Empty Recently deleted?"));
      expect(document.body.textContent).toContain("This deletes 2 bots for good, with all their chats, their memory and the files in their folders.");
      expect(document.activeElement?.textContent).toBe("Cancel");
      expect(calls.some((call) => call.path === "/api/bot-trash/empty")).toBe(false);
      await act(async () => buttonByText("Delete for good").click());
      expect(calls.some((call) => call.path === "/api/bot-trash/empty" && call.method === "POST")).toBe(true);
      await act(() => new Promise<void>((done) => setTimeout(done, PRESENCE_EXIT_MS + 60)));
      expect(document.body.textContent).not.toContain("Bots stay here for 30 days.");
    } finally {
      await act(async () => view.root.unmount());
    }
  });

  it("moves a deleted bot to Recently deleted with an Undo note", async () => {
    bots = [bot("ada", "Ada", false), bot("bo", "Bo", false)];
    const view = await renderSidebar();
    try {
      await openMenu("Ada");
      await act(async () => buttonByText("Delete", document.querySelector("[data-bot-menu]")!).click());
      await act(async () => buttonByText("Delete", dialog()).click());
      expect(dispatched).toContainEqual({ type: "deleteBot", botId: "ada" });
      await vi.waitFor(() => expect(document.body.textContent).toContain("Ada moved to Recently deleted"));
      trash = [trashRow("ada", "Ada", 30)];
      await act(async () => buttonByText("Undo").click());
      expect(calls.some((call) => call.path === "/api/bot-trash/ada/restore" && call.method === "POST")).toBe(true);
      expect(dispatched).toContainEqual({ type: "select", id: "ada" });
    } finally {
      await act(async () => view.root.unmount());
    }
  });

  it("reads in Korean", async () => {
    localStorage.setItem("omb-locale", "ko");
    bots = [bot("ada", "Ada", false)];
    trash = [trashRow("atlas", "Atlas", 23)];
    const view = await renderSidebar();
    try {
      await act(async () => buttonByText("새로 만들기 또는 공유").click());
      await vi.waitFor(() => expect(buttonByText("최근 삭제한 봇")).toBeTruthy());
      await act(async () => buttonByText("최근 삭제한 봇").click());
      await vi.waitFor(() => expect(dialog()?.textContent).toContain("봇은 30일 동안 여기에 보관됩니다."));
      expect(dialog().textContent).toContain("삭제한 봇 1개");
      expect(dialog().textContent).toContain("23일 남음");
      expect(buttonByText("지금 비우기", dialog())).toBeTruthy();
    } finally {
      await act(async () => view.root.unmount());
    }
  });
});
