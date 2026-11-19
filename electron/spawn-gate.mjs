import { Worker, threadId } from "node:worker_threads";

// A process created while a terminal starts inherits that terminal's console pipes, and the terminal then never ends.
export const spawnGate = new Int32Array(new SharedArrayBuffer(8));

// Each slot holds the owning thread, so the parent can let go of a turn whose thread ended inside it.
const TERMINALS = 0;
const LAUNCHES = 1;
const self = threadId + 1;
// A thread hung inside its turn never lets go, so nobody waits longer than this.
const LIMIT_MS = 5_000;

function enter(gate, take) {
  for (const deadline = Date.now() + LIMIT_MS; ;) {
    const seen = Atomics.load(gate, TERMINALS);
    if (take(seen)) return true;
    if (Date.now() >= deadline) return false;
    Atomics.wait(gate, TERMINALS, seen, 50);
  }
}

function release(gate, owner) {
  Atomics.compareExchange(gate, LAUNCHES, owner, 0);
  Atomics.compareExchange(gate, TERMINALS, owner, 0);
  Atomics.compareExchange(gate, TERMINALS, -owner, 0);
  Atomics.notify(gate, TERMINALS);
}

/** A worker given the gate as `workerData.gate`; whatever it holds is let go when it ends. */
export function gatedWorker(url, options) {
  const worker = new Worker(url, { ...options, workerData: { ...options.workerData, gate: spawnGate } });
  const owner = worker.threadId + 1;
  worker.once("exit", () => release(spawnGate, owner));
  return worker;
}

// ConPTY crashes the process (0xC0000005) when two terminals start on different threads at once.
/** One terminal starts at a time; a waiting launch goes before the next one. */
export function startTerminal(gate, run) {
  const entered = gate && enter(gate, (owner) => owner === 0 && !Atomics.load(gate, LAUNCHES) && Atomics.compareExchange(gate, TERMINALS, 0, self) === 0);
  try {
    return run();
  } finally {
    if (entered) release(gate, self);
  }
}

/** `run` creates the process before it returns, while no terminal is inside its start. */
export function startProcess(gate, run) {
  const entered = gate && enter(gate, (owner) => {
    Atomics.compareExchange(gate, LAUNCHES, 0, self);
    return owner === 0 && Atomics.compareExchange(gate, TERMINALS, 0, -self) === 0;
  });
  try {
    return run();
  } finally {
    if (gate) {
      if (entered) Atomics.compareExchange(gate, TERMINALS, -self, 0);
      Atomics.compareExchange(gate, LAUNCHES, self, 0);
      Atomics.notify(gate, TERMINALS);
    }
  }
}
