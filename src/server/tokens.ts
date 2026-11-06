// Agent tokens: long random secrets a signed-in person creates for an agent. Only a hash is
// stored; the token itself is shown once. A token can read the network and read and write notes.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface TokenInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface Stored extends TokenInfo {
  hash: string;
}

const PREFIX = "stb_";
const hash = (token: string) => createHash("sha256").update(token).digest();

export class TokenStore {
  constructor(readonly path: string) {}

  list(): TokenInfo[] {
    return this.read().map(({ hash: _, ...t }) => t);
  }

  /** Returns the token once; afterwards only its hash exists. */
  create(name: string): { token: string; info: TokenInfo } {
    const clean = name.trim().slice(0, 60) || "Agent";
    const token = PREFIX + randomBytes(32).toString("base64url");
    const info: TokenInfo = { id: randomBytes(6).toString("hex"), name: clean, createdAt: new Date().toISOString() };
    this.write([...this.read(), { ...info, hash: hash(token).toString("hex") }]);
    return { token, info };
  }

  revoke(id: string): boolean {
    const all = this.read();
    const next = all.filter((t) => t.id !== id);
    if (next.length === all.length) return false;
    this.write(next);
    return true;
  }

  /** The token's record when it is valid. Marks it used, at most once a minute. */
  verify(token: string): TokenInfo | undefined {
    if (!token.startsWith(PREFIX)) return undefined;
    const h = hash(token);
    const all = this.read();
    const hit = all.find((t) => {
      const b = Buffer.from(t.hash, "hex");
      return b.length === h.length && timingSafeEqual(b, h);
    });
    if (!hit) return undefined;
    if (!hit.lastUsedAt || Date.now() - Date.parse(hit.lastUsedAt) > 60_000) {
      hit.lastUsedAt = new Date().toISOString();
      this.write(all);
    }
    const { hash: _, ...info } = hit;
    return info;
  }

  private read(): Stored[] {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as Stored[]) : [];
  }

  private write(all: Stored[]) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
