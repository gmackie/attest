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
import { canonicalJson } from "@attest/mandates/protocol";
import { isCanonicalPublicKey, type SubjectRef } from "@attest/verifier";

export const ENROLLMENT_SCHEMA = "attest.holder-enrollment/v1";
export const MAX_ENROLLMENT_AGE_MS = 300_000;
const FUTURE_SKEW_MS = 30_000;

export interface EnrollmentStatement {
  schema: typeof ENROLLMENT_SCHEMA;
  verifier: string;
  subject: SubjectRef;
  holderPublicKey: string;
  issuedAt: number;
}

export class EnrollmentError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}
const need = (ok: unknown, code: string, status = 400): void => {
  if (!ok) throw new EnrollmentError(code, status);
};

/** Canonical bytes of the statement (the same canonical JSON as attest.* JWS payloads). */
export const canonicalStatement = (s: EnrollmentStatement): string => canonicalJson(s);

/** Wallet side: sign an enrollment statement with the holder key. */
export const signEnrollment = (statement: EnrollmentStatement, holderPrivateKey: string): JSONPOD =>
  POD.sign({ enrollment: { type: "string", value: canonicalStatement(statement) } }, holderPrivateKey).toJSON();

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
}
export interface DurableState { storage: DurableStorage }

interface Binding { issuer: string; subject: string; enrolledAt: number }
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
 * One instance per holder public key (idFromName of the canonical key), SQLite-backed.
 * The body is parsed before any storage access, and every read-check-write runs in a serial
 * queue, so two concurrent enrollments of one key cannot both see "unbound".
 */
export class EnrollmentStore {
  private readonly queue = new SerialQueue();
  constructor(private readonly state: DurableState, _env?: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/binding" || (request.method !== "GET" && request.method !== "PUT"))
      return reply({ code: "not_found" }, 404);
    let next: Binding | undefined;
    if (request.method === "PUT") {
      const body = (await request.json()) as Partial<Binding>;
      if (typeof body.issuer !== "string" || typeof body.subject !== "string" || !Number.isSafeInteger(body.enrolledAt))
        return reply({ code: "invalid_binding" }, 400);
      next = { issuer: body.issuer, subject: body.subject, enrolledAt: body.enrolledAt! };
    }
    return this.queue.run(async () => {
      const current = await this.state.storage.get<Binding>("binding");
      if (!next) return reply({ binding: current ?? null });
      if (current && (current.issuer !== next.issuer || current.subject !== next.subject))
        return reply({ code: "holder_already_enrolled" }, 409);
      await this.state.storage.put("binding", { issuer: next.issuer, subject: next.subject,
        enrolledAt: current?.enrolledAt ?? next.enrolledAt });
      return reply({ enrolled: true, existing: Boolean(current) });
    });
  }
}
