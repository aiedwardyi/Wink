/** Registers one cleanup step of a node:test test. */
export function defer(t, step) {
  t.after(step);
}
