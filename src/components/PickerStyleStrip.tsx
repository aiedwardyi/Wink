import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChartSpline, Check, ChevronDown, CupSoda, Gauge, List, type LucideIcon } from "lucide-react";
import type { ModelPickerView } from "@/lib/model-picker-view";
import { PICKER_LOOKS, pickerLookSkin, type PickerLook } from "@/lib/picker-look";
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

function DialPreview() {
  return <>
    <rect className="f-ink" x="10" y="8" width="26" height="3" rx="1.5" />
    <rect className="f-dim" x="10" y="13.5" width="38" height="1.6" rx=".8" />
    <rect className="s-acc" x="10" y="17.5" width="20" height="3.6" rx="1" fill="none" strokeWidth=".7" />
    <circle className="f-face s-line" cx="48" cy="50" r="25" strokeWidth=".8" />
    <circle className="s-line" cx="48" cy="50" r="17" fill="none" strokeWidth="3" />
    <path className="s-acc" d={arc(48, 50, 17, -60, 40)} fill="none" strokeWidth="3" strokeLinecap="round" />
    <path className="s-acc" d={arc(48, 50, 22, -20, 20)} fill="none" strokeWidth="4.5" opacity=".35" />
    <rect className="f-card s-line" x="40" y="42" width="16" height="16" rx="4" strokeWidth=".8" />
    <rect className="f-acc" x="44" y="47.5" width="8" height="5" rx="1" />
    <path className="s-acc" d="M73 50H84" strokeWidth=".8" />
    {[[-15, 0.45], [-7, 0.75], [7, 0.75], [15, 0.45]].map(([turn, fade]) => (
      <rect key={turn} className="f-card s-line" x="86" y="45" width="46" height="10" rx="2" strokeWidth=".6" opacity={fade} transform={`rotate(${turn} 48 50) translate(0 ${turn! * 1.6})`} />
    ))}
    <rect className="f-card s-acc" x="84" y="44" width="50" height="12" rx="2.5" strokeWidth="1" />
    <rect className="f-ink" x="88" y="47.5" width="18" height="2" rx="1" />
    <rect className="f-dim" x="88" y="51.5" width="12" height="1.4" rx=".7" />
    <rect className="s-acc" x="125" y="47.5" width="6" height="4" rx="1" fill="none" strokeWidth=".6" />
    <rect className="f-card s-line" x="141" y="38" width="7" height="24" rx="3.5" strokeWidth=".6" />
    <rect className="s-acc" x="142.8" y="48.3" width="3.4" height="3.4" fill="none" strokeWidth=".6" />
    <rect className="s-acc" x="10" y="81" width="20" height="7" rx="1.5" fill="none" strokeWidth=".7" />
    <circle className="s-line" cx="41" cy="84.5" r="4.2" fill="none" strokeWidth="1.3" />
    <path className="s-acc" d={arc(41, 84.5, 4.2, -90, 120)} fill="none" strokeWidth="1.3" />
    <rect className="f-dim" x="49" y="83.5" width="16" height="1.6" />
    <rect className="f-ink" x="80" y="81" width="12" height="4" rx="1" />
    <rect className="f-ink" x="108" y="81" width="14" height="4" rx="1" />
    <path className="s-acc" d="M108 88.5q2-1.6 4 0t4 0t4 0" fill="none" strokeWidth=".7" />
    <path className="s-line" d="M10 94.5H150" strokeWidth=".5" />
  </>;
}

