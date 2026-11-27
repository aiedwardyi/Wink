// Effort moved into a running Claude turn: the CLI applies apply_flag_settings
// at once, mid-turn too, so the turn's next model call carries it. An idle
// kept process takes a model or effort change the same way, plus set_model.
import type { EffortLevel } from "../contracts.ts";
import { newId } from "../contracts.ts";

export type SwitchRequest = ReturnType<typeof effortRequest> | ReturnType<typeof modelRequest>;

const effortRequest = (requestId: string, effort: EffortLevel) => ({
  type: "control_request" as const,
  request_id: requestId,
  request: { subtype: "apply_flag_settings" as const, settings: { effortLevel: effort } },
});

const modelRequest = (requestId: string, model: string) => ({
  type: "control_request" as const,
  request_id: requestId,
  request: { subtype: "set_model" as const, model },
});

type SwitchSession = {
  argsKey: string;
  replies: Map<string, (ok: boolean) => void>;
  turn: { launch?: { request: { effort?: EffortLevel } } } | null;
};

/** The spawn contract a process switched to this effort now matches; one
 * spawned without --effort matches none, so its next turn relaunches. */
const keyWithEffort = (argsKey: string, effort: EffortLevel): string => {
  if (!argsKey) return "";
  const key: { args: string[] } = JSON.parse(argsKey);
  const at = key.args.indexOf("--effort");
  if (at === -1) return "";
  key.args[at + 1] = effort;
  return JSON.stringify(key);
};

/** What a live process on contract `from` must be sent to match `to`, or
 * null when anything but --model and --effort differs (base URL included). */
export function switchPlan(from: string, to: string): { model?: string; effort?: EffortLevel } | null {
  if (!from || !to || from === to) return null;
  const key: { args: string[]; model: string | null } = JSON.parse(from);
  const next: { args: string[]; model: string | null } = JSON.parse(to);
  const plan: { model?: string; effort?: EffortLevel } = {};
  const model = key.args.indexOf("--model");
  if (model !== -1 && next.model && key.args[model + 1] !== next.model) {
    key.args[model + 1] = plan.model = next.model;
    key.model = next.model;
  }
  const effort = key.args.indexOf("--effort");
  // set_model can reset effort, so a model switch re-applies it
  if (effort !== -1 && (plan.model || key.args[effort + 1] !== next.args[effort + 1])) {
    key.args[effort + 1] = plan.effort = next.args[effort + 1] as EffortLevel;
  }
  return JSON.stringify(key) === to ? plan : null;
}

/** True once the CLI answers success within ms; a later success still runs onOk. */
const control = (
  session: SwitchSession,
  request: (requestId: string) => SwitchRequest,
  write: (request: SwitchRequest) => Promise<boolean>,
  ms: number,
  onOk: () => void = () => {},
): Promise<boolean> => {
  const requestId = newId();
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    session.replies.set(requestId, (ok) => {
      session.replies.delete(requestId);
      clearTimeout(timer);
      if (ok) onOk();
      resolve(ok);
    });
    void write(request(requestId)).then((written) => {
      if (!written) session.replies.get(requestId)?.(false);
    });
  });
};

/** True once the CLI answers success within ms. A success that comes later
 * still moves the session's contract, since the CLI did switch. */
export function switchEffort(
  session: SwitchSession,
  effort: EffortLevel,
  write: (request: SwitchRequest) => Promise<boolean>,
  ms: number,
): Promise<boolean> {
  const turn = session.turn;
  return control(session, (id) => effortRequest(id, effort), write, ms, () => {
    session.argsKey = keyWithEffort(session.argsKey, effort);
    // a relaunch of this turn replays its launch request
    if (turn?.launch) turn.launch.request = { ...turn.launch.request, effort };
  });
}

/** Moves an idle process to contract `argsKey` in place; false means respawn. */
export async function switchIdle(
  session: SwitchSession & { closing: boolean; child: { exitCode: number | null } },
  argsKey: string,
  write: (request: SwitchRequest) => Promise<boolean>,
  ms: number,
): Promise<boolean> {
  const plan = switchPlan(session.argsKey, argsKey);
  if (!plan) return false;
  const { model, effort } = plan;
  if (model && !(await control(session, (id) => modelRequest(id, model), write, ms))) return false;
  if (effort && !(await control(session, (id) => effortRequest(id, effort), write, ms))) return false;
  if (session.turn || session.closing || session.child.exitCode !== null) return false;
  session.argsKey = argsKey;
  return true;
}
