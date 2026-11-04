import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { ChartSeries, Point, Projection } from "@/lib/usage-pace";

const W = 1000;
const BLOCKS = "▁▂▃▄▅▆▇█";
// Braille dot bits by [row][column] inside one 2x4 cell.
const DOTS = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];

let brailleOk: boolean | undefined;
/** Braille glyphs that render narrower or wider than the mono cell fall back to block glyphs. */
export function brailleFits(): boolean {
  if (brailleOk !== undefined) return brailleOk;
  const context = typeof document === "undefined" ? null : document.createElement("canvas").getContext?.("2d");
  if (!context) return (brailleOk = true);
  context.font = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim()
    ? `12px ${getComputedStyle(document.documentElement).getPropertyValue("--font-mono")}` : "12px monospace";
  const cell = context.measureText("M").width;
  brailleOk = cell > 0 && Math.abs(context.measureText("⣿").width - cell) / cell < 0.1;
  return brailleOk;
}

export type ChartTone = "ok" | "warn" | "out";
const STROKE: Record<ChartTone, string> = { ok: "var(--color-accent)", warn: "var(--color-warning)", out: "var(--color-danger)" };

type Scale = { x: (at: number) => number; y: (used: number) => number };
const scaleOf = (series: ChartSeries, top: number, bottom: number): Scale => ({
  x: (at) => ((at - series.start) / Math.max(1, series.end - series.start)) * W,
  y: (used) => top + (Math.min(100, Math.max(0, used)) / 100) * (bottom - top),
});
const pathOf = (segments: Point[][], scale: Scale) => segments.map((segment) =>
  segment.map((point, i) => `${i ? "L" : "M"}${scale.x(point.at).toFixed(1)} ${scale.y(point.used).toFixed(1)}`).join(" ")).join(" ");
const projected = (projection: Projection, at: number) => projection.from.used + projection.rate * (at - projection.from.at);

function brailleRows(series: ChartSeries, projection: Projection | null, cols: number, rows: number): string[] {
  const grid = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  const dot = (x: number, used: number) => {
    const dx = Math.min(cols * 2 - 1, Math.max(0, Math.round((x / W) * (cols * 2 - 1))));
    const dy = Math.min(rows * 4 - 1, Math.max(0, Math.round((used / 100) * (rows * 4 - 1))));
    grid[Math.floor(dy / 4)]![Math.floor(dx / 2)]! |= DOTS[dy % 4]![dx % 2]!;
  };
  const scale = scaleOf(series, 0, 100);
  for (const segment of series.segments) for (let i = 0; i < segment.length; i += 1) {
    const a = segment[i]!;
    const b = segment[i + 1] ?? a;
    const steps = Math.max(1, Math.ceil(((scale.x(b.at) - scale.x(a.at)) / W) * cols * 2));
    for (let s = 0; s <= steps; s += 1) dot(scale.x(a.at + ((b.at - a.at) * s) / steps), a.used + ((b.used - a.used) * s) / steps);
  }
  if (projection) for (let s = 0; s <= cols; s += 2) {
    const at = projection.from.at + ((projection.until - projection.from.at) * s) / cols;
    dot(scale.x(at), projected(projection, at));
  }
  return grid.map((row) => row.map((bits) => String.fromCharCode(0x2800 + bits)).join(""));
}

function blockRow(series: ChartSeries, cols: number): string {
  const cells = new Array<string>(cols).fill(" ");
  const scale = scaleOf(series, 0, 100);
  for (const point of series.segments.flat()) {
    const col = Math.min(cols - 1, Math.max(0, Math.floor((scale.x(point.at) / W) * cols)));
    cells[col] = BLOCKS[Math.round(((100 - point.used) / 100) * (BLOCKS.length - 1))]!;
  }
  return cells.join("");
}

