import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { Check, Lock } from "lucide-react";
import type { ModelSelection } from "@/state/store";
import { defaultModelEffort } from "../../shared/model-effort.ts";
import { pickerColumn, pickerEfforts, pickerModels, selectPickerEffort, selectPickerModel, type PickerCell, type PickerEffort, type PickerRow } from "@/lib/cross-model-picker";
import { chipEffortLabel, chipEffortShortLabel, modelFamilyAccent } from "@/lib/model-chip";
import { dialPrice, dialScore, dialTier } from "@/lib/model-dial";
import { pickerPrice } from "@/lib/model-index";
import { pickerLookSkin, type PickerLook } from "@/lib/picker-look";
import { useBackLayer } from "@/lib/use-back-layer";
import { reducedMotion } from "@/lib/phone-swipe";
import type { SkinId } from "@/lib/skins";
import { useI18n, type Translate } from "@/lib/i18n";
import {
  QUICK_BAR_BREATHE_STAGGER_MS, QUICK_BAR_MS, QUICK_BAR_STAGGER_MS, QUICK_FLOURISH_EASE, QUICK_FLOURISH_MS, QUICK_FLOURISH_SHEEN_MS,
  QUICK_MAX_RING_A_MS, QUICK_MAX_RING_B_DELAY_MS, QUICK_MAX_RING_B_MS, QUICK_MAX_SPARK_MS,
  QUICK_MAX_SPARK_STAGGER_MS, QUICK_MAX_SWEEP_MS, QUICK_OPEN_MS, QUICK_OUT_EASE, QUICK_POP_MS,
  QUICK_SPRING, QUICK_THUMB_MS,
} from "@/lib/motion-character";
import { EngineSetup, engineChecking, needsCli, needsSignIn } from "./EngineSetup";
import { ProviderBrandMark } from "./ProviderIcons";
import { PickerStyleButton } from "./PickerStyleStrip";
import "./QuickModelPicker.css";

export type EffortFlowTier = "none" | "xhigh" | "max";

type Spot = { top: number; right: number; width: number; maxHeight: number };
type CssVars = CSSProperties & Record<`--${string}`, string | number | undefined>;
const cssVars = (style: CssVars): CSSProperties => style;

const LAB_SHORT_NAMES = new Map<string, string>([
  ["claudeAgent", "Claude"],
  ["codex", "Codex"],
  ["grokAgent", "Grok"],
  ["antigravityAgent", "Gemini"],
  ["geminiAgent", "Gemini"],
  ["museAgent", "Muse"],
]);
const APEX_SPARKS = [
  { dx: -52, dy: -36, bright: false },
  { dx: -32, dy: -52, bright: true },
  { dx: -10, dy: -56, bright: false },
  { dx: 14, dy: -50, bright: true },
  { dx: 34, dy: -36, bright: false },
  { dx: -64, dy: -14, bright: false },
  { dx: -44, dy: -22, bright: true },
  { dx: 24, dy: -16, bright: false },
  { dx: -18, dy: -34, bright: true },
  { dx: 6, dy: -32, bright: false },
] as const;

const labShortName = (row: PickerRow) => LAB_SHORT_NAMES.get(row.instance.driverKind) ?? row.label;

/** Extra High flows quietly and Max fully; Extra High as the top step (Grok, Gemini) flows like Max. */
export function effortFlowTier(label: string | undefined, effortIndex: number, totalEfforts: number): EffortFlowTier {
  if (!label) return "none";
  if (label === "max" || label === "ultra") return "max";
  if (label === "xhigh") return totalEfforts > 1 && effortIndex === totalEfforts - 1 ? "max" : "xhigh";
  return "none";
}

export function selectionFlowTier(rows: readonly PickerRow[], selection: ModelSelection): EffortFlowTier {
  const row = rows.find((item) => item.instance.instanceId === selection.instanceId);
  const cell = row?.cells[pickerColumn(row, selection.model)];
  if (!row || !cell) return selection.effort === "max" || selection.effort === "ultra" ? "max" : "none";
  const list = pickerEfforts(row, cell);
  const idx = list.findIndex((opt) => (opt.model ? opt.model === selection.model : opt.effort === selection.effort));
  const active = idx >= 0 ? list[idx] : undefined;
  return effortFlowTier(active?.label, idx, list.length);
}

