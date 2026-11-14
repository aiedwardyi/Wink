// The animated backdrop of the scene themes. Each scene is its own lazy chunk,
// so other themes load and run none of it.
import { useEffect, useRef, type RefObject } from "react";
import type { SkinId } from "@/lib/skins";
import { startScene, type SceneHost, type SceneModule } from "@/scenes/scene-host";
import "@/scenes/scenes.css";

export type SceneId = "lagoon" | "snow";

const SCENE_SKINS: Partial<Record<SkinId, SceneId>> = { lagoon: "lagoon", "lagoon-night": "lagoon", snow: "snow", "snow-night": "snow" };
const LOAD: Record<SceneId, () => Promise<{ default: SceneModule }>> = {
  lagoon: () => import("@/scenes/lagoon"),
  snow: () => import("@/scenes/snow"),
};

export const sceneOf = (skin: SkinId): SceneId | undefined => SCENE_SKINS[skin];

type Props = { scene: SceneId; skin: SkinId; working: boolean; threadId: string; sendRef: RefObject<(() => void) | null> };

/** sendRef is filled with this chat's send trigger; the only one besides the turn ending. */
export function ChatScene({ scene, skin, working, threadId, sendRef }: Props) {
  const layer = useRef<HTMLDivElement>(null);
  const host = useRef<SceneHost | null>(null);
  const turn = useRef({ working, threadId });

  useEffect(() => {
    let live = true;
    let started: SceneHost | undefined;
    void LOAD[scene]().then(({ default: module }) => {
      if (!live || !layer.current) return;
      started = host.current = startScene(layer.current, module);
      if (turn.current.working) started.emit({ name: "busy" });
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
    turn.current = { working, threadId };
    const h = host.current;
    if (!h || was.working === working) return;
    if (working) return h.emit({ name: "busy" });
    const bubbles = was.threadId === threadId ? layer.current?.parentElement?.querySelectorAll('[data-orbit-message="bot"] [data-orbit-message-content]') : undefined;
    h.emit({ name: "reply", at: bubbles?.[bubbles.length - 1] });
  }, [working, threadId]);

  return <div ref={layer} data-chat-scene="" aria-hidden="true" />;
}
