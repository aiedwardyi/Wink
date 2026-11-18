import { createContext, memo, useContext, useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, History, Paperclip, Pencil, Search, TextQuote, X } from "lucide-react";
import { z } from "zod";

import { request } from "@/lib/api-request";
import { attachmentImageUrl } from "@/lib/composer-attachments";
import { localeTag, useI18n, type LocaleId, type MessageKey } from "@/lib/i18n";
import { adjacentMedia, type MediaReference, type PreviewImage } from "@/lib/media-viewer";
import { watchMemoryArrival } from "@/lib/memory-clean-events";
import { fileOpen, openFile } from "@/lib/open-file";
import { linkedFileSrc, showName } from "@/lib/show-pane";
import { Fold } from "./Fold";
import { MediaViewer } from "./MediaViewer";
import "./TimelinePane.css";

const picture = z.object({ path: z.string(), caption: z.string().optional() });
const entry = z.object({
  id: z.string(),
  key: z.string(),
  replacedBy: z.string().optional(),
  picked: z.string(),
  picture: picture.optional(),
  over: z.array(z.string()),
  overPictures: z.array(picture),
  said: z.string().optional(),
  files: z.array(z.string()),
  tweaks: z.array(z.object({ at: z.string(), said: z.string() })),
});
const topic = z.object({ entries: z.array(entry) });

type Picture = z.infer<typeof picture>;
type Entry = z.infer<typeof entry>;
type Row = Entry & { older: Entry[]; hay: string };

const stampOf = (id: string) => /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?/.exec(id)?.[0] ?? id;
const dayOf = (id: string) => id.slice(0, 10);
const timeOf = (id: string) => stampOf(id).slice(11);
const when = (stamp: string, now: Date) => (stamp.startsWith(`${now.getFullYear()}-`) ? stamp.slice(5) : stamp);
// A picture shown in chat is copied to attachments, which any chat can load; a bot's own file loads only through a chat that links it.
const pictureSrc = (threadId: string, path: string) => (/[\\/]attachments[\\/][^\\/]+$/.test(path) && attachmentImageUrl(path)) || linkedFileSrc(threadId, path);
const same = (a = "", b = "") => a.trim().toLowerCase() === b.trim().toLowerCase();

// A tab switch unmounts the pane, so each pick's fold lives here for the session.
const folds = new Map<string, boolean>();
function useFold(key: string, initial: boolean) {
  const [open, setOpen] = useState(() => folds.get(key) ?? initial);
  return [open, () => { const next = !(folds.get(key) ?? initial); folds.set(key, next); setOpen(next); }] as const;
}

const ViewPicture = createContext<(path: string, threadId: string, opener: HTMLElement) => void>(() => {});

// Captions name their option; uncaptioned pictures pair in order with the options left over, only when the counts match.
function crossedOf({ over, overPictures }: Entry): { label: string; picture?: Picture }[] {
  if (!over.length) return overPictures.map((each) => ({ label: each.caption ?? "", picture: each }));
  const named = over.map((label) => overPictures.find((each) => same(each.caption, label)));
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
  const rows = new Map<Entry, Row>();
  for (const each of [...entries].reverse().sort((a, b) => stampOf(b.id).localeCompare(stampOf(a.id)))) {
    const head = headOf(each);
    const row = rows.get(head) ?? { ...head, older: [], hay: "" };
    rows.set(head, row);
    if (head !== each) row.older.push(each);
  }
  const days = new Map<string, Row[]>();
  for (const row of rows.values()) {
    row.hay = [row, ...row.older].flatMap((each) => [each.key, each.picked, each.said ?? "", ...each.over, ...each.tweaks.map((tweak) => tweak.said)]).join("\n").toLowerCase();
    const day = days.get(dayOf(row.id));
    if (day) day.push(row);
    else days.set(dayOf(row.id), [row]);
  }
  return [...days].map(([day, list]) => ({ day, rows: list }));
}

function dayLabel(day: string, now: Date, t: (key: MessageKey) => string, locale: LocaleId): [string, string] {
  const [year, month, date] = day.split("-").map(Number);
  const at = new Date(year!, month! - 1, date!);
  const ago = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - at.getTime()) / 86_400_000);
  const weekday = at.toLocaleDateString(localeTag(locale), { weekday: "short" });
  const shown = when(day, now);
  return ago === 0 ? [t("chat.today"), `${weekday} ${shown}`] : ago === 1 ? [t("chat.yesterday"), `${weekday} ${shown}`] : [weekday, shown];
}

