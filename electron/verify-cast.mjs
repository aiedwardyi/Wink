import { VERIFY_GEOMETRY } from "./verify-protocol.mjs";

// The link drops a cast frame of 192 KiB base64 or more.
const FRAME_BYTES = 140 * 1024;

export function startCast({ cdp, page, tile, started, frame }) {
  let stopped = false, received = false, capturing = false, last = -Infinity;
  const timers = new Set();
  const { cssW, cssH, dpr } = VERIFY_GEOMETRY[tile], size = { maxWidth: cssW * dpr, maxHeight: cssH * dpr };
  const jpeg = image => {
    const sized = image.resize({ width: size.maxWidth });
    let bytes;
    for (const quality of [80, 65, 50]) if ((bytes = sized.toJPEG(quality)).length <= FRAME_BYTES) break;
    return bytes.toString("base64");
  };
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
  void cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, ...size }).catch(() => {});
  return {
    readerStop() {
      if (stopped || received || capturing || !page.capturePage || Date.now() - last < 250) return;
      capturing = true;
      void page.capturePage().then(image => {
        if (!stopped && !received) emit(jpeg(image));
      }).catch(() => {}).finally(() => { capturing = false; });
    },
    async shot() {
      if (stopped || !page.capturePage) return;
      const image = await page.capturePage();
      if (stopped) return;
      last = Date.now();
      frame({ tile, ms: Math.max(0, last - started), data: jpeg(image) });
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
