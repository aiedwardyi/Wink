import fs from "node:fs";

// Share mode 0 (UV_FS_O_EXLOCK): the kernel frees the lock only when the holder exits.
const LOCK_FLAGS = fs.constants.O_RDWR | fs.constants.O_CREAT | 0x10000000;

export const holdWorkerHostLock = (file) => fs.openSync(file, LOCK_FLAGS, 0o600);

export function workerHostLock(file) {
  try { fs.closeSync(holdWorkerHostLock(file)); return "dead"; }
  catch (error) { return error.code === "EBUSY" ? "alive" : "unknown"; }
}

export function workerHostRecord(file) {
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    return record && !Array.isArray(record) && Object(record) === record ? record : null;
  } catch {
    return null;
  }
}

export function writeWorkerHostRecord(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
