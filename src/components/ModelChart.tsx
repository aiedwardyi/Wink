import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { Lock } from "lucide-react";
import type { ModelSelection } from "@/state/store";
import { pickerEfforts, pickerModels, selectPickerEffort, selectPickerModel, withPickerEffort, type PickerEffort, type PickerRow } from "@/lib/cross-model-picker";
import { dialPrice, dialRunCost, dialScore, dialShift, dialStep, dialTier } from "@/lib/model-dial";
import { modelEffortLabel } from "@/lib/model-chip";
import { reducedMotion } from "@/lib/phone-swipe";
import { useI18n } from "@/lib/i18n";
import { ProviderMark } from "./ProviderIcons";
import { needsCli, needsSignIn } from "./EngineSetup";
import type { ModelDialHandle } from "./ModelDial";
import "./ModelChart.css";

const XMIN = 0.003;
const XMAX = 40;
const YMAX = 70;
// jsdom and the first frame measure 0; a desktop-sized plot keeps the dots clickable until the real size lands.
const FALLBACK = { w: 900, h: 560 };

type Stop = { option?: PickerEffort; label: string; score?: number; coding?: number; cost?: number };
type Item = ReturnType<typeof pickerModels>[number];
type Line = { row: Item; key: string; name: string; tag: string; offList?: boolean; stops: Stop[] };
type Point = { x: number; y: number };
type Box = Point & { w: number; h: number };
type Plot = { W: number; H: number; phone: boolean; pad: { l: number; r: number; t: number; b: number }; cw: number };

const charted = (stop: Stop | undefined) => stop?.score != null && stop.cost != null;
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

function lineOf(item: Item): Line {
  const option = item.cell.options[0]!;
  const contrib = !item.cell.offList && item.cell.options.length === 1 && /-contributor$/i.test(option.id);
  const efforts = pickerEfforts(item, item.cell);
  const stops = (efforts.length ? efforts : [undefined]).map((effort): Stop => {
    const model = effort?.model ?? option.id;
    return { option: effort, label: effort?.label ?? "", score: dialScore(model, effort?.effort, "intelligence"), coding: dialScore(model, effort?.effort, "coding"), cost: dialRunCost(model, effort?.effort) };
  });
  return { row: item, key: option.id, name: contrib ? option.label.replace(/\s+contributor$/i, "") : item.cell.label, tag: contrib ? "Contrib" : "", offList: item.cell.offList, stops };
}

function locate(lines: Line[], selection: ModelSelection) {
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
      const k = Math.min(1, (t - t0) / 240);
      const e = 1 - Math.pow(1 - k, 3);
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
  return <dd data-chart-stat={name}>{format(value == null ? undefined : point?.x ?? value)}</dd>;
}

function Flag({ text, x, y, cw }: { text: string; x: number; y: number; cw: number }) {
  const w = text.length * cw + 10;
  return <g className="flag"><rect x={x - w / 2} y={y - 9} width={w} height={18} /><text x={x} y={y + 4} textAnchor="middle">{text}</text></g>;
}

