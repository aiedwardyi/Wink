import { describe, expect, it } from "vitest";

import { nominate } from "./quick-route.ts";

// Edward's busy-time asks (ROUTER.md 1.3), redacted; the label is the probe rules' decision.
const LABELED: Array<[string, "quick" | "main"]> = [
  ["quick q with all the engines connecting, what is purpose of it?", "quick"],
  ["do u remember me telling you make eval page pretty so its impressive", "quick"],
  ["admin is user ?", "quick"],
  ["are we almost done yet", "quick"],
  ["can u tell me what u found so far though.", "quick"],
  ["Do u know why urs say reconnecting in this chat.", "quick"],
  ["do u know which one that is lol i forgot", "quick"],
  ["i can switch themes and stuff, use the demo as normal or do i need to know restricitons?", "quick"],
  ["He can just sign in google same way as we do right", "quick"],
  ["u want me to reinstall ? im at home", "quick"],
  ["hahaha thats funny. do i need to tell pokkey anything or are we good", "quick"],
  ["for the 200 tokens to each bot turn, its measuring something throughout ? for everybody using wink? we dont turn it on like during test and turn it off kinda thing? \n\nalso im installing something on w...", "quick"],
  ["when can we do that. i want to keep developing and updating without having to slow down pokkey", "main"],
  ["are we gonna do the test today vs grok vs dot, or u want to do that tonight when everything is quiet", "quick"],
  ["Csn i give feedback.", "main"],
  ["is thihs out in the wild in the release?", "quick"],
  ["how would i activate ultrathink in this bot chat though its not terminal cli so slashes prob dont work?", "quick"],
  ["okay great. whats that audit-chats on desktop too. i dont know that one ?", "quick"],
  ["wait didn't we do this glitchtip ap[i key setup long time ago at first time or did i forget?", "quick"],
  ["will they do as good of a job? you can do it yourself since its important if u want, ur on max", "quick"],
  ["can u save these on my work pc desktop", "main"],
  ["Dont merge the lag fix if it doesnt fix it.", "main"],
  ["Ship it", "main"],
  ["go", "main"],
  ["yes do whatever u need to do, i have authorizd vercel on wonikyi", "main"],
  ["change pass to <redacted> for both\nuser is admin", "main"],
  ["and update docs while at it", "main"],
  ["make it an engineering task, so we can target the coders", "main"],
  ["pokkey somethigns going on with my cpu and memory 90%", "main"],
  ["please install node and all the necessary stuff, update powershell and stuff too while at it, so i can log into those accounts too", "main"],
  ["i might need to stop here, im too tired sorry brother i tried to go far", "main"],
  ["Run them hidden in background", "main"],
  ["yea use 3080", "main"],
  ["what do u think about this https://www.microsoft.com/en-us/startups/blog/imagine-cup-2027\n\nfor...", "main"],
  ["GetWinkDev is available", "main"],
  ["says 57%", "main"],
  ["dark mode?", "quick"],
  ["can we do the world swipe now please? i would love that we can deploy today if we can asap", "main"],
  ["when ppl use our bots our bots should know our system and how our app works. just like every other bots for every other project", "main"],
];

const HELD_OUT: Array<[string, "quick" | "main"]> = [
  ["how did you let this get out in the wild", "quick"],
  ["if we're done, lets work on the auto ? get all these out in release too", "main"],
  ["do you think agentloop site should be dark mode too then, or white looks good here", "quick"],
  ["where's the plan?", "quick"],
  ["what port is in the server config?", "quick"],
  ["is node installed on my work pc?", "quick"],
  ["should i send the screenshots to the team now or wait?", "quick"],
  ["true ur right okay leave the 3 flaky tests as is. should i tell the team the lag is fixed?", "quick"],
  ["open that file and tell me step 3", "main"],
  ["i see what u mean, okay ill try new bot", "main"],
  ["<attached-image path=\"C:\\a.png\" /> what is this?", "main"],
  [`${"is it ".repeat(50)}?`, "main"],
  ["", "main"],
];

