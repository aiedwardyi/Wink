import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { mapFlowStages, type MapFlow, type MapPr, type MapReview, type MapStage } from "../../shared/map-flow";
import type { MapWorker } from "../../shared/map-pane";
import { request } from "@/lib/api-request";
import { useI18n } from "@/lib/i18n";
import { mapClashes } from "@/lib/map-tree";
import { mapWorkerColor } from "@/lib/map-worker-colors";
import "./MapGitFlow.css";

const copy = {
  en: {
    git: "Git", commits: (n: number) => n === 1 ? "1 commit" : `${n} commits`, noCommits: "No commits since the worker started",
    files: (n: number) => n === 1 ? "1 file changed" : `${n} files changed`, noFiles: "No edits yet", pushedOn: (p: number, t: number, branch: string) => `${p} of ${t} commits on ${branch}`,
    state: { open: "open", draft: "draft", merged: "merged", closed: "closed" }, into: (base: string) => `Into ${base}`, noPr: "No PR yet",
    failing: (n: number) => `${n} failing`, fail: (n: number) => `${n} fail`, running: (n: number) => `${n} running`, passing: "passed", failTip: (name: string) => `Failing: ${name}`, runTip: (name: string) => `Running: ${name}`, passed: (n: number) => `All ${n} passed`, noChecks: "No checks yet",
    changes: "changes asked", approved: "approved", open: (n: number) => `${n} open`, threads: (n: number) => n === 1 ? "1 open thread" : `${n} open threads`, noReviews: "No reviews yet",
    reviewed: { approved: "approved", changes: "asked for changes", commented: "commented", dismissed: "dismissed", pending: "pending" } satisfies Record<MapReview["state"], string>,
    closed: "Closed", mergedInto: (base: string, at: string) => `Merged into ${base} · ${at}`, closedTip: "Closed without merging", openTip: "Not merged yet",
    pushedRow: (p: number, t: number) => `pushed ${p} of ${t}`, noCommitsRow: "no commits yet",
    stops: { code: "Coding", commit: "Commit", push: "Push", pr: "PR", checks: "Checks", review: "Review", merge: "Merged" },
    clash: (n: number) => n === 1 ? "⚠ 1 file" : `⚠ ${n} files`, also: (who: string) => `Also edited by ${who}`,
  },
  ko: {
    git: "Git", commits: (n: number) => `커밋 ${n}개`, noCommits: "작업 시작 후 커밋이 없어요",
    files: (n: number) => `파일 ${n}개 변경`, noFiles: "아직 수정이 없어요", pushedOn: (p: number, t: number, branch: string) => `${branch}에 커밋 ${t}개 중 ${p}개`,
    state: { open: "열림", draft: "초안", merged: "병합됨", closed: "닫힘" }, into: (base: string) => `${base}로 병합`, noPr: "아직 PR이 없어요",
    failing: (n: number) => `${n}개 실패`, fail: (n: number) => `${n}개 실패`, running: (n: number) => `${n}개 실행 중`, passing: "통과", failTip: (name: string) => `실패: ${name}`, runTip: (name: string) => `실행 중: ${name}`, passed: (n: number) => `${n}개 모두 통과`, noChecks: "아직 체크가 없어요",
    changes: "변경 요청", approved: "승인됨", open: (n: number) => `${n}개 열림`, threads: (n: number) => `열린 스레드 ${n}개`, noReviews: "아직 리뷰가 없어요",
    reviewed: { approved: "승인", changes: "변경 요청", commented: "코멘트", dismissed: "취소됨", pending: "대기 중" } satisfies Record<MapReview["state"], string>,
    closed: "닫힘", mergedInto: (base: string, at: string) => `${base}에 병합 · ${at}`, closedTip: "병합하지 않고 닫았어요", openTip: "아직 병합 전이에요",
    pushedRow: (p: number, t: number) => `${t}개 중 ${p}개 푸시`, noCommitsRow: "커밋 없음",
    stops: { code: "코딩", commit: "커밋", push: "푸시", pr: "PR", checks: "체크", review: "리뷰", merge: "병합" },
    clash: (n: number) => `⚠ 파일 ${n}개`, also: (who: string) => `${who}도 수정 중`,
  },
};
type Copy = (typeof copy)["en"];
const EVERY = 30_000;
const PRESS = 450;
// The line takes the color of the last stage reached: white-gray before the PR, green from the PR on, purple once merged.
const FILL = ["ink", "ink", "ink", "open", "open", "open", "merged"];
type Stop = { key: keyof Copy["stops"]; state?: string; tip: string[] };
type Tip = { id: string; lines: string[]; top: number; left?: number; right?: number };
const ended = (pr: MapPr | null) => pr?.state === "merged" || pr?.state === "closed";
// Review bots by the names people call them.
const BOTS: Record<string, string> = { "chatgpt-codex-connector": "codex", "copilot-pull-request-reviewer": "copilot" };
const person = (login: string) => BOTS[login] ?? login;