function ListPreview() {
  return <>
    <ellipse className="f-acc" cx="80" cy="48" rx="46" ry="34" opacity=".16" />
    {[10, 29, 67, 86].map((y) => <rect key={y} className="f-card s-line" x="72" y={y - 7} width="16" height="14" rx="3.5" strokeWidth=".9" opacity={y === 29 || y === 67 ? 1 : 0.6} />)}
    {[40, 59, 101, 120].map((x) => <rect key={x} className="f-card s-line" x={x - 8} y="42" width="16" height="12" rx="3.5" strokeWidth=".9" opacity={x === 59 || x === 101 ? 1 : 0.6} />)}
    <rect className="f-card s-acc" x="69" y="37" width="22" height="22" rx="5" strokeWidth="1.3" />
    <circle className="s-dim" cx="80" cy="45" r="3" fill="none" strokeWidth=".9" />
    <rect className="f-ink" x="74" y="51.5" width="12" height="2" rx="1" />
    <path className="s-acc" d="M78 4l2-2 2 2M78 93l2 2 2-2" fill="none" strokeWidth=".8" />
    {[46, 60, 74, 88, 102].map((x) => <rect key={x} className="f-card s-line" x={x} y="85" width="10" height="5" rx="1" strokeWidth=".5" />)}
  </>;
}

function ChartPreview() {
  return <>
    <rect className="f-dim" x="8" y="7" width="22" height="2" rx="1" />
    <rect className="s-line" x="92" y="4.5" width="40" height="7" fill="none" strokeWidth=".6" />
    <rect className="f-ink" x="96" y="7.2" width="22" height="1.6" />
    <rect className="f-dim" x="8" y="17" width="10" height="1.5" />
    {[0, 1, 2, 3, 4].map((i) => <rect key={i} className={i === 0 ? "f-card s-acc" : "f-card s-line"} x={8 + i * 9} y="21" width="7.5" height="7.5" rx="1" strokeWidth=".6" />)}
    <rect className="f-dim" x="8" y="33" width="12" height="1.5" />
    {[0, 1, 2, 3].map((i) => <g key={i}>
      <rect className={i === 1 ? "f-card s-acc" : "s-line"} x="8" y={37 + i * 6} width="44" height="5" fill={i === 1 ? undefined : "none"} strokeWidth=".5" />
      <rect className="f-ink" x="10" y={38.8 + i * 6} width={[16, 20, 14, 18][i]} height="1.4" opacity={i === 1 ? 1 : 0.6} />
    </g>)}
    <rect className="f-dim" x="8" y="63" width="12" height="1.5" />
    {[0, 1, 2, 3, 4].map((i) => <rect key={i} className={i <= 2 ? "f-acc" : "s-line"} x={8 + i * 9} y="67" width="7.5" height="4" fill={i <= 2 ? undefined : "none"} opacity={i <= 2 ? 0.75 : 1} strokeWidth=".5" />)}
    <rect className="f-ink" x="8" y="78" width="44" height="9" />
    <path className="s-line" d="M60 18V90H154" fill="none" strokeWidth=".6" />
    <path className="s-line" d="M60 66H154M60 42H154" strokeWidth=".4" strokeDasharray="1.5 1.5" />
    <path className="s-dim" d="M66 84L82 78L96 66L112 58L132 50L150 45" fill="none" strokeWidth=".8" />
    <path className="s-dim" d="M66 88L84 85L100 78L118 72L138 66L150 62" fill="none" strokeWidth=".8" />
    <path className="s-acc" d="M64 80L80 70L96 53L114 39L134 31L150 26" fill="none" strokeWidth="1.4" />
    {[[80, 70], [96, 53], [134, 31]].map(([x, y]) => <circle key={x} className="f-acc" cx={x} cy={y} r="1.3" />)}
    <circle className="s-acc" cx="114" cy="39" r="4.5" fill="none" strokeWidth=".7" />
    <circle className="f-acc" cx="114" cy="39" r="1.8" />
    <rect className="f-ink" x="64" y="21" width="24" height="2.6" />
    <rect className="f-dim" x="64" y="26" width="15" height="1.5" />
  </>;
}

const PACKS = [["#f6e7d8", "#8c3740"], ["#8a77a6", "#f8f0e8"], ["#4f4656", "#f8f0e8"], ["#e7c2df", "#9a5f94"], ["#f2e3a6", "#bfa95c"]];