// Korean orders, refusals and reports, then questions; one with no "?" reads as a statement and stays with the bot.
const KO_LABELED: Array<[string, "quick" | "main"]> = [
  ["아니", "main"],
  ["아냐", "main"],
  ["아니 그거 말고", "main"],
  ["맞아", "main"],
  ["됐어", "main"],
  ["응 그렇게 해줘", "main"],
  ["좋아 진행해", "main"],
  ["멈춰", "main"],
  ["잠깐", "main"],
  ["하지 마", "main"],
  ["그거 하지 말고 이렇게 하면 어때?", "main"],
  ["이거 고쳐줄래?", "main"],
  ["커밋해줄 수 있어?", "main"],
  ["테스트 돌려볼까?", "main"],
  ["푸시해줄래?", "main"],
  ["멈춰줄래?", "main"],
  ["이 파일 지워도 돼?", "main"],
  ["다시 해볼래?", "main"],
  ["방금 재시작했는데 됐어?", "main"],
  ["다 했어", "main"],
  ["파일 저장했어", "main"],
  ["로그인 했어", "main"],
  ["문제 없어", "main"],
  ["여기 있어", "main"],
  ["버그 있는 것 같은데?", "main"],
  ["안 돼", "main"],
  ["지금 뭐 하고 있어?", "quick"],
  ["지금 뭐 하고 있어", "quick"],
  ["얼마나 남았어?", "quick"],
  ["얼마나 남았어", "quick"],
  ["다 끝났어", "main"],
  ["테스트 통과했나", "main"],
  ["그 파일 어디에 있지", "main"],
  ["왜 이렇게 오래 걸려", "quick"],
  ["끝났습니까", "main"],
  ["진행 상황 알려줘", "main"],
];

const KO_MIXED: Array<[string, "quick" | "main"]> = [
  ["PR 머지해줘", "main"],
  ["README도 업데이트해줘", "main"],
  ["main 브랜치에 push 하지 마", "main"],
  ["npm install 다시 해볼까?", "main"],
  ["응 merge 해", "main"],
  ["아니 그 파일 말고 config.ts", "main"],
  ["방금 pull 받았는데 conflict 났어?", "main"],
  ["배포해도 돼?", "main"],
  ["이거 버그 아니야?", "main"],
  ["잠깐만, 그 PR 닫지 마", "main"],
  ["끝나면 Slack으로 알려줘", "main"],
  ["테스트 통과했어", "main"],
  ["뭐든 좋아, 네가 골라", "main"],
  ["테스트 통과했어?", "quick"],
  ["CI 왜 빨간색이야?", "quick"],
  ["어느 브랜치에서 작업 중이야", "quick"],
  ["서버 포트 몇 번이야?", "quick"],
  ["혹시 지금 어디까지 했어", "quick"],
  ["API 키 어디에 저장돼 있어?", "quick"],
  ["커밋 메시지 뭐라고 썼어?", "quick"],
];

describe("nominate", () => {
  it.each(LABELED)("labeled: %s", (text, want) => {
    expect(nominate(text)).toBe(want);
  });

  it.each(HELD_OUT)("held out: %s", (text, want) => {
    expect(nominate(text)).toBe(want);
  });

  it.each(KO_LABELED)("korean: %s", (text, want) => {
    expect(nominate(text)).toBe(want);
  });

  it.each(KO_MIXED)("korean with code words: %s", (text, want) => {
    expect(nominate(text)).toBe(want);
  });

  it("stays under 10 us per message", () => {
    const texts = [...LABELED, ...HELD_OUT].map(([text]) => text);
    for (const text of texts) nominate(text);
    const reps = 200;
    const started = process.hrtime.bigint();
    for (let rep = 0; rep < reps; rep++) for (const text of texts) nominate(text);
    expect(Number(process.hrtime.bigint() - started) / 1000 / (reps * texts.length)).toBeLessThan(10);
  });
});