function useFlows(base: string | undefined, key: string, active: boolean) {
  const [flows, setFlows] = useState<Record<string, MapFlow>>({});
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
        setFlows(current => ({ ...current, [id]: flow }));
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

// Every row has the same seven stops; a stop has a state only once it has happened.
function stops(item: MapWorker, flow: MapFlow, stages: MapStage[], c: Copy): Stop[] {
  const pr = flow.pr;
  const at = (key: MapStage["key"]) => stages.find(stage => stage.key === key);
  const checks = at("checks");
  const review = at("review");
  const merge = at("merge");
  return [
    { key: "code", state: item.files.length || flow.total || pr ? "on" : undefined, tip: [item.files.length ? c.files(item.files.length) : c.noFiles] },
    { key: "commit", state: flow.total || pr ? "on" : undefined, tip: flow.total ? [c.commits(flow.total), ...at("commit")!.detail] : [c.noCommits] },
    { key: "push", state: flow.pushed || pr ? "on" : undefined, tip: [c.pushedOn(flow.pushed, flow.total, flow.branch)] },
    { key: "pr", state: pr ? "on" : undefined, tip: pr ? [`#${pr.number} ${pr.title}`, c.into(pr.into)] : [c.noPr] },
    { key: "checks", state: checks?.total ? checks.tone : undefined,
      tip: checks?.fail ? checks.detail.map(c.failTip) : checks?.pending ? checks.detail.map(c.runTip) : [checks?.total ? c.passed(checks.total) : c.noChecks] },
    { key: "review", state: review?.tone === "bad" ? "bad" : review?.tone === "ok" ? "on" : review?.on || review?.threads ? "half" : undefined,
      tip: pr ? [...pr.reviews.map(each => `${person(each.login)} · ${c.reviewed[each.state]}`), ...pr.threads ? [c.threads(pr.threads)] : []].concat(pr.reviews.length ? [] : [c.noReviews]) : [c.noReviews] },
    { key: "merge", state: merge?.on ? merge.tone : undefined,
      tip: [merge?.tone === "closed" ? c.closedTip : merge?.on ? c.mergedInto(pr!.into, merge.at ? new Date(merge.at).toLocaleString() : "") : c.openTip] },
  ];
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
  // The files a worker shares with another worker, as the Map marks them on the tree.
  const shared = useMemo(() => {
    const nick = new Map(workers.map(item => [item.id, item.nick]));
    const by = new Map<string, { paths: Set<string>; who: Set<string> }>();
    for (const clash of mapClashes(workers)) for (const id of clash.ids) {
      const entry = by.get(id) ?? { paths: new Set(), who: new Set() };
      entry.paths.add(clash.path);
      for (const other of clash.ids) if (other !== id) entry.who.add(nick.get(other) ?? other);
      by.set(id, entry);
    }
    return by;
  }, [workers]);
  const [tip, setTip] = useState<Tip | null>(null);
  const press = useRef<{ timer?: ReturnType<typeof setTimeout>; held: boolean }>({ held: false });
  useEffect(() => () => clearTimeout(press.current.timer), []);
  if (!shown.length) return null;

  // The tip sits outside the scrolling list, under the row, so the list never clips it.
  const show = (id: string, lines: string[], target: HTMLElement) => {
    const box = target.closest(".map-flow-rows")?.getBoundingClientRect();
    const row = target.closest(".map-flow-row")?.getBoundingClientRect();
    if (!box || !row) return;
    const at = target.getBoundingClientRect();
    const top = row.bottom - box.top - 2;
    setTip(at.left + at.width / 2 - box.left > box.width / 2 ? { id, lines, top, right: Math.max(0, box.right - at.right) } : { id, lines, top, left: at.left - box.left });
  };
  const hide = (id: string) => setTip(current => current?.id === id ? null : current);
  const hover = (id: string, lines: string[]) => ({
    onPointerOver: (event: React.PointerEvent<HTMLElement>) => { if (event.pointerType !== "touch" && tip?.id !== id) show(id, lines, event.currentTarget); },
    onPointerLeave: () => hide(id),
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

  const rows = shown.flatMap(item => flows[item.id] ? [{ item, flow: flows[item.id] }] : [])
    .toSorted((a, b) => Number(failing(b.flow)) - Number(failing(a.flow)));
  if (!rows.length) return null;
  return <section className="map-flow-rows" aria-label={c.git}><div className="map-flow-list">
    {rows.map(({ item, flow }) => {
      const pr = flow.pr;
      const stages = mapFlowStages(flow);
      const list = stops(item, flow, stages, c);
      const reach = list.findLastIndex(stop => stop.state && stop.state !== "closed");
      const checks = pr?.checks.filter(check => check.state !== "skip") ?? [];
      const box = stages.find(stage => stage.key === "checks");
      const status = box?.fail ? c.fail(box.fail) : box?.pending ? c.running(box.pending) : box?.total ? c.passing : "";
      const clash = shared.get(item.id);
      const tone = rowTone(flow);
      const color = mapWorkerColor(slots.get(item.id) ?? 99);
      // Keyboard focus on the row shows what the stops say on hover.
      const lines = [...list.flatMap(stop => (pr ? stop.key === "checks" || stop.key === "review" : stop.key === "commit") ? stop.tip : []), ...clash ? [c.also([...clash.who].join(", "))] : []];
      return <a key={item.id} className="map-flow-row" data-tone={tone} style={{ "--flow-line": color } as CSSProperties} aria-label={`${item.nick}, ${summary(flow, c)}`} {...link(pr?.url ?? stages.findLast(stage => stage.url)?.url)}
        onFocus={event => { if (event.currentTarget.matches(":focus-visible")) show(`${item.id}:row`, lines, event.currentTarget); }} onBlur={() => hide(`${item.id}:row`)}>
        <i /><b>{item.nick}</b>
        <span className="map-flow-stops" data-reach={reach} data-fill={FILL[reach]} aria-hidden="true">
          {list.map((stop, index) => <Fragment key={stop.key}>
            {index > 0 && <i data-on={index <= reach || undefined} />}
            {stop.key === "checks"
              ? <span className="map-flow-box" data-k={stop.key} data-state={stop.state} {...hover(`${item.id}:${stop.key}`, stop.tip)}>
                <b>{c.stops.checks}<span>{status}</span></b>
                <span>{checks.map((check, at) => <i key={`${check.name}\0${at}`} data-state={check.state} />)}</span>
              </span>
              : <span data-k={stop.key} data-state={stop.state} data-line={index < reach ? "through" : index === reach && index > 0 ? "in" : undefined} {...hover(`${item.id}:${stop.key}`, stop.tip)}>
                <small>{stop.state === "closed" ? c.closed : c.stops[stop.key]}</small><i />
              </span>}
          </Fragment>)}
        </span>
        <span className="map-flow-end">
          <small data-tone={tone} data-short={pr ? `#${pr.number}` : undefined}>{summary(flow, c)}</small>
          {clash && <em className="map-flow-clash" data-short={`⚠ ${clash.paths.size}`} {...hover(`${item.id}:clash`, [c.also([...clash.who].join(", ")), ...clash.paths])}>{c.clash(clash.paths.size)}</em>}
        </span>
      </a>;
    })}
  </div>{tip && <div className="map-flow-tip" role="tooltip" style={{ top: tip.top, left: tip.left, right: tip.right }}>{tip.lines.map((line, at) => <p key={at}>{line}</p>)}</div>}</section>;
}
