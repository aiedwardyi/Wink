import { describe, expect, it } from "vitest";

import { isNudge, isOrder, nominate, questionPart } from "./quick-route.ts";

// Busy-time asks, redacted; the label is the probe rules' decision.
const LABELED: Array<[string, "quick" | "aside" | "main"]> = [
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
  ["when can we do that. i want to keep developing and updating without having to slow down pokkey", "aside"],
  ["are we gonna do the test today vs grok vs dot, or u want to do that tonight when everything is quiet", "quick"],
  ["Csn i give feedback.", "aside"],
  ["is thihs out in the wild in the release?", "quick"],
  ["how would i activate ultrathink in this bot chat though its not terminal cli so slashes prob dont work?", "quick"],
  ["okay great. whats that audit-chats on desktop too. i dont know that one ?", "quick"],
  ["wait didn't we do this glitchtip ap[i key setup long time ago at first time or did i forget?", "quick"],
  ["will they do as good of a job? you can do it yourself since its important if u want, ur on max", "quick"],
  ["can u save these on my work pc desktop", "aside"],
  ["Dont merge the lag fix if it doesnt fix it.", "main"],
  ["Ship it", "main"],
  ["go", "main"],
  ["yes do whatever u need to do, i have authorizd vercel on wonikyi", "main"],
  ["change pass to <redacted> for both\nuser is admin", "aside"],
  ["and update docs while at it", "aside"],
  ["make it an engineering task, so we can target the coders", "aside"],
  ["pokkey somethigns going on with my cpu and memory 90%", "aside"],
  ["please install node and all the necessary stuff, update powershell and stuff too while at it, so i can log into those accounts too", "aside"],
  ["i might need to stop here, im too tired sorry brother i tried to go far", "aside"],
  ["Run them hidden in background", "aside"],
  ["yea use 3080", "aside"],
  ["what do u think about this https://www.microsoft.com/en-us/startups/blog/imagine-cup-2027\n\nfor...", "aside"],
  ["GetWinkDev is available", "aside"],
  ["says 57%", "aside"],
  ["dark mode?", "quick"],
  ["can we do the world swipe now please? i would love that we can deploy today if we can asap", "aside"],
  ["when ppl use our bots our bots should know our system and how our app works. just like every other bots for every other project", "aside"],
];

const HELD_OUT: Array<[string, "quick" | "aside" | "main"]> = [
  ["how did you let this get out in the wild", "quick"],
  ["if we're done, lets work on the auto ? get all these out in release too", "aside"],
  ["do you think agentloop site should be dark mode too then, or white looks good here", "quick"],
  ["where's the plan?", "quick"],
  ["what port is in the server config?", "quick"],
  ["is node installed on my work pc?", "quick"],
  ["should i send the screenshots to the team now or wait?", "quick"],
  ["true ur right okay leave the 3 flaky tests as is. should i tell the team the lag is fixed?", "quick"],
  ["open that file and tell me step 3", "aside"],
  ["i see what u mean, okay ill try new bot", "aside"],
  ["<attached-image path=\"C:\\a.png\" /> what is this?", "aside"],
  [`${"is it ".repeat(50)}?`, "aside"],
  ["", "main"],
];

// Korean orders, refusals and reports, then questions; one with no "?" reads as a statement and gets the short reply.
const KO_LABELED: Array<[string, "quick" | "aside" | "main"]> = [
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
  ["이거 고쳐줄래?", "aside"],
  ["커밋해줄 수 있어?", "aside"],
  ["테스트 돌려볼까?", "aside"],
  ["푸시해줄래?", "aside"],
  ["멈춰줄래?", "main"],
  ["이 파일 지워도 돼?", "aside"],
  ["다시 해볼래?", "aside"],
  ["방금 재시작했는데 됐어?", "aside"],
  ["다 했어", "aside"],
  ["파일 저장했어", "aside"],
  ["로그인 했어", "aside"],
  ["문제 없어", "aside"],
  ["여기 있어", "aside"],
  ["버그 있는 것 같은데?", "aside"],
  ["안 돼", "aside"],
  ["지금 뭐 하고 있어?", "quick"],
  ["지금 뭐 하고 있어", "quick"],
  ["얼마나 남았어?", "quick"],
  ["얼마나 남았어", "quick"],
  ["다 끝났어", "aside"],
  ["테스트 통과했나", "aside"],
  ["그 파일 어디에 있지", "aside"],
  ["왜 이렇게 오래 걸려", "quick"],
  ["끝났습니까", "aside"],
  ["진행 상황 알려줘", "aside"],
];

