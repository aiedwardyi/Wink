// Choosing a skin is a visual decision, so the options are shown visually: each
// card carries a working miniature of the app rendered in that skin, not a row
// of paint chips. That works because the skin blocks in styles.css are keyed on
// `[data-skin]` rather than `:root[data-skin]` — any element can open a skin
// context for its own subtree, so the miniature styles itself and can never
// drift from what picking it actually does.
import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { LIGHT_SKIN_IDS, SKINS, SKIN_CHANGE_EVENT, applySkin, readSkin, readTriedSkins, type SkinId } from "@/lib/skins";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { reducedMotion } from "@/lib/phone-swipe";
import { startScene, type SceneHost } from "@/scenes/scene-host";
import { loadScene, sceneOf, type SceneId } from "./ChatScene";
import { Section } from "./SettingsPrimitives";
import { Fold } from "./Fold";

const FEATURED_SKIN_IDS: readonly SkinId[] = ["precision", "github-dimmed", "tokyo-night", "terminal", "inkwell", "graphite", "merlot", "bronze", "lagoon-night", "snow-night", "dim-sand", "lagoon", "snow", "wink-day", "notebook"];
const NEW_SKIN_IDS: ReadonlySet<SkinId> = new Set<SkinId>(["precision-dimmed", "bronze", "dim-sand", "lagoon", "lagoon-night", "snow", "snow-night"]);

/** An animated theme's own scene, looping in its tile while the picker is open; a still tile under reduced motion. */
function MiniScene({ scene }: { scene: SceneId }) {
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reducedMotion()) return;
    let live = true;
    let host: SceneHost | undefined;
    const start = () =>
      void loadScene(scene)
        .then((module) => {
          const tile = layer.current?.closest<HTMLElement>("[data-skin]");
          if (!live || !layer.current || !tile) return;
          // A loop is the longest runner, so every tile also rests on blur.
          host = startScene(layer.current, { ...module, pauseOnBlur: true }, document.documentElement, tile);
          host.emit({ name: "loop" });
          layer.current.dataset.live = "";
        })
        // A scene that cannot start (no canvas, a stale chunk) leaves the still tile.
        .catch(() => host?.stop());
    // After the first paint: a first shader compile must not hold up opening Themes.
    const frame = requestAnimationFrame(() => setTimeout(start, 0));
    return () => {
      live = false;
      cancelAnimationFrame(frame);
      host?.stop();
    };
  }, [scene]);
  return <div ref={layer} data-mini-scene={scene} />;
}

/**
 * The app's own layout at roughly 1/14 scale: rail, sidebar with a selected
 * row, thread, composer. The selected row and the send button are drawn in the
 * accent on purpose — a skin is mostly judged by where its colour lands, and a
 * single dot was too small to judge.
 */
function Miniature({ skin }: { skin: SkinId }) {
  const scene = sceneOf(skin);
  return (
    <div
      data-skin={skin}
      aria-hidden="true"
      className="flex h-[78px] w-full overflow-hidden rounded-lg bg-app ring-1 ring-hairline/60"
    >
      {/* rail */}
      <div className="flex w-[11px] shrink-0 flex-col items-center gap-[3px] bg-panel pt-[5px]">
        <span className="size-[5px] rounded-full bg-accent" />
        <span className="size-[5px] rounded-full bg-ink-secondary/40" />
        <span className="size-[5px] rounded-full bg-ink-secondary/40" />
      </div>
      {/* sidebar — the top row is the selected conversation */}
      <div className="flex w-[30px] shrink-0 flex-col gap-[3px] border-r border-hairline bg-panel p-[4px]">
        <span className="flex h-[9px] w-full items-center gap-[2px] rounded-sm bg-raised px-[2px]">
          <span className="size-[4px] shrink-0 rounded-full bg-accent" />
          <span className="h-[2px] flex-1 rounded-full bg-ink/50" />
        </span>
        <span className="h-[3px] w-[80%] rounded-full bg-ink-secondary/30" />
        <span className="h-[3px] w-[62%] rounded-full bg-ink-secondary/30" />
        <span className="h-[3px] w-[74%] rounded-full bg-ink-secondary/30" />
      </div>
      {/* thread */}
      <div data-mini-thread="" className="relative isolate flex min-w-0 flex-1 flex-col gap-[4px] p-[6px]">
        {scene && <MiniScene scene={scene} />}
        <span className="h-[13px] w-[62%] self-end rounded-md bg-bubble-user" />
        <div className="flex w-[88%] flex-col gap-[3px] rounded-md bg-card p-[4px]">
          <span className="h-[2px] w-full rounded-full bg-ink/45" />
          <span className="h-[2px] w-[85%] rounded-full bg-ink/45" />
          <span className="h-[2px] w-[60%] rounded-full bg-ink-secondary/40" />
        </div>
        <div className="mt-auto flex items-center gap-[4px]">
          <span className="h-[11px] flex-1 rounded-full bg-inset ring-1 ring-hairline" />
          {/* filled accent with its own ink — Foundry's inversion reads right
              here: bright brass carrying a dark mark, where the others carry
              a light one */}
          <span className="flex size-[11px] items-center justify-center rounded-full bg-accent">
            <span
              className="h-[1.5px] w-[5px] rounded-full"
              style={{ background: "var(--color-accent-ink)" }}
            />
          </span>
        </div>
      </div>
    </div>
  );
}

