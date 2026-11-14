import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowUp, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import { mapFlowStages, type MapFlow, type MapPr, type MapReview, type MapStage } from "../../shared/map-flow";
import type { MapWorker } from "../../shared/map-pane";
import { request } from "@/lib/api-request";
import { useI18n } from "@/lib/i18n";
import { mapWorkerColor } from "@/lib/map-worker-colors";
import "./MapGitFlow.css";

const copy = {
  en: {
    git: "Git", commits: (n: number) => n === 1 ? "1 commit" : `${n} commits`, commit: "Commit", none: "none yet", noCommits: "No commits since the worker started",
    pushed: "Pushed", of: (p: number, t: number) => `${p} of ${t}`, pushedOn: (p: number, t: number, branch: string) => `${p} of ${t} commits on ${branch}`,
    pr: "PR", state: { open: "open", draft: "draft", merged: "merged", closed: "closed" }, into: (base: string) => `Into ${base}`,
    checks: "Checks", failing: (n: number) => `${n} failing`, running: (n: number) => `${n} running`, failTip: (name: string) => `Failing: ${name}`, runTip: (name: string) => `Running: ${name}`, passed: (n: number) => `All ${n} passed`, noChecks: "No checks yet",
    review: "Review", waiting: "waiting", changes: "changes asked", approved: "approved", open: (n: number) => `${n} open`, threads: (n: number) => n === 1 ? "1 open thread" : `${n} open threads`, noReviews: "No reviews yet",
    reviewed: { approved: "approved", changes: "asked for changes", commented: "commented", dismissed: "dismissed", pending: "pending" } satisfies Record<MapReview["state"], string>,
    merged: "Merged", closed: "Closed", notYet: "not yet", notMerged: "not merged", mergedInto: (base: string, at: string) => `Merged into ${base} · ${at}`, closedTip: "Closed without merging", openTip: "Not merged yet",
    pushedRow: (p: number, t: number) => `pushed ${p} of ${t}`, noCommitsRow: "no commits yet",
  },
  ko: {
    git: "Git", commits: (n: number) => `커밋 ${n}개`, commit: "커밋", none: "아직 없음", noCommits: "작업 시작 후 커밋이 없어요",
    pushed: "푸시", of: (p: number, t: number) => `${t}개 중 ${p}개`, pushedOn: (p: number, t: number, branch: string) => `${branch}에 커밋 ${t}개 중 ${p}개`,
    pr: "PR", state: { open: "열림", draft: "초안", merged: "병합됨", closed: "닫힘" }, into: (base: string) => `${base}로 병합`,
    checks: "체크", failing: (n: number) => `${n}개 실패`, running: (n: number) => `${n}개 실행 중`, failTip: (name: string) => `실패: ${name}`, runTip: (name: string) => `실행 중: ${name}`, passed: (n: number) => `${n}개 모두 통과`, noChecks: "아직 체크가 없어요",
    review: "리뷰", waiting: "대기 중", changes: "변경 요청", approved: "승인됨", open: (n: number) => `${n}개 열림`, threads: (n: number) => `열린 스레드 ${n}개`, noReviews: "아직 리뷰가 없어요",
    reviewed: { approved: "승인", changes: "변경 요청", commented: "코멘트", dismissed: "취소됨", pending: "대기 중" } satisfies Record<MapReview["state"], string>,
    merged: "병합", closed: "닫힘", notYet: "아직", notMerged: "병합 안 됨", mergedInto: (base: string, at: string) => `${base}에 병합 · ${at}`, closedTip: "병합하지 않고 닫았어요", openTip: "아직 병합 전이에요",
    pushedRow: (p: number, t: number) => `${t}개 중 ${p}개 푸시`, noCommitsRow: "커밋 없음",
  },
};
type Copy = (typeof copy)["en"];
const EVERY = 30_000;
const PRESS = 450;
const DOTS = 6;
const FACES = 3;
const STAGES = 6;
type Seen = { flow: MapFlow; added: ReadonlySet<string>; join: boolean; live: boolean };
type Tip = { id: string; lines: string[]; left?: number; right?: number };
const ended = (pr: MapPr | null) => pr?.state === "merged" || pr?.state === "closed";
const time = (at?: number) => at ? new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
// Review bots by the names people call them.
const BOTS: Record<string, string> = { "chatgpt-codex-connector": "codex", "copilot-pull-request-reviewer": "copilot" };
const person = (login: string) => BOTS[login] ?? login;
const PR_ICON = { open: GitPullRequest, draft: GitPullRequestDraft, merged: GitMerge, closed: GitPullRequestClosed };

