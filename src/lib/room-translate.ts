import { useEffect, useRef, useState } from "react";

import { request } from "./api-request";
import type { LocaleId } from "./i18n";

export function alreadyInLanguage(text: string, lang: LocaleId): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  const hangul = letters.filter((letter) => /\p{Script=Hangul}/u.test(letter)).length;
  return lang === "en" ? hangul === 0 : hangul >= letters.length / 2;
}

export function translateLine(base: string, entryId: string, lang: LocaleId): Promise<{ text: string }> {
  return request(`${base}/entries/${entryId}/translate`, { method: "POST", body: JSON.stringify({ lang }) });
}

export function useTranslationAvailable(base: string): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let current = true;
    setAvailable(false);
    const check = () => {
      void request(`${base}/translate`).then((body) => { if (current) setAvailable(body.available === true); }, () => { if (current) setAvailable(false); });
    };
    check();
    window.addEventListener("focus", check);
    return () => { current = false; window.removeEventListener("focus", check); };
  }, [base]);
  return available;
}

type Translation = { key: string; visible: boolean; pending: boolean; failed: boolean; text?: string };

export function useRoomTranslation(base: string, entryId: string, lang: LocaleId) {
  const key = `${base}/${entryId}/${lang}`;
  const [state, setState] = useState<Translation>({ key, visible: false, pending: false, failed: false });
  const current = state.key === key ? state : { key, visible: false, pending: false, failed: false };
  const latest = useRef<Translation>(current);
  latest.current = current;
  const update = (patch: Partial<Translation>) => {
    if (latest.current.key !== key) return;
    latest.current = { ...latest.current, ...patch };
    setState(latest.current);
  };
  const retry = async () => {
    if (latest.current.pending) return;
    update({ visible: true, pending: true, failed: false });
    try {
      const result = await translateLine(base, entryId, lang);
      update({ text: result.text, pending: false });
    } catch { update({ failed: true, pending: false }); }
  };
  const toggle = () => {
    if (latest.current.visible) update({ visible: false });
    else if (latest.current.text || latest.current.pending) update({ visible: true });
    else void retry();
  };
  return { ...current, toggle, retry };
}
