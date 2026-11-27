import { VERIFY_GEOMETRY } from "./verify-protocol.mjs";

// A JPEG at most this size is ~187 KiB base64 (x 4/3), under the link's 192 KiB frame cap.
const FRAME_BYTES = 140 * 1024;

export function startCast({ cdp, page, tile, started, frame }) {
  let stopped = false, received = false, capturing = false, wanted = false, retry = null, last = -Infinity;
  const timers = new Set();
  const { cssW, cssH, dpr } = VERIFY_GEOMETRY[tile], size = { maxWidth: cssW * dpr, maxHeight: cssH * dpr };
  const jpeg = image => {
    // capturePage gives the phone at CSS px, so never upscale past what the page drew.
    const own = Math.min(size.maxWidth, image.getSize().width);
    for (const width of [own, Math.round(own / 2)]) {
      const sized = image.resize({ width });
      for (const quality of [70, 50]) {
        const bytes = sized.toJPEG(quality);
        if (bytes.length <= FRAME_BYTES) return bytes.toString("base64");
      }
    }
    return null;
  };
  const emit = data => {
    if (stopped || !data || Date.now() - last < 250) return;
    last = Date.now();
    frame({ tile, ms: Math.max(0, Date.now() - started), data });
  };
  // A frame too big for the link is replaced by a capture once the throttle allows, even after accepted frames.
  const fallback = () => {
    if (stopped || !wanted || capturing || retry || !page.capturePage) return;
    const wait = last + 250 - Date.now();
    if (wait > 0) { retry = setTimeout(() => { retry = null; fallback(); }, wait); return; }
    wanted = false;
    capturing = true;
    void page.capturePage().then(image => {
      if (!stopped) emit(jpeg(image));
    }).catch(() => {}).finally(() => { capturing = false; fallback(); });
  };
  const off = cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
    if (stopped) return;
    if (data.length <= FRAME_BYTES * 4 / 3) {
      received = true;
      try { emit(data); } catch {}
    } else {
      wanted = true;
      fallback();
    }
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
      }).catch(() => {}).finally(() => { capturing = false; fallback(); });
    },
    async shot() {
      if (stopped || !page.capturePage) return;
      const data = jpeg(await page.capturePage());
      if (stopped || !data) return;
      last = Date.now();
      frame({ tile, ms: Math.max(0, last - started), data });
    },
    stop() {
      stopped = true;
      off();
      clearTimeout(retry);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      void cdp.send("Page.stopScreencast").catch(() => {});
    },
  };
}
