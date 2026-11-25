import { useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { BotAvatar } from "@/components/Avatar";
import { lineFacts, meterTarget, meterWindows } from "@/components/ChatPlanMeters";
import { ProviderBrandMark } from "@/components/ProviderIcons";
import { shortLabel } from "@/components/UsageDesk";
import { agoText } from "@/lib/ago";
import { chatErrorText } from "@/lib/error-text";
import { useI18n, type Translate } from "@/lib/i18n";
import { useOlderMessages } from "@/lib/message-pages";
import { pinnedQuestion } from "@/lib/open-question";
import { catalogModelLabel, chipPhoneName, modelChipText } from "@/lib/model-chip";
import { isShownMessage } from "@/lib/shown-message";
import { leftOf } from "@/lib/usage-pace";
import { useUsageBoard } from "@/lib/use-usage-board";
import { useVisibleClock } from "@/lib/use-visible-clock";
import { shownModelSelection, useStore, useStreamSelect, visibleMessages, type Bot } from "@/state/store";
import { linesAbove, OLDER_STEP, olderWindow, replyMove, type ReplyMove } from "./glass-keys";

const LINE = 32;
const ENGINES = new Map([
  ["claudeAgent", "Claude"],
  ["codex", "Codex"],
  ["grokAgent", "Grok"],
  ["antigravityAgent", "Gemini"],
  ["museAgent", "Muse"],
]);

export type Reply = { id: string; you?: string; text: string; at?: number; live?: boolean };
export type GlassChatHandle = {
  move: (dir: -1 | 1) => ReplyMove["type"];
  ask: (dir: -1 | 1) => "scroll" | "reply" | "choices";
  answer: (choice: string) => void;
  older: () => void;
  back: () => void;
  reply: () => Reply | undefined;
};

/** Bot replies oldest first, each with the message you sent before it; a turn still running is the last one, a failed one shows the phone's error line. */
export function replies(bot: Bot, stream: string, t: Translate): Reply[] {
  const list: Reply[] = [];
  let you: string | undefined;
  let answered = true;
  let failed: { id: string; text: string; at?: number } | undefined;
  for (const message of visibleMessages(bot)) {
    if (!isShownMessage(message)) continue;
    const error = message.kind === "activity" ? message.tool?.name : undefined;
    if (you !== undefined && error?.startsWith("error:")) {
      const shown = chatErrorText(error.slice(6).trim(), bot.name, t);
      failed = shown ? { id: message.id, text: shown.text, at: message.at } : undefined;
    }
    if (message.kind !== "text" || !message.text) continue;
    if (message.role === "user") {
      you = message.text;
      answered = false;
      failed = undefined;
    } else {
      list.push({ id: message.id, you, text: message.text, at: message.at });
      answered = true;
      failed = undefined;
    }
  }
  if (stream || (!answered && bot.busy)) list.push({ id: "live", you, text: stream, live: true });
  else if (failed) list.push({ ...failed, you });
  return list;
}

/** The bot's engine and the model it shows: chip name, full name and engine name. */
export function useModel(bot: Bot | undefined) {
  const { t } = useI18n();
  const { state } = useStore();
  const shown = bot?.modelSelection ? shownModelSelection(bot) : undefined;
  const engine = shown && state.instances.find((instance) => instance.instanceId === shown.instanceId);
  const kind = engine?.driverKind ?? "";
  return {
    shown,
    kind,
    chip: shown ? chipPhoneName(kind, modelChipText({ instance: engine, model: shown.model, effort: shown.effort }, t)) : "",
    full: shown ? catalogModelLabel(engine, shown.model).replace(/\s+\((xhigh|high|medium|low)\)$/i, "") : "",
    who: ENGINES.get(kind) ?? engine?.displayName ?? "",
  };
}

/** The tightest window of the bot's engine, read like the desktop chat's usage line: "5h · 62% left". */
function useUsageLeft(instanceId: string | undefined) {
  const { t } = useI18n();
  const { state } = useStore();
  const board = useUsageBoard();
  const now = useVisibleClock();
  if (!instanceId) return null;
  const target = meterTarget(board.board, state.instances, instanceId);
  const engine = state.instances.find((instance) => instance.instanceId === instanceId);
  const binding = lineFacts(meterWindows(target, engine?.rateLimits?.windows, now), target?.account.coverage ?? "unknown", t).binding;
  return binding ? shortLabel(binding, t) + " · " + t("usage.desk.windowLeft", { percent: Math.round(leftOf(binding)) }) : null;
}

export function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2.5" width="6" height="11.5" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
      <line x1="12" y1="18" x2="12" y2="21.5" />
    </svg>
  );
}

