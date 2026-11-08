import { chunk } from "./verify-replay.mjs";

export function createCastStream(input, started) {
  const head = chunk(0, { v: 1, runId: input.runId, site: input.site, page: input.entry, startedAt: started, tiles: { desktop: [1280, 720], phone: [392, 800] } });
  const marks = [], latest = new Map(), streams = new Set();
  let markBytes = 0, end, offset = 0;
  function publish(bytes, frame = false) {
    for (const stream of streams) {
      if (stream.res.destroyed || stream.res.writableEnded) { streams.delete(stream); continue; }
      if (frame && stream.blocked) continue;
      if (!stream.res.write(bytes)) stream.blocked = true;
    }
  }
  return {
    frame(value) {
      if (end) return;
      const bytes = chunk(1, { ...value, ms: value.ms + offset, data: Buffer.from(value.data, "base64") });
      latest.set(value.tile, bytes);
      publish(bytes, true);
    },
    mark(event) {
      if (end || marks.length >= 2000) return;
      if (event.kind === "start") offset = Math.max(0, event.emittedAt - started);
      const bytes = chunk(2, { ...event, ms: Math.max(0, Math.round(event.emittedAt - started)) });
      if (markBytes + bytes.length > 2 * 1024 * 1024) return;
      markBytes += bytes.length; marks.push(bytes); publish(bytes);
    },
    finish(result) {
      if (end) return;
      end = chunk(3, { status: result.errorCode ? "blocked" : "completed", ms: Math.round(result.durationMs + offset), issues: result.issues, notChecked: result.notChecked ?? [] });
      publish(end);
      for (const stream of streams) stream.res.end();
      streams.clear();
    },
    open(res) {
      if (streams.size >= 2) throw Object.assign(new Error("busy"), { status: 429 });
      res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      const stream = { res, blocked: false };
      res.on("drain", () => { stream.blocked = false; });
      res.once("close", () => streams.delete(stream));
      for (const bytes of [head, ...latest.values(), ...marks]) if (!res.write(bytes)) stream.blocked = true;
      if (end) { res.end(end); return; }
      streams.add(stream);
    },
  };
}
