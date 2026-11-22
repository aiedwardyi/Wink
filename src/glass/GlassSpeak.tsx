import type { Bot } from "@/state/store";
import { CheckIcon, GlassAvatar, MicIcon, useChipText } from "./GlassChat";

/** Nothing reaches the bot until Send here; Back drops the draft. */
export function GlassSpeak({ bot, draft }: { bot: Bot; draft: string }) {
  const chip = useChipText(bot);
  return (
    <div className="glass-layer">
      <div className="glass-hdr">
        <GlassAvatar bot={bot} />
        <span className="glass-hcol">
          <span className="glass-nm">Send to {bot.name}</span>
          {chip && <span className="glass-chip quiet">{chip}</span>}
        </span>
      </div>
      <div className="glass-check">
        <div className="glass-draft">{draft}</div>
        <div className="glass-hint">
          Nothing is sent until you press Send.
          <br />
          Back throws the draft away.
        </div>
      </div>
      <button type="button" className="glass-btn send" data-glass="send" autoFocus>
        <CheckIcon />
        Send
      </button>
      <label className="glass-btn ghost">
        <MicIcon />
        Speak again
        <input data-glass="again" type="text" aria-label="Speak again" autoComplete="off" />
      </label>
    </div>
  );
}
