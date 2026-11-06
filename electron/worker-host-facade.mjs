import { createTerminalHost } from "./terminal-host.mjs";
import { createWorkerHostClient } from "./worker-host-client.mjs";
import { recoverWorkers } from "./worker-resume.mjs";

export function createWorkerTerminalHost(options) {
  const local = createTerminalHost({ ...options, paneCleanup: null });
  let accountsEnabled = options.workerAccountsEnabled !== false;
  const remoteIds = new Set();
  const serviceNames = new Set(["workerLaunch", "resolveCwd", "botNames", "mailbox", "snag"]);
  const announce = (channel, value) => {
    if (channel === "terminal:opened") remoteIds.add(value.id);
    try { options.owner()?.send(channel, value); } catch {}
  };
  const client = createWorkerHostClient({ ...options.hostConfig,
    service: (method, args) => {
      if (!serviceNames.has(method) || typeof options[method] !== "function") throw new Error("Background work unavailable");
      return options[method](...args);
    },
    event: announce,
  });
  const adopt = async () => {
    const connected = await client.connect(false);
    if (connected) for (const pane of client.summary().panes) {
      remoteIds.add(pane.id);
      announce("terminal:opened", pane);
    }
    return connected;
  };
  let discovery = null;
  const discover = () => discovery ??= adopt().catch((error) => { discovery = null; throw error; });
  const remote = (id) => typeof id === "string" && (remoteIds.has(id) || id.length >= 8 && [...remoteIds].some((pane) => pane.startsWith(id)) || client.summary().panes.some((pane) => pane.id === id));
  const request = (name, ...args) => client.request(name, args);
  const host = {
    ...local,
    backgroundHost: true,
    async open(event, input) {
      options.authorize(event);
      if (!input?.sessionId) return local.open(event, input);
      await discover();
      return request("attach", input);
    },
    async readBot(botId, input = {}) {
      await discover();
      const own = await local.readBot(botId, input.sessionId && !remote(input.sessionId) ? input : {});
      if (input.sessionId && !remote(input.sessionId) && own.sessionId === input.sessionId) return local.readBot(botId, input);
      const background = client.summary().panes.some((pane) => pane.botId === botId);
      if (!background) return own;
      const hosted = await request("read", botId, input);
      if (input.sessionId || own.state === "no-terminal") return hosted;
      return { ...own, panes: [...own.panes, ...hosted.panes], closedPanes: [...own.closedPanes, ...hosted.closedPanes] };
    },
    async openForBot(...args) {
      await discover();
      if (accountsEnabled) await request("enable-accounts");
      const result = await request("spawn", ...args);
      if (result.sessionId) remoteIds.add(result.sessionId);
      return result;
    },
    async sendBot(botId, input, ...rest) {
      await discover();
      return remote(input?.sessionId) ? request("send", botId, input, ...rest) : local.sendBot(botId, input, ...rest);
    },
    async closeForBot(botId, id, keep) {
      await discover();
      return request("close-pane", botId, id, keep);
    },
    async closeBotPanes(botId) {
      await discover();
      await local.closeBotPanes(botId);
      if (client.summary().panes.some((pane) => pane.botId === botId)) await request("close-bot", botId);
    },
    paneLabels: () => ({ ...local.paneLabels(), ...client.summary().labels }),
    liveWorkerCount: () => local.liveWorkerCount() + client.summary().count,
    workerResumeStatus: (id) => client.summary().panes.find((pane) => pane.id === id)?.resumeStatus ?? local.workerResumeStatus(id),
    liveAccountRuns: (filter = {}) => [...local.liveAccountRuns(filter), ...client.summary().accounts.filter((run) => (!filter.botId || run.botId === filter.botId) && (!filter.engine || run.engine === filter.engine))],
    async livePanesForAccount(id) {
      await discover();
      if (!client.identity()) return local.livePanesForAccount(id);
      const own = local.livePanesForAccount(id);
      const background = await request("account-panes", id);
      const generations = { ...own.generations };
      for (const [generation, count] of Object.entries(background.generations)) generations[generation] = (generations[generation] ?? 0) + count;
      return { count: own.count + background.count, unknown: own.unknown + background.unknown, generations };
    },
    async captureWorkerSession(...args) {
      await discover();
      return remote(args[1]?.pane) ? request("capture", ...args) : local.captureWorkerSession(...args);
    },
    async attendBot(botId, id, ...args) {
      await discover();
      return remote(id) ? request("attend", botId, id, ...args) : local.attendBot(botId, id, ...args);
    },
    async enableWorkerAccounts() {
      local.enableWorkerAccounts();
      accountsEnabled = true;
      await discover();
      await request("enable-accounts");
    },
    async recoverWorkers(input) {
      await discover();
      if (client.needsRecovery() || client.summary().recoveryPending) await request("recover");
      await recoverWorkers(input);
    },
    async dispose() {
      await client.detach();
      await local.dispose();
    },
  };
  for (const [method, operation] of [["write", "write"], ["resize", "resize"], ["acknowledge", "acknowledge"], ["close", "close"]]) {
    host[method] = (event, id, ...args) => {
      options.authorize(event);
      return remote(id) ? request(operation, id, ...args) : local[method](event, id, ...args);
    };
  }
  return host;
}