/** The finish-line chart: % left from 100 at the top to 0 at the bottom, actual samples solid, the estimate dashed, quota bars below. */
export function UsageChart({ series, projection, tone, finish, caption, topLeft, terminal, compact = false }: {
  series: ChartSeries;
  projection: Projection | null;
  tone: ChartTone;
  finish?: string;
  caption: string;
  topLeft?: ReactNode;
  terminal: boolean;
  compact?: boolean;
}) {
  const points = series.segments.reduce((count, segment) => count + segment.length, 0);
  const maxBar = Math.max(5, ...series.bars.map((bar) => bar.used));
  const labels = (
    <>
      <span className="absolute left-0 top-0 text-[11px] leading-none text-ink-secondary">100%</span>
      {topLeft && <span className="absolute left-10 top-0 text-[11px] leading-none text-ink-secondary">{topLeft}</span>}
      {finish && <span className="absolute right-0 top-0 text-[11px] leading-none text-ink-secondary">{finish}</span>}
    </>
  );
  if (terminal) {
    const cols = compact ? 28 : 44;
    const braille = brailleFits();
    const lines = braille ? brailleRows(series, projection, cols, compact ? 3 : 4) : [blockRow(series, cols)];
    const bars = series.bars.length ? series.bars.map((bar) => BLOCKS[Math.round((bar.used / maxBar) * (BLOCKS.length - 1))]).join("") : "";
    return (
      <div data-usage-chart="" data-glyphs={braille ? "braille" : "block"} className="relative min-w-0 pt-4 text-ink-secondary">
        {labels}
        <div data-trace="" data-points={points} aria-hidden="true" className="usage-glyphs overflow-hidden" style={{ color: STROKE[tone] }}>
          {lines.map((line, i) => <div key={i}>{line}</div>)}
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-2 text-[11px]">
          <span>0%</span>
          <span aria-hidden="true" className="usage-glyphs">{bars}</span>
          <span>{caption}</span>
        </div>
      </div>
    );
  }
  const height = compact ? 96 : 140;
  const plotBottom = height - 30;
  const scale = scaleOf(series, 16, plotBottom);
  const trace = pathOf(series.segments, scale);
  const last = series.segments.at(-1)?.at(-1);
  return (
    <div data-usage-chart="" className="relative min-w-0" style={{ height: height + 14 }}>
      {labels}
      <svg aria-hidden="true" className="absolute inset-x-0 top-0 w-full overflow-visible" style={{ height }} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none">
        <line x1={0} x2={W} y1={plotBottom} y2={plotBottom} stroke="var(--color-hairline)" vectorEffect="non-scaling-stroke" />
        {finish && <line x1={W} x2={W} y1={12} y2={height} stroke="var(--color-ink-secondary)" strokeOpacity={0.5} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />}
        {series.marks.map((mark) => <line key={`${mark.kind}${mark.at}`} x1={scale.x(mark.at)} x2={scale.x(mark.at)} y1={12} y2={plotBottom}
          stroke={mark.kind === "limit" ? "var(--color-danger)" : "var(--color-ink-secondary)"} strokeOpacity={0.45} strokeDasharray="1 3" vectorEffect="non-scaling-stroke" />)}
        {series.bars.map((bar) => {
          const x = scale.x(bar.at);
          const w = Math.max(2, scale.x(bar.at + bar.width) - x - 4);
          const h = (bar.used / maxBar) * 22;
          return <rect key={bar.at} x={x + 2} width={w} y={height - h} height={h} fill="var(--color-ink-secondary)" fillOpacity={0.25} />;
        })}
        {trace && <path data-trace="" data-points={points} d={trace} fill="none" stroke={STROKE[tone]} strokeWidth={1.75} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
        {projection && <path data-projection="" fill="none" stroke={STROKE[tone]} strokeWidth={1.5} strokeDasharray="4 4" strokeOpacity={0.7} vectorEffect="non-scaling-stroke"
          d={`M${scale.x(projection.from.at)} ${scale.y(projection.from.used)} L${scale.x(projection.until)} ${scale.y(projected(projection, projection.until))}`} />}
        {last && <circle cx={scale.x(last.at)} cy={scale.y(last.used)} r={3} fill={STROKE[tone]} vectorEffect="non-scaling-stroke" />}
      </svg>
      <span className="absolute left-0 text-[11px] leading-none text-ink-secondary" style={{ top: plotBottom - 12 }}>0%</span>
      <span className="absolute inset-x-0 bottom-0 text-center text-[11px] leading-none text-ink-secondary">{caption}</span>
    </div>
  );
}

/** A row's tiny trace of % left; glyphs on terminal skins. */
export function UsageSpark({ series, tone, terminal }: { series: ChartSeries | null; tone: ChartTone; terminal: boolean }) {
  if (!series || series.segments.length === 0) return <span aria-hidden="true" className="w-12 shrink-0" />;
  if (terminal) return <span aria-hidden="true" className={cn("usage-glyphs w-12 shrink-0 overflow-hidden")} style={{ color: STROKE[tone] }}>
    {brailleFits() ? brailleRows(series, null, 6, 1)[0] : blockRow(series, 6)}
  </span>;
  const scale = scaleOf(series, 2, 16);
  return (
    <svg aria-hidden="true" className="h-[18px] w-12 shrink-0" viewBox={`0 0 ${W} 18`} preserveAspectRatio="none">
      <path d={pathOf(series.segments, scale)} fill="none" stroke={STROKE[tone]} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
