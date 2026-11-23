import { dragOffset } from "@/lib/phone-swipe";
import { agoText } from "@/lib/ago";
import { useI18n } from "@/lib/i18n";
import { ProviderBrandMark } from "@/components/ProviderIcons";
import { useStore, type Bot } from "@/state/store";
import { Chevron, Dots, GlassAvatar, replies, useModel } from "./GlassChat";

function DeckCard({ bot, off }: { bot: Bot; off: number }) {
  const { t } = useI18n();
  const model = useModel(bot);
  const last = replies(bot, "", t).filter((reply) => !reply.live).pop();
  const status = bot.busy ? "Running" : bot.unread ? "New reply" : "Ready";
  return (
    <div className={off ? "glass-card side" : "glass-card on"} style={{ transform: "translateX(" + off * 410 + "px) scale(" + (off ? 0.88 : 1) + ")" }}>
      <div className="glass-card-top">
        <GlassAvatar bot={bot} size={52} className="glass-card-av" />
        <span className={bot.busy ? "glass-status running" : "glass-status"}>
          <span className="glass-sdot" />
          {status}
        </span>
      </div>
      <div className="glass-card-name">{bot.name}</div>
      <div className="glass-card-model">
        <ProviderBrandMark driverKind={model.kind} size={15} />
        <span>{model.full}</span>
        {last?.at && <span className="sep">·</span>}
        {last?.at && <span>{agoText(last.at, Date.now(), t)}</span>}
      </div>
      {last && <div className="glass-card-prev">{last.text}</div>}
    </div>
  );
}

/** The card deck shown while ArrowLeft/Right walk the chats; the chat under it is already selected. */
export function GlassDeck({ ids, at, bump }: { ids: string[]; at: string; bump: number }) {
  const { state } = useStore();
  const index = ids.indexOf(at);
  return (
    <div className="glass-deck">
      <div className="glass-deck-hdr">
        <span className="glass-deck-h">Chats</span>
        <span className="glass-deck-n">
          {index + 1} of {ids.length}
        </span>
      </div>
      <div className="glass-stage" style={bump ? { transform: "translateX(" + dragOffset(-bump * 24, false) + "px)" } : undefined}>
        {ids.map((id, i) => {
          const bot = Math.abs(i - index) <= 2 ? state.bots.find((candidate) => candidate.id === id) : undefined;
          return bot && <DeckCard key={id} bot={bot} off={i - index} />;
        })}
      </div>
      <div className="glass-deck-foot">
        <Chevron dir="left" />
        <Dots count={ids.length} at={index} />
        <Chevron dir="right" />
      </div>
    </div>
  );
}
