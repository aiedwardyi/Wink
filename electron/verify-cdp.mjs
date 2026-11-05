import { readFileSync } from "node:fs";

const PROBE = readFileSync(new URL("./verify/probe.js", import.meta.url), "utf8");
const failure = (message, code = "page-failed") => Object.assign(new Error(message), { code });

export function attach(webContents) {
  const debuggerApi = webContents.debugger;
  debuggerApi.attach("1.3");
  const pending = new Set(), listeners = new Map();
  let closed = false, generation = 0, context = null;

  function lost() {
    if (closed) return;
    closed = true;
    generation++;
    context = null;
    for (const reject of pending) reject(failure("CDP page detached"));
    pending.clear();
  }
  function invalidated() { generation++; context = null; }
  const dispatch = (_event, method, params) => {
    if (method === "Runtime.executionContextsCleared" || (method === "Page.frameNavigated" && !params.frame?.parentId)) invalidated();
    for (const cb of listeners.get(method) ?? []) {
      try { Promise.resolve(cb(params)).catch(() => {}); } catch {}
    }
  };
  debuggerApi.on("message", dispatch);
  debuggerApi.on("detach", lost);
  webContents.on("destroyed", lost);
  webContents.on("render-process-gone", lost);

  function release(result, late = false) {
    const ids = new Set([result?.result?.objectId, result?.exceptionDetails?.exception?.objectId, late && result?.object?.objectId].filter(Boolean));
    for (const objectId of ids) {
      if (!closed) Promise.resolve(debuggerApi.sendCommand("Runtime.releaseObject", { objectId })).catch(() => {});
    }
  }
  function send(method, params = {}, { timeoutMs = 4000 } = {}) {
    if (closed) return Promise.reject(failure("CDP page detached"));
    return new Promise((resolve, reject) => {
      let active = true;
      const finish = (error, value) => {
        if (!active) return;
        active = false;
        clearTimeout(timer);
        pending.delete(cancel);
        if (error) reject(error);
        else resolve(value);
      };
      const cancel = error => finish(error);
      const timer = setTimeout(() => finish(failure(`CDP timeout: ${method}`)), Math.max(1, Math.min(4000, timeoutMs)));
      pending.add(cancel);
      // A timeout retires this reply, but Chromium still owns the command.
      Promise.resolve().then(() => {
        if (active && !closed) return debuggerApi.sendCommand(method, params);
      }).then(value => {
        release(value, !active);
        if (value?.exceptionDetails) {
          const message = value.exceptionDetails.exception?.description ?? value.exceptionDetails.text ?? "Evaluation failed";
          return finish(failure(message, message.includes("resource-limit") ? "resource-limit" : "page-failed"));
        }
        finish(null, value);
      }, error => finish(failure(error.message ?? "CDP command failed")));
    });
  }
  async function isolated() {
    if (!context) {
      const own = generation;
      context = (async () => {
        const { frameTree } = await send("Page.getFrameTree");
        const { executionContextId } = await send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "lv" });
        if (own !== generation) throw failure("Document changed while creating world");
        return executionContextId;
      })();
      context.catch(() => { if (own === generation) context = null; });
    }
    return context;
  }
  async function ev(expression) {
    const contextId = await isolated(), own = generation;
    const body = expression.trim().replace(/;$/, "");
    const result = await send("Runtime.evaluate", {
      expression: `(async () => { if (!globalThis.lv) { ${PROBE} } const value = await (${body}); const json = JSON.stringify(value); if (json && new TextEncoder().encode(json).length > 2097152) throw new Error("resource-limit"); return value; })()`,
      contextId, returnByValue: true, awaitPromise: true,
    });
    if (own !== generation) throw failure("Document changed during observation");
    return result.result?.value;
  }
  return {
    send,
    ev,
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(cb);
      return () => listeners.get(event)?.delete(cb);
    },
    close() {
      lost();
      listeners.clear();
      debuggerApi.removeListener("message", dispatch);
      debuggerApi.removeListener("detach", lost);
      webContents.removeListener("destroyed", lost);
      webContents.removeListener("render-process-gone", lost);
      try { debuggerApi.detach(); } catch {}
    },
  };
}
