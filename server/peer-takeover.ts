import { peerReplyText, settlePeerUserReplies } from "./peer-user-reply.ts";
import type { Message } from "./store.ts";

interface PeerWatch {
  joined?: () => void;
}

const peerTurns = new Map<string, Set<PeerWatch>>(); // target threadId → watches

/** True while a teammate's turn on `threadId` still waits for its reply. */
export function hasPeerWatch(threadId: string): boolean {
  return peerTurns.has(threadId);
}

/** The stamp for a peer turn's assistant text row: its pending comm, once,
 * while the watch is live. Blank and summarized rows stay bare. */
export function takePeerReplyStamp(
  pending: Map<string, NonNullable<Message["comm"]>>,
  threadId: string,
  message: { text?: string; summarized?: boolean },
): NonNullable<Message["comm"]> | undefined {
  const comm = pending.get(threadId);
  if (!comm || message.summarized || !message.text?.trim()) return undefined;
  if (!hasPeerWatch(threadId)) return undefined;
  pending.delete(threadId);
  return comm;
}

export function watchPeerTurn(threadId: string, joined?: () => void): () => void {
  const handlers = peerTurns.get(threadId) ?? new Set();
  const watch = { joined };
  handlers.add(watch);
  peerTurns.set(threadId, handlers);
  return () => {
    handlers.delete(watch);
    if (!handlers.size && peerTurns.get(threadId) === handlers) {
      peerTurns.delete(threadId);
      settlePeerUserReplies(threadId);
    }
  };
}

/** Backstop: the running turn on `threadId` read an input that is not the
 * user's (a pane note). A teammate's answer is what the turn said before it. */
export function peerInputJoined(threadId: string): void {
  for (const watch of [...(peerTurns.get(threadId) ?? [])]) watch.joined?.();
}

const askJoinedText = (botName: string) =>
  `${botName} took in a worker's note before answering. Ask again later.`;

/** ask_bot's answer until the turn ends or a pane note joins. */
export function peerAnswer(
  threadId: string,
  botName: string,
  _userName: () => string,
  resolve: (text: string, replied: boolean) => void,
) {
  let text = "";
  let done = false;
  const finish = (out: string, replied = true) => {
    if (done) return;
    done = true;
    endWatch();
    resolve(out, replied && Boolean(text.trim()));
  };
  const endWatch = watchPeerTurn(threadId, () => finish(text || askJoinedText(botName)));
  return {
    add: (step: string, replace = false) => {
      if (done) return;
      const peer = peerReplyText(step);
      if (replace) text = peer;
      else if (peer.trim()) text += (text ? "\n" : "") + peer;
    },
    end: (fallback: string, replied = true) => finish(text || fallback, replied),
  };
}
