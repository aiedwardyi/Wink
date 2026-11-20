import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronRight, History, Paperclip, Pencil, Search } from "lucide-react";
import { z } from "zod";

import { request } from "@/lib/api-request";
import { DEMO_CHIP } from "@/lib/chip-style";
import { attachmentImageUrl } from "@/lib/composer-attachments";
import { localeTag, useI18n, type LocaleId, type MessageKey } from "@/lib/i18n";
import { adjacentMedia, type MediaReference, type PreviewImage } from "@/lib/media-viewer";
import { watchMemorySave } from "@/lib/memory-clean-events";
import { fileOpen, openFile } from "@/lib/open-file";
import { reducedMotion } from "@/lib/phone-swipe";
import { linkedFileSrc, showName } from "@/lib/show-pane";
import { entryTime, pickStamp } from "../../shared/timeline-time";
import { wheelZoomFactor } from "./image-zoom";
import { MediaViewer } from "./MediaViewer";
import "./TimelinePane.css";

const picture = z.object({ path: z.string(), caption: z.string().optional() });
const entry = z.object({
  id: z.string(),
  at: z.number().optional(),
  binding: z.enum(["verified", "unbound"]).optional(),
  key: z.string(),
  replacedBy: z.string().optional(),
  picked: z.string(),
  picture: picture.optional(),
  over: z.array(z.string()),
  overPictures: z.array(picture),
  said: z.string().optional(),
  files: z.array(z.string()),
  thread: z.string().optional(),
  tweaks: z.array(z.object({ at: z.string(), said: z.string() })),
});
const topic = z.object({ entries: z.array(entry) });

type Picture = z.infer<typeof picture>;
type Entry = z.infer<typeof entry>;
type Row = Entry & { older: Entry[]; hay: string };

const stampOf = (id: string) => /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?/.exec(id)?.[0] ?? id;
const dayOf = (id: string) => id.slice(0, 10);
const timeOf = (id: string) => stampOf(id).slice(11);
const entryStamp = (entry: Entry) => entry.binding === "unbound" ? "" : entry.at === undefined ? stampOf(entry.id) : pickStamp(entry.at);
const when = (stamp: string, now: Date) => (stamp.startsWith(`${now.getFullYear()}-`) ? stamp.slice(5) : stamp);
// A picture shown in chat is copied to attachments, which any chat can load; a bot's own file loads only through a chat that links it.
const pictureSrc = (threadId: string, path: string) => (/[\\/]attachments[\\/][^\\/]+$/.test(path) && attachmentImageUrl(path)) || linkedFileSrc(threadId, path);
const same = (a = "", b = "") => a.trim().toLowerCase() === b.trim().toLowerCase();
const LABEL = /^(?:option\s+)?([a-z]|\d{1,2})\s*[-.):]\s+/i;
// a caption may drop its option's letter, as the server accepts; two letters must agree
const names = (caption: string, label: string) => {
  const [a, b] = [LABEL.exec(caption.trim())?.[1], LABEL.exec(label.trim())?.[1]];
  return (!a || !b || same(a, b)) && same(caption.trim().replace(LABEL, ""), label.trim().replace(LABEL, ""));
};

// A tab switch unmounts the pane, so each replaced pick's fold and the search live here for the session.
const folds = new Map<string, boolean>();
const queries = new Map<string, string>();
type View = { x: number; y: number; scale: number };

const ViewPicture = createContext<(path: string, threadId: string, opener: HTMLElement) => void>(() => {});
const Redraw = createContext<() => void>(() => {});

// Captions name their option; uncaptioned pictures pair in order with the options left over, only when the counts match.
function crossedOf({ over, overPictures }: Entry): { label: string; picture?: Picture }[] {
  if (!over.length) return overPictures.map((each) => ({ label: each.caption ?? "", picture: each }));
  const named = over.map((label) => overPictures.find((each) => each.caption && names(each.caption, label)));
  const loose = overPictures.filter((each) => !each.caption);
  const paired = loose.length === named.filter((each) => !each).length;
  let next = 0;
  return over.map((label, i) => ({ label, picture: named[i] ?? (paired ? loose[next++] : undefined) }));
}

