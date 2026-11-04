// The race chart: % left burns down toward the finish line at the reset.
// Dotted line = even pace. Dashed line = where the recent pace lands.
// Markers on the floor = account switches (yours and Wink's).
// Terminal skins draw the same chart in braille, like btop.
import { useRef, type CSSProperties } from "react";
import { cn } from "@/lib/cn";
import { isTerminalSkin, useSkin } from "@/lib/skins";
import type { FxSwitch } from "./fixtures";
import { buckets, evenLeft, recentRate, startOf, usedAt, type Verdict, type Win } from "./pace";
import { useCharWidth, useEased, useWidth } from "./motion";

export type Tone = "calm" | "warm" | "out";
export const TONE_VAR: Record<Tone, string> = {
  calm: "var(--color-accent)",
  warm: "var(--color-warning)",
  out: "var(--color-danger)",
};
export const TONE_TEXT: Record<Tone, string> = { calm: "text-ink", warm: "text-warning", out: "text-danger" };

export const toneOf = (v: Verdict): Tone => (v.kind === "out" ? "out" : v.kind === "runsOut" ? "warm" : "calm");

type Labels = {
  start?: string;
  end: string;
  countdown: string;
  runOut?: string;
  topLeft?: string;
  days?: { at: number; text: string }[];
  marker: (m: FxSwitch) => string;
};

type ChartProps = {
  win: Win;
  now: number;
  verdict: Verdict;
  live: boolean;
  markers: FxSwitch[];
  size: "page" | "compact";
  labels: Labels;
  normal?: number | null;
};

const GEOMETRY = {
  page: { top: 20, plot: 112, gap: 8, vol: 24, axis: 20 },
  compact: { top: 18, plot: 84, gap: 0, vol: 0, axis: 18 },
} as const;

export function RaceChart(props: ChartProps) {
  const terminal = isTerminalSkin(useSkin());
  return terminal ? <BrailleChart {...props} /> : <SvgChart {...props} />;
}

/** History points with the tip eased toward the newest report, then held flat to now. */
function useTrace(win: Win, now: number) {
  const past = win.samples.filter((s) => s.t <= now);
  const last = past.at(-1);
  const tipUsed = useEased(last?.used ?? 0);
  const points = past.slice(0, -1).map((s) => ({ t: s.t, left: 100 - s.used }));
  if (last) points.push({ t: last.t, left: 100 - tipUsed });
  points.push({ t: Math.min(now, win.resetsAt), left: 100 - tipUsed });
  return { points, tipLeft: Math.max(0, 100 - tipUsed) };
}

function projection(win: Win, now: number, tipLeft: number, verdict: Verdict) {
  if (verdict.kind === "out" || tipLeft <= 0) return null;
  const rate = recentRate(win, now);
  if (rate <= 0) return { t: win.resetsAt, left: tipLeft };
  const hits = now + tipLeft / rate;
  return hits < win.resetsAt ? { t: hits, left: 0, out: true } : { t: win.resetsAt, left: tipLeft - rate * (win.resetsAt - now) };
}

