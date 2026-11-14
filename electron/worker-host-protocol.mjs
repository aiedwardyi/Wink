import { createHmac, timingSafeEqual } from "node:crypto";

export const WORKER_HOST_PROTOCOL = 1;
const MAX_FRAME = 256 * 1024;
// UTF-8 needs at most 3 bytes per UTF-16 unit, so a chunk this long always fits one frame.
const MAX_CHUNK = 64 * 1024;
const MAX_BACKLOG = 32 * 1024 * 1024;
const CONTROL = 1;
const DATA = 2;
const WRITE = 3;
const ACK = 4;
const RAW = 1;
const UNAVAILABLE = "Worker host unavailable";

export const workerHostProof = (secret, role, clientNonce, hostNonce) => createHmac("sha256", secret).update(`${role}\n${clientNonce}\n${hostNonce}`).digest("hex");

export function sameProof(actual, expected) {
  const left = Buffer.from(String(actual));
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function textChunks(text) {
  if (text.length <= MAX_CHUNK) return [text];
  const chunks = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + MAX_CHUNK);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

export function workerHostPeer(socket, { request = null, event = () => {}, data = null, write = null } = {}) {
  const pending = new Map();
  const acks = new Map();
  let buffered = Buffer.alloc(0);
  let nextId = 0;
  let nextWrite = 0;
  let corked = false;
  const send = (type, ...parts) => {
    let length = 1;
    for (const part of parts) length += part.length;
    if (length > MAX_FRAME) throw new Error("Worker host frame is too large");
    if (socket.destroyed || socket.writableLength > MAX_BACKLOG) {
      socket.destroy();
      throw new Error(UNAVAILABLE);
    }
    const head = Buffer.alloc(5);
    head.writeUInt32LE(length, 0);
    head[4] = type;
    if (!corked) {
      corked = true;
      socket.cork();
      process.nextTick(() => { corked = false; socket.uncork(); });
    }
    socket.write(head);
    for (const part of parts) socket.write(part);
  };
  const control = (message) => send(CONTROL, Buffer.from(JSON.stringify(message)));
  const settle = (map, id, error, value) => {
    const waiting = map.get(id);
    if (!waiting) return;
    map.delete(id);
    clearTimeout(waiting.timer);
    if (error) return waiting.reject(new Error(error));
    waiting.replied?.(value);
    waiting.resolve(value);
  };
  const expect = (map, id, timeoutMs, replied) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => settle(map, id, UNAVAILABLE), timeoutMs);
    map.set(id, { resolve, reject, timer, replied });
  });
  const answer = (id, run) => Promise.resolve().then(run).then(
    (value) => control({ reply: id, value }),
    (error) => control({ reply: id, error: error?.message || "Worker host request failed" }),
  ).catch(() => {});
  const paneFrame = (frame, tail) => {
    const at = 2 + (frame[1] ?? MAX_FRAME);
    if (frame.length < at + tail) throw new Error("Malformed frame");
    return { id: frame.toString("latin1", 2, at), at, body: frame.subarray(at + tail) };
  };
  const receive = (frame) => {
    const type = frame[0];
    if (type === DATA && data) {
      const pane = paneFrame(frame, 6);
      return data(pane.id, frame.readUIntLE(pane.at, 6), pane.body.toString("utf8"));
    }
    if (type === WRITE && write) {
      const pane = paneFrame(frame, 5);
      const reply = Buffer.from(frame.subarray(pane.at, pane.at + 4));
      // Mouse reports are raw bytes; everything else is text.
      const input = frame[pane.at + 4] === RAW ? Buffer.from(pane.body) : pane.body.toString("utf8");
      return void Promise.resolve().then(() => write(pane.id, input)).then(
        () => send(ACK, reply),
        (error) => send(ACK, reply, Buffer.from(error?.message || "Write failed")),
      ).catch(() => {});
    }
    if (type === ACK && frame.length >= 5) return settle(acks, frame.readUInt32LE(1), frame.toString("utf8", 5));
    if (type !== CONTROL) throw new Error("Malformed frame");
    const message = JSON.parse(frame.toString("utf8", 1));
    if (message.event) return event(message.event, message.value);
    if (message.reply) return settle(pending, message.reply, message.error, message.value);
    if (!request || !Number.isSafeInteger(message.id) || !Array.isArray(message.args)) throw new Error("Malformed frame");
    return void answer(message.id, () => request(String(message.method), message.args));
  };
  socket.on("data", (chunk) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    try {
      while (buffered.length >= 4) {
        const length = buffered.readUInt32LE(0);
        if (length < 1 || length > MAX_FRAME) throw new Error("Malformed frame");
        if (buffered.length < 4 + length) return;
        const frame = buffered.subarray(4, 4 + length);
        buffered = buffered.subarray(4 + length);
        receive(frame);
      }
    } catch {
      socket.destroy();
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    for (const map of [pending, acks]) for (const id of map.keys()) settle(map, id, UNAVAILABLE);
  });
  const paneHead = (id, tail) => {
    const head = Buffer.alloc(1 + id.length + tail);
    head[0] = id.length;
    head.write(id, 1, "latin1");
    return head;
  };
  return {
    /** `replied` runs before the next frame is read; a promise callback would run after the whole chunk. */
    request(method, args = [], timeoutMs = 10_000, replied = null) {
      const id = ++nextId;
      const reply = expect(pending, id, timeoutMs, replied);
      try { control({ id, method, args }); } catch (error) { settle(pending, id, error.message); }
      return reply;
    },
    emit: (name, value) => control({ event: name, value }),
    data(id, seq, bytes) {
      const head = paneHead(id, 6);
      head.writeUIntLE(seq, 1 + id.length, 6);
      send(DATA, head, bytes);
    },
    write(id, input, timeoutMs = 10_000) {
      const request = nextWrite = (nextWrite % 0xffffffff) + 1;
      const head = paneHead(id, 5);
      head.writeUInt32LE(request, 1 + id.length);
      head[5 + id.length] = Buffer.isBuffer(input) ? RAW : 0;
      const reply = expect(acks, request, timeoutMs);
      try { send(WRITE, head, Buffer.from(input)); } catch (error) { settle(acks, request, error.message); }
      return reply;
    },
    close: () => socket.destroy(),
  };
}
