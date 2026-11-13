import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Lock, X } from "lucide-react";
import type { ModelSelection } from "@/state/store";
import { pickerModels, selectPickerEffort, selectPickerModel, withPickerEffort, type PickerRow } from "@/lib/cross-model-picker";
import { dialShift, dialStep } from "@/lib/model-dial";
import { modelEffortLabel } from "@/lib/model-chip";
import { formatCost } from "@/lib/model-index";
import { reducedMotion } from "@/lib/phone-swipe";
import { useI18n } from "@/lib/i18n";
import { MODEL_INDEX_AS_OF } from "../../shared/model-index-data.ts";
import { ProviderMark } from "./ProviderIcons";
import { needsCli, needsSignIn } from "./EngineSetup";
import { charted, lineOf, locate, type Line, type Stop } from "./ModelChart";
import { clunk } from "./model-machine-sound";
import { altKeyLabel } from "./PickerStyleStrip";
import "./ModelMachine.css";

const LEVELS = ["low", "medium", "high", "xhigh", "max"];
const EFFORTS = ["none", "minimal", ...LEVELS, "ultra"];
const rank = (level: string) => EFFORTS.includes(level) ? EFFORTS.indexOf(level) : EFFORTS.length;
const LETTERS = "ABCDEFGHI";
const DROP_MS = 570;
// The can lands in the tray halfway through its 620 ms bounce.
const LAND_MS = DROP_MS + 320;
const VEND_MS = 1300;
const INK = "#241a26";
const CREAM = "#fbf3ea";

type Pack = "can" | "bottle" | "carton" | "pouch" | "box";
type Paint = { body: [string, string]; accent: [string, string] };
const PACKS: Partial<Record<string, Pack>> = { claudeAgent: "can", codex: "bottle", grokAgent: "carton", antigravityAgent: "pouch", geminiAgent: "pouch", museAgent: "box" };
// Weakest to strongest; stronger models get the darker end.
const PAINT = {
  can: { body: ["#f6e7d8", "#f6e7d8"], accent: ["#e2b5b3", "#8c3740"] },
  bottle: { body: ["#c9bddb", "#574670"], accent: ["#6f5e88", "#2f2440"] },
  carton: { body: ["#655c6b", "#2e2733"], accent: ["#8f8695", "#5d5463"] },
  pouch: { body: ["#ecd1e6", "#d7a3cb"], accent: ["#b98bb4", "#9a5f94"] },
  box: { body: ["#f6edc8", "#ecdb96"], accent: ["#d8c88f", "#bfa95c"] },
} satisfies Record<Pack, Paint>;
// Where the lab mark sits on each package, in the 100x150 art box.
const MARK = { can: [31, 40, 38], bottle: [35, 75, 30], carton: [35, 67, 30], pouch: [35, 65, 30], box: [29, 54, 30] } satisfies Record<Pack, [number, number, number]>;

const mix = (a: string, b: string, t: number) => "#" + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, "0")).join("");
const best = (line: Line) => Math.max(0, ...line.stops.map((stop) => stop.score ?? 0));
const levelOf = (stop: Stop | undefined) => stop?.option ? stop.label : undefined;

type Product = { line: Line; pack: Pack; size: number; body: string; accent: string; text: string; code: string; lab: number; slot: number };

function stock(rows: PickerRow[], lines: Line[]): Product[] {
  const top = Math.max(1, ...lines.map(best));
  return rows.flatMap((row, lab) => {
    const mine = lines.filter((line) => line.row.instance === row.instance);
    const ranked = [...mine].sort((a, b) => best(b) - best(a));
    const pack = PACKS[row.instance.driverKind] ?? "can";
    return mine.map((line, slot) => {
      const t = mine.length > 1 ? 1 - ranked.indexOf(line) / (mine.length - 1) : 1;
      const words = line.name.split(/\s+/);
      return {
        line, pack, lab, slot,
        size: 0.74 + 0.26 * Math.min(1, best(line) / top),
        body: mix(PAINT[pack].body[0], PAINT[pack].body[1], t),
        accent: mix(PAINT[pack].accent[0], PAINT[pack].accent[1], t),
        text: (line.tag || (pack === "can" ? line.name : words[words.length - 1]!)).toUpperCase(),
        code: `${LETTERS[lab] ?? "?"}${slot + 1}`,
      };
    });
  });
}

