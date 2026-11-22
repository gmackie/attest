/**
 * Single-use proof requests. One SQLite-backed Durable Object instance per
 * (PEP issuer, request id): the instance is single-threaded, so check-and-set is
 * atomic. The record is kept until the request has expired (plus clock skew), then
 * purged by an alarm; after that the request itself fails `request_expired`.
 */
import type { DurableState } from "./enrollment";

export const REPLAY_PURGE_SKEW_MS = 120_000;
interface Consumed { digest: string; expiresAt: number; consumedAt: number }
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class ReplayStore {
  constructor(private readonly state: DurableState, _env?: unknown) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/consume") return reply({ code: "not_found" }, 404);
    const body = (await request.json()) as { digest?: unknown; expiresAt?: unknown; now?: unknown };
    if (typeof body.digest !== "string" || !Number.isSafeInteger(body.expiresAt) || !Number.isSafeInteger(body.now))
      return reply({ code: "invalid_consume" }, 400);
    const existing = await this.state.storage.get<Consumed>("consumed");
    if (existing) return reply({ consumed: false });
    await this.state.storage.put("consumed", {
      digest: body.digest, expiresAt: body.expiresAt as number, consumedAt: body.now as number,
    } satisfies Consumed);
    await this.state.storage.setAlarm((body.expiresAt as number) + REPLAY_PURGE_SKEW_MS);
    return reply({ consumed: true });
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}
