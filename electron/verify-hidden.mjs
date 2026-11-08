import { attach } from "./verify-cdp.mjs";
import { startCast } from "./verify-cast.mjs";
import { VERIFY_GEOMETRY, VERIFY_RUN_MS } from "./verify-protocol.mjs";
import { pageTools } from "./verify-rules/dom.mjs";
import * as errorsRule from "./verify-rules/page-errors.mjs";
import * as linksRule from "./verify-rules/dead-links.mjs";
import * as scrollRule from "./verify-rules/phone-scroll.mjs";
import * as menuRule from "./verify-rules/phone-menu.mjs";
import * as copyRule from "./verify-rules/leftovers.mjs";
import * as detailsRule from "./verify-rules/details.mjs";
import { blockedGuard } from "./verify-rules/blocked.mjs";

const rules = [errorsRule, linksRule, scrollRule, menuRule, copyRule, detailsRule];
const fatal = new Set(["resource-limit", "isolation-failed", "cancelled", "timeout"]);
const plain = (value, cap) => String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, cap);
const fault = code => Object.assign(new Error(code), { code });

export function runHiddenVerify(input) {
  const started = Date.now(), adapters = {}, disposers = [], problems = [], notChecked = new Set(), details = [];
  const counts = { planned: 0, completed: 0, passed: 0, failed: 0, blocked: 0, notRun: 0 };
  // [done, planned] per checker and tile; planned grows when a rule's list is known, so it rides on the next progress.
  const by = {}, tally = (checker, tile) => (by[checker] ??= {})[tile] ??= [0, 0];
  const casts = {};
  let batch = [];
  let rejectFailure, ended = false, seq = 0, eventBytes = 0, runFailure;
  const failed = new Promise((_, reject) => { rejectFailure = reject; });
  failed.catch(() => {});
  const stop = code => { runFailure ??= code; rejectFailure(fault(code)); };
  const abort = () => stop("cancelled");
  const deadline = setTimeout(() => stop("timeout"), VERIFY_RUN_MS - 2500);
  input.signal.addEventListener("abort", abort, { once: true });
  const race = promise => Promise.race([promise, failed]);
  const shots = new Set();
  // Awaited so the frame shows this scroll stop; a fast run leaves the screencast no time to.
  async function shot(tile, y) {
    if (!casts[tile] || shots.has(`${tile}:${y}`)) return;
    shots.add(`${tile}:${y}`);
    await race(casts[tile].shot().catch(() => {}));
  }
  const emit = value => {
    const event = { ...value, seq: seq + 1, emittedAt: performance.timeOrigin + performance.now() }, size = Buffer.byteLength(JSON.stringify(event));
    if (seq >= 1998 && value.kind !== "end" || eventBytes + size > 2 * 1024 * 1024 - (value.kind === "end" ? 0 : 32768)) return;
    seq++; eventBytes += size; input.emit(event);
  };
  function flushChecks() {
    if (!batch.length) return;
    emit({ kind: "checks", checks: batch, count: counts.completed });
    batch = [];
  }
  function complete(blocked, count, event) {
    if (ended) return;
    counts.planned++;
    counts.completed++;
    counts[blocked ? "blocked" : count ? "failed" : "passed"]++;
    if (event) {
      const row = tally(event.checker, event.tile);
      row[1] = Math.max(row[1], ++row[0]);
      batch.push({ ...event, result: blocked ? "blocked" : count ? "issue" : "ok", count: counts.completed });
      if (batch.length === 32) flushChecks();
    }
    input.progress({ ...counts, by: structuredClone(by) });
  }
  async function observe(cdp, rule, tile) {
    if (ended) throw fault("cancelled");
    try {
      return await race(cdp.ev(`(() => {
        const tools = (${pageTools.toString()})();
        const data = (${rule.observe.toString()})(tools);
        const measure = row => {
          if (!row.where || row.box) return;
          let node; try { node = row.where === "page" ? document.documentElement : document.querySelector(row.where); } catch {}
          if (!node?.getClientRects().length && row.where === "header nav") node = document.querySelector("header,[role=banner]");
          if (!node) return;
          const r = node.getBoundingClientRect(); row.box = [r.x, r.y, r.width, r.height]; row.scrollY = scrollY;
        };
        for (const value of Object.values(data)) if (Array.isArray(value)) for (const row of value) measure(row);
        measure(data);
        data.viewport = { height: innerHeight, maxScroll: Math.max(0, document.documentElement.scrollHeight - innerHeight), y: scrollY };
        return data;
      })()`));
    } catch (error) {
      if (runFailure || fatal.has(error.code)) throw fault(runFailure ?? error.code);
      notChecked.add(`${rule.label} (${tile})`);
      return null;
    }
  }
  async function setup(tile) {
    const page = input.pages[tile], cdp = adapters[tile] = attach(page), events = [], loads = [], aborted = [], requests = new Map();
    const blocked = [], hmr = new Set(), origin = new URL(input.url).origin;
    for (const event of ["render-process-gone", "destroyed", "unresponsive"]) {
      const handler = () => { if (!ended) stop("page-failed"); };
      page.on(event, handler);
      disposers.push(() => page.removeListener(event, handler));
    }
    disposers.push(cdp.on("Runtime.exceptionThrown", ({ exceptionDetails: e }) => {
      const message = e.exception?.description || e.text;
      events.push({ where: plain(`${e.url?.replace(origin, "") || "page"}:${(e.lineNumber ?? 0) + 1}`, 120), measured: plain(`${message}; reload the page`.replaceAll(origin, ""), 160) });
    }));
    disposers.push(cdp.on("Network.requestWillBeSent", e => requests.set(e.requestId, { url: e.request.url, type: e.type })));
    disposers.push(cdp.on("Network.webSocketCreated", e => {
      for (let stack = e.initiator?.stack; stack; stack = stack.parent) {
        if (stack.callFrames.some(frame => {
          try { const url = new URL(frame.url); return url.origin === origin && url.pathname === "/@vite/client"; }
          catch { return false; }
        })) { hmr.add(e.url); break; }
      }
    }));
    disposers.push(cdp.on("Network.responseReceived", e => {
      if (errorsRule.failedLoad({ url: e.response.url, type: e.type, status: e.response.status, blocked: input.blockedUrls().includes(e.response.url) }, origin)) loads.push({ where: plain(new URL(e.response.url).pathname, 120), measured: `HTTP ${e.response.status}; reload the page` });
    }));
    disposers.push(cdp.on("Network.loadingFailed", e => {
      const request = requests.get(e.requestId);
      if (!request) return;
      if (e.blockedReason || input.blockedUrls().includes(request.url) || new URL(request.url).origin !== origin) blocked.push({ url: request.url, type: e.type ?? request.type });
      else if (/ERR_ABORTED/.test(e.errorText) && ["Document", "Script", "Stylesheet", "Image", "Media", "Font"].includes(e.type ?? request.type)) aborted.push({ ...request, type: e.type ?? request.type });
      else if (errorsRule.failedLoad({ url: request.url, type: e.type ?? request.type, errorText: e.errorText }, origin)) loads.push({ where: plain(new URL(request.url).pathname, 120), measured: plain(`${e.errorText}; reload the page`, 160) });
    }));
    disposers.push(cdp.on("Page.javascriptDialogOpening", () => cdp.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => stop("isolation-failed"))));
    disposers.push(cdp.on("Page.fileChooserOpened", e => cdp.send("DOM.setFileInputFiles", { files: [], backendNodeId: e.backendNodeId }).catch(() => stop("isolation-failed"))));
    for (const method of ["Page.enable", "Runtime.enable", "Network.enable"]) await race(cdp.send(method));
    try { await race(cdp.send("Page.setInterceptFileChooserDialog", { enabled: true })); }
    catch { throw fault("isolation-failed"); }
    // Keep capture from changing page visibility.
    await race(cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }));
    const geometry = VERIFY_GEOMETRY[tile];
    await race(cdp.send("Emulation.setDeviceMetricsOverride", { width: geometry.cssW, height: geometry.cssH, deviceScaleFactor: geometry.dpr, mobile: geometry.mobile, scale: 1 }));
    if (tile === "phone") await race(cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }));
    await race(page.loadURL(input.url));
    if (input.frame) {
      casts[tile] = startCast({ cdp, page, tile, started, frame: input.frame });
      casts[tile].readerStop();
    }
    try { await race(cdp.ev("(() => { void document.body.offsetWidth; return document.fonts.ready.then(() => true); })()")); }
    catch (error) {
      if (runFailure || fatal.has(error.code)) throw fault(runFailure ?? error.code);
      notChecked.add(`fonts (${tile})`);
    }
    await shot(tile, 0);
    return { cdp, events, loads, aborted, blocked, requests, hmr };
  }
  async function head(urls) {
    const statuses = new Map();
    for (let i = 0; i < urls.length; i += 4) await race(Promise.all(urls.slice(i, i + 4).map(async url => {
      try {
        const response = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.any([input.signal, AbortSignal.timeout(1500)]) });
        statuses.set(url, response.status);
        await response.body?.cancel();
      } catch { statuses.set(url, null); }
    })));
    return statuses;
  }
  async function links(data) {
    const statuses = await head([...new Set(data.links.filter(a => a.local && !a.missing && !a.samePage).map(a => a.url))]);
    for (const a of data.links) if (statuses.has(a.url)) { a.status = statuses.get(a.url); a.unchecked = a.status === null; }
  }
  async function pageErrors(data, state, scriptsBlocked) {
    const origin = new URL(input.url).origin, aborted = state.aborted.splice(0);
    const blocked = new Set(input.blockedUrls());
    data.images = data.images.filter(img => {
      if (!blocked.has(img.src) || !img.src.startsWith(origin + "/")) return true;
      notChecked.add("images blocked in the check"); return false;
    });
    const statuses = await head([...new Set(aborted.map(r => r.url))]);
    for (const r of aborted) if (errorsRule.failedLoad({ ...r, status: statuses.get(r.url) ?? 0 }, origin)) state.loads.push({ where: plain(new URL(r.url).pathname, 120), measured: `HTTP ${statuses.get(r.url)}; reload the page` });
    Object.assign(data, { origin, scriptsBlocked, errors: [...new Map(state.events.splice(0).map(e => [e.where, e])).values()] });
    data.loads = [...new Map(state.loads.splice(0).filter(e => !data.images.some(img => img.broken && img.src && new URL(img.src).pathname === e.where)).map(e => [e.where, e])).values()];
  }
  async function interact(cdp, tile) {
    try {
      const targets = await race(cdp.ev(`(() => {
        const { all, visible, where } = (${pageTools.toString()})();
        const nodes = all("a,button,summary,label,[role=button]").filter(visible);
        const menu = ${JSON.stringify(tile)} === "phone" && nodes.find(n => n.closest("header,[role=banner],nav") && /menu|navigation|toggle|hamburger|메뉴|탐색/i.test(n.getAttribute("aria-label") || n.id || n.textContent));
        const signup = nodes.find(n => /sign[ -]?up|register|apply|신청|가입/i.test(n.textContent) && !n.closest("form") && !n.disabled && (n.localName !== "a" || n.origin === location.origin && n.pathname === location.pathname));
        globalThis.lvWatchTargets = [menu, signup].filter(Boolean);
        return globalThis.lvWatchTargets.map((n, index) => ({ index, where: where(n), key: n === menu ? "menu" : "signup" }));
      })()`));
      if (!Array.isArray(targets)) return;
      for (const target of targets) {
        const point = await race(cdp.ev(`(() => { const n = globalThis.lvWatchTargets[${target.index}]; if (!n?.isConnected) return null; n.scrollIntoView({ block: "center", behavior: "instant" }); const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, scrollY }; })()`));
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        emit({ kind: "scroll", tile, y: point.scrollY });
        emit({ kind: "point", inp: { tile, type: "click", key: target.key, path: target.where, x: point.x, y: point.y, doc: false }, scrollY: point.scrollY });
        await race(cdp.ev("lv.allow(true)"));
        try {
          for (const type of ["mousePressed", "mouseReleased"]) await race(cdp.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 }));
        } finally { await cdp.ev("lv.allow(false)").catch(() => {}); }
        casts[tile]?.readerStop();
      }
    } catch (error) {
      if (runFailure || fatal.has(error.code)) throw fault(runFailure ?? error.code);
      notChecked.add(`visible interactions (${tile})`);
    }
  }
  async function execute() {
    input.onTiming?.("run-start", started);
    if (input.signal.aborted) throw fault("cancelled");
    emit({ kind: "start", scan: null, clock: { t0: started, holds: 0 } });
    const tiles = await race(Promise.all([setup("desktop"), setup("phone")]));
    emit({ kind: "part", part: "loads" });
    const nav = {};
    for (const [i, tile] of ["desktop", "phone"].entries()) {
      const { cdp, blocked, requests, hmr } = tiles[i];
      const types = new Map([...requests.values()].map(r => [r.url, r.type]));
      const guard = blockedGuard([...blocked, ...input.blockedUrls().map(url => ({ url, type: types.get(url) }))].filter(row => !hmr.has(row.url)));
      const forms = await race(cdp.ev("!!document.querySelector('form,input:not([type=hidden]):not([type=checkbox]):not([type=radio]),textarea,button[type=submit]') || [...document.querySelectorAll('a,button')].some(n => /sign[ -]?up|register|신청|가입/i.test(n.textContent))")).catch(error => {
        if (runFailure || fatal.has(error.code)) throw fault(runFailure ?? error.code);
        notChecked.add(`form delivery (${tile})`);
        return false;
      });
      if (forms) notChecked.add("form delivery");
      let lastY = 0;
      for (const rule of rules) {
        if (tile === "desktop" && rule === scrollRule) continue;
        if (guard.layout && (rule === detailsRule || tile === "phone" && (rule === scrollRule || rule === menuRule))) { notChecked.add(`phone layout (${guard.layout})`); continue; }
        if (lastY) {
          await race(cdp.ev('(() => { scrollTo({ top: 0, behavior: "instant" }); void document.body.offsetWidth; return scrollY; })()'));
          emit({ kind: "scroll", tile, y: 0 }); lastY = 0;
        }
        const data = await observe(cdp, rule, tile);
        if (!data) continue;
        try {
          if (rule === errorsRule) await pageErrors(data, tiles[i], guard.scripts);
          if (rule === linksRule) await links(data);
          if (rule === menuRule) nav[tile] = data;
          const checked = rule === menuRule ? tile === "phone" && nav.desktop ? rule.check(data, nav.desktop) : { problems: [], notChecked: [] } : rule.check(data);
          if (rule === menuRule && tile === "phone" && !nav.desktop) notChecked.add("phone menu (desktop navigation unavailable)");
          const candidates = rule === errorsRule ? [...data.images, ...data.errors, ...data.loads] : rule === linksRule ? data.links : rule === copyRule ? checked.checks.map(row => ({ ...data.texts.find(item => item.where === row.where), ...row })) : rule === menuRule ? data.links : rule === detailsRule ? data.rows : [data];
          tally(rule.id, tile)[1] += candidates.length;
          const decorate = row => {
            const element = candidates.find(item => item.where === row.where) ?? (rule === menuRule ? data : null);
            return { checker: rule.id, tile, rule: plain(row.rule, 80), where: plain(row.where, 120), measured: plain(row.measured, 160), ...(element?.box ? { box: element.box, scrollY: element.scrollY ?? 0 } : {}) };
          };
          for (const row of checked.problems) problems.push(decorate(row));
          for (const reason of checked.notChecked) notChecked.add(reason);
          for (const row of checked.details ?? []) details.push(decorate(row));
          const remaining = [...checked.problems];
          let y = data.viewport?.y ?? 0;
          let lastTarget = y;
          candidates.sort((a, b) => (a.box?.[1] ?? 0) + (a.scrollY ?? 0) - (b.box?.[1] ?? 0) - (b.scrollY ?? 0));
          for (const element of candidates) {
            if (element.box && data.viewport) {
              const documentY = element.box[1] + (element.scrollY ?? 0), height = data.viewport.height;
              const target = Math.min(data.viewport.maxScroll, Math.max(0, Math.floor(Math.max(0, documentY - 80) / Math.max(1, height - 120)) * Math.max(1, height - 120)));
              if (target !== lastTarget) {
                flushChecks();
                y = await race(cdp.ev(`(() => { scrollTo({ top: ${target}, behavior: "instant" }); void document.body.offsetWidth; return scrollY; })()`));
                lastTarget = target;
                emit({ kind: "scroll", tile, y }); await shot(tile, y);
              }
              element.box = [element.box[0], documentY - y, element.box[2], element.box[3]];
              element.scrollY = y;
            }
            const found = remaining.filter(row => row.where === element.where && (!element.rule || element.rule === row.rule) && element.bad !== false);
            for (const row of found) remaining.splice(remaining.indexOf(row), 1);
            complete(element.unchecked === true || element.pending === true, found.length > 0 || element.bad === true, { tile, checker: rule.id, rule: element.rule ?? rule.label, where: element.where ?? "page", ...(element.box ? { box: element.box } : {}), scrollY: element.scrollY ?? 0, detail: rule === detailsRule });
            if (counts.completed % 64 === 0) await race(new Promise(setImmediate));
          }
          for (const row of remaining) complete(false, true, { ...decorate(row), detail: false, scrollY: 0 });
          lastY = y;
          for (const row of [...problems, ...details].filter(row => row.tile === tile && row.checker === rule.id)) {
            const element = candidates.find(item => item.where === row.where && (!item.rule || item.rule === row.rule));
            if (element?.box) { row.box = element.box; row.scrollY = element.scrollY ?? 0; }
          }
          flushChecks(); casts[tile]?.readerStop();
          if (rule === linksRule && tile === "desktop") emit({ kind: "part", part: "links" });
          input.onTiming?.("first-check", Date.now());
        } catch (error) {
          if (runFailure || fatal.has(error.code)) throw fault(runFailure ?? error.code);
          notChecked.add(`${rule.label} (${tile})`);
        }
      }
      await interact(cdp, tile);
      const data = { images: [] };
      await pageErrors(data, tiles[i], blockedGuard(blocked.filter(row => !hmr.has(row.url))).scripts || guard.scripts);
      const checked = errorsRule.check(data);
      for (const row of checked.problems) {
        const issue = { checker: errorsRule.id, tile, rule: plain(row.rule, 80), where: plain(row.where, 120), measured: plain(row.measured, 160) };
        problems.push(issue);
        complete(false, true, { ...issue, detail: false, scrollY: 0 });
      }
      for (const reason of checked.notChecked) notChecked.add(reason);
      flushChecks();
      if (tile === "phone") emit({ kind: "part", part: "phone" });
    }
    if (!await race(input.revisionUnchanged())) throw fault("site-changed");
  }
  const done = execute().then(() => undefined, error => fatal.has(error.code) || ["page-failed", "site-changed"].includes(error.code) ? error.code : "page-failed").then(errorCode => {
    ended = true;
    flushChecks();
    for (const cast of Object.values(casts)) cast.stop();
    const distinct = new Map();
    for (const row of problems) {
      const key = JSON.stringify([row.checker, row.rule, row.where, row.measured]);
      if (!distinct.has(key)) distinct.set(key, row);
    }
    const unique = [...distinct.values()];
    const result = { v: 1, runId: input.runId, site: input.site, counts: { ...counts }, issues: unique.slice(0, 40), issueTotal: unique.length, durationMs: Date.now() - started, notChecked: [...notChecked].sort().slice(0, 20), details: [...new Map(details.map(row => [JSON.stringify([row.checker, row.rule, row.where, row.measured]), row])).values()].slice(0, 40) };
    if (errorCode) result.errorCode = errorCode;
    try { emit({ kind: "end", result }); } catch {}
    return result;
  }).finally(() => {
    ended = true;
    clearTimeout(deadline);
    input.signal.removeEventListener("abort", abort);
    for (const dispose of disposers) dispose();
    for (const cdp of Object.values(adapters)) cdp.close();
  });
  return { done, rescale() {} };
}