const KO_MIXED: Array<[string, "quick" | "aside" | "main"]> = [
  ["PR 머지해줘", "aside"],
  ["README도 업데이트해줘", "aside"],
  ["main 브랜치에 push 하지 마", "main"],
  ["npm install 다시 해볼까?", "aside"],
  ["응 merge 해", "main"],
  ["아니 그 파일 말고 config.ts", "main"],
  ["방금 pull 받았는데 conflict 났어?", "aside"],
  ["배포해도 돼?", "aside"],
  ["이거 버그 아니야?", "aside"],
  ["잠깐만, 그 PR 닫지 마", "main"],
  ["끝나면 Slack으로 알려줘", "aside"],
  ["테스트 통과했어", "aside"],
  ["뭐든 좋아, 네가 골라", "aside"],
  ["테스트 통과했어?", "quick"],
  ["CI 왜 빨간색이야?", "quick"],
  ["어느 브랜치에서 작업 중이야", "quick"],
  ["서버 포트 몇 번이야?", "quick"],
  ["혹시 지금 어디까지 했어", "quick"],
  ["API 키 어디에 저장돼 있어?", "quick"],
  ["커밋 메시지 뭐라고 썼어?", "quick"],
];

// Greetings, pings and asks aimed at the helper, then orders wrapped in them.
const CASUAL: Array<[string, "quick" | "aside" | "main"]> = [
  ["sidekick test hello", "quick"],
  ["sidekick testing", "quick"],
  ["sidekick test 2", "quick"],
  ["sidekick test 3", "quick"],
  ["sidekick test 4", "quick"],
  ["whatsup", "quick"],
  ["can u say hi", "quick"],
  ["if you're sidekick please respond with a hello sentence", "quick"],
  ["if you're sidekick please respond with a hello sentence\nwhy arent u responding hello misterr lol", "quick"],
  ["yeah if you'r sidekick let me know one last time please. and main one please dont respond HAHAHA", "quick"],
  ["sidekick is sleeping i think", "quick"],
  ["i dont think so, is that u? can u tell which one u received or not?", "quick"],
  ["안녕하세요", "quick"],
  ["사이드킥 테스트", "quick"],
  ["사이드킥이면 인사해줘", "quick"],
  ["hi, fix the login bug", "aside"],
  ["hey sidekick, push it", "aside"],
  ["test the build", "aside"],
  ["if you're the sidekick please deploy", "aside"],
  ["sidekick please run the tests", "aside"],
  ["hello. please restart the server", "aside"],
  ["please dont", "main"],
  ["sidekick doesnt work", "aside"],
  ["안녕, 버그 고쳐줘", "aside"],
  ["사이드킥이면 푸시해줘", "aside"],
];

// Mid-turn sends that got no reply on 11-17, redacted to the same shape; the card tap and the approval stay with the bot.
const LONG = "hm if we switch the buttons to soft press and fade, would it still match the rest of the app? also my dad opened his forum and thought the chat went blank because nothing was there. do you think an empty forum should say something nice instead, like a note that bots post here to each other, so nobody thinks it broke? i keep seeing that on the phone and on desktop too";
const SENT_MIDTURN: Array<[string, "quick" | "aside" | "main"]> = [
  [LONG, "aside"],
  [`${LONG.slice(0, 340)}\n\n<attached-image path="C:\\shot.png" />`, "aside"],
  ["do u want to book all 4 pcs for urself, so that u can manage wider. our launch is so close that im starting to get worried", "aside"],
  ["when u got time read this real quick to see if it'll help us with ci https://example.com/ci-cost", "aside"],
  ["i know ur working, but its odd, im testing the sidekick thing but it doesnt seem like our feature works", "aside"],
  ["help me answer ur questions", "aside"],
  ["Yes, soft press + fade", "main"],
  ["no stop", "main"],
];

