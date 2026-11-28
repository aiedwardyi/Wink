// The Stuck post an older build left for each engine call; other PCs still sync them in, and clearing the blocker still solves one.
import { createHash } from "node:crypto";

import { BOARD_REF_MAX, errorSig, type Board, type BoardPost } from "../board.ts";

type Blocker = { kind: string; note: string };

export function olderCall(board: Board, botId: string, threadId: string, blocker: Blocker, projectId = "wink"): BoardPost {
  const refs = (episode: number) => {
    const legacy = `call:${threadId}:${episode}:${blocker.kind}:${blocker.note}`;
    const digest = `call:${threadId}:${episode}:${blocker.kind}:${createHash("sha256").update(`${blocker.kind}\n${blocker.note}`).digest("hex").slice(0, 24)}`;
    return legacy.length <= BOARD_REF_MAX ? [legacy, digest] : [digest];
  };
  return board.post({
    author_bot_id: botId,
    kind: "stuck",
    title: blocker.note,
    body: blocker.note,
    error_sig: errorSig(blocker.note),
    project_id: projectId,
    source_ref: board.next(refs, (post) => post.status === "solved"),
  });
}
