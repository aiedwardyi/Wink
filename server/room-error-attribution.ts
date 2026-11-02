import type { Message } from "./store.ts";

export interface RoomErrorBot {
  id: string;
  name: string;
  color: string;
}

type RoomErrorActivity = Omit<Message, "id" | "at">;

export function stallErrorActivity(
  bot: RoomErrorBot | null | undefined,
  minutes: number,
  isGroup: boolean,
): RoomErrorActivity {
  const activity: RoomErrorActivity = {
    role: "bot",
    kind: "activity",
    tool: { name: `error: no activity for ${minutes} minutes — the turn was stopped`, ok: false },
  };
  if (isGroup && bot) {
    activity.from = { botId: bot.id, name: bot.name, color: bot.color };
  }
  return activity;
}
