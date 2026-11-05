import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = path.resolve(os.tmpdir(), "wink-lv0-host");
const systemEnv = new Set(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "SYSTEMDRIVE"]);

export function prepareVerifyProbe({ app, env = process.env, root = env.OMB_VERIFY_PROBE_ROOT }) {
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
  for (const [name, value] of Object.entries(paths)) app.setPath(name, value);

  const windowOptions = (options = {}) => ({ ...options, show: false, opacity: 0, x: -32000, y: -32000, focusable: false, skipTaskbar: true });
  function guardWindow(win) {
    win.setOpacity(0);
    win.setPosition(-32000, -32000);
    win.setFocusable(false);
    win.setSkipTaskbar(true);
    win.setIgnoreMouseEvents(true);
    const inactive = win.showInactive.bind(win);
    for (const name of ["show", "focus", "moveTop", "restore"]) win[name] = () => {};
    for (const [name, value] of [["setOpacity", 0], ["setFocusable", false], ["setSkipTaskbar", true], ["setIgnoreMouseEvents", true]]) {
      const original = win[name].bind(win);
      win[name] = () => original(value);
    }
    const position = win.setPosition.bind(win);
    win.setPosition = () => position(-32000, -32000);
    const bounds = win.setBounds.bind(win);
    win.setBounds = (value) => bounds({ ...value, x: -32000, y: -32000 });
    win.showInactive = () => {
      win.setOpacity(0);
      win.setPosition(-32000, -32000);
      inactive();
    };
    return win;
  }
  app.on("browser-window-created", (_event, win) => guardWindow(win));
  app.on("web-contents-created", (_event, contents) => { contents.setAudioMuted(true); });
  return { root: resolved, paths: Object.freeze(paths), windowOptions, guardWindow };
}
