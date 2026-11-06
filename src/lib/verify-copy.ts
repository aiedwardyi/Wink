import type { VerifyIssue } from "../../shared/live-verify";

export function verifyProblem(issue: VerifyIssue, locale: "en" | "ko"): string {
  if (locale !== "ko") return issue.measured;
  const text = issue.measured;
  switch (issue.rule) {
    case "missing target": return `${text.split(" has no target")[0]} 링크의 대상을 찾지 못했어요. 링크를 눌러 확인해 주세요.`;
    case "local 404": return `${text.split(" returns 404")[0]} 링크에서 404 오류가 나요. 링크를 눌러 확인해 주세요.`;
    case "self sign-up": return `${/^Sign-up link "(.*?)"/.exec(text)?.[1] ?? text.split(" points at")[0]} 가입 링크가 정보를 입력할 곳으로 이어지지 않아요. 링크를 눌러 확인해 주세요.`;
    case "sideways scroll": {
      const size = /^(\d+) px page at (\d+) px/.exec(text);
      return `휴대폰에서 페이지가 옆으로 넘쳐요${size ? ` (페이지 ${size[1]} px / 화면 ${size[2]} px)` : ""}.`;
    }
    case "broken image": return "이미지를 불러오지 못했어요. 페이지를 새로고침해 주세요.";
    case "page error": return `페이지에 오류가 있어요. 새로고침해 주세요: ${text.replace(/; reload the page$/, "")}`;
    case "phone menu gone": return `${text.split(" disappear at")[0]} 링크가 휴대폰에서 사라지고 메뉴 버튼도 없어요. 페이지 폭을 줄여 확인해 주세요.`;
    case "placeholder contact":
    case "lorem":
    case "TODO":
    case "undefined":
    case "NaN": {
      const value = /"(.*?)"/.exec(text)?.[1];
      return `임시 문구나 연락처가 남아 있어요${value ? `: ${value}` : ""}. 페이지에서 확인해 주세요.`;
    }
    default: return "페이지에서 문제를 발견했어요. 해당 위치를 확인해 주세요.";
  }
}
