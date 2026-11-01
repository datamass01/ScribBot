/** Daily log files in DATA_DIR/logs (docs/assessment/02 S9), so a crash leaves evidence. */
import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 20 * 1024 * 1024; // per file; a day that writes more continues in bot-<day>.1.log, .2…

export class DailyLog {
  private file: string | null = null;
  private day = "";
  private part = 0;
  private bytes = 0;

  constructor(
    private dir: string,
    private retentionDays: number,
    private prefix = "bot",
    private now: () => Date = () => new Date(),
  ) {}

  /** Append one line. Never throws: logging must not take the bot down. */
  write(line: string) {
    try {
      const day = this.now().toISOString().slice(0, 10);
      if (day !== this.day) this.open(day);
      if (this.bytes > MAX_BYTES) this.open(day, this.part + 1);
      const text = `${line.replace(/\r?\n/g, "\n  ")}\n`;
      fs.appendFileSync(this.file!, text);
      this.bytes += Buffer.byteLength(text);
    } catch {
      // disk full or folder gone: the console still has it
    }
  }

  private open(day: string, part = 0) {
    fs.mkdirSync(this.dir, { recursive: true });
    if (day !== this.day) this.prune();
    this.day = day;
    this.part = part;
    this.file = path.join(this.dir, `${this.prefix}-${day}${part ? `.${part}` : ""}.log`);
    try {
      this.bytes = fs.statSync(this.file).size;
    } catch {
      this.bytes = 0;
    }
    if (this.bytes > MAX_BYTES) this.open(day, part + 1);
  }

  /** Delete this prefix's files older than the retention period. */
  prune() {
    const cutoff = this.now().getTime() - this.retentionDays * 86_400_000;
    const re = new RegExp(`^${this.prefix}-(\\d{4}-\\d{2}-\\d{2})(\\.\\d+)?\\.log$`);
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const m = re.exec(name);
      if (m && Date.parse(`${m[1]}T23:59:59Z`) < cutoff) fs.rmSync(path.join(this.dir, name), { force: true });
    }
  }
}
