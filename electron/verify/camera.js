(() => {
  function scrollAt(score, tile, t) {
    if (score.hops.some(h => h.tile === tile && h.live && !h.skip && t >= h.t && (t < h.ts + h.hold || (h.pending && t < 44 * score.beat)))) return null;
    const c = score.camera[tile];
    let i = c.length - 1;
    while (i > 0 && c[i].t > t) i--;
    if (i === 0) return c[0].y;
    const q = c[i], u = Math.max(0, Math.min(1, (t - q.t) / q.d));
    return Math.round(q.d ? c[i - 1].y + (q.y - c[i - 1].y) * (1 - (1 - u) ** 3) : q.y);
  }
  globalThis.LiveVerifyCamera = { scrollAt };
})();
