import { expect, it } from "vitest";
import { CommsCallers } from "./comms-caller.ts";

it("keeps a stable token for each bot and session", () => {
  const callers = new CommsCallers();
  const token = callers.token("a", "home");
  expect(callers.token("a", "home")).toBe(token);
  expect(callers.token("a", "other")).not.toBe(token);
  expect(callers.resolve(`Bearer ${token}`)).toEqual({ botId: "a", threadId: "home" });
});

it("refuses unknown or malformed caller tokens", () => {
  const callers = new CommsCallers();
  expect(callers.resolve(undefined)).toBeUndefined();
  expect(callers.resolve(["Bearer forged"])).toBeUndefined();
  expect(callers.resolve("Bearer forged")).toBeUndefined();
});