const ORDERS: Array<[string, boolean]> = [
  ["merge both", true],
  ["both", true],
  ["2", true],
  ["the second one", true],
  ["option b", true],
  ["also update the docs when you are done", true],
  ["can u save these on my work pc desktop", true],
  ["can we do the world swipe now please? i would love that we can deploy today", true],
  ["yea use 3080", true],
  ["둘 다", true],
  ["2번", true],
  ["PR 머지해줘", true],
  ["둘 다 머지해줘", true],
  ["squash both", true],
  ["그냥 머지하면 어때?", true],
  ["what port is in the server config, please?", false],
  ["how do I run this, pls", false],
  ["Does it support Windows, please?", false],
  ["성능은 어때?", false],
  ["Can it support Windows, please?", false],
  ["Could it run on Linux, please?", false],
  ["Will the release include the fix, pls?", false],
  ["Do the tests pass on Windows, please?", false],
  ["Do both builds support Windows, please?", false],
  ["Have the tests passed, please?", false],
  ["Should I send it now, please?", false],
  ["Could you tell me which port it uses, please?", false],
  ["Do you know if it supports Windows, please?", false],
  ["Can you merge it, please?", true],
  ["Can we deploy today, please?", true],
  ["do both, please", true],
  ["do the migration, please", true],
  ["do both PRs now, please?", true],
  ["have it ready by noon, please", true],
  ["성능 어때?", false],
  ["속도 어때?", false],
  ["이거 어때?", false],
  ["화면 어때?", false],
  ["새로 만든 게 어때?", false],
  ["빌드 상태 어때요?", false],
  ["성능 어떨까?", false],
  ["윈도우에서도 돼?", false],
  ["맥에서도 되나요?", false],
  ["머지하는 게 어때?", true],
  ["해보는 건 어때?", true],
  ["내일 하면 어떨까?", true],
  ["배포해도 돼?", true],
  ["그걸로 해도 돼?", true],
  ["please install node", true],
  ["switched to the new branch", false],
  ["done", false],
  ["done. now push it", true],
  ["says 57%", false],
  ["GetWinkDev is available", false],
  ["what port is in the server config?", false],
  ["dark mode?", false],
  ["when can we do that. i want to keep developing", false],
  ["Csn i give feedback.", false],
  ["다 했어", false],
  ["지금 뭐 하고 있어?", false],
  ["Do these work, please?", false],
  ["Do those look right, please?", false],
  ["Could you explain why it failed, please?", false],
  ["Can you confirm whether it supports Windows, please?", false],
  ["Can you please clarify what changed, pls?", false],
  ["Would you describe the setup, please?", false],
  ["Could you remind me which port it uses, please?", false],
  ["Can you summarize the error, please?", false],
  ["Could you let me know if the build passed, please?", false],
  ["do these first, please", true],
  ["do those two, please?", true],
  ["Can you confirm the order, please?", true],
  ["Can you squash the two commits?", true],
  ["squash the two commits", true],
  ["윈도우 지원하는지 알려줄래?", false],
  ["왜 실패했는지 설명해 줄래요?", false],
  ["포트가 뭔지 알려줘", false],
  ["어떻게 설치하는지 말해 줄래?", false],
  ["빌드 통과했는지 알려주세요", false],
  ["어디서 설정하는지 설명해 줄 수 있어?", false],
  ["PR 머지하고 알려줘", true],
  ["테스트 통과하는지 확인해 줘", true],
  ["", false],
];

