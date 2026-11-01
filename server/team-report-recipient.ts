const OWNER = /^(edward|eddie|ed|에드워드|에디|대표)(님)?(한테로|에게|한테|께|로|에|가)?(?:는|도)?$/iu;
const BOUNDARY = /^[,.!?;\n]$/;
const COURTESY = new Set(["please", "pls", "hey", "ok", "okay", "yeah", "yes", "let's"]);
const MODAL = new Set(["can", "could", "would", "will"]);
const VERBS = new Set(["send", "report", "forward", "submit", "tell", "flag", "file", "share", "let"]);
const OBJECT = /^(?:this|that|it|these|those|the|a|an|my|our|your|all|some|everything|logs?|reports?|screenshots?|images?|files?|messages?|diagnostics?|evidence|details|feedback|bugs?|issues?|errors?|crashes|crash|debug|console|server|client|stack|trace|output)$/;
const INFINITIVE = /^(?:save|reproduce|debug|fix|check|test|show|explain|help|send|report|see|know|collect|include)$/;
const GERUND = /^(?:saving|reproducing|debugging|fixing|checking|testing|showing|explaining|helping|sending|reporting|sharing|filing|collecting)$/;
const PARTICLES = ["한테로", "에게", "한테", "께", "로", "에"];
const RECIPIENT_PARTICLES = ["한테로", "에게", "한테", "께"];
const KOREAN_SEND = /^(?:보[내네](?:줘|주세요|주|줄래|줄|드려|드려요)?|(?:보고|전달|제보|전송|공유|신고)(?:해|하)[\p{L}]*|(?:알려|말해)(?:줘|주세요|주|드려)?)$/u;
const KOREAN_REPORT = /^(?:보고|전달|제보|전송|공유|신고)$/;

function koreanSend(words: string[], index: number): boolean {
  return KOREAN_SEND.test(words[index]) || (KOREAN_REPORT.test(words[index]) && /^(?:해|하|부탁|좀)/.test(words[index + 1] ?? ""));
}

function command(words: string[], start: number): { start: number; index: number; addressed: boolean } | undefined {
  let index = start;
  const owner = OWNER.exec(words[index]);
  let addressed = Boolean(owner && !owner[3]);
  if (addressed) { index++; if (words[index] === ",") index++; }
  else if (start > 1 && words[start - 1] === ",") {
    const before = OWNER.exec(words[start - 2]);
    addressed = Boolean(before && !before[3]);
  }
  while (index < words.length) {
    if (COURTESY.has(words[index])) index++;
    else if (MODAL.has(words[index]) && words[index + 1] === "you") index += 2;
    else if (/^i['’]d$/.test(words[index]) && words[index + 1] === "like" && words[index + 2] === "to") index += 3;
    else if (words[index] === "i" && words[index + 1] === "would" && words[index + 2] === "like" && words[index + 3] === "to") index += 4;
    else if (words[index] === "i" && /^(?:want|need)$/.test(words[index + 1] ?? "")) {
      index += 2;
      if (words[index] === "you") index++;
      if (words[index] === "to") index++; else return;
    } else break;
  }
  if (VERBS.has(words[index])) return { start, index, addressed };
}

export function reportRecipient(text: string): boolean {
  const words = (text.match(/[\p{L}\p{N}_]+(?:['’][\p{L}\p{N}_]+)?|\n|[^\s]/gu) ?? []).map((word) => word.toLowerCase());
  const commands: Array<{ start: number; index: number; addressed: boolean }> = [];
  for (let index = 0; index < words.length; index++) {
    if (index && !BOUNDARY.test(words[index - 1])) continue;
    const found = command(words, index);
    if (found) { commands.push(found); index = found.index; }
  }
  const subject = OWNER.exec(words[0] ?? "");
  const sentenceEnd = words.findIndex((word) => /^[.!?]$/.test(word));
  const conflicts = new Set<number>();
  for (let index = 0; index < commands.length; index++) {
    const current = commands[index], end = commands[index + 1]?.start ?? words.length;
    const verb = words[current.index], first = words[current.index + 1] ?? "";
    let recipient = current.addressed || Boolean(OWNER.exec(first));
    let other = false;
    if (verb === "tell" || verb === "let") {
      recipient = Boolean(OWNER.exec(first)) && (verb !== "let" || words[current.index + 2] === "know");
      if (!recipient) { conflicts.add(current.index); continue; }
    } else if (current.addressed && /^(?:send|forward)$/.test(verb) && !OWNER.test(first) && !OBJECT.test(first)) { other = true; conflicts.add(current.index); }
    for (let at = current.index + 1; at < end; at++) {
      const preposition = words[at], next = words[at + 1] ?? "";
      if (preposition !== "to" && !(/^(?:flag|file|share)$/.test(verb) && /^(?:for|with)$/.test(preposition))) continue;
      if ((preposition === "to" && INFINITIVE.test(next)) || (preposition === "for" && (GERUND.test(next) || OBJECT.test(next)))) continue;
      if (OWNER.test(next)) recipient = true;
      else if (preposition === "to" && next === "him" && subject && !subject[3] && (sentenceEnd < 0 || current.start < sentenceEnd)) recipient = true;
      else { other = true; conflicts.add(at); }
    }
    if (recipient && !other) return true;
  }
  let recipient = false, other = false, subjectOwner = false, needs = false, englishOther = false;
  for (let index = 0; index < words.length; index++) {
    const word = words[index], next = words[index + 1] ?? "";
    if (/^[.!?;\n]$/.test(word)) englishOther = false;
    if (conflicts.has(index)) englishOther = true;
    const owner = OWNER.exec(word);
    if (owner) {
      const particle = owner[3] ?? (PARTICLES.includes(next) ? next : undefined);
      if (particle === "가") subjectOwner = true;
      else if (particle) recipient = !/^(?:받|온|들은)/.test(words[index + (owner[3] ? 1 : 2)] ?? "");
      else if (owner[1] !== "대표" || owner[2] || ((!index || BOUNDARY.test(words[index - 1])) && (next === "," || /^(?:이거|이것|그거|저거)$/.test(next) || koreanSend(words, index + 1)))) recipient = true;
    } else if (RECIPIENT_PARTICLES.includes(next) || RECIPIENT_PARTICLES.some((particle) => word.length > particle.length && (word.endsWith(particle) || word.endsWith(`${particle}는`) || word.endsWith(`${particle}도`)))) other = true;
    if (word.includes("말고") || word.includes("대신")) other = true;
    if (subjectOwner && /(?:봐야|받아야|알아야)/.test(word)) needs = true;
    if (koreanSend(words, index)) {
      if (!other && !englishOther && (recipient || (subjectOwner && needs))) return true;
      recipient = other = subjectOwner = needs = false;
    }
  }
  return false;
}