function SvgChart({ win, now, verdict, live, markers, size, labels, normal }: ChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const g = GEOMETRY[size];
  const height = g.top + g.plot + g.gap + g.vol + g.axis;
  const tone = toneOf(verdict);
  const color = TONE_VAR[tone];
  const start = startOf(win);
  const { points, tipLeft } = useTrace(win, now);
  const easedProj = projection(win, now, tipLeft, verdict);
  const projT = useEased(easedProj?.t ?? win.resetsAt, 700);
  const projL = useEased(easedProj?.left ?? tipLeft, 700);
  const W = Math.max(width, 1);
  const x = (t: number) => 1 + ((t - start) / (win.resetsAt - start)) * (W - 2);
  const y = (left: number) => g.top + (1 - left / 100) * g.plot;
  const floor = y(0);
  const line = points.map((p) => `${x(p.t).toFixed(1)},${y(p.left).toFixed(1)}`).join(" ");
  const tip = points.at(-1)!;
  const area = `${x(points[0]!.t).toFixed(1)},${floor} ${line} ${x(tip.t).toFixed(1)},${floor}`;
  const shown = markers.filter((m) => m.at >= start - 60_000 && m.at <= win.resetsAt);
  const gradient = `desk-fill-${size}-${win.kind}`;
  const volumes = size === "page" ? buckets(win, now, win.kind === "week" ? 7 : 30) : [];
  const volMax = Math.max(win.kind === "week" ? 8 : 3, ...volumes.map((b) => b.used), (normal ?? 0) * 1.5);
  const volTop = floor + g.gap;
  const volY = (v: number) => volTop + g.vol - (v / volMax) * g.vol;
  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }}>
      {width > 0 && (
        <svg width={W} height={height} className="absolute inset-0 overflow-visible" aria-hidden="true">
          <defs>
            <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity={0.2} />
              <stop offset="1" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <line x1={0} x2={W} y1={floor + 0.5} y2={floor + 0.5} stroke="var(--color-hairline)" strokeWidth={1} />
          <line x1={W - 1.5} x2={W - 1.5} y1={g.top - 6} y2={floor} stroke="var(--color-ink-secondary)" strokeOpacity={0.45} strokeWidth={1} />
          <line x1={x(start)} y1={y(100)} x2={x(win.resetsAt)} y2={y(0)} stroke="var(--color-ink-secondary)" strokeOpacity={0.55} strokeWidth={1.4} strokeDasharray="0 5" strokeLinecap="round" />
          {shown.map((m) => (
            <line key={`m${m.at}`} x1={x(m.at)} x2={x(m.at)} y1={g.top - 2} y2={floor} stroke="var(--color-ink-secondary)" strokeOpacity={0.5} strokeWidth={1} strokeDasharray="2 3" className="desk-fade" />
          ))}
          <polygon points={area} fill={`url(#${gradient})`} />
          <polyline points={line} fill="none" stroke={color} strokeWidth={size === "page" ? 2 : 1.75} strokeLinejoin="round" strokeLinecap="round" />
          {easedProj && (
            <line x1={x(tip.t)} y1={y(tipLeft)} x2={x(projT)} y2={y(projL)} stroke={color} strokeOpacity={0.75} strokeWidth={1.5} strokeDasharray="4 4" strokeLinecap="round" />
          )}
          {easedProj?.out && <circle cx={x(projT)} cy={floor} r={3} fill="var(--color-panel)" stroke={color} strokeWidth={1.5} />}
          {live && <circle cx={x(tip.t)} cy={y(tipLeft)} r={3.5} fill={color} className="desk-pulse" />}
          <circle cx={x(tip.t)} cy={y(tipLeft)} r={size === "page" ? 3.75 : 3.25} fill={color} stroke="var(--color-panel)" strokeWidth={1.5} />
          {volumes.map((b, i) => {
            const w = Math.max(1, x(b.to) - x(b.from) - (win.kind === "week" ? 6 : 2));
            const current = b.from <= now && now < b.to;
            const top = volY(b.used);
            return b.used > 0.05 ? (
              <rect key={i} x={x(b.from) + (win.kind === "week" ? 3 : 1)} y={top} width={w} height={volTop + g.vol - top} rx={1}
                fill={current ? color : "var(--color-ink-secondary)"} fillOpacity={current ? 0.5 : 0.2} />
            ) : null;
          })}
          {volumes.length > 0 && normal != null && normal > 0 && (
            <line x1={0} x2={W} y1={volY(normal)} y2={volY(normal)} stroke="var(--color-ink-secondary)" strokeOpacity={0.6} strokeDasharray="2 3" strokeWidth={1} />
          )}
        </svg>
      )}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between text-[11px] leading-none text-ink-secondary" style={{ height: g.top - 6 }}>
        <span>{labels.topLeft}</span>
        <span className="desk-num text-ink"><span className="text-ink-secondary">↻ </span>{labels.countdown}</span>
      </div>
      {/* The time sits on the point only with room to spare; near the finish line the verdict above says it. */}
      {easedProj?.out && labels.runOut && width > 0 && x(projT) < W - 90 && (
        <span className="desk-num pointer-events-none absolute -translate-x-1/2 whitespace-nowrap text-[11px] leading-none text-warning" style={{ left: Math.max(x(projT), 40), top: floor - 16 }}>
          {labels.runOut}
        </span>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 text-[11px] leading-none text-ink-secondary" style={{ height: g.axis }}>
        {labels.days && width > 0 ? (
          labels.days.map((d, i) => (
            <span key={i} className="absolute bottom-0.5 -translate-x-1/2" style={{ left: x(d.at) }}>{d.text}</span>
          ))
        ) : (
          <>
            <span className="absolute bottom-0.5 left-0 flex items-center gap-1.5">
              {shown.filter((m) => Math.abs(x(m.at) - x(start)) < 4).map((m) => <MarkerTile key={m.at} m={m} title={labels.marker(m)} />)}
              {labels.start}
            </span>
            <span className="desk-num absolute bottom-0.5 right-0">{labels.end}</span>
          </>
        )}
      </div>
      {width > 0 && shown.filter((m) => Math.abs(x(m.at) - x(start)) >= 4).map((m) => (
        <span key={m.at} className="absolute -translate-x-1/2" style={{ left: x(m.at), top: floor - 8 }}>
          <MarkerTile m={m} title={labels.marker(m)} />
        </span>
      ))}
    </div>
  );
}

