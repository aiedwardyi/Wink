// --require'd by the kit's Wink server. Wink drops *_TOKEN names from the engines it spawns, so the login rides as
// EVAL_CLAUDE_OAUTH and lands only on claude spawns, with the night's throwaway config dir (no session files reach a real profile).
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");

const isClaude = (command) => /(?:^|[\\/\s"'])claude(?:\.(?:exe|cmd|bat|js))?(?=$|[\s"'])|claude-code[\\/]cli\.js/i.test(command);
const { EVAL_CLAUDE_OAUTH: token, EVAL_CLAUDE_CONFIG: config } = process.env;
delete process.env.EVAL_CLAUDE_OAUTH;
delete process.env.EVAL_CLAUDE_CONFIG;

for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
  const original = childProcess[name];
  childProcess[name] = function (file, args, options, ...rest) {
    if (!Array.isArray(args)) {
      if (options instanceof Function) rest.unshift(options);
      options = args;
      args = [];
    }
    const env = { ...(options?.env ?? process.env) };
    delete env.EVAL_CLAUDE_OAUTH;
    delete env.EVAL_CLAUDE_CONFIG;
    if (token && config && isClaude([file, ...args.slice(0, 2)].join(" "))) Object.assign(env, { CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CONFIG_DIR: config });
    if (options instanceof Function) return original.call(this, file, args, { env }, options, ...rest);
    return original.call(this, file, args, { ...options, env }, ...rest);
  };
}

syncBuiltinESMExports();
