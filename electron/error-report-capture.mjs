import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ERROR_SITES } from "../shared/error-report.mjs";
import { trustedTerminalSender } from "./terminal-host.mjs";

// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Renderer error detail crosses the IPC boundary.
const text = (value) => typeof value === "string" ? value : "";

// The stack opens with the message, which can hold user text shaped like a frame.
function framesOf({ name, message, stack }) {
  const header = message ? `${name}: ${message}` : name;
  return stack.startsWith(header) ? stack.slice(header.length) : null;
}

export function shippedChunks(uiDir) {
  try {
    return new Set(fs.readdirSync(path.join(uiDir, "assets")).filter((name) => /\.m?js$/.test(name)));
  } catch {
    return new Set();
  }
}

export function rendererFrame(error, origin, chunks) {
  for (const line of (framesOf(error) ?? "").split("\n")) {
    const match = /^\s+at (?:.*\()?(\S+):(\d+):(\d+)\)?$/.exec(line);
    if (!match) continue;
    try {
      const url = new URL(match[1]);
      const name = url.pathname.split("/").pop();
      // The whole href, not the origin: a blob: URL shares the page's origin.
      if (url.href === `${origin}/assets/${name}` && chunks.has(name)) return `${name}:${match[2]}:${match[3]}`;
    } catch {}
  }
  return "";
}

export function registerErrorReportIpc(ipc, reports, owner, origin, { chunks = new Set() } = {}) {
  const authorize = (event) => {
    if (!trustedTerminalSender(event, owner(), origin())) throw new Error("Untrusted error report caller");
  };
  ipc.handle("error-reports:get", (event) => { authorize(event); return reports.available() ? reports.consent() : null; });
  ipc.handle("error-reports:set", (event, value) => { authorize(event); return reports.setConsent(value); });
  ipc.on("error-reports:capture", (event, site, detail) => {
    if (!trustedTerminalSender(event, owner(), origin())) return;
    if (site !== ERROR_SITES.rendererError && site !== ERROR_SITES.rendererRejection) return;
    const error = { name: text(detail?.name), message: text(detail?.message), stack: text(detail?.stack) };
    reports.capture({ process: "renderer", code: "UNKNOWN_ERROR", site, errorName: error.name, frame: rendererFrame(error, origin(), chunks) });
  });
}

export function installErrorReportCapture(app, reports, owner) {
  app.on("render-process-gone", (_event, contents, details) => {
    if (contents === owner() && details.reason !== "clean-exit") reports.capture({ process: "renderer", code: "RENDERER_GONE", site: ERROR_SITES.rendererGone, exitCode: details.exitCode });
  });
}

export async function handleServerErrorReport(req, res, token, reports) {
  const expected = createHmac("sha256", token).update("orbit-error-report-v1").digest("base64url");
  const received = Buffer.from(req.headers.authorization ?? "");
  const auth = Buffer.from(`Bearer ${expected}`);
  let status = 400;
  if (received.length !== auth.length || !timingSafeEqual(received, auth)) status = 401;
  else if (req.method !== "POST") status = 405;
  else {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024) throw new Error("Report too large");
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (Object.keys(input).length === 2 && input.code === "SERVER_RUNTIME_FAILURE" && [ERROR_SITES.serverRuntime, ERROR_SITES.chatRace, ERROR_SITES.usageRefresh, ERROR_SITES.chatQueue].includes(input.site)) {
        reports.capture({ process: "server", code: input.code, site: input.site });
        status = 204;
      } else if (Object.keys(input).length === 1 && input.consent === false) {
        reports.setConsent(false);
        status = 204;
      }
    } catch {}
  }
  res.writeHead(status);
  res.end();
}