function MarkerTile({ m, title }: { m: FxSwitch; title: string }) {
  return (
    <span title={title} aria-label={title}
      className="desk-drop pointer-events-auto inline-flex size-4 items-center justify-center rounded-[4px] border border-hairline bg-panel text-[9.5px] font-semibold leading-none text-ink">
      {m.to}
    </span>
  );
}

// Braille: each glyph is a 2x4 dot cell. Layers in priority: burned area, pace dashes, even-pace dots.
const BIT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];
const LEVELS = " ▁▂▃▄▅▆▇█";

function BrailleChart({ win, now, verdict, live, markers, size, labels, normal }: ChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const box = useRef<HTMLDivElement>(null);
  const charW = useCharWidth(box);
  const rows = size === "page" ? 7 : 5;
  const cols = Math.max(12, Math.floor(width / charW));
  const tone = toneOf(verdict);
  const start = startOf(win);
  const { tipLeft } = useTrace(win, now);
  const proj = projection(win, now, tipLeft, verdict);
  const DX = cols * 2;
  const DY = rows * 4;
  // A crisp line over a light stipple, so the chart reads like the SVG one and not a solid block.
  const line = new Uint8Array(cols * rows);
  const area = new Uint8Array(cols * rows);
  const pace = new Uint8Array(cols * rows);
  const even = new Uint8Array(cols * rows);
  const set = (layer: Uint8Array, dx: number, dy: number) => {
    if (dx < 0 || dx >= DX || dy < 0 || dy >= DY) return;
    layer[Math.floor(dy / 4) * cols + Math.floor(dx / 2)]! |= BIT[dy % 4]![dx % 2]!;
  };
  const tAt = (dx: number) => start + ((dx + 0.5) / DX) * (win.resetsAt - start);
  const dotY = (left: number) => Math.round((1 - left / 100) * (DY - 1));
  let tipCol = 0;
  let prevY: number | null = null;
  for (let dx = 0; dx < DX; dx++) {
    const t = tAt(dx);
    if (dx % 3 === 0) set(even, dx, dotY(evenLeft(win, t)));
    if (t <= now) {
      const left = t > now - (win.resetsAt - start) / DX ? tipLeft : 100 - usedAt(win, t);
      const y = dotY(left);
      // Join steep drops so the line never breaks into loose dots.
      for (let dy = Math.min(prevY ?? y, y); dy <= Math.max(prevY ?? y, y); dy++) set(line, dx, dy);
      for (let dy = y + 1; dy < DY; dy++) if (dx % 2 === 0 && dy % 2 === 1) set(area, dx, dy);
      prevY = y;
      tipCol = Math.floor(dx / 2);
    } else if (proj && t <= proj.t + 1) {
      const p = tipLeft + ((proj.left - tipLeft) * (t - now)) / Math.max(1, proj.t - now);
      if (dx % 2 === 0) set(pace, dx, dotY(Math.max(0, p)));
    }
  }
  const toneClass = tone === "out" ? "text-danger" : tone === "warm" ? "text-warning" : "text-accent";
  const lines = Array.from({ length: rows }, (_, r) => {
    const cells: { text: string; cls: string }[] = [];
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const bits = line[i]! | area[i]! | pace[i]! | even[i]!;
      const cls = line[i] ? cn(toneClass, live && c === tipCol && "desk-blink")
        : area[i] ? cn(toneClass, "opacity-40")
        : pace[i] ? cn(toneClass, "opacity-70")
        : even[i] ? "text-ink-secondary opacity-60" : "";
      const ch = bits ? String.fromCharCode(0x2800 + bits) : " ";
      const prev = cells.at(-1);
      if (prev && prev.cls === cls) prev.text += ch;
      else cells.push({ text: ch, cls });
    }
    return cells;
  });
  const vol = size === "page" ? buckets(win, now, cols) : [];
  const volMax = Math.max(win.kind === "week" ? 0.6 : 0.4, ...vol.map((b) => b.used));
  const startText = labels.start ?? "";
  const endText = labels.end;
  const dash = Math.max(1, cols - startText.length - endText.length - 2);
  const shown = markers.filter((m) => m.at >= start - 60_000 && m.at <= win.resetsAt);
  const style: CSSProperties = { fontSize: size === "page" ? 13 : 12 };
  return (
    <div ref={ref} className="w-full">
      <div ref={box} className="desk-braille relative select-none" style={style} aria-hidden="true">
        <div className="flex justify-between text-[11px] text-ink-secondary" style={{ lineHeight: "16px" }}>
          <span>{labels.topLeft}</span>
          <span className="text-ink">↻ {labels.countdown}</span>
        </div>
        {lines.map((cells, r) => (
          <div key={r} style={{ lineHeight: size === "page" ? "15px" : "14px", height: size === "page" ? 15 : 14 }}>
            {cells.map((cell, k) => <span key={k} className={cell.cls}>{cell.text}</span>)}
          </div>
        ))}
        {vol.length > 0 && (
          <div style={{ lineHeight: "15px" }}>
            {vol.map((b, c) => {
              const level = b.used <= 0.02 ? 0 : Math.max(1, Math.round((b.used / volMax) * 8));
              const current = b.from <= now && now < b.to;
              return <span key={c} className={current ? toneClass : "text-ink-secondary opacity-50"}>{LEVELS[Math.min(8, level)]}</span>;
            })}
          </div>
        )}
        <div className="text-ink-secondary" style={{ lineHeight: "16px" }}>
          {shown.length > 0 && <span className="text-ink">[{shown.at(-1)!.to}] </span>}
          {startText} <span className="opacity-40">{"─".repeat(Math.max(1, dash - (shown.length ? 4 : 0)))}</span> <span className="text-ink">{endText}</span>
        </div>
        {verdict.kind === "runsOut" && labels.runOut && <span className="sr-only">{labels.runOut}</span>}
        {normal != null && <span className="sr-only">{labels.topLeft}</span>}
      </div>
    </div>
  );
}