function seen(was: Seen | undefined, flow: MapFlow): Seen {
  if (!was) return { flow, added: new Set(), join: false, live: false };
  const old = new Set(was.flow.commits.map(commit => commit.sha));
  return { flow, added: new Set(flow.commits.filter(commit => !old.has(commit.sha)).map(commit => commit.sha)), join: was.join || flow.pr?.state === "merged" && was.flow.pr?.state !== "merged", live: true };
}

function useFlows(base: string | undefined, key: string, active: boolean) {
  const [flows, setFlows] = useState<Record<string, Seen>>({});
  useEffect(() => {
    const ids = key ? key.split("\0") : [];
    if (!base || !active || !ids.length) return;
    const controller = new AbortController();
    const finished = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    const poll = async () => {
      timer = undefined;
      running = true;
      await Promise.all(ids.filter(id => !finished.has(id)).map(id => request(`${base}/flow?${new URLSearchParams({ worker: id })}`, { signal: controller.signal }).then((flow: MapFlow) => {
        if (controller.signal.aborted || !Array.isArray(flow?.commits)) return;
        if (ended(flow.pr)) finished.add(id);
        setFlows(current => ({ ...current, [id]: seen(current[id], flow) }));
      }, () => {})));
      running = false;
      if (!controller.signal.aborted && !document.hidden && ids.some(id => !finished.has(id))) timer = setTimeout(poll, EVERY);
    };
    const visible = () => {
      if (document.hidden) { clearTimeout(timer); timer = undefined; }
      else if (!timer && !running && ids.some(id => !finished.has(id))) void poll();
    };
    void poll();
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [base, key, active]);
  return flows;
}

function text(stage: MapStage, flow: MapFlow, c: Copy): { label: string; number?: number; value: string; tip: string[] } {
  const pr = flow.pr;
  switch (stage.key) {
    case "commit": return { label: flow.total ? c.commits(flow.total) : c.commit, value: flow.commits[0]?.sha.slice(0, 7) ?? c.none, tip: stage.detail.length ? stage.detail : [c.noCommits] };
    case "push": return { label: c.pushed, value: c.of(flow.pushed, flow.total), tip: [c.pushedOn(flow.pushed, flow.total, flow.branch)] };
    case "pr": return { label: c.pr, number: pr!.number, value: c.state[pr!.state], tip: [pr!.title, c.into(pr!.into)].filter(Boolean) };
    case "checks": return {
      label: c.checks,
      value: stage.fail ? c.failing(stage.fail) : stage.pending ? c.running(stage.pending) : stage.total ? `${stage.pass}/${stage.total}` : c.none,
      tip: stage.fail ? stage.detail.map(c.failTip) : stage.pending ? stage.detail.map(c.runTip) : [stage.total ? c.passed(stage.total) : c.noChecks],
    };
    case "review": {
      const who = stage.who ?? [];
      const value = stage.tone === "bad" ? c.changes : stage.tone === "ok" ? c.approved : who.length ? person(who[0]) + (who.length > 1 ? ` +${who.length - 1}` : "") : c.waiting;
      return { label: c.review, value: stage.threads ? `${value} · ${c.open(stage.threads)}` : value,
        tip: [...pr!.reviews.map(review => `${person(review.login)} · ${c.reviewed[review.state]}`), ...stage.threads ? [c.threads(stage.threads)] : []].concat(pr!.reviews.length ? [] : [c.noReviews]) };
    }
    case "merge": return stage.tone === "closed" ? { label: c.closed, value: c.notMerged, tip: [c.closedTip] }
      : { label: c.merged, value: stage.on ? time(stage.at) : c.notYet, tip: [stage.on ? c.mergedInto(pr!.into, stage.at ? new Date(stage.at).toLocaleString() : "") : c.openTip] };
  }
}

function lane(stage: MapStage, { flow, added, join }: Seen): ReactNode {
  const pr = flow.pr;
  switch (stage.key) {
    case "commit": return <>
      <svg className="map-flow-rise" viewBox="0 0 16 30"><path d="M0 25.5L16.5 9H18" /></svg>
      {flow.commits.length > 0 && <span className="map-flow-dots">{flow.commits.slice(0, DOTS).toReversed().map(commit => <i key={commit.sha} data-new={added.has(commit.sha) || undefined} />)}</span>}
    </>;
    case "push": return <span className="map-flow-node"><ArrowUp size={10} strokeWidth={2.75} /></span>;
    case "pr": {
      const Icon = PR_ICON[pr!.state];
      return <span className="map-flow-pill"><Icon size={10} strokeWidth={2.5} />#{pr!.number}</span>;
    }
    case "checks": return pr!.checks.length > 0 && <span className="map-flow-checks">{pr!.checks.filter(check => check.state !== "skip").map((check, index) => <i key={`${check.name}\0${index}`} data-state={check.state} />)}</span>;
    case "review": return pr!.reviews.length > 0 && <span className="map-flow-faces">
      {pr!.reviews.slice(0, FACES).map(review => <i key={review.login} data-state={review.state}>{person(review.login).slice(0, 1).toUpperCase()}</i>)}
      {pr!.reviews.length > FACES && <i>+{pr!.reviews.length - FACES}</i>}
    </span>;
    case "merge": return stage.tone === "merged" ? <>
      <svg className="map-flow-join" viewBox="0 0 24 30" data-join={join || undefined}><path d="M0 9H4.5L21 25.5" pathLength={1} /></svg>
      <span className="map-flow-node" data-tone="merged"><GitMerge size={10} strokeWidth={2.75} /></span>
    </> : stage.tone === "closed" ? <span className="map-flow-node" data-tone="closed"><GitPullRequestClosed size={10} strokeWidth={2.75} /></span>
      : <span className="map-flow-node" data-hollow />;
  }
}

function summary(flow: MapFlow, c: Copy) {
  const pr = flow.pr;
  if (!pr) return flow.pushed ? c.pushedRow(flow.pushed, flow.total) : flow.total ? c.commits(flow.total) : c.noCommitsRow;
  const stages = mapFlowStages(flow);
  const checks = stages.find(stage => stage.key === "checks")!;
  const review = stages.find(stage => stage.key === "review")!;
  const head = `#${pr.number}`;
  if (checks.fail) return `${head} · ${c.failing(checks.fail)}`;
  if (pr.state !== "open") return `${head} ${c.state[pr.state]}`;
  if (review.tone === "bad") return `${head} · ${c.changes}`;
  if (checks.pending) return `${head} · ${c.running(checks.pending)}`;
  if (review.tone === "ok") return `${head} · ${c.approved}`;
  if (pr.threads) return `${head} · ${c.open(pr.threads)}`;
  return `${head} ${c.state.open}`;
}

// Done stages fill whole; a push before the PR or checks still running fill part way and stop the fill there.
function fills(flow: MapFlow, stages: MapStage[]) {
  const reach = stages.findLastIndex(stage => stage.on);
  let stop = false;
  return stages.map((stage, index) => {
    if (stop || index > reach + 1) return 0;
    const part = stage.key === "push" && !flow.pr && flow.pushed < flow.total ? flow.pushed / flow.total
      : stage.key === "checks" && stage.pending && !ended(flow.pr) ? (stage.pass! + stage.fail!) / stage.total! : undefined;
    stop = part !== undefined;
    return part ?? Number(index <= reach);
  });
}

const failing = (flow: MapFlow) => mapFlowStages(flow).some(stage => stage.key === "checks" && stage.fail);

function rowTone(flow: MapFlow): string | undefined {
  const pr = flow.pr;
  if (!pr) return undefined;
  if (failing(flow)) return "bad";
  const stages = mapFlowStages(flow);
  return pr.state === "open" ? stages.find(stage => stage.key === "review")?.tone === "bad" ? "bad" : stages.find(stage => stage.key === "checks")?.tone ?? "open" : pr.state;
}

export function MapGitFlow({ base, workers, slots, worker, all, active }: { base?: string; workers: MapWorker[]; slots: ReadonlyMap<string, number>; worker: string; all: boolean; active: boolean }) {
  const { locale } = useI18n();
  const c = copy[locale];
  const shown = (all ? workers : workers.filter(item => item.id === worker)).filter(item => item.git);
  const flows = useFlows(base, shown.map(item => item.id).join("\0"), active);
  const [tip, setTip] = useState<Tip | null>(null);
  const press = useRef<{ timer?: ReturnType<typeof setTimeout>; held: boolean }>({ held: false });
  useEffect(() => () => clearTimeout(press.current.timer), []);
  if (!shown.length) return null;

  const show = (id: string, lines: string[], target: HTMLElement) => {
    if (target.classList.contains("map-flow-row")) return setTip({ id, lines, left: 0 });
    const box = target.offsetParent instanceof HTMLElement ? target.offsetParent.clientWidth : 0;
    const right = target.offsetLeft + target.offsetWidth / 2 > box / 2;
    setTip(right ? { id, lines, right: Math.max(0, box - target.offsetLeft - target.offsetWidth) } : { id, lines, left: target.offsetLeft });
  };
  const hide = (id: string) => setTip(current => current?.id === id ? null : current);
  const hover = (id: string, lines: string[]) => ({
    onPointerOver: (event: React.PointerEvent<HTMLElement>) => { if (event.pointerType !== "touch" && tip?.id !== id) show(id, lines, event.currentTarget); },
    onPointerLeave: () => hide(id),
    onFocus: (event: React.FocusEvent<HTMLElement>) => show(id, lines, event.currentTarget),
    onBlur: () => hide(id),
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (event.pointerType !== "touch") return;
      const target = event.currentTarget;
      clearTimeout(press.current.timer);
      press.current = { held: false, timer: setTimeout(() => { press.current.held = true; show(id, lines, target); }, PRESS) };
    },
    onPointerUp: () => {
      clearTimeout(press.current.timer);
      if (press.current.held) press.current.timer = setTimeout(() => hide(id), 1600);
    },
    onPointerCancel: () => { clearTimeout(press.current.timer); hide(id); },
    onContextMenu: (event: React.MouseEvent) => { if (press.current.held) event.preventDefault(); },
    onClick: (event: React.MouseEvent) => { if (press.current.held) { event.preventDefault(); press.current.held = false; } },
  });
  const link = (url: string | undefined) => url ? { href: url, target: "_blank", rel: "noreferrer" } : { tabIndex: 0 };
  const tipFor = (id: string) => tip?.id === id && <div className="map-flow-tip" role="tooltip" style={{ left: tip.left, right: tip.right }}>{tip.lines.map((line, index) => <p key={index}>{line}</p>)}</div>;

  if (shown.length === 1) {
    const item = shown[0];
    const state = flows[item.id];
    if (!state) return null;
    const stages = mapFlowStages(state.flow);
    const fill = fills(state.flow, stages);
    return <section className="map-flow" aria-label={c.git} data-n={stages.length} data-tone={rowTone(state.flow)} data-live={state.live || undefined}>
      {stages.map((stage, index) => {
        const { label, number, value, tip: lines } = text(stage, state.flow, c);
        const Tag = stage.url ? "a" : "span";
        const key = `${item.id}:${stage.key}`;
        return <Tag key={stage.key} className="map-flow-stage" data-k={stage.key} data-on={stage.on || undefined} data-tone={stage.tone} data-end={!state.flow.pr && index === stages.length - 1 || undefined}
          style={{ "--fill": fill[index] } as CSSProperties} aria-label={`${label}${number ? ` #${number}` : ""}, ${value}`} {...link(stage.url)} {...hover(key, lines)}>
          <span className="map-flow-lane" aria-hidden="true">{lane(stage, state)}</span>
          <b>{label}{number && <span> #{number}</span>}</b><small>{value}</small>
        </Tag>;
      })}
      {tip && tip.id.startsWith(`${item.id}:`) && tipFor(tip.id)}
    </section>;
  }

  const rows = shown.flatMap(item => flows[item.id] ? [{ item, state: flows[item.id] }] : [])
    .toSorted((a, b) => Number(failing(b.state.flow)) - Number(failing(a.state.flow)));
  return <section className="map-flow-rows" aria-label={c.git}>
    {rows.map(({ item, state }) => {
      const { flow } = state;
      const stages = mapFlowStages(flow);
      const pr = flow.pr;
      const tone = rowTone(flow);
      const lines = stages.flatMap(stage => stage.key === "checks" || stage.key === "review" || stage.key === "commit" && !pr ? text(stage, flow, c).tip : []);
      const key = `${item.id}:row`;
      const color = mapWorkerColor(slots.get(item.id) ?? 99);
      const Icon = pr && PR_ICON[pr.state];
      return <a key={item.id} className="map-flow-row" data-tone={tone} style={{ "--flow-line": color } as CSSProperties} aria-label={`${item.nick}, ${summary(flow, c)}`} {...link(pr?.url ?? stages.findLast(stage => stage.url)?.url)} {...hover(key, lines)}>
        <i /><b>{item.nick}</b>
        <span className="map-flow-mini" aria-hidden="true">
          <svg className="map-flow-rise" viewBox="0 0 12 18"><path d="M1 15.5L10.5 6H12" /></svg>
          <span className="map-flow-thread" data-end={!pr || undefined} style={{ "--fill": fills(flow, stages).reduce((sum, part) => sum + part, 0) / STAGES } as CSSProperties}>
            {flow.commits.slice(0, DOTS).toReversed().map(commit => <i key={commit.sha} data-new={state.added.has(commit.sha) || undefined} />)}
            {Icon && <span className="map-flow-badge" data-tone={pr.state}><Icon size={8} strokeWidth={3} /></span>}
            {pr?.checks.filter(check => check.state !== "skip").map((check, index) => <u key={`${check.name}\0${index}`} data-state={check.state} />)}
          </span>
          {pr?.state === "merged" && <svg className="map-flow-join" viewBox="0 0 16 18" data-join={state.join || undefined}><path d="M0 6H4.5L14 15.5" pathLength={1} /></svg>}
        </span>
        <small data-tone={tone}>{summary(flow, c)}</small>
        {tipFor(key)}
      </a>;
    })}
  </section>;
}