function timelineDays(entries: readonly Entry[]): { day: string; rows: Row[] }[] {
  const byId = new Map(entries.map((each) => [each.id, each]));
  const headOf = (each: Entry) => {
    const seen = new Set<string>();
    while (each.replacedBy && byId.has(each.replacedBy) && !seen.has(each.id)) {
      seen.add(each.id);
      each = byId.get(each.replacedBy)!;
    }
    return each;
  };
  const ordered = [...entries].reverse().sort((a, b) => entryTime(b) - entryTime(a));
  const rows = new Map<Entry, Row>();
  for (const each of ordered) {
    const head = headOf(each);
    const row = rows.get(head) ?? { ...head, older: [], hay: "" };
    rows.set(head, row);
    if (head !== each) row.older.push(each);
  }
  const days = new Map<string, Row[]>();
  for (const each of ordered) {
    const row = rows.get(each);
    if (!row) continue;
    row.hay = [row, ...row.older].flatMap((each) => [each.key, each.picked, each.said ?? "", ...each.over, ...each.tweaks.map((tweak) => tweak.said)]).join("\n").toLowerCase();
    const key = dayOf(entryStamp(row) || row.id);
    const day = days.get(key);
    if (day) day.push(row);
    else days.set(key, [row]);
  }
  // built newest first so replaced picks list newest first; drawn oldest first, down to the newest
  return [...days].reverse().map(([day, list]) => ({ day, rows: list.toReversed() }));
}

// Drawn only while the bot has no picks: never saved, sent or counted.
function sampleDays(t: (key: MessageKey) => string) {
  const now = new Date();
  // two local calendar days, so a demo opened just after midnight still reads yesterday and today
  const yesterday = (hour: number, minute: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, hour, minute).getTime();
  const today = (ago: number, order: number) => Math.max(now.getTime() - ago * 60_000, new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() + order);
  const pick = (id: string, at: number, key: string, picked: string, over: string[]): Entry => ({ id, at, key, picked, over, overPictures: [], files: [], tweaks: [] });
  return timelineDays([
    pick("sample-name", yesterday(15, 20), t("timeline.sampleName"), "Wink", ["Nova", "Pilot"]),
    pick("sample-settings", yesterday(15, 55), t("timeline.sampleSettings"), t("timeline.sampleSidePanel"), [t("timeline.sampleFullPage")]),
    pick("sample-font", yesterday(16, 25), t("timeline.sampleFont"), t("timeline.sampleMedium"), [t("timeline.sampleSmall"), t("timeline.sampleLarge")]),
    pick("sample-theme", today(40, 0), t("timeline.sampleTheme"), t("timeline.sampleDark"), [t("timeline.sampleLight")]),
    pick("sample-tour", today(12, 1), t("timeline.sampleTour"), t("timeline.sampleShortTour"), [t("timeline.sampleSkip")]),
    pick("sample-ship", today(2, 2), t("timeline.sampleShip"), t("timeline.sampleToday"), [t("timeline.sampleTomorrow")]),
  ]);
}

function dayLabel(day: string, now: Date, t: (key: MessageKey) => string, locale: LocaleId): [string, string] {
  const [year, month, date] = day.split("-").map(Number);
  const at = new Date(year!, month! - 1, date!);
  const ago = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - at.getTime()) / 86_400_000);
  const weekday = at.toLocaleDateString(localeTag(locale), { weekday: "short" });
  const shown = when(day, now);
  return ago === 0 ? [t("chat.today"), `${weekday} ${shown}`] : ago === 1 ? [t("chat.yesterday"), `${weekday} ${shown}`] : [weekday, shown];
}

const ZOOM = { min: 0.3, max: 2.5 };
const SLOP = 4;
const KEY_PAN = 40;
const GLIDE_MS = 360;
const ARROWS = new Map<string, [number, number]>([["ArrowLeft", [1, 0]], ["ArrowRight", [-1, 0]], ["ArrowUp", [0, 1]], ["ArrowDown", [0, -1]]]);
// Hundreds of picks mount in one task too slowly, so the newest draw first and the rest follow a batch a frame.
const FIRST = 8;
const BATCH = 24;
// The sheet stops at its own edges, so a fling never leaves an empty canvas.
// the sheet keeps this much room at the left and top, clear of the Oldest pill
const PAD = { x: 4, y: 44 };
const edge = (size: number, room: number, at: number, start: number) => Math.min(start, Math.max(Math.min(start, room - size), at));
const LINE = "color-mix(in srgb, var(--color-ink-secondary) 80%, transparent)";
const WON = "var(--color-success)";
const OUT = "var(--color-danger)";