function Overlay({ plot, target, ghost, now, same, instant }: { plot: Plot; target: Point | null; ghost: boolean; now: Point | null; same: boolean; instant: boolean }) {
  const pos = useTween(target, instant);
  const { W, H, pad, phone, cw } = plot;
  const X = (cost: number) => pad.l + Math.log(cost / XMIN) / Math.log(XMAX / XMIN) * (W - pad.l - pad.r);
  const Y = (score: number) => H - pad.b - score / YMAX * (H - pad.t - pad.b);
  const xText = pos ? usd(XMIN * Math.pow(XMAX / XMIN, (pos.x - pad.l) / (W - pad.l - pad.r))) : "";
  const half = (xText.length * cw + 10) / 2;
  const fx = pos ? Math.min(Math.max(pos.x, pad.l + half), W - half - 1) : 0;
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
        {!same && <path d="M0-5L5 0L0 5L-5 0Z" />}
        <text y={same ? -22 : -11} textAnchor="middle">NOW</text>
      </g>}
      {pos && <>
        <line className="cross" x1={pos.x} x2={pos.x} y1={Math.min(pos.y + 18, H - pad.b)} y2={H - pad.b} />
        <line className="cross" x1={pad.l} x2={Math.max(pos.x - 18, pad.l)} y1={pos.y} y2={pos.y} />
        <g className="ret" data-chart-reticle data-ghost={ghost || undefined} transform={`translate(${pos.x.toFixed(1)} ${pos.y.toFixed(1)})`}>
          <path className="br" d="M-14-8V-14H-8M8-14H14V-8M14 8V14H8M-8 14H-14V8" />
          <rect className="core" x={-3.5} y={-3.5} width={7} height={7} />
        </g>
        <Flag text={xText} x={fx} y={H - pad.b + (phone ? 12 : 15)} cw={cw} />
        <Flag text={((H - pad.b - pos.y) / (H - pad.t - pad.b) * YMAX).toFixed(1)} x={pad.l - (4 * cw + 10) / 2 - 5} y={pos.y} cw={cw} />
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
  const locked = (row: PickerRow) => needsCli(row.instance) || needsSignIn(row.instance);
  const pickable = canCommit(draft);
  const lastIn = useRef(new Map<string, string>());
  if (line) lastIn.current.set(line.row.instance.instanceId, line.key);

  const root = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0, rw: 0, rh: 0 });
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
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
  const plot: Plot = { W, H, phone, pad: phone ? { l: 34, r: 10, t: 20, b: 24 } : { l: 46, r: 26, t: 30, b: 40 }, cw: phone ? 5.8 : 6.7 };
  const { pad, cw } = plot;
  const X = (cost: number) => pad.l + Math.log(cost / XMIN) / Math.log(XMAX / XMIN) * (W - pad.l - pad.r);
  const Y = (score: number) => H - pad.b - score / YMAX * (H - pad.t - pad.b);
  const spot = (s: Stop | undefined): Point | null => charted(s) ? { x: X(s!.cost!), y: Y(s!.score!) } : null;

  const aim = anchor(line, level);
  const target = line ? spot(line.stops[aim]) : null;
  const nowAim = anchor(now.line, now.level);
  const nowPos = now.line ? spot(now.line.stops[nowAim]) : null;
  const same = Boolean(target && nowPos && Math.hypot(target.x - nowPos.x, target.y - nowPos.y) < 1);
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
  const labels: Array<Box & { text: string; sel: boolean }> = [];
  if (line) {
    const blocks: Box[] = lines.filter((item) => item.row.instance === line.row.instance).flatMap((item) => item.stops.map(spot).filter((p): p is Point => Boolean(p)).map((p) => ({ x: p.x - 6, y: p.y - 6, w: 12, h: 12 })));
    if (target) blocks.push({ x: target.x - 17, y: target.y - 17, w: 34, h: 34 }, { x: target.x - 4, y: target.y, w: 8, h: H }, { x: pad.l, y: target.y - 9, w: target.x - pad.l, h: 18 });
    if (nowPos) blocks.push({ x: nowPos.x - 16, y: nowPos.y - 24, w: 32, h: 32 });
    for (const item of [line, ...lines.filter((other) => other !== line && other.row.instance === line.row.instance)]) {
      if (phone && item !== line) continue;
      const pts = item.stops.map(spot).filter((p): p is Point => Boolean(p));
      if (!pts.length) continue;
      const a = pts[0]!;
      const b = pts[pts.length - 1]!;
      const text = item.name + (item.tag ? ` ${item.tag}` : "");
      const w = text.length * cw;
      const h = 14;
      const cands = [
        { x: a.x - 12 - w, y: a.y - 7 }, { x: b.x + 12, y: b.y - 7 }, { x: b.x - w / 2, y: b.y - 26 }, { x: a.x - w / 2, y: a.y + 12 },
        { x: b.x - w - 6, y: b.y - 24 }, { x: a.x + 6, y: a.y + 12 }, { x: a.x - 12 - w, y: a.y + 10 }, { x: b.x + 12, y: b.y - 22 },
      ].map((c) => ({ ...c, w, h }));
      const inside = (c: Box) => c.x > pad.l + 3 && c.x + w < W - pad.r - 2 && c.y > pad.t + 2 && c.y + h < H - pad.b - 3;
      const box = cands.find((c) => inside(c) && ![...blocks, ...labels].some((o) => hit(c, o))) ?? cands.find(inside) ?? cands[0]!;
      labels.push({ ...box, text, sel: item === line });
    }
  }

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
          <h3><i>01</i>{t("model.chart.lab")}</h3>
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
          <h3><i>02</i>{t("model.engineAxis")}</h3>
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
          <h3><i>03</i>{t("model.effort")}</h3>
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
            <span><b>↑↓</b>{t("model.engineAxis")}</span>
            <span><b>←→</b>{t("model.modelAxis")}</span>
            <span><b>1-{Math.min(rows.length, 5)}</b>{t("model.chart.lab")}</span>
            <span><b>↵</b>{t("model.chart.pick")}</span>
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
            {[0.01, 0.1, 1, 10].map((v) => <line key={v} className="grid" x1={px(X(v))} x2={px(X(v))} y1={px(pad.t)} y2={px(H - pad.b)} />)}
            <path className="axis" d={`M${px(pad.l)} ${px(pad.t)}V${px(H - pad.b)}H${px(W - pad.r)}`} />
            <path className="corner" d={`M${px(W - pad.r) - 9} ${px(pad.t)}H${px(W - pad.r)}V${px(pad.t) + 9}M${px(pad.l)} ${px(pad.t) + 9}V${px(pad.t)}H${px(pad.l) + 9}`} />
            <text className="cap" x={pad.l} y={pad.t - (phone ? 7 : 11)}>{`↑ ${t("model.chart.smarter").toUpperCase()}`}</text>
            <text className="cap" x={W - pad.r} y={pad.t - (phone ? 7 : 11)} textAnchor="end">{`${t("model.chart.costAxis").toUpperCase()} →`}</text>
            {drawOrder.map(({ item }) => {
              const pts = item.stops.map(spot).filter((p): p is Point => Boolean(p));
              if (!pts.length) return null;
              return (
                <g key={`${item.row.instance.instanceId}:${item.key}`} className="mdl" data-sel={item === line || undefined} data-lab={rank(item) === 1 || undefined}>
                  <polyline points={pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")} />
                  {pts.map((p, k) => <rect key={k} className="dot" x={p.x - 3.5} y={p.y - 3.5} width={7} height={7} />)}
                </g>
              );
            })}
            <Overlay plot={plot} target={target} ghost={aim !== level} now={nowPos} same={same} instant={instant} />
            <g className="labels">{labels.map((label) => <text key={label.text} className="lbl" data-sel={label.sel || undefined} x={label.x} y={label.y + 11}>{label.text}</text>)}</g>
            {tip && (() => {
              const w = tip.text.length * cw + 16;
              const x = Math.min(Math.max(tip.x, pad.l + w / 2), W - pad.r - w / 2);
              return <g className="tip"><rect x={x - w / 2} y={tip.y - 34} width={w} height={20} /><text x={x} y={tip.y - 20} textAnchor="middle">{tip.text}</text></g>;
            })()}
            <g>
              {lines.flatMap((item) => item.stops.map((s) => {
                const p = spot(s);
                if (!p) return null;
                const text = `${item.name}${item.tag ? ` ${item.tag}` : ""}${s.option ? ` · ${modelEffortLabel(s.label, t)}` : ""}`;
                return <circle
                  key={`${item.row.instance.instanceId}:${item.key}:${s.label}`}
                  className="hit"
                  r={phone ? 13 : 10}
                  cx={p.x}
                  cy={p.y}
                  data-stop={`${item.key}:${s.label}`}
                  onClick={() => go(item, s)}
                  onPointerOver={(event) => { if (event.pointerType === "mouse") setTip({ x: p.x, y: p.y, text }); }}
                />;
              }))}
            </g>
          </svg>
        </div>
      </div>
    </div>
  );
}
