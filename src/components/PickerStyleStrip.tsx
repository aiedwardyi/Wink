import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChartSpline, Check, ChevronDown, CupSoda, Gauge, List, type LucideIcon } from "lucide-react";
import type { ModelPickerView } from "@/lib/model-picker-view";
import { PICKER_LOOK_CHOICES, pickerLook, pickerLookSkin, shownPickerLook, type PickerLook, type PickerLookChoice } from "@/lib/picker-look";
import type { SkinId } from "@/lib/skins";
import { useI18n } from "@/lib/i18n";
import "./PickerStyleStrip.css";

const FRONT = 4;

export const altKeyLabel = () => /Mac/i.test(globalThis.navigator?.platform ?? "") ? "Option" : "Alt";

const pt = (cx: number, cy: number, r: number, a: number) => [cx + r * Math.cos(a * Math.PI / 180), cy + r * Math.sin(a * Math.PI / 180)].map((n) => n.toFixed(1));
const arc = (cx: number, cy: number, r: number, a0: number, a1: number) => {
  const [x0, y0] = pt(cx, cy, r, a0);
  const [x1, y1] = pt(cx, cy, r, a1);
  return `M${x0} ${y0}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
};

// One drawing set on a 160x100 grid: hairlines 1px, accents 1.5px (non-scaling), text as bars.
function DialPreview() {
  return <>
    <rect className="f-ink" x="10" y="9" width="30" height="4" rx="1" />
    <rect className="f-dim" x="10" y="16" width="40" height="2" rx="1" />
    <rect className="s-acc" x="10.5" y="21.5" width="27" height="5" rx="1.5" fill="none" />
    <circle className="s-line" cx="40" cy="56" r="25" fill="none" />
    <circle className="s-line thick" cx="40" cy="56" r="18" fill="none" strokeWidth="4" />
    <path className="s-acc thick" d={arc(40, 56, 18, -150, -30)} fill="none" strokeWidth="4" strokeLinecap="round" />
    <path className="s-acc thick" d={arc(40, 56, 22.5, -25, 25)} fill="none" strokeWidth="5" opacity=".35" />
    <rect className="f-card s-line" x="31" y="47" width="18" height="18" rx="4.5" />
    <rect className="f-acc" x="35.5" y="53.5" width="9" height="5" rx="1" />
    <path className="s-acc" d="M65 56H80" />
    {[[-26, 0.35], [-13, 0.6], [13, 0.6], [26, 0.35]].map(([dy, fade]) => (
      <g key={dy} opacity={fade}>
        <rect className="f-card s-line" x={84 + Math.abs(dy!) * 0.3} y={51 + dy!} width="48" height="10" rx="2.5" />
        <rect className="f-ink" x={89 + Math.abs(dy!) * 0.3} y={54.5 + dy!} width="16" height="3" rx="1" />
      </g>
    ))}
    <rect className="f-card s-acc" x="80" y="49" width="56" height="14" rx="3" strokeWidth="1.5" />
    <rect className="f-ink" x="86" y="52.5" width="20" height="3" rx="1" />
    <rect className="f-dim" x="86" y="58" width="14" height="2" rx="1" />
    <rect className="s-acc" x="124.5" y="53.5" width="7" height="5" rx="1.5" fill="none" />
    <rect className="f-card s-line" x="142.5" y="42.5" width="9" height="27" rx="4" />
    <rect className="s-acc" x="145" y="54" width="4" height="4" fill="none" />
    <rect className="s-acc" x="10.5" y="86.5" width="21" height="7" rx="2" fill="none" />
    <circle className="s-line" cx="43" cy="90" r="3.5" fill="none" strokeWidth="1.5" />
    <path className="s-acc" d={arc(43, 90, 3.5, -90, 100)} fill="none" strokeWidth="1.5" />
    <rect className="f-dim" x="50" y="89" width="16" height="2" rx="1" />
    <rect className="f-ink" x="84" y="88" width="12" height="4" rx="1" />
    <rect className="f-ink" x="112" y="88" width="14" height="4" rx="1" />
  </>;
}

function ListPreview() {
  const card = (x: number, y: number, w: number, h: number, fade: number, on = false) => (
    <g key={`${x}-${y}`} opacity={fade}>
      <rect className={on ? "f-card s-acc" : "f-card s-line"} x={x + 0.5} y={y + 0.5} width={w - 1} height={h - 1} rx="4" strokeWidth={on ? 1.5 : 1} />
      <circle className={on ? "s-ink" : "s-dim"} cx={x + w / 2} cy={y + h * 0.38} r="3" fill="none" />
      <rect className="f-ink" x={x + w / 2 - 6} y={y + h * 0.68} width="12" height="2" rx="1" />
    </g>
  );
  return <>
    {card(68, 10, 24, 20, 0.8)}
    {card(68, 70, 24, 20, 0.8)}
    {card(8, 41, 24, 18, 0.55)}
    {card(37, 41, 24, 18, 1, true)}
    {card(99, 41, 24, 18, 0.8)}
    {card(128, 41, 24, 18, 0.55)}
    {card(66, 36, 28, 28, 1, true)}
  </>;
}

function ChartPreview() {
  return <>
    <rect className="f-dim" x="8" y="8" width="18" height="2" rx="1" />
    {[0, 1, 2, 3, 4].map((i) => <rect key={i} className={i === 0 ? "f-card s-ink" : "f-card s-line"} x={8.5 + i * 9.6} y="14.5" width="8" height="8" rx="1" />)}
    <rect className="f-acc" x="10.5" y="17.5" width="4" height="2" />
    <rect className="f-dim" x="8" y="27" width="14" height="2" rx="1" />
    {[0, 1, 2, 3, 4].map((i) => <g key={i}>
      {i === 3 && <rect className="f-card" x="8" y={32 + i * 5.5} width="48" height="5.5" />}
      {i === 3 && <rect className="f-acc" x="8" y={32 + i * 5.5} width="1" height="5.5" />}
      <rect className="f-ink" x="11" y={34 + i * 5.5} width={[14, 14, 13, 15, 12][i]} height="1.5" rx=".75" opacity={i === 3 ? 1 : 0.6} />
      <rect className="f-dim" x="48" y={34 + i * 5.5} width="5" height="1.5" rx=".75" />
      <path className="s-line" d={`M8 ${37.5 + i * 5.5}H56`} />
    </g>)}
    <rect className="f-dim" x="8" y="64" width="14" height="2" rx="1" />
    {[0, 1, 2, 3, 4].map((i) => <g key={i}>
      <rect className={i === 2 ? "f-card s-ink" : "f-card s-line"} x={8.5 + i * 9.6} y="69.5" width="8" height="7" />
      {i <= 2 && <rect className="f-acc" x={8 + i * 9.6} y="69" width="9" height="1" />}
    </g>)}
    <rect className="f-ink" x="8" y="82" width="48" height="9" />
    <rect className="f-acc" x="66" y="8" width="5" height="3" />
    <rect className="f-dim" x="73" y="8.5" width="16" height="2" rx="1" />
    <rect className="f-ink" x="66" y="14" width="32" height="6" rx="1" />
    {[0, 1, 2].map((i) => <g key={i}>
      <rect className="f-dim" x={114 + i * 14} y="11" width="10" height="1.5" rx=".75" />
      <rect className="f-ink" x={114 + i * 14} y="15" width="11" height="4" rx="1" />
    </g>)}
    <path className="s-line" d="M66 26H152" />
    <path className="s-line" d="M68 32V91H152M68 50H152M68 72H152M90 32V91M114 32V91M138 32V91" fill="none" strokeDasharray="1 2" />
    <path className="s-line" d="M68 32V91H152" fill="none" />
    <path className="s-dim" d="M72 88L92 80L108 66L124 52L140 40L148 37" fill="none" />
    <path className="s-dim" d="M90 82L106 74L120 66L136 58L146 54" fill="none" />
    <path className="s-acc" d="M98 82L110 66L122 54L136 44" fill="none" strokeWidth="1.5" />
    {[[98, 82], [110, 66], [136, 44]].map(([x, y]) => <rect key={x} className="f-acc" x={x! - 1.5} y={y! - 1.5} width="3" height="3" />)}
    <rect className="f-ink" x="120" y="52" width="4" height="4" />
    <path className="s-ink" d="M117 52v-3h3M127 52v-3h-3M117 56v3h3M127 56v3h-3" fill="none" />
  </>;
}

const PACKS = [["#f3e3d3", "#c4573f"], ["#5a4a7a", "#f8f0e8"], ["#9a8bb8", "#f8f0e8"], ["#e7c2df", "#9a5f94"], ["#f2e3a6", "#bfa95c"]];

// The Machine keeps its own colors in every look, as the real one does.
function MachinePreview() {
  return <>
    <rect x="6" y="4" width="148" height="92" rx="8" fill="#3b2441" />
    <rect x="10" y="8" width="140" height="10" rx="3" fill="#f6dbe0" />
    <circle cx="16" cy="13" r="2.5" fill="#241a26" />
    <rect x="21" y="11.5" width="12" height="3" rx="1" fill="#241a26" />
    <rect x="36" y="12" width="20" height="2" rx="1" fill="#6a4660" />
    <rect x="114" y="12" width="18" height="2" rx="1" fill="#6a4660" />
    <rect x="135.5" y="10.5" width="11" height="5" rx="1.5" fill="none" stroke="#6a4660" />
    <rect x="10" y="22" width="92" height="62" rx="3" fill="#f9eee7" />
    {[0, 1, 2].map((row) => {
      const base = 36 + row * 20.5;
      return <g key={row}>
        {[0, 1, 2, 3, 4].map((i) => {
          const [body, band] = PACKS[(i + row * 2) % PACKS.length]!;
          const h = 9 + ((i + row) % 2) * 1.5;
          const x = 15 + i * 17.5;
          return <g key={i}>
            <rect x={x} y={base - h} width="8" height={h} rx="1.5" fill={body} />
            <rect x={x} y={base - h * 0.45} width="8" height="2" fill={band} />
          </g>;
        })}
        <rect x="10" y={base + 1} width="92" height="5" fill="#3b2441" opacity=".9" />
        {[0, 1, 2, 3, 4].map((i) => <rect key={i} x={12 + i * 17.5} y={base + 1.75} width="15" height="3.5" rx="1" fill={row === 0 && i === 3 ? "#cf4a6c" : "#fbf3ea"} />)}
      </g>;
    })}
    <rect x="106" y="22" width="44" height="26" rx="3" fill="#170f18" />
    <rect x="110" y="26" width="8" height="3" rx="1" fill="#f8d5dc" />
    {[0, 1, 2].map((i) => <rect key={i} x={110 + i * 12} y="32" width="9" height="3" rx="1" fill={i === 2 ? "#f1d98f" : "#f8d5dc"} />)}
    <path d="M112 45L120 42L128 41L136 38L144 36" fill="none" stroke="#e27a9a" />
    <circle cx="128" cy="41" r="1.5" fill="#f1d98f" />
    {[0, 1, 2, 3, 4].map((i) => <rect key={i} x={106 + i * 9.1} y="52" width="7.6" height="4" rx="1" fill={["#f2b6c8", "#f2b6c8", "#cf4a6c", "#5b3f60", "#5b3f60"][i]} />)}
    {[0, 1].map((row) => [0, 1, 2, 3, 4].map((i) => <rect key={`${row}-${i}`} x={106 + i * 9.1} y={60 + row * 7} width="7.6" height="5.5" rx="1.2" fill={(row === 0 && i === 0) || (row === 1 && i === 3) ? "#f1d98f" : "#fbf3ea"} />))}
    <rect x="106" y="76" width="44" height="9" rx="3" fill="#6a4470" />
    <rect x="117" y="79.5" width="22" height="2" rx="1" fill="#fbf3ea" />
    <rect x="10" y="88" width="56" height="5" rx="2" fill="#2a1730" />
    <rect x="31" y="89" width="9" height="3" rx="1" fill="#f3e3d3" />
    <rect x="72" y="89" width="22" height="2.5" rx="1" fill="#fbf3ea" opacity=".85" />
  </>;
}

const STYLES: ReadonlyArray<{ id: ModelPickerView; Icon: LucideIcon; Preview: () => ReactNode }> = [
  { id: "dial", Icon: Gauge, Preview: DialPreview },
  { id: "list", Icon: List, Preview: ListPreview },
  { id: "chart", Icon: ChartSpline, Preview: ChartPreview },
  { id: "machine", Icon: CupSoda, Preview: MachinePreview },
];

function Mini({ look, skin, Preview }: { look: PickerLook; skin: SkinId; Preview: () => ReactNode }) {
  return (
    <span className="pss-mini" data-look={look} data-skin={look === "dark" ? undefined : pickerLookSkin(skin, look) ?? skin} aria-hidden>
      <svg viewBox="0 0 160 100" preserveAspectRatio="xMidYMid slice"><Preview /></svg>
    </span>
  );
}

// Theme reads like an OS "Auto" appearance: dark and the theme's light look, split.
function ThemeMini({ skin, Preview }: { skin: SkinId; Preview: () => ReactNode }) {
  const light = pickerLook(skin) === "atelier" ? "atelier" : "light";
  return <span className="pss-split" aria-hidden><Mini look="dark" skin={skin} Preview={Preview} /><Mini look={light} skin={skin} Preview={Preview} /></span>;
}

export function PickerStyleButton({ shown, open, onToggle }: { shown: ModelPickerView; open: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  const { Icon } = STYLES.find((style) => style.id === shown) ?? STYLES[0]!;
  return (
    <button type="button" className="picker-style-button" data-picker-style-button data-picker-view={shown} aria-haspopup="dialog" aria-expanded={open} aria-keyshortcuts="Alt+T" aria-label={`${t("model.style")}: ${t(`settings.pickerStyle.${shown}`)}`} title={`${t("model.style")} (${altKeyLabel()}+T)`} onClick={onToggle}>
      <Icon size={13} aria-hidden /><span>{t(`settings.pickerStyle.${shown}`)}</span><ChevronDown size={12} aria-hidden />
    </button>
  );
}

export type StripTile<T extends string = string> = { id: T; label: string; mini: ReactNode };

/** One row of tiles, folded like Themes: the first few up front (the pick always among them), the rest under More. */
export function TileRow<T extends string>({ kind, title, hint, more, tiles, selected, onPick }: {
  kind: "style" | "look";
  title: string;
  hint?: ReactNode;
  more: (count: number) => string;
  tiles: readonly StripTile<T>[];
  selected: T;
  onPick: (id: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const front = tiles.slice(0, FRONT);
  const current = tiles.find((tile) => tile.id === selected);
  if (current && !front.includes(current)) front[FRONT - 1] = current;
  const shown = open ? [...front, ...tiles.filter((tile) => !front.includes(tile))] : front;
  return <>
    <div className="pss-head"><span>{title}</span>{hint}</div>
    <div className="pss-tiles" role="radiogroup" aria-label={title}>
      {shown.map((tile) => (
        <button key={tile.id} type="button" role="radio" aria-checked={tile.id === selected} tabIndex={tile.id === selected ? 0 : -1} className="pss-tile" {...{ [`data-picker-${kind}`]: tile.id }} onClick={() => onPick(tile.id)}>
          {tile.mini}
          <span className="pss-name"><span>{tile.label}</span>{tile.id === selected && <Check size={12} aria-hidden />}</span>
        </button>
      ))}
    </div>
    {tiles.length > FRONT && (
      <button type="button" className="pss-more" data-picker-more={kind} aria-expanded={open} onClick={() => setOpen(!open)}>
        {more(tiles.length - FRONT)}<ChevronDown size={14} aria-hidden />
      </button>
    )}
  </>;
}

type StripProps = {
  closing: boolean;
  shown: ModelPickerView;
  styles: readonly ModelPickerView[];
  picked: PickerLookChoice;
  skin: SkinId;
  onStyle: (style: ModelPickerView) => void;
  onLook: (look: PickerLookChoice) => void;
  /** A tile click is a commit: the pick is applied, then the strip closes. */
  onDone: () => void;
};

export function PickerStyleStrip({ closing, shown, styles, picked, skin, onStyle, onLook, onDone }: StripProps) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const look = shownPickerLook(picked, skin);
  // The Machine keeps its own colors, so looks preview on the Dial there.
  const Preview = shown === "machine" ? DialPreview : STYLES.find((style) => style.id === shown)?.Preview ?? DialPreview;

  // Follows its button: in the header, or on the Machine's sign once that view shows.
  useLayoutEffect(() => {
    let frame = 0;
    const place = () => {
      const strip = root.current;
      const dialog = strip?.closest(".model-cross-dialog");
      const button = dialog?.querySelector(".model-machine [data-picker-style-button]") ?? dialog?.querySelector(".model-cross-header [data-picker-style-button]");
      const rect = button?.getBoundingClientRect();
      if (strip && rect) {
        strip.style.setProperty("--pss-top", `${Math.round(rect.bottom + 8)}px`);
        strip.style.setProperty("--pss-right", `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`);
      }
      frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    root.current?.querySelector<HTMLElement>('[data-picker-style][aria-checked="true"]')?.focus({ preventScroll: true });
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.key === "Tab") return;
    event.stopPropagation();
    const target = event.target instanceof HTMLElement ? event.target : null;
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step && target?.matches("[role=radio]")) {
      const group = [...target.closest("[role=radiogroup]")!.querySelectorAll<HTMLElement>("[role=radio]")];
      group[(group.indexOf(target) + step + group.length) % group.length]?.focus();
      event.preventDefault();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const groups = [...root.current!.querySelectorAll<HTMLElement>("[role=radiogroup]")];
      const next = groups[groups.findIndex((group) => group.contains(target)) + (event.key === "ArrowDown" ? 1 : -1)];
      (next?.querySelector<HTMLElement>('[aria-checked="true"]') ?? next?.querySelector<HTMLElement>("[role=radio]"))?.focus();
      event.preventDefault();
    }
  };

  const styleTiles = STYLES.filter((style) => styles.includes(style.id)).map((style) => ({ id: style.id, label: t(`settings.pickerStyle.${style.id}`), mini: <Mini look={look} skin={skin} Preview={style.Preview} /> }));
  const lookTiles = PICKER_LOOK_CHOICES.map((choice) => ({
    id: choice,
    label: t(`model.look.${choice}`),
    mini: choice === "theme" ? <ThemeMini skin={skin} Preview={Preview} /> : <Mini look={choice} skin={skin} Preview={Preview} />,
  }));

  return (
    <div ref={root} className="picker-style-strip animate-pop-in" data-picker-style-strip data-closing={closing || undefined} inert={closing} role="dialog" aria-label={t("model.style")} onKeyDown={onKeyDown}>
      <TileRow kind="style" title={t("model.style")} hint={<span className="pss-keys"><kbd>{altKeyLabel()}</kbd><kbd>T</kbd></span>} more={(count) => t("model.style.more", { count })}
        tiles={styleTiles} selected={shown} onPick={(style) => { onStyle(style); onDone(); }} />
      <TileRow kind="look" title={t("model.look")} hint={picked === "theme" && <small>{t("model.look.followsTheme")}</small>} more={(count) => t("model.look.more", { count })}
        tiles={lookTiles} selected={picked} onPick={(choice) => { onLook(choice); onDone(); }} />
    </div>
  );
}
