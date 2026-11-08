import { VERIFY_BODY_LIMIT, VERIFY_RUN_STATES } from "./verify-protocol.mjs";

export const RESOLVER_RULES = "MAP * ~NOTFOUND, EXCLUDE 127.0.0.1";
export const SYSTEM_ENV = ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "SYSTEMDRIVE"];
export const CHILD_PATHS = ["appData", "userData", "sessionData", "temp", "logs", "crashDumps"];
const CHECKERS = ["TEXT_A", "TEXT_B", "HEADINGS", "LINKS", "FONT", "CONTRAST", "BUTTONS", "NAV", "CLICK", "FORM", "FIT", "PAGE_ERRORS"];
export const ERROR_CODES = ["needs-approval", "denied", "desktop-required", "outside-folders", "not-a-site", "busy", "page-failed", "timeout", "cancelled", "site-changed", "resource-limit", "isolation-failed", "internal"];

const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v, max = 4096) => typeof v === "string" && v.length <= max && !v.includes("\0");
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const runId = (v) => typeof v === "string" && /^[a-z0-9-]{8,64}$/.test(v);
const locale = (v) => v === "en" || v === "ko";
const bool = (v) => typeof v === "boolean";
const error = (v) => ERROR_CODES.includes(v);
const tally = (v) => Array.isArray(v) && v.length === 2 && v.every(integer) && v[0] <= v[1];
const nullable = (f) => (v) => v === null || f(v);
const optional = (f) => (v) => v === undefined || f(v);
const display = (v) => record(v) && Object.keys(v).sort().join() === "height,width,x,y" && [v.x, v.y, v.width, v.height].every(Number.isFinite) && v.width > 0 && v.height > 0;

function shape(value, fields) {
  return record(value) && Object.keys(value).every((key) => Object.hasOwn(fields, key)) && Object.entries(fields).every(([key, check]) => check(value[key]));
}

export function validCounts(v) {
  const by = (b) => shape(b, Object.fromEntries(CHECKERS.map((c) => [c, optional((t) => shape(t, { desktop: optional(tally), phone: optional(tally) }))])));
  return shape(v, { planned: integer, completed: integer, passed: integer, failed: integer, blocked: integer, notRun: integer, by: optional(by) })
    && v.completed === v.passed + v.failed + v.blocked && v.planned === v.completed + v.notRun;
}

export function validResult(v) {
  return shape(v, {
    v: (n) => n === 1, runId, site: (s) => text(s, 512), counts: validCounts,
    issues: (issues) => Array.isArray(issues) && issues.length <= 40 && issues.every((issue) => shape(issue, {
      checker: (c) => CHECKERS.includes(c),
      tile: (t) => ["desktop", "phone"].includes(t), rule: (s) => text(s, 120), where: (s) => text(s, 120), measured: (s) => text(s, 160), scrollY: optional(Number.isFinite),
      box: optional(v => Array.isArray(v) && v.length === 4 && v.every(Number.isFinite) && v[2] >= 0 && v[3] >= 0),
    })),
    issueTotal: integer, errorCode: optional(error), durationMs: integer,
    notChecked: optional(v => Array.isArray(v) && v.length <= 20 && v.every(s => text(s, 200))),
    details: optional(v => Array.isArray(v) && v.length <= 40 && v.every(row => validResult({ v: 1, runId: "detail-123", site: "", counts: { planned: 1, completed: 1, passed: 0, failed: 1, blocked: 0, notRun: 0 }, issues: [row], issueTotal: 1, durationMs: 0 }))),
  }) && v.issueTotal >= v.issues.length && v.issueTotal <= v.counts.failed;
}

export function validProbe(q) {
  if (typeof q === "string") return ["metrics", "counts", "layout", "lookups"].includes(q);
  return shape(q, { name: (n) => n === "resize", width: (v) => integer(v) && v >= 960 && v <= 4096, height: (v) => integer(v) && v >= 540 && v <= 4096 })
    || shape(q, { name: (n) => n === "stall", ms: (v) => integer(v) && v <= 35000 });
}

const run = { runId };
const viewing = { locale, muted: bool, display };
const parent = {
  hello: { v: (v) => v === 1, nonce: (v) => /^[a-f0-9]{48}$/.test(v), parentPid: (v) => integer(v) && v > 0, probe: bool, probeRoot: nullable(text) },
  start: { ...run, botId: (v) => typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v), root: text, entry: text, revision: (v) => /^[a-f0-9]{64}$/.test(v), site: (v) => text(v, 512), watch: bool, recording: optional(bool), ...viewing },
  watch: { ...run, ...viewing }, cancel: run, ping: { n: integer }, quit: {}, probe: { q: validProbe },
};
const child = {
  cast: { ...run, tile: v => v === "desktop" || v === "phone", ms: v => integer(v) && v <= 0xffffffff, data: v => typeof v === "string" && v.length > 0 && v.length < 192 * 1024 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v) },
  mark: { ...run, event: v => record(v) && ["start", "hold", "load", "scroll", "point", "result", "opened", "finalize", "part", "checks"].includes(v.kind) && integer(v.seq) && Number.isFinite(v.emittedAt) && Buffer.byteLength(JSON.stringify(v)) < 60 * 1024 },
  ready: {
    versions: (v) => record(v) && Object.keys(v).length <= 100 && Object.values(v).every((s) => text(s, 256)),
    rules: (v) => text(v, 256), userDataDir: text,
    paths: (v) => shape(v, Object.fromEntries(CHILD_PATHS.map((key) => [key, text]))), canary: (v) => v === "rejected",
  },
  fatal: { reason: (v) => text(v, 512) }, accepted: run, rejected: { ...run, error }, shown: run, unknown: run,
  cancelled: { ...run, cancelled: bool }, pong: { n: integer }, muted: { muted: bool }, idle: {},
  log: { level: (v) => ["debug", "info", "warn", "error"].includes(v), msg: (v) => text(v, 2048) },
  state: { ...run, state: (v) => VERIFY_RUN_STATES.includes(v), counts: nullable(validCounts), result: nullable(validResult), errorCode: optional(error) },
  timing: { ...run, name: (v) => ["run-start", "first-check", "first-wall-frame"].includes(v), epochMs: (v) => Number.isFinite(v) && v > 0 },
  probe: { q: validProbe, data: (v) => v !== undefined },
};

