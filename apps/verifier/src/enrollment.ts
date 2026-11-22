/**
 * Holder enrollment: binds a holder POD (EdDSA) key to one authenticated subject.
 *
 * Enrollment requires both:
 *  - an authenticated subject `{iss, sub}` from a verified IdP access token, and
 *  - proof of possession of the holder key: a POD signed by that key whose only entry
 *    is the canonical `attest.holder-enrollment/v1` statement naming the same subject,
 *    this verifier and a timestamp at most five minutes old.
 *
 * A holder key is bound to at most one subject. Rebinding it to another subject is
 * refused (`holder_already_enrolled`), so one key-holder cannot lend presentations to
 * several accounts through this verifier.
 */
import { POD, type JSONPOD } from "@pcd/pod";
import {
  canonicalStatement, ENROLLMENT_SCHEMA, isCanonicalPublicKey, signEnrollment,
  type EnrollmentStatement, type SubjectRef,
} from "@attest/verifier";

// The statement codec lives in @attest/verifier so wallets (the browser journey) can sign it.
export { canonicalStatement, ENROLLMENT_SCHEMA, signEnrollment, type EnrollmentStatement };
export const MAX_ENROLLMENT_AGE_MS = 300_000;
const FUTURE_SKEW_MS = 30_000;

export class EnrollmentError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}
const need = (ok: unknown, code: string, status = 400): void => {
  if (!ok) throw new EnrollmentError(code, status);
};

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function parseStatement(value: unknown): EnrollmentStatement {
  need(isRecord(value), "invalid_enrollment");
  const v = value as Record<string, unknown>;
  need(Object.keys(v).sort().join(",") === "holderPublicKey,issuedAt,schema,subject,verifier", "invalid_enrollment");
  need(v.schema === ENROLLMENT_SCHEMA, "unsupported_enrollment_schema");
  need(typeof v.verifier === "string" && typeof v.holderPublicKey === "string" &&
    v.holderPublicKey.length > 0 && v.holderPublicKey.length <= 256 &&
    Number.isSafeInteger(v.issuedAt) && isRecord(v.subject), "invalid_enrollment");
  // One key, one spelling: otherwise hex/padded aliases of one key could bind several subjects.
  need(isCanonicalPublicKey(v.holderPublicKey), "noncanonical_holder_key");
  const s = v.subject as Record<string, unknown>;
  need(Object.keys(s).sort().join(",") === "issuer,subject" && typeof s.issuer === "string" &&
    typeof s.subject === "string", "invalid_enrollment");
  return {
    schema: ENROLLMENT_SCHEMA, verifier: v.verifier as string, holderPublicKey: v.holderPublicKey as string,
    issuedAt: v.issuedAt as number, subject: { issuer: s.issuer as string, subject: s.subject as string },
  };
}

/**
 * Checks the statement against the authenticated subject, this verifier and the clock,
 * then the holder's proof of possession. Throws EnrollmentError.
 */
export function checkEnrollment(
  body: unknown,
  authenticated: SubjectRef,
  verifierId: string,
  now: number,
): EnrollmentStatement {
  need(isRecord(body) && Object.keys(body).sort().join(",") === "signature,statement", "invalid_enrollment");
  const statement = parseStatement((body as Record<string, unknown>).statement);
  need(statement.verifier === verifierId, "enrollment_audience_mismatch");
  // The subject comes from the token. The statement must name the same one, so a
  // statement signed for one account cannot be replayed under another account's token.
  need(statement.subject.issuer === authenticated.issuer && statement.subject.subject === authenticated.subject,
    "enrollment_subject_mismatch", 403);
  need(statement.issuedAt <= now + FUTURE_SKEW_MS && now - statement.issuedAt <= MAX_ENROLLMENT_AGE_MS,
    "enrollment_stale");
  let valid = false;
  try {
    const pod = POD.fromJSON((body as { signature: JSONPOD }).signature);
    const entries = pod.content.asEntries();
    valid = pod.verifySignature() && pod.signerPublicKey === statement.holderPublicKey &&
      Object.keys(entries).length === 1 && entries.enrollment?.type === "string" &&
      entries.enrollment.value === canonicalStatement(statement);
  } catch {
    valid = false;
  }
  need(valid, "enrollment_signature_invalid");
  return statement;
}

/* ------------------------------------------------------------------------------------------ */

export interface DurableStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
  getAlarm?(): Promise<number | null>;
}
export interface DurableState { storage: DurableStorage }

/** `expiresAt` is null for IdPs without a binding TTL (the binding is permanent). */
interface Binding { issuer: string; subject: string; enrolledAt: number; expiresAt: number | null }
/** Holder keys bound to one subject, each with its binding expiry (null: permanent). */
type SubjectKeys = Record<string, number | null>;
/** Active holder keys one subject may hold at once. */
export const MAX_KEYS_PER_SUBJECT = 5;
const live = (expiresAt: number | null | undefined, now: number) => expiresAt === null || expiresAt === undefined || expiresAt > now;
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Runs tasks one at a time, so a read-check-write never interleaves with another request. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/**
 * Two kinds of instance, both SQLite-backed and serialized:
 *  - one per holder public key (`holder:<key>`): the key's binding to one subject (`/binding`);
 *  - one per subject (`subject:<digest>`): the subject's active holder keys (`/subject/reserve`,
 *    `/subject/release`), capped at MAX_KEYS_PER_SUBJECT, so one account cannot enroll keys
 *    without bound.
 * Bindings from IdPs with a `bindingTtlMs` expire; expired entries count as absent at once and
 * are deleted by an alarm. Bodies are parsed before any storage access, and every
 * read-check-write runs in a serial queue, so two concurrent enrollments cannot both win.
 */
