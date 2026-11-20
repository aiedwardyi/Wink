// A node --test reporter for CI: names any test still running after NODE_TEST_STALL_MS (90 s), so a job cut off at its cap still says which test hung.
import path from "node:path";
import { Transform } from "node:stream";

const after = Number(process.env.NODE_TEST_STALL_MS) || 90_000;
const running = new Map();

const stalls = new Transform({
  writableObjectMode: true,
  // test:dequeue and test:complete arrive as they happen; test:start waits for the tests before it.
  transform({ type, data }, encoding, callback) {
    if ((type === "test:dequeue" || type === "test:complete") && data.file && path.resolve(data.name) !== path.resolve(data.file)) {
      const name = `${path.relative(process.cwd(), data.file)}:${data.line} > ${data.name}`;
      if (type === "test:dequeue") running.set(name, Date.now());
      else running.delete(name);
    }
    callback();
  },
  flush(callback) {
    clearInterval(timer);
    callback();
  },
});
const timer = setInterval(() => {
  const now = Date.now();
  for (const [name, since] of running) {
    if (now - since < after) continue;
    stalls.push(`::warning::still running after ${Math.round(after / 1000)} s: ${name}\n`);
    running.set(name, now);
  }
}, 1000);
timer.unref();

export default stalls;
