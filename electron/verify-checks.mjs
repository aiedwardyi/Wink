
export const DESK = { width: 1280, height: 720 };
export const PHONE = { width: 392, height: 800 };
const J = JSON.stringify;
const SCROLL = "Math.round(visualViewport.pageTop)";
const hex = (rgb) => "#" + (String(rgb).match(/\d+/g) || []).slice(0, 3).map((v) => (+v).toString(16).padStart(2, "0")).join("");
const primary = (fonts) => [...fonts].sort((a, b) => b.glyphCount - a.glyphCount)[0]?.familyName ?? "none";
const fontList = (fonts) => fonts.map((f) => `${f.familyName}${f.isCustomFont ? "*" : ""}:${f.glyphCount}`).join(", ");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const BUDGET_MS = 4500;
export async function world(cdp, tile) {
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  let document = null;
  for (const event of ["DOM.documentUpdated", "Runtime.executionContextsCleared"]) cdp.on(event, () => { document = null; });
  cdp.on("Page.frameNavigated", event => { if (!event.frame?.parentId) document = null; });
  const node = async path => {
    // Re-fetching the document invalidates node IDs in parallel readers.
    if (!document) {
      const pending = cdp.send("DOM.getDocument", { depth: 0 });
      document = pending;
      pending.catch(() => { if (document === pending) document = null; });
    }
    const { root } = await document;
    return (await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: path })).nodeId;
  };
  const fonts = async path => (await cdp.send("CSS.getPlatformFontsForNode", { nodeId: await node(path) })).fonts;
  const listeners = async path => {
    const { object } = await cdp.send("DOM.resolveNode", { nodeId: await node(path) });
    let handlers = [];
    try {
      const result = await cdp.send("DOMDebugger.getEventListeners", { objectId: object.objectId });
      handlers = result.listeners.flatMap(l => [l.handler?.objectId, l.originalHandler?.objectId]).filter(Boolean);
      return result.listeners.map(l => l.type);
    } finally {
      await Promise.all([...new Set([object.objectId, ...handlers])].map(objectId => cdp.send("Runtime.releaseObject", { objectId })));
    }
  };
  return { ev: cdp.ev, fonts, listeners, tile };
}

function stopsFor(blocks, navBottom, vh, maxScroll) {
  const stops = [0];
  let s = 0;
  for (const b of [...blocks].filter((b) => !b.pin).sort((a, c) => a.box.y - c.box.y)) {
    if (b.box.y >= s + navBottom && b.box.y + b.box.h <= s + vh) continue;
    const next = Math.min(maxScroll, Math.max(s + 1, Math.round(b.box.y - navBottom - 24)));
    if (next <= s) continue;
    s = next;
    stops.push(s);
  }
  return stops;
}
function stopOf(b, stops, navBottom, vh) {
  if (b.pin) return 0;
  let best = 0, bestVis = -1;
  stops.forEach((s, i) => {
    const top = Math.max(b.box.y, s + navBottom), bot = Math.min(b.box.y + b.box.h, s + vh);
    const vis = Math.max(0, bot - top) / Math.max(1, b.box.h);
    if (vis > bestVis + 1e-6) { best = i; bestVis = vis; }
  });
  return best;
}

