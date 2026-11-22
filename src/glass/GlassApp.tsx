import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { I18nProvider } from "@/lib/i18n";
import { dragOffset, neighborId, reducedMotion, swipeChatIds } from "@/lib/phone-swipe";
import { loadSidebarOrder } from "@/lib/sidebar-preferences";
import { StoreProvider, useStore } from "@/state/store";
import { glassKey, type GlassFocus } from "./glass-keys";
import { GlassChat, type GlassChatHandle } from "./GlassChat";
import { GlassSpeak } from "./GlassSpeak";
import "./glass.css";

function focusOf(): { focus: GlassFocus; field: HTMLInputElement | null } {
  const el = document.activeElement;
  const role = el instanceof HTMLElement ? el.dataset.glass : undefined;
  const focus: GlassFocus = role === "speak" || role === "header" || role === "send" || role === "again" ? role : "other";
  return { focus, field: el instanceof HTMLInputElement ? el : null };
}

function focusGlass(role: GlassFocus) {
  document.querySelector<HTMLElement>('.glass-layer:not([inert]) [data-glass="' + role + '"]')?.focus();
}

function Glasses() {
  const { state, dispatch } = useStore();
  const [draft, setDraft] = useState<string | null>(null);
  const [slide, setSlide] = useState<{ from: string; step: -1 | 1 } | null>(null);
  const [bump, setBump] = useState(0);
  const [hot, setHot] = useState<-1 | 1 | null>(null);
  const [pressed, setPressed] = useState(false);
  const [sent, setSent] = useState<{ botId: string; text: string } | null>(null);
  const chat = useRef<GlassChatHandle | null>(null);

  const bot = state.bots.find((candidate) => candidate.id === state.selectedId) ?? state.bots.find((candidate) => !candidate.hidden);
  const ids = swipeChatIds(state.bots, [], loadSidebarOrder(), bot?.id);
  const name = (from: string, step: -1 | 1) => {
    const id = neighborId(ids, from, step);
    return state.bots.find((candidate) => candidate.id === id)?.name;
  };

  useEffect(() => {
    if (bot && bot.id !== state.selectedId) dispatch({ type: "select", id: bot.id });
  }, [bot?.id, state.selectedId, dispatch]);

  useLayoutEffect(() => {
    if (draft === null) focusGlass("speak");
  }, [bot?.id, draft === null]);

  useEffect(() => {
    const onPop = () => setDraft(null);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const latest = useRef({ bot, ids, draft });
  latest.current = { bot, ids, draft };

  useEffect(() => {
    const toCheck = (field: HTMLInputElement | null) => {
      const text = field?.value.trim();
      if (!field || !text) return;
      field.value = "";
      if (latest.current.draft === null) window.history.pushState({ glass: "check" }, "");
      setDraft(text);
      requestAnimationFrame(() => focusGlass("send"));
    };
    const onChange = (event: Event) => {
      const role = (event.target as HTMLElement).dataset?.glass;
      if (role === "speak" || role === "again") toCheck(event.target as HTMLInputElement);
    };
    const onKey = (event: KeyboardEvent) => {
      const { bot, ids, draft } = latest.current;
      if (!bot) return;
      const { focus, field } = focusOf();
      const action = glassKey(draft === null ? "chat" : "check", focus, event.key, Boolean(field?.value.trim()));
      if (event.key.startsWith("Arrow")) event.preventDefault();
      if (!action) return;
      if (action.type !== "composer") event.preventDefault();
      switch (action.type) {
        case "chat": {
          setHot(action.step);
          const target = neighborId(ids, bot.id, action.step);
          if (!target) {
            setBump(action.step);
            break;
          }
          if (!reducedMotion()) setSlide({ from: bot.id, step: action.step });
          dispatch({ type: "select", id: target });
          break;
        }
        case "reply":
          if (chat.current?.move(action.dir) === "header") focusGlass("header");
          break;
        case "messages":
          focusGlass("speak");
          break;
        case "composer":
          if (focus === "speak") setPressed(true);
          break;
        case "check":
          toCheck(field);
          break;
        case "send":
          if (draft) {
            dispatch({ type: "send", botId: bot.id, text: draft, threadId: bot.threadId, sendId: crypto.randomUUID() });
            setSent({ botId: bot.id, text: draft });
          }
          window.history.back();
          break;
        case "again":
          focusGlass("again");
          break;
        case "toSend":
          focusGlass("send");
          break;
      }
    };
    const onKeyUp = () => {
      setHot(null);
      setPressed(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    document.addEventListener("change", onChange, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
      document.removeEventListener("change", onChange, true);
    };
  }, [dispatch]);

  useEffect(() => {
    if (!bump) return;
    const timer = setTimeout(() => setBump(0), 160);
    return () => clearTimeout(timer);
  }, [bump]);

  if (!bot) return <div className="glass" />;
  if (draft !== null) {
    return (
      <div className="glass">
        <GlassSpeak bot={bot} draft={draft} />
      </div>
    );
  }
  const from = slide && slide.from !== bot.id ? state.bots.find((candidate) => candidate.id === slide.from) : undefined;
  const leaving = from && slide ? (
    <div key={"out-" + from.id} className={slide.step > 0 ? "glass-slide out-next" : "glass-slide out-prev"} onAnimationEnd={() => setSlide(null)}>
      <GlassChat bot={from} left={name(from.id, -1)} right={name(from.id, 1)} active={false} hot={slide.step} />
    </div>
  ) : null;
  return (
    <div className="glass">
      {leaving}
      <div
        key={bot.id}
        className={from && slide ? (slide.step > 0 ? "glass-slide in-next" : "glass-slide in-prev") : "glass-slide"}
        style={bump ? { transform: "translateX(" + dragOffset(-bump * 24, false) + "px)" } : undefined}
      >
        <GlassChat
          bot={bot}
          left={name(bot.id, -1)}
          right={name(bot.id, 1)}
          hot={hot}
          pressed={pressed}
          sent={sent?.botId === bot.id ? sent.text : null}
          active
          handle={chat}
        />
      </div>
    </div>
  );
}

export function GlassApp() {
  return (
    <I18nProvider>
      <StoreProvider>
        <Glasses />
      </StoreProvider>
    </I18nProvider>
  );
}
