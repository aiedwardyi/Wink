import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { links } from "./sim-phone-menu-fixture.mjs";

const prefix = "sim/phoneMenu/";
const scopes = ["ordinary", "unrelated", "unbound", "sameName", "room", "deleted", "superseded", "repeat"];
const cases = ["predictionOutcome", "firstPass", "repeatsBeforePass", "scope", "cost"];
const percentile = (values, p) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const stats = values => ({ p50: percentile(values, 0.5), p95: percentile(values, 0.95) });
const observed = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const same = (left, right, key) => Boolean(left[key] && left[key] === right[key]);

function pairGap(off, on) {
  if (!off || !on) return "one or both arms are missing";
  if (off.status !== "done" || on.status !== "done") return [off, on].filter(arm => arm.status !== "done").map(arm => arm.reason ?? arm.status ?? "arm stalled").join("; ");
  if (off.historyCount !== 0 || on.historyCount !== 0 || !off.threadId || !on.threadId || off.threadId === on.threadId
    || !off.sessionId || !on.sessionId || off.sessionId === on.sessionId) return "fresh threads and native sessions were not verified";
  if (!["fixtureHash", "requestHash", "memoryHash", "model", "build"].every(key => same(off, on, key)) || !observed(off.budget) || off.budget !== on.budget) {
    return "fixture, request, saved memory, model, build or budget did not match";
  }
  if (off.lessonOffered !== false || on.lessonOffered !== true) return "handoff exposure did not match the assigned arms";
  return "";
}

function predictionGrade({ lesson, before, after }) {
  if (!lesson || !before || !after) return undefined;
  const outcome = after.check === "passed" ? "fixed" : after.check === "missed" ? "missed" : "skipped";
  return Number(lesson.predictedAt <= after.startedAt && before.endedAt <= lesson.predictedAt
    && lesson.beforeRunId === before.runId && lesson.afterRunId === after.runId
    && before.runId !== after.runId && before.check === "missed" && lesson.outcome === outcome);
}

const passed = cycle => cycle.check === "passed" && cycle.width === 392 && cycle.opens === true && links.every(link => cycle.links?.includes(link));
const scope = arm => scopes.every(key => observed(arm.scope?.[key])) ? Number(scopes.every(key => arm.scope[key] === 0)) : undefined;
const traceUsage = trace => {
  if (!trace?.requests?.length || trace.requests.some(row => !row.usage)) return undefined;
  const usage = trace.requests.find(row => !row.nested)?.usage;
  if (!usage || !observed(usage.input) || !observed(usage.output)) return undefined;
  return usage;
};
const duration = (trace, phase) => {
  const span = trace.spans?.find(row => row.phase === phase && observed(row.start) && observed(row.end));
  return span && span.end >= span.start ? span.end - span.start : undefined;
};
function costs(off, on, cohort) {
  const a = off.traces?.[cohort], b = on.traces?.[cohort];
  if (!a?.length || a.length !== b?.length) return undefined;
  const samples = a.map((left, i) => {
    const right = b[i];
    const x = traceUsage(left), y = traceUsage(right);
    const buildOff = duration(left, "prompt_build"), buildOn = duration(right, "prompt_build");
    const lookupOff = duration(left, "forum_lesson"), lookupOn = duration(right, "forum_lesson");
    const firstOff = left.marks?.first_visible_text, firstOn = right.marks?.first_visible_text;
    if (!x || !y || ![buildOff, buildOn, lookupOff, lookupOn, firstOff, firstOn].every(observed)) return undefined;
    return {
      promptMs: buildOn - buildOff,
      lookupMs: lookupOn - lookupOff,
      firstVisibleMs: firstOn - firstOff,
      inputTokens: y.input - x.input,
      outputTokens: y.output - x.output,
    };
  });
  if (samples.some(row => !row)) return undefined;
  return {
    samples,
    promptMs: stats(samples.map(row => row.promptMs)),
    lookupMs: stats(samples.map(row => row.lookupMs)),
    firstVisibleMs: stats(samples.map(row => row.firstVisibleMs)),
  };
}

export function phoneMenuRows(pairs) {
  return pairs.flatMap(pair => {
    const { off, on } = pair;
    const gap = pairGap(off, on);
    const ordinary = gap ? undefined : costs(off, on, "ordinary");
    const matching = gap ? undefined : costs(off, on, "matching");
    const cost = ordinary && matching ? Number(
      [ordinary, matching].every(group => group.lookupMs.p95 < 100 && group.promptMs.p95 < 100)
      && ordinary.samples.every(row => row.inputTokens === 0)
      && matching.samples.every(row => row.inputTokens >= 0 && row.inputTokens <= 120),
    ) : undefined;
    return ["off", "on"].flatMap(side => {
      const arm = side === "off" ? off : on;
      const cycles = arm?.cycles ?? [];
      const first = cycles.findIndex(passed);
      const values = gap ? [] : [predictionGrade(arm), cycles.length ? Number(first === 0) : undefined, first < 0 ? undefined : first, scope(arm), cost];
      return cases.map((metric, i) => ({
        metric: prefix + metric,
        pair: pair.id,
        side,
        build: arm?.build ?? "unknown",
        model: arm?.model ?? "unknown",
        runId: arm?.runId ?? null,
        value: values[i] ?? null,
        reason: gap || (values[i] === undefined ? first < 0 && metric === "repeatsBeforePass" && cycles.length ? "no verified pass within budget" : "evidence missing" : ""),
        ...(metric === "cost" ? { ordinary, matching } : {}),
        ...(metric === "predictionOutcome" ? { prediction: arm?.lesson ?? null } : {}),
        ...(metric === "firstPass" || metric === "repeatsBeforePass" ? { cycles } : {}),
        ...(metric === "scope" ? { observations: arm?.scope ?? null } : {}),
      }));
    });
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [input, out] = process.argv.slice(2);
  if (!input || !out) throw new Error("usage: node scripts/sim-phone-menu-eval.mjs <paired-proof.json> <night-root>/sim-phone-menu/rows.json");
  const { pairs } = JSON.parse(readFileSync(input, "utf8"));
  if (!Array.isArray(pairs) || !pairs.length) throw new Error("paired-proof.json must name its attempted pairs, including blocked arms");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ rows: phoneMenuRows(pairs) }, null, 2) + "\n", { flag: "wx" });
}