export function validFrame(frame, direction) {
  if (!record(frame) || typeof frame.type !== "string") return false;
  const schema = (direction === "parent" ? parent : child)[frame.type];
  if (!schema) return false;
  const { type: _type, ...body } = frame;
  if (!shape(body, schema)) return false;
  if (frame.type === "state") {
    if (frame.result && (frame.result.runId !== frame.runId || Object.keys(frame.result.counts).some((key) => frame.counts?.[key] !== frame.result.counts[key]))) return false;
    if (["completed", "blocked"].includes(frame.state) !== (frame.result !== null)) return false;
    if (frame.state === "completed" && (frame.result.errorCode || frame.errorCode)) return false;
    if (frame.state === "blocked" && (!frame.errorCode || frame.result.errorCode !== frame.errorCode)) return false;
  }
  return true;
}

export function createChildLink({ nonce, direction, input, output, onFrame, onError, onLog = () => {} }) {
  const limit = direction === "parent" ? 256 * 1024 : VERIFY_BODY_LIMIT;
  const outgoing = direction === "parent" ? "parent" : "child";
  const incoming = direction === "parent" ? "child" : "parent";
  const prefix = `lv0:${nonce}:`;
  let pending = Buffer.alloc(0);
  let failed = false;
  let logs = 0;
  let dropped = 0;
  let sending = false;
  const queue = [];
  let queuedBytes = 0;
  const fail = (reason) => { if (!failed) { failed = true; onError(new Error(reason)); } };
  const reportLog = (value) => { if (logs++ < 200) onLog(Buffer.from(value).subarray(0, 1800).toString("utf8")); else dropped++; };
  function line(bytes) {
    const raw = bytes.toString("utf8");
    if (!raw.startsWith("lv0:")) return incoming === "child" ? reportLog(raw) : fail("Malformed frame");
    if (!raw.startsWith(prefix)) return fail("Wrong frame nonce");
    let frame;
    try { frame = JSON.parse(raw.slice(prefix.length)); } catch { return fail("Malformed frame JSON"); }
    if (!validFrame(frame, incoming)) return fail("Invalid frame schema");
    if (frame.type === "log" && bytes.length > 2048) return fail("Oversize log frame");
    if (frame.type === "log") return reportLog(frame.msg);
    if (frame.type === "accepted") logs = 0;
    try { onFrame(frame); } catch { fail("Frame handler failed"); }
  }
  function data(chunk) {
    if (failed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset);
      const part = bytes.subarray(offset, end < 0 ? bytes.length : end);
      if (pending.length + part.length > limit) return fail("Oversize frame");
      pending = Buffer.concat([pending, part]);
      if (end < 0) return;
      line(pending);
      pending = Buffer.alloc(0);
      if (failed) return;
      offset = end + 1;
    }
  }
  function flush() {
    if (failed || sending || !queue.length) return;
    sending = true;
    const value = queue.shift();
    queuedBytes -= value.length;
    try { output.write(value, (err) => { sending = false; if (err) fail("Transport write failed"); else flush(); }); }
    catch { sending = false; fail("Transport write failed"); }
  }
  const streamError = () => fail("Transport stream failed");
  const end = () => { if (pending.length) fail("Incomplete frame"); };
  input.on("data", data);
  input.on("error", streamError);
  input.on("end", end);
  output.on("error", streamError);
  return {
    send(frame) {
      if (failed) return false;
      if (outgoing === "child" && frame.type === "cast" && (queuedBytes >= 256 * 1024 || !validFrame(frame, outgoing))) { dropped++; return false; }
      if (frame.type === "accepted") logs = 0;
      if (frame.type === "log" && typeof frame.msg === "string") frame = { ...frame, msg: Buffer.from(frame.msg).subarray(0, 1800).toString("utf8") };
      if (!validFrame(frame, outgoing)) { fail("Invalid outgoing frame"); return false; }
      if (frame.type === "log" && logs++ >= 200) { dropped++; return false; }
      const bytes = Buffer.from(prefix + JSON.stringify(frame) + "\n");
      if (bytes.length - 1 > (outgoing === "parent" ? VERIFY_BODY_LIMIT : 256 * 1024) || queuedBytes + bytes.length > 1024 * 1024) { fail("Transport cap"); return false; }
      queue.push(bytes);
      queuedBytes += bytes.length;
      flush();
      return true;
    },
    resetLogs() { logs = 0; },
    stats: () => ({ dropped, queuedBytes }),
    close() { input.off("data", data); input.off("error", streamError); input.off("end", end); output.off("error", streamError); queue.length = 0; pending = Buffer.alloc(0); },
  };
}
