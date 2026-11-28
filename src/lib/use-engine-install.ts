import { useEffect, useRef, useState } from "react";
import type { InstanceInfo } from "@/state/store";

type Attempt = { until: number; failed?: boolean };

export function useEngineInstall(instances: InstanceInfo[], refresh: () => void | Promise<void>, focus = true) {
  const [attempts, setAttempts] = useState<Record<string, Attempt>>({});
  const latest = useRef({ instances, refresh, attempts });
  latest.current = { instances, refresh, attempts };
  const installing = Object.values(attempts).some((attempt) => !attempt.failed);
  // A failed install window leaves a marker; flip only the attempt that was asked about, not a newer one.
  const checkFailed = (ids: string[]) => {
    const failedCheck = window.ogb?.engineInstallFailed;
    if (!failedCheck) return [];
    return ids.map((id) => {
      const until = latest.current.attempts[id]?.until;
      return failedCheck(id).then((failed) => {
        if (failed) setAttempts((current) => current[id] && current[id].until === until && !current[id].failed
          ? { ...current, [id]: { until: 0, failed: true } } : current);
      }, () => {});
    });
  };
  const activeIds = () => Object.entries(latest.current.attempts).filter(([id, attempt]) => !attempt.failed && Date.now() < attempt.until
    && latest.current.instances.find((row) => row.instanceId === id)?.snapshot.state !== "available").map(([id]) => id);

  useEffect(() => {
    if (!focus) return;
    const onFocus = () => {
      void Promise.resolve().then(() => latest.current.refresh()).catch(() => {});
      void Promise.all(checkFailed(activeIds()));
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [focus]);

  useEffect(() => {
    const installed = instances.filter((row) => row.snapshot.state === "available" && attempts[row.instanceId]);
    if (!installed.length) return;
    setAttempts((current) => {
      const next = { ...current };
      for (const row of installed) delete next[row.instanceId];
      return next;
    });
  }, [instances, attempts]);

  useEffect(() => {
    if (!installing) return;
    let checking = false;
    const timer = setInterval(() => {
      const ids = activeIds();
      if (!ids.length || checking) return;
      checking = true;
      void Promise.all([Promise.resolve().then(() => latest.current.refresh()).catch(() => {}), ...checkFailed(ids)]).finally(() => { checking = false; });
    }, 5000);
    return () => clearInterval(timer);
  }, [installing]);

  useEffect(() => {
    const active = Object.values(attempts).filter((attempt) => !attempt.failed);
    if (!active.length) return;
    const deadline = setTimeout(() => {
      setAttempts((current) => Object.fromEntries(Object.entries(current).map(([id, attempt]) =>
        [id, attempt.until <= Date.now() ? { ...attempt, failed: true } : attempt])));
    }, Math.max(0, Math.min(...active.map((attempt) => attempt.until)) - Date.now()));
    return () => clearTimeout(deadline);
  }, [attempts]);

  const begin = (id: string) => setAttempts((current) => ({ ...current, [id]: { until: Date.now() + 600000 } }));
  const fail = (id: string) => setAttempts((current) => ({ ...current, [id]: { until: 0, failed: true } }));
  return { attempts, begin, fail };
}
