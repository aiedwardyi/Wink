// CHAT-JUMP: something moves a window off the chat it has open and no log
// says what. Each switch away from an open chat posts one [chat-switch] line
// to the server log: the action that did it, the code that dispatched it, and
// the input event (if any) it ran under. Drop this once the trigger is known.
import type { Action } from "@/state/store-types";

export const CHAT_SWITCH_PATH = "/api/diag/chat-switch";

type Caller = { event?: string; trusted?: boolean; active?: boolean; caller: string[] };

const callers = new WeakMap<Action, Caller>();
const reported = new WeakSet<Action>();

/** At dispatch time, while the caller and its event are still on the stack. */
export function noteDispatch(action: Action) {
  if (action.type !== "select") return;
  const event = typeof window === "undefined" ? undefined : window.event;
  callers.set(action, {
    event: event?.type,
    trusted: event?.isTrusted,
    active: typeof navigator === "undefined" ? undefined : navigator.userActivation?.isActive,
    caller: (new Error().stack ?? "").split("\n").slice(2, 8).map((line) => line.trim().slice(0, 200)),
  });
}

/** Called by the reducer when `action` moved the open chat; StrictMode's second run is dropped. */
export function reportChatSwitch(action: Action, from: string, to: string | undefined, send = postChatSwitch) {
  if (reported.has(action)) return;
  reported.add(action);
  send({
    from,
    // a delete that leaves no chat open still logs; the server requires "to"
    to: to ?? "",
    action: action.type,
    ...callers.get(action),
    focused: document.hasFocus(),
    visibility: document.visibilityState,
    desktop: Boolean(window.ogb),
    userAgent: navigator.userAgent.slice(0, 512),
  });
}

function postChatSwitch(line: Record<string, unknown>) {
  setTimeout(() => {
    void fetch(CHAT_SWITCH_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(line), keepalive: true }).catch(() => {});
  }, 0);
}
