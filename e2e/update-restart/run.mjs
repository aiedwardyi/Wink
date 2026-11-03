// One side of the update restart check on a fresh Windows runner:
//   node run.mjs before|after   install 1.0.900, update to 1.0.901 through the app's Restart path, time the gap
//   node run.mjs compare        before vs after table, fails when the after side misses its checks
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, join } from "node:path";

const MODE = process.argv[2];
const OUT_ROOT = process.env.OUT_DIR;
const OLD = "1.0.900";
const NEW = "1.0.901";
const PORT = 47123;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log(new Date().toISOString(), ...args);

function ps(command) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true }).trim();
}
const list = (json) => (json ? [JSON.parse(json)].flat() : []);

function entry() {
  const json = ps("Get-ItemProperty 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/*' -ErrorAction SilentlyContinue | Where-Object { \"$($_.DisplayName)\" -like 'Wink *' } | Select-Object DisplayName, DisplayVersion, InstallLocation, QuietUninstallString | ConvertTo-Json -Compress");
  return list(json)[0] ?? null;
}

function processesUnder(dir) {
  const prefix = `${dir}\\`.replaceAll("'", "''");
  return list(ps(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${prefix}', 'OrdinalIgnoreCase') } | Select-Object ProcessId, ExecutablePath | ConvertTo-Json -Compress`));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(what, ms, test, every = 250) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(every);
  }
}

function serveFeed(dir, requests) {
  const server = createServer((req, res) => {
    const name = basename(decodeURIComponent(new URL(req.url, "http://feed").pathname));
    const file = join(dir, name);
    requests.push(`${req.method} ${req.url}`);
    if (!existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-length": statSync(file).size });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

function setupIn(dir) {
  const exe = readdirSync(dir).find((name) => name.endsWith("-setup.exe"));
  if (!exe) throw new Error(`no setup exe in ${dir}`);
  return join(dir, exe);
}

function classify(window, inst, oldPid) {
  const exe = window.exe.toLowerCase();
  if (exe.startsWith(`${inst.toLowerCase()}\\`)) return window.pid === oldPid ? "old" : "new";
  if (/-setup\.exe$|old-uninstaller\.exe$|\\ns[^\\]*\.tmp\\/.test(exe)) return "installer";
  return "other";
}

// Samples are written on change (and once a second), so each one holds until the next.
function analyze(samples, { t0, inst, oldPid }) {
  const rows = samples.filter((s) => Array.isArray(s.w)).sort((a, b) => a.t - b.t);
  const kinds = rows.map((s) => new Set(s.w.map((w) => classify(w, inst, oldPid))));
  const firstNew = rows.findIndex((s, i) => s.t >= t0 && kinds[i].has("new"));
  const tNew = firstNew >= 0 ? rows[firstNew].t : null;
  const end = tNew ?? rows.at(-1)?.t ?? t0;
  let blank = 0;
  let banner = 0;
  let tOldGone = null;
  let tBannerOn = null;
  for (let i = 0; i < rows.length; i++) {
    const from = Math.max(rows[i].t, t0);
    const to = Math.min(rows[i + 1]?.t ?? end, end);
    if (rows[i].t >= t0 && tOldGone === null && !kinds[i].has("old")) tOldGone = rows[i].t;
    if (rows[i].t >= t0 && tBannerOn === null && kinds[i].has("installer")) tBannerOn = rows[i].t;
    if (to <= from) continue;
    if (kinds[i].has("installer")) banner += to - from;
    if (!kinds[i].has("old") && !kinds[i].has("installer") && !kinds[i].has("new")) blank += to - from;
  }
  const installerWindows = new Map();
  for (const s of rows) {
    for (const w of s.w) {
      if (classify(w, inst, oldPid) === "installer") installerWindows.set(`${w.cls}|${w.title}`, { exe: w.exe, cls: w.cls, title: w.title, rect: w.rect });
    }
  }
  const s = (ms) => (ms === null ? null : Math.round(ms / 100) / 10);
  return {
    totalS: tNew === null ? null : s(tNew - t0),
    blankS: s(blank),
    bannerS: s(banner),
    oldGoneS: tOldGone === null ? null : s(tOldGone - t0),
    bannerOnS: tBannerOn === null ? null : s(tBannerOn - t0),
    tNew,
    tOldGone,
    installerWindows: [...installerWindows.values()],
    bannerIntervals: rows.flatMap((r, i) => (kinds[i].has("installer") ? [[r.t, rows[i + 1]?.t ?? r.t]] : [])),
  };
}

function pickShots(shots, out, result, t0) {
  const times = readdirSync(shots).map((f) => Number(basename(f, ".png"))).filter(Number.isFinite).sort((a, b) => a - b);
  const pick = (name, test) => {
    const t = times.find(test);
    if (t === undefined) return null;
    copyFileSync(join(shots, `${t}.png`), join(out, name));
    return `${name} (+${((t - t0) / 1000).toFixed(1)} s)`;
  };
  return {
    updating: pick("updating.png", (t) => t >= t0 + 300 && (result.tOldGone === null || t < result.tOldGone)),
    banner: pick("banner.png", (t) => result.bannerIntervals.some(([a, b]) => t >= a + 300 && t < b)),
    relaunched: pick("relaunched.png", (t) => result.tNew !== null && t >= result.tNew + 2500),
  };
}

function uninstall(inst, userData, cacheDir) {
  for (const p of processesUnder(inst)) spawnSync("taskkill.exe", ["/PID", String(p.ProcessId), "/T", "/F"], { windowsHide: true });
  const e = entry();
  const m = /^"([^"]+)"\s*(.*)$/.exec(e?.QuietUninstallString ?? "");
  if (m) spawnSync(m[1], m[2].split(/\s+/).filter(Boolean), { windowsHide: true, timeout: 120_000 });
  const deadline = Date.now() + 120_000;
  while (entry() && Date.now() < deadline);
  for (const dir of [userData, cacheDir, inst]) if (dir) rmSync(dir, { recursive: true, force: true });
}

async function side(name) {
  const bits = process.env.BITS_DIR;
  const out = join(OUT_ROOT, name);
  const work = join(process.env.WORK_DIR, name);
  const shots = join(out, "shots");
  for (const dir of [out, work]) mkdirSync(dir, { recursive: true });
  const result = { side: name, checks: {} };
  const requests = [];
  const server = await serveFeed(join(bits, NEW), requests);
  let inst = null;
  let userData = null;
  let cacheDir = null;
  let watcher = null;
  const stop = join(work, "stop");
  try {
    if (entry()) throw new Error(`a Wink install already exists: ${JSON.stringify(entry())}`);

    log("install", OLD);
    let t = Date.now();
    const installed = spawnSync(setupIn(join(bits, OLD)), ["/S"], { windowsHide: true, timeout: 300_000 });
    result.installOldS = (Date.now() - t) / 1000;
    const e = entry();
    if (installed.status !== 0 || e?.DisplayVersion !== OLD) throw new Error(`install ${OLD}: exit ${installed.status}, entry ${JSON.stringify(e)}`);
    inst = e.InstallLocation.replace(/\\$/, "");

    // Same updater, same installer path, local feed.
    const yml = join(inst, "resources", "app-update.yml");
    cacheDir = /updaterCacheDirName:\s*(\S+)/.exec(readFileSync(yml, "utf8"))?.[1] ?? null;
    writeFileSync(yml, `provider: generic\nurl: http://127.0.0.1:${PORT}/\nupdaterCacheDirName: ${cacheDir}\n`);
    if (cacheDir) cacheDir = join(process.env.LOCALAPPDATA, cacheDir);

    log("launch", inst);
    const { _electron: electron } = await import("playwright");
    const env = { ...process.env, USERPROFILE: join(work, "home"), HOME: join(work, "home") };
    for (const key of Object.keys(env)) if (/^(ELECTRON_|OMB_|OGB_|ORBIT_|GH_TOKEN|GITHUB_TOKEN)/.test(key)) delete env[key];
    mkdirSync(env.USERPROFILE, { recursive: true });
    const app = await electron.launch({ executablePath: join(inst, "Orbit.exe"), env, timeout: 120_000 });
    const oldPid = app.process().pid;
    userData = await app.evaluate(({ app: a }) => a.getPath("userData"));
    const page = await app.firstWindow();
    await waitFor("the app page", 120_000, () => page.url().startsWith("http://127.0.0.1"));
    await page.waitForFunction(() => Boolean(window.ogb?.updater), null, { timeout: 60_000 });
    await page.evaluate(() => window.ogb.updater.onState((s) => { window.__update = s; }));
    const status = () => page.evaluate(() => window.__update?.status ?? null);
    // The updater starts after the first window, so a check can land before it exists.
    let checked = 0;
    await waitFor("an available update", 180_000, async () => {
      const s = await status();
      if (s === "available" || s === "downloaded") return true;
      if (s !== "checking" && Date.now() - checked > 10_000) {
        checked = Date.now();
        await page.evaluate(() => window.ogb.updater.check()).catch(() => {});
      }
      return false;
    }, 500);
    if ((await status()) === "available") await page.evaluate(() => window.ogb.updater.download());
    await waitFor("the downloaded update", 300_000, async () => (await status()) === "downloaded");
    log("downloaded", NEW);

    const ready = join(work, "ready");
    const samplesFile = join(out, "windows.jsonl");
    watcher = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(import.meta.dirname, "watch.ps1"), "-Out", samplesFile, "-Shots", shots, "-Stop", stop, "-Ready", ready], { stdio: "inherit" });
    await waitFor("the window watcher", 60_000, () => existsSync(ready));
    result.screen = readFileSync(ready, "utf8").trim();
    await sleep(1500);

    // The Restart button's own IPC call.
    const t0 = Date.now();
    page.evaluate(() => { void window.ogb.updater.install(); }).catch(() => {});
    log("install clicked");
    const samples = () => readFileSync(samplesFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    let relaunched = false;
    try {
      await waitFor("the relaunched window", 240_000, () => analyze(samples(), { t0, inst, oldPid }).tNew !== null, 500);
      relaunched = true;
    } catch (error) {
      result.relaunchError = String(error.message);
    }
    await sleep(4000);
    writeFileSync(stop, "");
    await new Promise((resolve) => (watcher.exitCode === null ? watcher.once("exit", resolve) : resolve()));
    watcher = null;

    Object.assign(result, analyze(samples(), { t0, inst, oldPid }));
    const after = entry();
    const productVersion = ps(`(Get-Item -LiteralPath '${join(inst, "Orbit.exe").replaceAll("'", "''")}').VersionInfo.ProductVersion`);
    const running = processesUnder(inst).filter((p) => /\\Orbit\.exe$/i.test(p.ExecutablePath) && p.ProcessId !== oldPid);
    result.relaunch = { seen: relaunched, entryVersion: after?.DisplayVersion ?? null, productVersion, newProcesses: running.length };
    result.checks.relaunchedOnNew = relaunched && after?.DisplayVersion === NEW && productVersion.startsWith(NEW) && running.length > 0;
    result.checks.bannerSeen = result.installerWindows.length > 0;
    result.shots = pickShots(shots, out, result, t0);
    result.feedRequests = requests;

    // A second install while the new build runs: it must stop everything running from the install (the app and
    // its adb server) and nothing outside it, here a same-named Orbit.exe in another folder.
    const adb = join(inst, "resources", "android-platform-tools", "win32", "adb.exe");
    if (existsSync(adb)) spawnSync(adb, ["start-server"], { stdio: "ignore", windowsHide: true, timeout: 60_000 });
    mkdirSync(join(work, "decoy"), { recursive: true });
    const decoyExe = join(work, "decoy", "Orbit.exe");
    copyFileSync(join(process.env.SystemRoot, "System32", "PING.EXE"), decoyExe);
    const decoy = spawn(decoyExe, ["-n", "600", "127.0.0.1"], { stdio: "ignore", windowsHide: true, detached: true });
    await sleep(1500);
    const before = processesUnder(inst);
    t = Date.now();
    const again = spawnSync(setupIn(join(bits, NEW)), ["/S"], { windowsHide: true, timeout: 300_000 });
    const left = before.filter((p) => alive(p.ProcessId));
    result.runningInstall = {
      seconds: (Date.now() - t) / 1000,
      exit: again.status,
      stopped: before.map((p) => basename(p.ExecutablePath)),
      left: left.map((p) => basename(p.ExecutablePath)),
      adbStopped: before.some((p) => /adb\.exe$/i.test(p.ExecutablePath)) ? !left.some((p) => /adb\.exe$/i.test(p.ExecutablePath)) : null,
      decoyAlive: alive(decoy.pid),
      entryVersion: entry()?.DisplayVersion ?? null,
    };
    result.checks.runningInstall = again.status === 0 && before.length > 0 && left.length === 0 && result.runningInstall.decoyAlive && result.runningInstall.entryVersion === NEW;
    try {
      process.kill(decoy.pid);
    } catch {}

    for (const file of ["updater.log", "server.log", "main.log"]) {
      const from = join(userData, "logs", file);
      if (existsSync(from)) copyFileSync(from, join(out, file));
    }
  } catch (error) {
    result.error = String(error?.stack ?? error);
    log("error", result.error);
  } finally {
    if (watcher) {
      writeFileSync(stop, "");
      await sleep(2000);
    }
    server.close();
    if (inst) uninstall(inst, userData, cacheDir);
    result.leftover = { entry: entry(), inst: inst ? existsSync(inst) : null };
    writeFileSync(join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  }
  const { bannerIntervals, tNew, tOldGone, ...shown } = result;
  log(JSON.stringify(shown, null, 2));
  return result;
}

function compare() {
  const read = (name) => JSON.parse(readFileSync(join(OUT_ROOT, name, "result.json"), "utf8"));
  const [b, a] = [read("before"), read("after")];
  const yn = (v) => (v ? "y" : "n");
  const row = (label, f) => `| ${label} | ${f(b)} | ${f(a)} |`;
  const lines = [
    "| | before | after |",
    "|---|---|---|",
    row("relaunched on 1.0.901", (r) => yn(r.checks?.relaunchedOnNew)),
    row("installer window seen", (r) => yn(r.checks?.bannerSeen)),
    row("installer windows", (r) => (r.installerWindows ?? []).map((w) => `${w.cls} "${w.title}" ${w.rect?.slice(2).join("x")}`).join("; ") || "none"),
    row("click to Wink window (s)", (r) => r.totalS ?? "none"),
    row("nothing on screen (s)", (r) => r.blankS ?? "none"),
    row("banner on screen (s)", (r) => r.bannerS ?? "none"),
    row("old window gone at (s)", (r) => r.oldGoneS ?? "none"),
    row("banner up at (s)", (r) => r.bannerOnS ?? "none"),
    row("install over running app (s)", (r) => r.runningInstall?.seconds ?? "none"),
    row("stopped / left / decoy alive", (r) => r.runningInstall ? `${r.runningInstall.stopped.join(",")} / ${r.runningInstall.left.join(",") || "none"} / ${yn(r.runningInstall.decoyAlive)}` : "none"),
    row("shots", (r) => Object.values(r.shots ?? {}).filter(Boolean).join(", ") || "none"),
    row("error", (r) => r.error?.split("\n")[0] ?? r.relaunchError ?? "none"),
  ];
  const table = lines.join("\n");
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Update restart\n\n${table}\n`);
  const ok = a.checks?.relaunchedOnNew && a.checks?.bannerSeen && a.checks?.runningInstall && b.checks?.relaunchedOnNew;
  console.log(`update-restart: ${ok ? "success" : "fail"}`);
  process.exitCode = ok ? 0 : 1;
}

if (MODE === "compare") compare();
else if (MODE === "before" || MODE === "after") {
  const result = await side(MODE);
  if (result.error) process.exitCode = 1;
} else {
  console.error("usage: node run.mjs before|after|compare");
  process.exitCode = 2;
}
