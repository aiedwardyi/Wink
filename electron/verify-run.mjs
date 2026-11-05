import { readFileSync } from "node:fs";

import { attach } from "./verify-cdp.mjs";
import { checks, SCROLL, world } from "./verify-checks.mjs";
import { conduct, finalize, pickLive, scanScore } from "./verify-conduct.mjs";
import { VERIFY_BAR_MS, VERIFY_BARS, VERIFY_FINALIZE_BAR, VERIFY_GEOMETRY, VERIFY_RUN_MS, verifyShowTime } from "./verify-protocol.mjs";

const CAMERA = readFileSync(new URL("./verify/camera.js", import.meta.url), "utf8");
const META = new Set(["MAP", "PLAN", "VIEW"]);
const ORDER = ["TEXT_A", "TEXT_B", "HEADINGS", "LINKS", "FONT", "CONTRAST", "BUTTONS", "NAV", "CLICK", "FORM", "FIT"];
const J = JSON.stringify;
const fail = code => Object.assign(new Error(code), { code });
const bytes = value => Buffer.byteLength(J(value));
const plain = (value, n) => String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, n);

export function runVerify(input) {
  const started = Date.now(), adapters = {}, pages = {}, disposers = [], timers = new Set();
  const monotonic = performance.now(), now = () => started + performance.now() - monotonic;
  const ledger = new Map(), observations = [];
  let seq = 0, eventBytes = 0, planBytes = 2, score = null, clock = null, loaded = false, stopped = false, sealed = false;
  let scan = true, liveOwner = false, converging = false, inputGeneration = 0, lane = Promise.resolve(), lastScroll = -Infinity;
  let dialog = null, firstCheck = false, frozenCounts = null;
  let rejectFailure;
  const failed = new Promise((_resolve, reject) => rejectFailure = reject);
  failed.catch(() => {});
  const race = promise => Promise.race([promise, failed]);
  const cancel = code => { if (!stopped) rejectFailure(fail(code)); };
  const abort = () => cancel("cancelled");
  input.signal.addEventListener("abort", abort, { once: true });
  disposers.push(() => input.signal.removeEventListener("abort", abort));
  const deadline = setTimeout(() => cancel("timeout"), VERIFY_RUN_MS);
  timers.add(deadline);
  const sleep = ms => race(new Promise(resolve => {
    const timer = setTimeout(() => { timers.delete(timer); resolve(); }, Math.max(0, ms));
    timers.add(timer);
  }));
  const until = epoch => sleep(Math.max(0, epoch - now()));
  const time = () => clock ? verifyShowTime(clock, now(), loaded) : 0;

  function counts() {
    if (frozenCounts) return { ...frozenCounts };
    const rows = [...ledger.values()], planned = rows.length;
    const passed = rows.filter(x => x.event?.result === "ok").length;
    const failed = rows.filter(x => x.event?.result === "issue").length;
    const blocked = rows.filter(x => x.event?.result === "blocked").length;
    const completed = passed + failed + blocked;
    return { planned, completed, passed, failed, blocked, notRun: planned - completed };
  }
  function publish(event) {
    const value = JSON.parse(J({ ...event, seq: seq + 1, emittedAt: Math.round(now()) }));
    const size = bytes(value);
    if ((seq >= 1998 && !["finalize", "end"].includes(event.kind)) || seq >= 2000 || eventBytes + size > 2 * 1024 * 1024) throw fail("resource-limit");
    seq++;
    eventBytes += size;
    input.emit(value);
  }
  function planned(jobs) {
    if (sealed || stopped) return;
    for (const job of jobs) {
      const key = J([job.tile, job.checker, job.kind, job.path, job.stop]);
      if (!ledger.has(key)) {
        const size = bytes(job) + 1;
        if (planBytes + size > 64 * 1024) throw fail("resource-limit");
        planBytes += size;
        ledger.set(key, { ...job });
      }
    }
    input.progress(counts());
  }
  function log(event) {
    if (sealed || stopped) return event;
    if (META.has(event.checker)) { observations.push(event); return event; }
    const row = [...ledger.values()].find(x => !x.event && x.tile === event.tile && x.checker === event.checker && x.kind === event.kind && x.path === event.path && (event.stop == null || x.stop === event.stop));
    if (row) row.event = event;
    if (!firstCheck && event.result !== "blocked") { firstCheck = true; input.onTiming?.("first-check", Math.round(now())); }
    if (event.result !== "blocked") observations.push(event);
    input.progress(counts());
    return event;
  }
  const C = checks(log, planned);
  async function metrics(tile) {
    const g = VERIFY_GEOMETRY[tile];
    const scale = input.scale(tile);
    if (!Number.isFinite(scale) || scale <= 0) throw fail("isolation-failed");
    await adapters[tile].send("Emulation.setDeviceMetricsOverride", { width: g.cssW, height: g.cssH, deviceScaleFactor: g.dpr, mobile: g.mobile, scale });
  }
  async function camera(tile) {
    if (!adapters[tile] || stopped) return;
    await adapters[tile].ev(`(() => {
      if (!globalThis.LiveVerifyCamera) { ${CAMERA} }
      if (!globalThis.lvCameraState) {
        globalThis.lvCameraState = {};
        const tick = () => {
          const s = globalThis.lvCameraState;
          if (!s) return;
          if (!s.suspended && s.score && s.clock) {
            const t = (${verifyShowTime.toString()})(s.clock, performance.timeOrigin + performance.now(), s.loaded);
            const y = LiveVerifyCamera.scrollAt(s.score, ${J(tile)}, Math.min(t, ${VERIFY_BARS * VERIFY_BAR_MS - 1}));
            if (y !== null && Math.round(scrollY) !== y) scrollTo({ top: y, behavior: "instant" });
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }
      Object.assign(globalThis.lvCameraState, ${J({ clock, loaded, suspended: scan || (tile === "desktop" && liveOwner) || (sealed && !converging), score })});
      return true;
    })()`);
  }
  async function setup(tile) {
    const page = input.pages[tile], cdp = adapters[tile] = attach(page);
    const requests = new Set();
    let activity = now();
    for (const name of ["render-process-gone", "destroyed", "unresponsive"]) {
      const handler = () => cancel("page-failed");
      page.on(name, handler);
      disposers.push(() => page.removeListener(name, handler));
    }
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    disposers.push(cdp.on("Network.requestWillBeSent", event => { requests.add(event.requestId); activity = now(); }));
    for (const event of ["Network.loadingFinished", "Network.loadingFailed"]) disposers.push(cdp.on(event, data => { requests.delete(data.requestId); activity = now(); }));
    await cdp.send("Network.enable");
    disposers.push(cdp.on("Page.javascriptDialogOpening", d => {
      dialog = { at: Date.now(), text: `${plain(d.type, 16)} "${plain(d.message, 24)}"` };
      return cdp.send("Page.handleJavaScriptDialog", { accept: true, promptText: "" }).catch(() => cancel("page-failed"));
    }));
    disposers.push(cdp.on("Page.fileChooserOpened", d => cdp.send("DOM.setFileInputFiles", { files: [], backendNodeId: d.backendNodeId }).catch(() => cancel("isolation-failed"))));
    try { await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }); } catch { throw fail("isolation-failed"); }
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await metrics(tile);
    if (tile === "phone") await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await page.loadURL(input.url);
    pages[tile] = await world(cdp, tile);
    await cdp.ev("document.fonts.ready.then(() => document.fonts.size)");
    await camera(tile);
    while (requests.size || now() - activity < 300) await sleep(50);
    const restored = () => {
      if (!stopped) camera(tile).catch(error => { if (!stopped) cancel(error.code ?? "page-failed"); });
    };
    page.on("did-finish-load", restored);
    disposers.push(() => page.removeListener("did-finish-load", restored));
  }
  function result(errorCode) {
    const issues = [...ledger.values()].filter(row => row.event?.result === "issue").sort((a, b) => ORDER.indexOf(a.checker) - ORDER.indexOf(b.checker)).map(row => {
      const e = row.event;
      const issue = { checker: e.checker, tile: e.tile, rule: plain(e.kind, 120), where: plain(`${e.path ?? "page"} ${e.label ?? ""}`.trim(), 120), measured: plain(e.value, 160) };
      if (Number.isFinite(e.scroll ?? e.mscroll)) issue.scrollY = e.scroll ?? e.mscroll;
      return issue;
    });
    const value = { v: 1, runId: input.runId, site: plain(input.site, 1024), counts: counts(), issues: issues.slice(0, 40), issueTotal: issues.length, durationMs: Math.max(0, Date.now() - started) };
    if (errorCode) value.errorCode = errorCode;
    while (value.issues.length && J(value).length > 8000) value.issues.pop();
    for (const n of Object.values(value.counts)) if (!Number.isSafeInteger(n) || n < 0) throw fail("internal");
    for (const issue of value.issues) Object.freeze(issue);
    Object.freeze(value.counts); Object.freeze(value.issues);
    return Object.freeze(value);
  }
  const current = generation => { if (sealed || stopped || generation !== inputGeneration) throw fail("cancelled"); };
  async function scrollEvent() {
    if (sealed || stopped || !liveOwner || Date.now() - lastScroll < 34) return;
    lastScroll = Date.now();
    const y = await adapters.desktop.ev(SCROLL);
    if (!sealed && !stopped && Number.isFinite(y)) publish({ kind: "scroll", tile: "desktop", y });
  }
  async function stamp(key, ev, generation) {
    current(generation);
    const hop = score.hops.find(h => h.live === key);
    if (hop) {
      hop.pending = false;
      if (ev.result === "skip") hop.skip = true;
      else hop.ts = Math.max(hop.ts, Math.ceil(time() / (score.beat / 4) - 1e-6) * (score.beat / 4));
    }
    const row = ledger.get(`live:${key}`);
    if (row && !row.event && ev.result !== "skip") { row.event = { ...ev, tile: "desktop" }; observations.push(row.event); }
    input.progress(counts());
    publish({ kind: "result", key, ev: { ...ev, tile: "desktop" }, t: time() });
  }
  async function aimed(inp, type, generation) {
    current(generation);
    const y = await adapters.desktop.ev(SCROLL);
    current(generation);
    publish({ kind: "point", inp, scrollY: y });
    const x = inp.x ?? 200, py = inp.doc && !inp.pin ? inp.y - y : (inp.y ?? 200);
    if (!Number.isFinite(x) || !Number.isFinite(py)) throw fail("page-failed");
    const params = { type, x, y: py };
    if (type !== "mouseMoved") Object.assign(params, { button: "left", clickCount: 1 });
    await adapters.desktop.send("Input.dispatchMouseEvent", params);
  }
  async function mouseClick(inp, generation) {
    const cdp = adapters.desktop;
    await cdp.ev("lv.allow(true)");
    try {
      await aimed(inp, "mouseMoved", generation);
      await aimed(inp, "mousePressed", generation);
      await aimed(inp, "mouseReleased", generation);
    } finally { await cdp.ev("lv.allow(false)").catch(() => {}); }
  }
  async function wheel(inp, generation) {
    const cdp = adapters.desktop;
    await cdp.ev("lv.allow(true)");
    try {
      await aimed(inp, "mouseMoved", generation);
      for (let pass = 0; pass < 2; pass++) {
        const left = inp.to - await cdp.ev(SCROLL), n = Math.ceil(Math.abs(left) / 240);
        if (Math.abs(left) < 40) break;
        for (let i = 0; i < n; i++) {
          current(generation);
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 200, y: 200, deltaX: 0, deltaY: left / n });
          await sleep(20);
        }
        await sleep(120);
      }
    } finally { await cdp.ev("lv.allow(false)").catch(() => {}); }
  }
  async function action(inp, live, generation) {
    current(generation);
    liveOwner = true;
    await camera("desktop");
    const T = pages.desktop, cdp = adapters.desktop;
    try {
      if (inp.type === "park") return;
      if (inp.type === "wheel") return await wheel(inp, generation);
      const nav = inp.key.startsWith("nav"), item = nav ? live.nav[+inp.key.match(/^nav(\d+)/)[1]] : inp.key.startsWith("form") ? live.input : live.button;
      if (inp.type === "move") {
        await wheel({ to: 0, tile: "desktop", type: "wheel", key: inp.key }, generation);
        const before = await C.live.hoverBefore(T, item.path);
        await aimed(inp, "mouseMoved", generation);
        await stamp(inp.key, await C.live.hoverAfter(T, item.path, before, nav ? "NAV" : "CLICK", "desktop", item), generation);
      } else if (inp.type === "click" && nav) {
        const y0 = await cdp.ev(SCROLL), t0 = Date.now();
        await mouseClick(inp, generation);
        const [click, land] = await C.live.navClick(T, item, y0);
        const i = inp.key.match(/^nav(\d+)/)[1];
        if (dialog?.at >= t0 && click.result === "issue") Object.assign(click, { result: "ok", value: `${item.href} -> ${dialog.text}` });
        await stamp(`nav${i}:click`, click, generation);
        await stamp(`nav${i}:land`, land, generation);
      } else if (inp.type === "click" && inp.key === "btn:click") {
        const before = await cdp.ev("lv.snap()"), y0 = await cdp.ev(SCROLL), hash0 = await cdp.ev("location.hash"), t0 = Date.now();
        await mouseClick(inp, generation);
        const o = await C.live.opened(T, before, item);
        const base = { checker: "CLICK", tile: "desktop", path: item.path, label: item.name || item.tag };
        if (o.open) {
          current(generation);
          publish({ kind: "opened", key: "btn:open", t: time() });
          await stamp("btn:open", { ...base, kind: "open", box: o.box, pin: o.pin, mscroll: await cdp.ev(SCROLL), label: o.tag, result: "ok", value: `opened ${o.tag} · ${[...o.text].length} ch`, detail: o }, generation);
          let open = true;
          const end = inp.t + 3 * score.beat;
          while (open && time() < end) { current(generation); await sleep(40); open = await cdp.ev(`lv.still(${J(o.path)})`); }
          const held = Date.now() - t0;
          await stamp("btn:close", { ...base, kind: "close", box: o.box, pin: o.pin, label: o.tag, result: "ok", value: open ? `stays open ${(held / 1000).toFixed(1)}s+` : `closed after ${(held / 1000).toFixed(2)}s`, held_ms: open ? null : held }, generation);
        } else {
          const y1 = await cdp.ev(SCROLL), hash1 = await cdp.ev("location.hash"), moved = y1 !== y0 || hash1 !== hash0, dl = dialog?.at >= t0 ? dialog.text : null;
          await stamp("btn:open", { ...base, kind: "open", box: item.box, pin: item.pin, result: moved || dl ? "ok" : "issue", value: dl ?? (moved ? `page moved ${y1 - y0 >= 0 ? "+" : ""}${y1 - y0}px` : "no visible change") }, generation);
          await stamp("btn:close", { ...base, kind: "close", result: "skip" }, generation);
        }
      } else if (inp.type === "click") {
        await mouseClick(inp, generation);
        await sleep(60);
        const ok = await cdp.ev(`document.activeElement === document.querySelector(${J(item.path)})`);
        await stamp("form:focus", { checker: "FORM", tile: "desktop", kind: "focus", path: item.path, box: item.box, pin: item.pin, label: item.name || item.tag, result: ok ? "ok" : "issue", value: ok ? "focused · caret in" : "click did not focus" }, generation);
      } else if (inp.type === "type") {
        const t0 = Date.now();
        for (let i = 0; i < inp.text.length; i++) {
          await until(t0 + i * inp.every);
          current(generation);
          const key = inp.text[i];
          await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, text: key });
          current(generation);
          await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key });
        }
        await sleep(80);
        const value = await cdp.ev(`document.querySelector(${J(item.path)}).value`), ok = value.endsWith(inp.text);
        await stamp("form:type", { checker: "FORM", tile: "desktop", kind: "type", path: item.path, box: item.box, pin: item.pin, label: item.name || item.tag, result: ok ? "ok" : "issue", value: ok ? `typed ${inp.text.length}/${inp.text.length} ch · "${inp.text}"` : `typed ${inp.text.length}, field has "${value.slice(0, 24)}"` }, generation);
      }
    } finally {
      liveOwner = false;
      await camera("desktop").catch(() => {});
    }
  }
  async function execute() {
    input.onTiming?.("run-start", started);
    if (input.signal.aborted) throw fail("cancelled");
    let preparation;
    const prepCap = new Promise((_resolve, reject) => {
      preparation = setTimeout(() => reject(fail("page-failed")), 10_000);
      timers.add(preparation);
    });
    await race(Promise.race([Promise.all([setup("desktop"), setup("phone")]), prepCap]));
    clearTimeout(preparation); timers.delete(preparation);
    const prep = await race(C.prep(pages.desktop)), live = pickLive(prep);
    clock = { t0: now(), holds: 0 };
    publish({ kind: "start", scan: scanScore({ site: input.site, look: "swarm", map: prep.map, live }), clock });
    const hold = setInterval(() => {
      if (!loaded && !stopped) { try { publish({ kind: "hold", text: `${counts().completed} done` }); } catch (e) { cancel(e.code ?? "internal"); } }
    }, 120);
    timers.add(hold);
    const [desk, phone] = await race(Promise.all([C.readers(pages.desktop, prep, input.blockedUrls()), C.fit(pages.phone)]));
    score = conduct({ site: input.site, look: "swarm", map: prep.map, events: observations, desk, phone, live });
    for (const h of score.hops.filter(h => h.live)) ledger.set(`live:${h.live}`, { checker: h.checker, tile: "desktop", kind: h.kind, path: h.live });
    if (bytes(score) > 1024 * 1024) throw fail("resource-limit");
    await race(Promise.all(Object.values(adapters).map(cdp => cdp.ev('(() => { scrollTo({ top: 0, behavior: "instant" }); return true; })()'))));
    const boundary = Math.max(2, Math.ceil((now() - clock.t0) / VERIFY_BAR_MS));
    clock = { ...clock, holds: boundary - 2 };
    await until(clock.t0 + boundary * VERIFY_BAR_MS);
    loaded = true; scan = false;
    clearInterval(hold); timers.delete(hold);
    publish({ kind: "load", score, clock });
    await race(Promise.all([camera("desktop"), camera("phone")]));
    const epoch = clock.t0 + clock.holds * VERIFY_BAR_MS;
    for (const inp of score.inputs) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (sealed || stopped) return;
        const generation = inputGeneration;
        lane = lane.then(() => action(inp, live, generation)).catch(error => { if (!sealed && !stopped) cancel(error.code ?? "page-failed"); });
      }, Math.max(0, epoch + inp.t - now()));
      timers.add(timer);
    }
    const scroll = setInterval(() => scrollEvent().catch(error => { if (!sealed && !stopped) cancel(error.code ?? "page-failed"); }), 34);
    timers.add(scroll);
    await until(epoch + (VERIFY_FINALIZE_BAR - 1) * VERIFY_BAR_MS);
    sealed = true; inputGeneration++;
    for (const h of score.hops.filter(h => h.live && h.pending)) {
      h.pending = false; h.skip = true;
      publish({ kind: "result", key: h.live, ev: { result: "skip" }, t: (VERIFY_FINALIZE_BAR - 1) * VERIFY_BAR_MS });
    }
    frozenCounts = counts();
    await Promise.all([camera("desktop"), camera("phone")]);
    let unchanged;
    try { unchanged = await race(input.revisionUnchanged()); } catch (error) { if (["timeout", "cancelled"].includes(error.code)) throw error; throw fail("site-changed"); }
    if (!unchanged) throw fail("site-changed");
    const fin = finalize(score, observations);
    publish({ kind: "finalize", fin, t: (VERIFY_FINALIZE_BAR - 1) * VERIFY_BAR_MS });
    for (const tile of ["desktop", "phone"]) score.camera[tile].push(...fin.camera[tile]);
    converging = true;
    await race(Promise.all([camera("desktop"), camera("phone")]));
    await until(epoch + VERIFY_BARS * VERIFY_BAR_MS);
    return result();
  }
  const done = execute().catch(error => {
    sealed = true; inputGeneration++;
    const code = ["page-failed", "timeout", "cancelled", "site-changed", "resource-limit", "isolation-failed"].includes(error.code) ? error.code : "page-failed";
    return result(code);
  }).then(value => {
    stopped = true;
    try { publish({ kind: "end", result: value }); } catch {}
    return value;
  }).finally(() => {
    stopped = true; inputGeneration++;
    for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
    for (const dispose of disposers) { try { dispose(); } catch {} }
    for (const cdp of Object.values(adapters)) { try { cdp.close(); } catch {} }
  });
  return { done, rescale() { if (!stopped) Promise.all(Object.keys(adapters).map(metrics)).catch(error => cancel(error.code ?? "page-failed")); } };
}