function cellDisplayName(cell: PickerCell) {
  const first = cell.options[0]!;
  const contrib = !cell.offList && cell.options.length === 1 && /-contributor$/i.test(first.id);
  return {
    name: contrib ? first.label.replace(/\s+contributor$/i, "") : cell.label,
    contrib,
    full: contrib ? first.label : cell.label,
  };
}

function effortNote(label: string | undefined, isTopNonMax: boolean, t: Translate): string {
  if (!label) return "";
  if (label === "max" || label === "ultra") return t("model.quick.maxDepth");
  if (isTopNonMax) return t("model.quick.topLevel");
  if (label === "none" || label === "minimal" || label === "low") return t("model.quick.effortQuick");
  if (label === "medium") return t("model.quick.effortBalanced");
  if (label === "high") return t("model.quick.effortDeep");
  if (label === "xhigh") return t("model.quick.effortExtended");
  return "";
}

function barCountFor(levelCount: number): number {
  if (levelCount <= 0) return 0;
  return levelCount <= 6 ? levelCount : 5;
}

function filledBarCount(effortIndex: number, total: number, barCount: number): number {
  if (total <= 0 || effortIndex < 0 || barCount <= 0) return 0;
  if (total === barCount) return effortIndex + 1;
  if (effortIndex === total - 1 || total === 1) return barCount;
  return Math.max(1, Math.min(barCount, Math.round(((effortIndex + 1) / total) * barCount)));
}

function barHeights(count: number, minH: number, maxH: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [maxH];
  return Array.from({ length: count }, (_, idx) => Math.round(minH + (idx / (count - 1)) * (maxH - minH)));
}

function segmentOpacity(idx: number, litCount: number, isMaxFlow: boolean): number {
  if (isMaxFlow || idx >= litCount - 1) return 1;
  return Number((0.58 + 0.32 * ((idx + 1) / Math.max(litCount, 1))).toFixed(2));
}

function placeQuickPopover(anchor: HTMLElement | null): Spot {
  const winW = globalThis.window?.innerWidth ?? 1440;
  const winH = globalThis.window?.innerHeight ?? 900;
  const margin = winW <= 420 ? 8 : 12;
  const width = Math.min(416, Math.max(280, winW - margin * 2));
  const rect = anchor?.getBoundingClientRect();
  const hasRect = Boolean(rect && (rect.width > 0 || rect.height > 0));
  const top = hasRect && rect ? Math.max(8, Math.round(rect.bottom + 8)) : 56;
  const desiredRight = hasRect && rect ? Math.round(winW - rect.right) : margin;
  const maxRight = Math.max(margin, winW - width - margin);
  const right = Math.max(margin, Math.min(desiredRight, maxRight));
  const maxHeight = Math.max(260, Math.min(480, Math.floor(winH - top - 16)));
  return { top, right, width: Math.round(width), maxHeight };
}

function encodedEffortTier(modelId: string): "low" | "medium" | "high" | "xhigh" | undefined {
  const tier = modelId.match(/-(low|medium|high|xhigh)$/)?.[1];
  if (tier === "low" || tier === "medium" || tier === "high" || tier === "xhigh") return tier;
  return undefined;
}

/** Antigravity's Gemini models encode effort in the model id, so its tier is carried by hand across labs. */
function nextSelectionForCell(row: PickerRow, cell: PickerCell, current: ModelSelection, currentRow?: PickerRow): ModelSelection {
  if (row.instance.driverKind === "antigravityAgent") {
    const currentTier = current.effort ?? encodedEffortTier(current.model);
    const matched = currentTier
      ? (cell.options.find((opt) => opt.id.endsWith(`-${currentTier}`))
        ?? (currentTier === "max"
          ? cell.options.find((opt) => opt.id.endsWith("-xhigh")) ?? cell.options.find((opt) => opt.id.endsWith("-high"))
          : undefined))
      : undefined;
    return selectPickerModel(row.instance, (matched ?? cell.options[0]!).id, current);
  }
  const encodedTier = currentRow?.instance.driverKind === "antigravityAgent" ? encodedEffortTier(current.model) : undefined;
  const carried = !current.effort && encodedTier ? { ...current, effort: encodedTier } : current;
  return selectPickerModel(row.instance, cell.options[0]!.id, carried);
}

