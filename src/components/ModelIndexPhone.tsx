// Phone Model Index: a ranked list first, a light chart one tab away. The pinch and zoom chart stays behind full screen.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Maximize2 } from "lucide-react";
import { cn } from "@/lib/cn";
import type { Translate } from "@/lib/i18n";
import { chartProvider, effortRank, fitLogTicks, formatCost, logTicks, type ChartProvider, type ModelIndexPoint } from "@/lib/model-index";
import { botAvatarAssetPath, type BotAvatarId } from "../../shared/bot-avatar";
import { edgeFade } from "./Segmented";

export const PROVIDER_NAME = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  meta: "Meta",
} satisfies Record<Exclude<ChartProvider, "other">, string>;

const AVATAR = {
  anthropic: "icon-45",
  openai: "icon-46",
  google: "icon-47",
  xai: "icon-48",
  meta: "icon-49",
} satisfies Record<Exclude<ChartProvider, "other">, BotAvatarId>;

// Best value looks only at the top of the list, so a cheap low scorer never takes it.
const VALUE_POOL = 9;
const CHART_HEIGHT = 380;
const PLOT = { top: 14, right: 10, bottom: 34, left: 34 };
const NAMED = 3;
// Two names closer than this read as one, like "Gemini 4 Carbon Opus 5.5".
const NAME_GAP = 10;

const color = (provider: string) => `var(--mi-${chartProvider(provider)})`;
const shortLabel = (label: string) => label.replace(/^Claude /, "");

export interface PhoneModel {
  model: string;
  label: string;
  provider: ChartProvider;
  rank: number;
  best: ModelIndexPoint;
  efforts: ModelIndexPoint[];
}

/** One row per model at its best effort; Cost ranks cheapest first. */
export function rankModels(points: readonly ModelIndexPoint[], cheapest: boolean): PhoneModel[] {
  const groups = new Map<string, ModelIndexPoint[]>();
  for (const point of points) groups.set(point.model, [...(groups.get(point.model) ?? []), point]);
  const better = (a: number, b: number) => (cheapest ? a < b : a > b);
  return [...groups.values()]
    .map((list) => {
      const efforts = [...list].sort((a, b) => effortRank(a.effort) - effortRank(b.effort));
      const best = efforts.reduce((top, point) => (better(point.score, top.score) ? point : top));
      return { model: best.model, label: best.label, provider: chartProvider(best.provider), rank: 0, best, efforts };
    })
    .sort((a, b) => (cheapest ? a.best.score - b.best.score : b.best.score - a.best.score))
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

export function bestValue(rows: readonly PhoneModel[]): string | undefined {
  const priced = rows.slice(0, VALUE_POOL).filter((row) => row.best.cost);
  if (priced.length < 2) return undefined;
  return priced.reduce((top, row) => (row.best.score / row.best.cost! > top.best.score / top.best.cost! ? row : top)).model;
}

function Avatar({ provider, size }: { provider: ChartProvider; size: number }) {
  const id = provider === "other" ? undefined : AVATAR[provider];
  const radius = size > 20 ? "rounded-lg" : "rounded-[4px]";
  return id ? (
    <img src={botAvatarAssetPath(id)} alt="" width={size} height={size} draggable={false} className={cn("block shrink-0", radius)} style={{ width: size, height: size }} />
  ) : (
    <span aria-hidden className={cn("block shrink-0", radius)} style={{ width: size, height: size, background: color(provider) }} />
  );
}

/** Index pills that scroll sideways under an edge fade; the picked one scrolls into view. */
export function PhoneTabs<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ id: T; label: string }>; onChange: (id: T) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [mask, setMask] = useState<string | undefined>();
  useEffect(() => {
    const row = ref.current;
    if (!row) return;
    row.querySelector<HTMLElement>('[aria-checked="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    setMask(edgeFade(row, 44));
  }, [value]);
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      onScroll={(e) => setMask(edgeFade(e.currentTarget, 44))}
      className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pt-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            "flex h-[34px] shrink-0 items-center whitespace-nowrap rounded-full px-3.5 text-[14px] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus",
            value === option.id ? "bg-ink font-semibold text-panel" : "bg-inset text-ink-secondary",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Ranked | Chart at full width, built on Segmented. */
export function PhoneSwitch({ children }: { children: ReactNode }) {
  return (
    <div className="[&>[role=radiogroup]]:w-full [&_[aria-checked=true]]:font-semibold [&_[role=radio]]:flex-1 [&_[role=radio]]:py-1.5 [&_[role=radio]]:text-[14px]">
      {children}
    </div>
  );
}

export function ProviderChips({ providers, value, onChange, t }: { providers: ChartProvider[]; value: ChartProvider | null; onChange: (provider: ChartProvider | null) => void; t: Translate }) {
  const chip = "flex h-7 items-center gap-1.5 rounded-full border text-[13px]";
  const on = "border-ink bg-ink font-semibold text-panel";
  return (
    <div className="flex flex-wrap gap-1.5">
      <button type="button" aria-pressed={!value} onClick={() => onChange(null)} className={cn(chip, "px-3", value ? "border-hairline text-ink" : on)}>
        {t("modelIndex.all")}
      </button>
      {providers.map((provider) => (
        <button
          key={provider}
          type="button"
          aria-pressed={value === provider}
          onClick={() => onChange(value === provider ? null : provider)}
          className={cn(chip, "pl-1.5 pr-2.5", value === provider ? on : "border-hairline text-ink")}
        >
          <Avatar provider={provider} size={16} />
          <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: color(provider) }} />
          {provider === "other" ? t("modelIndex.provider.other") : PROVIDER_NAME[provider]}
        </button>
      ))}
    </div>
  );
}

