// The animated backdrop of the scene themes. Each scene is its own lazy chunk,
// so other themes load and run none of it.
import { useEffect, useRef, type RefObject } from "react";
import { reducedMotion } from "@/lib/phone-swipe";
import { SKINS, SKIN_CHANGE_EVENT, type SkinId } from "@/lib/skins";
import { startScene, type SceneHost, type SceneModule } from "@/scenes/scene-host";
import { offerThemeRow, scenePlayed } from "./WhatsNew";
import "@/scenes/scenes.css";

export type SceneId = "lagoon" | "snow";

const SCENE_SKINS: Partial<Record<SkinId, SceneId>> = { lagoon: "lagoon", "lagoon-night": "lagoon", snow: "snow", "snow-night": "snow" };
const LOAD: Record<SceneId, () => Promise<{ default: SceneModule }>> = {
  lagoon: () => import("@/scenes/lagoon"),
  snow: () => import("@/scenes/snow"),
};
const BUBBLES = '[data-orbit-message="bot"] [data-orbit-message-content]';

export const sceneOf = (skin: SkinId): SceneId | undefined => SCENE_SKINS[skin];
export const loadScene = (scene: SceneId): Promise<SceneModule> => LOAD[scene]().then((module) => module.default);

// A pick owes one play in the next visible chat. The startup apply follows no skin, so it is not a pick.
let applied = globalThis.document?.documentElement.dataset.skin;
let owed: SceneId | undefined;
globalThis.window?.addEventListener?.(SKIN_CHANGE_EVENT, () => {
  const skin = SKINS.find(({ id }) => id === document.documentElement.dataset.skin)?.id;
  if (applied && skin && skin !== applied) {
    owed = sceneOf(skin);
    offerThemeRow(owed && !reducedMotion() ? owed : null);
  }
  applied = skin;
});

/** The reply's burst from the last reply. Mid-turn that would settle the scene early, so the turn's own start plays again. */
function playOwed(host: SceneHost, scene: SceneId, layer: HTMLElement, turn: { working: boolean; hidden: boolean }) {
  if (turn.hidden || owed !== scene) return;
  owed = undefined;
  const frame = layer.parentElement?.querySelector("[data-orbit-composer-frame]") ?? undefined;
  const bubbles = layer.parentElement?.querySelectorAll(BUBBLES);
  if (!turn.working) host.emit({ name: "reply", at: bubbles?.[bubbles.length - 1] ?? frame });
  else {
    if (frame) host.emit({ name: "send", at: frame });
    // Snow rests 30s into a turn, and only busy wakes it.
    host.emit({ name: "busy" });
  }
  if (host.running()) scenePlayed(scene);
}

type Props = { scene: SceneId; skin: SkinId; working: boolean; threadId: string; hidden: boolean; sendRef: RefObject<(() => void) | null> };

/** sendRef is filled with this chat's send trigger; the only one besides the turn ending. */
export function ChatScene({ scene, skin, working, threadId, hidden, sendRef }: Props) {
  const layer = useRef<HTMLDivElement>(null);
  const host = useRef<SceneHost | null>(null);
  const turn = useRef({ working, threadId, hidden });

  useEffect(() => {
    let live = true;
    let started: SceneHost | undefined;
    void loadScene(scene).then((module) => {
      if (!live || !layer.current) return;
      started = host.current = startScene(layer.current, module);
      if (turn.current.working) started.emit({ name: "busy" });
      playOwed(started, scene, layer.current, turn.current);
    });
    return () => {
      live = false;
      started?.stop();
      host.current = null;
    };
  }, [scene]);

  useEffect(() => host.current?.emit({ name: "skin" }), [skin]);

  useEffect(() => {
    sendRef.current = () => {
      const frame = layer.current?.parentElement?.querySelector("[data-orbit-composer-frame]");
      if (frame) host.current?.emit({ name: "send", at: frame });
    };
    return () => {
      sendRef.current = null;
    };
  }, [sendRef]);

  useEffect(() => {
    const was = turn.current;
    turn.current = { working, threadId, hidden };
    const h = host.current;
    if (!h || !layer.current) return;
    if (was.working !== working) {
      const bubbles = was.threadId === threadId ? layer.current.parentElement?.querySelectorAll(BUBBLES) : undefined;
      h.emit(working ? { name: "busy" } : { name: "reply", at: bubbles?.[bubbles.length - 1] });
      // A turn's own burst in a visible chat is the theme having played.
      if (!hidden && h.running()) scenePlayed(scene);
    }
    playOwed(h, scene, layer.current, turn.current);
  }, [working, threadId, hidden, skin, scene]);

  return <div ref={layer} data-chat-scene="" aria-hidden="true" />;
}
