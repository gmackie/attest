import type { Store } from "../src/demo-pep/ledger";

/** In-memory Durable Object storage: ordered prefix listing and a single alarm, like the real one. */
export class MemoryStore implements Store {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string) { return structuredClone(this.data.get(key)) as T | undefined; }
  async put(key: string, value: unknown) { this.data.set(key, structuredClone(value)); }
  async delete(key: string) { return this.data.delete(key); }
  async list<T>({ prefix, limit }: { prefix: string; limit: number }) {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit);
    return new Map(keys.map((k) => [k, structuredClone(this.data.get(k)) as T]));
  }
  async getAlarm() { return this.alarm; }
  async setAlarm(at: number) { this.alarm = at; }
}