describe("isOrder", () => {
  it.each(ORDERS)("%s", (text, want) => {
    expect(isOrder(text)).toBe(want);
  });

  it.each(["squash", "rebase", "keep", "revert", "skip", "drop", "approve", "finish", "close", "publish", "switch to", "apply", "commit", "share", "pick", "split"])("takes %s as an order, bare and after can you", (verb) => {
    expect(isOrder(`${verb} the two commits`)).toBe(true);
    expect(isOrder(`Can you ${verb} the two commits?`)).toBe(true);
  });
});

// The helper answers only this part of a send the bot already took; "" means no line at all.
const QUESTION_PARTS: Array<[string, string]> = [
  ["btw is lens ready", "btw is lens ready"],
  ["Check aiedwardyi tokens. also is lens ready", "also is lens ready"],
  ["Btw tell me do we have api credits we need to use up before it expires. Check", "Btw tell me do we have api credits we need to use up before it expires."],
  ["Which row got worse? Also export it.", "Which row got worse?"],
  ["what port is in the server config, please?", "what port is in the server config, please?"],
  ["Can you confirm whether it supports Windows, please?", "Can you confirm whether it supports Windows, please?"],
  ["성능 어때?", "성능 어때?"],
  ["Updated", ""],
  ["Shows in detail", ""],
  ["Ugh these card answers", ""],
  ["fyi the email is missing", ""],
  ["use 8080 instead", ""],
  ["merge both", ""],
  ["2", ""],
  ["둘 다 머지해줘", ""],
  ["npm install 다시 해볼까?", ""],
  ["Can you squash the two commits?", ""],
  ["hey can you help me out with something", ""],
  ["Hey can u figure out how to make mobile to pc sync faster?", ""],
];

describe("questionPart", () => {
  it.each(QUESTION_PARTS)("%s", (text, want) => {
    expect(questionPart(text)).toBe(want);
  });
});

// "do both" approves whatever follows; a "do" question with its own verb and a "?" asks.
const DO_BOTH: Array<[string, "quick" | "aside" | "main"]> = [
  ["Do both builds support Windows, please?", "aside"],
  ["Do all tests pass on CI?", "quick"],
  ["do both", "main"],
  ["do both PRs?", "main"],
  ["do both PRs now?", "main"],
  ["do all of them?", "main"],
  ["do it?", "main"],
];

describe("nominate", () => {
  it.each(DO_BOTH)("do: %s", (text, want) => {
    expect(nominate(text)).toBe(want);
  });

  it.each(SENT_MIDTURN)("sent mid-turn: %s", (text, want) => {
    expect(nominate(text)).toBe(want);
  });

  it.each(CASUAL)("casual: %s", (text, want) => {
    expect(nominate(text)).toBe(want);
  });

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

describe("isNudge", () => {
  it.each(["sidekick answer me", "answer me??", "hello?", "you there?", "sidekick?", "hey sidekick, answer my question", "pls answer", "anyone?", "사이드킥 대답해"])("asks to be answered: %s", (text) => {
    expect(isNudge(text)).toBe(true);
  });

  it.each(["ok", "lol", "yeah", "", "sidekick dont answer", "no don't reply", "stop", "answer the review then fix it", "whats the address?", "fix the build", "ok sounds good"])("is no nudge: %s", (text) => {
    expect(isNudge(text)).toBe(false);
  });

  it("finds the questions of a mixed message and leaves its order out", () => {
    const mixed = "can i let a teammate use my spare account ? whats the address again. we dont use it for tests right we can leave tests to this one ? or whatsup";
    expect(nominate(mixed)).toBe("quick");
    expect(isOrder(mixed)).toBe(false);
    expect(questionPart(mixed)).toBe("can i let a teammate use my spare account ? whats the address again. we dont use it for tests right we can leave tests to this one ?");
    expect(questionPart("whats the address again? switch the tests to this one")).toBe("whats the address again?");
    expect(isOrder("whats the address again? switch the tests to this one")).toBe(true);
  });
});
