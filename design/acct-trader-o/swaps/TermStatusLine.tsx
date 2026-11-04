// Concept swap for src/components/TermStatusLine.tsx: the Terminal skin keeps its
// two-line status; the meters line becomes the braille ticker that opens the quick view.
import { shownModelSelection, useStore, type Bot, type InstanceInfo } from "@/state/store";
import { useI18n } from "@/lib/i18n";
import { shortPath } from "@/lib/short-path";
import { termModelLabel } from "@/lib/terminal-skin";
import { isPhone } from "@/lib/phone-swipe";
import { useSkin } from "@/lib/skins";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { ChatTicker, ENGINE_OF } from "../QuickView";
import "@/components/TermStatusLine.css";
import "../desk.css";

export function TermStatusLine({ bot, engine, cwd = bot.cwd }: { bot: Bot; engine: InstanceInfo | undefined; cwd?: string | null }) {
  const { t } = useI18n();
  const { state } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const skin = useSkin();
  const phone = isPhone();
  const selection = shownModelSelection(bot);
  const selectedEngine = engine?.instanceId === selection.instanceId ? engine : state.instances.find((instance) => instance.instanceId === selection.instanceId);
  const model = selectedEngine?.models.options.find((option) => option.id === selection.model)?.label ?? selection.model;
  const engineId = selectedEngine ? ENGINE_OF[selectedEngine.driverKind] : undefined;
  if (phone) return (
    <div data-term-status data-term-window={bot.name} data-term-phone={skin} role="group" aria-label={t("term.status.aria")} className="term-status">
      <div data-term-model><span aria-hidden="true" className="text-accent">◆</span> {termModelLabel(model)}</div>
      {engineId && <div data-term-meters={1}><ChatTicker engine={engineId} variant="term-phone" /></div>}
    </div>
  );
  return (
    <div data-term-status data-term-window={bot.name} role="group" aria-label={t("term.status.aria")} className="term-status">
      <div>
        <span aria-hidden="true" className="text-accent">◆</span> {model}
        {cwd && (
          <>
            <span aria-hidden="true" className="text-ink-secondary"> │ </span>
            {shortPath(cwd, capabilities.host.homeDir)}
          </>
        )}
        {selection.effort && <span className="text-ink-secondary"> · {selection.effort}</span>}
      </div>
      {engineId && <ChatTicker engine={engineId} variant="term" />}
    </div>
  );
}
