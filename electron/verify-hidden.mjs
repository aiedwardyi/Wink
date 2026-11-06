import { attach } from "./verify-cdp.mjs";
import { VERIFY_GEOMETRY, VERIFY_RUN_MS } from "./verify-protocol.mjs";
import { pageTools } from "./verify-rules/dom.mjs";
import * as errorsRule from "./verify-rules/page-errors.mjs";
import * as linksRule from "./verify-rules/dead-links.mjs";
import * as scrollRule from "./verify-rules/phone-scroll.mjs";
import * as menuRule from "./verify-rules/phone-menu.mjs";
import * as copyRule from "./verify-rules/leftovers.mjs";
import { blockedGuard } from "./verify-rules/blocked.mjs";

const rules = [errorsRule, linksRule, scrollRule, menuRule, copyRule];
const fatal = new Set(["resource-limit", "isolation-failed", "cancelled", "timeout"]);
const plain = (value, cap) => String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, cap);
const fault = code => Object.assign(new Error(code), { code });

export function runHiddenVerify(input) {
  const started = Date.now(), adapters = {}, disposers = [], problems = [], notChecked = new Set(), details = [];
  const counts = { planned: 10, completed: 0, passed: 0, failed: 0, blocked: 0, notRun: 10 };
  let rejectFailure, ended = false, seq = 0, runFailure;
  const failed = new Promise((_, reject) => { rejectFailure = reject; });
  failed.catch(() => {});
  const stop = code => { runFailure ??= code; rejectFailure(fault(code)); };
  const abort = () => stop("cancelled");
  const deadline = setTimeout(() => stop("timeout"), VERIFY_RUN_MS - 2500);
  input.signal.addEventListener("abort", abort, { once: true });
  const race = promise => Promise.race([promise, failed]);
  const emit = value => input.emit({ ...value, seq: ++seq, emittedAt: performance.timeOrigin + performance.now() });
  function complete(blocked, count) {
    if (ended) return;
    counts.completed++;
    counts.notRun--;
    counts[blocked ? "blocked" : count ? "failed" : "passed"]++;
    input.progress({ ...counts });
  }
  async function observe(cdp, rule, tile) {
    if (ended) throw fault("cancelled");
    try {
      return await race(cdp.ev(`(${rule.observe.toString()})((${pageTools.toString()})())`));
    } catch (error) {
      if (runFailure || fatal.has(error.code)) throw fault(runFailure ?? error.code);
      notChecked.add(`${rule.label} (${tile})`);
      return null;
    }
  }
  async function setup(tile) {
    const page = input.pages[tile], cdp = adapters[tile] = attach(page), events = [], loads = [], aborted = [], requests = new Map();
    const blocked = [], origin = new URL(input.url).origin;
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
    const geometry = VERIFY_GEOMETRY[tile];
    await race(cdp.send("Emulation.setDeviceMetricsOverride", { width: geometry.cssW, height: geometry.cssH, deviceScaleFactor: geometry.dpr, mobile: geometry.mobile, scale: 1 }));
    if (tile === "phone") await race(cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }));
    await race(page.loadURL(input.url));
    try { await race(cdp.ev("(() => { void document.body.offsetWidth; return document.fonts.ready.then(() => true); })()")); }
    catch (error) {
      if (runFailure || fatal.has(error.code)) throw fault(runFailure ?? error.code);
      notChecked.add(`fonts (${tile})`);
    }
    return { cdp, events, loads, aborted, blocked, requests };
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
  async function execute() {
    input.onTiming?.("run-start", started);
    if (input.signal.aborted) throw fault("cancelled");
    emit({ kind: "start", scan: null, clock: { t0: started, holds: 0 } });
    const tiles = await race(Promise.all([setup("desktop"), setup("phone")]));
    const nav = {};
    for (const [i, tile] of ["desktop", "phone"].entries()) {
      const { cdp, events, loads, aborted, blocked, requests } = tiles[i];
      const types = new Map([...requests.values()].map(r => [r.url, r.type]));
      const guard = blockedGuard([...blocked, ...input.blockedUrls().map(url => ({ url, type: types.get(url) }))]);
      const forms = await race(cdp.ev("!!document.querySelector('form,input:not([type=hidden]):not([type=checkbox]):not([type=radio]),textarea,button[type=submit]') || [...document.querySelectorAll('a,button')].some(n => /sign[ -]?up|register|신청|가입/i.test(n.textContent))")).catch(error => {
        if (runFailure || fatal.has(error.code)) throw fault(runFailure ?? error.code);
        notChecked.add(`form delivery (${tile})`);
        return false;
      });
      if (forms) notChecked.add("form delivery");
      for (const rule of rules) {
        if (tile === "desktop" && rule === scrollRule) { complete(false, 0); continue; }
        if (tile === "phone" && guard.layout && (rule === scrollRule || rule === menuRule)) { notChecked.add(`phone layout (${guard.layout})`); complete(true, 0); continue; }
        const data = await observe(cdp, rule, tile);
        if (!data) { complete(true, 0); continue; }
        try {
          if (rule === errorsRule) {
            Object.assign(data, { origin: new URL(input.url).origin, scriptsBlocked: guard.scripts, errors: [...new Map(events.map(e => [e.where, e])).values()] });
            const statuses = await head([...new Set(aborted.map(r => r.url))]);
            for (const r of aborted) if (errorsRule.failedLoad({ ...r, status: statuses.get(r.url) ?? 0 }, new URL(input.url).origin)) loads.push({ where: plain(new URL(r.url).pathname, 120), measured: `HTTP ${statuses.get(r.url)}; reload the page` });
            data.loads = [...new Map(loads.filter(e => !data.images.some(img => img.broken && img.src && new URL(img.src).pathname === e.where)).map(e => [e.where, e])).values()];
          }
          if (rule === linksRule) await links(data);
          if (rule === menuRule) nav[tile] = data;
          const checked = rule === menuRule ? tile === "phone" && nav.desktop ? rule.check(data, nav.desktop) : { problems: [], notChecked: [] } : rule.check(data);
          if (rule === menuRule && tile === "phone" && !nav.desktop) notChecked.add("phone menu (desktop navigation unavailable)");
          for (const row of checked.problems) problems.push({ checker: rule.id, tile, rule: plain(row.rule, 80), where: plain(row.where, 120), measured: plain(row.measured, 160) });
          for (const reason of checked.notChecked) notChecked.add(reason);
          for (const row of checked.details ?? []) details.push({ checker: rule.id, tile, rule: plain(row.rule, 80), where: plain(row.where, 120), measured: plain(row.measured, 160) });
          complete(checked.notChecked.length > 0 && !checked.problems.length, checked.problems.length);
          input.onTiming?.("first-check", Date.now());
        } catch (error) {
          if (runFailure || fatal.has(error.code)) throw fault(runFailure ?? error.code);
          notChecked.add(`${rule.label} (${tile})`);
          complete(true, 0);
        }
      }
    }
    if (!await race(input.revisionUnchanged())) throw fault("site-changed");
  }
  const done = execute().then(() => undefined, error => fatal.has(error.code) || ["page-failed", "site-changed"].includes(error.code) ? error.code : "page-failed").then(errorCode => {
    ended = true;
    const distinct = new Map();
    for (const row of problems) {
      const key = JSON.stringify([row.checker, row.rule, row.where, row.measured]);
      if (!distinct.has(key)) distinct.set(key, row);
    }
    const unique = [...distinct.values()];
    const extra = Math.max(0, unique.length - counts.failed);
    const result = { v: 1, runId: input.runId, site: input.site, counts: { ...counts, failed: counts.failed + extra, planned: counts.planned + extra, completed: counts.completed + extra }, issues: unique.slice(0, 40), issueTotal: unique.length, durationMs: Date.now() - started, notChecked: [...notChecked].sort().slice(0, 20), details: [...new Map(details.map(row => [JSON.stringify([row.checker, row.rule, row.where, row.measured]), row])).values()].slice(0, 40) };
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
