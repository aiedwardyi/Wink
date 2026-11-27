import type { SceneModule } from "@/scenes/scene-host";
import { loadScene, type SceneId } from "./ChatScene";

type Tile = { scene: SceneId; start(module: SceneModule): void };

let queue: Tile[] = [];
let frame = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

async function flush() {
  const batch = queue;
  queue = [];
  const modules = new Map<SceneId, Promise<SceneModule>>();
  for (const { scene } of batch) if (!modules.has(scene)) modules.set(scene, loadScene(scene));
  // Every chunk lands before any tile starts, so no tile's first frame waits on another's download.
  const loaded = new Map(await Promise.all([...modules].map(async ([scene, load]) => [scene, await load.catch(() => undefined)] as const)));
  for (const tile of batch) {
    const module = loaded.get(tile.scene);
    if (module) tile.start(module);
  }
}

/** Tiles queued in one commit start in one task, so their loops share a first frame. Returns the cancel. */
export function startTogether(tile: Tile): () => void {
  queue.push(tile);
  // After the first paint: a first shader compile must not hold up opening Themes.
  if (!frame && timer === undefined) frame = requestAnimationFrame(() => { frame = 0; timer = setTimeout(() => { timer = undefined; void flush(); }, 0); });
  return () => {
    queue = queue.filter((queued) => queued !== tile);
    if (queue.length) return;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    frame = 0;
    timer = undefined;
  };
}
