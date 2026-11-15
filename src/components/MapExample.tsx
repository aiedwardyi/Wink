import { useEffect, useMemo, useState, type ComponentProps } from "react";
import type { MapDiffLine, MapWorker } from "../../shared/map-pane";
import { useI18n } from "@/lib/i18n";
import { treeIndex } from "@/lib/map-tree";
import { MapTree } from "./MapTree";

const copy = {
  en: { line: "Your workers' changes show here live", label: "Example", nick: "worker" },
  ko: { line: "작업자가 바꾼 내용이 여기에 실시간으로 보여요", label: "예시", nick: "작업자" },
};
const EVERY = 2400;
const INDEX = treeIndex("my-app", ["README.md", "package.json", "src/App.tsx", "src/api.ts", "src/styles.css"]);
const SLOTS = new Map([["example", 0]]);
const EDITS: { path: string; lines: MapDiffLine[] }[] = [
  { path: "src/App.tsx", lines: [{ kind: "context", line: 12, text: "  <Header />" }, { kind: "remove", line: 13, text: "  <List items={all} />" }, { kind: "add", line: 13, text: "  <List items={visible} />" }] },
  { path: "src/api.ts", lines: [{ kind: "context", line: 4, text: "export async function load() {" }, { kind: "add", line: 5, text: '  const res = await fetch("/items");' }, { kind: "add", line: 6, text: "  return res.json();" }] },
];
const FILES = EDITS.map(edit => ({ path: edit.path, added: 1, removed: 0 }));
const NONE: never[] = [];
const open = () => {};

export function MapExample({ labels, active }: { labels: ComponentProps<typeof MapTree>["labels"]; active: boolean }) {
  const { locale } = useI18n();
  const c = copy[locale];
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    if (!active || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
    const timer = setInterval(() => setTurn(turn => turn + 1), EVERY);
    return () => clearInterval(timer);
  }, [active]);
  const edit = EDITS[turn % EDITS.length];
  const workers = useMemo<MapWorker[]>(() => [{ id: "example", nick: c.nick, git: true, editedAt: turn + 1, path: edit.path, files: FILES }], [c.nick, turn, edit.path]);
  const current = useMemo(() => ({ path: edit.path, worker: "example", at: turn + 1 }), [edit.path, turn]);
  return <div className="map-example">
    <p>{c.line}</p>
    <div inert>
      <small>{c.label}</small>
      <MapTree index={INDEX} workers={workers} team={false} slots={SLOTS} clashes={NONE} current={current} selected={null} follow labels={labels} onOpen={open} />
      <div className="map-code">{edit.lines.map((line, index) => <div key={index} className="map-code-row" data-kind={line.kind}><u>{line.line}</u><b>{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : ""}</b><code>{line.text}</code></div>)}</div>
    </div>
  </div>;
}