export function checks(log, onPlan = () => {}) {
  async function scrollTo(P, y) {
    const cur = await P.ev(SCROLL);
    if (cur === y) return y;
    await P.ev(`(() => { scrollTo({ top: ${y}, behavior: "instant" }); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); })()`);
    const got = await P.ev(SCROLL);
    log({ checker: "VIEW", tile: P.tile, kind: "scroll", box: null, label: "scroll", result: "ok", value: `${cur} -> ${got}`, scroll: got, scrollFrom: cur });
    return got;
  }
  async function prep(R) {
    const map = await R.ev("lv.map()");
    for (const m of map) log({ checker: "MAP", tile: "desktop", kind: "map", box: m.box, mscroll: 0, pin: m.pin, deco: m.deco, label: m.tag, result: "seen", value: m.path });
    const [blocks, heads, links, btns, inputs, navBottom, docH, declared] = await Promise.all([
      R.ev("lv.blocks()"), R.ev("lv.headings()"), R.ev("lv.links()"), R.ev("lv.buttons()"), R.ev("lv.inputs()"), R.ev("lv.navBottom()"),
      R.ev("document.documentElement.scrollHeight"), R.ev("getComputedStyle(document.body).fontFamily"),
    ]);
    for (const l of links) if (l.target) l.target.first = await R.ev(`lv.firstText(${J(l.target.path)})`);
    return { map, blocks, heads, links, btns, inputs, navBottom, docH, declared: declared.split(",")[0].trim().replace(/['"]/g, "") };
  }

  async function readers(R, p, blocked) {
    const { blocks, heads, links, btns, navBottom, docH, declared } = p;
    const stops = stopsFor(blocks, navBottom, DESK.height, Math.max(0, docH - DESK.height));
    const at = (b) => stopOf(b, stops, navBottom, DESK.height);
    const plan = { TEXT_A: [], TEXT_B: [], CONTRAST: [], FONT: [], HEADINGS: [], LINKS: [], BUTTONS: [] };
    blocks.forEach((b, i) => {
      b.stop = at(b);
      (i % 2 ? plan.TEXT_B : plan.TEXT_A).push(b);
      if (/[\p{L}\p{N}]/u.test(b.text)) plan.CONTRAST.push(b);
    });
    const seenStyle = new Set();
    for (const b of blocks) {
      const key = `${b.stop}|${b.weight}|${Math.round(b.size)}`;
      if (seenStyle.has(key) || !/\p{L}/u.test(b.text)) continue;
      seenStyle.add(key);
      plan.FONT.push(b);
    }
    heads.forEach((h) => { h.stop = at(h); plan.HEADINGS.push(h); });
    for (const l of links) {
      l.stop = at(l);
      plan.LINKS.push({ ...l, kind: "link" });
      if (l.target) plan.LINKS.push({ ...l, kind: "target", stop: at({ box: l.target.box }) });
    }
    btns.forEach((b) => { b.stop = at(b); plan.BUTTONS.push(b); });
    log({ checker: "PLAN", tile: "desktop", kind: "plan", box: null, label: "plan", result: "ok",
      value: Object.entries(plan).map(([k, v]) => `${k} ${v.length}`).join(" · "), stops, navBottom, docHeight: docH, map: p.map.length, blocks: blocks.length });

    const jobs = Object.entries(plan).flatMap(([checker, list]) => list.map(b => ({ checker, tile: "desktop", kind: checker.startsWith("TEXT") ? "text" : ({CONTRAST:"contrast", FONT:"font", HEADINGS:"heading", LINKS:b.kind, BUTTONS:"button"})[checker], path: b.path, stop: b.stop })));
    if (blocks.length) jobs.push({ checker: "FONT", tile: "desktop", kind: "font-face", path: "font-face", stop: 0 });
    onPlan(jobs);
    let ms = 0;
    const textCheck = async (checker, b) => {
      const x = await R.ev(`lv.text(${J(b.path)})`);
      const f = await R.fonts(b.path);
      const why = x.covered ? `under ${x.covered}` : x.clip ? `cut ${x.clip.px}px by ${x.clip.by}` : x.placeholder ? "placeholder" : null;
      return log({ checker, tile: "desktop", kind: "text", path: b.path, box: x.box, mscroll: ms, pin: x.pin, label: x.tag, result: x.ok && f.length ? "ok" : "issue",
        value: why ?? `${x.chars} ch · ${x.lines} ln`, detail: { text: x.text.slice(0, 60), fonts: fontList(f) } });
    };
    const run = {
      TEXT_A: (b) => textCheck("TEXT_A", b),
      TEXT_B: (b) => textCheck("TEXT_B", b),
      async CONTRAST(b) {
        const c = await R.ev(`lv.contrast(${J(b.path)})`);
        if (c.skip) return;
        return log({ checker: "CONTRAST", tile: "desktop", kind: "contrast", path: b.path, box: b.box, mscroll: 0, pin: b.pin, label: b.tag, result: c.ok ? "ok" : "issue",
          value: `${c.ratio.toFixed(2)}:1${c.ok ? "" : ` < ${c.need}`}`, detail: c });
      },
      async FONT(b) {
        const f = await R.fonts(b.path);
        const used = primary(f);
        return log({ checker: "FONT", tile: "desktop", kind: "font", path: b.path, box: b.box, mscroll: 0, pin: b.pin, label: b.tag, result: "ok",
          value: `${used}${used === declared ? "" : " fallback"}`, detail: { declared, fonts: fontList(f) } });
      },
      async HEADINGS(h) {
        const x = (await R.ev("lv.headings()")).find((q) => q.path === h.path);
        return log({ checker: "HEADINGS", tile: "desktop", kind: "heading", path: h.path, box: x.box, mscroll: ms, pin: x.pin, label: `h${x.level}`, result: x.ok ? "ok" : "issue",
          value: x.skip ? `h${x.level} after h${x.prev}, skips h${x.prev + 1}` : `h${x.level} in order`, detail: { text: x.text } });
      },
      async LINKS(l) {
        const x = (await R.ev("lv.links()")).find((q) => q.path === l.path);
        if (l.kind === "target") return log({ checker: "LINKS", tile: "desktop", kind: "target", path: l.path, box: x.target.box, mscroll: ms, label: x.target.tag,
          result: x.target.unique ? "ok" : "issue", value: `${x.href} found`, detail: { target: x.target.path } });
        return log({ checker: "LINKS", tile: "desktop", kind: "link", path: l.path, box: x.box, mscroll: ms, pin: x.pin, label: x.name, result: x.ok ? "ok" : "issue",
          value: `-> ${x.href}`, detail: { name: x.name } });
      },
      async BUTTONS(b) {
        const x = (await R.ev("lv.buttons()")).find((q) => q.path === b.path);
        const types = await R.listeners(b.path);
        const click = types.includes("click");
        const ok = click && !!x.name && !x.disabled && x.tabIndex >= 0 && x.w >= 24 && x.h >= 24;
        return log({ checker: "BUTTONS", tile: "desktop", kind: "button", path: b.path, box: x.box, mscroll: ms, pin: x.pin, label: x.name, result: ok ? "ok" : "issue",
          value: `${click ? "onclick" : "no handler"} · ${Math.round(x.w)}x${Math.round(x.h)}`, detail: { listeners: types, tabIndex: x.tabIndex } });
      },
    };
    const h1 = blocks.find((b) => b.tag.startsWith("h1")) ?? blocks[0];
    const sheet = blocked.find((u) => /fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr|font/i.test(u));
    if (h1) {
      const faces = await R.ev("document.fonts.ready.then(() => [...document.fonts].map((f) => f.family.replace(/['\"]/g, '') + ':' + f.status))");
      const used = primary(await R.fonts(h1.path));
      const loaded = faces.some((f) => f.startsWith(declared + ":loaded")) || used === declared;
      if (loaded || !sheet) {
        log({ checker: "FONT", tile: "desktop", kind: "font-face", path: "font-face", box: h1.box, mscroll: 0, pin: h1.pin, label: declared, result: loaded ? "ok" : "issue",
          value: loaded ? `${declared} loaded` : `${declared} not found -> ${used}`, detail: { faces, used }, stop: 0, scroll: 0 });
      } else {
        log({ checker: "FONT", tile: "desktop", kind: "font-face", path: "font-face", box: h1.box, mscroll: 0, pin: h1.pin, label: declared, result: "blocked", value: "sheet blocked", stop: 0, scroll: 0 });
      }
    }

    const until = Date.now() + BUDGET_MS;
    for (let s = 0; s < stops.length && (s === 0 || Date.now() < until); s++) {
      const work = Object.entries(plan).flatMap(([k, list]) => list.filter((x) => x.stop === s).map((x) => [k, x]));
      if (!work.length) continue;
      ms = await scrollTo(R, stops[s]);
      await Promise.all(Object.keys(plan).map(async (k) => {
        for (const [, x] of work.filter(([q]) => q === k)) {
          const e = await run[k](x);
          if (e) Object.assign(e, { stop: s, scroll: ms });
        }
      }));
    }
    return { stops, navBottom, docH };
  }

  async function fit(P) {
    const blocks = await P.ev("lv.blocks()");
    const navBottom = await P.ev("lv.navBottom()");
    const f0 = await P.ev("lv.fit()");
    const stops = stopsFor(blocks, navBottom, PHONE.height, Math.max(0, f0.docHeight - PHONE.height));
    const at = (b) => stopOf(b, stops, navBottom, PHONE.height);
    log({ checker: "PLAN", tile: "phone", kind: "plan", box: null, label: "plan", result: "ok", value: `FIT ${1 + f0.taps.length + blocks.length}`, stops, navBottom, docHeight: f0.docHeight });
    onPlan([
      { checker: "FIT", tile: "phone", kind: "overflow", path: "page", stop: 0 },
      ...f0.taps.map(t => ({ checker: "FIT", tile: "phone", kind: "tap", path: t.path, stop: at(t) })),
      ...blocks.map(b => ({ checker: "FIT", tile: "phone", kind: "cut", path: b.path, stop: at(b) })),
    ]);
    const until = Date.now() + BUDGET_MS;
    for (let s = 0; s < stops.length && (s === 0 || Date.now() < until); s++) {
      const taps = f0.taps.filter((t) => at(t) === s);
      const texts = blocks.filter((b) => at(b) === s);
      const wide = s === 0;
      if (!taps.length && !texts.length && !wide) continue;
      const ms = await scrollTo(P, stops[s]);
      const f = await P.ev("lv.fit()");
      const base = { checker: "FIT", tile: "phone", stop: s, scroll: ms, mscroll: ms };
      if (wide) {
        const ok = f.scrollWidth <= f.width + 1;
        const top = f.over[0];
        log({ ...base, kind: "overflow", path: "page", box: ok || !top ? { x: 0, y: ms, w: f.width, h: PHONE.height } : top.box, pin: ok || !top, label: ok || !top ? "viewport" : top.tag,
          result: ok ? "ok" : "issue", value: ok ? `${f.scrollWidth}/${f.width}px wide` : `${f.scrollWidth}px wide on ${f.width} · pans ${f.scrollWidth - f.width}px`,
          detail: { width: f.width, scrollWidth: f.scrollWidth, innerWidth: f.innerWidth, over: f.over } });
      }
      for (const t of taps) {
        const x = f.taps.find((q) => q.path === t.path);
        if (!x) continue;
        log({ ...base, kind: "tap", path: t.path, box: x.box, pin: x.pin, label: x.name, result: x.ok ? "ok" : "issue", value: `${Math.round(x.w)}x${Math.round(x.h)}${x.ok ? "" : " < 44"}` });
      }
      for (const b of texts) {
        const x = await P.ev(`lv.text(${J(b.path)})`);
        const bad = x.clip || x.covered;
        log({ ...base, kind: "cut", path: b.path, box: x.box, pin: x.pin, label: x.tag, result: bad ? "issue" : "ok",
          value: x.clip ? `cut ${x.clip.px}px` : x.covered ? `under ${x.covered}` : `fits · ${x.lines} ln` });
      }
    }
    return { stops, navBottom, docH: f0.docHeight };
  }
  const settle = async (T) => {
    let last = -1, same = 0;
    for (let i = 0; i < 100 && same < 3; i++) {
      await wait(30);
      const s = await T.ev(SCROLL);
      same = s === last ? same + 1 : 0;
      last = s;
    }
    return last;
  };
  const feedback = (a, b) => {
    if (a.color !== b.color) return `color ${hex(a.color)} -> ${hex(b.color)}`;
    if (a.ty !== b.ty) return `lift ${b.ty - a.ty}px`;
    if (a.scale !== b.scale) return `scale ${b.scale}`;
    if (a.bg !== b.bg) return `bg ${hex(a.bg)} -> ${hex(b.bg)}`;
    if (a.bgi !== b.bgi || a.shadow !== b.shadow) return "glow on hover";
    if (a.border !== b.border) return `border ${hex(b.border)}`;
    if (a.deco !== b.deco) return `underline`;
    if (a.opacity !== b.opacity) return `opacity ${b.opacity}`;
    return null;
  };
  const live = {
    async hoverBefore(T, path) { return T.ev(`lv.lift(${J(path)})`); },
    async hoverAfter(T, path, before, checker, tile, item) {
      const read = () => T.ev(`lv.lift(${J(path)})`), t0 = Date.now();
      let after, fb = null;
      while (!fb && Date.now() - t0 < 260) { await wait(20); fb = feedback(before, (after = await read())); }
      if (fb) { await wait(260 - (Date.now() - t0)); const end = await read(), fe = feedback(before, end); if (fe) (after = end), (fb = fe); }
      return { checker, tile, kind: "hover", path, box: item.box, mscroll: 0, pin: item.pin, label: item.name || item.tag, result: fb ? "ok" : "issue", value: fb ? `hover ${fb}` : "no hover feedback", detail: { before, after } };
    },
    async navClick(T, l, y0) {
      const y1 = await settle(T);
      const land = await T.ev(`lv.landing(${J(l.target.path)})`);
      return [
        { checker: "NAV", tile: "nav", kind: "click", path: l.path, box: l.box, mscroll: 0, pin: l.pin, label: l.name, result: y1 !== y0 ? "ok" : "issue",
          value: `${l.href} ${y1 - y0 >= 0 ? "+" : ""}${y1 - y0}px`, scroll: y1, scrollFrom: y0 },
        { checker: "NAV", tile: "nav", kind: "land", path: l.path, box: land.firstText, mscroll: y1, label: l.target.tag, result: land.hidden > 0 ? "issue" : "ok",
          value: land.hidden > 0 ? `1st line ${land.hidden}px under nav` : "clear of nav", detail: land },
      ];
    },
    async opened(T, before, b) {
      let o = { open: false };
      for (let i = 0; i < 12 && !o.open; i++) { await wait(50); o = await T.ev(`lv.opened(${J(before)})`); }
      return o;
    },
  };

  return { prep, readers, fit, live, scrollTo };
}

export { SCROLL, wait };
