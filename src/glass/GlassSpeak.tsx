import { modelFamilyAccent } from "@/lib/model-chip";
import type { Bot } from "@/state/store";
import { Chevron, GlassAvatar, MicIcon, replies, useModel } from "./GlassChat";

/** Nothing reaches the bot until Send here; Back drops the draft. */
export function GlassSpeak({ bot, draft }: { bot: Bot; draft: string }) {
  const model = useModel(bot);
  const last = replies(bot, "").filter((reply) => !reply.live).pop();
  const line = last?.text.split("\n").map((part) => part.trim()).filter(Boolean).pop();
  return (
    <div className="glass-layer">
      <div className="glass-vtop">
        <div className="glass-back">
          <Chevron dir="left" />
          <GlassAvatar bot={bot} size={26} className="glass-ctx-av" />
          <strong>{bot.name}</strong>
        </div>
        <div className="glass-vpill">
          <span className="glass-wave">
            <span style={{ height: 6 }} />
            <span style={{ height: 13 }} />
            <span style={{ height: 9 }} />
            <span style={{ height: 12 }} />
          </span>
          Voice draft
        </div>
      </div>
      <div className="glass-vstage">
        {line && (
          <div className="glass-quote">
            <span className="glass-qbar" style={{ background: modelFamilyAccent(model.kind) }} />
            <span>
              {model.who}: "{line}"
            </span>
          </div>
        )}
        <div className="glass-draft">
          <div className="glass-dtext">
            {draft}
            <span className="glass-caret" />
          </div>
          <div className="glass-dfoot">
            <span className="glass-dsrc">
              <MicIcon />
              Meta dictation
            </span>
            <span className="glass-ready">Ready to send</span>
          </div>
        </div>
      </div>
      <div className="glass-actions">
        <label className="glass-btn redo">
          <MicIcon />
          Redo
          <input data-glass="again" type="text" aria-label="Redo" autoComplete="off" />
        </label>
        <button type="button" className="glass-btn send" data-glass="send" autoFocus>
          Send
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
          </svg>
        </button>
      </div>
    </div>
  );
}
