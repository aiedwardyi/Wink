import fs from "node:fs";

// Share mode 0 (UV_FS_O_EXLOCK): the kernel frees the lock only when the holder exits.
const LOCK_FLAGS = fs.constants.O_RDWR | fs.constants.O_CREAT | 0x10000000;

export const holdWorkerHostLock = (file) => fs.openSync(file, LOCK_FLAGS, 0o600);

export function workerHostLock(file) {
  try { fs.closeSync(holdWorkerHostLock(file)); return "dead"; }
  catch (error) { return error.code === "EBUSY" ? "alive" : "unknown"; }
}

function readRecord(file) {
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    return record && !Array.isArray(record) && Object(record) === record ? record : null;
  } catch {
    return null;
  }
}

export function workerHostRecord(file) {
  if (fs.existsSync(file)) return readRecord(file);
  // A writer that died between its two renames left the new record in full beside the old one.
  return readRecord(`${file}.tmp`) ?? readRecord(`${file}.old`);
}

// Fixed names, not pid ones: only the host holding host.lock writes, and a reader must find what a dead writer left.
export function writeWorkerHostRecord(file, value) {
  const temporary = `${file}.tmp`;
  const previous = `${file}.old`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  // Windows will not rename over a record a reader has open, but it will move that record aside.
  let moved = true;
  try { fs.renameSync(file, previous); }
  catch (error) { if (error.code !== "ENOENT") throw error; moved = false; }
  try { fs.renameSync(temporary, file); }
  catch (error) { if (moved) fs.renameSync(previous, file); throw error; }
  if (moved) fs.rmSync(previous, { force: true });
}
