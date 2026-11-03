import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { teamTodaySchema, type TeamToday } from "@/components/TeamSection";

const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;
// Lands just after the server's midnight even when this clock runs a little fast.
const SKEW_MS = 5_000;
const POLL_MS = 30_000;

export function useTeamToday(active: boolean, accountEmail: string | null): TeamToday | null {
  const [today, setToday] = useState<TeamToday | null>(null);
  useEffect(() => {
    setToday(null);
    if (!active) return;
    let gone = false;
    let revision = 0;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      clearTimeout(timer);
      const current = ++revision;
      if (document.visibilityState !== "hidden") void api("/api/team/today").catch(() => null).then((body) => {
        if (!gone && current === revision) setToday(teamTodaySchema.safeParse(body).data ?? null);
      });
      const now = Date.now();
      timer = setTimeout(refresh, Math.min(POLL_MS, DAY_MS - ((now + KST_MS) % DAY_MS) + SKEW_MS));
    };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      gone = true;
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [active, accountEmail]);
  return today;
}
