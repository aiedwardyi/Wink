// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Group, Message } from "@/state/store-types";

import { closeGroupArchive, groupTaskTicket, showGroupTask, useGroupArchive, type GroupArchive } from "./group-archive";

const older: Message[] = [{ id: "m1", role: "user", kind: "text", at: 1, text: "Last week's plan" }];
const view = (hosted: boolean) => ({ id: "g1", threadId: "older", messages: older, ...(hosted ? { hosted: { roomId: "r1" } } : {}) }) as unknown as Group;

afterEach(() => closeGroupArchive());

describe("an older task of a shared group", () => {
  it("opens to read only and leaves the group on its shared thread", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const dispatch = vi.fn();
    let seen: Record<string, GroupArchive | null> = {};
    function Probe() {
      seen = { g1: useGroupArchive("g1"), g2: useGroupArchive("g2") };
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    await act(async () => showGroupTask(view(true), dispatch, groupTaskTicket()));
    expect(dispatch).not.toHaveBeenCalled();
    expect(seen).toEqual({ g1: { groupId: "g1", threadId: "older", messages: older }, g2: null });
    await act(async () => closeGroupArchive());
    expect(seen.g1).toBeNull();
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  it("switches a group that isn't shared, as before", () => {
    const dispatch = vi.fn();
    showGroupTask(view(false), dispatch, groupTaskTicket());
    expect(dispatch).toHaveBeenCalledWith({ type: "groupPatched", group: view(false) });
  });


  it("drops an answer that a newer ask or a select overtook", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let seen: GroupArchive | null = null;
    function Probe() {
      seen = useGroupArchive("g1");
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    const first = groupTaskTicket();
    const second = groupTaskTicket();
    await act(async () => showGroupTask({ ...view(true), threadId: "newer" }, vi.fn(), second));
    await act(async () => showGroupTask(view(true), vi.fn(), first));
    expect(seen).toMatchObject({ threadId: "newer" });
    const asked = groupTaskTicket();
    await act(async () => closeGroupArchive());
    await act(async () => showGroupTask(view(true), vi.fn(), asked));
    expect(seen).toBeNull();
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });
});

describe("the older task bar", () => {
  it.each([["en", "An older task. Read only.", "Back to the shared chat"], ["ko", "이전 작업이에요. 읽기만 할 수 있어요.", "공유 채팅으로 돌아가기"]] as const)("reads in %s and Back closes it", async (locale, line, back) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const { applyLocale, I18nProvider } = await import("./i18n");
    const { GroupArchiveBar } = await import("@/components/GroupArchiveBar");
    localStorage.setItem("omb-locale", locale);
    showGroupTask(view(true), vi.fn(), groupTaskTicket());
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    let open: GroupArchive | null = null;
    function Probe() {
      open = useGroupArchive("g1");
      return createElement(GroupArchiveBar);
    }
    await act(async () => root.render(createElement(I18nProvider, null, createElement(Probe))));
    expect(host.textContent).toBe(line + back);
    await act(async () => host.querySelector("button")!.click());
    expect(open).toBeNull();
    await act(async () => root.unmount());
    applyLocale("en");
    localStorage.clear();
    vi.unstubAllGlobals();
  });
});