function MachinePreview() {
  return <>
    <rect className="f-floor" x="0" y="88" width="160" height="12" />
    <rect x="16" y="5" width="128" height="88" rx="8" fill="#3b2441" />
    <rect x="16" y="5" width="128" height="26" rx="8" fill="#4f3256" opacity=".55" />
    <rect x="21" y="9" width="118" height="10" rx="3" fill="#f6dbe0" />
    <circle cx="27" cy="14" r="3" fill="#241a26" />
    <rect x="32" y="12.5" width="14" height="3" rx="1" fill="#241a26" />
    <rect x="49" y="13" width="22" height="2" rx="1" fill="#6a4660" />
    <rect x="21" y="22" width="80" height="56" rx="4" fill="#f9eee7" stroke="#2c1a32" strokeWidth="1.5" />
    {[0, 1, 2].map((row) => <g key={row}>
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const [body, band] = PACKS[(i + row * 2) % PACKS.length]!;
        const h = 9 + ((i + row) % 3);
        return <g key={i}>
          <rect x={25 + i * 12.4} y={39 + row * 17 - h} width="8.4" height={h} rx="1.6" fill={body} />
          <rect x={25 + i * 12.4} y={39 + row * 17 - h * 0.45} width="8.4" height="2.4" fill={band} />
        </g>;
      })}
      <rect x="23" y={39.5 + row * 17} width="76" height="1.3" fill="#cbb9af" />
    </g>)}
    <rect x="106" y="22" width="33" height="20" rx="3" fill="#170f18" />
    <rect x="110" y="26" width="10" height="4" rx="1" fill="#f8d5dc" />
    <rect x="110" y="33" width="22" height="2" rx="1" fill="#94738c" />
    <rect x="110" y="37" width="16" height="1.6" rx=".8" fill="#94738c" />
    {[0, 1, 2, 3, 4].map((k) => <rect key={k} x={107 + k * 6.4} y={58 - (4 + k * 2)} width="4.6" height={4 + k * 2} rx="1" fill={k <= 2 ? "#f1d98f" : "#5b3f60"} />)}
    <rect x="106" y="62" width="33" height="15" rx="4" fill="#cf4a6c" />
    <rect x="114" y="68" width="17" height="3" rx="1.5" fill="#fbf3ea" />
    <rect x="21" y="81" width="80" height="8" rx="3" fill="#2a1730" />
    <rect x="106" y="81" width="33" height="8" rx="3" fill="#fbf3ea" opacity=".9" />
  </>;
}

function SoonPreview() {
  return <>
    <rect className="s-line" x="10" y="10" width="140" height="80" rx="6" fill="none" strokeDasharray="3 3" strokeWidth=".8" />
    <circle className="f-dim" cx="80" cy="44" r="10" opacity=".4" />
    <rect className="f-dim" x="62" y="62" width="36" height="3" rx="1.5" opacity=".5" />
  </>;
}

const STYLES: ReadonlyArray<{ id: ModelPickerView; Icon: LucideIcon; Preview: () => ReactNode }> = [
  { id: "dial", Icon: Gauge, Preview: DialPreview },
  { id: "list", Icon: List, Preview: ListPreview },
  { id: "chart", Icon: ChartSpline, Preview: ChartPreview },
  { id: "machine", Icon: CupSoda, Preview: MachinePreview },
];

// Prototype only: placeholder styles show how the strip holds 10+.
const demoCount = () => {
  try {
    return Number(localStorage.getItem("omb-proto-picker-styles")) || 0;
  } catch {
    return 0;
  }
};

function Mini({ look, skin, Preview }: { look: PickerLook; skin: SkinId; Preview: () => ReactNode }) {
  return (
    <span className="pss-mini" data-look={look} data-skin={look === "dark" ? undefined : pickerLookSkin(skin, look) ?? skin} aria-hidden>
      <svg viewBox="0 0 160 100" preserveAspectRatio="xMidYMid slice"><Preview /></svg>
    </span>
  );
}

