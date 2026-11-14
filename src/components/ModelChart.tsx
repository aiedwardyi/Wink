import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { Lock } from "lucide-react";
import type { ModelSelection } from "@/state/store";
import { pickerEfforts, pickerModels, selectPickerEffort, selectPickerModel, withPickerEffort, type PickerEffort, type PickerRow } from "@/lib/cross-model-picker";
import { dialPrice, dialRunCost, dialScore, dialShift, dialStep, dialTier } from "@/lib/model-dial";
import { modelEffortLabel } from "@/lib/model-chip";
import { MOTION_LARGE_MS } from "@/lib/motion";
import { reducedMotion } from "@/lib/phone-swipe";
import { useI18n } from "@/lib/i18n";
import { ProviderMark } from "./ProviderIcons";
import { engineChecking, needsCli, needsSignIn } from "./EngineSetup";
import type { ModelDialHandle } from "./ModelDial";
import { altKeyLabel } from "./PickerStyleStrip";
import "./ModelChart.css";

const XMIN = 0.003;
const DECADES = [0.01, 0.1, 1, 10];
const XMAX = 40;
const YMAX = 70;
// jsdom and the first frame measure 0; a desktop-sized plot keeps the dots clickable until the real size lands.
const FALLBACK = { w: 900, h: 560 };

export type Stop = { option?: PickerEffort; label: string; score?: number; coding?: number; cost?: number };
type Item = ReturnType<typeof pickerModels>[number];
export type Line = { row: Item; key: string; name: string; tag: string; offList?: boolean; stops: Stop[] };
type Point = { x: number; y: number };
type Box = Point & { w: number; h: number };
type Plot = { W: number; H: number; phone: boolean; pad: { l: number; r: number; t: number; b: number }; cw: number };

export const charted = (stop: Stop | undefined) => stop?.score != null && stop.cost != null;
const usd = (cost: number | undefined) => cost == null ? "-" : `$${cost < 0.1 ? cost.toFixed(3) : cost.toFixed(2)}`;
const one = (value: number | undefined) => value == null ? "-" : value.toFixed(1);
const signed = (n: number, format: (value: number) => string) => (n < 0 ? "−" : "+") + format(Math.abs(n));
const px = (n: number) => Math.round(n) + 0.5;
const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// The stop the reticle sits on: this one if charted, else the nearest charted stop (ties go up).
function anchor(line: Line | undefined, at: number): number {
  if (!line) return -1;
  if (charted(line.stops[at])) return at;
  return line.stops.map((_, k) => k).filter((k) => charted(line.stops[k])).sort((a, b) => Math.abs(a - at) - Math.abs(b - at) || b - a)[0] ?? -1;
}

export function lineOf(item: Item): Line {
  const option = item.cell.options[0]!;
  const contrib = !item.cell.offList && item.cell.options.length === 1 && /-contributor$/i.test(option.id);
  const efforts = pickerEfforts(item, item.cell);
  const stops = (efforts.length ? efforts : [undefined]).map((effort): Stop => {
    const model = effort?.model ?? option.id;
    return { option: effort, label: effort?.label ?? "", score: dialScore(model, effort?.effort, "intelligence"), coding: dialScore(model, effort?.effort, "coding"), cost: dialRunCost(model, effort?.effort) };
  });
  return { row: item, key: option.id, name: contrib ? option.label.replace(/\s+contributor$/i, "") : item.cell.label, tag: contrib ? "Contrib" : "", offList: item.cell.offList, stops };
}

export function locate(lines: Line[], selection: ModelSelection) {
  const index = lines.findIndex((line) => line.row.instance.instanceId === selection.instanceId && line.row.cell.options.some((option) => option.id === selection.model));
  const line = lines[index];
  const level = line ? line.stops.findIndex((stop) => !stop.option || (stop.option.model ? stop.option.model === selection.model : stop.option.effort === selection.effort)) : -1;
  return { index, line, level, stop: line?.stops[level] };
}

