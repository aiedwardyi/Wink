import { accounts, engines, trace, hourly, usual, daily, now } from "./fixtures.mjs";

const query = new URLSearchParams(location.search);
const ko = query.get("lang") === "ko";
const t = (en, kr) => ko ? kr : en;
const view = query.get("view") || "usage";
document.documentElement.lang = ko ? "ko" : "en";
document.documentElement.dataset.skin = query.get("skin") || "github-dimmed";
let selected = "Claude";
let range = "today";
let pending = false;
const pins = { Claude: null, Codex: null, Grok: null, Gemini: null };
let value = 66;
let quickOpen = true;
let age = 12;
let autoRoute = null;
let receipt = t("Main: next messages only", "기본 계정: 다음 메시지부터");
let main = { Claude: "claude-1", Codex: "codex-1", Grok: "grok-1", Gemini: "gemini-1" };
const app = document.querySelector("#app");
const tile = (number) => `<span class="tile">${number}</span>`;
const account = () => accounts.find((item) => item.id === main[selected]);
const time = (stamp) => new Intl.DateTimeFormat(ko ? "ko-KR" : "en-US", { timeZone: "Asia/Seoul", hour: "numeric", minute: "2-digit", hour12: !ko }).format(stamp);
const shortReset = (window) => window.windowMinutes === 300 ? time(window.resetsAt) : new Intl.DateTimeFormat(ko ? "ko-KR" : "en-US", { timeZone: "Asia/Seoul", weekday: "short", hour: "numeric", minute: "2-digit", hour12: !ko }).format(window.resetsAt);
const left = (window) => 100 - window.usedPercent;
const remaining = (item, window) => item.id === "claude-1" && window.windowMinutes === 300 ? value : left(window);
const percent = (amount) => Number.isInteger(amount) ? amount : amount.toFixed(1);
const projected = (amount) => amount - (69 - amount) * 220 / 30;
const countdown = (stamp) => {
  const minutes = Math.round((stamp - Date.parse("2026-11-05T15:00:00+09:00")) / 60000);
  return `${minutes >= 1440 ? `${Math.floor(minutes / 1440)}d` : ""}${Math.floor(minutes % 1440 / 60)}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
};

function top() {
  return `<header class="top"><div class="top-left"><span class="brand">wink</span><span class="muted">${t("Workspace", "작업 공간")}</span></div><div class="top-right"><span class="desktop-only">${t("Thu, Nov 5", "11월 5일 목요일")}</span><span class="mono">15:00 KST</span></div></header>`;
}

function nav() {
  return `<aside class="nav"><small>${t("WORKSPACE", "작업 공간")}</small><button data-view="chat" class="${view === "chat" ? "selected" : ""}">${t("Chats", "대화")}</button><button data-view="usage" class="${view === "usage" ? "selected" : ""}">${t("Usage", "사용량")}</button><button data-view="details">${t("Connections", "연결")}</button><div class="people"><small>${t("WORKING NOW", "작업 중")}</small><div class="person"><i></i>Mina</div><div class="person"><i></i>Kai</div><div class="person"><i></i>Review</div></div></aside>`;
}

function chart(compact = false) {
  const current = account().id === "claude-1" ? value : null;
  if (current === null) return `<div class="chart muted" style="display:flex;align-items:center">${t("A few readings reveal the pace.", "기록이 쌓이면 추이가 보여요.")}</div>`;
  const forecast = projected(current);
  const canvas = view === "usage" && innerWidth > 700 ? Math.max(300, Math.min(1100, innerWidth - 178) - 364) : 440;
  const end = canvas - 14;
  const x = (minute) => 12 + minute / 700 * (end - 12);
  const y = (remaining) => 20 + (100 - remaining) * 1.08;
  const path = trace.map(([minute, remaining], index) => `${index ? "L" : "M"}${x(minute)},${y(index === trace.length - 1 ? current : remaining)}`).join(" ");
  return `<div class="chart"><svg viewBox="0 0 ${canvas} 155" preserveAspectRatio="none" role="img" aria-label="${t("Remaining allowance with two resets, then estimated pace until reset", "두 번의 초기화와 남은 양 기록, 다음 초기화까지 예상 추이")}"><line class="grid" x1="12" x2="${end}" y1="20" y2="20"/><line class="grid" x1="12" x2="${end}" y1="74" y2="74"/><line class="grid" x1="12" x2="${end}" y1="128" y2="128"/><line class="now" x1="${x(480)}" x2="${x(480)}" y1="12" y2="132"/><path d="${path} L${x(480)},128 L12,128 Z" fill="var(--color-accent)" opacity=".045"/><path class="observed" d="${path}"/><path class="projection" d="M${x(480)},${y(current)} L${end},${y(forecast)}"/><circle cx="${x(480)}" cy="${y(current)}" r="4" fill="var(--color-accent)" stroke="var(--color-panel)" stroke-width="2"/><text x="${x(100) + 4}" y="12">${t("reset", "초기화")}</text><text x="${x(400) - 4}" y="12" text-anchor="end">${t("reset", "초기화")}</text><text x="12" y="150">07:00</text><text x="${x(480)}" y="150" text-anchor="middle">${t("Now", "지금")}</text><text x="${end}" y="150" text-anchor="end">18:40</text><text x="${end}" y="12" text-anchor="end">100%</text><text x="${end}" y="123" text-anchor="end">0%</text></svg></div>${compact ? "" : `<div class="legend"><span><i></i>${t("Reported", "확인된 기록")}</span><span><i class="dotted"></i>${t("Pace estimate", "추이 예상")}</span></div>`}`;
}

function hero(compact = false) {
  const item = account();
  const current = item.id === "claude-1" ? value : item.windows.length ? left(item.windows[0]) : null;
  const amount = item.id === "claude-1" ? current.toFixed(1) : current;
  const windows = item.windows.map((window) => {
    const duration = Math.round((window.resetsAt - Date.parse("2026-11-05T15:00:00+09:00")) / 60000);
    const days = Math.floor(duration / 1440);
    const hours = Math.floor(duration % 1440 / 60);
    const minutes = duration % 60;
    const countdown = ko ? `${days ? `${days}일 ` : ""}${hours}시간${minutes ? ` ${minutes}분` : ""}` : `${days ? `${days}d ` : ""}${hours}h${minutes ? ` ${minutes}m` : ""}`;
    return `<div><strong>${window.windowMinutes === 300 ? "5h" : "7d"} · ${shortReset(window)}</strong><span>${percent(remaining(item, window))}% ${t("left", "남음")} · ${countdown}</span></div>`;
  }).join("");
  return `<section class="hero"><div class="engine-name">${selected} ${tile(item.tile)} <span class="main-label">${t("Main", "기본 계정")}</span></div><div class="hero-value"><span class="big" data-live-value>${amount ?? "?"}<sup>${current === null ? "" : "%"}</sup></span><span class="left">${current === null ? t("No reading", "정보 없음") : item.weeklyOnly ? t("7d left", "7일 남음") : t("5h left", "5시간 남음")}</span></div><div class="forecast">${current === null ? t("Send a message to start", "메시지 후 사용량 표시") : item.id === "claude-1" ? `${Math.round(projected(current))}% ${t("at reset", "초기화 때 남음")} <small>${t("estimate", "예상")}</small>` : t("Pace not known yet", "추이는 아직 알 수 없어요")}</div>${chart(compact)}<div class="window-list">${windows}</div></section>`;
}

function burn() {
  const days = range === "week";
  const samples = days ? daily : hourly;
  return `<svg class="burn-chart" viewBox="0 0 240 110" preserveAspectRatio="none" role="img" aria-label="${t("Busy morning, quiet afternoon, compared with normal", "평소와 비교한 바쁜 오전과 조용한 오후")}">${samples.map((n, i) => {
    const x = 4 + i * (225 / samples.length);
    const height = days ? n * .33 : n * 1.4;
    const normal = days ? 152 * .33 : usual[i] * 1.4;
    return `<rect x="${x}" y="${83 - normal}" width="${days ? 15 : 12}" height="${normal}" fill="var(--color-ink-secondary)" opacity=".17"/><rect x="${x + 4}" y="${83 - height}" width="${days ? 8 : 6}" height="${height}" fill="var(--color-accent)" opacity=".85"/>`;
  }).join("")}<text x="4" y="104">${days ? t("Fri", "금") : "07:00"}</text><text x="112" y="104">${days ? t("Mon", "월") : "11:00"}</text><text x="233" y="104" text-anchor="end">${days ? t("Today", "오늘") : "15:00"}</text></svg>`;
}

function historyPanel() {
  const item = account();
  const known = item.id === "claude-1";
  const names = [...item.workers, ...(autoRoute?.to === item.id ? ["Lint"] : [])];
  return `<aside class="history"><div class="history-top"><div class="section-head"><h2>${t("Burn history", "사용 추이")}</h2></div><div class="range" role="group" aria-label="${t("History range", "기록 기간")}"><button data-range="today" aria-pressed="${range === "today"}">${t("Today", "오늘")}</button><button data-range="week" aria-pressed="${range === "week"}">${t("7 days", "7일")}</button></div></div>${known ? burn() : `<div class="burn-chart muted">${t("History starts with your readings.", "사용 기록이 쌓이면 보여요.")}</div>`}<p>${known ? t("Busy morning. Quiet afternoon.", "바쁜 오전. 조용한 오후.") : t("No history yet", "아직 기록이 없어요")}</p><p>${known ? t("5h points · actual / usual", "5시간 한도 · 기록 / 평소") : t("Saved as reports arrive", "새 사용량이 오면 저장해요")}</p><div class="workers"><div class="section-head"><h2>${t(`Working on ${item.engine} ${item.tile}`, `${item.engine} ${item.tile} 사용 중`)}</h2><small>${t(`${names.length} active`, `${names.length}개 작업`)}</small></div>${names.map((name) => `<div class="worker-line"><span>${name}</span><span>${name === "Mina" || name === "Kai" ? t("Chat", "대화") : t("Worker", "워커")}</span></div>`).join("")}<p>${t("Activity, not a spend split", "작업 목록. 사용량 비중 아님")}</p></div></aside>`;
}

function quota(window, item) {
  if (!window) return `<div class="quota muted">${item.weeklyOnly ? "N/A" : "-"}<small>${item.weeklyOnly ? t("7d only", "주간만") : ""}</small></div>`;
  return `<div class="quota ${item.out ? "out-copy" : ""}"><span class="num">${percent(remaining(item, window))}%</span><small>${shortReset(window)}</small><small aria-label="${t("Until reset", "초기화까지")}">${countdown(window.resetsAt)}</small></div>`;
}

function rows(compact = false) {
  return `<section class="account-area">${compact ? "" : `<div class="section-head"><h2>${t("Every account", "모든 계정")}</h2><button data-view="details">${t("Connections", "연결 관리")} ↗</button></div>`}<div class="account-header"><span>${t("Account", "계정")}</span><span>${t("5h left", "5시간 남음")}</span><span>${t("7d left", "7일 남음")}</span>${compact ? "" : `<span class="workers-count">${t("Active", "작업 중")}</span>`}<span>${t("Main", "기본 계정")}</span></div>${accounts.map((item) => `<div class="account-row" data-account="${item.id}"><div class="engine-name"><b>${item.engine}</b>${tile(item.tile)}${autoRoute?.to === item.id ? `<span class="route-mark">+Lint</span>` : ""}</div>${item.windows.length ? quota(item.windows.find((w) => w.windowMinutes === 300), item) + quota(item.windows.find((w) => w.windowMinutes === 10080), item) : `<div class="unknown">${t("After first message", "첫 메시지 후 표시")}</div>`}${compact ? "" : `<span class="workers-count">${[...item.workers, ...(autoRoute?.to === item.id ? ["Lint"] : [])].join(" · ") || "-"}</span>`}<button class="action ${item.out ? "out" : main[item.engine] === item.id ? "current" : "use"}" data-use="${item.id}" ${item.out || main[item.engine] === item.id || pending ? "disabled" : ""}>${pending && main[item.engine] !== item.id && !item.out ? t("Saving", "저장 중") : item.out ? t("Out", "소진") : main[item.engine] === item.id ? `✓ ${t("Main", "기본")}` : t("Use", "사용")}</button></div>`).join("")}</section>`;
}

function policy() {
  const item = account();
  const multiple = accounts.filter((candidate) => candidate.engine === selected).length > 1;
  return `<div class="policy"><span>${selected} · ${pins[selected] || !multiple ? t("Wait at limit", "소진 시 대기") : t("New workers auto switch", "새 워커 자동 전환")}</span>${multiple ? `<button data-pin aria-pressed="${Boolean(pins[selected])}">${pins[selected] ? t(`Unpin ${item.tile}`, `${item.tile} 고정 해제`) : t(`Pin to ${item.tile}`, `${item.tile}에 고정`)}</button>` : `<span>${t("One account", "계정 1개")}</span>`}</div><div class="receipt" role="status">${receipt}</div>`;
}

function usage() {
  return `<main class="usage"><div class="page-title"><h1>${t("Usage", "사용량")}</h1><small>${age ? t(`Read ${age}s ago`, `${age}초 전 확인`) : t("Just reported", "방금 확인")}</small></div><div class="tabs" role="tablist" aria-label="${t("Engine", "엔진")}">${engines.map((engine) => `<button data-engine="${engine}" role="tab" aria-selected="${engine === selected}">${engine}</button>`).join("")}</div><div class="hero-grid">${hero()}${historyPanel()}</div>${rows()}${policy()}<details class="phone-workers"><summary>${t("6 active · who?", "6개 작업 · 누가 사용 중?")}</summary>${accounts.filter((item) => item.workers.length).map((item) => `<div class="worker-line"><span>${item.workers.join(" · ")}</span><span>${item.engine} ${item.tile}</span></div>`).join("")}<p class="muted">${t("Activity, not a spend split", "작업 목록. 사용량 비중 아님")}</p></details></main>`;
}

function quick() {
  return `<section class="quick" role="dialog" aria-label="${t("Quick usage", "사용량 빠른 보기")}" ${quickOpen ? "" : "hidden"}><div class="quick-head"><h2>Claude ${tile(account().tile)}</h2><small>${age ? t(`${age}s ago`, `${age}초 전`) : t("Just reported", "방금 확인")}</small><button data-close aria-label="${t("Close quick usage", "빠른 보기 닫기")}">×</button></div>${hero(true)}${rows(true)}${policy()}<button class="manage" data-view="usage">${t("Open Usage", "사용량 열기")} ↗ <span class="muted">Alt+U</span></button></section>`;
}

function chat() {
  const item = account();
  const amount = remaining(item, item.windows[0]);
  return `<main class="chat-main"><div class="chat-heading"><div><h2>Mina</h2><p>Claude ${tile("1")}</p></div><span class="muted">···</span></div><div class="messages"><div class="message user">${t("Check the account handoff.", "계정 전환을 확인해 줘.")}</div><div class="message"><span class="speaker">Mina</span>${t("Review and Tests are running on Claude 1. Your current reply stays here.", "Review와 Tests는 Claude 1에서 실행 중이에요. 이 답변은 같은 계정을 유지해요.")}</div><div class="message"><span class="speaker">15:00</span>${t("Workers can choose any signed-in account.", "워커는 로그인한 계정을 선택해요.")}</div></div><div class="composer-wrap">${quick()}<button class="meter" data-meter aria-expanded="${quickOpen}"><span class="meter-left">Claude ${tile(item.tile)} <span class="num">${percent(amount)}%</span> ${t("left", "남음")}</span><svg class="mini-line" viewBox="0 0 74 24">${item.id === "claude-1" ? `<path d="M2 3 L13 5 L24 12 L35 15 L46 16 L57 18 L72 19" fill="none" stroke="var(--color-accent)" stroke-width="1.5"/>` : ""}</svg><span>${t("3h 40m to reset", "초기화 3시간 40분")}</span></button><div class="composer"><input aria-label="${t("Message Mina", "Mina에게 메시지")}" placeholder="${t("Message Mina", "Mina에게 메시지")}"/><div class="composer-foot"><span>+　Claude ${item.tile}</span><span>↑</span></div></div></div></main>`;
}

function details() {
  return `<main class="detail"><h1>${t("When an account runs out", "계정이 소진되면")}</h1><div class="detail-grid"><section><div class="wait"><h2>Claude ${tile("2")} · ${t("Out until Mon 5:00 PM", "월 오후 5:00까지 소진")}</h2><p>${t("Waiting · 4d 2h to reset", "대기 중 · 초기화 4일 2시간")}</p><div class="actions"><button class="primary" data-wait-use>${t("Use Claude 3", "Claude 3 사용")}</button><button data-wait-cancel>${t("Cancel", "취소")}</button></div><div class="receipt" data-wait-status></div></div><p class="detail-note">${t("Only the queued action moves.", "대기 중인 작업만 옮겨요.")}</p><p class="detail-note">${t("Running work keeps its account.", "실행 중인 작업은 유지해요.")}</p></section><section><div class="section-head"><h2>${t("Connections", "연결")}</h2><button data-add>${t("Add account", "계정 추가")} +</button></div><div class="connections">${accounts.map((item) => `<div class="connection-row">${tile(item.tile)}<div class="identity"><span>${item.engine.toLowerCase()}${item.tile}@example.invalid</span><small>${item.engine} ${main[item.engine] === item.id ? `· ${t("Main", "기본")}` : ""}</small></div><button data-signout="${item.id}">${t("Sign out", "로그아웃")}</button></div>`).join("")}</div><p class="detail-note" role="status" data-connection-status>${t("Addresses stay in these rows.", "주소는 이 목록에만 표시해요.")}</p></section></div></main>`;
}

function render() {
  const scroll = document.querySelector(".quick")?.scrollTop || 0;
  const draft = document.querySelector(".composer input")?.value || "";
  app.innerHTML = `${top()}<div class="workspace">${nav()}${view === "chat" ? chat() : view === "details" ? details() : usage()}</div>`;
  const quick = document.querySelector(".quick");
  if (quick) quick.scrollTop = scroll;
  const input = document.querySelector(".composer input");
  if (input) input.value = draft;
}

function paintQuote() {
  const amount = percent(value);
  const row = document.querySelector('[data-account="claude-1"] .quota .num');
  if (row) row.textContent = `${amount}%`;
  if (account().id !== "claude-1") return;
  const quote = document.querySelector("[data-live-value]");
  if (quote) quote.innerHTML = `${value.toFixed(1)}<sup>%</sup>`;
  const forecast = document.querySelector(".forecast");
  if (forecast) forecast.innerHTML = `${Math.round(projected(value))}% ${t("at reset", "초기화 때 남음")} <small>${t("estimate", "예상")}</small>`;
  const plot = document.querySelector(".hero .chart");
  if (plot) { const fragment = document.createElement("div"); fragment.innerHTML = chart(true); plot.replaceWith(fragment.firstElementChild); }
  const window = document.querySelector(".window-list > div:first-child span");
  if (window) window.textContent = window.textContent.replace(/^[\d.]+%/, `${amount}%`);
  const meter = document.querySelector(".meter .num");
  if (meter) meter.textContent = `${amount}%`;
  const reading = document.querySelector(".page-title small,.quick-head small");
  if (reading) reading.textContent = t("Just reported", "방금 확인");
}

async function use(id) {
  if (pending) return;
  const item = accounts.find((candidate) => candidate.id === id);
  if (!item || item.out) return;
  pending = true;
  receipt = t(`Saving ${item.engine} ${item.tile}`, `${item.engine} ${item.tile} 저장 중`);
  render();
  await new Promise((resolve) => setTimeout(resolve, 220));
  main[item.engine] = id;
  if (pins[item.engine]) pins[item.engine] = id;
  pending = false;
  receipt = t(`${item.engine} ${item.tile} is Main · next messages only`, `${item.engine} ${item.tile} 기본 계정 · 다음 메시지부터`);
  render();
}

app.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.use) return void use(button.dataset.use);
  if (button.dataset.view) { const url = new URL(location.href); url.searchParams.set("view", button.dataset.view); location.href = url; return; }
  if (button.dataset.engine) selected = button.dataset.engine;
  if (button.dataset.range) range = button.dataset.range;
  if (button.hasAttribute("data-pin")) { pins[selected] = pins[selected] ? null : main[selected]; receipt = pins[selected] ? t(`${selected} ${account().tile} pinned · wait at limit`, `${selected} ${account().tile} 고정 · 소진 시 대기`) : t("Automatic switching for new workers", "새 워커 자동 전환 켜짐"); }
  if (button.hasAttribute("data-close")) quickOpen = false;
  if (button.hasAttribute("data-meter")) quickOpen = !quickOpen;
  if (button.hasAttribute("data-wait-use")) { button.disabled = true; document.querySelector("[data-wait-status]").textContent = t("Queued action will use Claude 3", "대기 작업은 Claude 3 사용"); return; }
  if (button.hasAttribute("data-wait-cancel")) { document.querySelector("[data-wait-status]").textContent = t("Queued action canceled", "대기 작업 취소됨"); return; }
  if (button.hasAttribute("data-add") || button.dataset.signout) { document.querySelector("[data-connection-status]").textContent = t("Fixture only · no account changed", "미리 보기 · 실제 계정 변경 없음"); return; }
  render();
  if (button.hasAttribute("data-meter") && quickOpen) document.querySelector("[data-close]").focus();
  if (button.hasAttribute("data-close")) document.querySelector("[data-meter]").focus();
});

document.addEventListener("keydown", (event) => {
  if (view !== "chat") return;
  if (event.altKey && event.key.toLowerCase() === "u") { event.preventDefault(); quickOpen = !quickOpen; render(); if (quickOpen) document.querySelector("[data-close]").focus(); }
  if (event.key === "Escape" && quickOpen) { quickOpen = false; render(); document.querySelector("[data-meter]").focus(); }
  if (event.key === "Tab" && quickOpen) {
    const elements = [...document.querySelectorAll(".quick button:not(:disabled)")];
    if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1).focus(); }
    if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0].focus(); }
  }
});

window.runway = {
  state: () => ({ main, pins, value, receipt, pending, autoRoute }),
  tick: (next) => {
    age = 0;
    const start = value;
    const began = performance.now();
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animate = (clock) => { const progress = reduced ? 1 : Math.min(1, (clock - began) / 550); value = start + (next - start) * (1 - (1 - progress) ** 3); paintQuote(); if (progress < 1) requestAnimationFrame(animate); else { value = next; paintQuote(); } };
    requestAnimationFrame(animate);
  },
  auto: () => { if (pins.Claude) receipt = t("Claude 1 pinned · no automatic move", "Claude 1 고정 · 자동 전환 없음"); else { autoRoute = { from: "claude-2", to: "claude-3", worker: "Lint", at: now }; receipt = `${time(autoRoute.at)} · ${t("New worker: 2 out → 3 · Main stays 1", "새 워커: 2 소진 → 3 · 기본 1 유지")}`; } render(); },
};
render();
