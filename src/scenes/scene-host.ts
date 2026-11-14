// A chat scene draws behind the transcript only on events (send, busy, reply)
// and stops itself; a theme tile asks it to loop. The host owns the frame loop
// so no scene can run while the window is hidden, or blurred for scenes that
// ask, or under reduced motion.
import { reducedMotion } from "@/lib/phone-swipe";

export type SceneRect = { x: number; y: number; w: number; h: number; cx: number; cy: number };

export type SceneEvent =
  | { name: "send"; at: Element }
  | { name: "busy" }
  | { name: "reply"; at?: Element }
  | { name: "loop" }
  | { name: "skin" }
  | { name: "motion" };

export type SceneApi = {
  layer: HTMLElement;
  wake(): void;
  /** Loop clock in ms; it only moves while frames run. */
  time(): number;
  reduced(): boolean;
  skin(): string;
  dark(): boolean;
  rectIn(el: Element): SceneRect;
  after(ms: number, fn: () => void): void;
};

export type Scene = {
  /** False ends the loop; the last frame stays up as a still. */
  frame(t: number, dt: number): boolean;
  event(event: SceneEvent): void;
  dispose(): void;
};

export type SceneModule = { pauseOnBlur: boolean; create(api: SceneApi): Scene };

export type SceneHost = { emit(event: SceneEvent): void; running(): boolean; stop(): void };

/** `look` carries the skin; a theme tile is its own, while rest always follows `root`. */
export function startScene(layer: HTMLElement, module: SceneModule, root: HTMLElement = document.documentElement, look: HTMLElement = root): SceneHost {
  let on = false;
  let want = false;
  let raf = 0;
  let last = 0;
  let clock = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const paused = () => {
    const idle = root.getAttribute("data-orbit-idle");
    return idle === "hidden" || (module.pauseOnBlur && idle === "blur");
  };
  const halt = () => {
    if (!on) return;
    on = false;
    cancelAnimationFrame(raf);
  };
  const tick = (now: number) => {
    if (!on) return;
    if (paused()) return halt();
    const dt = Math.min(50, Math.max(0, now - last));
    last = now;
    clock += dt;
    if (!scene.frame(clock, dt)) {
      on = false;
      want = false;
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  const wake = () => {
    if (reducedMotion()) return;
    want = true;
    if (on || paused()) return;
    on = true;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  };

  const api: SceneApi = {
    layer,
    wake,
    time: () => clock,
    reduced: () => reducedMotion(),
    skin: () => look.dataset.skin ?? "",
    dark() {
      const m = getComputedStyle(look).getPropertyValue("--color-app").trim().match(/^#(..)(..)(..)/);
      return !m || 0.2126 * parseInt(m[1], 16) + 0.7152 * parseInt(m[2], 16) + 0.0722 * parseInt(m[3], 16) < 128;
    },
    rectIn(el) {
      const a = el.getBoundingClientRect();
      const b = layer.getBoundingClientRect();
      const x = a.left - b.left;
      const y = a.top - b.top;
      return { x, y, w: a.width, h: a.height, cx: x + a.width / 2, cy: y + a.height / 2 };
    },
    after(ms, fn) {
      const id = setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
    },
  };
  const scene = module.create(api);

  // Same frame as idle-motion's attribute write: the observer runs before the next paint.
  const idle = new MutationObserver(() => {
    if (paused()) halt();
    else if (want) wake();
  });
  idle.observe(root, { attributes: true, attributeFilter: ["data-orbit-idle"] });
  const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const onMotion = () => {
    if (reducedMotion()) {
      halt();
      want = false;
    }
    scene.event({ name: "motion" });
  };
  motion?.addEventListener?.("change", onMotion);

  return {
    emit: (event) => scene.event(event),
    running: () => on,
    stop() {
      halt();
      want = false;
      idle.disconnect();
      motion?.removeEventListener?.("change", onMotion);
      for (const id of timers) clearTimeout(id);
      scene.dispose();
    },
  };
}
