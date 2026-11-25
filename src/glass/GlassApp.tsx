import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { I18nProvider } from "@/lib/i18n";
import { neighborId, swipeChatIds } from "@/lib/phone-swipe";
import { loadSidebarOrder } from "@/lib/sidebar-preferences";
import { speaker } from "@/lib/tts";
import { StoreProvider, useStore } from "@/state/store";
import { choiceMove, glassKey, type GlassFocus } from "./glass-keys";
import { GlassChat, type GlassChatHandle } from "./GlassChat";
import { GlassDeck } from "./GlassDeck";
import { GlassModels, useGlassModels } from "./GlassModels";
import { GlassSpeak } from "./GlassSpeak";
import { readAloud, stopReading } from "./glass-voice";
import "./glass.css";

const DECK_MS = 1200;

function focusOf() {
  const el = document.activeElement;
  const role = el instanceof HTMLElement ? el.dataset.glass : undefined;
  const focus: GlassFocus =
    role === "speak" || role === "ask" || role === "choice" || role === "bar" || role === "older" || role === "listen" || role === "send" || role === "again" ? role : "other";
  return { focus, field: el instanceof HTMLInputElement ? el : null };
}

function focusGlass(role: GlassFocus) {
  const el = document.querySelector<HTMLElement>('.glass [data-glass="' + role + '"]');
  el?.focus();
  return Boolean(el);
}

const choices = () => [...document.querySelectorAll<HTMLElement>('.glass [data-glass="choice"]')];

