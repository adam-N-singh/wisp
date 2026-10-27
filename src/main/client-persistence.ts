// Renderer key/value persistence under `ui-state/`: one `<base32(key)>.blob`
// file per key holding the string the renderer wrote (by convention a JSON
// `{schemaVersion, value}` envelope). Keys are scoped by prefix (e.g.
// `wisp.ui.ui-layout`).
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { base32Decode, base32Encode } from "../shared/base32";
import { writeFileAtomic } from "./atomic-write";

const MAX_VALUE_BYTES = 4 * 1024 * 1024;

export class ClientPersistence {
  private readonly dir: string;

  constructor(userDataDir: string) {
    this.dir = join(userDataDir, "ui-state");
  }

  private fileFor(key: string): string {
    return join(this.dir, `${base32Encode(key)}.blob`);
  }

  async read(key: string): Promise<string | null> {
    try {
      return await readFile(this.fileFor(key), "utf8");
    } catch {
      return null;
    }
  }

  /** Every key matching an include prefix and no exclude prefix (empty include = all). */
  async readMany(include: string[], exclude: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const key of await this.keys()) {
      if (include.length > 0 && !include.some((prefix) => key.startsWith(prefix))) continue;
      if (exclude.some((prefix) => key.startsWith(prefix))) continue;
      const value = await this.read(key);
      if (value != null) out[key] = value;
    }
    return out;
  }

  async write(key: string, value: string): Promise<void> {
    if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new Error(`value for ${key} exceeds ${MAX_VALUE_BYTES} bytes`);
    await mkdir(this.dir, { recursive: true });
    await writeFileAtomic(this.fileFor(key), value);
  }

  async remove(key: string): Promise<void> {
    await rm(this.fileFor(key), { force: true });
  }

  async listKeys(prefix: string): Promise<string[]> {
    return (await this.keys()).filter((key) => key.startsWith(prefix)).sort();
  }

  private async keys(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    return names.flatMap((name) => {
      if (!name.endsWith(".blob")) return [];
      const key = base32Decode(name.slice(0, -5));
      return key == null ? [] : [key];
    });
  }

  /** Synchronous read for the boot snapshot, so the first paint has its layout. */
  readSync(key: string): string | null {
    try {
      return readFileSync(this.fileFor(key), "utf8");
    } catch {
      return null;
    }
  }

  countSync(): number {
    try {
      return readdirSync(this.dir).filter((name) => name.endsWith(".blob")).length;
    } catch {
      return 0;
    }
  }
}
