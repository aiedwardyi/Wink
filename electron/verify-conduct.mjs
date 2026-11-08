export const BPM = 174, B = 60000 / BPM, E = B / 2, S = B / 4, BAR = 4 * B;
export const at = (bar, beat = 0, s16 = 0) => (bar - 1) * BAR + beat * B + s16 * S;
const up16 = (t) => Math.ceil(t / S - 1e-6) * S;
const META = new Set(["MAP", "PLAN", "VIEW"]);

const CHECKERS = [
  { id: "TEXT_A", tag: "TEXT A", role: "text" },
  { id: "TEXT_B", tag: "TEXT B", role: "text" },
  { id: "HEADINGS", tag: "HEADINGS", role: "struct" },
  { id: "LINKS", tag: "LINKS", role: "struct" },
  { id: "FONT", tag: "FONT", role: "style" },
  { id: "CONTRAST", tag: "CONTRAST", role: "style" },
  { id: "BUTTONS", tag: "BUTTONS", role: "action" },
  { id: "NAV", tag: "NAV", role: "clicker" },
  { id: "CLICK", tag: "CLICK", role: "clicker" },
  { id: "FORM", tag: "FORM", role: "clicker" },
  { id: "FIT", tag: "FIT", role: "fit" },
];
const READERS = CHECKERS.slice(0, 7).map((c) => c.id);
export const typed = (type) => ({ email: "demo@wink.ai", tel: "010-1234-5678", url: "https://wink.ai", number: "42", search: "live verify" })[type] ?? "Live Verify";

const unionBox = (bs) => {
  const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
  return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y };
};
function groups(list, slots) {
  if (list.length <= slots) return list.map((e) => [e]);
  const solo = list.filter((e) => e.result === "issue").length;
  const per = (list.length - solo) / Math.max(1, slots - solo);
  const out = [];
  let cur = [], quota = per, used = 0;
  for (const e of list) {
    if (e.result === "issue") { if (cur.length) out.push(cur), (cur = []); out.push([e]); continue; }
    cur.push(e);
    if (++used >= quota - 1e-9) { out.push(cur); cur = []; quota += per; }
  }
  if (cur.length) out.push(cur);
  return out;
}
function groupValue(c, g) {
  if (g.length === 1) return g[0].value;
  if (c === "CONTRAST") return `${Math.min(...g.map((e) => parseFloat(e.value))).toFixed(2)}:1 min x${g.length}`;
  if (c.startsWith("TEXT")) return `${g.length} blocks · ${g.reduce((n, e) => n + (parseInt(e.value) || 0), 0)} ch`;
  if (c === "FONT") return `${g[0].value} x${g.length}`;
  return `${g.length} ok`;
}
export function pickLive(p) {
  const inView = (b) => b.box.x >= 0 && b.box.y >= 0 && (b.pin || b.box.y + b.box.h <= 700);
  const jumps = p.links.filter((l) => l.href.startsWith("#") && l.href.length > 1 && l.target?.unique && l.box.w > 0 && inView(l) && l.target.box.y > 360);
  const seen = new Set();
  let nav = jumps.filter((l) => l.pin && !seen.has(l.target.path) && seen.add(l.target.path)).slice(0, 3);
  if (!nav.length) nav = jumps.filter(inView).slice(0, 1);
  const button = p.btns.find((b) => !b.form && !b.href && !b.disabled && inView(b) && b.w >= 8) ?? null;
  const input = p.inputs[0] ?? null;
  return { nav, button, input, docH: p.docH, navBottom: p.navBottom };
}

const scanOf = (map) => [...map].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x).map((m, i, a) => ({ t: S + (i * (at(2, 3) - S)) / a.length, box: m.box, pin: m.pin, label: m.tag }));
const pickCheckers = (live) => CHECKERS.filter((c) => (c.id !== "NAV" || live.nav.length) && (c.id !== "CLICK" || live.button) && (c.id !== "FORM" || live.input));
function rawScanScore({ site, look, map, live }) {
  const checkers = pickCheckers(live);
  return {
    bpm: BPM, beat: B, bars: 16, duration_ms: 16 * BAR, hold_ms: 2000, site, look,
    tiles: { desktop: { vw: 1280, vh: 720 }, nav: { vw: 1280, vh: 720 }, act: { vw: 1280, vh: 720 }, phone: { vw: 392, vh: 800 } },
    used: ["desktop"], checkers, sections: [{ name: "Scan", from: 1, to: 2, t0: 0, t1: at(3) }],
    layout: [{ t: 0, name: "solo" }], camera: { desktop: [{ t: 0, y: 0, d: 0 }], nav: [{ t: 0, y: 0, d: 0 }], act: [{ t: 0, y: 0, d: 0 }], phone: [{ t: 0, y: 0, d: 0 }] },
    inputs: [], scan: scanOf(map), hops: [], sweeps: [], rulers: [], converge: [], recheck: [], pill: [{ t: 0, mode: "scan" }, { t: at(2, 3), mode: "plan" }], stamps: [],
    totals: { checkers: checkers.length, checks: 0, issues: 0, map: map.length },
  };
}

