import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Action, Bot, Group, InstanceInfo } from "@/state/store";

const { mockState, dispatched } = vi.hoisted(() => ({
  // SAFETY: the test fixture stores only the app's bot and instance collections.
  mockState: { value: { bots: [] as Bot[], instances: [] as InstanceInfo[] } },
  // SAFETY: the mock dispatch receives the app's Action union.
  dispatched: [] as Action[],
}));

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: mockState.value,
      dispatch: (action: Action) => dispatched.push(action),
      refreshInstances: () => Promise.resolve(),
    }),
  };
});

const group: Group = {
  id: "group-1",
  threadId: "thread-1",
  name: "Channel",
  memberIds: [],
  defaultResponder: { kind: "everyone" },
  bulletin: "",
  unread: false,
  createdAt: 0,
  messages: [],
};

describe("ManageMembersPanel Korean title", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "omb-locale" ? "ko" : null),
      setItem: () => {},
      removeItem: () => {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockState.value = { bots: [], instances: [] };
    dispatched.length = 0;
  });

  it("renders the members title in Korean", async () => {
    const { ManageMembersPanel } = await import("./ManageMembersPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(ManageMembersPanel, {
        group,
        onClose: () => undefined,
        triggerRef: { current: null },
      })),
    );
    expect(html).toContain("구성원 관리");
    expect(html).toContain("first-letter:uppercase");
    expect(html).toContain("Channel의 구성원 관리");
    expect(html).toContain("data-manage-create-bot");
    expect(html).toContain("+ 새 봇");
    expect(html).not.toContain(">Manage Members<");
    expect(html).not.toContain("Manage members of Channel");
  });

  it.each([
    ["en", "Name your bot", "For example, Researcher", "Save"],
    ["ko", "봇 이름 짓기", "예: 리서처", "저장"],
  ] as const)("adds a named bot with an explicit model selection in %s", async (locale, label, placeholder, saveLabel) => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "omb-locale" ? locale : null),
      setItem: () => {},
      removeItem: () => {},
    });
    const existing: Bot = {
      id: "existing",
      threadId: "existing-thread",
      name: "Ada",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "codex-1", model: "codex-default" },
      messages: [],
    };
    const created: Bot = { ...existing, id: "created", threadId: "created-thread", name: "research Desk v2 / Seoul HQ" };
    const codex: InstanceInfo = {
      instanceId: "codex-1",
      driverKind: "codex",
      displayName: "Codex",
      snapshot: { state: "available", authenticated: true },
      models: {
        default: "codex-default",
        options: [
          { id: "codex-default", label: "Codex Default" },
          { id: "codex-pro", label: "Codex Pro" },
        ],
      },
    };
    mockState.value = { bots: [existing], instances: [codex] };
    const calls: Array<{ body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push({ body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ bot: created }), { status: 201 });
      }),
    );
    const group: Group = {
      id: "group-1",
      threadId: "thread-1",
      name: "Channel",
      memberIds: [existing.id],
      defaultResponder: { kind: "everyone" },
      bulletin: "",
      unread: false,
      createdAt: 0,
      messages: [],
      section: "Work",
    };
    const { ManageMembersPanel } = await import("./ManageMembersPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(I18nProvider, null, createElement(ManageMembersPanel, {
        group,
        onClose: () => undefined,
        triggerRef: { current: null },
      }))));
      await act(async () => host.querySelector<HTMLButtonElement>("[data-manage-create-bot]")!.click());
      const name = host.querySelector<HTMLInputElement>('input[id^="group-wizard-name-"]');
      const selects = [...host.querySelectorAll("select")];
      if (!(name instanceof HTMLInputElement)) throw new Error("group add name field did not render");
      expect(host.querySelector(`label[for="${name.id}"]`)?.textContent).toBe(label);
      expect(name.placeholder).toBe(placeholder);
      expect(name.maxLength).toBe(40);
      expect(selects).toHaveLength(2);
      expect([...selects[1]!.options].map((option) => option.value)).toEqual(["codex-default", "codex-pro"]);

      await act(async () => {
        const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        inputSetter.call(name, "  research Desk v2 / Seoul HQ  ");
        name!.dispatchEvent(new Event("input", { bubbles: true }));
        const selectSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
        selectSetter.call(selects[1], "codex-pro");
        selects[1]!.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const add = [...host.querySelectorAll("button")].find(
        (button) =>
          !button.hasAttribute("data-manage-create-bot") &&
          (button.textContent?.includes("Add bot") || button.textContent?.includes("봇 추가")),
      );
      if (!(add instanceof HTMLButtonElement)) throw new Error("group add action did not render");
      await act(async () => add.click());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(calls[0]?.body).toEqual({
        name: "research Desk v2 / Seoul HQ",
        modelSelection: { instanceId: "codex-1", model: "codex-pro" },
        section: "Work",
      });
      expect(dispatched).toContainEqual(expect.objectContaining({ type: "botAdded", bot: created }));
      expect(dispatched).not.toContainEqual(expect.objectContaining({ type: "patchGroup" }));
      const save = [...host.querySelectorAll("button")].find((button) => button.textContent === saveLabel);
      if (!(save instanceof HTMLButtonElement)) throw new Error("group save action did not render");
      await act(async () => save.click());
      expect(dispatched).toContainEqual({
        type: "patchGroup",
        groupId: group.id,
        patch: { memberIds: [existing.id, created.id] },
      });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("ManageMembersPanel people", () => {
  const CODE = `wkr1:studio.example.test:inv_r1.wki_${"Q".repeat(43)}`;
  const shared = (people: Array<{ id: string; name: string }>): Group => ({ ...group, memberIds: ["b1"], hosted: { roomId: "r1" }, room: { name: "Channel", people, joins: [] } });
  let calls: Array<{ method: string; path: string }>;
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  async function open(target: Group, locale: "en" | "ko", answer: (path: string, method: string) => Response) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("localStorage", { getItem: (key: string) => (key === "omb-locale" ? locale : null), setItem: () => {}, removeItem: () => {} });
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", path });
      return answer(path, init?.method ?? "GET");
    }));
    const { ManageMembersPanel } = await import("./ManageMembersPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => root.render(createElement(I18nProvider, null, createElement(ManageMembersPanel, { group: target, onClose: () => undefined, triggerRef: { current: null } }))));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const people = () => host.querySelector<HTMLElement>("[data-group-people]")!;

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    dispatched.length = 0;
  });

  it.each([
    ["en", "People", "Invite", "Anyone with this code can join and read this whole chat.", "Bots"],
    ["ko", "참여자", "초대", "이 코드가 있으면 누구나 참여해서 이 채팅 전체를 읽을 수 있어요.", "봇"],
  ] as const)("puts People on top and Invite shares the group and shows its code in %s", async (locale, label, invite, hint, bots) => {
    const after = shared([]);
    await open(group, locale, () => json({ roomId: "r1", code: CODE, carried: 3, group: after }));
    expect(calls).toEqual([]);
    expect(people().compareDocumentPosition(host.querySelector('[role="checkbox"], [data-manage-create-bot]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(people().firstElementChild!.textContent).toBe(label);
    expect(host.textContent).toContain(bots);
    const button = people().querySelector<HTMLButtonElement>("[data-group-invite]")!;
    expect(button.textContent).toBe(invite);
    await act(async () => button.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(calls).toEqual([{ method: "POST", path: "/api/groups/group-1/share" }]);
    expect(people().querySelector("[data-team-room-code]")!.textContent).toContain(CODE);
    expect(people().querySelector("[data-room-code-hint]")!.textContent).toBe(hint);
    expect(dispatched).toContainEqual({ type: "groupPatched", group: after });
  });

  it("keeps People's label and hint on the code's gutter", async () => {
    await open(shared([]), "en", () => json({ roomId: "r1", code: CODE, carried: 0, group: shared([]) }));
    const code = people().querySelector("[data-team-room-code]")!;
    expect(people().className.split(" ")).not.toContain("px-3");
    expect(code.className.split(" ")).toContain("px-3");
    expect(people().firstElementChild!.className.split(" ")).toContain("px-3");
    expect(people().querySelector("[data-room-code-hint]")!.className.split(" ")).toContain("px-3");
  });

  it("shows a shared group's code and people at once, and Remove takes a fresh code", async () => {
    let code = CODE;
    await open(shared([{ id: "p1", name: "Seo-yeon Park" }]), "en", (_path, method) => {
      if (method === "DELETE") {
        code = CODE.replace("inv_r1", "inv_r2");
        return json({ ok: true });
      }
      return json({ roomId: "r1", code, carried: 0, group: shared([]) });
    });
    expect(people().querySelector("[data-team-room-code]")!.textContent).toContain(CODE);
    expect(people().textContent).toContain("Seo-yeon Park");
    await act(async () => people().querySelector<HTMLButtonElement>('button[aria-label="Remove Seo-yeon Park"]')!.click());
    expect(calls).toHaveLength(1);
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent === "Remove").at(-1)!.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(calls).toEqual([
      { method: "POST", path: "/api/groups/group-1/share" },
      { method: "DELETE", path: "/api/rooms/r1/people/p1" },
      { method: "POST", path: "/api/groups/group-1/share" },
    ]);
    expect(people().querySelector("[data-team-room-code]")!.textContent).toContain("inv_r2");
  });

  it.each([
    ["phone access is off", "Turn on Phone Access in Settings first."],
    ["this group is working - finish that turn first", "This group is working. Try again when it's done."],
  ])("says why Invite has no code: %s", async (error, line) => {
    await open(group, "en", () => json({ error }, 409));
    await act(async () => people().querySelector<HTMLButtonElement>("[data-group-invite]")!.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(people().querySelector('[role="alert"]')!.textContent).toBe(line);
    expect(people().querySelector("[data-team-room-code]")).toBeNull();
  });

  it("waits for Invite when a shared group's room is missing", async () => {
    await open({ ...group, hosted: { roomId: "gone" }, room: { missing: true } }, "en", () => json({}));
    expect(calls).toEqual([]);
    expect(people().querySelector("[data-group-invite]")).not.toBeNull();
  });

  it("never opens with focus on a Remove", async () => {
    await open(shared([{ id: "p1", name: "Seo-yeon Park" }]), "en", () => json({ roomId: "r1", code: CODE, carried: 0, group: shared([]) }));
    expect(document.activeElement?.getAttribute("aria-label")).not.toBe("Remove Seo-yeon Park");
    expect(people().contains(document.activeElement)).toBe(false);
  });

  it("shows the code once a missing room comes back while open", async () => {
    await open({ ...group, hosted: { roomId: "r1" }, room: { missing: true } }, "en", () => json({ roomId: "r1", code: CODE, carried: 0, group: shared([]) }));
    const { ManageMembersPanel } = await import("./ManageMembersPanel");
    const { I18nProvider } = await import("@/lib/i18n");
    await act(async () => root.render(createElement(I18nProvider, null, createElement(ManageMembersPanel, { group: shared([]), onClose: () => undefined, triggerRef: { current: null } }))));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(calls).toEqual([{ method: "POST", path: "/api/groups/group-1/share" }]);
    expect(people().querySelector("[data-team-room-code]")!.textContent).toContain(CODE);
  });

  it("scrolls 40 people and 15 bots inside the panel and keeps Cancel and Save out of the scroll", async () => {
    const bots = Array.from({ length: 15 }, (_, i): Bot => ({
      id: `b${i}`, threadId: `b${i}-thread`, name: `Bot ${i}`, title: "", description: "", notifications: true, color: "green", unread: false,
      modelSelection: { instanceId: "codex-1", model: "codex-default" }, messages: [],
    }));
    mockState.value = { bots, instances: [] };
    const crowd = { ...shared(Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, name: `Teammate ${i}` }))), memberIds: bots.map((bot) => bot.id) };
    await open(crowd, "en", () => json({ roomId: "r1", code: CODE, carried: 0, group: crowd }));
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.className.split(" ")).toContain("max-h-full");
    const body = people().closest<HTMLElement>(".overflow-y-auto")!;
    expect(body.className.split(" ")).toEqual(expect.arrayContaining(["min-h-0", "flex-1"]));
    expect(body.querySelectorAll("[data-group-people] li")).toHaveLength(40);
    expect(body.querySelectorAll('[role="checkbox"]')).toHaveLength(15);
    for (const label of ["Cancel", "Save"]) {
      const button = [...dialog.querySelectorAll("button")].find((each) => each.textContent === label)!;
      expect(body.contains(button)).toBe(false);
    }
    mockState.value = { bots: [], instances: [] };
  });
});
