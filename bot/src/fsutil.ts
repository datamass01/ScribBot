import fs from "node:fs";

/** Errors Windows raises while another process (Defender, the indexer, an editor) holds the file. */
const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);
const RETRY_DELAYS_MS = [20, 40, 60, 100, 150, 200, 300, 400, 500, 500];

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * `fs.renameSync`, retried with backoff on transient Windows sharing errors, like graceful-fs
 * does (docs/assessment/02 S1). Throws the last error once the retries are used up.
 */
export function renameWithRetry(from: string, to: string, opts: { delays?: number[]; rename?: typeof fs.renameSync } = {}) {
  const rename = opts.rename ?? fs.renameSync;
  const delays = opts.delays ?? RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !TRANSIENT.has(code) || attempt >= delays.length) throw err;
      pause(delays[attempt]!);
    }
  }
}

/** Write `<file>.tmp`, then rename it over `file`, so readers never see a partial file. */
export function writeFileAtomic(file: string, data: string, opts: { rename?: typeof fs.renameSync; delays?: number[] } = {}) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  renameWithRetry(tmp, file, opts);
}