export class EnrollmentStore {
  private readonly queue = new SerialQueue();
  constructor(private readonly state: DurableState, _env?: unknown) {}

  private async schedule(at: number | null) {
    if (at === null) return;
    const current = this.state.storage.getAlarm ? await this.state.storage.getAlarm() : null;
    if (current === null || current === undefined || at < current) await this.state.storage.setAlarm(at);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const time = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : undefined);
    if (url.pathname === "/binding" && request.method === "GET") {
      const now = time(Number(url.searchParams.get("now") ?? Date.now())) ?? Date.now();
      return this.queue.run(async () => {
        const current = await this.state.storage.get<Binding>("binding");
        return reply({ binding: current && live(current.expiresAt, now) ? current : null });
      });
    }
    if (url.pathname === "/binding" && request.method === "PUT") {
      const body = (await request.json()) as Partial<Binding>;
      const expiresAt = body.expiresAt === undefined || body.expiresAt === null ? null : time(body.expiresAt);
      if (typeof body.issuer !== "string" || typeof body.subject !== "string" || time(body.enrolledAt) === undefined ||
        expiresAt === undefined)
        return reply({ code: "invalid_binding" }, 400);
      const next: Binding = { issuer: body.issuer, subject: body.subject, enrolledAt: body.enrolledAt!, expiresAt };
      return this.queue.run(async () => {
        const stored = await this.state.storage.get<Binding>("binding");
        const current = stored && live(stored.expiresAt, next.enrolledAt) ? stored : undefined;
        if (current && (current.issuer !== next.issuer || current.subject !== next.subject))
          return reply({ code: "holder_already_enrolled" }, 409);
        await this.state.storage.put("binding", { ...next, enrolledAt: current?.enrolledAt ?? next.enrolledAt });
        await this.schedule(next.expiresAt);
        return reply({ enrolled: true, existing: Boolean(current) });
      });
    }
    if ((url.pathname === "/subject/reserve" || url.pathname === "/subject/release") && request.method === "POST") {
      const body = (await request.json()) as { holderPublicKey?: unknown; now?: unknown; expiresAt?: unknown };
      const now = time(body.now), expiresAt = body.expiresAt === null ? null : time(body.expiresAt);
      if (typeof body.holderPublicKey !== "string" || now === undefined || expiresAt === undefined)
        return reply({ code: "invalid_reservation" }, 400);
      const holder = body.holderPublicKey;
      return this.queue.run(async () => {
        const keys: SubjectKeys = {};
        for (const [k, e] of Object.entries((await this.state.storage.get<SubjectKeys>("keys")) ?? {}))
          if (live(e, now)) keys[k] = e;
        if (url.pathname === "/subject/release") {
          delete keys[holder];
        } else {
          const added = !Object.hasOwn(keys, holder);
          if (added && Object.keys(keys).length >= MAX_KEYS_PER_SUBJECT)
            return reply({ code: "too_many_holder_keys" }, 409);
          keys[holder] = expiresAt === null || keys[holder] === null ? null : Math.max(expiresAt, keys[holder] ?? 0);
          await this.state.storage.put("keys", keys);
          await this.schedule(expiresAt);
          return reply({ reserved: true, added });
        }
        if (Object.keys(keys).length) await this.state.storage.put("keys", keys);
        else await this.state.storage.deleteAll();
        return reply({ released: true });
      });
    }
    return reply({ code: "not_found" }, 404);
  }

  /** Deletes expired bindings and subject keys; reschedules for the next expiry. */
  async alarm(): Promise<void> {
    await this.queue.run(async () => {
      const now = Date.now();
      const binding = await this.state.storage.get<Binding>("binding");
      if (binding && !live(binding.expiresAt, now)) await this.state.storage.delete("binding");
      else if (binding?.expiresAt) await this.state.storage.setAlarm(binding.expiresAt);
      const stored = await this.state.storage.get<SubjectKeys>("keys");
      if (stored) {
        const keys = Object.fromEntries(Object.entries(stored).filter(([, e]) => live(e, now)));
        if (Object.keys(keys).length) {
          await this.state.storage.put("keys", keys);
          const next = Math.min(...Object.values(keys).filter((e): e is number => e !== null));
          if (Number.isFinite(next)) await this.state.storage.setAlarm(next);
        } else await this.state.storage.delete("keys");
      }
      if (!(await this.state.storage.get("binding")) && !(await this.state.storage.get("keys")))
        await this.state.storage.deleteAll();
    });
  }
}
