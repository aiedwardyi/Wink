import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SHARED_LOCAL_VM_TARGET } from "./container-computer.ts";
import { LocalVmIdleTimer } from "./local-vm-idle.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const idleFor = source.slice(source.indexOf("function localVmIdleFor("), source.indexOf("function releaseLocalVmThread("));
const startup = source.slice(source.indexOf("void (async () => {", source.indexOf("// A running VM may have survived")));
const boot = startup.slice(0, startup.indexOf("})();") + 5).replace("void (", "return (");

function harness(managed: boolean) {
  const status = { container: "running", managed };
  const remove = vi.fn(async () => {});
  const timers = new Map<string, LocalVmIdleTimer>();
  const scope = {
    LocalVmIdleTimer, LOCAL_VM_IDLE_MS: 1_000, localVmIdles: timers,
    localVmLifecycleBusy: new Set(), localVmActiveThreads: new Map(),
    containerComputerStatus: async () => status, containerComputerAction: remove,
    localVmMode: () => "shared", cfg: {}, store: { bots: [] }, SHARED_LOCAL_VM_TARGET,
  };
  const javascript = ts.transpileModule(`${idleFor}\nfunction boot() { ${boot} }\nreturn { boot, localVmIdleFor };`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText;
  const run = new Function(...Object.keys(scope), javascript)(...Object.values(scope)) as {
    boot(): Promise<void>;
    localVmIdleFor(target: typeof SHARED_LOCAL_VM_TARGET): LocalVmIdleTimer;
  };
  return { ...run, status, remove, timers };
}

afterEach(() => vi.useRealTimers());

describe("Local VM idle ownership", () => {
  it("arms the startup backstop only for a managed running container", async () => {
    vi.useFakeTimers();
    const unmanaged = harness(false);
    await unmanaged.boot();
    expect(unmanaged.timers.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(unmanaged.remove).not.toHaveBeenCalled();

    const managed = harness(true);
    await managed.boot();
    expect(managed.timers.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(managed.remove).toHaveBeenCalledWith("remove", undefined, undefined, SHARED_LOCAL_VM_TARGET);
  });

  it("rechecks ownership when an already armed timer expires", async () => {
    vi.useFakeTimers();
    const vm = harness(true);
    await vm.boot();
    vm.status.managed = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vm.remove).not.toHaveBeenCalled();

    vm.status.managed = true;
    vm.localVmIdleFor(SHARED_LOCAL_VM_TARGET).touch();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vm.remove).toHaveBeenCalledOnce();
  });
});
