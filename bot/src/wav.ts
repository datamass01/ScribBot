import fs from "node:fs";
import { Writable } from "node:stream";

/** 44-byte PCM WAV header. Sizes are patched in when the stream finishes. */
export function wavHeader(dataBytes: number, sampleRate: number, channels: number, bitsPerSample = 16) {
  const blockAlign = (channels * bitsPerSample) / 8;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write("data", 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** Writable that accepts raw s16le PCM and produces a valid WAV file. */
export class WavFileWriter extends Writable {
  private fd: number;
  private bytes = 0;

  constructor(
    readonly file: string,
    readonly sampleRate: number,
    readonly channels: number,
  ) {
    super();
    this.fd = fs.openSync(file, "w");
    fs.writeSync(this.fd, wavHeader(0, sampleRate, channels));
  }

  get dataBytes() {
    return this.bytes;
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
    try {
      fs.writeSync(this.fd, chunk);
      this.bytes += chunk.length;
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  override _final(cb: (err?: Error | null) => void) {
    try {
      fs.writeSync(this.fd, wavHeader(this.bytes, this.sampleRate, this.channels), 0, 44, 0);
      this.close();
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void) {
    // Abandoned mid-write: still patch the header so what we have is playable.
    if (this.fdOpen) {
      try {
        fs.writeSync(this.fd, wavHeader(this.bytes, this.sampleRate, this.channels), 0, 44, 0);
      } catch {
        // best effort
      }
    }
    this.close();
    cb(err);
  }

  private fdOpen = true;
  private close() {
    if (!this.fdOpen) return;
    this.fdOpen = false;
    fs.closeSync(this.fd);
  }
}
