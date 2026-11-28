export const ERROR_CODES = Object.freeze(["UNKNOWN_ERROR", "RENDERER_GONE", "SERVER_GONE", "STARTUP_TIMEOUT", "UPDATE_FAILED", "UPDATE_UNAVAILABLE", "UNCLEAN_EXIT", "SERVER_RUNTIME_FAILURE"]);
export const ERROR_SITES = Object.freeze({ rendererError: 1, rendererRejection: 2, rendererGone: 3, serverGone: 4, startupTimeout: 5, updaterFailure: 6, updaterUnavailable: 7, uncleanExit: 8, serverRuntime: 9, updaterChannel: 10, chatRace: 11, usageRefresh: 12, chatQueue: 13 });
const PLATFORMS = ["win32", "darwin", "linux"];
const ARCHES = ["x64", "arm64", "ia32", "arm"];
const PROCESSES = ["main", "renderer", "server"];
const FIELDS = ["schema", "build", "platform", "arch", "process", "code", "site", "errorName", "frame", "exitCode", "count", "uptimeBucket", "utcHour", "reportId"];
// Page code can set Error.name to anything, so only built-in JS and DOM names pass.
const ERROR_NAMES = ["", "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "EvalError", "URIError", "AggregateError", "DOMException", "AbortError", "NotAllowedError", "NotFoundError", "NotReadableError", "NotSupportedError", "SecurityError", "TimeoutError", "InvalidStateError", "QuotaExceededError", "NetworkError", "DataCloneError", "OverconstrainedError"];
const FRAME = /^([^:/\\]{1,200}):\d{1,8}:\d{1,8}$/;
const NO_CHUNKS = new Set();
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Report fields cross the IPC and queue file boundaries.
const shippedFrame = (value, chunks) => value === "" || typeof value === "string" && chunks.has(FRAME.exec(value)?.[1]);
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function errorCode(value) {
  return ERROR_CODES.includes(value) ? value : "UNKNOWN_ERROR";
}

/** chunks: the JavaScript files this build ships under /assets; a frame outside them is invalid. */
export function validErrorReport(value, chunks = NO_CHUNKS) {
  return value !== null && typeof value === "object" && Object.keys(value).length === FIELDS.length
    && FIELDS.every((field) => Object.hasOwn(value, field)) && value.schema === 2
    && typeof value.build === "string" && /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-(?:dev|alpha|beta|rc)\.\d{1,12})?$/.test(value.build)
    && PLATFORMS.includes(value.platform) && ARCHES.includes(value.arch) && PROCESSES.includes(value.process)
    && ERROR_CODES.includes(value.code) && Object.values(ERROR_SITES).includes(value.site)
    && ERROR_NAMES.includes(value.errorName) && shippedFrame(value.frame, chunks)
    && integer(value.exitCode, -2147483648, 2147483647) && integer(value.count, 1, 10000)
    && integer(value.uptimeBucket, 0, 3) && integer(value.utcHour, 0, 3000000)
    && typeof value.reportId === "string" && /^[a-f0-9]{32}$/.test(value.reportId);
}

export function makeErrorReport(input, context) {
  const chunks = context.chunks ?? NO_CHUNKS;
  const report = {
    schema: 2, build: context.build, platform: context.platform, arch: context.arch,
    process: input.process, code: errorCode(input.code), site: input.site,
    errorName: ERROR_NAMES.includes(input.errorName) ? input.errorName : "", frame: shippedFrame(input.frame, chunks) ? input.frame : "",
    exitCode: integer(input.exitCode, -2147483648, 2147483647) ? input.exitCode : 0,
    count: 1, uptimeBucket: context.uptime < 60 ? 0 : context.uptime < 600 ? 1 : context.uptime < 3600 ? 2 : 3,
    utcHour: Math.floor(context.now / 3600000), reportId: context.reportId,
  };
  return validErrorReport(report, chunks) ? report : null;
}
