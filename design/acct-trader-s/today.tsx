import { createRoot } from "react-dom/client";
import { UsageSection } from "../../src/components/UsageSection";
import { ChatPlanMeters } from "../../src/components/ChatPlanMeters";
import { AccountConnections } from "../../src/components/AccountConnections";
import { ErrorRow } from "../../src/components/ChatView";
import { I18nProvider, persistPreference } from "../../src/lib/i18n";
import { accounts, instances, now } from "./fixtures.mjs";
import "./today.css";

const query = new URLSearchParams(location.search);
const ko = query.get("lang") === "ko";
const view = query.get("view") || "usage";
const t = (en: string, kr: string) => ko ? kr : en;
document.documentElement.dataset.skin = query.get("skin") || "github-dimmed";
persistPreference(ko ? "ko" : "en");
localStorage.setItem("omb-usage-mode", "remaining");
const rows = instances();

function Connections() {
  return <div className="today-connections">{["Claude", "Codex", "Grok", "Gemini"].map((engine) => <section key={engine}><h2>{engine}</h2><AccountConnections accounts={rows.filter((row) => row.displayName === engine)} reload={async () => {}} /></section>)}</div>;
}

function Wait() {
  return <ErrorRow botId="fixture" message={t("Weekly usage limit reached", "주간 사용 한도 도달")} usageLimit={{ resetsAt: accounts[1].windows[0].resetsAt }} usageWait={{ id: "fixture-wait", ownerDeviceId: "fixture", state: "waiting", weekly: true, resumesAt: accounts[1].windows[0].resetsAt, cancelable: true }} />;
}

function Chat() {
  return <main className="today-chat"><header><b>Mina</b><span>Claude</span></header><div className="today-messages"><p className="user">{t("Check the account handoff.", "계정 전환을 확인해 줘.")}</p><p>{t("Review and Tests are running. I will check the account handoff.", "Review와 Tests가 실행 중이에요. 계정 전환을 확인할게요.")}</p></div><div className="today-composer"><ChatPlanMeters windows={accounts[0].windows} now={now} onOpenUsage={() => {}} /><div className="today-input">{t("Message Mina", "Mina에게 메시지")}<div>+　Claude <span>↑</span></div></div></div></main>;
}

function App() {
  return <I18nProvider><div className="today-top"><b>wink</b><span>{t("Workspace", "작업 공간")}</span></div>{view === "chat" ? <Chat /> : view === "details" ? <main className="today-details"><h1>{t("Connections and usage wait", "연결과 사용량 대기")}</h1><Wait /><Connections /></main> : <div className="today-settings"><nav><h2>{t("Settings", "설정")}</h2>{[t("General", "일반"), t("Connections", "연결"), t("Usage", "사용량"), t("Appearance", "모양")].map((name, index) => <div key={name} className={index === 2 ? "active" : ""}>{name}</div>)}</nav><main><header><h1>{t("Usage", "사용량")}</h1><span>×</span></header><div className="today-usage"><UsageSection /></div></main></div>}</I18nProvider>;
}
createRoot(document.querySelector("#root")!).render(<App />);
