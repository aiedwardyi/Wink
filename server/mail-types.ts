import type { Message } from "./store.ts";

export type MailState = "held" | "ready" | "approval" | "dispatching" | "running" | "steered" | "finishing" | "done" | "failed" | "dropped" | "refused" | "deferred";

export interface MailRead {
  state: "handed" | "read";
  via: "fold" | "tool" | "steer";
  turnId: string;
  requestId?: string;
  upto?: number;
  part?: number;
  handedUpto?: number;
  at: number;
}

export interface MailDestination {
  threadId: string;
  mailKey: string;
  rowId?: string;
  row?: Omit<Message, "id" | "at">;
}

export const terminalMailState = (state: MailState) =>
  state === "done" || state === "failed" || state === "dropped" || state === "refused";
