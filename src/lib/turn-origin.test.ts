import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { nextTurnOrigin, nextTurnOrigins, turnOriginRow, type TurnOriginState } from "./turn-origin";

const user: Message = { id: "u1", at: 90_000, role: "user", kind: "text", text: "Preview" };
const idle: TurnOriginState = { active: false };
const dispatched = () => nextTurnOrigin(idle, { type: "dispatch", turnKey: "pending", dispatchKey: "d1", now: 100_000 });

describe("turn origin", () => {
  it("uses viewer receipt time for live dispatch", () => {
    expect(dispatched().origin).toEqual({ turnKey: "pending", originMs: 100_000, source: "dispatch" });
  });

  it("keeps dispatch time through its first row, starts, joins and retries", () => {
    let state = nextTurnOrigin(dispatched(), { type: "row", row: user, now: 100_100 });
    state = nextTurnOrigin(state, { type: "started", turnKey: "provider-1", now: 100_850 });
    state = nextTurnOrigin(state, { type: "row", row: { ...user, id: "join", steered: true }, now: 100_900 });
    expect(nextTurnOrigin(state, { type: "started", turnKey: "provider-1", now: 101_800 })).toBe(state);
    expect(state.origin?.originMs).toBe(100_000);
  });

  it("ignores a replayed dispatch after start and completion", () => {
    let state = nextTurnOrigin(dispatched(), { type: "started", turnKey: "provider-1", now: 100_850 });
    state = nextTurnOrigin(state, { type: "completed" });
    expect(nextTurnOrigin(state, { type: "dispatch", turnKey: "another-pending", dispatchKey: "d1", now: 110_000 })).toBe(state);
    expect(nextTurnOrigin(state, { type: "started", turnKey: "provider-1", now: 110_000 })).toBe(state);
  });

  it("keeps the origin when a retry announces a replacement provider id", () => {
    const started = nextTurnOrigin(dispatched(), { type: "started", turnKey: "provider-1", now: 100_850 });
    const retry = nextTurnOrigin(started, { type: "started", turnKey: "provider-2", retry: true, now: 102_000 });
    expect(retry.origin).toBe(started.origin);
    expect(retry.providerTurnId).toBe("provider-2");
  });

  it("starts a drained reply at its new dispatch", () => {
    const ended = nextTurnOrigin(dispatched(), { type: "completed" });
    const drained = nextTurnOrigin(ended, { type: "row", row: { ...user, id: "drain", queueId: "q1", at: 110_000 }, now: 110_000 });
    expect(nextTurnOrigin(drained, { type: "dispatch", turnKey: "pending-2", dispatchKey: "d2", now: 110_050 }).origin?.originMs).toBe(110_050);
  });

  it("hydrates from the first row of the current turn, past tools and steers", () => {
    const first = { ...user, id: "first", at: 95_000 };
    const row = turnOriginRow([user, first, { ...user, id: "tool", role: "bot", kind: "activity" }, { ...user, id: "join", at: 99_000, steered: true }]);
    const state = nextTurnOrigin(idle, { type: "hydrated", turnKey: "tail", row, now: 100_000 });
    expect(state.origin).toEqual({ turnKey: "tail", originMs: 95_000, source: "row" });
    expect(nextTurnOrigin(state, { type: "hydrated", turnKey: "moved-tail", row, now: 102_000 })).toBe(state);
  });

  it("clamps a future server row to first observation on reload", () => {
    const row = { ...user, at: 103_000 };
    const state = nextTurnOrigin(idle, { type: "hydrated", turnKey: "tail", row, now: 100_000 });
    expect(state.origin).toEqual({ turnKey: "tail", originMs: 100_000, source: "observed" });
    expect(nextTurnOrigin(state, { type: "hydrated", turnKey: "tail", row, now: 102_000 })).toBe(state);
  });

  it("keeps a row-anchored origin when hydration has no row", () => {
    const state = nextTurnOrigin(idle, { type: "hydrated", turnKey: "tail", row: user, now: 100_000 });
    expect(nextTurnOrigin(state, { type: "hydrated", turnKey: "tail", now: 102_000 })).toBe(state);
  });

  it("keeps the first observation when recovered history has a future timestamp", () => {
    const observed = nextTurnOrigin(idle, { type: "hydrated", turnKey: "tail", now: 100_000 });
    const recovered = nextTurnOrigin(observed, { type: "history", row: { ...user, at: 103_000 } });
    expect(recovered.origin?.originMs).toBe(100_000);
    expect(nextTurnOrigin(recovered, { type: "history", row: { ...user, at: 103_000 } })).toBe(recovered);
  });

  it("ignores recovered history for dispatched and completed turns", () => {
    const live = dispatched();
    expect(nextTurnOrigin(live, { type: "history", row: user })).toBe(live);
    const ended = nextTurnOrigin(nextTurnOrigin(idle, { type: "hydrated", turnKey: "tail", now: 100_000 }), { type: "completed" });
    expect(nextTurnOrigin(ended, { type: "history", row: user })).toBe(ended);
  });

  it("waits for the first prompt when recovered history only contains a steer", () => {
    const observed = nextTurnOrigin(idle, { type: "hydrated", turnKey: "tail", now: 100_000 });
    expect(nextTurnOrigin(observed, { type: "history", row: { ...user, steered: true } })).toBe(observed);
    expect(nextTurnOrigin(observed, { type: "history", row: user }).origin?.originMs).toBe(90_000);
  });

  it("uses the observed start until a missed-dispatch row arrives", () => {
    const started = nextTurnOrigin(idle, { type: "started", turnKey: "provider-1", now: 100_000 });
    expect(nextTurnOrigin(started, { type: "row", row: user, now: 101_000 }).origin?.originMs).toBe(90_000);
    expect(nextTurnOrigin(started, { type: "row", row: { ...user, at: 103_000 }, now: 101_000 }).origin?.originMs).toBe(100_000);
  });

  it("ignores queued placeholders when finding the first row", () => {
    expect(turnOriginRow([user, { ...user, id: "optimistic", placeholder: true }, { ...user, id: "queued", queued: true }])).toBe(user);
  });

  it("keeps each thread independent", () => {
    let state = nextTurnOrigins({}, { threadId: "t1", event: { type: "dispatch", turnKey: "p1", dispatchKey: "d1", now: 100_000 } });
    state = nextTurnOrigins(state, { threadId: "t2", event: { type: "dispatch", turnKey: "p2", dispatchKey: "d2", now: 101_000 } });
    expect(state.t1.origin?.originMs).toBe(100_000);
    expect(state.t2.origin?.originMs).toBe(101_000);
  });
});
