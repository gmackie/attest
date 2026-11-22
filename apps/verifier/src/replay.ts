/**
 * Single-use proof requests and a per-request attempt budget.
 *
 * One SQLite-backed Durable Object instance per (verified PEP issuer, request id). Every
 * read-check-write runs in a serial queue, so consume is atomic. Records are kept until
 * the request has expired (plus clock skew), then purged by an alarm; after that the
 * request itself fails `request_expired`.
 *
 * Failed verifications of a validly signed request are counted. After MAX_FAILED_ATTEMPTS
 * the request is refused before any proof or chain work (`attempts_exhausted`), bounding
 * the CPU and RPC load one request can cause.
 */
import { SerialQueue, type DurableState } from "./enrollment";

export const REPLAY_PURGE_SKEW_MS = 120_000;
export const MAX_FAILED_ATTEMPTS = 5;
interface Record_ { consumed?: { digest: string; consumedAt: number }; failures: number; expiresAt: number }
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class ReplayStore {
  private readonly queue = new SerialQueue();
  constructor(private readonly state: DurableState, _env?: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/check", "/fail", "/consume"].includes(path)) return reply({ code: "not_found" }, 404);
    const body = (await request.json()) as { digest?: unknown; expiresAt?: unknown; now?: unknown };
    if (!Number.isSafeInteger(body.expiresAt) || !Number.isSafeInteger(body.now) ||
      (path === "/consume" && typeof body.digest !== "string"))
      return reply({ code: "invalid_replay_call" }, 400);
    const expiresAt = body.expiresAt as number, now = body.now as number;
    return this.queue.run(async () => {
      const existing = await this.state.storage.get<Record_>("request");
      const record: Record_ = existing ?? { failures: 0, expiresAt };
      const state = () => ({ consumed: Boolean(record.consumed), failures: record.failures,
        exhausted: record.failures >= MAX_FAILED_ATTEMPTS });
      if (path === "/check") return reply(state());
      if (path === "/fail") {
        if (!record.consumed) record.failures += 1;
      } else {
        if (record.consumed) return reply({ ...state(), consumedNow: false });
        record.consumed = { digest: body.digest as string, consumedAt: now };
      }
      await this.state.storage.put("request", record);
      if (!existing) await this.state.storage.setAlarm(expiresAt + REPLAY_PURGE_SKEW_MS);
      return reply({ ...state(), ...(path === "/consume" ? { consumedNow: true } : {}) });
    });
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}
