import { StringDecoder } from "node:string_decoder";

export const WORKER_HOST_VERSION = 1;
export const WORKER_HOST_CAPABILITIES = ["list", "attach", "read", "write", "resize", "detach", "spawn", "session-capture"];
const MAX_FRAME = 4 * 1024 * 1024;

export function workerHostPeer(socket, handle, event = () => {}) {
  const pending = new Map();
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let nextId = 0;
  const send = (message) => {
    if (socket.destroyed || socket.writableLength > MAX_FRAME) throw new Error("Background work unavailable");
    const frame = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(frame) > MAX_FRAME) throw new Error("Worker host frame is too large");
    socket.write(frame);
  };
  socket.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      if (end > MAX_FRAME) { socket.destroy(); return; }
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { socket.destroy(); return; }
      if (!message || typeof message !== "object") { socket.destroy(); return; }
      if (message.event) { event(message.event, message.value); continue; }
      if (message.reply) {
        const request = pending.get(message.reply);
        if (!request) continue;
        pending.delete(message.reply);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.value);
        continue;
      }
      if (!Number.isSafeInteger(message.id) || typeof message.method !== "string" || !Array.isArray(message.args)) { socket.destroy(); return; }
      void Promise.resolve().then(() => handle(message.method, message.args)).then(
        (value) => { try { send({ reply: message.id, value }); } catch { socket.destroy(); } },
        (error) => { try { send({ reply: message.id, error: error?.message ?? "Worker host request failed" }); } catch { socket.destroy(); } },
      );
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME) socket.destroy();
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Background work unavailable"));
    }
    pending.clear();
  });
  return {
    request(method, args = [], timeoutMs = 70_000) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("Background work unavailable")); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { send({ id, method, args }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
    emit: (name, value) => send({ event: name, value }),
    close: () => socket.destroy(),
  };
}
