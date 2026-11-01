import type { TransformCallback } from "node:stream";
import prism from "prism-media";

/**
 * prism's Opus decoder fails the whole stream on the first packet it can't decode, which
 * throws away the rest of that speech burst. Discord does send the odd undecodable packet,
 * especially right after the bot joins while voice encryption (DAVE) is settling. This
 * decoder skips such packets and counts them instead.
 */
export class TolerantOpusDecoder extends prism.opus.Decoder {
  /** Packets that couldn't be decoded and were skipped. */
  dropped = 0;
  /** Packets decoded into PCM. */
  decoded = 0;

  override _transform(chunk: Buffer, encoding: BufferEncoding, done: TransformCallback): void {
    super._transform(chunk, encoding, (err?: Error | null) => {
      if (err) this.dropped++;
      else this.decoded++;
      done();
    });
  }
}
