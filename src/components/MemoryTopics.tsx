import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { formatBytes, type MemoryTopic } from "./MemoryGroups";

/** A file opens under its row, so nothing needs a Back. */
export function TopicRows({ botId, topics }: { botId: string; topics: MemoryTopic[] }) {
  const [shown, setShown] = useState<{ name: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const list = useRef<HTMLUListElement>(null);
  const picked = useRef<string | null>(null);

  // show the file just opened; closing one above it also moves its row, maybe out of view
  useLayoutEffect(() => {
    if (picked.current === null) return;
    const row = [...(list.current?.querySelectorAll<HTMLElement>("[data-topic]") ?? [])].find((each) => each.dataset.topic === picked.current);
    picked.current = null;
    (row?.nextElementSibling ?? row)?.scrollIntoView({ block: "nearest" });
  }, [shown]);

  const open = async (name: string) => {
    const mine = ++request.current;
    setError(null);
    if (shown?.name === name) {
      setShown(null);
      return;
    }
    try {
      const result: { name: string; text: string } = await api(`/api/bots/${botId}/memory/topics/${encodeURIComponent(name)}`);
      if (mine === request.current) setShown(result);
    } catch (e) {
      if (mine === request.current) setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <ul ref={list} className="mm-list mm-topics">
      {topics.map((entry) => {
        const here = shown?.name === entry.name;
        return (
          <li key={entry.name}>
            <button type="button" className="mm-topic" data-topic={entry.name} aria-expanded={here} onClick={() => { picked.current = entry.name; void open(entry.name); }}>
              <span className="mm-list-text">{entry.name}</span>
              <span className="mm-date">{formatBytes(entry.bytes)}</span>
              <ChevronDown size={14} aria-hidden="true" className={cn("mm-chev transition-transform motion-reduce:transition-none", here && "rotate-180")} />
            </button>
            {here && (
              <div className="col-span-full my-2 animate-fade-in scroll-mt-12 whitespace-pre-wrap break-words rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] leading-relaxed text-ink">
                {shown.text}
              </div>
            )}
          </li>
        );
      })}
      {error && <li className="text-[12px] text-danger">{error}</li>}
    </ul>
  );
}
