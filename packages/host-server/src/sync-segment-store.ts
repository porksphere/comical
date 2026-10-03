/**
 * A hub's segments on disk: one append-only JSON-lines file per device, `{dir}/{device}.jsonl`.
 * Device ids are validated to a filename-safe alphabet before anything reaches here.
 *
 * A crash can leave a device's last line half-written. Loading keeps each file's longest prefix of
 * lines that parse as that device's next segment and cuts the file back to it, so the next append
 * starts on a clean line. Anything after a bad line could never be served anyway — it would sit
 * past a gap — and the device re-pushes it, since it never got the acknowledgement.
 */
import { mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSegment, type Segment, type SegmentStore } from "@comical/sync";

const EXT = ".jsonl";

export class FileSegmentStore implements SegmentStore {
  constructor(private readonly dir: string) {}

  async load(): Promise<Segment[]> {
    await mkdir(this.dir, { recursive: true });
    const out: Segment[] = [];
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith(EXT)) continue;
      const device = name.slice(0, -EXT.length);
      const path = join(this.dir, name);
      const raw = await readFile(path, "utf8");
      const kept: Segment[] = [];
      for (const line of raw.split("\n")) {
        if (line === "") continue;
        const seg = parseLine(line);
        if (!seg || seg.device !== device || seg.seq !== kept.length + 1) break;
        kept.push(seg);
      }
      const clean = kept.map((s) => JSON.stringify(s) + "\n").join("");
      if (clean !== raw) await writeFile(path, clean);
      out.push(...kept);
    }
    return out;
  }

  async append(segment: Segment): Promise<void> {
    const file = await open(join(this.dir, `${segment.device}${EXT}`), "a");
    try {
      await file.write(JSON.stringify(segment) + "\n");
      await file.datasync();
    } finally {
      await file.close();
    }
  }
}

function parseLine(line: string): Segment | undefined {
  try {
    const parsed = parseSegment(JSON.parse(line));
    return parsed.ok ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}
