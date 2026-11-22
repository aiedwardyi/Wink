import { useEffect, useLayoutEffect, useRef, useState, type Ref } from "react";
import { BotAvatar } from "@/components/Avatar";
import { useI18n } from "@/lib/i18n";
import { chipPhoneName, displayedChipEffort, modelChipText, modelEffortLabel } from "@/lib/model-chip";
import { shownModelSelection, useStore, useStreamSelect, visibleMessages, type Bot } from "@/state/store";
import { linesAbove, replyMove, type ReplyMove } from "./glass-keys";

const LINE = 40;

export type GlassChatHandle = { move: (dir: -1 | 1) => ReplyMove["type"] };

type Reply = { id: string; you?: string; text: string; live?: boolean };

/** Bot replies oldest first, each with the message you sent before it; a turn still running is the last one. */
function replies(bot: Bot, stream: string): Reply[] {
  const list: Reply[] = [];
  let you: string | undefined;
  let answered = true;
  for (const message of visibleMessages(bot)) {
    if (message.kind !== "text" || !message.text) continue;
    if (message.role === "user") {
      you = message.text;
      answered = false;
    } else {
      list.push({ id: message.id, you, text: message.text });
      answered = true;
    }
  }
  if (stream || !answered) list.push({ id: "live", you, text: stream, live: true });
  return list;
}

export function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </svg>
  );
}

export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

export function useChipText(bot: Bot): string {
  const { t } = useI18n();
  const { state } = useStore();
  const shown = bot.modelSelection && shownModelSelection(bot);
  if (!shown) return "";
  const engine = state.instances.find((instance) => instance.instanceId === shown.instanceId);
  const name = chipPhoneName(engine?.driverKind, modelChipText({ instance: engine, model: shown.model, effort: shown.effort }, t));
  const effort = displayedChipEffort(engine, shown.model, shown.effort);
  return effort ? name + " · " + modelEffortLabel(effort, t) : name;
}

export function GlassAvatar({ bot }: { bot: Bot }) {
  return (
    <div className="glass-av">
      <BotAvatar bot={bot} size={56} />
    </div>
  );
}

export function GlassChat({
  bot,
  left,
  right,
  hot,
  pressed,
  sent,
  active,
  handle,
}: {
  bot: Bot;
  left?: string;
  right?: string;
  hot?: -1 | 1 | null;
  pressed?: boolean;
  sent?: string | null;
  active: boolean;
  handle?: Ref<GlassChatHandle>;
}) {
  const chip = useChipText(bot);
  const stream = useStreamSelect((s) => s.streaming[bot.threadId] ?? "");
  const list = replies(bot, stream);
  const [index, setIndex] = useState<number | null>(null);
  const [edge, setEdge] = useState<"top" | "bottom">("bottom");
  const [above, setAbove] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const shown = index === null ? list.length - 1 : Math.min(index, list.length - 1);
  const reply = list[shown];
  const newest = shown === list.length - 1;
  const follow = useRef(true);

  const measure = () => {
    const el = scroller.current;
    setAbove(el ? linesAbove(el.scrollTop, LINE) : 0);
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return setAbove(0);
    if (follow.current && newest) el.scrollTop = el.scrollHeight;
    measure();
  }, [reply?.text, shown, newest]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = edge === "top" ? 0 : el.scrollHeight;
    measure();
  }, [index, edge]);

  if (handle) {
    const api: GlassChatHandle = {
      move: (dir) => {
        const el = scroller.current;
        const max = el ? el.scrollHeight - el.clientHeight : 0;
        const top = el ? el.scrollTop : 0;
        const step = replyMove({ index: shown, count: list.length, atTop: top <= 0, atBottom: top >= max - 1 }, dir);
        if (step.type === "scroll" && el) {
          el.scrollTop = top + dir * Math.max(LINE, el.clientHeight - LINE);
          follow.current = newest && el.scrollTop >= max - 1;
          measure();
        } else if (step.type === "message") {
          follow.current = false;
          setEdge(step.edge);
          setIndex(step.index === list.length - 1 ? null : step.index);
        }
        return step.type;
      },
    };
    if (typeof handle === "function") handle(api);
    else (handle as { current: GlassChatHandle | null }).current = api;
  }

  useEffect(() => {
    if (index === null && edge === "top") follow.current = false;
  }, [index, edge]);

  const working = Boolean(bot.busy);
  return (
    <div className="glass-layer" inert={!active}>
      <button type="button" tabIndex={-1} className="glass-hdr" data-glass="header">
        <GlassAvatar bot={bot} />
        <span className="glass-hcol">
          <span className="glass-nm">{bot.name}</span>
          {chip && (
            <span className="glass-chip">
              {chip}
              <span className="glass-chev">▼</span>
            </span>
          )}
        </span>
        <span className={working ? "glass-st work" : "glass-st done"}>
          {working ? <span className="glass-dot" /> : <CheckIcon className="glass-chk" />}
          {working ? "working" : "done"}
        </span>
      </button>
      {reply?.you && (
        <div className="glass-you">
          <b>You</b> {sent && newest && working && <span className="glass-sent">sent </span>}› {reply.you}
        </div>
      )}
      {reply && (
        <div className="glass-panel">
          {above > 0 && <div className="glass-more">▲ {above} lines above</div>}
          <div ref={scroller} className="glass-scroll">
            <div className="glass-reply">
              {reply.text}
              {reply.live && working && <span className="glass-caret" />}
            </div>
          </div>
        </div>
      )}
      <div className="glass-bar">
        <div className={hot === -1 ? "glass-nb hot" : "glass-nb"}>{left && "‹ " + left}</div>
        <label className={pressed ? "glass-speak pressed" : "glass-speak"}>
          <MicIcon />
          Speak
          <input data-glass="speak" type="text" aria-label="Speak" autoComplete="off" />
        </label>
        <div className={hot === 1 ? "glass-nb r hot" : "glass-nb r"}>{right && right + " ›"}</div>
      </div>
    </div>
  );
}
