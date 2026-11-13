export function createMapEvents() {
  const listeners = new Map();
  return {
    watch(botId, listener) {
      const bot = listeners.get(botId) ?? new Set();
      bot.add(listener);
      listeners.set(botId, bot);
      return () => { bot.delete(listener); if (!bot.size) listeners.delete(botId); };
    },
    emit(botId) {
      for (const listener of listeners.get(botId) ?? []) {
        try { listener(); } catch {}
      }
    },
  };
}

export function streamMapPanes(res, host, botId) {
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
  res.socket?.setTimeout(0);
  const send = () => {
    if (res.destroyed || res.writableEnded) return;
    res.write("{}\n");
    if (res.writableLength > 4096) res.destroy();
  };
  const stop = host.watchMap(botId, send);
  res.once("close", stop);
  send();
}
