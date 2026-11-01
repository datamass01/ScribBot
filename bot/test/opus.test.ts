// The recorder's Opus decoder must skip a bad packet instead of ending the speech burst.
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import OpusScript from "opusscript";
import { describe, expect, it } from "vitest";
import { TolerantOpusDecoder } from "../src/opus.js";

const RATE = 16_000;
const FRAME = 320; // 20 ms at 16 kHz

function opusFrame(): Buffer {
  const enc = new OpusScript(RATE, 1, OpusScript.Application.VOIP);
  const pcm = Buffer.alloc(FRAME * 2);
  for (let i = 0; i < FRAME; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / RATE)), i * 2);
  const packet = Buffer.from(enc.encode(pcm, FRAME));
  enc.delete();
  return packet;
}

async function decode(packets: Buffer[]) {
  const decoder = new TolerantOpusDecoder({ rate: RATE, channels: 1, frameSize: FRAME });
  let bytes = 0;
  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      done();
    },
  });
  await pipeline(Readable.from(packets, { objectMode: true }), decoder, sink);
  return { bytes, dropped: decoder.dropped, decoded: decoder.decoded };
}

describe("TolerantOpusDecoder", () => {
  it("skips undecodable packets and keeps decoding the rest", async () => {
    const good = opusFrame();
    const garbage = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x01]);
    const res = await decode([garbage, good, garbage, good]);
    expect(res.dropped).toBe(2);
    expect(res.decoded).toBe(2);
    expect(res.bytes).toBe(2 * FRAME * 2);
  });

  it("decodes a clean stream with nothing dropped", async () => {
    const good = opusFrame();
    const res = await decode([good, good, good]);
    expect(res).toEqual({ bytes: 3 * FRAME * 2, dropped: 0, decoded: 3 });
  });
});
