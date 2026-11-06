const copy = {
  en: { title: "Live Verify - {site}", unavailable: "Preview unavailable", internal: "Could not finish the check.", "isolation-failed": "The page could not be isolated.", "page-failed": "The page stopped responding.", timeout: "The check ran out of time.", cancelled: "The check was cancelled.", "resource-limit": "The check reached its limit.", "site-changed": "The site changed during the check." },
  ko: { title: "Live Verify - {site}", unavailable: "미리보기를 볼 수 없어요", internal: "검사를 마치지 못했어요.", "isolation-failed": "페이지를 격리하지 못했어요.", "page-failed": "페이지가 응답하지 않아요.", timeout: "검사 시간이 초과됐어요.", cancelled: "검사가 취소됐어요.", "resource-limit": "검사 한도에 도달했어요.", "site-changed": "검사 중 사이트가 변경됐어요." },
};

export function verifyCopy(locale, key, site = "") { return (copy[locale] ?? copy.en)[key]?.replace("{site}", site) ?? copy.en.internal; }