export function SkinPicker() {
  const { t } = useI18n();
  // The document is the source of truth, not storage: main.tsx has already
  // stamped it, and reading it back keeps the checkmark honest even if the
  // skin was set some other way.
  // SAFETY: main.tsx writes this attribute from applySkin() before the first
  // paint, and readSkin() covers the case where it is absent or unreadable.
  const [active, setActive] = useState<SkinId>(
    () => (document.documentElement.dataset.skin as SkinId) || readSkin(),
  );
  const [expanded, setExpanded] = useState(false);
  // A theme picked from the open fold stays put until the fold closes, so keyboard focus is not lost.
  const [picked, setPicked] = useState<SkinId | null>(null);
  const moreId = useId();
  const [tried, setTried] = useState(readTriedSkins);

  // The theme-cycle hotkey calls applySkin() directly, outside this
  // component's own onClick - without this, the checkmark would go stale.
  useEffect(() => {
    const onChange = () => {
      setActive((document.documentElement.dataset.skin as SkinId) || readSkin());
      setTried(readTriedSkins());
    };
    window.addEventListener(SKIN_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(SKIN_CHANGE_EVENT, onChange);
  }, []);

  const featured = FEATURED_SKIN_IDS.map((id) => SKINS.find((skin) => skin.id === id)!);
  if (!FEATURED_SKIN_IDS.includes(active) && active !== picked) {
    const current = SKINS.find((skin) => skin.id === active);
    if (current) featured.push(current);
  }
  const extra = SKINS.filter((skin) => !featured.includes(skin));
  const groups = (skins: typeof SKINS) => [
    { key: "settings.skin.dark", skins: skins.filter((skin) => !LIGHT_SKIN_IDS.has(skin.id)) },
    { key: "settings.skin.light", skins: skins.filter((skin) => LIGHT_SKIN_IDS.has(skin.id)) },
  ] as const;

  const renderGroups = (items: typeof SKINS, folded = false) => groups(items).filter(({ skins }) => skins.length > 0).map(({ key, skins }) => (
    <Section key={key} title={t(key)}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {skins.map((skin) => {
          const selected = skin.id === active;
          const isNew = !selected && NEW_SKIN_IDS.has(skin.id) && !tried.includes(skin.id);
          return (
            <button
              key={skin.id}
              type="button"
              onClick={() => {
                applySkin(skin.id);
                setActive(skin.id);
                setPicked(folded ? skin.id : null);
              }}
              aria-pressed={selected}
              className={cn(
                "flex flex-col gap-2 rounded-xl border p-2 text-left transition-colors",
                selected
                  ? "border-accent-border bg-control"
                  : "border-hairline/60 hover:border-hairline hover:bg-control/50",
              )}
            >
              <Miniature skin={skin.id} />
              <div className="flex items-start gap-1.5 px-0.5 pb-0.5">
                {/* A long name wraps inside its own box, so the New tag never drops under it or covers it. */}
                <div className="min-w-0 flex-1 break-words">
                  <div className="text-[13px] font-medium text-ink">{skin.nameKey ? t(skin.nameKey) : skin.name}</div>
                </div>
                {selected && <Check size={13} className="mt-0.5 shrink-0 text-accent-text" />}
                {isNew && (
                  <span data-skin-new className="shrink-0 rounded-full border border-accent/40 bg-accent/15 px-1.5 text-[10.5px] leading-[17px] font-semibold text-accent-text">
                    {t("settings.skin.new")}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </Section>
  ));

  return (
    <div className="flex flex-col gap-4">
      {renderGroups(featured)}
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={moreId}
        onClick={() => {
          setExpanded(!expanded);
          setPicked(null);
        }}
        className="flex min-h-11 items-center justify-between gap-2 rounded-lg border border-hairline/60 px-3 py-2 text-left text-[13px] font-medium text-ink hover:bg-control/50"
      >
        {t("settings.skin.more", { count: extra.length })}
        <ChevronDown size={16} className={cn("shrink-0 transition-transform", expanded && "rotate-180")} />
      </button>
      <Fold open={expanded} id={moreId} className="-mt-4">
        <div className="flex flex-col gap-4 pt-4">{renderGroups(extra, true)}</div>
      </Fold>
    </div>
  );
}
