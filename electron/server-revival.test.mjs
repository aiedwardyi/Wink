import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { createServerRevival } from "./server-revival.mjs";

function desktop({ boots = () => true } = {}) {
  const state = { forks: [], pages: [], quitting: false, clock: 0, current: null };
  const fork = () => {
    const child = new EventEmitter();
    child.once("exit", () => {
      if (state.current !== child) return;
      state.current = null;
      state.revival = revive();
    });
    state.forks.push(child);
    return child;
  };
  const revive = createServerRevival({
    quitting: () => state.quitting,
    now: () => state.clock,
    show: (page) => state.pages.push(page),
    start: async () => {
      const child = fork();
      if (!boots(state.forks.length)) return false;
      state.current = child;
      return true;
    },
  });
  state.current = fork();
  return state;
}

describe("packaged server revival", () => {
  it("forks again and reloads the window when the server dies after startup", async () => {
    const app = desktop();
    app.forks[0].emit("exit", 1);
    expect(app.pages).toEqual(["restarting"]);
    await app.revival;
    expect(app.forks).toHaveLength(2);
    expect(app.pages).toEqual(["restarting", "ready"]);
  });

  it("shows the failed page when the restart does not come up", async () => {
    const app = desktop({ boots: () => false });
    app.forks[0].emit("exit", 1);
    await app.revival;
    expect(app.pages).toEqual(["restarting", "failed"]);
  });

  it("stays quiet when the app is quitting", () => {
    const app = desktop();
    app.quitting = true;
    app.forks[0].emit("exit", 0);
    expect(app.forks).toHaveLength(1);
    expect(app.pages).toEqual([]);
  });

  it("stops at the failed page when the restarted server dies straight away", async () => {
    const app = desktop();
    app.forks[0].emit("exit", 1);
    await app.revival;
    app.clock += 29_999;
    app.forks[1].emit("exit", 1);
    expect(app.forks).toHaveLength(2);
    expect(app.pages).toEqual(["restarting", "ready", "stopped"]);
  });

  it("restarts again when a restarted server dies after it settled", async () => {
    const app = desktop();
    app.forks[0].emit("exit", 1);
    await app.revival;
    app.clock += 30_000;
    app.forks[1].emit("exit", 1);
    await app.revival;
    expect(app.forks).toHaveLength(3);
    expect(app.pages).toEqual(["restarting", "ready", "restarting", "ready"]);
  });
});
