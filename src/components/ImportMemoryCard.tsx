import { Check, ChevronDown, ChevronRight, ChevronUp, Import, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { aboutYouNote, UNNAMED_SOURCE } from "../../shared/about-you-note";
import { PRIMARY_BUTTON } from "@/lib/button-style";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { api, useStore } from "@/state/store";
import { ImportPromptBox, SkippedLines } from "./AboutYouCard";
import { DETAILS_INPUT, FitTextarea } from "./BotDetailsRows";
import { StepMark } from "./DeviceSetupParts";
import { Fold } from "./Fold";
import { ImportProviderButtons } from "./ImportProviderButtons";
import { SegmentedRow } from "./Segmented";
import { ROW_BUTTON } from "./SettingsPrimitives";

type Scope = "all" | "bot";
type Added = { source: string; added: number; found: number; hidden: number; flagged?: string[] };
type Saved = Added & { scope: Scope; id: number };

// phone hit areas reach 40 px; the look at rest stays the mock's
const LINK = "relative text-accent-text hover:underline focus-visible:underline focus-visible:outline-none [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-y-2.5 [@media(pointer:coarse)]:after:inset-x-0";
const ICON_BUTTON = "relative flex size-8 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink focus-visible:bg-control focus-visible:text-ink [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1";
// the pills' group scrolls sideways, which would clip their hit area; two short pills never need to scroll here,
// and the thumb's shadow stays cut at the group's edge as the scroll clip cut it
const SCOPE_HIT = "[@media(pointer:coarse)]:[&_[role=radiogroup]]:overflow-visible [@media(pointer:coarse)]:[&_[data-segmented-thumb]]:[clip-path:inset(-3px_round_var(--radius-lg))] [@media(pointer:coarse)]:[&_[role=radio]]:after:absolute [@media(pointer:coarse)]:[&_[role=radio]]:after:inset-x-0 [@media(pointer:coarse)]:[&_[role=radio]]:after:-inset-y-[6.5px] [@media(pointer:coarse)]:[&_[role=radio]]:after:z-10";

// the last answers, so a chat opened after them paints the row without waiting
let offered: boolean | null = null;
const ownImport = new Set<string>();
// each dismissal, so a lookup that was already out when the row was dismissed cannot bring it back
let dismissals = 0;

export type ImportOffer = { offer: boolean | null; close: () => void };

/** A chat with nothing in it yet offers the import while Import Memory is empty, this bot holds no import of its own and it was never dismissed; null until known. */
export function useImportOffer(botId: string, fresh: boolean): ImportOffer {
  const [offer, setOffer] = useState(offered && !ownImport.has(botId));
  useEffect(() => {
    if (!fresh) return;
    let gone = false;
    const asked = dismissals;
    void api(`/api/about-you?bot=${encodeURIComponent(botId)}`).then((body) => {
      if (dismissals !== asked) return;
      offered = Array.isArray(body?.sources) && !body.sources.length && body.declined !== true;
      if (body?.imported === true) ownImport.add(botId);
      if (!gone) setOffer(offered && !ownImport.has(botId));
    }).catch(() => {
      if (!gone) setOffer(false);
    });
    return () => {
      gone = true;
    };
  }, [botId, fresh]);
  return { offer: fresh ? offer : false, close: () => setOffer(false) };
}

function Step({ step, title, children }: { step: number; title: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-2.5">
      <StepMark done={false} step={step} label={title} className="size-5 text-[11px]" />
      <div className="flex min-w-0 flex-col gap-2.5">
        <div className="break-keep text-[13px] font-semibold leading-5 text-ink">{title}</div>
        {children}
      </div>
    </div>
  );
}

/** Before a chat's first message: bring what another AI knows about the user, for every bot or only this one. */
export function ImportMemoryCard({ botId, onClose }: { botId: string; onClose: () => void }) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState(false);
  const [text, setText] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState<Saved | null>(null);
  const saves = useRef(0);

  const dismiss = () => {
    offered = false;
    dismissals++;
    onClose();
    void api("/api/about-you/decline", { method: "POST" }).catch(() => {});
  };

  const paste = async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (clip) setText(clip);
    } catch {
      /* clipboard read can be denied; the box still takes a paste */
    }
  };

  const route = (to: Scope) => (to === "all" ? "/api/about-you" : `/api/bots/${botId}/memory/import`);

  const add = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setNote("");
    try {
      const body: Added = await api(route(scope), { method: "POST", body: JSON.stringify({ text }) });
      // lines held back for Keep still open the saved box, where the user can bring them in
      if (!body.added && !body.flagged?.length) setNote(aboutYouNote(body, t));
      else {
        // the card stays gone once this paste put something in memory; flagged lines alone wait for Keep
        if (body.added) {
          if (scope === "all") offered = false;
          else ownImport.add(botId);
        }
        setSaved({ ...body, scope, id: ++saves.current });
        setText("");
        setPrompt(false);
      }
    } catch (error) {
      setNote((error as { status?: number }).status === 413 ? t("aboutYou.tooLarge") : t("aboutYou.failed"));
    } finally {
      setBusy(false);
    }
  };

  // a kept line goes to the scope the paste went to, under the same source
  const keep = async (line: string) => {
    if (!saved) return;
    const body: Added = await api(route(saved.scope), { method: "POST", body: JSON.stringify({ keep: [line], source: saved.source }) });
    if (body.added) {
      if (saved.scope === "all") offered = false;
      else ownImport.add(botId);
    }
    // only the box this Keep started from counts it: another import may be on screen by now
    setSaved((before) => (before?.id === saved.id ? { ...before, added: before.added + body.added } : before));
  };

  if (saved) {
    const source = saved.source === UNNAMED_SOURCE ? t("importCard.anotherAi") : saved.source;
    return (
      <section data-import-saved role="status" className="w-full max-w-[560px] rounded-xl border border-success/30 bg-success/10 py-3 pl-[18px] pr-2 text-ink">
        <div className="flex items-start gap-3">
          <Check size={16} aria-hidden className="mt-0.5 shrink-0 text-success" />
          <div className="min-w-0 flex-1 break-keep">
            <div className="text-[13.5px] leading-5">
              <span className="font-semibold">{saved.added === 1 ? t("importCard.addedOne", { source }) : t("importCard.added", { count: saved.added, source })}</span>
              <span className="text-ink-secondary"> · {saved.scope === "all" ? t("importCard.allBots") : t("importCard.savedThisBot")}</span>
            </div>
            {saved.hidden > 0 && <div className="mt-0.5 text-[12.5px] text-ink-secondary">{t("aboutYou.hidden", { count: saved.hidden })}</div>}
            {Boolean(saved.flagged?.length) && <SkippedLines lines={saved.flagged!} keep={keep} className="mt-0.5" />}
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
              <button type="button" className={LINK} onClick={() => dispatch(saved.scope === "all" ? { type: "toggleAppSettings", open: true, section: "about-you" } : { type: "toggleSettings", open: true, memory: { line: "" } })}>
                {t("importCard.viewSettings")}
              </button>
              <button type="button" className={LINK} onClick={() => {
                setSaved(null);
                setOpen(true);
              }}>
                {t("importCard.another")}
              </button>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label={t("importCard.close")} className={cn(ICON_BUTTON, "-mt-1.5")}>
            <X size={16} aria-hidden />
          </button>
        </div>
      </section>
    );
  }

  return (
    <section data-import-card className="w-full max-w-[560px] overflow-hidden rounded-xl border border-hairline bg-card text-ink">
      <div className="flex items-center gap-1 py-[11px] pl-[14px] pr-2">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
          <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-raised text-ink-secondary">
            <Import size={16} />
          </span>
          <span className="min-w-0 flex-1 break-keep">
            <span className="block text-[14px] font-semibold leading-5">{t("importCard.title")}</span>
            <span className="block text-[12.5px] leading-[18px] text-ink-secondary">{t("importCard.subtitle")}</span>
          </span>
          <span aria-hidden className="flex size-8 shrink-0 items-center justify-center text-ink-secondary">
            {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </span>
        </button>
        <button type="button" onClick={dismiss} aria-label={t("importCard.dismiss")} className={ICON_BUTTON}>
          <X size={16} aria-hidden />
        </button>
      </div>
      <Fold open={open}>
        <div className="flex flex-col gap-[22px] border-t border-hairline/60 px-[18px] pb-[18px] pt-4">
          <Step step={1} title={t("importCard.step1")}>
            <ImportProviderButtons prompt={t("aboutYou.prompt")} copy />
            {/* the chips' hit area takes the gap above, so this one grows down to 40 px */}
            <button type="button" onClick={() => setPrompt(!prompt)} aria-expanded={prompt} className="relative flex w-fit items-center gap-1.5 text-[12.5px] text-ink-secondary hover:text-ink focus-visible:text-ink focus-visible:outline-none [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:inset-x-0 [@media(pointer:coarse)]:after:-top-0.5 [@media(pointer:coarse)]:after:-bottom-[19px]">
              {prompt ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
              {prompt ? t("importCard.hidePrompt") : t("importCard.showPrompt")}
            </button>
            <Fold open={prompt}>
              <ImportPromptBox />
            </Fold>
          </Step>
          <Step step={2} title={t("importCard.step2")}>
            <FitTextarea
              className={cn(DETAILS_INPUT, "max-h-[240px] min-h-[76px] overflow-y-auto")}
              value={text}
              placeholder={t("importCard.placeholder")}
              aria-label={t("importCard.step2")}
              disabled={busy}
              onChange={(event) => {
                setText(event.target.value);
                setNote("");
              }}
            />
            {text.trim() && (
              <div className={SCOPE_HIT}>
                <SegmentedRow
                  label={t("importCard.useFor")}
                  hint={t("importCard.useForHint")}
                  value={scope}
                  options={[{ id: "all", label: t("importCard.allBots") }, { id: "bot", label: t("importCard.thisBot") }]}
                  onChange={setScope}
                />
              </div>
            )}
            {note && <div role="status" className="text-[13px] text-ink">{note}</div>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => void paste()} disabled={busy} className={cn(ROW_BUTTON, "h-8 px-3 text-ink")}>
                {t("importCard.paste")}
              </button>
              <button type="button" onClick={() => void add()} disabled={busy || !text.trim()} className={cn(ROW_BUTTON, PRIMARY_BUTTON, "h-8 border-transparent px-3 font-medium text-accent-ink not-disabled:hover:bg-accent")}>
                {t("importCard.add")}
              </button>
            </div>
          </Step>
        </div>
      </Fold>
    </section>
  );
}