export function Chevron({ dir }: { dir: "up" | "down" | "left" | "right" }) {
  const points = dir === "up" ? "6 15 12 9 18 15" : dir === "down" ? "6 9 12 15 18 9" : dir === "left" ? "15 18 9 12 15 6" : "9 18 15 12 9 6";
  return (
    <svg className="glass-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}

export function GlassAvatar({ bot, size, className }: { bot: Bot; size: number; className: string }) {
  return (
    <div className={className}>
      <BotAvatar bot={bot} size={size} />
    </div>
  );
}

export function Dots({ count, at }: { count: number; at: number }) {
  const start = Math.max(0, Math.min(at - 4, count - 9));
  return (
    <div className="glass-dots">
      {Array.from({ length: Math.min(count, 9) }, (_, i) => (
        <span key={start + i} className={start + i === at ? "glass-dot on" : "glass-dot"} />
      ))}
    </div>
  );
}

export function GlassChat({ bot, ids, pressed, reading, handle }: { bot: Bot; ids: string[]; pressed: boolean; reading: boolean; handle: Ref<GlassChatHandle> }) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const model = useModel(bot);
  const usage = useUsageLeft(model.shown?.instanceId);
  const stream = useStreamSelect((s) => s.streaming[bot.threadId] ?? "");
  const list = replies(bot, stream, t);
  const [at, setAt] = useState<string | null>(null);
  const [limit, setLimit] = useState(OLDER_STEP);
  const [older, setOlder] = useState<"shown" | "loading" | null>(null);
  const [above, setAbove] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const asked = useRef<HTMLDivElement>(null);
  const olderButton = useRef<HTMLButtonElement>(null);
  const speak = useRef<HTMLInputElement>(null);
  const follow = useRef(true);
  const read = useRef(false);
  const oldest = useRef<string | undefined>(undefined);
  const loadOlder = useOlderMessages(dispatch, bot.threadId, bot.messages[0]?.id, bot.hasMore);
  const reach = olderWindow(list.length, limit, Boolean(bot.hasMore));
  const found = at === null ? -1 : list.findIndex((candidate) => candidate.id === at);
  const shown = found >= reach.first ? found : list.length - 1;
  const reply = list[shown];
  const live = Boolean(reply?.live);
  // the phone's pinned question, under the newest reply only
  const question = older === null && shown === list.length - 1 ? pinnedQuestion(bot.messages, visibleMessages(bot)) : null;
  const card = question?.card;

  const measure = () => setAbove(scroller.current ? linesAbove(scroller.current.scrollTop, LINE) : 0);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = 0;
    follow.current = true;
    read.current = false;
    measure();
  }, [reply?.id, older === null]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && live && follow.current) el.scrollTop = el.scrollHeight;
    measure();
  }, [reply?.text, live]);

  useLayoutEffect(() => {
    if (older === "shown") olderButton.current?.focus();
    if (older !== "loading") return;
    const index = list.findIndex((candidate) => candidate.id === oldest.current);
    if (index > 0 || !bot.hasMore) {
      if (index > 0) setAt(list[index - 1]!.id);
      setOlder(null);
      speak.current?.focus();
    } else loadOlder(undefined, () => setOlder("shown"));
  }, [older, list.length, bot.hasMore, loadOlder]);

  const api: GlassChatHandle = {
    reply: () => reply,
    move: (dir) => {
      const el = scroller.current;
      const max = el ? el.scrollHeight - el.clientHeight : 0;
      const top = el ? el.scrollTop : 0;
      const step = replyMove({ index: shown - reach.first, count: list.length - reach.first, atTop: top <= 0, atBottom: top >= max - 1, older: reach.older, ask: Boolean(card), askFirst: Boolean(card) && !read.current }, dir);
      if (step.type === "scroll" && el) {
        el.scrollTop = top + dir * Math.max(LINE, el.clientHeight - LINE);
        follow.current = el.scrollTop >= max - 1;
        measure();
      } else if (step.type === "message") {
        const index = reach.first + step.index;
        setAt(index === list.length - 1 ? null : list[index]!.id);
      } else if (step.type === "older") setOlder("shown");
      return step.type;
    },
    ask: (dir) => {
      const el = asked.current;
      const max = el ? el.scrollHeight - el.clientHeight : 0;
      const top = el ? el.scrollTop : 0;
      if (el && (dir < 0 ? top > 0 : top < max - 1)) {
        el.scrollTop = top + dir * Math.max(LINE, el.clientHeight - LINE);
        return "scroll";
      }
      if (dir > 0) return "choices";
      read.current = true;
      return "reply";
    },
    answer: (choice) => {
      if (question) dispatch({ type: "answerCard", botId: bot.id, messageId: question.id, answer: choice });
    },
    older: () => {
      oldest.current = list[reach.first]?.id;
      setLimit(limit + OLDER_STEP);
      setOlder("loading");
    },
    back: () => setOlder(null),
  };
  useImperativeHandle(handle, () => api);

  const paragraphs = reply ? reply.text.split(/\n\s*\n/).filter((part) => part.trim()) : [];
  return (
    <div className="glass-layer">
      <Dots count={ids.length} at={ids.indexOf(bot.id)} />
      <div className="glass-top">
        <div className="glass-id">
          <GlassAvatar bot={bot} size={38} className="glass-av" />
          <div className="glass-title">{bot.name}</div>
        </div>
      </div>
      <div className="glass-stream">
        {older !== null && (
          <button ref={olderButton} type="button" tabIndex={-1} className="glass-older" data-glass="older">
            <Chevron dir="up" />
            <span>{older === "loading" ? "Loading…" : "See " + OLDER_STEP + " more"}</span>
          </button>
        )}
        {older === null && !card && reply?.you && (
          <div className="glass-you">
            <div>{reply.you}</div>
          </div>
        )}
        {older === null && reply && (
          <div className="glass-bot">
            <div className="glass-meta">
              <span className="glass-who">
                <ProviderBrandMark driverKind={model.kind} size={16} />
                {model.who}
              </span>
              <span className="glass-time">{reply.live ? "Working…" : reply.at ? agoText(reply.at, Date.now(), t) : ""}</span>
            </div>
            {above > 0 && <div className="glass-more">▲ {above} lines above</div>}
            <div ref={scroller} className="glass-scroll">
              {paragraphs.map((part, i) => (
                <p key={i} className={i > 0 && i === paragraphs.length - 1 ? "follow" : undefined}>
                  {part}
                  {reply.live && i === paragraphs.length - 1 && <span className="glass-caret" />}
                </p>
              ))}
              {reply.live && !paragraphs.length && <span className="glass-caret" />}
            </div>
          </div>
        )}
        {question && card && (
          <div key={question.id} className="glass-ask">
            <div className="glass-ask-who">{t("ask.asks", { name: bot.name })}</div>
            <div ref={asked} className="glass-ask-q" data-glass="ask" tabIndex={-1}>
              {card.subtitle}
            </div>
            {card.options.length > 0 && (
              <div className="glass-choices">
                {card.options.map((choice) => (
                  <button key={choice} type="button" tabIndex={-1} className="glass-choice" data-glass="choice">
                    {choice}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {model.chip && (
        <button type="button" tabIndex={-1} className="glass-bar" data-glass="bar">
          <ProviderBrandMark driverKind={model.kind} size={17} />
          <span className="glass-bar-model">{model.chip}</span>
          <Chevron dir="down" />
          {usage && <span className="glass-bar-left">{usage}</span>}
        </button>
      )}
      <div className="glass-dock">
        <label className={pressed ? "glass-pill pressed" : "glass-pill"}>
          <MicIcon />
          <span>Speak a reply...</span>
          <input ref={speak} data-glass="speak" type="text" aria-label="Speak a reply" autoComplete="off" />
        </label>
        <button type="button" tabIndex={-1} className={reading ? "glass-listen on" : "glass-listen"} data-glass="listen" aria-label={reading ? "Stop reading" : "Read aloud"} aria-pressed={reading}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polygon points="11 5 6 9 2.5 9 2.5 15 6 15 11 19 11 5" />
            <path d="M15.5 8.8a4.5 4.5 0 0 1 0 6.4" />
            <path d="M18.6 5.8a8.8 8.8 0 0 1 0 12.4" />
          </svg>
        </button>
      </div>
    </div>
  );
}