export function PickerStyleButton({ shown, open, onToggle }: { shown: ModelPickerView; open: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  const { Icon } = STYLES.find((style) => style.id === shown) ?? STYLES[0]!;
  return (
    <button type="button" className="picker-style-button" data-picker-style-button aria-haspopup="dialog" aria-expanded={open} aria-keyshortcuts="Alt+S" aria-label={`${t("model.style")}: ${t(`settings.pickerStyle.${shown}`)}`} title={`${t("model.style")} (${altKeyLabel()}+S)`} onClick={onToggle}>
      <Icon size={13} aria-hidden /><span>{t(`settings.pickerStyle.${shown}`)}</span><ChevronDown size={12} aria-hidden />
    </button>
  );
}

type StripProps = {
  shown: ModelPickerView;
  styles: readonly ModelPickerView[];
  look: PickerLook;
  followsTheme: boolean;
  skin: SkinId;
  onStyle: (style: ModelPickerView) => void;
  onLook: (look: PickerLook) => void;
};

export function PickerStyleStrip({ shown, styles, look, followsTheme, skin, onStyle, onLook }: StripProps) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const all = [
    ...STYLES.filter((style) => styles.includes(style.id)).map((style) => ({ ...style, key: style.id as string, label: t(`settings.pickerStyle.${style.id}`) })),
    ...Array.from({ length: Math.max(0, demoCount() - STYLES.length) }, (_, i) => ({ id: null, key: `soon-${i}`, label: `Style ${STYLES.length + i + 1}`, Preview: SoonPreview })),
  ];
  const front = all.slice(0, FRONT);
  const current = all.find((style) => style.id === shown);
  if (current && !front.includes(current)) front[FRONT - 1] = current;
  const tiles = more ? [...front, ...all.filter((style) => !front.includes(style))] : front;
  const Preview = STYLES.find((style) => style.id === shown)?.Preview ?? DialPreview;

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
        strip.style.setProperty("--pss-right", `${Math.max(8, Math.round(innerWidth - rect.right))}px`);
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

  const tile = (key: string, label: string, on: boolean, mini: ReactNode, pick: (() => void) | null, data: Record<string, string>) => (
    <button key={key} type="button" role="radio" aria-checked={on} aria-disabled={!pick || undefined} tabIndex={on ? 0 : -1} className="pss-tile" {...data} onClick={() => pick?.()}>
      {mini}
      <span className="pss-name"><span>{label}</span>{on && <Check size={12} aria-hidden />}</span>
    </button>
  );

  return (
    <div ref={root} className="picker-style-strip" data-picker-style-strip role="dialog" aria-label={t("model.style")} onKeyDown={onKeyDown}>
      <div className="pss-head"><span>{t("model.style")}</span><span className="pss-keys"><kbd>{altKeyLabel()}</kbd><kbd>S</kbd></span></div>
      <div className="pss-tiles" role="radiogroup" aria-label={t("model.style")}>
        {tiles.map((style) => tile(style.key, style.label, style.id === shown, <Mini look={look} skin={skin} Preview={style.Preview} />, style.id ? () => onStyle(style.id!) : null, { "data-picker-style": style.key }))}
      </div>
      {all.length > FRONT && (
        <button type="button" className="pss-more" data-picker-style-more aria-expanded={more} onClick={() => setMore(!more)}>
          {t("model.style.more", { count: all.length - FRONT })}<ChevronDown size={14} aria-hidden />
        </button>
      )}
      <div className="pss-head pss-look-head"><span>{t("model.look")}</span>{followsTheme && <small>{t("model.look.theme")}</small>}</div>
      <div className="pss-tiles" role="radiogroup" aria-label={t("model.look")}>
        {PICKER_LOOKS.map((option) => tile(option, t(`model.look.${option}`), option === look, <Mini look={option} skin={skin} Preview={Preview} />, () => onLook(option), { "data-picker-look": option }))}
      </div>
    </div>
  );
}
