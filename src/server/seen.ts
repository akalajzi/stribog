// When Stribog first saw each device, in the data directory (seen.json), for "new device".
// Written by the recorder; the demo ships its own.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { recordSeen, type Seen } from "../core/newdevices.ts";

const DEMO_SEEN = resolve(import.meta.dirname, "../../fixtures/demo/seen.json");

export function seenFile(dataDir: string): string {
  return join(dataDir, "seen.json");
}

export function readSeen(file: string): Seen | undefined {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Seen) : undefined;
  } catch {
    return undefined;
  }
}

export const demoSeen = () => readSeen(DEMO_SEEN);

export function writeSeen(file: string, now: number, online: string[], known: string[]): Seen {
  const seen = recordSeen(readSeen(file), now, online, known);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(seen), { mode: 0o600 });
  renameSync(tmp, file);
  return seen;
}
