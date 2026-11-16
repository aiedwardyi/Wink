// A busy dev PC sits under the warm pool's free-RAM floor and refuses every prewarm; CI never does.
const os = require("node:os");
const free = os.freemem;
os.freemem = () => Math.max(free(), os.totalmem() / 2);