function rawConduct({ site, look, map, events, desk, phone, live }) {
  const first = events.filter((e) => !META.has(e.checker));
  const hops = [];
  const src = (e) => ({ label: e.label, value: e.value, result: e.result, path: e.path, kind: e.kind });
  function hop(checker, tile, t, list, o = {}) {
    const d = o.d ?? E, ta = t + d;
    const h = {
      id: hops.length, checker, tile, t, d, ta, ts: o.ts ?? ta + 3 * S, hold: o.hold ?? B,
      box: o.box ?? list[0].box, mscroll: o.mscroll ?? list[0].mscroll ?? 0, pin: !!(o.pin ?? list[0].pin),
      kind: o.kind ?? list[0].kind, label: o.label ?? list[0].label, value: o.value ?? list[0].value,
      result: list.some((e) => e.result === "issue") ? "issue" : "ok", n: list.length, src: list.map(src), ...o.fx,
    };
    hops.push(h);
    return h;
  }
  const lhop = (checker, tile, t, key, item, o = {}) =>
    hop(checker, tile, t, [{ box: item.box, pin: item.pin, label: o.label ?? item.name ?? item.tag, value: o.value ?? "…", result: "ok", kind: o.kind }], { ...o, fx: { ...o.fx, live: key, pending: true } });

  const nav = live.nav.length > 0, act = !!(live.button || live.input);
  const drop = nav && act ? "drop" : nav ? "dropN" : act ? "dropA" : "solo";
  const layout = [{ t: 0, name: "solo" }, { t: at(7), name: drop }, { t: at(11), name: "fit" }];
  const camera = { desktop: [{ t: 0, y: 0, d: 0 }], nav: [{ t: 0, y: 0, d: 0 }], act: [{ t: 0, y: 0, d: 0 }], phone: [{ t: 0, y: 0, d: 0 }] };
  const cam = (tile, t, y, d = E) => { const c = camera[tile]; if (c.at(-1).y !== y) c.push({ t, y, d }); };
  const inputs = [];

  const scan = scanOf(map);
  const dStops = desk.stops;
  const atStop = (c, s) => first.filter((e) => e.checker === c && e.tile === "desktop" && e.stop === s);
  const maxAt = (s) => Math.max(...READERS.map((c) => atStop(c, s).length));
  const windows = [];
  {
    const build = Math.min(2, dStops.length), dropS = dStops.slice(build).map((_, i) => i + build);
    for (let s = 0; s < build; s++) windows.push({ stop: s, t0: at(3 + s * (4 / build)), t1: at(3 + (s + 1) * (4 / build)), g: B });
    if (dropS.length) {
      const beats = dropS.map((s) => Math.max(1, Math.ceil(maxAt(s) / 2)));
      while (beats.reduce((a, b) => a + b, 0) > 16) beats[beats.indexOf(Math.max(...beats))]--;
      for (let spare = 16 - beats.reduce((a, b) => a + b, 0), i = beats.length - 1; spare > 0; spare--, i = (i - 1 + beats.length) % beats.length) beats[i]++;
      let t = at(7);
      dropS.forEach((s, i) => { windows.push({ stop: s, t0: t, t1: t + beats[i] * B, g: E }); t += beats[i] * B; });
    }
  }
  for (const w of windows) {
    cam("desktop", w.t0, dStops[w.stop]);
    const slots = Math.max(1, Math.round((w.t1 - w.t0) / w.g));
    READERS.forEach((c, ci) => {
      const list = atStop(c, w.stop);
      if (!list.length) return;
      const gs = groups(list, slots);
      const lag = ci % 2 && slots / gs.length >= 2 ? 1 : 0;
      gs.forEach((g, i) => {
        const t = w.t0 + Math.min(slots - 1, Math.floor((i * slots) / gs.length) + lag) * w.g;
        hop(c, "desktop", t, g, {
          box: g.length > 1 ? unionBox(g.map((e) => e.box)) : g[0].box, value: groupValue(c, g), label: g.length > 1 ? `${g[0].label} +${g.length - 1}` : g[0].label,
          ts: t + E + 3 * S, hold: w.g === B ? B : S, fx: { stop: w.stop },
        });
      });
    });
  }
  const planned = [];
  live.nav.forEach((l, i) => {
    const T = at(7) + i * 6 * B, c = { x: l.box.x + l.box.w / 2, y: l.box.y + l.box.h / 2 };
    lhop("NAV", "nav", T, `nav${i}:hover`, l, { kind: "hover", ts: T + E + 3 * S, hold: S, value: "hover color #000000 -> #000000" });
    inputs.push({ t: T + E, tile: "nav", type: "move", x: c.x, y: c.y, key: `nav${i}:hover`, pin: l.pin });
    const tc = T + B;
    lhop("NAV", "nav", tc, `nav${i}:click`, l, { kind: "click", d: 0, ts: tc + S, hold: E, value: `${l.href} +0000px`, fx: { click: { x: c.x, y: c.y, pin: l.pin } } });
    inputs.push({ t: tc, tile: "nav", type: "click", x: c.x, y: c.y, key: `nav${i}:click`, pin: l.pin });
    lhop("NAV", "nav", tc + S, `nav${i}:land`, { box: l.target.first, pin: false, tag: l.target.tag }, { kind: "land", hold: 3 * B, value: "1st line 00px under nav", fx: { navBottom: live.navBottom } });
    planned.push("hover", "click", "land");
  });
  let ta = at(7, 2);
  if (live.button) {
    const b = live.button, c = { x: b.box.x + b.box.w / 2, y: b.box.y + b.box.h / 2 };
    lhop("CLICK", "act", ta, "btn:hover", b, { kind: "hover", ts: ta + E + 3 * S, hold: S, value: "hover color #000000 -> #000000" });
    inputs.push({ t: ta + E, tile: "act", type: "move", x: c.x, y: c.y, key: "btn:hover", pin: b.pin });
    const tc = ta + B;
    inputs.push({ t: tc, tile: "act", type: "click", x: c.x, y: c.y, key: "btn:click", pin: b.pin });
    lhop("CLICK", "act", tc, "btn:open", b, { kind: "open", hold: E, value: "opened div.toast · 00 ch", fx: { click: { x: c.x, y: c.y, pin: b.pin } } });
    lhop("CLICK", "act", tc + E + 3 * S, "btn:close", b, { kind: "close", d: E, hold: 2 * B, value: "closed after 0.00s", fx: { timer: { from: tc, held: null } } });
    planned.push("hover", "open", "close");
    ta = at(8, 2);
  }
  if (live.input) {
    const f = live.input, text = typed(f.type);
    const away = !f.pin && f.box.y + f.box.h > 640;
    if (away) inputs.push({ t: ta, tile: "act", type: "wheel", key: "form:wheel", to: Math.max(0, Math.min(live.docH - 720, f.box.y - 260)) });
    const tf = ta + B, tt = tf + E;
    inputs.push({ t: tf, tile: "act", type: "click", x: f.box.x + Math.min(24, f.box.w / 2), y: f.box.y + f.box.h / 2, key: "form:focus", pin: f.pin, doc: true });
    lhop("FORM", "act", tf, "form:focus", f, { kind: "focus", d: 0, ts: tf + S, hold: E, value: "focused · caret in", fx: { click: { x: f.box.x + Math.min(24, f.box.w / 2), y: f.box.y + f.box.h / 2, pin: f.pin, doc: true } } });
    inputs.push({ t: tt, tile: "act", type: "type", text, key: "form:type", every: S });
    lhop("FORM", "act", tt, "form:type", f, { kind: "type", hold: 2 * B, ts: tt + (text.length + 1) * S, value: `typed ${text.length}/${text.length} ch · "${text}"` });
    planned.push("focus", "type");
  }
  if (inputs.length) inputs.push({ t: at(11) - E, tile: null, type: "park" });
  const fitEv = first.filter((e) => e.checker === "FIT");
  const pStops = phone.stops;
  const sweeps = [];
  {
    const s0 = fitEv.filter((e) => e.stop === 0);
    const over = s0.find((e) => e.kind === "overflow");
    if (over) hop("FIT", "phone", at(11), [over], { hold: 4 * B, fx: over.result === "issue" ? { overflow: { width: over.detail.width, scrollWidth: over.detail.scrollWidth } } : {} });
    const taps0 = s0.filter((e) => e.kind === "tap");
    groups(taps0, 5).forEach((g, k) => hop("FIT", "phone", at(11, 1) + k * E, g, { hold: E, box: g.length > 1 ? unionBox(g.map((e) => e.box)) : g[0].box, value: groupValue("FIT", g), fx: { gauge: g.length === 1 ? 44 : 0 } }));
    const cutHop = (t, list, d) => {
      sweeps.push({ t, d, tile: "phone", items: list.map((e) => ({ box: e.box, pin: e.pin, mscroll: e.mscroll, result: e.result })) });
      const last = list.at(-1);
      hop("FIT", "phone", t, list, { box: last.box, label: last.label, value: `${list.filter((e) => e.result === "ok").length}/${list.length} fit`, ts: t + d + S, hold: S, fx: { sweep: true } });
    };
    const cuts0 = s0.filter((e) => e.kind === "cut");
    if (cuts0.length) cutHop(at(11, 3), cuts0, E);
    const rest = pStops.length - 1, step = rest > 7 ? (7 * E) / rest : E;
    for (let s = 1; s < pStops.length; s++) {
      const t = at(12) + Math.round(((s - 1) * step) / S) * S;
      cam("phone", t, pStops[s], Math.min(E, step));
      const cuts = fitEv.filter((e) => e.stop === s && e.kind === "cut");
      if (cuts.length) cutHop(t, cuts, Math.min(E, step));
    }
    const tapsLater = fitEv.filter((e) => e.stop > 0 && e.kind === "tap");
    const lastStop = (g) => Math.max(...g.map((e) => e.stop));
    groups(tapsLater, 4).forEach((g, k) => hop("FIT", "phone", at(12, 3) + k * E, g, {
      hold: E, box: g.length > 1 ? unionBox(g.map((e) => e.box)) : g[0].box, mscroll: pStops[lastStop(g)], value: groupValue("FIT", g), fx: { gauge: g.length === 1 ? 44 : 0 },
    }));
  }

  const stamps = hops.filter((h) => !h.live).flatMap((h) => h.src.map((e) => ({ t: h.ts, issue: e.result === "issue" }))).sort((a, b) => a.t - b.t);
  const pill = [{ t: 0, mode: "scan" }, { t: at(2, 3), mode: "plan" }, { t: at(3), mode: "live" }, { t: at(15), mode: "result" }];
  const used = new Set(["desktop", "phone", ...(nav ? ["nav"] : []), ...(act ? ["act"] : [])]);
  const checkers = pickCheckers(live);
  const hidden = first.length;
  return {
    bpm: BPM, beat: B, bars: 16, duration_ms: 16 * BAR, hold_ms: 2000, site, look,
    tiles: {
      desktop: { vw: 1280, vh: 720, navBottom: desk.navBottom },
      nav: { vw: 1280, vh: 720, navBottom: live.navBottom },
      act: { vw: 1280, vh: 720 },
      phone: { vw: 392, vh: 800, navBottom: phone.navBottom },
    },
    used: [...used], checkers, sections: [["Scan", 1, 2], ["Read", 3, 6], ["Use", 7, 10], ["Fit", 11, 12], ["Converge", 13, 14], ["Result", 15, 16]].map(([name, from, to]) => ({ name, from, to, t0: at(from), t1: at(to + 1) })),
    layout, camera, inputs, scan, hops, sweeps, rulers: [], converge: [], recheck: [], pill, stamps,
    totals: { checkers: checkers.length, checks: hidden + planned.length, issues: first.filter((e) => e.result === "issue").length, map: map.length, planned: planned.length },
  };
}
export function finalize(score, all) {
  const checks = all.filter((e) => !META.has(e.checker));
  const issues = checks.filter((e) => e.result === "issue");
  const D = score.tiles.desktop;
  const vis = (b, c) => b.y >= c + D.navBottom && b.y + b.h <= c + D.vh;
  const lands = issues.filter((e) => e.kind === "land").map((e) => e.mscroll);
  let spots = [];
  for (const e of issues) {
    const tile = e.tile === "phone" ? "phone" : "desktop";
    let scroll = e.pin ? null : e.kind === "land" ? e.mscroll : (lands.find((c) => vis(e.box, c)) ?? e.scroll ?? e.mscroll ?? 0);
    if (tile === "phone") scroll = e.pin ? null : (e.mscroll ?? 0);
    const prev = tile === "phone" && spots.find((s) => s.tile === "phone" && s.kind === e.kind && s.scroll === scroll);
    if (prev) { prev.items.push(e); continue; }
    spots.push({ tile, kind: e.kind, scroll, items: [e] });
  }
  while (spots.length > 16) {
    let k = spots.findIndex((s, i) => i > 0 && spots[i - 1].tile === s.tile && spots[i - 1].scroll === s.scroll);
    if (k < 0) k = spots.length - 1;
    spots[k - 1].items.push(...spots[k].items);
    spots.splice(k, 1);
  }
  const ph = spots.filter((s) => s.tile === "phone").sort((a, b) => (b.scroll ?? -1) - (a.scroll ?? -1));
  const dk = spots.filter((s) => s.tile === "desktop").sort((a, b) =>
    (b.scroll ?? 0) - (a.scroll ?? 0) || (b.kind === "land") - (a.kind === "land") || a.items[0].box.y - b.items[0].box.y);
  spots = [...ph, ...dk];
  const camNow = { desktop: score.camera.desktop.at(-1).y, phone: score.camera.phone.at(-1).y };
  const moves = spots.map((s, i) => {
    const move = s.scroll != null && camNow[s.tile] !== s.scroll;
    if (move) camNow[s.tile] = s.scroll;
    return i === 0 || move;
  });
  const eighths = 16, base = Math.max(1, Math.floor(eighths / Math.max(1, spots.length))), len = spots.map(() => base);
  let extra = eighths - base * spots.length;
  for (const pass of [true, false]) spots.forEach((_, i) => { if (extra > 0 && moves[i] === pass) { len[i]++; extra--; } });
  let t = at(13);
  const item = (e) => ({ checker: e.checker, kind: e.kind, label: e.label, value: e.value, box: e.box, mscroll: e.mscroll ?? 0, pin: !!e.pin });
  const converge = spots.map((s, i) => { const o = { ...s, t, d: len[i] * E, items: s.items.map(item) }; t += len[i] * E; return o; });
  const camera = { desktop: [], phone: [] };
  const last = { desktop: score.camera.desktop.at(-1).y, phone: score.camera.phone.at(-1).y };
  for (const s of converge) if (s.scroll != null && last[s.tile] !== s.scroll) { camera[s.tile].push({ t: s.t, y: s.scroll, d: E }); last[s.tile] = s.scroll; }
  if (last.desktop !== 0) camera.desktop.push({ t: at(15), y: 0, d: E });
  return { converge, camera, totals: { checks: checks.length, issues: issues.length } };
}

