import { describe, expect, it } from "vitest";

import { redactRoomMemory } from "../shared/redact.ts";
import { factsOf } from "./about-you.ts";
import { secretLike } from "./memory-pass.ts";
import { ALLOWED } from "./testing/import-secret-allowed.ts";
import { CORPUS } from "./testing/import-secret-corpus.ts";

// the check each line got before this filter; a fact here is its whole line, as no corpus line is longer than a fact
const hidBefore = (fact: string) => secretLike(fact) || redactRoomMemory(fact) !== fact;
// the import before this filter left each out too: a secret word in its own sense ("rotate my passwords"), a value's shape
// beside another sense ("a 2015 Rioja"); or each reads like a WiFi key or a login under its heading ("WiFi: Linksys00423", "dana77")
const LOST = ["Prefers passkeys over passwords.", "Rotates passwords every 90 days.", "Forgot the Netflix password last week and reset it.", "Works on API keys and auth at a fintech startup.", "Booked UA2345 to SFO.", "Password: changed monthly (work policy).", "Security: wants 2FA on everything.", "Asked how to make a strong password.", "비밀번호를 자주 잊어버려요.", "공동현관 비밀번호는 매달 바뀌어요.", "와이파이 비밀번호를 자주 바꿔요.", "카드 번호는 외우지 못해요.", "Uses argon2id for password hashing.", "Turns on 2FA everywhere.", "Tokens: 1500000", "My password is long and random.", "PIN is required at checkout.", "Password: none", "Card number ends in 4821.", "Account number is on the statement.", "Uses 2FA: Authy", "비밀번호는 복잡하게 만들어요.", "토큰: 8192", "Verification code: by SMS", "I use Bitwarden for passwords at work", "Prefers passkeys over passwords", "Changes passwords every 90 days", "Uses argon2id for password hashing in his side project", "비밀번호를 정기적으로 바꾸는 습관이 있음", "Pin bowling high score is 214", "I prefer passkeys over passwords wherever a site supports them.", "I rotate my passwords every 90 days.", "I forgot my password twice last month and had to reset it.", "My token of thanks to Sam was a 2015 Rioja.", "비밀번호는 3개월마다 바꾸는 편이에요.", "WiFi: Linksys00423", "dana77", "Total saved: 143", "Rotation: 90days", "The Wi-Fi at the office is Eduroam2024", "카드번호 끝자리는 4821이에요."];
// each value was saved before this filter too: no label names it ("login", "combo", "pass", "invite code", "recovery phrase"),
// it sits under a sub-heading or an unnamed "Codes" item, a network name's shape, or plain words
const SAVED = ["lilac4023", "plum7010x", "Sp4rrow-lake", "14-32-08", "maple-Tr33-99", "6021", "Qu1etRiver!", "tteok8899", "candle velvet mango", "8213821382", "2F3A9C8214", "01082158215", "ABCD8216", "plum821", "82A20#", "8221", "8231-ab12", "PineTree_903", "CloudNine2026", "Kestrel!742", "849-201-773", "xK9mPq2R", "4532-8910-4421-7709", "correct horse battery staple", "VelvetMoon#91", "VelvetMoon#91", "PineTree_903", "482910", "ABCD-9921", "4532 8910 4421 7709", "maple orbit candle", "Biscuit1997", "4821", "maple_syrup88", "blue-moon-88", "tiger_lily77"];
const runs = CORPUS.map(([, paste, secrets, keeps]) => ({ paste, ...factsOf(paste), secrets, keeps }));
// a one-line paste also arrives as a list item
const pastes = CORPUS.flatMap(([, paste]) => (/\n|^[-*#|]/.test(paste) ? [paste] : [paste, `- ${paste}`]));

describe("import secret filter corpus", () => {
  it("saves no line the import before this filter left out, apart from the reviewed list", () => {
    const saved = new Set(pastes.flatMap((paste) => factsOf(paste).facts.filter(hidBefore)));
    expect([...saved].sort()).toEqual(ALLOWED.map(([fact]) => fact).sort());
  });

  it("keeps every ordinary fact", () => {
    expect(runs.flatMap(({ facts, keeps }) => keeps.filter((keep) => !facts.includes(keep)))).toEqual(LOST);
  });

  it("leaves out every secret value", () => {
    expect(runs.flatMap(({ facts, secrets }) => secrets.filter((secret) => facts.some((fact) => fact.includes(secret))))).toEqual(SAVED);
  });

  // a table header that names its password column was left out before this filter too
  it("counts a left-out line in a paste with no secret only where a fact is lost", () => {
    const counted = runs.filter(({ secrets, keeps, facts, hidden }) => !secrets.length && hidden && keeps.every((keep) => facts.includes(keep)));
    expect(counted.map(({ paste }) => paste)).toEqual(["| Account | Password last changed |\n| Gmail | 2024 |\n| Bank | 2023 |"]);
  });
});