function seeded(text: string) {
  let seed = [...text].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16_777_619), 2_166_136_261);
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function smooth(points: [number, number][]) {
  const f = (n: number) => n.toFixed(1);
  let d = `M${f(points[0]![0])} ${f(points[0]![1])}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const [p0, p1, p2] = [points[i - 1] ?? points[i]!, points[i]!, points[i + 1]!];
    const p3 = points[i + 2] ?? p2;
    d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

function penCurve(r: () => number, x1: number, y1: number, x2: number, y2: number, amp = 1.3) {
  const points: [number, number][] = [];
  const dy = y2 - y1;
  for (let i = 0; i <= 10; i += 1) {
    const t = i / 10;
    const u = 1 - t;
    const x = u * u * u * x1 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x2;
    const y = u * u * u * y1 + 3 * u * u * t * (y1 + dy * 0.55) + 3 * u * t * t * (y2 - dy * 0.55) + t * t * t * y2;
    const jitter = i === 0 || i === 10 ? 0.6 : amp;
    points.push([x + (r() - 0.5) * 2 * jitter, y + (r() - 0.5) * jitter]);
  }
  return smooth(points);
}

function penLine(r: () => number, x1: number, y1: number, x2: number, y2: number, amp = 1.4) {
  const points: [number, number][] = [];
  const bow = (r() - 0.5) * 5;
  const length = Math.hypot(y2 - y1, x2 - x1) || 1;
  for (let i = 0; i <= 5; i += 1) {
    const t = i / 5;
    const b = Math.sin(Math.PI * t) * bow;
    points.push([x1 + (x2 - x1) * t - ((y2 - y1) / length) * b + (r() - 0.5) * amp, y1 + (y2 - y1) * t + ((x2 - x1) / length) * b + (r() - 0.5) * amp]);
  }
  return smooth(points);
}

function penLoop(r: () => number, cx: number, cy: number, rx: number, ry: number) {
  const points: [number, number][] = [];
  const from = -2.3 + r() * 0.4;
  let wobble = 0;
  for (let i = 0; i <= 30; i += 1) {
    const t = i / 30;
    const a = from + (Math.PI * 2 + 0.55) * t;
    wobble = (wobble + (r() - 0.5) * 0.03) * 0.9;
    const k = 1 + wobble + t * 0.07;
    points.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k * (1 - t * 0.03)]);
  }
  return smooth(points);
}

// Pen strokes over the laid-out sheet: branches from each question, the pick circled, the rest struck, and a line down to the next pick.
function drawInk(sheet: HTMLElement, ink: SVGSVGElement) {
  const box = (el: HTMLElement) => {
    let x = 0;
    let y = 0;
    // SAFETY: an HTML element's offsetParent is an HTML element, or null past the root.
    for (let node: HTMLElement | null = el; node && node !== sheet; node = node.offsetParent as HTMLElement | null) {
      x += node.offsetLeft;
      y += node.offsetTop;
    }
    return { x, y, w: el.offsetWidth, h: el.offsetHeight };
  };
  const paths: string[] = [];
  let above: { x: number; y: number } | null = null;
  for (const pick of sheet.querySelectorAll<HTMLElement>("[data-timeline-pick]")) {
    const r = seeded(pick.dataset.timelinePick!);
    const add = (kind: string, d: string, color: string, width: number, extra = "") => paths.push(`<path data-ink="${kind}" d="${d}" stroke="${color}" stroke-width="${width}"${extra}/>`);
    const old = pick.hasAttribute("data-old");
    const label = box(pick.querySelector<HTMLElement>("[data-label]")!);
    const lx = label.x + label.w / 2;
    const ly = label.y + label.h;
    const won = box(pick.querySelector<HTMLElement>("[data-won] > .timeline-pic")!);
    const wx = won.x + won.w / 2;
    if (above && !old) add("link", penCurve(r, above.x, above.y, lx, label.y - 2, 1.2), LINE, 1.5);
    for (const el of pick.querySelectorAll<HTMLElement>("[data-timeline-out] > .timeline-pic")) {
      const out = box(el);
      const ox = out.x + out.w / 2;
      add("branch", penCurve(r, lx, ly + 2, ox, out.y - 4), LINE, 1.4);
      add("branch", penCurve(r, lx + 0.8, ly + 2, ox + 0.6, out.y - 4, 0.7), LINE, 0.7);
      add("tick", penLine(r, ox - 8, out.y - 9, ox + 8, out.y - 6, 1), OUT, 1.6);
      add("strike", penLine(r, out.x + 4, out.y + 6, out.x + out.w - 4, out.y + out.h - 6), OUT, 2.2, ' opacity=".9"');
      add("strike", penLine(r, out.x + out.w - 6, out.y + 8, out.x + 6, out.y + out.h - 10), OUT, 2.2, ' opacity=".9"');
    }
    const color = old ? LINE : WON;
    const rx = won.w / 2 + 13;
    const ry = won.h / 2 + 14;
    add("branch", penCurve(r, lx, ly + 2, wx, won.y - 14), color, 2.2);
    add("branch", penCurve(r, lx - 0.7, ly + 2, wx + 0.5, won.y - 14, 0.8), color, 1);
    add(old ? "replaced" : "ring", penLoop(r, wx, won.y + won.h / 2, rx, ry), color, 2.6, old ? ' stroke-dasharray="5 5"' : "");
    if (!old) add("ring", penLoop(r, wx + 1, won.y + won.h / 2 - 1, rx - 2, ry - 1), color, 1.1, ' opacity=".6"');
    const note = pick.querySelector<HTMLElement>(".timeline-note");
    if (note) {
      const n = box(note);
      add("note", penLine(r, wx + rx - 2, won.y + won.h / 2 - 10, n.x - 4, n.y + 18, 1), LINE, 1.2, ' stroke-dasharray="4 5"');
    }
    if (old) continue;
    const caption = pick.querySelector<HTMLElement>("[data-won] > .timeline-caption");
    above = { x: wx, y: Math.max(won.y + won.h / 2 + ry + 2, caption ? box(caption).y + box(caption).h + 6 : 0) };
    // each open replaced pick hangs below its newer one on a dashed line
    const left = Math.min(...[...pick.querySelectorAll<HTMLElement>(".timeline-option")].map((el) => box(el).x)) - 22;
    const my = label.y + label.h / 2;
    for (let next = pick.nextElementSibling; next?.classList.contains("timeline-old"); next = next.nextElementSibling) {
      const to = box(next.querySelector<HTMLElement>("[data-label]")!);
      const route: [number, number][] = [[label.x, my], [left + 6, my + 8], [left, my + 60], [left - 2, to.y - 40], [left + 8, to.y + to.h / 2 - 4], [to.x - 2, to.y + to.h / 2]];
      add("route", smooth(route.map(([x, y], i) => (i && i < route.length - 1 ? [x + (r() - 0.5) * 2, y + (r() - 0.5) * 2] : [x, y]))), LINE, 1.3, ' stroke-dasharray="6 6"');
    }
  }
  ink.setAttribute("width", String(sheet.offsetWidth));
  ink.setAttribute("height", String(sheet.offsetHeight));
  // only numbers and token names go in, never the user's words
  ink.innerHTML = paths.join("");
}

type PaneProps = { botId: string; threadId: string; maximized: boolean; closing: boolean; profileName?: string };

export function TimelinePane(props: PaneProps) {
  const [viewing, setViewing] = useState<PreviewImage | null>(null);
  const [pick, setPick] = useState<MediaReference[]>([]);
  const view = useMemo(() => (path: string, threadId: string, opener: HTMLElement) => {
    opener.focus({ preventScroll: true });
    const buttons = [...(opener.closest(".timeline-detail")?.querySelectorAll<HTMLElement>("[data-path]") ?? [opener])].filter((button) => fileOpen(button.dataset.path!) === "picture");
    const pictures = buttons.map(({ dataset }, i) => ({ src: pictureSrc(threadId, dataset.path!), name: showName(dataset.path!), id: String(i), messageId: threadId }));
    setPick(pictures);
    const selected = pictures[buttons.indexOf(opener)];
    if (selected) setViewing(selected);
    else openFile({ path, threadId, src: pictureSrc(threadId, path) }, { view: setViewing });
  }, []);
  return (
    <ViewPicture.Provider value={view}>
      <Picks {...props} />
      {viewing && (
        <MediaViewer image={viewing} onClose={() => setViewing(null)} previous={Boolean(adjacentMedia(pick, viewing, -1))} next={Boolean(adjacentMedia(pick, viewing, 1))}
          onNavigate={(direction) => setViewing((current) => current && (adjacentMedia(pick, current, direction) ?? current))} />
      )}
    </ViewPicture.Provider>
  );
}

function Picks({ botId, threadId, maximized, closing, profileName }: PaneProps) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [saves, setSaves] = useState(0);
  const [query, setTyped] = useState(() => queries.get(botId) ?? "");
  const setQuery = (next: string) => {
    queries.set(botId, next);
    setTyped(next);
  };

  useEffect(() => watchMemorySave(botId, () => setSaves((count) => count + 1)), [botId]);

  useEffect(() => {
    let alive = true;
    request(`/api/bots/${encodeURIComponent(botId)}/memory/topics/decisions.md`).then(
      (body) => {
        if (!alive) return;
        const parsed = topic.safeParse(body);
        if (parsed.success) {
          setEntries(parsed.data.entries);
          setFailed(false);
        } else setFailed(true);
      },
      (error: { status?: number }) => {
        if (!alive) return;
        if (error.status === 404) {
          setEntries((shown) => shown ?? []);
          setFailed(false);
        } else setFailed(true);
      },
    );
    return () => { alive = false; };
  }, [botId, saves]);

  const sample = entries?.length === 0;
  const days = useMemo(() => (entries?.length === 0 ? sampleDays(t) : timelineDays(entries ?? [])), [entries, t]);
  const needle = query.trim().toLowerCase();
  const shown = useMemo(() => (needle ? days.map((day) => ({ ...day, rows: day.rows.filter((row) => row.hay.includes(needle)) })).filter((day) => day.rows.length > 0) : days), [days, needle]);
  const you = profileName || t("chrome.you");

  return (
    <div className="verify-watch-frame timeline-pane" data-maximized={maximized || undefined} aria-busy={(!entries && !failed) || undefined} data-sample={sample || undefined}>
      {failed && !entries
        ? <p role="status" className="show-media-empty">{t("errors.request")}</p>
        : sample
          ? (
            <>
              <div className="timeline-sample">
                <small className={DEMO_CHIP}>{t("timeline.sample")}</small>
                <p className="show-media-empty">{t("timeline.empty")}</p>
              </div>
              <Canvas key="sample" days={days} needle="" botId={botId} threadId={threadId} you={you} closing={closing} />
            </>
          )
          : entries && (
            <>
              <label className="timeline-search">
                <Search size={14} aria-hidden="true" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape" || !query) return;
                    event.preventDefault();
                    setQuery("");
                  }}
                  placeholder={t("timeline.search")}
                  aria-label={t("timeline.search")}
                />
              </label>
              {shown.length === 0
                ? <p className="show-media-empty">{t("find.noResults")}</p>
                : <Canvas days={shown} needle={needle} botId={botId} threadId={threadId} you={you} closing={closing} />}
            </>
          )}
    </div>
  );
}

// where the sheet sits with its newest pick at the bottom of the pane, or at the top if it is shorter
const pinY = (box: HTMLElement, sheet: HTMLElement, scale: number) => Math.min(PAD.y, box.clientHeight - sheet.offsetHeight * scale);

function Canvas({ days, needle, botId, threadId, you, closing }: { days: { day: string; rows: Row[] }[]; needle: string; botId: string; threadId: string; you: string; closing: boolean }) {
  const { t, locale } = useI18n();
  const frame = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const ink = useRef<SVGSVGElement>(null);
  const zoom = useRef<HTMLElement>(null);
  const view = useRef<View | null>(null);
  const pinned = useRef(false);
  const gliding = useRef(0);
  const laid = useRef({ rows: "", first: "", height: 0, opened: null as ReadonlySet<string> | null });
  const searched = useRef(needle);
  const wasClosing = useRef(closing);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragged = useRef(false);
  const [touch] = useState(() => window.matchMedia?.("(pointer: coarse)").matches ?? false);
  const [opened, setOpened] = useState(() => new Set([...folds].filter(([key, open]) => open && key.startsWith(`${botId}:`)).map(([key]) => key.slice(botId.length + 1))));
  const toggle = useCallback((id: string) => setOpened((now) => {
    const next = new Set(now);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    folds.set(`${botId}:${id}`, next.has(id));
    return next;
  }), [botId]);
  const [grow, setGrow] = useState(() => ({ needle, limit: FIRST }));
  if (grow.needle !== needle) setGrow({ needle, limit: FIRST });
  const total = days.reduce((sum, day) => sum + day.rows.length, 0);
  const drawn = useMemo(() => {
    let left = grow.limit;
    return [...days].reverse().flatMap((day) => {
      const rows = day.rows.slice(Math.max(0, day.rows.length - left));
      left -= rows.length;
      return rows.length ? [{ ...day, rows }] : [];
    }).reverse();
  }, [days, grow.limit]);
  useEffect(() => {
    if (grow.limit >= total) return;
    const id = requestAnimationFrame(() => setGrow((at) => ({ ...at, limit: at.limit + BATCH })));
    return () => cancelAnimationFrame(id);
  }, [grow, total]);
  const now = new Date();

  const show = useCallback((next: View, free = false) => {
    if (![next.x, next.y, next.scale].every(Number.isFinite)) return;
    const box = frame.current!;
    const width = sheet.current!.offsetWidth * next.scale;
    const height = sheet.current!.offsetHeight * next.scale;
    const kept = box.clientWidth && !free
      ? { scale: next.scale, x: edge(width, box.clientWidth, next.x, PAD.x), y: edge(height, box.clientHeight, next.y, PAD.y) }
      : next;
    view.current = kept;
    pinned.current = kept.y <= box.clientHeight - height + 1;
    sheet.current!.style.transform = `translate(${kept.x}px, ${kept.y}px) scale(${kept.scale})`;
    zoom.current!.textContent = `${Math.round(kept.scale * 100)}%`;
  }, []);

  const stopGlide = useCallback(() => {
    cancelAnimationFrame(gliding.current);
    gliding.current = 0;
  }, []);

  // the newest end is read each frame, so a pick landing mid-glide is still where it ends
  const glideTo = useCallback((end: "oldest" | "newest") => {
    stopGlide();
    const box = frame.current!;
    if (end === "oldest") setGrow((at) => (at.limit < total ? { ...at, limit: total } : at));
    const goal = () => (end === "oldest" ? PAD.y : pinY(box, sheet.current!, view.current!.scale));
    if (reducedMotion()) return show({ ...view.current!, y: goal() });
    let began: number | undefined;
    let from = 0;
    const step = (now: number) => {
      began ??= now;
      if (now === began) from = view.current!.y;
      const done = Math.min(1, (now - began) / GLIDE_MS);
      show({ ...view.current!, y: from + (goal() - from) * (1 - (1 - done) ** 3) });
      gliding.current = done < 1 ? requestAnimationFrame(step) : 0;
    };
    gliding.current = requestAnimationFrame(step);
  }, [show, stopGlide, total]);

  const zoomAt = useCallback((x: number, y: number, factor: number, at = view.current!) => {
    const scale = Math.min(ZOOM.max, Math.max(ZOOM.min, at.scale * factor));
    const ratio = scale / at.scale;
    show({ scale, x: x - (x - at.x) * ratio, y: y - (y - at.y) * ratio });
  }, [show]);

  // A resize can land after React detached the sheet, so the refs may be gone.
  const redraw = useCallback(() => {
    if (sheet.current && ink.current) drawInk(sheet.current, ink.current);
  }, []);

  useLayoutEffect(() => {
    redraw();
    const box = frame.current!;
    const width = sheet.current!.offsetWidth;
    const height = sheet.current!.offsetHeight;
    const fit = Math.min(0.86, Math.max(0.62, width ? (box.clientWidth / width) * 1.06 : 1));
    const at = view.current;
    const reopened = wasClosing.current && !closing;
    const changed = searched.current !== needle;
    const was = laid.current;
    const first = drawn[0]?.rows[0]?.id ?? "";
    const rows = `${first}\n${drawn.at(-1)?.rows.at(-1)?.id}\n${drawn.reduce((sum, day) => sum + day.rows.length, 0)}`;
    // the newest pick is at the bottom, so a view left there follows new picks down
    const floor = (scale: number) => pinY(box, sheet.current!, scale);
    let next: View;
    if (!at || reopened || changed) {
      stopGlide();
      const scale = !at || reopened || !needle ? fit : at.scale;
      next = { x: PAD.x, y: floor(scale), scale };
    // the same picks keep the view, unless one grew (a tweak landed) while it sat on the newest pick
    } else if (was.rows === rows && (was.height === height || was.opened !== opened)) next = at;
    else if (pinned.current) next = { ...at, y: floor(at.scale) };
    // older picks mounting above keep a scrolled-up view on what it shows
    else next = first === was.first ? at : { ...at, y: at.y - (height - was.height) * at.scale };
    laid.current = { rows, first, height, opened };
    wasClosing.current = closing;
    searched.current = needle;
    show(next, true);
  }, [closing, drawn, needle, opened, redraw, show, stopGlide]);

  useEffect(() => {
    const box = frame.current!;
    // a pane resize while the view sits on the newest pick keeps it there
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      redraw();
      const at = view.current;
      if (at && pinned.current && sheet.current) show({ ...at, y: pinY(box, sheet.current, at.scale) }, true);
    });
    resized?.observe(sheet.current!);
    resized?.observe(box);
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      stopGlide();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.clientHeight : 1;
      const rect = box.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) return zoomAt(event.clientX - rect.left, event.clientY - rect.top, wheelZoomFactor(event.deltaY * unit));
      const sideways = event.shiftKey && !event.deltaX;
      const at = view.current!;
      show({ ...at, x: at.x - (sideways ? event.deltaY : event.deltaX) * unit, y: at.y - (sideways ? 0 : event.deltaY) * unit });
    };
    const prevent = (event: Event) => event.preventDefault();
    box.addEventListener("wheel", onWheel, { passive: false });
    box.addEventListener("gesturestart", prevent);
    box.addEventListener("gesturechange", prevent);
    return () => {
      resized?.disconnect();
      box.removeEventListener("wheel", onWheel);
      box.removeEventListener("gesturestart", prevent);
      box.removeEventListener("gesturechange", prevent);
      stopGlide();
    };
  }, [redraw, show, stopGlide, zoomAt]);

  const spot = (event: ReactPointerEvent) => {
    const rect = frame.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    stopGlide();
    if (!pointers.current.size) dragged.current = false;
    pointers.current.set(event.pointerId, spot(event));
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const last = pointers.current.get(event.pointerId);
    if (!last) return;
    const point = spot(event);
    const at = view.current!;
    if (event.pointerType === "mouse" && !event.buttons) {
      pointers.current.delete(event.pointerId);
      return;
    }
    if (pointers.current.size >= 2) {
      // SAFETY: two or more pointers are down, so the first two exist before and after this move.
      const [a, b] = [...pointers.current.values()] as [typeof point, typeof point];
      pointers.current.set(event.pointerId, point);
      // SAFETY: the same pointers, one of them moved.
      const [c, d] = [...pointers.current.values()] as [typeof point, typeof point];
      if (!dragged.current) {
        dragged.current = true;
        frame.current!.setPointerCapture?.(event.pointerId);
      }
      const mid = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 };
      // one clamp after both the move and the zoom, so an edge never eats the move
      zoomAt(mid.x, mid.y, Math.hypot(c.x - d.x, c.y - d.y) / (Math.hypot(a.x - b.x, a.y - b.y) || 1), { ...at, x: at.x + mid.x - (a.x + b.x) / 2, y: at.y + mid.y - (a.y + b.y) / 2 });
      return;
    }
    if (!dragged.current) {
      if (Math.hypot(point.x - last.x, point.y - last.y) < SLOP) return;
      dragged.current = true;
      frame.current!.setPointerCapture?.(event.pointerId);
      frame.current!.dataset.grabbing = "";
    }
    pointers.current.set(event.pointerId, point);
    show({ ...at, x: at.x + point.x - last.x, y: at.y + point.y - last.y });
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (!pointers.current.size) delete frame.current!.dataset.grabbing;
  };

  return (
    <div
      ref={frame}
      className="timeline-canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDragStart={(event) => event.preventDefault()}
      // a drag that ends on a picture is not a click on it; a key press is
      onClickCapture={(event) => {
        if (!dragged.current || event.detail === 0) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      // the arrow keys move the canvas, so a keyboard reaches a quote no tab stop brings into view
      onKeyDown={(event) => {
        const step = ARROWS.get(event.key);
        if (!step || event.altKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        stopGlide();
        const at = view.current!;
        show({ ...at, x: at.x + step[0] * KEY_PAN, y: at.y + step[1] * KEY_PAN });
      }}
      onFocus={(event) => {
        if (!(event.target instanceof HTMLElement) || !event.target.matches(":focus-visible") || event.target.dataset.end) return;
        const to = event.target.getBoundingClientRect();
        const box = frame.current!.getBoundingClientRect();
        if (to.top >= box.top + PAD.y && to.bottom <= box.bottom && to.left >= box.left && to.right <= box.right) return;
        const at = view.current!;
        show({ ...at, x: at.x + box.left + box.width / 2 - (to.left + to.width / 2), y: at.y + box.top + box.height / 2 - (to.top + to.height / 2) });
      }}
    >
      <Redraw.Provider value={redraw}>
        <div ref={sheet} className="timeline-sheet">
          <svg ref={ink} className="timeline-ink" aria-hidden="true" />
          {drawn.map(({ day, rows }) => {
            const [name, date] = day ? dayLabel(day, now, t, locale) : [];
            return (
              <section key={day}>
                {day && <h3 data-timeline-day={day} className="timeline-day"><b>{name}</b> · {date}</h3>}
                {rows.map((row) => <Decision key={row.id} row={row} opened={opened} toggle={toggle} threadId={threadId} you={you} />)}
              </section>
            );
          })}
        </div>
      </Redraw.Provider>
      <p className="timeline-hint">{t(touch ? "timeline.hintTouch" : "timeline.hintMouse")}<b ref={zoom} /></p>
      <button type="button" className="timeline-hint" data-end="oldest" onClick={() => glideTo("oldest")}>{t("timeline.oldest")}</button>
      <button type="button" className="timeline-hint" data-end="newest" onClick={() => glideTo("newest")}>{t("timeline.newest")}</button>
    </div>
  );
}

function Decision({ row, opened, toggle, threadId, you }: { row: Row; opened: ReadonlySet<string>; toggle: (id: string) => void; threadId: string; you: string }) {
  const { t } = useI18n();
  const chips = row.older.length > 0 && (
    <span className="timeline-chips">
      {row.older.map((each) => {
        const stamp = entryStamp(each);
        const time = timeOf(stamp);
        const at = time && dayOf(stamp) === dayOf(entryStamp(row)) ? time : when(stamp, new Date());
        return (
          <button key={each.id} type="button" data-timeline-replaced aria-expanded={opened.has(each.id)} onClick={() => toggle(each.id)} className="timeline-replaced hover:bg-raised-hover">
            <History size={13} aria-hidden="true" />
            <span>{at && <>{t("timeline.replaced", { when: at })} · </>}<s>{each.picked}</s></span>
            <ChevronRight size={14} aria-hidden="true" className="timeline-chevron" />
          </button>
        );
      })}
    </span>
  );
  return (
    <>
      <Pick entry={row} threadId={threadId} you={you} chips={chips} />
      {row.older.filter((each) => opened.has(each.id)).map((each) => <div key={each.id} className="timeline-old"><Pick entry={each} threadId={threadId} you={you} replaced={[row, ...row.older].find((other) => other.id === each.replacedBy)} old /></div>)}
    </>
  );
}

function Pick({ entry, threadId: viewing, you, chips, replaced, old = false }: { entry: Entry; threadId: string; you: string; chips?: ReactNode; replaced?: Entry; old?: boolean }) {
  const { t } = useI18n();
  // a room pick's own files load through the room that links them
  const threadId = entry.thread ?? viewing;
  const now = new Date();
  const stamp = entryStamp(entry);
  const at = when(stamp, now);
  const replacedAt = replaced && entryStamp(replaced) && when(entryStamp(replaced), now);
  const options = crossedOf(entry).map((each, n) => <Option key={n} label={each.label} picture={each.picture} threadId={threadId} />);
  // the pick sits among its options, second from the left, the way it was picked from a row
  options.splice(Math.min(1, options.length), 0, <Option key="won" label={entry.picked} picture={entry.picture} threadId={threadId} won />);
  return (
    <div className="timeline-detail" data-timeline-pick={entry.id} data-old={old || undefined}>
      <div className="timeline-left">
        <div className="timeline-label" data-label tabIndex={0}>
          <span className="timeline-key">{old ? entry.picked : entry.key}</span>
          {old ? replacedAt && <time>{t("timeline.replacedAt", { when: replacedAt })}</time> : at && <time>{at}</time>}
          {chips}
        </div>
        <div className="timeline-options">{options}</div>
      </div>
      <div className="timeline-notes">
        {entry.said !== undefined && <div className="timeline-note"><p className="timeline-said"><q>{entry.said}</q><span>{you}{at && ` · ${at}`}</span></p></div>}
        {entry.tweaks.length > 0 && (
          <div className="timeline-note">
            <p className="timeline-section"><Pencil size={12} aria-hidden="true" />{t("timeline.tweaks")}</p>
            <ol className="timeline-tweaks">
              {entry.tweaks.map((tweak, n) => <li key={n}><span>{n + 1}</span><q>{tweak.said}</q><time>{dayOf(tweak.at) === dayOf(stamp) && timeOf(tweak.at) ? timeOf(tweak.at) : when(stampOf(tweak.at), now)}</time></li>)}
            </ol>
          </div>
        )}
        {entry.files.length > 0 && (
          <div className="timeline-note">
            <p className="timeline-section"><Paperclip size={12} aria-hidden="true" />{t("timeline.screenshots", { when: at })}</p>
            <div className="timeline-shots">{entry.files.map((path) => <span key={path} className="timeline-pic"><Img path={path} threadId={threadId} viewable /></span>)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function Option({ label, picture, threadId, won = false }: { label: string; picture?: Picture; threadId: string; won?: boolean }) {
  const redraw = useContext(Redraw);
  const [failed, setFailed] = useState(false);
  useEffect(() => { if (failed) redraw(); }, [failed, redraw]);
  const shown = picture && !failed;
  return (
    <div className="timeline-option" data-won={won || undefined} data-timeline-out={won ? undefined : ""}>
      {shown
        ? <span className="timeline-pic"><Img path={picture.path} threadId={threadId} onFail={() => setFailed(true)} viewable /></span>
        : <span className="timeline-pic" data-text>{won ? label : <s>{label}</s>}</span>}
      {shown && <span className="timeline-caption">{won ? label : <s>{label}</s>}</span>}
    </div>
  );
}

// Inside a button, a picture is opened by the viewer; the row's own thumb sits in one already.
function Img({ path, threadId, onFail, viewable = false }: { path: string; threadId: string; onFail?: () => void; viewable?: boolean }) {
  const { t } = useI18n();
  const view = useContext(ViewPicture);
  const [loaded, setLoaded] = useState(false);
  const img = <img src={pictureSrc(threadId, path)} alt="" loading="lazy" decoding="async" data-loaded={loaded || undefined} onLoad={() => setLoaded(true)} onError={onFail} />;
  return viewable
    ? <button type="button" className="timeline-open" data-path={path} aria-label={t("viewer.open", { name: showName(path) })} onClick={(event) => view(path, threadId, event.currentTarget)}>{img}</button>
    : img;
}
