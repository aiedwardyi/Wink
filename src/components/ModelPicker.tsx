import { lazy, Suspense, useEffect, useId, useImperativeHandle, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { Atom, BookOpen, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Hexagon, Leaf, MoonStar, Mountain, Orbit, Sparkle, Sparkles, Sun, X } from "lucide-react";
import { shownModelSelection, useStore, type Bot, type ModelSelection } from "@/state/store";
import { filterCustomModels } from "@/lib/custom-models";
import { chipEffortLabel, chipEffortShortLabel, chipPhoneName,displayedChipEffort, engineBadgeText, modelChipText, modelChipTitle, modelEffortLabel, modelFamilyAccent } from "@/lib/model-chip";
import { movePicker, pickerColumn, pickerEfforts, pickerModels, pickerRows, selectPickerEffort, selectPickerModel, withPickerEffort } from "@/lib/cross-model-picker";
import { focusComposerOnActivation } from "@/lib/focus-composer";
import { formatCost, pickerPrice } from "@/lib/model-index";
import { dialRunCost, dialWheel } from "@/lib/model-dial";
import { usePresence } from "@/lib/use-presence";
import { useBackLayer } from "@/lib/use-back-layer";
import { noReplySource, switchFromNoReply } from "@/lib/no-reply-switch";
import type { AcceptedSend } from "@/lib/send-accept";
import { ProviderMark } from "./ProviderIcons";
import { EngineSetup, engineChecking, needsCli, needsSignIn } from "./EngineSetup";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { modelDialEnabled } from "@/lib/feature-flags";
import { loadModelPickerView, saveModelPickerView, type ModelPickerView } from "@/lib/model-picker-view";
import { showTouchPickerLegend } from "@/lib/friends-chrome";
import { pickerLookSkin, savePickerLook, shownPickerLook, usePickedLook } from "@/lib/picker-look";
import { useSkin } from "@/lib/skins";
import { ModelDial, useDialFontWarm, useModelDialFits, type ModelDialHandle } from "./ModelDial";
import { ModelChart } from "./ModelChart";
import { PickerStyleButton, PickerStyleStrip } from "./PickerStyleStrip";
import "./ModelPicker.css";
import { switchVia, trackScreen } from "@/lib/usage-stats";

const ModelMachine = lazy(() => import("./ModelMachine"));

const EFFORT_EDGE_CLEARANCE = 130 / 2 + 38; // Half the horizontal step plus chevron clearance.

type ModelPickerProps = {
  bot: Bot;
  className?: string;
  contained?: boolean;
  label?: ReactNode;
  defaultOpen?: boolean;
  switchControl?: Ref<(() => void) | null>;
  onSwitching?: (stage: "saving" | "rerunning" | null) => void;
  onRerunSettled?: () => void;
  dial?: boolean;
};

type PickerStore = {
  state: Pick<ReturnType<typeof useStore>["state"], "instances" | "selectedId"> & Partial<Pick<ReturnType<typeof useStore>["state"], "pendingQueued">>;
  dispatch: ReturnType<typeof useStore>["dispatch"];
  refreshInstances: () => Promise<void>;
};

export function ModelPicker(props: ModelPickerProps) {
  const store = useStore();
  return <ModelPickerControl {...props} store={store} accepted={store.state.acceptedSends[props.bot.threadId]} dial={modelDialEnabled(store.state.config)} />;
}

export function ModelPickerControl({
  bot, className, contained = false, label, defaultOpen = false, store, accepted, switchControl, onSwitching, onRerunSettled, dial = false,
}: ModelPickerProps & { store: PickerStore; accepted?: readonly AcceptedSend[] }) {
  const { t } = useI18n();
  const skin = useSkin();
  const picked = usePickedLook();
  const look = shownPickerLook(picked, skin);
  const { state, dispatch, refreshInstances } = store;
  const shortcutEnabled = !contained && state.selectedId === bot.id;
  const selection = shownModelSelection(bot);
  const active = state.instances.find((instance) => instance.instanceId === selection.instanceId);
  const [open, setOpen] = useState(defaultOpen);
  const presence = usePresence(open);
  const [draftSelection, setDraft] = useState(selection);
  const draft = withPickerEffort(state.instances.find((instance) => instance.instanceId === draftSelection.instanceId), draftSelection);
  const [customOpen, setCustomOpen] = useState(false);
  const [machine, setMachine] = useState(() => dial && loadModelPickerView() === "machine");
  const [styleOpen, setStyleOpen] = useState(false);
  const strip = usePresence(open && styleOpen);
  useBackLayer(open && customOpen, () => setCustomOpen(false));
  const [query, setQuery] = useState("");
  const dialFits = useModelDialFits(dial);
  const [view, setView] = useState(loadModelPickerView);
  // Machine is an overlay; the dial stays mounted under it.
  const base = view === "machine" ? "dial" : view;
  const dialView = dial && dialFits && base === "dial";
  const chartView = dial && dialFits && base === "chart";
  const styles: ModelPickerView[] = dial && dialFits ? ["dial", "list", "chart", "machine"] : ["list", "machine"];
  const shown: ModelPickerView = machine ? "machine" : dialView ? "dial" : chartView ? "chart" : "list";
  useDialFontWarm(dial, open);
  useEffect(() => {
    if (!presence.mounted) return;
    void window.ogb?.setModelPickerBackground?.(dialView || chartView ? "dial" : "list")?.catch(() => undefined);
    return () => { void window.ogb?.setModelPickerBackground?.(null)?.catch(() => undefined); };
  }, [presence.mounted, dialView, chartView]);
  const dialRef = useRef<ModelDialHandle>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const focusComposerAfterCloseRef = useRef(false);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const switchingRef = useRef(false);
  const saveTimerRef = useRef(0);
  const switchSourceRef = useRef<string | undefined>(undefined);
  const followUpRef = useRef(false);
  followUpRef.current = Boolean(state.pendingQueued?.[bot.threadId]?.length) || bot.messages.some((message) => message.queued) || Boolean(accepted?.some((send) => send.kind === "sends-next"));
  const stageRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef({ x: 0, y: 0, stepped: true });
  const wheelRef = useRef({ at: 0, dir: 0, sum: 0 });
  const [stageWidth, setStageWidth] = useState(0);
  const bindingsId = useId();
  const rows = pickerRows(state.instances, selection, draft);
  const row = rows.find((item) => item.instance.instanceId === draft.instanceId);
  const column = row ? pickerColumn(row, draft.model) : 0;
  const cell = row?.cells[column];
  const instance = row?.instance;
  const isCustom = instance?.models.options.some((option) => option.id === draft.model && option.custom);
  const blocked = Boolean(instance && (needsCli(instance) || (!isCustom && needsSignIn(instance))));
  const canCommit = (candidate: ModelSelection) => {
    if (candidate.instanceId === selection.instanceId && candidate.model === selection.model) return true;
    const target = rows.find((item) => item.instance.instanceId === candidate.instanceId)?.instance;
    if (!target) return false;
    const customOption = target.models.options.some((option) => option.id === candidate.model && option.custom);
    if (needsCli(target) || (!customOption && needsSignIn(target))) return false;
    return target.models.options.some((option) => option.id === candidate.model);
  };
  const canSave = canCommit(draft);
  const models = pickerModels(rows);
  const modelIndex = Math.max(0, models.findIndex((item) => item.instance === instance && item.cell === cell));
  const efforts = row && cell ? pickerEfforts(row, cell) : [];
  const effortIndex = efforts.findIndex((option) => option.model ? option.model === draft.model : option.effort === draft.effort);
  const split = Math.ceil(efforts.length / 2);
  const effortPosition = (index: number) => index < split ? index - split : index - split + 1;
  // Level labels live in lib/model-chip so the badge and tooltip localize together.
  const effortLabel = (label: string) => modelEffortLabel(label, t);
  const effortX = effortIndex >= 0 ? effortPosition(effortIndex) * 130 : 0;
  const offset = stageWidth ? Math.max(EFFORT_EDGE_CLEARANCE - stageWidth / 2 - effortX, Math.min(0, stageWidth / 2 - EFFORT_EDGE_CLEARANCE - effortX)) : 0;
  const planeStyle: CSSProperties & { "--picker-offset": string } = {
    "--picker-offset": `${offset}px`,
  };
  const families = new Map([["codex", "gpt"], ["grokAgent", "grok"], ["antigravityAgent", "gemini"], ["geminiAgent", "gemini"], ["claudeAgent", "claude"], ["museAgent", "metamuse"]]);
  const family = families.get((instance ?? active)?.driverKind ?? "") ?? "grok";
  const shortcut = /Mac/i.test(globalThis.navigator?.platform ?? "") ? "Option" : "Alt";
  const custom = instance?.models.options.filter((option) => option.custom) ?? [];
  const filteredCustom = filterCustomModels(custom, query);
  const price = pickerPrice(draft.model);
  const runCost = dialRunCost(draft.model, draft.effort);

  const show = (switching = false) => {
    const next = loadModelPickerView();
    trackScreen(dial && dialFits && next !== "list" ? (next === "chart" ? "model-chart" : "model-dial") : "model-picker");
    setDraft(selection);
    setCustomOpen(false);
    setMachine(dial && next === "machine");
    setStyleOpen(false);
    setView(next);
    setQuery("");
    focusComposerAfterCloseRef.current = false;
    switchingRef.current = switching;
    switchSourceRef.current = switching ? noReplySource(bot)?.id : undefined;
    setOpen(true);
  };
  useImperativeHandle(switchControl, () => () => show(true));
  const close = () => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = 0;
    setOpen(false);
  };
  useEffect(() => () => clearTimeout(saveTimerRef.current), []);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("orbit:model-picker", { detail: { id: bindingsId, open } }));
    if (open) window.addEventListener("orbit:close-model-picker", close);
    return () => {
      window.removeEventListener("orbit:close-model-picker", close);
      if (open) window.dispatchEvent(new CustomEvent("orbit:model-picker", { detail: { id: bindingsId, open: false } }));
    };
  }, [bindingsId, open]);
  const finishSave = () => {
    close();
    if (focusComposerAfterCloseRef.current) {
      focusComposerOnActivation({ activatedElement: triggerRef.current, onDeclined: () => previousFocusRef.current?.focus() });
    }
  };
  const save = (candidate: ModelSelection = draft, fromKeyboard = false, closeDelay = 0) => {
    if (saveTimerRef.current || !canCommit(candidate)) return false;
    focusComposerAfterCloseRef.current = !contained && (fromKeyboard || !switchingRef.current);
    if (switchingRef.current) switchFromNoReply(bot, candidate, switchSourceRef.current, state.instances, () => followUpRef.current, dispatch, onSwitching, onRerunSettled);
    else {
      if (dialView) switchVia("dial");
      dispatch({ type: "setModel", botId: bot.id, selection: candidate });
    }
    if (closeDelay) saveTimerRef.current = window.setTimeout(finishSave, closeDelay);
    else finishSave();
    return true;
  };
  const pick = (next: ModelSelection) => {
    setDraft(next);
    setCustomOpen(false);
  };
  const chooseStyle = (next: ModelPickerView) => {
    setView(next);
    saveModelPickerView(next, "picker");
    setMachine(next === "machine");
    // Leaving the Machine unmounts the focused overlay.
    requestAnimationFrame(() => { if (!dialogRef.current?.contains(document.activeElement)) dialogRef.current?.focus(); });
  };
  // The shown view takes focus back, so its keys and Enter work again.
  const refocus = () => (dialogRef.current?.querySelector<HTMLElement>(".model-machine") ?? dialogRef.current)?.focus();
  const closeStrip = () => {
    setStyleOpen(false);
    if (document.activeElement?.closest("[data-picker-style-strip]")) refocus();
  };
  const styleButton = dial ? <PickerStyleButton shown={shown} open={styleOpen} onToggle={() => styleOpen ? closeStrip() : setStyleOpen(true)} /> : null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.code !== "KeyM") return;
      // Only picker and trapping dialogs block Alt+M (prevents a second
      // picker over its own dialog, and keeps the Team Library's
      // capture-phase focus trap intact). Compatible dialogs such as
      // Settings must not swallow the shortcut — the picker renders above
      // them (z-100 over z-50).
      if (!shortcutEnabled || (!open && document.querySelector('[data-model-picker-content], [aria-labelledby="team-library-title"]'))) return;
      event.preventDefault();
      if (open) close();
      else show();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, shortcutEnabled, selection]);

  useEffect(() => {
    if (!open) return;
    void refreshInstances();
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : triggerRef.current;
    previousFocusRef.current = previous;
    dialogRef.current?.focus();
    return () => {
      if (!focusComposerAfterCloseRef.current) previous?.focus();
    };
  }, [contained, open, refreshInstances]);

  useEffect(() => {
    if (!open) return;
    const stage = stageRef.current!;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!event.deltaY) return;
      if ((dialView || chartView) && !dialWheel(wheelRef.current, event)) return;
      const direction = event.deltaY > 0 ? "ArrowDown" : "ArrowUp";
      setDraft((current) => movePicker(rows, withPickerEffort(state.instances.find((item) => item.instanceId === current.instanceId), current), direction));
      setCustomOpen(false);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [open, rows, state.instances, dialView, chartView]);

  // Touch equivalent of the wheel handler above: the stage isn't a scroll
  // container, so a plain touchmove does nothing. One gesture steps once,
  // on the dominant axis, when it first crosses the threshold.
  useEffect(() => {
    if (!open) return;
    const stage = stageRef.current!;
    const THRESHOLD = 40;
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      touchStartRef.current = { x: event.touches[0]!.clientX, y: event.touches[0]!.clientY, stepped: false };
    };
    const onTouchMove = (event: TouchEvent) => {
      // A ref, not a closure local: `rows` changes identity on every step
      // (setDraft below), which re-subscribes this effect mid-gesture.
      const start = touchStartRef.current;
      event.preventDefault();
      if (start.stepped) return;
      const dx = start.x - event.touches[0]!.clientX;
      const dy = start.y - event.touches[0]!.clientY;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < THRESHOLD) return;
      const direction = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "ArrowRight" : "ArrowLeft") : (dy > 0 ? "ArrowDown" : "ArrowUp");
      setDraft((current) => movePicker(rows, withPickerEffort(state.instances.find((item) => item.instanceId === current.instanceId), current), direction));
      setCustomOpen(false);
      start.stepped = true;
    };
    stage.addEventListener("touchstart", onTouchStart, { passive: true });
    stage.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      stage.removeEventListener("touchstart", onTouchStart);
      stage.removeEventListener("touchmove", onTouchMove);
    };
  }, [open, rows, state.instances]);

  useEffect(() => {
    if (!open) return;
    const stage = stageRef.current!;
    const resize = () => setStageWidth(stage.getBoundingClientRect().width);
    if (!dialView) resize();
    const observer = dialView ? null : new window.ResizeObserver(([entry]) => {
      if (entry) setStageWidth(entry.contentRect.width);
    });
    observer?.observe(stage);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      observer?.disconnect();
      document.body.style.overflow = overflow;
    };
  }, [open, dialView]);

  // Display-only: the accent dot is engine-driven, so effortless models
  // (wizard bots, muse) still show it; only the effort label stays gated
  // on displayedChipEffort. No state changes here.
  const chipEffort = displayedChipEffort(active, selection.model, selection.effort);
  const effortFull = chipEffort ? t("model.effortChip", { level: chipEffortLabel(chipEffort, t) }) : "";
  const effortShort = chipEffort ? chipEffortShortLabel(chipEffort, t) : "";
  const chipName = modelChipText({ instance: active, model: selection.model, effort: selection.effort }, t);
  const phoneName = chipPhoneName(active?.driverKind, chipName);
  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      onClick={() => show()}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-keyshortcuts={shortcutEnabled ? "Alt+M" : undefined}
      className="flex min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap rounded-[3px] [corner-shape:bevel] border border-hairline/40 bg-control/60 py-1 pl-2 pr-2.5 text-[13px] text-ink hover:bg-raised-hover"
      title={modelChipTitle({ mode: selection.mode, instance: active, model: selection.model, effort: selection.effort }, t) + (shortcutEnabled ? ` (${shortcut}+M)` : "")}
    >
      {active ? <ProviderMark driverKind={active.driverKind} size={14} className="shrink-0" /> : <Sparkles size={14} className="shrink-0 text-accent" />}
      {/* Only the label side may shrink: a long name truncates in place while
          the accent dot, effort, and chevron stay visible at any width. The
          label is always the full selected model — never the bare engine
          name — so the header matches Bot details at every width. */}
      <span data-model-label className="min-w-0 max-w-[160px] truncate">
        {phoneName === chipName ? chipName : (
          <>
            <span className="max-md:hidden">{chipName}</span>
            <span className="md:hidden">{phoneName}</span>
          </>
        )}
      </span>
      {active && (
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: modelFamilyAccent(active.driverKind) }} />
      )}
      {chipEffort && (
        <span data-model-effort className="shrink-0 whitespace-nowrap text-[12px] text-ink-secondary">{" "}{effortShort === effortFull ? effortFull : (
          <><span className="max-md:hidden">{effortFull}</span><span className="md:hidden">{effortShort}</span></>
        )}</span>
      )}
      <ChevronDown size={14} className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180", !contained && active && "@max-4xl/chathead:hidden")} />
    </button>
  );

  const setup = <>
    {blocked && instance && !engineChecking(instance) && <EngineSetup instance={instance} intent={isCustom ? "inject" : "cloud"} />}
    {custom.length > 0 && <button type="button" className="text-xs text-ink-secondary hover:text-ink" aria-expanded={customOpen} onClick={() => setCustomOpen(!customOpen)}>{t("model.useLocalCount", { count: custom.length })}</button>}
    {customOpen && instance && <div className="model-cross-custom">
      <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("model.searchLocal")} placeholder={t("model.searchLocal")} className="w-full rounded-lg bg-inset px-3 py-2 text-base sm:text-sm text-ink" />
      {filteredCustom.map((option) => <button key={option.id} type="button" data-custom-option={option.id} className="block w-full rounded-lg px-3 py-2 text-left text-sm text-ink hover:bg-control" onClick={() => { if (option.id === draft.model) save(); else pick(selectPickerModel(instance, option.id, draft)); }}>{option.label}</button>)}
      {filteredCustom.length === 0 && <p className="text-xs text-ink-secondary">{t("palette.noMatch", { query })}</p>}
    </div>}
  </>;

  const dialog = (
    <div className="model-cross-backdrop animate-fade-in" data-skin={pickerLookSkin(skin, look)} data-light={look !== "dark" || undefined} data-picker-family={family} data-contained={contained || undefined} data-closing={presence.closing || undefined} inert={presence.closing} onMouseDown={(event) => {
      if (styleOpen) {
        if (!(event.target instanceof Element && event.target.closest("[data-picker-style-strip], [data-picker-style-button]"))) closeStrip();
        return;
      }
      if (event.target === event.currentTarget || (event.target instanceof Element && event.target.matches(".model-cross-plane, .model-cross-stage"))) close();
    }}>
      <div
        ref={dialogRef}
        data-model-picker-content={!presence.closing || undefined}
        role={presence.closing ? undefined : "dialog"}
        aria-modal={!presence.closing || undefined}
        aria-label={t("model.choose")}
        aria-describedby={bindingsId}
        tabIndex={-1}
        className="model-cross-dialog"
        data-touch-picker-legend={!dial && !showTouchPickerLegend() ? "hidden" : undefined}
        onKeyDownCapture={(event) => {
          if (!styleOpen || event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          setStyleOpen(false);
          refocus();
        }}
        onKeyDown={(event) => {
          // focus lingers in the fading dialog for a frame; let Alt+M through to reopen it
          if (presence.closing) return;
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.repeat && event.code === "KeyM") {
            event.preventDefault();
            setMachine(!machine);
            if (machine) dialogRef.current?.focus();
            return;
          }
          if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === "KeyT") {
            event.preventDefault();
            if (event.repeat) return;
            if (styleOpen) closeStrip();
            else setStyleOpen(true);
            return;
          }
          if ((dialView || chartView) && dialRef.current?.key(event)) return;
          if (event.key === "Escape" || (event.altKey && !event.ctrlKey && !event.shiftKey && event.code === "KeyM")) {
            event.preventDefault();
            close();
          } else if (event.key === "Enter") {
            // Focus is only an affordance: Enter always commits, no matter
            // which selection cell holds focus. Action buttons and the
            // search field keep their native activation.
            const focused = event.target instanceof HTMLElement ? event.target : null;
            const customId = focused?.closest("[data-custom-option]")?.getAttribute("data-custom-option");
            if (customId && instance) {
              // Custom options sit outside the arrow-key grid, so Tab+Enter
              // is their only keyboard path: commit the focused option.
              event.preventDefault();
              save(selectPickerModel(instance, customId, draft), true);
              return;
            }
            if (event.target !== event.currentTarget && !(focused && focused.closest("[data-model-cell], [data-picker-effort]"))) return;
            event.preventDefault();
            save(draft, true);
          } else if (event.key === "Tab") {
            const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, [tabindex="0"]') ?? []);
            const first = buttons[0];
            const last = buttons[buttons.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) && !(event.target instanceof HTMLInputElement)) {
            event.preventDefault();
            pick(movePicker(rows, draft, event.key));
          }
        }}
      >
        <header className="model-cross-header">
          <h2 className="sr-only">{t("model.choose")}</h2>
          {styleButton}
          <button data-picker-action type="button" onClick={close} aria-label={t("createBot.cancel")}><X size={18} /></button>
        </header>
        {dialView ? <ModelDial rows={rows} draft={draft} canCommit={canCommit} onDraft={pick} onSave={save} handle={dialRef} stageRef={stageRef} bindingsId={bindingsId} />
          : chartView ? <ModelChart rows={rows} draft={draft} current={selection} canCommit={canCommit} onDraft={pick} onSave={save} handle={dialRef} stageRef={stageRef}>{setup}</ModelChart> : <>
        <div ref={stageRef} className="model-cross-stage" aria-label={t("engines.models")}>
          <div className="model-cross-plane" style={planeStyle}>
            <div className="model-cross-column" style={{ transform: `translateY(calc(${modelIndex} * -1 * var(--picker-y-step)))` }}>
              {models.map((item) => {
                const selected = item.instance === instance && item.cell === cell;
                const option = item.cell;
                const id = selected ? draft.model : option.options[0]!.id;
                const gpt = id.match(/^(gpt-[\d.]+)-(astra|sol|terra|luna)$/i);
                const ModelIcon = /astra/i.test(id) ? Atom : /sol/i.test(id) ? Sun : /terra/i.test(id) ? Mountain
                  : /luna/i.test(id) ? MoonStar : /fable/i.test(id) ? BookOpen : /haiku/i.test(id) ? Leaf
                  : /opus/i.test(id) ? Sun : /sonnet/i.test(id) ? Sparkles : Orbit;
                // Contributor variants read as a short card ("Meta Muse 1.3" +
                // Contrib badge) with the full catalog name kept in
                // aria-label/title for screen readers and tooltips. Off-list
                // pins stay verbatim (no rename, no badge) so the accessible
                // name keeps the exact pinned id and off-list note.
                const shortContrib = !gpt && !option.offList && option.options.length === 1 && /-contributor$/i.test(option.options[0]!.id);
                const fullName = shortContrib ? option.options[0]!.label : option.label;
                const shortName = shortContrib ? option.options[0]!.label.replace(/\s+contributor$/i, "") : option.label;
                return (
                  <button
                    key={`${item.instance.instanceId}:${option.options[0]!.id}`}
                    type="button"
                    data-model-row={item.instance.instanceId}
                    data-model-cell={option.options[0]!.id}
                    aria-pressed={selected}
                    aria-label={shortContrib ? fullName : undefined}
                    tabIndex={selected ? 0 : -1}
                    className="model-cross-cell"
                    title={shortContrib ? fullName : option.options.map((model) => model.id).join("\n")}
                    onClick={() => { if (selected) save(); else pick(selectPickerModel(item.instance, id, draft)); }}
                  >
                    <ModelIcon size={30} strokeWidth={1.1} aria-hidden />
                    <span className="model-cross-engine">{gpt ? gpt[1]!.replace("gpt-", "GPT ") : item.label}</span>
                    <span className="model-cross-name">{gpt ? gpt[2]![0]!.toUpperCase() + gpt[2]!.slice(1) : shortName}</span>
                    {shortContrib && <span className="model-cross-badge">Contrib</span>}
                    {option.offList && <span className="model-cross-note">{t("model.offList")}</span>}
                  </button>
                );
              })}
            </div>
            {cell && <div data-model-chrome className="model-cross-chrome model-cross-model-chrome" aria-hidden />}
            {efforts.length > 0 && <div data-effort-axis className="model-cross-efforts" aria-label={t("model.effort")}>
              {efforts.map((option, index) => {
                const EffortIcon = option.label === "low" ? Sparkle
                  : option.label === "medium" ? Orbit : option.label === "high" ? Sparkles : option.label === "xhigh" ? Sun : Hexagon;
                return <button
                  key={option.id}
                  type="button"
                  className="model-cross-cell model-cross-effort"
                  data-model-tier={option.model}
                  data-picker-effort={option.id}
                  aria-pressed={index === effortIndex}
                  style={{ transform: `translateX(calc(${effortPosition(index)} * var(--picker-x-step)))` }}
                  onClick={() => { if (index === effortIndex) save(); else pick(selectPickerEffort(draft, option)); }}
                >
                  <EffortIcon size={26} strokeWidth={1.1} aria-hidden />
                  <span className="model-cross-name">{effortLabel(option.label)}</span>
                </button>;
              })}
              {effortIndex >= 0 && <div data-effort-chrome className="model-cross-chrome model-cross-effort-chrome" aria-hidden style={{ transform: `translateX(calc(${effortPosition(effortIndex)} * var(--picker-x-step)))` }} />}
            </div>}
            <button data-picker-action type="button" className="model-cross-chevron model-cross-up" aria-label={t("model.previousModel")} onClick={() => pick(movePicker(rows, draft, "ArrowUp"))}><ChevronUp size={14} /></button>
            <button data-picker-action type="button" className="model-cross-chevron model-cross-down" aria-label={t("model.nextModel")} onClick={() => pick(movePicker(rows, draft, "ArrowDown"))}><ChevronDown size={14} /></button>
          </div>
          {efforts.length > 0 && <>
            <button data-picker-action type="button" className="model-cross-chevron model-cross-left" aria-label={t("model.previousEffort")} style={{ left: `max(24px, calc(50% - ${(split + 0.65) * 130}px))` }} onClick={() => pick(movePicker(rows, draft, "ArrowLeft"))}><ChevronLeft size={14} /></button>
            <button data-picker-action type="button" className="model-cross-chevron model-cross-right" aria-label={t("model.nextEffort")} style={{ left: `min(calc(100% - 24px), calc(50% + ${(efforts.length - split + 0.65) * 130}px))` }} onClick={() => pick(movePicker(rows, draft, "ArrowRight"))}><ChevronRight size={14} /></button>
          </>}
          <button data-picker-action type="button" className="model-cross-edge model-cross-top" style={{ left: `calc(50% + ${offset}px)` }} aria-label={t("model.previousModel")} onClick={() => pick(movePicker(rows, draft, "ArrowUp"))}><ChevronUp size={12} /></button>
          <button data-picker-action type="button" className="model-cross-edge model-cross-bottom" style={{ left: `calc(50% + ${offset}px)` }} aria-label={t("model.nextModel")} onClick={() => pick(movePicker(rows, draft, "ArrowDown"))}><ChevronDown size={12} /></button>
        </div>
        <div className="model-cross-options">
          <div aria-live="polite" className="flex min-w-0 flex-wrap items-center justify-center gap-2 text-xs text-ink-secondary">
            <span data-picker-current-model>{t("model.automatic")}</span>
            <span data-picker-current-model className="break-all text-ink">{t("model.automaticHelp", { name: draft.model || t("model.unresolved") })}</span>
            {effortIndex >= 0 && <span>{t("model.effort")}: {effortLabel(efforts[effortIndex]!.label)}</span>}
            {price && <span data-model-price className="shrink-0 whitespace-nowrap" title={t("model.priceUnits")}>{price} {t("model.pricePerMillion")}</span>}
            {runCost != null && <span data-model-run-cost className="shrink-0 whitespace-nowrap">{formatCost(runCost)}{t("model.dial.perTask")}</span>}
            {!instance && <span>{t("model.offList")}</span>}
            {instance && <span className={cn("rounded-full px-2 py-0.5", engineChecking(instance) ? "bg-control text-ink-secondary" : blocked ? "bg-warning/10 text-warning" : "bg-success/10 text-success")}>
              {engineBadgeText(instance.snapshot, engineChecking(instance) ? "checking" : needsCli(instance) ? "not-installed" : needsSignIn(instance) ? "sign-in" : "ready", t)}
            </span>}
          </div>
          {setup}
        </div>
        <footer className="model-cross-footer" id={bindingsId}>
          <span data-picker-key-legend className="model-cross-binding"><kbd>{shortcut}</kbd><kbd>M</kbd>{t("model.close")}</span>
          {dial && <span data-picker-key-legend className="model-cross-binding"><kbd>{shortcut}</kbd><kbd>T</kbd>{t("model.style")}</span>}
          <span data-picker-key-legend className="model-cross-binding"><kbd>↑</kbd><kbd>↓</kbd>{t("model.engineAxis")}</span>
          <span data-picker-key-legend className="model-cross-binding"><kbd>←</kbd><kbd>→</kbd>{t("model.modelAxis")}</span>
          <button type="button" disabled={!canSave} className="model-cross-binding" onClick={() => save()}><kbd>Enter</kbd>{t("settings.profile.save")}</button>
          <button data-picker-action type="button" className="model-cross-binding" onClick={close}><kbd>Esc</kbd>{t("createBot.cancel")}</button>
        </footer>
        </>}
        {machine && <Suspense fallback={null}>
          <ModelMachine rows={rows} draft={draft} current={selection} canCommit={canCommit} onDraft={pick} onSave={save} corner={styleButton} onClose={() => {
            // As the chosen style the Machine is the picker; as the Alt+Shift+M easter egg it peels off.
            if (view === "machine") close();
            else { setMachine(false); dialogRef.current?.focus(); }
          }}>{setup}</ModelMachine>
        </Suspense>}
        {strip.mounted && <PickerStyleStrip closing={strip.closing} shown={shown} styles={styles} picked={picked} skin={skin} onStyle={chooseStyle} onLook={savePickerLook} onDone={closeStrip} />}
      </div>
    </div>
  );

  return (
    <div className={cn(contained ? "w-full" : "relative", className)}>
      {contained ? (
        // Stacked like the neighboring card sections (Project folder,
        // Connected apps): label and description above, the model control
        // in a full-width row below. The side-by-side row squeezed the
        // label into a ~60px column next to the nowrap chip.
        <div className="flex flex-col gap-3">
          {label}
          <div className="flex">{trigger}</div>
        </div>
      ) : trigger}
      {presence.mounted && (globalThis.document ? createPortal(dialog, document.body) : dialog)}
    </div>
  );
}
