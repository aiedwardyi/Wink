import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { applyLocale } from "@/lib/i18n";
import type { JoinedView } from "@/lib/team-rooms";
import { initialState, type Bot, type Group } from "@/state/store";
import { BotListItem } from "./SidebarConversations";

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown>, dispatch: vi.fn() }));
const joined = vi.hoisted(() => ({ rooms: [] as unknown[] }));
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), useStore: () => store }));
vi.mock("@/lib/joined-rooms", () => ({ useLoadedJoinedRooms: () => joined.rooms }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));

afterEach(() => { applyLocale("en"); joined.rooms = []; });

const rando = (workingThreadId: string | null) => ({ id: "rando", name: "Rando", threadId: "own", busy: true, workingThreadId, messages: [], modelSelection: { instanceId: "muse", model: "muse-spark-1.3" } }) as unknown as Bot;
const group = (patch: Partial<Group> = {}) => ({ id: "g1", threadId: "g1-thread", name: "test", memberIds: ["rando"], messages: [], ...patch }) as Group;

async function row(bot: Bot, state: { groups?: Group[]; routineRuns?: unknown[] } = {}) {
  store.state = { ...initialState, bots: [bot], instances: [{ instanceId: "muse", driverKind: "museAgent", models: { options: [{ id: "muse-spark-1.3", label: "Muse 1.3" }] } }], config: {}, terminalAttention: {}, terminalPanes: {}, groups: [], routineRuns: [], selectedId: null, ...state };
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(BotListItem, { bot, density: "comfortable", onMenu: () => {} })));
  const text = host.querySelector("[data-sidebar-model-row]")?.textContent ?? "";
  await act(async () => root.unmount());
  host.remove();
  return text;
}

it.each([["en", "Working in test"], ["ko", "test에서 작업 중"]] as const)("names the group a turn runs in, in %s", async (locale, label) => {
  applyLocale(locale);
  expect(await row(rando("g1-thread"), { groups: [group({ busyBotId: "rando" })] })).toBe(`Muse 1.3${label}`);
});

it("names the group when only the group names the bot as working", async () => {
  expect(await row(rando(null), { groups: [group({ busyBotId: "rando" })] })).toContain("Working in test");
});

it("names the group for a turn in one of its other threads", async () => {
  const tasks = [{ threadId: "g1-thread", title: "", createdAt: 1 }, { threadId: "g1-older", title: "", createdAt: 0 }];
  expect(await row(rando("g1-older"), { groups: [group({ tasks })] })).toContain("Working in test");
});

it.each([["en", "Working on Morning digest"], ["ko", "Morning digest 루틴 실행 중"]] as const)("names the routine a turn runs for, in %s", async (locale, label) => {
  applyLocale(locale);
  const run = { id: "r1", routineId: "rt", routineName: "Morning digest", botId: "rando", status: "running", threadId: "run-thread" };
  expect(await row(rando("run-thread"), { routineRuns: [run] })).toContain(label);
  expect(await row(rando("run-thread"), { routineRuns: [{ ...run, status: "completed" }] })).toContain(locale === "en" ? "Working…" : "작업 중…");
});

it("names the joined team room a turn runs for", async () => {
  joined.rooms = [{ roomId: "r1", state: { roomName: "Launch" }, myBots: [{ id: "tb1", botId: "rando", working: true }] } as unknown as JoinedView];
  expect(await row(rando("hidden-room-task"))).toContain("Working in Launch");
  expect(await row(rando("own"))).toBe("Muse 1.3Working…");
});

it.each([["en", "Working…"], ["ko", "작업 중…"]] as const)("keeps the plain line for a turn in its own chat, in %s", async (locale, label) => {
  applyLocale(locale);
  expect(await row(rando("own"), { groups: [group()] })).toBe(`Muse 1.3${label}`);
  expect(await row(rando(null), { groups: [group()] })).toBe(`Muse 1.3${label}`);
});