// Rows of six or fewer slots; a lab with four or more models gets its own shelf.
function shelves(rows: PickerRow[]): number[][] {
  const out: Array<{ labs: number[]; n: number; big: boolean }> = [];
  rows.forEach((row, lab) => {
    const n = row.cells.length;
    const last = out[out.length - 1];
    if (!last || last.big || n >= 4 || last.n + n > 6) out.push({ labs: [lab], n, big: n >= 4 });
    else { last.labs.push(lab); last.n += n; }
  });
  return out.map((shelf) => shelf.labs);
}

function Art({ product }: { product: Product }) {
  const { pack, body: b, accent: a, text } = product;
  const label = (x: number, y: number, fill: string) => <text className="vm-ptext" x={x} y={y} textAnchor="middle" fill={fill}>{text}</text>;
  const [mx, my, ms] = MARK[pack];
  return (
    <span className="vm-art">
      <svg viewBox="0 0 100 150" aria-hidden>
        {pack === "can" && <>
          <rect x="15" y="6" width="70" height="140" rx="13" fill={b} /><rect x="15" y="6" width="70" height="12" rx="6" fill="#cbb9af" /><rect x="15" y="135" width="70" height="11" rx="5.5" fill="#cbb9af" />
          <rect x="15" y="98" width="70" height="27" fill={a} />{label(50, 115.5, CREAM)}<rect x="22" y="23" width="5" height="106" rx="2.5" fill="#fff" opacity=".6" />
        </>}
        {pack === "bottle" && <>
          <rect x="38" y="3" width="24" height="13" rx="3.5" fill={a} /><path d="M42 15h16v12c0 13 24 15 24 37v72a10 10 0 0 1-10 10H28a10 10 0 0 1-10-10V64c0-22 24-24 24-37z" fill={b} />
          <rect x="18" y="70" width="64" height="58" fill={CREAM} />{label(50, 121, INK)}<path d="M26 68v68" stroke="#fff" strokeWidth="4" strokeLinecap="round" opacity=".3" />
        </>}
        {pack === "carton" && <>
          <rect x="35" y="4" width="30" height="14" rx="2" fill={a} /><path d="M16 48 35 17h30l19 31z" fill={a} /><path d="M16 48 35 17h13L33 48z" fill="#fff" opacity=".12" /><rect x="16" y="47" width="68" height="99" rx="3" fill={b} />
          <rect x="25" y="61" width="50" height="70" rx="5" fill={CREAM} />{label(50, 121, INK)}
        </>}
        {pack === "pouch" && <>
          <path d="M24 9h52l-3 16c19 26 21 85 12 121H15C6 110 8 51 27 25z" fill={b} /><rect x="23" y="5" width="54" height="10" rx="2.5" fill={a} />
          <circle cx="50" cy="80" r="26" fill={CREAM} />{label(50, 130, INK)}<path d="M24 46c-7 22-7 62-2 90" stroke="#fff" strokeWidth="4" strokeLinecap="round" fill="none" opacity=".4" />
        </>}
        {pack === "box" && <>
          <path d="M12 27 24 15h64L76 27z" fill="#fdf6dc" /><path d="M76 27 88 15v119l-12 12z" fill={a} /><rect x="12" y="27" width="64" height="119" fill={b} />
          <rect x="20" y="45" width="48" height="64" rx="5" fill={CREAM} />{label(44, 130, INK)}
        </>}
      </svg>
      <span className="vm-mark" style={{ left: `${mx}%`, top: `${my / 1.5}%`, width: `${ms}%` }}><ProviderMark driverKind={product.line.row.instance.driverKind} size={24} /></span>
    </span>
  );
}

// A wire spiral seen from the front: loops behind the can are dimmer than the ones in front.
function Coil() {
  const loops = [0, 1, 2, 3, 4];
  return (
    <svg className="vm-coil" viewBox="0 0 100 16" preserveAspectRatio="none" aria-hidden>
      {loops.map((k) => <path key={`b${k}`} className="vm-wire-back" d={`M${4 + k * 19} 8a9.5 6 0 0 1 19 0`} />)}
      {loops.map((k) => <path key={`f${k}`} className="vm-wire" d={`M${4 + k * 19} 8a9.5 6 0 0 0 19 0`} />)}
    </svg>
  );
}

const PX = (cost: number) => 26 + ((Math.log10(cost) + 2) / (Math.log10(40) + 2)) * 250;
const PY = (score: number) => 98 - ((score - 5) / 63) * 86;
const at = (stop: Stop | undefined) => charted(stop) ? [PX(stop!.cost!), PY(stop!.score!)] as const : null;
const f1 = (n: number) => n.toFixed(1);

