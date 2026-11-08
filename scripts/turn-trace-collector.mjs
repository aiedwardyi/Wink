import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// A turn resumes or starts a Codex thread, never both.
const untaken = (spans, span) => ["resume", "start"].includes(span.phase) && spans.some((other) => other.phase === (span.phase === "resume" ? "start" : "resume") && other.start !== null);

export function collectTurnTraces(records) {
  const traces = new Map(records.filter((row) => row.version === 2 && row.traceId).map((row) => [row.traceId, row]));
  return [...traces.values()].map((row) => {
    const calls = row.requests.filter((call) => !call.nested);
    const known = calls.every((call) => call.id !== null && call.usage !== null);
    const sum = known && calls.length ? calls.reduce((total, call) => ({ input: total.input + call.usage.input, output: total.output + call.usage.output }), { input: 0, output: 0 }) : null;
    const result = row.reconciliation.delta ?? row.reconciliation.result;
    return {
      traceId: row.traceId,
      botId: row.botId,
      threadId: row.threadId,
      sendId: row.sendId,
      batchId: row.batchId,
      sourceMessageIds: row.sourceMessageIds,
      sourceSendIds: row.sourceSendIds,
      scope: row.batchId ? "helper" : "foreground",
      calls: calls.length,
      sum,
      result,
      reconciled: sum && result ? sum.input === result.input && sum.output === result.output : null,
      nested: row.requests.filter((call) => call.nested),
      incomplete: !sum || !result || Boolean(row.batchId && !row.sourceMessageIds?.length),
      unknownPhases: row.spans.filter((span) => (span.start === null || span.end === null) && !span.reason?.endsWith("/unobservable") && !untaken(row.spans, span)).map((span) => ({ phase: span.phase, reason: span.reason })),
    };
  });
}

export async function traceNoteWait(identity, wait, options = {}) {
  if (!options.enabled) return wait();
  const now = options.now ?? (() => performance.now());
  const start = now();
  let reason = "error";
  try {
    const result = await wait();
    reason = result.reason;
    return result;
  } finally {
    try { options.write?.({ version: 2, ...identity, phase: "note_wait", pid: process.pid, ts: new Date().toISOString(), monotonicOrigin: performance.timeOrigin, start, end: now(), reason }); } catch {}
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const records = process.argv.slice(2).flatMap((path) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
  process.stdout.write(`${JSON.stringify({ traces: collectTurnTraces(records), schemas: records.filter((row) => row.kind === "tool_schemas"), completeCost: false }, null, 2)}\n`);
}
