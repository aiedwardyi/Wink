// A process created while a terminal starts inherits that terminal's console pipes, and the terminal then never ends.
export const spawnGate = new Int32Array(new SharedArrayBuffer(8));

const TERMINALS = 0;
const LAUNCHES = 1;
const LAUNCHING = -1;
// A thread stopped inside its turn never lets go, so nobody waits longer than this.
const LIMIT_MS = 5_000;

function enter(gate, take) {
  for (const deadline = Date.now() + LIMIT_MS; ;) {
    const seen = Atomics.load(gate, TERMINALS);
    if (take(seen)) return true;
    if (Date.now() >= deadline) return false;
    Atomics.wait(gate, TERMINALS, seen, 50);
  }
}

/** Any number of terminals start together; a waiting launch goes before the next one. */
export function startTerminal(gate, run) {
  const entered = gate && enter(gate, (count) => count >= 0 && !Atomics.load(gate, LAUNCHES) && Atomics.compareExchange(gate, TERMINALS, count, count + 1) === count);
  try {
    return run();
  } finally {
    if (entered) {
      Atomics.sub(gate, TERMINALS, 1);
      Atomics.notify(gate, TERMINALS);
    }
  }
}

/** `run` creates the process before it returns, while no terminal is inside its start. */
export function startProcess(gate, run) {
  if (gate) Atomics.add(gate, LAUNCHES, 1);
  const entered = gate && enter(gate, (count) => count === 0 && Atomics.compareExchange(gate, TERMINALS, 0, LAUNCHING) === 0);
  try {
    return run();
  } finally {
    if (gate) {
      Atomics.sub(gate, LAUNCHES, 1);
      if (entered) Atomics.store(gate, TERMINALS, 0);
      Atomics.notify(gate, TERMINALS);
    }
  }
}
