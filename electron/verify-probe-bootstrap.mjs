import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

const scratch = path.resolve(os.tmpdir(), "wink-lv0-host");
const systemEnv = new Set(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "SYSTEMDRIVE"]);
let active = null;
let queryChild;
let readChild;

export function activeVerifyProbe() { return active; }
export function registerVerifyProbe(query, read) { queryChild = query; readChild = read; }
export function verifyProbeWindowOptions(options = {}) {
  return { ...options, show: false, opacity: 0, x: -32000, y: -32000, focusable: false, skipTaskbar: true };
}

export function guardVerifyProbeWindow(win) {
  win.setOpacity(0);
  win.setPosition(-32000, -32000);
  win.setFocusable(false);
  win.setSkipTaskbar(true);
  win.setIgnoreMouseEvents(true);
  const inactive = win.showInactive.bind(win);
  for (const name of ["show", "focus", "moveTop", "restore", "setAlwaysOnTop"]) win[name] = () => {};
  for (const [name, value] of [["setOpacity", 0], ["setFocusable", false], ["setSkipTaskbar", true], ["setIgnoreMouseEvents", true]]) {
    const original = win[name].bind(win);
    win[name] = () => original(value);
  }
  const position = win.setPosition.bind(win);
  win.setPosition = () => position(-32000, -32000);
  const bounds = win.setBounds.bind(win);
  win.setBounds = (value) => bounds({ ...value, x: -32000, y: -32000 });
  win.showInactive = () => { win.setOpacity(0); win.setPosition(-32000, -32000); inactive(); };
  return win;
}

export function prepareVerifyProbe({ app, dialog, env = process.env, root = env.OMB_VERIFY_PROBE_ROOT }) {
  active = null;
  const rawScale = env.OMB_VERIFY_PROBE_SCALE;
  if (rawScale !== undefined && !["1", "1.25", "1.5", "2"].includes(rawScale)) throw new Error("Invalid verify probe scale");
  const scale = rawScale === undefined ? null : Number(rawScale);
  if (typeof root !== "string" || !path.isAbsolute(root) || /^[\\/]{2}/.test(root) || root.includes(":", 2)) {
    throw new Error("Invalid verify probe root");
  }
  const lexical = path.relative(scratch, path.resolve(root));
  if (!lexical || lexical.startsWith("..") || path.isAbsolute(lexical)) throw new Error("Verify probe root is outside scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const base = fs.realpathSync.native(scratch);
  const resolved = fs.realpathSync.native(root);
  const relative = path.relative(base, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Verify probe root is outside scratch");
  const paths = {};
  for (const name of ["home", "appData", "userData", "sessionData", "temp", "logs", "crashDumps"]) {
    paths[name] = path.join(resolved, name);
    fs.mkdirSync(paths[name], { recursive: true });
  }
  for (const name of Object.keys(env)) {
    if (!systemEnv.has(name.toUpperCase())) delete env[name];
  }
  Object.assign(env, {
    OMB_VERIFY_PROBE_ROOT: resolved,
    ...(scale === null ? {} : { OMB_VERIFY_PROBE_SCALE: String(scale) }),
    OMB_USER_DATA: paths.userData,
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.appData,
    TEMP: paths.temp,
    TMP: paths.temp,
    OMB_DATA_DIR: path.join(resolved, "data"),
    XDG_CONFIG_HOME: paths.appData,
    XDG_CACHE_HOME: path.join(resolved, "cache"),
    XDG_DATA_HOME: path.join(resolved, "data"),
  });
  fs.mkdirSync(env.OMB_DATA_DIR, { recursive: true });
  fs.mkdirSync(env.XDG_CACHE_HOME, { recursive: true });
  const bin = path.join(resolved, "bin"); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "stub.mjs"), `import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(path.join(resolved, "cli-calls.ndjson"))}, JSON.stringify({pid:process.pid,args:process.argv.slice(2)})+"\\n");
if(process.argv.includes("--version")) console.log("1.0.0");
else {
  console.log(JSON.stringify({type:"assistant",message:{role:"assistant",content:[{type:"text",text:"Probe reply."}]}}));
  console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"Probe reply.",session_id:"verify-probe",total_cost_usd:0}));
}
`);
  for (const name of ["claude", "codex"]) fs.writeFileSync(path.join(bin, name + ".cmd"), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${path.join(bin, "stub.mjs")}" %*\r\n`);
  env.PATH = [bin, path.dirname(process.execPath), path.join(env.SYSTEMROOT ?? env.SystemRoot ?? "C:\\Windows", "System32")].join(path.delimiter);
  for (const [name, value] of Object.entries(paths)) app.setPath(name, value);

  const windowOptions = verifyProbeWindowOptions;
  const guardWindow = guardVerifyProbeWindow;
  if (dialog) {
    for (const name of ["showOpenDialog", "showSaveDialog", "showMessageBox"]) dialog[name] = async () => { throw new Error("Verify probe dialog refused"); };
    for (const name of ["showOpenDialogSync", "showSaveDialogSync", "showMessageBoxSync", "showErrorBox"]) dialog[name] = () => { throw new Error("Verify probe dialog refused"); };
  }
  let secondInstances = 0;
  app.on("second-instance", () => { secondInstances++; });
  app.on("browser-window-created", (_event, win) => guardWindow(win));
  app.on("web-contents-created", (_event, contents) => { contents.setAudioMuted(true); });
  active = Object.freeze({ root: resolved, scale });
  const surface = {
    ...active, paths: Object.freeze(paths), windowOptions, guardWindow,
    metrics: () => ({ paths, pid: process.pid, secondInstances, child: readChild?.() ?? null }),
    query: (q) => queryChild?.(q),
    allocatePort: () => new Promise((resolve, reject) => {
      const server = createServer(); server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { const port = server.address().port; env.OMB_PORT = String(port); server.close(() => resolve(port)); });
    }),
  };
  if (env === process.env) globalThis.__verifyProbe = Object.freeze({ metrics: surface.metrics, query: surface.query });
  return surface;
}