function niceTop(max: number) {
  const step = 10 ** Math.floor(Math.log10(max));
  return Math.ceil(max / step) * step;
}

export function PhoneRanked({
  rows,
  value,
  title,
  hint,
  chips,
  valueText,
  t,
}: {
  rows: PhoneModel[];
  value?: string;
  title: string;
  hint: string;
  chips: ReactNode;
  valueText: (point: ModelIndexPoint) => string;
  t: Translate;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const top = niceTop(Math.max(1e-9, ...rows.map((row) => row.best.score)));
  return (
    <div data-mi-ranked className="flex flex-col">
      <div className="flex items-baseline justify-between gap-3 text-[12.5px] text-ink-secondary">
        <span>
          <b className="font-semibold text-ink">{title}</b> · {hint}
        </span>
        <span className="shrink-0">{t("modelIndex.modelCount", { count: rows.length })}</span>
      </div>
      <div className="pb-1.5 pt-2.5">{chips}</div>
      <div className="-mx-4 pt-0.5">
        {rows.map((row) => {
          const expanded = open === row.model;
          return (
            <button
              key={row.model}
              type="button"
              data-mi-row={row.model}
              aria-expanded={expanded}
              onClick={() => setOpen(expanded ? null : row.model)}
              className="grid min-h-[58px] w-full grid-cols-[22px_32px_minmax(0,1fr)_minmax(76px,auto)] items-center gap-2.5 border-t border-hairline/45 px-4 py-2 text-left first:border-t-0"
            >
              <span className="text-right text-[13px] tabular-nums text-ink-secondary">{row.rank}</span>
              <Avatar provider={row.provider} size={32} />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <span data-mi-name className="text-[15px] font-semibold leading-5 text-ink">{row.label}</span>
                  {row.best.effort !== "all" && (
                    <span className="rounded-full border border-hairline px-1.5 text-[11.5px] font-medium leading-4 text-ink-secondary">{row.best.effort}</span>
                  )}
                </span>
                <span className="mt-1.5 block h-1.5 overflow-hidden rounded-[3px] bg-inset">
                  <span data-mi-bar className="block h-full rounded-[3px]" style={{ width: `${(row.best.score / top) * 100}%`, background: color(row.provider) }} />
                </span>
                {expanded && (
                  <span className="mt-2 flex flex-wrap gap-1.5">
                    {row.efforts.map((point) => (
                      <span
                        key={point.key}
                        className={cn("rounded-full border px-2 py-0.5 text-[12.5px] tabular-nums", point === row.best ? "border-ink bg-inset text-ink" : "border-hairline text-ink-secondary")}
                      >
                        {point.effort !== "all" && `${point.effort} `}
                        <b className="font-semibold text-ink">{valueText(point)}</b>
                        {point.cost ? ` · ${formatCost(point.cost)}` : ""}
                      </span>
                    ))}
                  </span>
                )}
              </span>
              <span className="self-start text-right tabular-nums">
                <span className="block text-[18px] font-semibold leading-[22px] text-ink">{valueText(row.best)}</span>
                {row.best.cost ? <span className="block whitespace-nowrap text-[12px] text-ink-secondary">{t("modelIndex.perTask", { cost: formatCost(row.best.cost) })}</span> : null}
                {row.model === value && <span className="block whitespace-nowrap text-[11.5px] font-semibold lowercase text-accent-text">{t("modelIndex.bestValue")}</span>}
              </span>
            </button>
          );
        })}
      </div>
      <div className="pointer-events-none sticky bottom-0 -mx-4 flex h-16 items-end justify-center bg-gradient-to-b from-transparent to-panel to-55% pb-3 text-[12.5px] text-ink-secondary">
        {t("modelIndex.tapModel")}
      </div>
    </div>
  );
}

type Spot = { x: number; y: number };
type Box = { x: number; y: number; w: number; h: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

let canvas: CanvasRenderingContext2D | null | undefined;
function measure(text: string) {
  canvas ??= document.createElement("canvas").getContext("2d");
  if (!canvas) return text.length * 7;
  canvas.font = `600 12.5px ${getComputedStyle(document.body).fontFamily}`;
  return canvas.measureText(text).width;
}

/** Each name takes the first side of its dot that clears the frame, the other names and the other dots. */
export function placeNames(named: Array<{ id: string; text: string; at: Spot }>, dots: Spot[], frame: { left: number; top: number; right: number; bottom: number }) {
  const placed: Box[] = [];
  const out = new Map<string, { x: number; y: number; anchor: "start" | "middle" | "end" }>();
  for (const { id, text, at } of named) {
    const w = measure(text);
    const h = 14;
    const sides = [
      { dx: -9, dy: -8, anchor: "end" as const },
      { dx: 9, dy: 16, anchor: "start" as const },
      { dx: -9, dy: 4, anchor: "end" as const },
      { dx: 9, dy: 4, anchor: "start" as const },
      { dx: 0, dy: -12, anchor: "middle" as const },
      { dx: 0, dy: 22, anchor: "middle" as const },
      { dx: 9, dy: -8, anchor: "start" as const },
      { dx: -9, dy: 16, anchor: "end" as const },
    ].map((side) => {
      const x = at.x + side.dx;
      const left = side.anchor === "end" ? x - w : side.anchor === "middle" ? x - w / 2 : x;
      return { ...side, x, y: at.y + side.dy, box: { x: left, y: at.y + side.dy - 11, w, h } };
    });
    const cost = ({ box }: (typeof sides)[number]) =>
      (box.x < frame.left || box.x + box.w > frame.right || box.y < frame.top || box.y + box.h > frame.bottom ? 1000 : 0) +
      placed.filter((other) => overlaps(box, { x: other.x - NAME_GAP, y: other.y - 2, w: other.w + NAME_GAP * 2, h: other.h + 4 })).length * 100 +
      dots.filter((dot) => overlaps(box, { x: dot.x - 6, y: dot.y - 6, w: 12, h: 12 })).length;
    const side = sides.reduce((top, next) => (cost(next) < cost(top) ? next : top));
    placed.push(side.box);
    out.set(id, { x: side.x, y: side.y, anchor: side.anchor });
  }
  return out;
}

export function PhoneChart({
  rows,
  width,
  title,
  percent,
  tick,
  chips,
  foot,
  valueText,
  onFull,
  t,
}: {
  rows: PhoneModel[];
  width: number;
  title: string;
  percent: boolean;
  tick: (value: number) => string;
  chips: ReactNode;
  foot: ReactNode;
  valueText: (point: ModelIndexPoint) => string;
  onFull: () => void;
  t: Translate;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // Each model's dot sits at its best effort that has a cost.
  const charted = rows.flatMap((row) => {
    const priced = row.efforts.filter((point) => point.cost);
    if (!priced.length) return [];
    const dot = row.best.cost ? row.best : priced.reduce((top, point) => (point.score > top.score ? point : top));
    return [{ ...row, priced, dot }];
  });
  const chosen = charted.find((row) => row.model === picked) ?? charted[0];

  const W = width + 16;
  const H = CHART_HEIGHT;
  const [left, right, top, bottom] = [PLOT.left, W - PLOT.right, PLOT.top, H - PLOT.bottom];
  const all = charted.flatMap((row) => row.priced);
  const costs = all.map((point) => point.cost!);
  const scores = all.map((point) => point.score);
  const [x0, x1] = costs.length ? [Math.log10(Math.min(...costs) / 1.6), Math.log10(Math.max(...costs) * 1.6)] : [-2, 2];
  const x = (usd: number) => left + ((Math.log10(usd) - x0) / (x1 - x0 || 1)) * (right - left);
  const decades = logTicks(10 ** x0, 10 ** x1, [1]);
  const xTicks = decades.length >= 2 ? decades : fitLogTicks(10 ** x0, 10 ** x1, right - left, (usd) => `$${usd}`.length * 7);

  const lo = scores.length ? Math.min(...scores) : 0;
  const hi = scores.length ? Math.max(...scores) : 100;
  const span = hi - lo || 1;
  const mag = 10 ** Math.floor(Math.log10(span / 6));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= span / 6)!;
  const y0 = Math.max(0, Math.floor((lo - span * 0.04) / step) * step);
  const y1 = Math.min(percent ? 100 : Infinity, Math.ceil((hi + span * 0.04) / step) * step);
  const y = (score: number) => bottom - ((score - y0) / (y1 - y0 || 1)) * (bottom - top);
  const grid = Array.from({ length: Math.round((y1 - y0) / step) + 1 }, (_, i) => y0 + i * step);

  const named = charted.slice(0, NAMED);
  const spot = (row: (typeof charted)[number]) => ({ x: x(row.dot.cost!), y: y(row.dot.score) });
  const names = placeNames(
    named.map((row) => ({ id: row.model, text: shortLabel(row.label), at: spot(row) })),
    charted.map(spot),
    // Names may spill 4px into the 8px the plot bleeds into the page padding.
    { left, top, right: W + 4, bottom },
  );
  const big = new Set([...named.map((row) => row.model), chosen?.model]);
  const ordered = [...charted].sort((a, b) => Number(big.has(a.model)) - Number(big.has(b.model)) || Number(a === chosen) - Number(b === chosen));

  const tap = (clientX: number, clientY: number) => {
    const frame = svgRef.current?.getBoundingClientRect();
    if (!frame) return;
    let nearest: string | null = null;
    let reach = 28;
    for (const row of charted) {
      const at = spot(row);
      const gap = Math.hypot(at.x - (clientX - frame.left), at.y - (clientY - frame.top));
      if (gap < reach) [nearest, reach] = [row.model, gap];
    }
    if (nearest) setPicked(nearest);
  };

  const [hintStart, hintEnd] = t("modelIndex.chart.hint", { tap: "\u0000" }).split("\u0000");
  return (
    <div data-mi-phone-chart className="flex flex-col">
      <div className="flex items-baseline justify-between gap-3 text-[12.5px] text-ink-secondary">
        <span>
          {hintStart}
          <b className="font-semibold text-ink">{t("modelIndex.chart.tapDot")}</b>
          {hintEnd}
        </span>
        <span className="shrink-0">{t("modelIndex.chart.dot")}</span>
      </div>
      <div className="relative -mx-2 pt-1.5">
        <button
          type="button"
          onClick={onFull}
          className="absolute right-1 top-0.5 flex size-8 items-center justify-center rounded-lg text-ink-secondary hover:bg-control"
          aria-label={t("modelIndex.fullScreen")}
        >
          <Maximize2 size={16} />
        </button>
        <svg ref={svgRef} width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block overflow-visible" role="img" aria-label={title}>
          <text x={left} y={10} className="fill-ink-secondary text-[11px]">
            ↑ {title}
          </text>
          {grid.map((value, i) => (
            <g key={`y${value}`}>
              <line x1={left} x2={right} y1={y(value)} y2={y(value)} className="stroke-hairline" strokeOpacity={0.5} />
              {i % 2 === 0 && (
                <text x={left - 6} y={y(value) + 4} textAnchor="end" className="fill-ink-secondary text-[11px] tabular-nums">
                  {tick(value)}
                </text>
              )}
            </g>
          ))}
          {xTicks.map((usd) => (
            <g key={`x${usd}`}>
              <line x1={x(usd)} x2={x(usd)} y1={top} y2={bottom} className="stroke-hairline" strokeOpacity={0.5} />
              <text x={x(usd)} y={bottom + 16} textAnchor="middle" className="fill-ink-secondary text-[11px] tabular-nums">
                {`$${usd}`}
              </text>
            </g>
          ))}
          <text x={right} y={H - 4} textAnchor="end" className="fill-ink-secondary text-[11px]">
            {t("modelIndex.axis.costLog")} →
          </text>
          <rect x={0} y={0} width={W} height={H} fill="transparent" onClick={(e) => tap(e.clientX, e.clientY)} />
          {ordered.map((row) =>
            row.priced.length > 1 ? (
              <polyline
                key={`line-${row.model}`}
                fill="none"
                pointerEvents="none"
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeWidth={row === chosen ? 2.5 : 1.5}
                strokeOpacity={row === chosen ? 1 : 0.35}
                style={{ stroke: color(row.provider) }}
                points={row.priced.map((point) => `${x(point.cost!).toFixed(1)},${y(point.score).toFixed(1)}`).join(" ")}
              />
            ) : null,
          )}
          {ordered.map((row) => {
            const at = spot(row);
            return (
              <g key={`dot-${row.model}`} data-mi-dot={row.model}>
                <circle cx={at.x} cy={at.y} r={big.has(row.model) ? 6 : 4.5} fillOpacity={big.has(row.model) ? 1 : 0.85} strokeWidth={2} style={{ fill: color(row.provider), stroke: "var(--color-panel)" }} />
                <circle
                  cx={at.x}
                  cy={at.y}
                  r={12}
                  fill="transparent"
                  role="button"
                  tabIndex={0}
                  aria-label={`${row.label} ${row.dot.effort}`}
                  aria-pressed={row === chosen}
                  className="outline-none"
                  onClick={() => setPicked(row.model)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    setPicked(row.model);
                  }}
                />
              </g>
            );
          })}
          {chosen && <circle cx={spot(chosen).x} cy={spot(chosen).y} r={11} fill="none" pointerEvents="none" strokeWidth={1.5} className="stroke-ink" />}
          {named.map((row) => {
            const name = names.get(row.model)!;
            return (
              <text
                key={`name-${row.model}`}
                data-mi-name={row.model}
                x={name.x}
                y={name.y}
                textAnchor={name.anchor}
                pointerEvents="none"
                className="fill-ink text-[12.5px] font-semibold"
                style={{ paintOrder: "stroke", stroke: "var(--color-panel)", strokeWidth: 4, strokeLinejoin: "round" }}
              >
                {shortLabel(row.label)}
              </text>
            );
          })}
        </svg>
      </div>
      {chosen && (
        <div data-mi-callout className="mt-1 grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg border border-hairline bg-raised px-3 py-2.5">
          <Avatar provider={chosen.provider} size={32} />
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-ink">{chosen.label}</div>
            <div className="text-[12.5px] text-ink-secondary">
              #{chosen.rank}
              {chosen.dot.effort !== "all" && ` · ${t("modelIndex.chart.effort", { effort: chosen.dot.effort })}`}
              {` · ${t("modelIndex.chart.perTask", { cost: formatCost(chosen.dot.cost!) })}`}
            </div>
          </div>
          <div className="text-right">
            <b className="block text-[18px] font-semibold tabular-nums text-ink">{valueText(chosen.dot)}</b>
            <span className="text-[12.5px] text-ink-secondary">{t("modelIndex.chart.score")}</span>
          </div>
        </div>
      )}
      <div className="pt-2.5">{chips}</div>
      <div className="pt-2.5 text-[12px] text-ink-secondary">{foot}</div>
    </div>
  );
}