/** Tiny line for rows and the chat ticker. Same rules as the big chart. */
export function Spark({ win, now, verdict, width = 56, height = 18, live = false, cols = 8 }: { win?: Win; now: number; verdict: Verdict; width?: number; height?: number; live?: boolean; cols?: number }) {
  const terminal = isTerminalSkin(useSkin());
  const tone = toneOf(verdict);
  const color = TONE_VAR[tone];
  if (!win) {
    if (terminal) return <span className="desk-braille text-ink-secondary opacity-50" style={{ fontSize: 12 }}>{"⠤".repeat(cols)}</span>;
    return (
      <svg width={width} height={height} aria-hidden="true" className="shrink-0">
        <line x1={1} x2={width - 1} y1={height - 1.5} y2={height - 1.5} stroke="var(--color-ink-secondary)" strokeOpacity={0.4} strokeDasharray="1 3" strokeLinecap="round" />
      </svg>
    );
  }
  const start = startOf(win);
  const past = win.samples.filter((s) => s.t <= now);
  const tipUsed = past.at(-1)?.used ?? 0;
  if (terminal) {
    const DX = cols * 2;
    const cells = new Uint8Array(cols);
    for (let dx = 0; dx < DX; dx++) {
      const t = start + ((dx + 0.5) / DX) * (win.resetsAt - start);
      if (t > now) break;
      const left = 100 - usedAt(win, t);
      const dy = Math.round((1 - left / 100) * 3);
      for (let k = dy; k < 4; k++) cells[Math.floor(dx / 2)]! |= BIT[k]![dx % 2]!;
    }
    const text = Array.from(cells, (b) => (b ? String.fromCharCode(0x2800 + b) : "⠀")).join("");
    const cls = tone === "out" ? "text-danger" : tone === "warm" ? "text-warning" : "text-accent";
    return <span className={cn("desk-braille", cls)} style={{ fontSize: 12 }} aria-hidden="true">{text}</span>;
  }
  const x = (t: number) => 1 + ((t - start) / (win.resetsAt - start)) * (width - 2.5);
  const y = (left: number) => 2 + (1 - left / 100) * (height - 4);
  const pts = past.map((s) => `${x(s.t).toFixed(1)},${y(100 - s.used).toFixed(1)}`);
  pts.push(`${x(Math.min(now, win.resetsAt)).toFixed(1)},${y(100 - tipUsed).toFixed(1)}`);
  const tipX = x(Math.min(now, win.resetsAt));
  const tipY = y(100 - tipUsed);
  return (
    <svg width={width} height={height} aria-hidden="true" className="shrink-0 overflow-visible">
      <line x1={x(start)} y1={y(100)} x2={x(win.resetsAt)} y2={y(0)} stroke="var(--color-ink-secondary)" strokeOpacity={0.45} strokeDasharray="0 3" strokeLinecap="round" />
      <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} stroke="var(--color-hairline)" />
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      {live && <circle cx={tipX} cy={tipY} r={2.25} fill={color} className="desk-pulse" />}
      <circle cx={tipX} cy={tipY} r={2.25} fill={color} />
    </svg>
  );
}
