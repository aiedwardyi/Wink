(() => {
  const limit = (n, max = 5000) => { if (n > max) throw new Error("resource-limit"); };
  const nodes = (selector, max = 5000) => { const found = document.querySelectorAll(selector); limit(found.length, max); return [...found]; };
  const cs = (el) => getComputedStyle(el);
  const INLINE = new Set(["inline", "contents"]);
  const r1 = (n) => Math.round(n * 10) / 10;
  const box = (r) => ({ x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) });

  function cssPath(el) {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
      if (e.id) { parts.unshift("#" + CSS.escape(e.id)); break; }
      let sel = e.localName;
      const p = e.parentElement;
      if (p) {
        const same = [...p.children].filter((c) => c.localName === e.localName);
        if (same.length > 1) sel += `:nth-of-type(${same.indexOf(e) + 1})`;
      }
      parts.unshift(sel);
    }
    return parts.join(" > ") || "html";
  }

  function pinned(el) {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const p = cs(e).position;
      if (p === "fixed" || p === "sticky") return true;
    }
    return false;
  }

  function visible(el) {
    const s = cs(el);
    if (s.display === "none" || s.visibility !== "visible" || +s.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  const label = (el) => {
    // SVG className is an SVGAnimatedString, unlike HTML className.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    const c = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/)[0] : "";
    return el.localName + (el.id ? "#" + el.id : c);
  };

  function textRects(nodes) {
    const out = [];
    for (const n of nodes) {
      const r = document.createRange();
      r.selectNodeContents(n);
      for (const q of r.getClientRects()) if (q.width > 0.5 && q.height > 0.5) out.push(q);
    }
    return out;
  }

  function union(rects) {
    const l = Math.min(...rects.map((r) => r.left)), t = Math.min(...rects.map((r) => r.top));
    const rr = Math.max(...rects.map((r) => r.right)), b = Math.max(...rects.map((r) => r.bottom));
    return { left: l, top: t, width: rr - l, height: b - t, right: rr, bottom: b };
  }
  function blocks() {
    const map = new Map();
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let visited = 0;
    for (let n; (n = w.nextNode()); ) {
      limit(++visited);
      if (!n.nodeValue.trim()) continue;
      const p = n.parentElement;
      if (!p || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(p.tagName) || !visible(p)) continue;
      let b = p;
      while (b.parentElement && INLINE.has(cs(b).display)) b = b.parentElement;
      if (!map.has(b)) map.set(b, []);
      map.get(b).push(n);
    }
    return [...map].map(([el, nodes]) => ({ el, nodes }));
  }

  function blockInfo({ el, nodes }) {
    const text = nodes.map((n) => n.nodeValue).join(" ").replace(/\s+/g, " ").trim();
    const rects = textRects(nodes);
    const u = rects.length ? union(rects) : el.getBoundingClientRect();
    const s = cs(el);
    return { path: cssPath(el), tag: label(el), text, chars: [...text].length, box: box(u), elBox: box(el.getBoundingClientRect()), pin: pinned(el), size: parseFloat(s.fontSize), weight: +s.fontWeight || 400, family: s.fontFamily };
  }

  let BLOCKS = null;
  const allBlocks = () => (BLOCKS ??= blocks());
  const byPath = (path) => allBlocks().find((b) => cssPath(b.el) === path);

  function map() {
    const out = [];
    for (const el of nodes("body *")) {
      if (["SCRIPT", "STYLE"].includes(el.tagName) || !visible(el)) continue;
      out.push({ path: cssPath(el), tag: label(el), box: box(el.getBoundingClientRect()), pin: pinned(el), deco: cs(el).pointerEvents === "none" && !el.textContent.trim() });
    }
    return out;
  }
  function parseColor(s) {
    const m = s && s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const over = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  function mix(a, b, u) {
    const A = a.a + (b.a - a.a) * u;
    if (A <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    const ch = (k) => (a[k] * a.a + (b[k] * b.a - a[k] * a.a) * u) / A;
    return { r: ch("r"), g: ch("g"), b: ch("b"), a: A };
  }
  function splitTop(s) {
    const out = [];
    let d = 0, cur = "";
    for (const ch of s) {
      if (ch === "(") d++;
      if (ch === ")") d--;
      if (ch === "," && d === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  function gradients(bgImage) {
    if (!bgImage || bgImage === "none") return [];
    return splitTop(bgImage).map((g) => {
      const m = g.match(/^(linear|radial)-gradient\((.*)\)$/);
      if (!m) return null;
      const args = splitTop(m[2]);
      let angle = 180, radial = "ellipse", i = 0;
      if (m[1] === "linear") {
        if (/deg$/.test(args[0])) { angle = parseFloat(args[0]); i = 1; }
        else if (/^to /.test(args[0])) { angle = { "to top": 0, "to right": 90, "to bottom": 180, "to left": 270 }[args[0]] ?? 180; i = 1; }
      } else if (!/^rgba?\(/.test(args[0])) { radial = args[0]; i = 1; }
      const stops = args.slice(i).map((a) => {
        const c = a.match(/rgba?\([^)]*\)/)[0];
        const pos = a.replace(c, "").trim();
        return { c: parseColor(c), p: pos ? parseFloat(pos) / 100 : null };
      });
      if (stops[0].p == null) stops[0].p = 0;
      if (stops.at(-1).p == null) stops.at(-1).p = 1;
      for (let k = 1; k < stops.length - 1; k++) if (stops[k].p == null) {
        let j = k; while (stops[j].p == null) j++;
        const a = stops[k - 1].p, b = stops[j].p;
        for (let q = k; q < j; q++) stops[q].p = a + ((b - a) * (q - k + 1)) / (j - k + 1);
      }
      return { kind: m[1], angle, radial, stops };
    }).filter(Boolean);
  }
  function stopAt(stops, t) {
    if (t <= stops[0].p) return stops[0].c;
    for (let i = 1; i < stops.length; i++) if (t <= stops[i].p) {
      const a = stops[i - 1], b = stops[i];
      return mix(a.c, b.c, (t - a.p) / (b.p - a.p || 1));
    }
    return stops.at(-1).c;
  }
  function gradAt(g, el, x, y) {
    const r = el.getBoundingClientRect();
    const W = el.clientWidth || r.width, H = el.clientHeight || r.height;
    const px = x - r.left - el.clientLeft, py = y - r.top - el.clientTop;
    if (g.kind === "linear") {
      const th = (g.angle * Math.PI) / 180, dx = Math.sin(th), dy = -Math.cos(th);
      const L = Math.abs(W * dx) + Math.abs(H * dy);
      return stopAt(g.stops, ((px - W / 2) * dx + (py - H / 2) * dy) / L + 0.5);
    }
    const cx = px - W / 2, cy = py - H / 2;
    if (/circle/.test(g.radial)) return stopAt(g.stops, Math.hypot(cx, cy) / Math.hypot(W / 2, H / 2));
    return stopAt(g.stops, Math.hypot(cx / ((W / 2) * Math.SQRT2), cy / ((H / 2) * Math.SQRT2)));
  }
  const isClipText = (el) => /text/.test(cs(el).backgroundClip || cs(el).webkitBackgroundClip || "");

  function paintLayers(el, x, y, base) {
    let c = base;
    const s = cs(el);
    const bc = parseColor(s.backgroundColor);
    if (bc && bc.a > 0) c = over(bc, c);
    if (!isClipText(el)) for (const g of gradients(s.backgroundImage).reverse()) {
      const gc = gradAt(g, el, x, y);
      if (gc.a > 0) c = over(gc, c);
    }
    return c;
  }
  function backdrop(textEl, x, y) {
    const root = cs(document.documentElement), body = cs(document.body);
    const rootBg = parseColor(root.backgroundColor);
    let base = rootBg && rootBg.a > 0 ? rootBg : parseColor(body.backgroundColor);
    if (!base || base.a === 0) base = { r: 255, g: 255, b: 255, a: 1 };
    base = { ...base, a: 1 };
    let c = base;
    for (const el of nodes("body *")) {
      if (cs(el).pointerEvents !== "none" || el.contains(textEl) || el.textContent.trim()) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) c = paintLayers(el, x, y, c);
    }
    const stack = document.elementsFromPoint(x, y);
    const i = stack.findIndex((e) => e === textEl || e.contains(textEl));
    const below = (i < 0 ? stack : stack.slice(i)).reverse();
    for (const el of below) {
      if (el === document.documentElement || (el === document.body && !(rootBg && rootBg.a > 0))) continue;
      c = paintLayers(el, x, y, c);
    }
    return { c, coveredBy: i > 0 && !textEl.contains(stack[0]) ? label(stack[0]) : null };
  }

  function textColor(node, x, y) {
    for (let e = node.parentElement; e && e !== document.body; e = e.parentElement) {
      const s = cs(e);
      const fill = parseColor(s.webkitTextFillColor);
      if (fill && fill.a === 0 && isClipText(e)) {
        const g = gradients(s.backgroundImage)[0];
        if (g) return gradAt(g, e, x, y);
      }
      if (!INLINE.has(s.display) || e === node.parentElement) {
        if (!(fill && fill.a === 0)) break;
      }
    }
    const p = node.parentElement, s = cs(p);
    const fill = parseColor(s.webkitTextFillColor);
    return fill && fill.a > 0 ? fill : parseColor(s.color);
  }

  function contrast(path) {
    const b = byPath(path);
    const s = cs(b.el);
    let worst = null;
    for (const n of b.nodes) {
      if (!/[\p{L}\p{N}]/u.test(n.nodeValue)) continue;
      const ps = cs(n.parentElement);
      const size = parseFloat(ps.fontSize), weight = +ps.fontWeight || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const need = large ? 3 : 4.5;
      for (const q of textRects([n])) for (const fx of [0.12, 0.5, 0.88]) {
        const x = q.left + q.width * fx, y = q.top + q.height / 2;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const bd = backdrop(n.parentElement, x, y);
        let tc = textColor(n, x, y);
        if (tc.a < 1) tc = over(tc, bd.c);
        const r = ratio(tc, bd.c);
        if (!worst || r / need < worst.ratio / worst.need) worst = { ratio: r, need, large, fg: hex(tc), bg: hex(bd.c), size, weight };
      }
    }
    if (!worst) return { skip: true };
    return { ...worst, ratio: Math.round(worst.ratio * 100) / 100, ok: worst.ratio >= worst.need, opacity: s.opacity };
  }
  function clipped(el, rects) {
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const s = cs(a);
      if (s.overflowX === "visible" && s.overflowY === "visible") continue;
      const r = a.getBoundingClientRect();
      const l = r.left + a.clientLeft, t = r.top + a.clientTop, R = l + a.clientWidth, B = t + a.clientHeight;
      for (const q of rects) {
        const cut = Math.max(l - q.left, q.right - R, s.overflowY === "visible" ? 0 : Math.max(t - q.top, q.bottom - B));
        if (cut > 1) return { by: label(a), px: Math.round(cut) };
      }
    }
    const vw = document.documentElement.clientWidth;
    for (const q of rects) if (q.right > vw + 1) return { by: "viewport", px: Math.round(q.right - vw) };
    return null;
  }

  function text(path) {
    const b = byPath(path);
    const info = blockInfo(b);
    const rects = textRects(b.nodes);
    const q = rects[0];
    let covered = null;
    if (q) {
      const x = q.left + Math.min(q.width / 2, 12), y = q.top + q.height / 2;
      if (x >= 0 && y >= 0 && x < innerWidth && y < innerHeight) {
        const hit = document.elementFromPoint(x, y);
        if (hit && !b.el.contains(hit) && !hit.contains(b.el)) covered = label(hit);
      }
    }
    const clip = clipped(b.el, rects);
    const placeholder = /lorem|ipsum|\btodo\b|undefined|\bnull\b|\bNaN\b|\{\{|\}\}|\[object/i.test(info.text);
    const lines = new Set(rects.map((r) => Math.round(r.top))).size;
    return { ...info, lines, covered, clip, placeholder, ok: !covered && !clip && !placeholder };
  }

  function headings() {
    const hs = nodes("h1,h2,h3,h4,h5,h6", 300).filter(visible);
    return hs.map((h, i) => {
      const level = +h.tagName[1], prev = i ? +hs[i - 1].tagName[1] : 0;
      const txt = h.textContent.replace(/\s+/g, " ").trim();
      const skip = level > prev + 1;
      return { path: cssPath(h), tag: label(h), level, prev, text: txt, box: box(h.getBoundingClientRect()), pin: pinned(h), ok: !skip && !!txt, skip };
    });
  }

  function links() {
    return nodes("a[href]", 300).filter(visible).map((a) => {
      const href = a.getAttribute("href");
      let target = null;
      if (href.startsWith("#")) {
        try {
          const id = decodeURIComponent(href.slice(1));
          const t = id ? document.getElementById(id) : document.documentElement;
          const dup = id ? document.querySelectorAll(`[id="${CSS.escape(id)}"]`).length : 1;
          if (t) target = { path: cssPath(t), tag: label(t), box: box(t.getBoundingClientRect()), unique: dup === 1 };
        } catch {}
      }
      const name = (a.getAttribute("aria-label") || a.textContent).replace(/\s+/g, " ").trim();
      return { path: cssPath(a), tag: label(a), href, name, box: box(a.getBoundingClientRect()), pin: pinned(a), target, ok: !!name && (!href.startsWith("#") || (!!target && target.unique)) };
    });
  }

  function buttons() {
    return nodes("button, [role=button], input[type=button], input[type=submit]", 300).filter(visible).map((b) => {
      const r = b.getBoundingClientRect();
      const name = (b.getAttribute("aria-label") || b.textContent || b.value || "").replace(/\s+/g, " ").trim();
      return { path: cssPath(b), tag: label(b), name, disabled: !!b.disabled, tabIndex: b.tabIndex, w: r1(r.width), h: r1(r.height), box: box(r), pin: pinned(b), cursor: cs(b).cursor, form: !!b.form, href: !!b.closest("a[href]") };
    });
  }
  function navBottom() {
    let b = 0;
    for (const el of nodes("body *")) {
      const p = cs(el).position;
      if (p !== "fixed" && p !== "sticky") continue;
      const r = el.getBoundingClientRect();
      if (visible(el) && r.top <= 2 && r.width >= innerWidth * 0.5 && r.bottom < innerHeight * 0.4) b = Math.max(b, r.bottom);
    }
    if (!b) { const n = document.querySelector("nav"); if (n && pinned(n)) b = n.getBoundingClientRect().bottom; }
    return Math.round(b);
  }

  function firstText(path) {
    const t = document.querySelector(path);
    const w = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode()); ) {
      if (n.nodeValue.trim() && visible(n.parentElement)) { const q = textRects([n])[0]; if (q) return box(q); }
    }
    return box(t.getBoundingClientRect());
  }

  function inputs() {
    return nodes("input, textarea", 300).filter((el) => visible(el) && !el.disabled && !el.readOnly && /^(text|email|tel|search|url|number|)$/.test(el.type === "textarea" ? "" : el.type)).map((el) => {
      const r = el.getBoundingClientRect();
      return { path: cssPath(el), tag: label(el), type: el.localName === "textarea" ? "textarea" : el.type, name: (el.getAttribute("aria-label") || el.placeholder || el.name || "").trim(), box: box(r), pin: pinned(el), value: el.value };
    });
  }
  const snap = () => map().map((m) => m.path);
  function opened(before) {
    const was = new Set(before);
    const fresh = map().filter((m) => !was.has(m.path) && m.box.w * m.box.h > 0);
    const top = fresh.filter((m) => !fresh.some((o) => o !== m && document.querySelector(o.path)?.contains(document.querySelector(m.path))));
    top.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h);
    const m = top[0];
    if (!m) return { open: false, n: 0 };
    const el = document.querySelector(m.path);
    return { open: true, n: fresh.length, path: m.path, tag: m.tag, box: m.box, pin: m.pin, text: el.textContent.replace(/\s+/g, " ").trim().slice(0, 80) };
  }
  const still = (path) => { const el = path && document.querySelector(path); return !!el && visible(el); };
  function landing(targetPath) {
    const t = document.querySelector(targetPath);
    const w = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
    let first = null;
    for (let n; (n = w.nextNode()) && !first; ) {
      if (n.nodeValue.trim() && visible(n.parentElement)) first = textRects([n])[0] ?? null;
    }
    first ??= t.getBoundingClientRect();
    const nb = navBottom();
    return { scrollY: Math.round(scrollY), hash: location.hash, targetTop: Math.round(t.getBoundingClientRect().top), textTop: Math.round(first.top), navBottom: nb, hidden: Math.max(0, Math.round(nb - first.top)), firstText: box(first) };
  }

  function lift(path) {
    const el = document.querySelector(path), s = cs(el);
    const m = new DOMMatrix(s.transform === "none" ? undefined : s.transform);
    return { ty: r1(m.m42), scale: r1(m.a), color: s.color, bg: s.backgroundColor, bgi: s.backgroundImage, shadow: s.boxShadow, border: s.borderColor, deco: s.textDecorationLine, opacity: s.opacity };
  }
  function fit() {
    const de = document.documentElement;
    const W = de.clientWidth;
    const unclipped = (el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) if (cs(a).overflowX !== "visible") return false; return true; };
    const wide = [...nodes("body *")].filter((el) => visible(el) && el.getBoundingClientRect().right > W + 1 && unclipped(el));
    const over = wide.filter((el) => !wide.some((a) => a !== el && a.contains(el))).map((el) => {
      const r = el.getBoundingClientRect();
      return { path: cssPath(el), tag: label(el), box: box(r), pin: pinned(el), px: Math.round(r.right - W), deco: cs(el).pointerEvents === "none" && !el.textContent.trim() };
    }).sort((a, b) => b.px - a.px);
    const taps = nodes("a[href], button, input, select, textarea, [role=button]", 300).filter(visible).map((el) => {
      const r = el.getBoundingClientRect();
      return { path: cssPath(el), tag: label(el), name: el.textContent.replace(/\s+/g, " ").trim(), w: r1(r.width), h: r1(r.height), box: box(r), pin: pinned(el), ok: r.width >= 44 && r.height >= 44 };
    });
    return { width: W, innerWidth, scrollWidth: de.scrollWidth, docHeight: de.scrollHeight, over, taps };
  }

  let allow = false;
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "wheel"]) {
    addEventListener(type, event => { if (!allow) { event.preventDefault(); event.stopImmediatePropagation(); } }, { capture: true, passive: false });
  }
  const api = { map, blocks: () => allBlocks().map(blockInfo), text, contrast, headings, links, buttons, navBottom, landing, firstText, inputs, snap, opened, still, lift, fit, reset: () => { BLOCKS = null; } };
  const targets = new Set();
  globalThis.lv = Object.fromEntries(Object.entries(api).map(([key, fn]) => [key, (...args) => {
    limit(document.getElementsByTagName("*").length);
    const value = fn(...args);
    const items = key === "fit" ? value.taps : ["blocks", "headings", "links", "buttons", "inputs"].includes(key) ? value : [];
    for (const item of items) {
      targets.add(item.path);
      if (item.target) targets.add(item.target.path);
      limit(targets.size, 300);
    }
    return value;
  }]));
  globalThis.lv.allow = value => (allow = value);
})();
