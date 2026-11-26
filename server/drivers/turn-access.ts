import type { SendTurnInput } from "../contracts.ts";

/** free: never asks. auto: Wink answers the engine's asks, except risky ones. ask: the user answers. own: the engine's own config decides. off: blocked. */
export type Grant = "free" | "auto" | "ask" | "own" | "off";
export interface TurnAccess {
  edits: Grant;
  commands: Grant;
}
export type AccessTurn = Pick<SendTurnInput, "approval" | "readOnly" | "ownerText" | "cwd" | "leanStartup" | "integrations">;
export const FREE_ACCESS: TurnAccess = { edits: "free", commands: "free" };
/** A read-only turn on someone else's words (a room guest, a bot, a joined room): no file of this PC may reach it. */
export const guestText = (turn: Pick<SendTurnInput, "readOnly" | "ownerText">) => turn.readOnly === true && turn.ownerText !== true;

/** Grants of a driver whose asks reach Wink: the chip decides, and a read-only turn has nobody to approve (index.ts denies its asks). */
export function routedAccess(turn: AccessTurn): TurnAccess {
  const grant: Grant = turn.readOnly ? "off" : turn.approval === "ask" ? "ask" : "auto";
  return { edits: grant, commands: grant };
}

const HOW: Record<Grant, string> = {
  free: "without asking",
  auto: "without asking (Wink asks the user only for risky ones)",
  ask: "once the user approves; just call the tool to ask them",
  own: "as your own sandbox and approval settings allow",
  off: "",
};

const WINK_TOOLS: Record<keyof NonNullable<SendTurnInput["integrations"]>, string> = {
  agents: "other bots and tasks",
  terminal: "terminals",
  computer: "a computer",
  localComputer: "a computer",
  composio: "connected apps",
  phone: "a phone",
  browser: "a browser",
  dweb: "dweb",
};

function can(what: string, grant: Grant): string {
  return grant === "off" ? `cannot ${what}` : `can ${what} ${HOW[grant]}`;
}

/** One block per turn, built from the same grants the driver launches with. */
export function accessRules(access: TurnAccess = FREE_ACCESS, integrations: SendTurnInput["integrations"]): string {
  const { edits, commands } = access;
  const level = edits === commands
    ? edits === "off" ? "Read-only turn: no file edits or commands." : `You can read files; you ${can("edit files and run commands", edits)}.`
    : `You can read files. You ${can("edit files", edits)}; you ${can("run commands", commands)}.`;
  const web = commands === "off" ? "" : " Commands can also fetch web pages (curl).";
  const wink = [...new Set(Object.keys(integrations ?? {}).map((key) => WINK_TOOLS[key as keyof typeof WINK_TOOLS]).filter(Boolean))];
  const tools = wink.length ? `built-in plus Wink tools for: ${wink.join("; ")}` : "built-in";
  return ` What you can do here: ${level}${web} Your tools are exactly your tool list (${tools}). Answer what-can-you-do questions from this, not from beliefs about your model.`;
}