type PaneProps = { botId: string; threadId: string; maximized: boolean; profileName?: string };

export function TimelinePane(props: PaneProps) {
  const [viewing, setViewing] = useState<PreviewImage | null>(null);
  const [pick, setPick] = useState<MediaReference[]>([]);
  const view = useMemo(() => (path: string, threadId: string, opener: HTMLElement) => {
    opener.focus({ preventScroll: true });
    // the pictures of one pick, in the order they sit on screen
    const paths = [...(opener.closest(".timeline-detail") ?? opener).querySelectorAll<HTMLElement>("[data-path]")].map((each) => each.dataset.path!).filter((each) => fileOpen(each) === "picture");
    setPick(paths.map((each) => ({ src: pictureSrc(threadId, each), name: showName(each), id: each, messageId: threadId })));
    openFile({ path, threadId, src: pictureSrc(threadId, path) }, { view: setViewing });
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

function Picks({ botId, threadId, maximized, profileName }: PaneProps) {
  const { t, locale } = useI18n();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [saves, setSaves] = useState(0);

  useEffect(() => watchMemoryArrival(botId, () => setSaves((count) => count + 1)), [botId]);

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
          setEntries([]);
          setFailed(false);
        } else setFailed(true);
      },
    );
    return () => { alive = false; };
  }, [botId, saves]);

  const days = useMemo(() => timelineDays(entries ?? []), [entries]);
  const needle = query.trim().toLowerCase();
  const shown = needle ? days.map((day) => ({ ...day, rows: day.rows.filter((row) => row.hay.includes(needle)) })).filter((day) => day.rows.length > 0) : days;
  const now = new Date();
  const you = profileName || t("chrome.you");

  return (
    <div className="verify-watch-frame timeline-pane" data-maximized={maximized || undefined} aria-busy={(!entries && !failed) || undefined}>
      {failed
        ? <p role="status" className="show-media-empty">{t("errors.request")}</p>
        : entries?.length === 0
          ? <p className="show-media-empty">{t("timeline.empty")}</p>
          : entries && (
            <>
              <label className="timeline-search">
                <Search size={14} aria-hidden="true" />
                <input
                  className="max-md:text-[16px]"
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
              <div className="show-media-scroll">
                {shown.length === 0 && <p className="show-media-empty">{t("find.noResults")}</p>}
                {shown.map(({ day, rows }) => {
                  const [name, date] = dayLabel(day, now, t, locale);
                  return (
                    <section key={day}>
                      <h3 data-timeline-day={day} className="show-media-month"><b>{name}</b> · {date}</h3>
                      {rows.map((row) => <TimelineRow key={row.id} row={row} botId={botId} threadId={threadId} you={you} />)}
                    </section>
                  );
                })}
              </div>
            </>
          )}
    </div>
  );
}

const TimelineRow = memo(function TimelineRow({ row, botId, threadId, you }: { row: Row; botId: string; threadId: string; you: string }) {
  const { t } = useI18n();
  const [open, toggle] = useFold(`${botId}:${row.id}`, true);
  const crossed = crossedOf(row).length;
  const counts = [
    ...(crossed ? [t("timeline.crossed", { count: crossed })] : []),
    ...(row.tweaks.length ? [t(row.tweaks.length === 1 ? "timeline.tweakOne" : "timeline.tweakMany", { count: row.tweaks.length })] : []),
  ].join(" · ");
  const time = timeOf(row.id);
  return (
    <div data-timeline-row={row.id} className="timeline-row">
      <button type="button" data-timeline-head aria-expanded={open} onClick={toggle} className="timeline-head hover:bg-raised/50">
        <Thumb picture={row.picture} threadId={threadId} />
        <span className="timeline-main">
          <span className="timeline-key">{row.key}</span>
          <span className="timeline-sub"><Check size={12} aria-hidden="true" /><span className="timeline-pick">{row.picked}</span></span>
        </span>
        <span className="timeline-meta">{time}{time && counts && <br />}{counts}</span>
        <ChevronRight size={16} aria-hidden="true" className="timeline-chevron" />
      </button>
      <Fold open={open}><Detail entry={row} threadId={threadId} you={you} /></Fold>
      {row.older.map((each) => <Replaced key={each.id} entry={each} newer={row} botId={botId} threadId={threadId} you={you} />)}
    </div>
  );
});