function useTween(to: Point | null, instant: boolean): Point | null {
  const [at, setAt] = useState(to);
  const now = useRef(to);
  useEffect(() => {
    const from = now.current;
    if (!to || !from || instant || reducedMotion()) {
      now.current = to;
      setAt(to);
      return;
    }
    const t0 = performance.now();
    let frame = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / MOTION_LARGE_MS);
      const e = 1 - Math.pow(1 - k, 5);
      now.current = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
      setAt(now.current);
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [to?.x, to?.y]);
  return at;
}

function Rolled({ value, format, name }: { value: number | undefined; format: (value: number | undefined) => string; name: string }) {
  const point = useTween(value == null ? null : { x: value, y: 0 }, false);
  return <dd data-chart-stat={name} data-none={value == null || undefined}>{format(value == null ? undefined : point?.x ?? value)}</dd>;
}

function Flag({ text, x, y, cw }: { text: string; x: number; y: number; cw: number }) {
  const w = text.length * cw + 10;
  return <g className="flag"><rect x={x - w / 2} y={y - 9} width={w} height={18} rx={2} /><text x={x} y={y + 4} textAnchor="middle">{text}</text></g>;
}

function Overlay({ plot, target, mark, ghost, now, nowLabel, same, under, instant }: { plot: Plot; target: Point | null; mark: string; ghost: boolean; now: Point | null; nowLabel: string; same: boolean; under: boolean; instant: boolean }) {
  const pos = useTween(target, instant);
  const { W, H, pad, phone, cw } = plot;
  const X = (cost: number) => pad.l + Math.log(cost / XMIN) / Math.log(XMAX / XMIN) * (W - pad.l - pad.r);
  const Y = (score: number) => H - pad.b - score / YMAX * (H - pad.t - pad.b);
  const xText = pos ? usd(XMIN * Math.pow(XMAX / XMIN, (pos.x - pad.l) / (W - pad.l - pad.r))) : "";
  const half = (xText.length * cw + 10) / 2;
  const fx = pos ? Math.min(Math.max(pos.x, pad.l + half), W - half - 1) : 0;
  const yHalf = (4 * cw + 10) / 2;
  const d = pos && now ? Math.hypot(pos.x - now.x, pos.y - now.y) : 0;
  const u = pos && now && d ? { x: (pos.x - now.x) / d, y: (pos.y - now.y) / d } : { x: 0, y: 0 };
  return (
    <>
      {[20, 40, 60].map((v) => <text key={v} className="ax" x={pad.l - 9} y={Y(v) + 4} textAnchor="end" visibility={pos && Math.abs(Y(v) - pos.y) < 15 ? "hidden" : undefined}>{v}</text>)}
      {([[0.01, "1¢"], [0.1, "10¢"], [1, "$1"], [10, "$10"]] as const).map(([v, label]) => (
        <text key={v} className="ax" x={X(v)} y={H - pad.b + (phone ? 15 : 20)} textAnchor="middle" visibility={pos && Math.abs(X(v) - fx) < half + 14 ? "hidden" : undefined}>{label}</text>
      ))}
      {pos && now && d > 44 && <line className="course" x1={now.x + u.x * 12} y1={now.y + u.y * 12} x2={pos.x - u.x * 22} y2={pos.y - u.y * 22} />}
      {now && <g className="nowm" transform={`translate(${now.x.toFixed(1)} ${now.y.toFixed(1)})`}>
        {!same && <path d="M0-5.5L5.5 0L0 5.5L-5.5 0Z" />}
        <text y={same ? -24 : under ? 19 : -12} textAnchor="middle">{nowLabel}</text>
      </g>}
      {/* Keyed on the stop, not its pixels: the first measure or a resize must not remount it. */}
      {target && <circle key={mark} className="ping" cx={target.x} cy={target.y} r={11} />}
      {pos && <>
        <line className="cross" x1={pos.x} x2={pos.x} y1={Math.min(pos.y + 18, H - pad.b)} y2={H - pad.b} />
        <line className="cross" x1={pad.l} x2={Math.max(pos.x - 18, pad.l)} y1={pos.y} y2={pos.y} />
        <g className="ret" data-chart-reticle data-ghost={ghost || undefined} transform={`translate(${pos.x.toFixed(1)} ${pos.y.toFixed(1)})`}>
          <circle className="halo" r={19} />
          <circle className="ring" r={10.5} />
          <circle className="core" r={4.5} />
        </g>
        <Flag text={xText} x={fx} y={H - pad.b + (phone ? 12 : 15)} cw={cw} />
        <Flag text={((H - pad.b - pos.y) / (H - pad.t - pad.b) * YMAX).toFixed(1)} x={Math.max(yHalf + 1, pad.l - yHalf - 5)} y={pos.y} cw={cw} />
      </>}
    </>
  );
}

