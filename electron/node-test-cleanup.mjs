const steps = new WeakMap();

/**
 * Registers one cleanup step of a node:test test. node:test stops at the first after hook that throws,
 * so a folder that cannot be removed would skip the close of the client holding it; every step runs here, newest first.
 */
export function defer(t, step) {
  if (!steps.has(t)) {
    steps.set(t, []);
    t.after(async () => {
      const errors = [];
      for (const run of steps.get(t).reverse()) {
        try { await run(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw errors[0];
    });
  }
  steps.get(t).push(step);
}