function Replaced({ entry, newer, botId, threadId, you }: { entry: Entry; newer: Entry; botId: string; threadId: string; you: string }) {
  const { t } = useI18n();
  const [open, toggle] = useFold(`${botId}:${entry.id}`, false);
  const time = timeOf(entry.id);
  const at = time && dayOf(entry.id) === dayOf(newer.id) ? time : when(stampOf(entry.id), new Date());
  return (
    <>
      <button type="button" data-timeline-replaced aria-expanded={open} onClick={toggle} className="timeline-replaced hover:bg-raised/50">
        <History size={13} aria-hidden="true" />
        <span>{t("timeline.replaced", { when: at })} · <s>{entry.picked}</s></span>
        <ChevronRight size={14} aria-hidden="true" className="timeline-chevron" />
      </button>
      <Fold open={open}><Detail entry={entry} threadId={threadId} you={you} old /></Fold>
    </>
  );
}

function Detail({ entry, threadId, you, old = false }: { entry: Entry; threadId: string; you: string; old?: boolean }) {
  const { t } = useI18n();
  const now = new Date();
  const at = when(stampOf(entry.id), now);
  return (
    <div className="timeline-detail" data-old={old || undefined}>
      <div className="timeline-pics">
        <Won entry={entry} threadId={threadId} />
        {crossedOf(entry).map((each, n) => <Crossed key={n} label={each.label} picture={each.picture} threadId={threadId} />)}
      </div>
      {entry.said !== undefined && <p className="timeline-said"><q>{entry.said}</q><span>{you} · {at}</span></p>}
      {entry.tweaks.length > 0 && (
        <>
          <p className="timeline-section"><Pencil size={12} aria-hidden="true" />{t("timeline.tweaks")}</p>
          <ol className="timeline-tweaks">
            {entry.tweaks.map((tweak, n) => <li key={n}><span>{n + 1}</span><q>{tweak.said}</q><time>{dayOf(tweak.at) === dayOf(entry.id) && timeOf(tweak.at) ? timeOf(tweak.at) : when(stampOf(tweak.at), now)}</time></li>)}
          </ol>
        </>
      )}
      {entry.files.length > 0 && (
        <>
          <p className="timeline-section"><Paperclip size={12} aria-hidden="true" />{t("timeline.screenshots", { when: at })}</p>
          <div className="timeline-shots">{entry.files.map((path) => <span key={path} className="timeline-pic"><Img path={path} threadId={threadId} viewable /></span>)}</div>
        </>
      )}
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

function Thumb({ picture, threadId }: { picture?: Picture; threadId: string }) {
  const [failed, setFailed] = useState(false);
  return picture && !failed
    ? <span className="timeline-pic timeline-thumb"><Img path={picture.path} threadId={threadId} onFail={() => setFailed(true)} /></span>
    : <span className="timeline-pic timeline-thumb" data-text><TextQuote size={16} aria-hidden="true" /></span>;
}

function Won({ entry, threadId }: { entry: Entry; threadId: string }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const badge = <span className="timeline-badge"><Check size={11} aria-hidden="true" />{t("timeline.picked")}</span>;
  return entry.picture && !failed
    ? <span className="timeline-pic timeline-won"><Img path={entry.picture.path} threadId={threadId} onFail={() => setFailed(true)} viewable />{badge}</span>
    : <span className="timeline-pic timeline-won" data-text>{badge}<span>{entry.picked}</span></span>;
}

function Crossed({ label, picture, threadId }: { label: string; picture?: Picture; threadId: string }) {
  const [failed, setFailed] = useState(false);
  if (!picture || failed) return <span data-timeline-out className="timeline-out" data-word><X size={12} aria-hidden="true" /><s>{label}</s></span>;
  return (
    <span data-timeline-out className="timeline-out">
      <span className="timeline-pic">
        <Img path={picture.path} threadId={threadId} onFail={() => setFailed(true)} viewable />
        <svg className="timeline-strike" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><line x1="14" y1="14" x2="86" y2="86" /><line x1="86" y1="14" x2="14" y2="86" /></svg>
      </span>
      <span>{label}</span>
    </span>
  );
}
