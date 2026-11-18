import { expect, it } from "vitest";
import { createActionClock } from "./action-clock";

it("anchors action time to the server rather than a slow or changing wall clock", () => {
  let wall = 1_000;
  let mono = 10;
  const clock = createActionClock(() => wall, () => mono);
  expect(clock.now()).toBe(1_000);
  clock.sample(20_000, 0, mono);
  mono += 100;
  wall -= 60_000;
  expect(clock.now()).toBe(20_105);
});

it("keeps the faster clock sample when a response is held in transit", () => {
  let mono = 10;
  const clock = createActionClock(() => 0, () => mono);
  clock.sample(1_000, 0, mono);
  mono = 5_000;
  clock.sample(1_001, 11, mono);
  expect(clock.now()).toBe(5_995);
  clock.sample(Number.NaN, 0, mono);
  expect(clock.now()).toBe(5_995);
});

it("reanchors after the client's monotonic clock pauses during sleep", () => {
  let mono = 10;
  const clock = createActionClock(() => 0, () => mono);
  clock.sample(1_000, 0, mono);
  mono = 20;
  clock.sample(361_010, 10, mono);
  expect(clock.now()).toBe(361_015);
});