function Glasses() {
  const { state, dispatch } = useStore();
  const [draft, setDraft] = useState<string | null>(null);
  const [picking, setPicking] = useState<number | null>(null);
  const [deck, setDeck] = useState(false);
  const [bump, setBump] = useState(0);
  const [pressed, setPressed] = useState(false);
  const [reading, setReading] = useState<string | null>(null);
  const chat = useRef<GlassChatHandle | null>(null);
  const deckTimer = useRef(0);

  const bot = state.bots.find((candidate) => candidate.id === state.selectedId) ?? state.bots.find((candidate) => !candidate.hidden);
  const ids = swipeChatIds(state.bots, [], loadSidebarOrder(), bot?.id);
  const models = useGlassModels(bot);

  useEffect(() => {
    if (bot && bot.id !== state.selectedId) dispatch({ type: "select", id: bot.id });
  }, [bot?.id, state.selectedId, dispatch]);

  useLayoutEffect(() => {
    if (draft === null && picking === null) focusGlass("speak");
  }, [bot?.id, draft === null, picking === null]);

  useEffect(() => {
    const onPop = () => {
      setDraft(null);
      setPicking(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    setReading(null);
    return stopReading;
  }, [bot?.id]);

  const latest = useRef({ bot, ids, draft, picking, models, deck, reading });
  latest.current = { bot, ids, draft, picking, models, deck, reading };

  useEffect(() => {
    const showDeck = () => {
      setDeck(true);
      clearTimeout(deckTimer.current);
      deckTimer.current = window.setTimeout(() => setDeck(false), DECK_MS);
    };
    const toCheck = (field: HTMLInputElement | null) => {
      const text = field?.value.trim();
      if (!field || !text) return;
      field.value = "";
      if (latest.current.draft === null) window.history.pushState({ glass: "check" }, "");
      setDraft(text);
      requestAnimationFrame(() => focusGlass("send"));
    };
    // the lens composer commits through input and change; text still being composed is not committed
    const onChange = (event: Event) => {
      const field = event.target;
      if (event instanceof InputEvent && event.isComposing) return;
      if (field instanceof HTMLInputElement && (field.dataset.glass === "speak" || field.dataset.glass === "again")) toCheck(field);
    };
    const onKey = (event: KeyboardEvent) => {
      const { bot, ids, draft, picking, models, deck, reading } = latest.current;
      if (!bot) return;
      if (deck && event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        clearTimeout(deckTimer.current);
        setDeck(false);
        if (event.key === "Enter") return event.preventDefault();
      }
      const { focus, field } = focusOf();
      const screen = draft !== null ? "check" : picking !== null ? "models" : "chat";
      const action = glassKey(screen, focus, event.key, Boolean(field?.value.trim()));
      if (event.key.startsWith("Arrow")) event.preventDefault();
      if (!action) return;
      if (action.type !== "composer") event.preventDefault();
      switch (action.type) {
        case "chat": {
          const target = neighborId(ids, bot.id, action.step);
          if (target) dispatch({ type: "select", id: target });
          else setBump(action.step);
          showDeck();
          break;
        }
        case "reply": {
          const step = chat.current?.move(action.dir);
          if (step === "ask") focusGlass("ask");
          else if (step === "bar" && !focusGlass("bar")) focusGlass("listen");
          break;
        }
        case "ask": {
          const step = chat.current?.ask(action.dir);
          if (step === "reply") focusGlass("speak");
          else if (step === "choices" && !focusGlass("choice") && !focusGlass("bar")) focusGlass("listen");
          break;
        }
        case "choice": {
          const list = choices();
          const step = choiceMove(list.findIndex((choice) => choice === document.activeElement), list.length, action.dir);
          if (step.type === "choice") list[step.index]?.focus();
          else if (step.type === "ask") focusGlass("ask");
          else if (!focusGlass("bar")) focusGlass("listen");
          break;
        }
        case "answer": {
          const choice = document.activeElement?.textContent;
          if (choice) chat.current?.answer(choice);
          focusGlass("speak");
          break;
        }
        case "messages":
          if (focus === "bar") {
            const last = choices().at(-1);
            last?.focus();
            if (last || focusGlass("ask")) break;
          }
          focusGlass("speak");
          chat.current?.back();
          break;
        case "older":
          chat.current?.older();
          break;
        case "toListen":
          focusGlass("listen");
          break;
        case "toBar":
          if (!focusGlass("bar")) focusGlass("speak");
          break;
        case "models":
          if (!models.length) break;
          window.history.pushState({ glass: "models" }, "");
          setPicking(Math.max(0, models.findIndex((model) => model.current)));
          break;
        case "model":
          setPicking((at) => Math.max(0, Math.min((at ?? 0) + action.dir, models.length - 1)));
          break;
        case "pick": {
          const model = picking === null ? undefined : models[picking];
          const shown = bot.modelSelection;
          if (model && !(model.current && model.selection.model === shown.model && model.selection.effort === shown.effort)) {
            dispatch({ type: "setModel", botId: bot.id, selection: model.selection });
          }
          latest.current.picking = null;
          setPicking(null);
          window.history.back();
          break;
        }
        case "listen": {
          if (reading) {
            stopReading();
            setReading(null);
            break;
          }
          const reply = chat.current?.reply();
          if (!reply?.text || reply.live) break;
          if (readAloud(reply.text, () => setReading(null))) setReading(reply.id);
          else void speaker.speak(reply.text, { botId: bot.id, messageId: reply.id, voiceId: bot.voice });
          break;
        }
        case "composer":
          if (focus === "speak") setPressed(true);
          break;
        case "check":
          toCheck(field);
          break;
        case "send":
          if (draft) {
            dispatch({
              type: "send",
              botId: bot.id,
              text: draft,
              threadId: bot.threadId,
              sendId: crypto.randomUUID(),
              onError: () => {
                if (latest.current.draft !== null) return;
                window.history.pushState({ glass: "check" }, "");
                latest.current.draft = draft;
                setDraft(draft);
                requestAnimationFrame(() => focusGlass("send"));
              },
            });
          }
          latest.current.draft = null;
          setDraft(null);
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
    const onKeyUp = () => setPressed(false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    document.addEventListener("change", onChange, true);
    document.addEventListener("input", onChange, true);
    document.addEventListener("compositionend", onChange, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
      document.removeEventListener("change", onChange, true);
      document.removeEventListener("input", onChange, true);
      document.removeEventListener("compositionend", onChange, true);
      clearTimeout(deckTimer.current);
    };
  }, [dispatch]);

  useEffect(() => {
    if (!bump) return;
    const timer = setTimeout(() => setBump(0), 160);
    return () => clearTimeout(timer);
  }, [bump]);

  if (!bot) return <div className="glass" />;
  return (
    <div className="glass">
      {draft !== null ? (
        <GlassSpeak bot={bot} draft={draft} />
      ) : picking !== null ? (
        <GlassModels bot={bot} models={models} at={picking} />
      ) : (
        <>
          <GlassChat key={bot.id} bot={bot} ids={ids} pressed={pressed} reading={reading !== null} handle={chat} />
          {deck && <GlassDeck ids={ids} at={bot.id} bump={bump} />}
        </>
      )}
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
