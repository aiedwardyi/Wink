// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";
import { applyLocale } from "./i18n";
import { NO_REPLY_MS } from "./no-reply";
import { useRoomTurnStage } from "./room-turn";
import type { TurnStreamState } from "./turn-stage";

const here = dirname(fileURLToPath(import.meta.url));
const groupView = readFileSync(join(here, "../components/GroupView.tsx"), "utf8");

const user: Message = { id: "u1", at: 1, role: "user", kind: "text", text: "hi" };
const tool: Message = { id: "a1", at: 2, role: "bot", kind: "activity", tool: { name: "Bash: pnpm test" } };
const stream = (signal?: "started" | "preparing"): TurnStreamState => ({ streaming: {}, reasoning: {}, signal: signal ? { t1: signal } : {} });

function Probe({ messages, state }: { messages: Message[]; state: TurnStreamState }) {
  const { label, noReply } = useRoomTurnStage("t1", messages, state, true, "antigravityAgent");
  return createElement("span", { "data-quiet": String(noReply?.quiet ?? false), "data-wrap": String(Boolean(noReply)) }, label);
}

let host: HTMLDivElement;
let root: Root;
const render = (messages: Message[], state: TurnStreamState) => act(async () => root.render(createElement(Probe, { messages, state })));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  applyLocale("en");
  document.body.innerHTML = "";
});

describe("a room turn's stage", () => {
  it("names the 1:1 stages", async () => {
    await render([user], stream());
    expect(host.textContent).toBe("Preparing");
    await render([user], stream("started"));
    expect(host.textContent).toBe("Waiting for the model");
    await render([user, tool], stream("started"));
    expect(host.textContent).toBe("Running a command");
  });

  it("goes quiet and wraps once the engine stays silent", async () => {
    await render([user], stream("started"));
    await act(async () => vi.advanceTimersByTime(NO_REPLY_MS));
    expect(host.textContent).toBe("Gemini hasn't replied in 2 min");
    expect(host.firstElementChild?.getAttribute("data-wrap")).toBe("true");
    expect(host.firstElementChild?.getAttribute("data-quiet")).toBe("false");
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(host.firstElementChild?.getAttribute("data-quiet")).toBe("true");
  });

  it("hands the wait to the room's presence, with no model switch", () => {
    expect(groupView).toMatch(/quiet=\{noReply\?\.quiet\}\s*wrap=\{Boolean\(noReply\)\}/);
    expect(groupView).not.toContain("onSwitch");
  });
});