type Vend = { key: string; from?: Product; was: string; to: Product; landed: boolean; fall: number };

type ModelMachineProps = {
  rows: PickerRow[];
  draft: ModelSelection;
  current: ModelSelection;
  canCommit: (selection: ModelSelection) => boolean;
  onDraft: (next: ModelSelection) => void;
  onSave: (next?: ModelSelection, fromKeyboard?: boolean, closeDelay?: number) => boolean;
  onClose: () => void;
  corner?: ReactNode;
  children?: ReactNode;
};

export default function ModelMachine({ rows, draft, current, canCommit, onDraft, onSave, onClose, corner, children }: ModelMachineProps) {
  const { t } = useI18n();
  const lines = useMemo(() => pickerModels(rows).map(lineOf), [rows]);
  const products = useMemo(() => stock(rows, lines), [rows, lines]);
  const { line, stop, level } = locate(lines, draft);
  const cur = products.find((product) => product.line === line);
  const now = locate(lines, withPickerEffort(rows.find((row) => row.instance.instanceId === current.instanceId)?.instance, current));
  const nowProduct = products.find((product) => product.line === now.line);
  const locked = (row: PickerRow) => needsCli(row.instance) || needsSignIn(row.instance);
  const same = Boolean(line && line === now.line && level === now.level);
  const pickable = canCommit(draft);
  const [vend, setVend] = useState<Vend | null>(null);
  const [pressed, setPressed] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const glass = useRef<HTMLElement>(null);
  const audio = useRef<AudioContext | null>(null);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    root.current?.focus();
    return () => {
      timers.current.forEach(clearTimeout);
      const ctx = audio.current;
      // Let a landing clunk finish when the picker closes on PICK.
      if (ctx) window.setTimeout(() => void ctx.close().catch(() => undefined), 1200);
    };
  }, []);
  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)); };

  const stopFor = (product: Product) => product === cur ? stop : locate([product.line], selectPickerModel(product.line.row.instance, product.line.key, draft)).stop;
  const priceOf = (product: Product) => {
    const cost = stopFor(product)?.cost;
    return cost == null ? "-" : formatCost(cost);
  };
  const go = (product: Product | undefined) => { if (product && !vend && product !== cur) onDraft(selectPickerModel(product.line.row.instance, product.line.key, draft)); };
  const goLab = (lab: number) => {
    if (!rows[lab] || lab === cur?.lab) return;
    const mine = products.filter((product) => product.lab === lab);
    go(mine[cur?.slot ?? 0] ?? mine[0]);
  };
  const goNum = (n: number) => go(products.find((product) => product.lab === (cur?.lab ?? 0) && product.slot === n - 1));
  const effort = (option: Stop["option"]) => { if (option && !vend) onDraft(selectPickerEffort(draft, option)); };
  const flash = (id: string) => { setPressed(id); later(() => setPressed((value) => value === id ? null : value), 110); };

  const sound = (when: number) => {
    try {
      audio.current ??= new AudioContext();
      clunk(audio.current, audio.current.currentTime + when / 1000);
    } catch {
      // No audio device: the machine still vends.
    }
  };

  const pick = (fromKeyboard = false) => {
    if (vend || !cur || !pickable) return;
    if (same) { onSave(draft, fromKeyboard); return; }
    if (reducedMotion()) {
      sound(0);
      onSave(draft, fromKeyboard);
      return;
    }
    const slot = [...(root.current?.querySelectorAll("[data-machine-slot]") ?? [])].find((el) => el.getAttribute("data-machine-slot") === cur.line.key);
    const prod = slot?.querySelector(".vm-prod")?.getBoundingClientRect();
    const fall = Math.round((glass.current?.getBoundingClientRect().bottom ?? 400) - (prod?.top ?? 0) + 24);
    if (!onSave(draft, fromKeyboard, VEND_MS)) return;
    sound(LAND_MS);
    setVend({ key: cur.line.key, from: nowProduct, was: effortText(now.stop), to: cur, landed: false, fall });
    later(() => setVend((value) => value && { ...value, landed: true }), DROP_MS);
  };

  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Modified keys belong to the picker: Alt+M closes it, Alt+Shift+M toggles the machine.
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const k = event.key;
    const target = event.target instanceof HTMLElement ? event.target : null;
    // Setup controls keep their native keys; Enter on a local option still commits through the picker.
    if (target?.closest(".vm-setup") && k !== "Escape" && k !== "Tab") {
      if (!(k === "Enter" && target.closest("[data-custom-option]"))) event.stopPropagation();
      return;
    }
    event.stopPropagation();
    const letter = k.length === 1 ? LETTERS.toLowerCase().indexOf(k.toLowerCase()) : -1;
    if (k === "Escape") onClose();
    else if (k === "Tab") {
      const all = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), a[href]') ?? [])];
      const i = all.indexOf(document.activeElement as HTMLElement);
      all[event.shiftKey ? (i <= 0 ? all.length - 1 : i - 1) : (i + 1) % all.length]?.focus();
    } else if (letter >= 0 && letter < rows.length) { flash(`lab${letter}`); goLab(letter); }
    else if (/^[1-9]$/.test(k)) { flash(`n${k}`); goNum(Number(k)); }
    else if (k === "ArrowLeft" || k === "ArrowRight") { if (!vend) onDraft(dialShift(rows, draft, k === "ArrowLeft" ? -1 : 1)); }
    else if (k === "ArrowUp" || k === "ArrowDown") { if (!vend) onDraft(dialStep(rows, draft, k === "ArrowUp" ? -1 : 1)); }
    else if (k === "Enter") {
      if (target?.closest("[data-machine-close]")) return;
      flash("pick");
      pick(true);
    } else return;
    event.preventDefault();
  };

  const effortText = (s: Stop | undefined) => s?.option ? modelEffortLabel(s.label, t) : "";
  const tray = vend ? (vend.landed ? vend.to : vend.from) : nowProduct;
  const trayEffort = vend ? (vend.landed ? effortText(stop) : vend.was) : effortText(now.stop);
  const msg = vend ? t(vend.landed ? "model.machine.enjoy" : "model.machine.vending", { code: vend.to.code })
    : same ? t("model.machine.same") : cur ? t("model.machine.ready", { code: cur.code }) : "";
  const here = at(stop);
  const trail = line ? line.stops.map(at).filter((p) => p !== null) : [];
  const maxSlots = Math.max(1, ...rows.map((row) => row.cells.length));
  const fullName = (product: Product) => product.line.name + (product.line.tag ? ` ${product.line.tag}` : "");
  const tagName = (product: Product) => product.line.tag || product.line.name.replace(/^(Gemini|Meta)\s+/, "");
  const selLevel = levelOf(stop);
  const levels = [...new Set([...LEVELS, ...(line?.stops.flatMap((s) => s.option ? [s.label] : []) ?? [])])].sort((a, b) => rank(a) - rank(b));

  return (
    <div ref={root} className="model-machine" tabIndex={-1} onKeyDown={onKey}>
      <div className="vm-machine">
        <header className="vm-sign" data-wink={vend ? "" : undefined}>
          <svg className="vm-face" viewBox="0 0 30 30" aria-hidden>
            <circle cx="15" cy="15" r="13.5" fill={INK} />
            <circle className="vm-eye" cx="10.2" cy="12.4" r="2.1" fill="#fbe3e6" />
            <path d="M16.6 12.9q3 -2.6 6 0" fill="none" stroke="#fbe3e6" strokeWidth="2" strokeLinecap="round" />
            <path d="M9.4 18.6q5.6 5 11.2 0" fill="none" stroke="#fbe3e6" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <b>{t("model.machine.brand")}</b><i /><h2>{t("model.machine.title")}</h2>
          <em>{t("model.machine.stock", { labs: rows.length, models: lines.length })}</em>
          {corner}
          <button type="button" className="vm-close" data-machine-close aria-label={t("createBot.cancel")} onClick={onClose}><X size={16} /></button>
        </header>

        <section ref={glass} className="vm-glass" aria-label={t("model.engineAxis")}>
          {shelves(rows).map((labs) => (
            <div key={labs.join()} className="vm-shelf" data-busy={labs.includes(vend?.to.lab ?? -1) || undefined}>
              {labs.map((lab) => {
                const row = rows[lab]!;
                const mine = products.filter((product) => product.lab === lab);
                return (
                  <div key={row.instance.instanceId} className="vm-sec" data-on={lab === cur?.lab || undefined} data-locked={locked(row) || undefined} style={{ "--n": mine.length } as CSSProperties}>
                    <button type="button" tabIndex={-1} className="vm-pill" aria-label={locked(row) ? `${row.label}, ${t("model.signInRequired")}` : row.label} onClick={() => goLab(lab)}>
                      <b>{LETTERS[lab]}</b><ProviderMark driverKind={row.instance.driverKind} size={14} /><span>{row.label}</span>
                      {locked(row) && <Lock size={11} aria-hidden />}
                    </button>
                    <div className="vm-slots">
                      {mine.map((product) => {
                        const on = product === cur;
                        const vending = vend?.key === product.line.key;
                        return (
                          <button
                            key={product.line.key}
                            type="button"
                            className="vm-slot"
                            data-machine-slot={product.line.key}
                            data-on={on || undefined}
                            data-inuse={product === nowProduct || undefined}
                            data-vend={vending && !vend.landed ? "" : undefined}
                            data-restock={vending && vend.landed ? "" : undefined}
                            aria-pressed={on}
                            aria-label={`${product.code} ${fullName(product)}, ${priceOf(product)}`}
                            tabIndex={on ? 0 : -1}
                            style={{ "--s": product.size.toFixed(3), "--spin": `${(product.slot % 2 ? -1 : 1) * (16 + product.slot * 5)}deg`, "--fall": `${vending ? vend.fall : 400}px` } as CSSProperties}
                            onClick={() => go(product)}
                            onDoubleClick={() => { if (on) pick(); }}
                          >
                            <span className="vm-stand"><Coil /><span className="vm-prod"><Art product={product} /></span></span>
                            <span className="vm-tag"><span className="vm-nm">{tagName(product)}</span><span className="vm-meta"><span className="vm-cd">{product.code}</span><span className="vm-pr" key={priceOf(product)}>{priceOf(product)}</span></span></span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </section>

        <section className="vm-tray">
          <div className="vm-bin" data-shake={vend?.landed || undefined}>
            {tray && <div key={vend?.landed ? "in" : "was"} className="vm-item" data-out={(vend && !vend.landed) || undefined} data-land={vend?.landed || undefined}><Art product={tray} /></div>}
            <div className="vm-flap" data-swing={vend?.landed || undefined}>{t("model.machine.push")}</div>
          </div>
          <div className="vm-now" data-machine-now aria-live="polite">
            <small>{t("model.machine.inChat")}</small>
            <b>{tray ? fullName(tray) : current.model}</b>
            {tray && <span><ProviderMark driverKind={tray.line.row.instance.driverKind} size={14} />{tray.line.row.label}{trayEffort && ` · ${trayEffort}`}</span>}
          </div>
        </section>

        <div className="vm-panel">
          <section className="vm-disp">
            <div className="vm-top"><span className="vm-code" key={cur?.code}>{cur?.code ?? "--"}</span>{line && <span className="vm-lab"><ProviderMark driverKind={line.row.instance.driverKind} size={18} /><span>{line.row.label}</span></span>}</div>
            <div className="vm-name" key={line?.key}>{cur ? fullName(cur) : draft.model}</div>
            <dl className="vm-stats">
              <div><dd key={`i${stop?.score}`}>{stop?.score != null ? f1(stop.score) : "-"}</dd><u><i style={{ width: `${(stop?.score ?? 0) / 0.7}%` }} /></u><dt>{t("modelIndex.index.intelligence")}</dt></div>
              <div><dd key={`c${stop?.coding}`}>{stop?.coding != null ? f1(stop.coding) : "-"}</dd><u><i style={{ width: `${(stop?.coding ?? 0) / 0.7}%` }} /></u><dt>{t("modelIndex.index.coding")}</dt></div>
              <div className="vm-cost"><dd key={`p${stop?.cost}`}>{stop?.cost != null ? formatCost(stop.cost) : "-"}</dd><dt>{t("model.chart.perTask")}</dt></div>
            </dl>
            <svg className="vm-plot" viewBox="0 0 284 122" role="img" aria-label={t("model.chart.aria")}>
              {[20, 40, 60].map((v) => <g key={v}><path className="vm-grid" d={`M26 ${f1(PY(v))}H280`} /><text x="20" y={f1(PY(v) + 3)} textAnchor="end">{v}</text></g>)}
              {([[0.01, "1¢"], [0.1, "10¢"], [1, "$1"], [10, "$10"]] as const).map(([v, label]) => <text key={v} x={f1(PX(v))} y="114" textAnchor="middle">{label}</text>)}
              {products.map((product) => {
                if (product === cur) return null;
                const p = at(stopFor(product)) ?? product.line.stops.map(at).find(Boolean);
                return p ? <g key={product.line.key} className="vm-dot" onClick={() => go(product)}>
                  <title>{`${product.code} ${fullName(product)}`}</title>
                  <circle cx={f1(p[0])} cy={f1(p[1])} r="9" fill="transparent" /><circle className="vm-pt" cx={f1(p[0])} cy={f1(p[1])} r="3.1" />
                  {product === nowProduct && <circle className="vm-used" cx={f1(p[0])} cy={f1(p[1])} r="6" />}
                </g> : null;
              })}
              {trail.length > 1 && <path className="vm-trail" d={"M" + trail.map((p) => `${f1(p[0])} ${f1(p[1])}`).join("L")} />}
              {trail.map((p, k) => <circle key={k} className="vm-step" cx={f1(p[0])} cy={f1(p[1])} r="2.3" />)}
              {here && <><circle className="vm-halo" cx={f1(here[0])} cy={f1(here[1])} r="11" /><circle className="vm-here" cx={f1(here[0])} cy={f1(here[1])} r="5.4" /></>}
            </svg>
            <div className="vm-msg" data-hot={vend ? "" : undefined}>{msg}</div>
          </section>

          <section className="vm-block">
            <h3>{t("model.effort")} <span>{effortText(stop)}</span></h3>
            <div className="vm-effort" role="radiogroup" aria-label={t("model.effort")} style={{ "--levels": levels.length } as CSSProperties}>
              {levels.map((label, k) => {
                const option = line?.stops.find((s) => s.option && s.label === label);
                const sel = label === selLevel;
                return (
                  <button
                    key={label}
                    type="button"
                    role="radio"
                    aria-checked={sel}
                    tabIndex={sel ? 0 : -1}
                    disabled={!option}
                    data-machine-effort={label}
                    data-fill={(option && selLevel && k < levels.indexOf(selLevel)) || undefined}
                    style={{ "--k": ((k + 1) * LEVELS.length) / levels.length } as CSSProperties}
                    onClick={() => effort(option?.option)}
                  ><i /><span>{modelEffortLabel(label, t)}</span></button>
                );
              })}
            </div>
          </section>

          <section className="vm-block vm-keys" aria-hidden>
            <div className="vm-krow" style={{ "--cols": Math.max(rows.length, maxSlots) } as CSSProperties}>
              {rows.map((row, lab) => <button key={row.instance.instanceId} type="button" tabIndex={-1} className="vm-key" data-on={lab === cur?.lab || undefined} data-down={pressed === `lab${lab}` || undefined} onClick={() => goLab(lab)}><small>{LETTERS[lab]}</small><ProviderMark driverKind={row.instance.driverKind} size={20} /></button>)}
            </div>
            <div className="vm-krow" style={{ "--cols": Math.max(rows.length, maxSlots) } as CSSProperties}>
              {Array.from({ length: maxSlots }, (_, k) => <button key={k} type="button" tabIndex={-1} className="vm-key" disabled={!products.some((product) => product.lab === cur?.lab && product.slot === k)} data-on={k === cur?.slot || undefined} data-down={pressed === `n${k + 1}` || undefined} onClick={() => goNum(k + 1)}>{k + 1}</button>)}
            </div>
          </section>

          <div className="vm-setup">{children}</div>

          <button type="button" className="vm-pick" data-machine-pick data-same={(same && !vend) || undefined} data-vending={vend ? "" : undefined} data-down={pressed === "pick" || undefined} disabled={!pickable || Boolean(vend)} onClick={() => pick()}>
            <b>{same && !vend ? t("model.machine.inChat") : t("model.chart.pick")}</b>
            <span>{cur ? `${fullName(cur)}${effortText(stop) ? ` · ${effortText(stop)}` : ""}` : draft.model}</span>
          </button>
          <p className="vm-fine">
            <kbd>{LETTERS[0]}</kbd>-<kbd>{LETTERS[rows.length - 1]}</kbd> {t("model.chart.lab")} <kbd>1</kbd>-<kbd>{maxSlots}</kbd> {t("model.engineAxis")} <kbd>←</kbd><kbd>→</kbd> {t("model.modelAxis")} <kbd>Enter</kbd> {t("model.chart.pick")}
            {corner && <> <kbd>{altKeyLabel()}</kbd><kbd>S</kbd> {t("model.style")} <kbd>{altKeyLabel()}</kbd><kbd>Shift</kbd><kbd>S</kbd> {t("model.style.next")}</>}
            <br />{t("model.dial.asOf", { date: MODEL_INDEX_AS_OF })}
          </p>
        </div>
      </div>
    </div>
  );
}
