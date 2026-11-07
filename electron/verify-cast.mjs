export function startCast({ cdp, page, tile, started, frame }) {
  let stopped = false, received = false, capturing = false, last = -Infinity;
  const timers = new Set();
  const emit = data => {
    if (stopped || Date.now() - last < 250) return;
    last = Date.now();
    frame({ tile, ms: Math.max(0, Date.now() - started), data });
  };
  const off = cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
    if (stopped) return;
    received = true;
    try { emit(data); } catch {}
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!stopped) void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    }, 250);
    timers.add(timer);
  });
  void cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, ...(tile === "desktop" ? { maxWidth: 640 } : { maxHeight: 800 }) }).catch(() => {});
  return {
    readerStop() {
      if (stopped || received || capturing || !page.capturePage || Date.now() - last < 250) return;
      capturing = true;
      void page.capturePage().then(image => {
        if (!stopped && !received) emit(image.resize(tile === "desktop" ? { width: 640 } : { height: 800 }).toJPEG(60).toString("base64"));
      }).catch(() => {}).finally(() => { capturing = false; });
    },
    stop() {
      stopped = true;
      off();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      void cdp.send("Page.stopScreencast").catch(() => {});
    },
  };
}