export function foldScore(input) {
  const score = structuredClone(input);
  score.tiles = { desktop: score.tiles.desktop, phone: score.tiles.phone };
  score.used = ["desktop", "phone"];
  score.layout = [{ t: 0, name: "fixed" }];
  score.camera = { desktop: score.camera.desktop, phone: score.camera.phone };
  const groups = [...new Set(score.inputs.filter(i => i.key).map(i => i.key.startsWith("nav") ? i.key.split(":")[0] : i.key.startsWith("btn") ? "btn" : i.key.startsWith("form") ? "form" : null).filter(Boolean))];
  let cursor = at(7);
  for (const key of groups) {
    const match = s => s.startsWith(key + ":");
    const hops = score.hops.filter(h => h.live && match(h.live));
    const inputs = score.inputs.filter(i => i.key && match(i.key));
    const first = Math.min(...hops.map(h => h.t), ...inputs.map(i => i.t));
    const offset = up16(cursor) - first;
    const end = key === "form" ? Math.max(...hops.map(h => h.ts)) + S : cursor + (key === "btn" ? 4 : 3) * B;
    for (const h of hops) {
      h.tile = "desktop";
      h.t += offset; h.ta += offset; h.ts += offset;
      if (h.timer) h.timer.from += offset;
    }
    for (const i of inputs) { i.tile = "desktop"; i.t += offset; }
    cursor = key === "form" ? end + offset : end;
  }
  for (const h of score.hops) if (h.tile === "nav" || h.tile === "act") h.tile = "desktop";
  for (const i of score.inputs) if (i.type === "park") i.t = Math.min(at(12) - S, cursor);
  score.inputs.sort((a, b) => a.t - b.t);
  return score;
}
export const scanScore = input => foldScore(rawScanScore(input));
export const conduct = input => foldScore(rawConduct(input));