type ModelChartProps = {
  rows: PickerRow[];
  draft: ModelSelection;
  current: ModelSelection;
  canCommit: (selection: ModelSelection) => boolean;
  onDraft: (next: ModelSelection) => void;
  onSave: (next?: ModelSelection, fromKeyboard?: boolean) => boolean;
  handle: Ref<ModelDialHandle | null>;
  stageRef: RefObject<HTMLDivElement | null>;
  children?: ReactNode;
};

export function ModelChart({ rows, draft, current, canCommit, onDraft, onSave, handle, stageRef, children }: ModelChartProps) {
  const { t } = useI18n();
  const lines = pickerModels(rows).map(lineOf);
  const { index, line, level, stop } = locate(lines, draft);
  const lab = rows.findIndex((row) => row.instance === line?.row.instance);
  const nowSelection = withPickerEffort(rows.find((row) => row.instance.instanceId === current.instanceId)?.instance, current);
  const now = locate(lines, nowSelection);
  const locked = (row: PickerRow) => !engineChecking(row.instance) && (needsCli(row.instance) || needsSignIn(row.instance));
  const pickable = canCommit(draft);
  const lastIn = useRef(new Map<string, string>());
  if (line) lastIn.current.set(line.row.instance.instanceId, line.key);

  const root = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0, rw: 0, rh: 0 });
  const [tip, setTip] = useState<{ x: number; y: number; id: string; line: Line; stop: Stop } | null>(null);
  const drawn = useRef(false);
  useLayoutEffect(() => {
    const measure = () => {
      const plot = plotRef.current!.getBoundingClientRect();
      const box = root.current!.getBoundingClientRect();
      setSize({ w: Math.round(plot.width), h: Math.round(plot.height), rw: box.width, rh: box.height });
    };
    measure();
    const observer = window.ResizeObserver ? new window.ResizeObserver(measure) : null;
    observer?.observe(plotRef.current!);
    observer?.observe(root.current!);
    return () => observer?.disconnect();
  }, []);
  const phone = size.rw > 0 && size.rw <= 800;
  const W = size.w || FALLBACK.w;
  const H = size.h || FALLBACK.h;
  const plot: Plot = { W, H, phone, pad: phone ? { l: 38, r: 10, t: 20, b: 24 } : { l: 46, r: 26, t: 30, b: 40 }, cw: phone ? 5.8 : 6.7 };
  const { pad, cw } = plot;
  const X = (cost: number) => pad.l + Math.log(cost / XMIN) / Math.log(XMAX / XMIN) * (W - pad.l - pad.r);
  const Y = (score: number) => H - pad.b - score / YMAX * (H - pad.t - pad.b);
  const spot = (s: Stop | undefined): Point | null => charted(s) ? { x: X(s!.cost!), y: Y(s!.score!) } : null;

  const aim = anchor(line, level);
  const aimed = line?.stops[aim];
  const target = spot(aimed);
  const nowAim = anchor(now.line, now.level);
  const nowPos = now.line ? spot(now.line.stops[nowAim]) : null;
  const same = Boolean(target && nowPos && Math.hypot(target.x - nowPos.x, target.y - nowPos.y) < 1);
  // The Now label sits on the side away from the selection, clear of the chosen line.
  const under = Boolean(target && nowPos && !same && target.y < nowPos.y);
  const instant = !drawn.current;
  useEffect(() => { drawn.current = true; });

  const go = (next: Line, at?: Stop) => {
    const moved = selectPickerModel(next.row.instance, next.key, draft);
    onDraft(at?.option ? selectPickerEffort(moved, at.option) : moved);
  };
  const goLab = (j: number) => {
    const row = rows[j];
    if (!row || j === lab) return;
    const key = lastIn.current.get(row.instance.instanceId);
    const next = lines.find((item) => item.row.instance === row.instance && item.key === key) ?? lines.find((item) => item.row.instance === row.instance);
    if (next) go(next);
  };

  useImperativeHandle(handle, () => ({
    key: (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.target instanceof HTMLInputElement) return false;
      const k = event.key;
      if (k === "ArrowUp" || k === "ArrowDown") onDraft(dialStep(rows, draft, k === "ArrowUp" ? -1 : 1));
      else if (k === "ArrowLeft" || k === "ArrowRight") onDraft(dialShift(rows, draft, k === "ArrowLeft" ? -1 : 1));
      else if (/^[1-5]$/.test(k)) goLab(Number(k) - 1);
      else return false;
      event.preventDefault();
      return true;
    },
  }));

  // Labels for the selected lab's lines, placed clear of the dots, the reticle and the crosshair.
  const labels: Array<Box & { text: string; sel: boolean; tx: number; anchor: "start" | "middle" | "end" }> = [];
  if (line) {
    const blocks: Box[] = lines.filter((item) => item.row.instance === line.row.instance).flatMap((item) => item.stops.map(spot).filter((p): p is Point => Boolean(p)).map((p) => ({ x: p.x - 6, y: p.y - 6, w: 12, h: 12 })));
    if (target) blocks.push({ x: target.x - 4, y: target.y, w: 8, h: H }, { x: pad.l, y: target.y - 9, w: target.x - pad.l, h: 18 });
    // In a crowded plot a label may sit on a dot, never on the reticle or the Now marker.
    const marks: Box[] = [];
    if (target) marks.push({ x: target.x - 17, y: target.y - 17, w: 34, h: 34 });
    if (nowPos) marks.push({ x: nowPos.x - 18, y: nowPos.y - (same ? 36 : under ? 8 : 24), w: 36, h: same ? 44 : 32 });
    for (const item of [line, ...lines.filter((other) => other !== line && other.row.instance === line.row.instance)]) {
      if (phone && item !== line) continue;
      const pts = item.stops.map(spot).filter((p): p is Point => Boolean(p));
      if (!pts.length) continue;
      const a = pts[0]!;
      const b = pts[pts.length - 1]!;
      const text = item.name + (item.tag ? ` ${item.tag}` : "");
      const w = text.length * cw;
      const h = 14;
      // Anchored on the dot's side, so a font wider or narrower than the guess still hugs it.
      const cands = ([
        { tx: a.x - 12, y: a.y - 7, anchor: "end" }, { tx: b.x + 12, y: b.y - 7, anchor: "start" }, { tx: b.x, y: b.y - 26, anchor: "middle" }, { tx: a.x, y: a.y + 12, anchor: "middle" },
        { tx: b.x - 6, y: b.y - 24, anchor: "end" }, { tx: a.x + 6, y: a.y + 12, anchor: "start" }, { tx: a.x - 12, y: a.y + 10, anchor: "end" }, { tx: b.x + 12, y: b.y - 22, anchor: "start" },
      ] as const).map((c) => ({ ...c, x: c.anchor === "end" ? c.tx - w : c.anchor === "middle" ? c.tx - w / 2 : c.tx, w, h }));
      const inside = (c: Box) => c.x > pad.l + 3 && c.x + w < W - pad.r - 2 && c.y > pad.t + 2 && c.y + h < H - pad.b - 3;
      const hard = [...marks, ...labels];
      const all = [...blocks, ...hard];
      const free = (c: Box, among: Box[]) => inside(c) && !among.some((o) => hit(c, o));
      const box = cands.find((c) => free(c, all)) ?? cands.find((c) => free(c, hard)) ?? cands.find(inside) ?? cands[0]!;
      labels.push({ ...box, text, sel: item === line });
    }
  }

  const capY = pad.t - (phone ? 7 : 11);
  const arrow = phone ? 7 : 9;
  const rank = (item: Line) => item === line ? 2 : item.row.instance === line?.row.instance ? 1 : 0;
  const drawOrder = lines.map((item, j) => ({ item, j })).sort((a, b) => rank(a.item) - rank(b.item) || a.j - b.j);
  const effortText = stop?.option ? modelEffortLabel(stop.option.label, t) : "";
  const nowText = now.line ? `${now.line.name}${now.line.tag ? ` ${now.line.tag}` : ""}${now.stop?.option ? ` · ${modelEffortLabel(now.stop.option.label, t)}` : ""}` : nowSelection.model;

  let delta: ReactNode;
  if (aim < 0) delta = t("model.chart.noScore");
  else if (aim !== level) delta = t("model.chart.notCharted", { effort: effortText, shown: modelEffortLabel(line!.stops[aim]!.label, t) });
  else if (index === now.index && level === now.level) delta = t("model.chart.current");
  else if (now.stop) {
    const parts: ReactNode[] = [];
    if (now.stop.score != null) parts.push(<span key="i"><b>{signed(stop!.score! - now.stop.score, (v) => v.toFixed(1))}</b> {t("modelIndex.index.intelligence").toLowerCase()}</span>);
    if (now.stop.cost != null) parts.push(<span key="c"><b>{signed(stop!.cost! - now.stop.cost, (v) => usd(v))}</b> {t("model.chart.perTask").toLowerCase()}</span>);
    if (parts.length) delta = <>{t("model.chart.vsNow")}{parts}</>;
  }

  return (
    <div ref={root} className="model-chart" data-phone={phone || undefined} data-short={(!phone && size.rh > 0 && size.rh <= 800) || undefined} data-mid={(!phone && size.rw > 0 && size.rw <= 1240) || undefined}>
      <header className="chart-top">
        <h2 className="chart-title">{t("model.choose")}</h2>
        <span className="chart-now" data-chart-now>
          <i>{t("model.chart.now")}</i>
          {now.line && <span className="chart-mk"><ProviderMark driverKind={now.line.row.instance.driverKind} size={14} /></span>}
          <span>{nowText}</span>
        </span>
      </header>

      <section className="chart-controls">
        <div>
          <h3>{t("model.chart.lab")}</h3>
          <div className="chart-labs" role="radiogroup" aria-label={t("model.chart.lab")}>
            {rows.map((row, j) => (
              <button
                key={row.instance.instanceId}
                type="button"
                role="radio"
                aria-checked={j === lab}
                className="chart-lab"
                data-chart-lab={row.instance.instanceId}
                data-locked={locked(row) || undefined}
                aria-label={locked(row) ? `${row.label}, ${t("model.signInRequired")}` : undefined}
                onClick={() => goLab(j)}
              >
                <span className="chart-mk"><ProviderMark driverKind={row.instance.driverKind} size={28} /></span>
                <span className="chart-lab-name">{row.label}</span>
                {locked(row) && <Lock size={10} className="chart-lock" aria-hidden />}
              </button>
            ))}
          </div>
        </div>
        <div>
          <h3>{t("model.engineAxis")}</h3>
          <div className="chart-models" role="radiogroup" aria-label={t("model.engineAxis")}>
            {lines.filter((item) => item.row.instance === line?.row.instance).map((item) => {
              const price = dialPrice(item.key);
              const tier = price ? dialTier(price.blend).length : 0;
              return (
                <button key={item.key} type="button" role="radio" aria-checked={item === line} tabIndex={item === line ? 0 : -1} className="chart-mrow" data-model-cell={item.key} onClick={() => go(item)}>
                  <span>{item.name}{item.tag && <small>{item.tag}</small>}{item.offList && <small>{t("model.offList")}</small>}</span>
                  {locked(item.row)
                    ? <Lock size={12} className="chart-tier" aria-label={t("model.signInRequired")} />
                    : tier > 0 && <span className="chart-tier" aria-hidden><b>{"$".repeat(tier)}</b>{"$".repeat(4 - tier)}</span>}
                </button>
              );
            })}
          </div>
        </div>
        {line && line.stops[0]?.option && <div>
          <h3>{t("model.effort")}</h3>
          <div className="chart-efforts" role="radiogroup" aria-label={t("model.effort")}>
            {line.stops.map((item, k) => (
              <button key={item.option!.id} type="button" role="radio" aria-checked={k === level} className="chart-eff" data-on={k <= level || undefined} data-picker-effort={item.option!.id} onClick={() => onDraft(selectPickerEffort(draft, item.option!))}>
                {modelEffortLabel(item.label, t)}<span>{usd(item.cost)}</span>
              </button>
            ))}
          </div>
        </div>}
        {children && <div className="model-cross-options chart-setup">{children}</div>}
        <div className="chart-go">
          <button type="button" className="chart-pick" data-chart-pick disabled={!pickable} onClick={() => onSave(draft)}>{t("model.chart.pick")}</button>
          <p className="chart-keys">
            <span><kbd>↑</kbd><kbd>↓</kbd>{t("model.engineAxis")}</span>
            <span><kbd>←</kbd><kbd>→</kbd>{t("model.modelAxis")}</span>
            <span><kbd>1-{Math.min(rows.length, 5)}</kbd>{t("model.chart.lab")}</span>
            <span><kbd>↵</kbd>{t("model.chart.pick")}</span>
            <span><kbd>{altKeyLabel()}</kbd><kbd>T</kbd>{t("model.style")}</span>
          </p>
        </div>
      </section>

      <div ref={stageRef} className="chart-stage">
        <div className="chart-readout">
          <div className="chart-who">
            <div className="chart-rlab">{line && <span className="chart-mk"><ProviderMark driverKind={line.row.instance.driverKind} size={16} /></span>}<span>{line?.row.label}</span></div>
            <div className="chart-rname"><span>{line ? line.name + (line.tag ? ` ${line.tag}` : "") : draft.model}</span>{effortText && <span className="chart-tag">{effortText}</span>}</div>
          </div>
          <p className="chart-delta" aria-live="polite">{delta}</p>
          <dl className="chart-stats">
            <div><dt>{t("modelIndex.index.intelligence")}</dt><Rolled name="intelligence" value={stop?.score} format={one} /></div>
            <div><dt>{t("modelIndex.index.coding")}</dt><Rolled name="coding" value={stop?.coding} format={one} /></div>
            <div><dt>{t("model.chart.perTask")}</dt><Rolled name="cost" value={stop?.cost} format={usd} /></div>
          </dl>
        </div>
        <div ref={plotRef} className="chart-plot">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t("model.chart.aria")} onPointerOut={() => setTip(null)}>
            {[20, 40, 60].map((v) => <line key={v} className="grid" x1={px(pad.l)} x2={px(W - pad.r)} y1={px(Y(v))} y2={px(Y(v))} />)}
            {DECADES.map((v) => <line key={v} className="grid" x1={px(X(v))} x2={px(X(v))} y1={px(pad.t)} y2={px(H - pad.b)} />)}
            <path className="plus" d={DECADES.flatMap((v) => [20, 40, 60].map((score) => `M${px(X(v)) - 4} ${px(Y(score))}h8M${px(X(v))} ${px(Y(score)) - 4}v8`)).join("")} />
            <path className="axis" d={`M${px(pad.l)} ${px(H - pad.b)}H${px(W - pad.r)}`} />
            <path className="axis" d={`M${px(pad.l)} ${px(pad.t)}V${px(H - pad.b)}`} />
            <path className="ticks" d={[
              ...[20, 40, 60].map((v) => `M${px(pad.l) - 5} ${px(Y(v))}H${px(pad.l)}`),
              ...[0.001, ...DECADES].flatMap((decade) => [1, 2, 3, 4, 5, 6, 7, 8, 9].map((step) => [decade * step, step] as const)).filter(([v]) => v > XMIN && v < XMAX).map(([v, step]) => `M${px(X(v))} ${px(H - pad.b)}v${step === 1 ? 5 : 3}`),
            ].join("")} />
            <g className="cap">
              <path d={`M${pad.l + 4} ${capY}v${-arrow}m${-arrow * 0.4} ${arrow * 0.4}l${arrow * 0.4} ${-arrow * 0.4}l${arrow * 0.4} ${arrow * 0.4}`} />
              <text x={pad.l + 4 + arrow} y={capY}>{t("model.chart.smarter")}</text>
              <text x={W - pad.r - arrow - 6} y={capY} textAnchor="end">{t("model.chart.costAxis")}</text>
              <path d={`M${W - pad.r - arrow} ${capY - arrow * 0.42}h${arrow}m${-arrow * 0.4} ${-arrow * 0.4}l${arrow * 0.4} ${arrow * 0.4}l${-arrow * 0.4} ${arrow * 0.4}`} />
            </g>
            {drawOrder.map(({ item }) => {
              const pts = item.stops.map(spot).filter((p): p is Point => Boolean(p));
              if (!pts.length) return null;
              const id = `${item.row.instance.instanceId}:${item.key}`;
              const points = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
              return (
                <g key={id} className="mdl" data-sel={item === line || undefined} data-lab={rank(item) === 1 || undefined} data-hov={tip?.id === id || undefined}>
                  {item === line && <polyline className="glow" points={points} />}
                  <polyline points={points} />
                  {pts.map((p, k) => <circle key={k} className="dot" cx={p.x} cy={p.y} r={4} />)}
                </g>
              );
            })}
            {line && aim < 0 && <text className="none" x={W - pad.r - 14} y={H - pad.b - 16} textAnchor="end">{t("model.chart.noScore")}</text>}
            <Overlay plot={plot} target={target} mark={`${aimed?.cost}:${aimed?.score}`} ghost={aim !== level} now={nowPos} nowLabel={t("model.chart.now")} same={same} under={under} instant={instant} />
            <g className="labels">{labels.map((label) => <text key={label.text} className="lbl" data-sel={label.sel || undefined} x={label.tx} y={label.y + 11} textAnchor={label.anchor}>{label.text}</text>)}</g>
            {tip && (() => {
              const name = `${tip.line.name}${tip.line.tag ? ` ${tip.line.tag}` : ""}${tip.stop.option ? ` · ${modelEffortLabel(tip.stop.label, t)}` : ""}`;
              const detail = `${t("modelIndex.index.intelligence")} ${one(tip.stop.score)} · ${usd(tip.stop.cost)}`;
              const w = Math.max(name.length, detail.length) * cw + 24;
              const x = Math.min(Math.max(tip.x, pad.l + w / 2), W - pad.r - w / 2);
              const y = tip.y < pad.t + 60 ? tip.y + 16 : tip.y - 58;
              return (
                <g className="tip">
                  <circle cx={tip.x} cy={tip.y} r={8} />
                  <rect x={x - w / 2} y={y} width={w} height={42} rx={2} />
                  <text className="name" x={x} y={y + 17} textAnchor="middle">{name}</text>
                  <text x={x} y={y + 33} textAnchor="middle">{detail}</text>
                </g>
              );
            })()}
            <g>
              {lines.flatMap((item) => item.stops.map((s) => {
                const p = spot(s);
                if (!p) return null;
                const id = `${item.row.instance.instanceId}:${item.key}`;
                return <circle
                  key={`${id}:${s.label}`}
                  className="hit"
                  r={phone ? 13 : 10}
                  cx={p.x}
                  cy={p.y}
                  data-stop={`${item.key}:${s.label}`}
                  onClick={() => go(item, s)}
                  onPointerOver={(event) => { if (event.pointerType === "mouse") setTip({ x: p.x, y: p.y, id, line: item, stop: s }); }}
                />;
              }))}
            </g>
          </svg>
        </div>
      </div>
    </div>
  );
}