function rowIntelScore(row: PickerRow, modelId: string, preferredEffort?: string): number | undefined {
  const levels = row.instance.capabilities?.effortLevels;
  const fallback = defaultModelEffort(row.instance.driverKind, modelId, levels) ?? "high";
  return dialScore(modelId, preferredEffort, "intelligence")
    ?? dialScore(modelId, fallback, "intelligence")
    ?? dialScore(modelId, "high", "intelligence");
}

/** Unmounts when it ends, so the closed button runs no animation at rest. */
export function QuickMaxFlourish({ onDone }: { onDone: () => void }) {
  const rimRef = useRef<HTMLSpanElement>(null);
  const spinRef = useRef<HTMLSpanElement>(null);
  const sheenRef = useRef<HTMLSpanElement>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useLayoutEffect(() => {
    if (reducedMotion()) {
      doneRef.current();
      return;
    }
    const rim = rimRef.current;
    const spin = spinRef.current;
    const sheen = sheenRef.current;
    if (!rim?.animate || !spin?.animate || !sheen?.animate) return;
    let alive = true;
    const anims = [
      rim.animate(
        [{ opacity: 0 }, { opacity: 1, offset: 0.16 }, { opacity: 0.92, offset: 0.72 }, { opacity: 0 }],
        { duration: QUICK_FLOURISH_MS, easing: QUICK_FLOURISH_EASE, fill: "forwards" },
      ),
      spin.animate(
        [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
        { duration: QUICK_FLOURISH_MS, easing: QUICK_FLOURISH_EASE, fill: "forwards" },
      ),
      sheen.animate(
        [
          { transform: "translateX(-130%) skewX(-18deg)", opacity: 0 },
          { opacity: 0.65, offset: 0.4 },
          { transform: "translateX(240%) skewX(-18deg)", opacity: 0 },
        ],
        { duration: QUICK_FLOURISH_SHEEN_MS, easing: QUICK_FLOURISH_EASE, fill: "forwards" },
      ),
    ];
    void Promise.all(anims.map((anim) => anim.finished.catch(() => undefined))).then(() => {
      if (alive) doneRef.current();
    });
    return () => {
      alive = false;
      for (const anim of anims) anim.cancel();
    };
  }, []);

  return (
    <span aria-hidden="true" data-quick-flourish="" className="quick-hdr-flourish">
      <span ref={rimRef} className="quick-hdr-flourish-rim">
        <span ref={spinRef} className="quick-hdr-flourish-spin" />
      </span>
      <span ref={sheenRef} className="quick-hdr-flourish-sheen" />
    </span>
  );
}

export function QuickModelPicker({
  id, cardRef, skin, look, closing, rows, triggerRef, styleButtonRef, styleOpen,
  onToggleStyle, onCloseStyle, onClose, onCommit, refreshInstances, selection,
}: {
  id: string;
  cardRef: RefObject<HTMLDivElement | null>;
  skin: SkinId;
  look: PickerLook;
  closing: boolean;
  rows: PickerRow[];
  triggerRef: RefObject<HTMLButtonElement | null>;
  styleButtonRef: RefObject<HTMLSpanElement | null>;
  styleOpen: boolean;
  onToggleStyle: () => void;
  onCloseStyle: () => void;
  onClose: (returnFocus?: "trigger" | "composer" | "none") => void;
  onCommit: (next: ModelSelection) => void;
  refreshInstances: () => Promise<void>;
  selection: ModelSelection;
}) {
  const { t } = useI18n();
  const thumbBodyRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const sweepRef = useRef<HTMLDivElement>(null);
  const shockARef = useRef<HTMLDivElement>(null);
  const shockBRef = useRef<HTMLDivElement>(null);
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const sparksRef = useRef<Array<HTMLSpanElement | null>>([]);
  const activeAnimsRef = useRef<Animation[]>([]);
  const [spot, setSpot] = useState<Spot>(() => placeQuickPopover(triggerRef.current));

  const light = look !== "dark";
  const borrowedSkin = pickerLookSkin(skin, look);
  const selectedRowIndex = Math.max(0, rows.findIndex((row) => row.instance.instanceId === selection.instanceId));
  const selectedRow = rows[selectedRowIndex];
  const selectedCell = selectedRow?.cells[pickerColumn(selectedRow, selection.model)];

  const [viewedLabId, setViewedLabId] = useState(selection.instanceId);
  const viewedRowIndex = Math.max(0, rows.findIndex((row) => row.instance.instanceId === viewedLabId));
  const viewedRow = rows[viewedRowIndex] ?? selectedRow;
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const prevSelectedInstance = useRef(selection.instanceId);
  useEffect(() => {
    if (prevSelectedInstance.current !== selection.instanceId) {
      prevSelectedInstance.current = selection.instanceId;
      setViewedLabId(selection.instanceId);
      setHoverIdx(null);
    }
  }, [selection.instanceId]);

  const efforts = useMemo(() => (selectedRow && selectedCell ? pickerEfforts(selectedRow, selectedCell) : []), [selectedRow, selectedCell]);
  const effortIndex = efforts.findIndex((option) => (option.model ? option.model === selection.model : option.effort === selection.effort));
  const activeEffort = effortIndex >= 0 ? efforts[effortIndex] : undefined;
  const flowTier = effortFlowTier(activeEffort?.label, effortIndex, efforts.length);
  const isMax = activeEffort?.label === "max" || activeEffort?.label === "ultra";
  const isTopNonMax = flowTier === "max" && !isMax;
  const isApex = flowTier === "max";
  const activeAccent = modelFamilyAccent(selectedRow?.instance.driverKind);
  const viewedAccent = modelFamilyAccent(viewedRow?.instance.driverKind);

  const locked = (row: PickerRow) => !engineChecking(row.instance) && (needsCli(row.instance) || needsSignIn(row.instance));

  const previewCell = hoverIdx !== null && viewedRow?.cells[hoverIdx] ? viewedRow.cells[hoverIdx] : selectedCell;
  const previewRow = hoverIdx !== null && viewedRow?.cells[hoverIdx] ? viewedRow : selectedRow;
  const previewModelId = previewCell
    ? (previewRow === selectedRow && previewCell === selectedCell ? selection.model : previewCell.options[0]!.id)
    : selection.model;
  const preferredEffort = activeEffort?.effort ?? activeEffort?.label;
  const previewIntel = previewRow ? rowIntelScore(previewRow, previewModelId, preferredEffort) : undefined;
  const previewPrice = pickerPrice(previewModelId);
  const previewPriceCompact = previewPrice ? previewPrice.replace(/\s*\/\s*/g, "/") : undefined;

  const cancelBursts = useCallback(() => {
    for (const anim of activeAnimsRef.current) {
      anim.finished?.catch(() => {});
      anim.cancel();
    }
    activeAnimsRef.current = [];
  }, []);
  useEffect(() => () => cancelBursts(), [cancelBursts]);

  useLayoutEffect(() => {
    setSpot(placeQuickPopover(triggerRef.current));
    const el = cardRef.current;
    if (!el || reducedMotion()) return;
    const anim = el.animate?.(
      [{ opacity: 0, transform: "translateY(-8px) scale(0.965)" }, { opacity: 1, transform: "translateY(0) scale(1)" }],
      { duration: QUICK_OPEN_MS, easing: QUICK_SPRING },
    );
    anim?.finished?.catch(() => {});
    return () => anim?.cancel();
  }, [cardRef, triggerRef]);

  useEffect(() => {
    if (closing) return;
    cardRef.current?.focus({ preventScroll: true });
    // After the entrance, so its first frames are not shared with the refresh.
    const timer = window.setTimeout(() => void refreshInstances(), QUICK_OPEN_MS);
    const update = () => setSpot(placeQuickPopover(triggerRef.current));
    window.addEventListener("resize", update);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", update);
    };
  }, [cardRef, closing, refreshInstances, triggerRef]);

  useBackLayer(!closing && styleOpen, onCloseStyle);
  useBackLayer(!closing && !styleOpen, () => onClose("trigger"));

  useEffect(() => {
    if (closing) return;
    const onOutside = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest("[data-picker-style-strip], [data-picker-style-button]")) return;
      if (styleOpen) {
        onCloseStyle();
        return;
      }
      if (cardRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onClose("none");
    };
    document.addEventListener("pointerdown", onOutside, true);
    return () => document.removeEventListener("pointerdown", onOutside, true);
  }, [cardRef, closing, onClose, onCloseStyle, styleOpen, triggerRef]);

  const triggerEffortMotion = useCallback((kind: "step" | "xhigh" | "max") => {
    if (reducedMotion()) return;
    cancelBursts();
    const anims: Animation[] = [];
    const push = (anim: Animation | undefined) => {
      if (!anim) return;
      anim.finished?.catch(() => {});
      anims.push(anim);
    };

    push(thumbBodyRef.current?.animate?.(
      kind === "max"
        ? [{ transform: "scale(1)" }, { transform: "scale(1.07, 0.93)", offset: 0.35 }, { transform: "scale(0.985, 1.03)", offset: 0.72 }, { transform: "scale(1)" }]
        : [{ transform: "scale(1)" }, { transform: "scale(1.045, 0.96)", offset: 0.4 }, { transform: "scale(1)" }],
      { duration: QUICK_THUMB_MS, easing: QUICK_SPRING },
    ));
    push(readoutRef.current?.animate?.(
      kind === "max"
        ? [{ transform: "scale(0.9)", opacity: 0.5 }, { transform: "scale(1.16)", opacity: 1, offset: 0.45 }, { transform: "scale(1)", opacity: 1 }]
        : [{ transform: "scale(0.94)" }, { transform: "scale(1.08)", offset: 0.45 }, { transform: "scale(1)" }],
      { duration: QUICK_POP_MS, easing: QUICK_SPRING },
    ));
    barsRef.current.forEach((slot, idx) => {
      if (!slot || !slot.hasAttribute("data-lit")) return;
      push(slot.animate?.(
        [{ transform: "scaleY(1)" }, { transform: kind === "max" ? "scaleY(1.26)" : "scaleY(1.16)", offset: 0.45 }, { transform: "scaleY(1)" }],
        { duration: QUICK_BAR_MS, delay: idx * QUICK_BAR_STAGGER_MS, easing: QUICK_SPRING },
      ));
    });

    if (kind === "xhigh") {
      push(sweepRef.current?.animate?.(
        [{ transform: "translateX(-120%) skewX(-18deg)", opacity: 0 }, { opacity: 0.46, offset: 0.4 }, { transform: "translateX(245%) skewX(-18deg)", opacity: 0 }],
        { duration: QUICK_MAX_SWEEP_MS, easing: QUICK_OUT_EASE },
      ));
    } else if (kind === "max") {
      push(shockARef.current?.animate?.([{ transform: "scale(0.16)", opacity: 0 }, { opacity: 0.92, offset: 0.14 }, { transform: "scale(2.4)", opacity: 0 }], { duration: QUICK_MAX_RING_A_MS, easing: QUICK_OUT_EASE }));
      push(shockBRef.current?.animate?.([{ transform: "scale(0.18)", opacity: 0 }, { opacity: 0.7, offset: 0.18 }, { transform: "scale(2.75)", opacity: 0 }], { duration: QUICK_MAX_RING_B_MS, delay: QUICK_MAX_RING_B_DELAY_MS, easing: QUICK_OUT_EASE }));
      push(sweepRef.current?.animate?.([{ transform: "translateX(-120%) skewX(-18deg)", opacity: 0 }, { opacity: 0.92, offset: 0.38 }, { transform: "translateX(255%) skewX(-18deg)", opacity: 0 }], { duration: QUICK_MAX_SWEEP_MS, easing: QUICK_OUT_EASE }));
      sparksRef.current.forEach((dot, idx) => {
        const spec = APEX_SPARKS[idx];
        if (!dot || !spec) return;
        push(dot.animate?.(
          [
            { transform: "translate(0, 0) scale(0.3)", opacity: 0 },
            { transform: `translate(${Math.round(spec.dx * 0.68)}px, ${Math.round(spec.dy * 0.68)}px) scale(1.2)`, opacity: 1, offset: 0.35 },
            { transform: `translate(${spec.dx}px, ${spec.dy}px) scale(0)`, opacity: 0 },
          ],
          { duration: QUICK_MAX_SPARK_MS, delay: idx * QUICK_MAX_SPARK_STAGGER_MS, easing: QUICK_OUT_EASE },
        ));
      });
    }
    activeAnimsRef.current = anims;
  }, [cancelBursts]);

  const pickModel = (row: PickerRow, cell: PickerCell) => onCommit(nextSelectionForCell(row, cell, selection, selectedRow));

  const pickEffort = (option: PickerEffort, index: number) => {
    if (index === effortIndex) return;
    onCommit(selectPickerEffort(selection, option));
    const nextTier = effortFlowTier(option.label, index, efforts.length);
    requestAnimationFrame(() => triggerEffortMotion(nextTier === "none" ? "step" : nextTier));
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (closing) return;
    if (event.nativeEvent.isComposing) return;
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === "KeyT") {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) onToggleStyle();
      return;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === "KeyM") {
      event.preventDefault();
      event.stopPropagation();
      return onClose("trigger");
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (styleOpen) return onCloseStyle();
      return onClose("trigger");
    }
    if (event.key === "Enter") {
      const target = event.target instanceof HTMLElement ? event.target : null;
      // A row or effort step picks and closes; other controls keep their own Enter.
      if (target !== event.currentTarget && target?.getAttribute("role") !== "radio") return;
      event.preventDefault();
      if (target !== event.currentTarget) target?.click();
      return onClose("composer");
    }
    if (event.key.startsWith("Arrow") && event.target instanceof Element && event.target.closest("[data-quick-lab]")) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (efforts.length < 2) return;
      event.preventDefault();
      const nextIdx = Math.max(0, Math.min(efforts.length - 1, (effortIndex < 0 ? 0 : effortIndex) + (event.key === "ArrowRight" ? 1 : -1)));
      if (nextIdx !== effortIndex && efforts[nextIdx]) pickEffort(efforts[nextIdx]!, nextIdx);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const allModels = pickerModels(rows).filter((item) => !locked(item));
      if (!allModels.length) return;
      event.preventDefault();
      const curIdx = allModels.findIndex((item) => item.instance.instanceId === selection.instanceId && item.cell.options.some((opt) => opt.id === selection.model));
      const target = allModels[(Math.max(0, curIdx) + (event.key === "ArrowDown" ? 1 : -1) + allModels.length) % allModels.length];
      if (target) {
        setViewedLabId(target.instance.instanceId);
        pickModel(target, target.cell);
      }
    }
  };

  const effortRatio = efforts.length > 0 && effortIndex >= 0 ? (effortIndex + 1) / efforts.length : 0;
  const shockLeftPct = efforts.length > 0 && effortIndex >= 0 ? `${(((effortIndex + 0.5) / efforts.length) * 100).toFixed(1)}%` : "85%";
  const glowX = efforts.length > 0 && effortIndex >= 0 ? `${Math.round(((effortIndex + 0.5) / efforts.length) * (spot.width - 24) - 90)}px` : "100px";
  const glowOpacity = flowTier === "max" ? 0.84 : flowTier === "xhigh" ? 0.54 : Number((0.16 + effortRatio * 0.36).toFixed(2));
  const glowScale = flowTier === "max" ? 1.24 : flowTier === "xhigh" ? 1.08 : Number((0.88 + effortRatio * 0.22).toFixed(2));
  const deckBarTotal = barCountFor(efforts.length);
  const deckBarHeights = useMemo(() => barHeights(deckBarTotal, 4, 16), [deckBarTotal]);
  const litBars = filledBarCount(effortIndex, efforts.length, deckBarTotal);
  const compactEffortLabels = efforts.length >= 6;
  const readoutText = activeEffort ? t("model.effortChip", { level: chipEffortLabel(activeEffort.label, t) }) : "";
  const activeNote = effortNote(activeEffort?.label, isTopNonMax, t);
  const viewedBlocked = Boolean(viewedRow && locked(viewedRow));


  return (
    <div
      ref={cardRef}
      id={id}
      role={closing ? undefined : "dialog"}
      aria-label={t("model.choose")}
      tabIndex={-1}
      data-model-picker-content={!closing || undefined}
      data-quick-model-picker=""
      data-skin={borrowedSkin}
      data-light={light || undefined}
      data-flow={flowTier !== "none" ? flowTier : undefined}
      data-apex={isApex || undefined}
      data-max={isMax || undefined}
      data-closing={closing || undefined}
      inert={closing || undefined}
      className="quick-card"
      style={cssVars({ top: spot.top, right: spot.right, width: spot.width, maxHeight: spot.maxHeight, "--quick-accent": activeAccent, "--quick-view-accent": viewedAccent })}
      onKeyDown={onKeyDown}
    >
      <div aria-hidden="true" className="quick-atmo" />
      <div aria-hidden="true" className="quick-head-glow" data-flow={flowTier !== "none" ? flowTier : undefined} />
      {flowTier !== "none" && <div aria-hidden="true" className="quick-card-neon" data-flow={flowTier} />}

      <div className="quick-head">
        <div className="quick-head-left">
          <span className="quick-head-title">{t("model.engineAxis")}</span>
          {(previewIntel != null || previewPriceCompact) && (
            <span
              className="quick-head-stat"
              title={[previewIntel != null ? `${t("modelIndex.index.intelligence")} ${previewIntel.toFixed(1)}` : "", previewPrice ? `${previewPrice} ${t("model.pricePerMillion")}` : ""].filter(Boolean).join(" · ")}
            >
              {previewIntel != null ? previewIntel.toFixed(1) : ""}
              {previewIntel != null && previewPriceCompact ? " · " : ""}
              {previewPriceCompact ?? ""}
            </span>
          )}
        </div>
        <span ref={styleButtonRef} className="quick-style-slot">
          <PickerStyleButton shown="quick" open={styleOpen} onToggle={onToggleStyle} />
        </span>
      </div>

      <div className="quick-labs-wrap">
        <div className="quick-labs" role="tablist" aria-label={t("model.engineAxis")} style={cssVars({ "--lab-count": Math.max(rows.length, 1), "--lab-idx": viewedRowIndex })}>
          <div aria-hidden="true" className="quick-lab-thumb" />
          {rows.map((row) => {
            const viewed = row.instance.instanceId === viewedRow?.instance.instanceId;
            const currentLab = row.instance.instanceId === selection.instanceId;
            const isLocked = locked(row);
            return (
              <button
                key={row.instance.instanceId}
                type="button"
                role="tab"
                data-quick-lab={row.instance.instanceId}
                aria-selected={viewed}
                data-locked={isLocked || undefined}
                className="quick-lab-btn"
                title={isLocked ? `${row.label} - ${t("model.signInRequired")}` : row.label}
                onClick={() => { setViewedLabId(row.instance.instanceId); setHoverIdx(null); }}
              >
                <ProviderBrandMark driverKind={row.instance.driverKind} size={13} />
                <span className="quick-lab-name">{labShortName(row)}</span>
                {isLocked && <Lock size={9} aria-hidden="true" />}
                {currentLab && !viewed && <span aria-hidden="true" className="quick-lab-live" style={cssVars({ "--quick-dot": modelFamilyAccent(row.instance.driverKind) })} />}
              </button>
            );
          })}
        </div>
      </div>

      <div className="quick-models-scroll">
        {viewedRow && (
          <div className="quick-models" role="radiogroup" aria-label={viewedRow.label} onMouseLeave={() => setHoverIdx(null)}>
            <div aria-hidden="true" className="quick-hover-pill" data-on={hoverIdx !== null || undefined} style={cssVars({ "--hover-idx": hoverIdx ?? 0 })} />
            {viewedRow.cells.map((cell, idx) => {
              const selected = viewedRow.instance.instanceId === selection.instanceId && cell.options.some((opt) => opt.id === selection.model);
              const idForStats = selected ? selection.model : cell.options[0]!.id;
              const { name, contrib, full } = cellDisplayName(cell);
              const score = rowIntelScore(viewedRow, idForStats, preferredEffort);
              const price = dialPrice(idForStats);
              return (
                <button
                  key={`${viewedRow.instance.instanceId}:${cell.options[0]!.id}`}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={viewedBlocked && !selected}
                  data-quick-model={cell.options[0]!.id}
                  className="quick-model-row"
                  title={contrib ? full : undefined}
                  onMouseEnter={() => setHoverIdx(idx)}
                  onFocus={() => setHoverIdx(idx)}
                  onClick={() => pickModel(viewedRow, cell)}
                >
                  <span className="quick-model-name-wrap">
                    <span className="quick-model-name">{name}</span>
                    {contrib && <span className="quick-model-badge">Contrib</span>}
                    {cell.offList && <span className="quick-model-badge">{t("model.offList")}</span>}
                  </span>
                  <span className="quick-model-meta">
                    <span className="quick-model-score">{score != null ? score.toFixed(1) : "-"}</span>
                    <span className="quick-model-tier">{price ? dialTier(price.blend) : "-"}</span>
                  </span>
                  <span className="quick-model-check" aria-hidden="true"><Check size={14} strokeWidth={2.4} /></span>
                </button>
              );
            })}
          </div>
        )}
        {viewedBlocked && viewedRow && <div className="quick-setup-wrap"><EngineSetup instance={viewedRow.instance} intent="cloud" /></div>}
      </div>

      <div
        className="quick-effort-deck"
        data-quick-effort-deck=""
        data-flow={flowTier !== "none" ? flowTier : undefined}
        data-apex={isApex || undefined}
        data-max={isMax || undefined}
        style={cssVars({ "--quick-accent": activeAccent, "--shock-left": shockLeftPct })}
      >
        <div aria-hidden="true" className="quick-deck-glow" style={cssVars({ "--glow-x": glowX, "--glow-op": glowOpacity, "--glow-scale": glowScale })} />
        {flowTier === "max" && <div aria-hidden="true" className="quick-deck-aurora" />}
        <div ref={sweepRef} aria-hidden="true" className="quick-deck-sweep" />
        <div ref={shockARef} aria-hidden="true" className="quick-shock" />
        <div ref={shockBRef} aria-hidden="true" className="quick-shock" />
        <div aria-hidden="true" className="quick-sparks">
          {APEX_SPARKS.map((spec, idx) => (
            <span key={idx} ref={(el) => { sparksRef.current[idx] = el; }} className="quick-spark" data-bright={spec.bright || undefined} />
          ))}
        </div>

        <div className="quick-effort-head">
          <div className="quick-effort-meta">
            <span className="quick-effort-label">{t("model.effort")}</span>
            {activeNote && <span data-quick-effort-note="" className="quick-effort-note">{activeNote}</span>}
          </div>
          {efforts.length > 0 && activeEffort && (
            <div className="quick-effort-status">
              <span
                aria-hidden="true"
                className="quick-bars"
                data-quick-bars="deck"
                data-bar-total={deckBarTotal}
                data-lit-count={litBars}
              >
                {deckBarHeights.map((height, idx) => {
                  const lit = idx < litBars;
                  const head = lit && idx === litBars - 1;
                  return (
                    <span
                      key={idx}
                      ref={(el) => { barsRef.current[idx] = el; }}
                      className="quick-bar-slot"
                      data-lit={lit || undefined}
                      style={cssVars({ height, "--bar-delay": `${idx * QUICK_BAR_BREATHE_STAGGER_MS}ms` })}
                    >
                      <span
                        className="quick-bar-fill"
                        data-lit={lit || undefined}
                        data-head={head || undefined}
                        style={lit ? cssVars({ "--bar-op": segmentOpacity(idx, litBars, isApex) }) : undefined}
                      />
                    </span>
                  );
                })}
              </span>
              <span ref={readoutRef} data-quick-effort-readout="" className="quick-effort-readout">{readoutText}</span>
            </div>
          )}
        </div>

        {efforts.length > 0 ? (
          <div className="quick-effort-track" role="radiogroup" aria-label={t("model.effort")} style={cssVars({ "--effort-count": efforts.length, "--effort-idx": Math.max(0, effortIndex) })}>
            {effortIndex >= 0 && (
              <div aria-hidden="true" className="quick-effort-thumb">
                <div ref={thumbBodyRef} className="quick-thumb-body">
                  {flowTier === "max" && <><div className="quick-thumb-neon" /><div className="quick-thumb-core"><div className="quick-thumb-pulse" /></div></>}
                </div>
              </div>
            )}
            {efforts.map((option, idx) => {
              const checked = idx === effortIndex;
              const optTier = effortFlowTier(option.label, idx, efforts.length);
              const label = compactEffortLabels ? chipEffortShortLabel(option.label, t) : chipEffortLabel(option.label, t);
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  data-quick-effort={option.label}
                  data-apex-btn={optTier === "max" || undefined}
                  className="quick-effort-btn"
                  onClick={() => pickEffort(option, idx)}
                >
                  <span>{label}</span>
                </button>
              );
            })}
            <div aria-hidden="true" className="quick-effort-steps">
              {efforts.map((option, idx) => {
                const lit = effortIndex >= 0 && idx <= effortIndex;
                const head = effortIndex >= 0 && idx === effortIndex;
                return (
                  <span key={option.id} className="quick-effort-step">
                    <span
                      className="quick-effort-step-fill"
                      data-lit={lit || undefined}
                      data-head={head || undefined}
                      style={lit ? cssVars({ "--step-op": segmentOpacity(idx, effortIndex + 1, isApex) }) : undefined}
                    />
                  </span>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="quick-fixed-effort">{t("model.quick.fixedEffort")}</div>
        )}
      </div>
    </div>
  );
}
